#!/usr/bin/env bash

# One way to reach the stack's database from a shell script.
#
# Every query used to be its own `docker exec dune-postgres psql ...`. That is
# fine for a one-shot CLI command but ruinous for the autoscaler, which runs
# sixteen scan functions plus four log-follower loops against the database
# forever: each exec spawns two conmon processes that linger for the engine's
# exit delay, and each one rewrites the container's ExecIDs array in the
# engine's own state database. On a busy Battlegroup that alone produced tens
# of megabytes per second of writes with no game state behind it.
#
# So this seam prefers a plain TCP connection to the port `start-postgres.sh`
# publishes on loopback, and falls back to `docker exec` where no `psql` client
# exists. The split is not a heuristic dressed up as a policy: `psql` ships in
# exactly the two images that run publisher loops -- the orchestrator image
# (dune-orchestrator, dune-autoscaler, dune-coriolis-coordinator) and the
# console image -- and every container from either runs with host networking,
# so whenever the client is present 127.0.0.1 really is the host's loopback and
# really does reach the published port. On the host itself -- the `dune` CLI,
# start-all.sh -- there is usually no client, and the exec path is the same code
# that has always run there.
#
# The same two transports, the same settings and the same defaults are
# reimplemented once in runtime/scripts/dune_psql.py, for the publishers whose
# queries run in an embedded `python3 - <<PY` block. tests/psql-transport-test.sh
# diffs the two halves so they cannot drift apart.
#
# The engine is addressed as `docker` throughout, which on a Podman host is the
# podman-docker shim; nothing here depends on Docker specifically.

# shellcheck source=runtime/scripts/lib/ports.sh
source runtime/scripts/lib/ports.sh

# How start-postgres.sh provisions the server. The TCP path has to authenticate
# where the exec path did not, so these are stated once and consumed by both
# this library and the script that creates the container.
# shellcheck disable=SC2034 # DUNE_PG_DATABASE is read by start-postgres.sh.
DUNE_PG_SUPERUSER="postgres"
DUNE_PG_SUPERUSER_PASSWORD="postgres"
DUNE_PG_DATABASE="dune"
DUNE_PG_CONTAINER="dune-postgres"

# The application role. postgres-bootstrap-sql.sh creates it with LOGIN and
# makes it the owner of the dune database; it is not a superuser. Scripts that
# only touch application tables connect as this role, which is what they did
# when each spelled out its own `docker exec ... psql -U dune`.
DUNE_PG_APP_ROLE="dune"

# `auto` (or unset) picks the transport by looking for a client; an explicit
# `tcp` or `exec` pins it, which is how the tests exercise both paths.
#
# Both this and the port are settled on the first query rather than when this
# file is sourced. Deferring is what makes the seam safe to source anywhere in a
# caller's prologue: several callers read .env well after their `source` lines,
# and resolving eagerly would pin the default port before the operator's value
# was ever visible. Neither answer can change while a process runs, so the
# result is cached in the shell that asked -- the autoscaler's scan loops settle
# it once each, while a `$(dune_psql ...)` substitution re-derives it in its own
# subshell, which is one grep against the cost of launching psql.
dune_psql_init() {
  [ -z "${DUNE_PSQL_INITIALIZED:-}" ] || return 0

  case "${DUNE_PSQL_TRANSPORT:-auto}" in
    auto)
      # type -P, not command -v: command -v would also match a shell function
      # named psql, and this repo used to carry one (deepdesert.sh) whose whole
      # body was a docker exec. Only a real client on PATH means TCP is possible.
      if type -P psql >/dev/null 2>&1; then
        DUNE_PSQL_TRANSPORT="tcp"
      else
        DUNE_PSQL_TRANSPORT="exec"
      fi
      ;;
    tcp|exec) ;;
    *)
      printf '%s\n' "Invalid DUNE_PSQL_TRANSPORT=$DUNE_PSQL_TRANSPORT; expected auto, tcp or exec." >&2
      return 1
      ;;
  esac

  # Resolved alongside the transport so _dune_psql_as can name the binary by
  # path. Falling back to the bare word keeps the old failure -- "psql: command
  # not found" -- for an operator who pinned DUNE_PSQL_TRANSPORT=tcp on an image
  # that has no client, rather than turning it into an empty-argv puzzle.
  if [ "$DUNE_PSQL_TRANSPORT" = "tcp" ]; then
    DUNE_PSQL_CLIENT="$(type -P psql || printf '%s' psql)"
  fi

  DUNE_PG_PORT="$(resolve_postgres_port)" || return 1

  # Resolved here rather than at the top of the file for the same reason as the
  # port: DUNE_DB_PASSWORD comes out of .env, which several callers read after
  # their `source` lines, and an eager default would pin `dune` before the
  # operator's value was ever visible. The default matches the one
  # postgres-bootstrap-sql.sh sets the role's password to.
  DUNE_PG_APP_PASSWORD="${DUNE_DB_PASSWORD:-dune}"

  DUNE_PSQL_INITIALIZED=1
}

# Run psql against the stack's database as a given role, passing through any
# psql arguments. Callers supply their own -c/-At/-F flags exactly as they did
# when they spelled out the docker exec.
#
# Both paths read from /dev/null. Many callers run this inside `while read`
# loops, and a psql started over TCP is a direct child that would otherwise
# inherit -- and, given a bare invocation, drain -- the loop's stdin. `docker
# exec` without -i never attached stdin, so redirecting keeps the TCP path
# behaving exactly like the exec path it replaces.
#
# Only the TCP path sends a password. The exec path reaches the server over its
# Unix socket, which the image trusts, and that is how every one of these
# queries already authenticated before the seam existed.
#
# DUNE_PSQL_TIMEOUT_SECONDS, when set, bounds a single query on either leg. It
# exists because the diagnostics -- ready.sh, status.sh -- wrapped every one of
# their `docker exec`s in `timeout` and would otherwise lose that watchdog on
# the way to the seam: `timeout` runs a program, and the seam is a shell
# function. Unset means no watchdog, which is what the autoscaler's scan loops
# have always run with, so nothing that does not opt in changes behaviour.
_dune_psql_as() {
  local role="$1" password="$2"
  shift 2

  local -a argv=()
  if [ -n "${DUNE_PSQL_TIMEOUT_SECONDS:-}" ]; then
    argv=(timeout --kill-after=2s "${DUNE_PSQL_TIMEOUT_SECONDS}s")
  fi

  if [ "$DUNE_PSQL_TRANSPORT" = "tcp" ]; then
    # The client is named by the absolute path dune_psql_init resolved, not by
    # the word `psql`. That is what the `command` builtin used to be here for --
    # to keep a shell function named psql from intercepting the call -- and a
    # path does the same job while remaining something `timeout` can exec, which
    # a builtin is not.
    argv+=("$DUNE_PSQL_CLIENT"
      -h 127.0.0.1
      -p "$DUNE_PG_PORT"
      -U "$role"
      -d "$DUNE_PG_DATABASE"
      "$@")
    PGPASSWORD="$password" "${argv[@]}" </dev/null
  else
    argv+=(docker exec "$DUNE_PG_CONTAINER" psql
      -U "$role"
      -d "$DUNE_PG_DATABASE"
      "$@")
    "${argv[@]}" </dev/null
  fi
}

# As the superuser. For work that needs it: catalog and partition maintenance,
# anything reaching outside the application's own tables.
dune_psql() {
  dune_psql_init || return 1
  _dune_psql_as "$DUNE_PG_SUPERUSER" "$DUNE_PG_SUPERUSER_PASSWORD" "$@"
}

# As the `dune` application role. The seam must not quietly widen what a script
# is allowed to do: a query that ran as `dune` before it moved onto the seam
# still runs as `dune` after.
dune_psql_app() {
  dune_psql_init || return 1
  _dune_psql_as "$DUNE_PG_APP_ROLE" "$DUNE_PG_APP_PASSWORD" "$@"
}

# The overwhelmingly common shape: one SQL statement, unaligned tuples only.
psql_value() {
  dune_psql -Atc "$1"
}

psql_app_value() {
  dune_psql_app -Atc "$1"
}
