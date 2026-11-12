#!/usr/bin/env bash
# Records why a game container went away and keeps what it logged.
#
# A removed container takes its `docker logs` with it and leaves no trace of who
# asked. Call dune_container_removal_hook just BEFORE `docker rm`. It never
# fails the caller: evidence gathering must not stop a stop.
#
#   runtime/generated/container-lifecycle.log   one line per removal: time, reason, container,
#                                               exit state, requester and caller process chain
#   runtime/generated/logs/containers/          the container's output, one .log.gz per removal
#   runtime/generated/logs/archive/<server>/    rotated game logs (Saved/Logs backups) and the run that ended
#
# Everything is written owner-only (files 0600, directories 0700) and passed
# through dune_redact_stream, because the game echoes its own command line,
# including tokens and the database password, into its output and logs.
# The requester fields come from the environment and are advisory: this is a
# local, best-effort record, not a tamper-evident audit trail.
#
# Switches (all optional):
#   DUNE_KEEP_CONTAINER_LOGS=0          do not save container output (default 1)
#   DUNE_KEPT_CONTAINER_LOGS=N          outputs kept per container (default 10)
#   DUNE_KEPT_CONTAINER_LOGS_TOTAL=N    outputs kept across all containers (default 100)
#   DUNE_ARCHIVE_GAME_LOGS=0            do not archive game logs (default 1)
#   DUNE_GAME_LOG_ARCHIVE_DAYS=N        days an archived game log is kept (default 30)
#   DUNE_GAME_LOG_ARCHIVE_MAX_FILES=N   archived files kept per server (default 60)
#   DUNE_CONTAINER_LOG_TIMEOUT=N        seconds to wait for `docker logs` (default 30)
#   DUNE_ARCHIVE_TIMEOUT=N              seconds allowed per archived file (default 60)
#   DUNE_REQUEST_SOURCE=text            free-form requester label recorded in the log
#
# Rotated game logs are archived at each removal, so a log the game rotates and
# prunes during one very long run (without any removal in between) can be missed.

DUNE_LIFECYCLE_LOG="${DUNE_LIFECYCLE_LOG:-runtime/generated/container-lifecycle.log}"
DUNE_CONTAINER_LOG_DIR="${DUNE_CONTAINER_LOG_DIR:-runtime/generated/logs/containers}"
DUNE_GAME_LOG_ARCHIVE_DIR="${DUNE_GAME_LOG_ARCHIVE_DIR:-runtime/generated/logs/archive}"

# Root-run maintenance and the Console share these records. Use the existing
# installation-owner contract when available; partial script copies still work.
# shellcheck source=runtime/scripts/host-file-ownership.sh
source runtime/scripts/host-file-ownership.sh 2>/dev/null || true

dune_lifecycle_path_owner() {
  if declare -F dune_set_host_path_owner >/dev/null 2>&1; then
    dune_set_host_path_owner "$1"
  fi
  return 0
}

# A positive integer from a setting, or the default when it is empty, zero or not a number.
dune_positive_or_default() {
  case "$1" in '' | *[!0-9]* | 0*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac
}

# Masks the value of anything that looks like a credential in a stream: NAME=value
# command-line arguments and "name":"value" JSON, for names containing password,
# passwd, token, secret or key (case-insensitive). Best effort: it cannot know
# every format a game or library prints.
dune_redact_stream() {
  LC_ALL=C sed -E \
    -e 's/([A-Za-z0-9_.:-]*([Pp][Aa][Ss][Ss][Ww][Oo]?[Rr]?[Dd]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Pp][Ii]_?[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh]_?[Kk][Ee][Yy])[A-Za-z0-9_.-]*=)("[^"]*"|[^ ]+)/\1[redacted]/g' \
    -e 's/("[A-Za-z0-9_.-]*([Pp][Aa][Ss][Ss][Ww][Oo]?[Rr]?[Dd]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Pp][Ii]_?[Kk][Ee][Yy])[A-Za-z0-9_.-]*"[[:space:]]*:[[:space:]]*")[^"]*/\1[redacted]/g'
}

# The calling process chain, nearest first, as "comm(pid) < comm(pid) ...".
dune_caller_chain() {
  local pid="$$" depth=0 chain="" comm="" ppid=""
  while [ "$depth" -lt 8 ] && [ "$pid" -gt 1 ] 2>/dev/null && [ -r "/proc/$pid/stat" ]; do
    comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"
    ppid="$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null || true)"
    chain="${chain:+$chain < }${comm:-?}($pid)"
    [ -n "$ppid" ] || break
    pid="$ppid"
    depth=$((depth + 1))
  done
  printf '%s' "$chain"
}

# Tabs and newlines would break the one-line-per-event format.
dune_lifecycle_clean() {
  printf '%s' "$1" | tr '\t\n\r' '   '
}

dune_private_dir() {
  local parent
  parent="$(dirname "$1")"
  if [ ! -d "$parent" ]; then
    dune_private_dir "$parent" || return 1
  fi
  mkdir -p "$1" 2>/dev/null
  chmod 700 "$1" 2>/dev/null || true
  dune_lifecycle_path_owner "$1"
}

dune_container_removal_hook() {
  local container="$1" reason="${2:-removal}" state="" caller="" who="" ts="" out="" keep="" total=""
  command -v docker >/dev/null 2>&1 || return 0
  timeout 10 docker inspect "$container" >/dev/null 2>&1 || return 0
  (
    set +e
    umask 077
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    state="$(timeout 10 docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} restarts={{.RestartCount}}' "$container" 2>/dev/null)"
    who="user=$(id -un 2>/dev/null)"
    [ -z "${SUDO_USER:-}" ] || who="$who sudo_user=$(dune_lifecycle_clean "$SUDO_USER")"
    [ -z "${SSH_CONNECTION:-}" ] || who="$who ssh=$(dune_lifecycle_clean "${SSH_CONNECTION%% *}")"
    [ -z "${DUNE_REQUEST_SOURCE:-}" ] || who="$who source=$(dune_lifecycle_clean "$DUNE_REQUEST_SOURCE")"
    caller="$(dune_caller_chain)"
    # runtime/generated is shared state, not a private archive directory.
    # Preserve its existing access mode for other services and host users.
    mkdir -p "$(dirname "$DUNE_LIFECYCLE_LOG")" 2>/dev/null
    dune_trim_lifecycle_log
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -Iseconds)" "$(dune_lifecycle_clean "$reason")" "$container" "$state" "$who" "$caller" >>"$DUNE_LIFECYCLE_LOG"
    chmod 600 "$DUNE_LIFECYCLE_LOG" 2>/dev/null
    dune_lifecycle_path_owner "$DUNE_LIFECYCLE_LOG"
    if [ "${DUNE_KEEP_CONTAINER_LOGS:-1}" != "0" ]; then
      dune_private_dir "$DUNE_CONTAINER_LOG_DIR"
      out="$DUNE_CONTAINER_LOG_DIR/$container-$ts.log.gz"
      # A temp file renamed on success, so a failed or timed-out save never
      # leaves a truncated file that counts toward the keep-N pruning.
      if (set -o pipefail; timeout "$(dune_positive_or_default "${DUNE_CONTAINER_LOG_TIMEOUT:-}" 30)" docker logs --timestamps "$container" 2>&1 | dune_redact_stream | gzip -c >"$out.part"); then
        mv -f "$out.part" "$out"
        dune_lifecycle_path_owner "$out"
      else
        rm -f "$out.part"
      fi
      keep="$(dune_positive_or_default "${DUNE_KEPT_CONTAINER_LOGS:-}" 10)"
      total="$(dune_positive_or_default "${DUNE_KEPT_CONTAINER_LOGS_TOTAL:-}" 100)"
      dune_prune_newest "$DUNE_CONTAINER_LOG_DIR" "$container-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.log.gz" "$keep"
      dune_prune_newest "$DUNE_CONTAINER_LOG_DIR" "*.log.gz" "$total"
    fi
    case "$container" in
      dune-server-*)
        dune_archive_game_logs "${container#dune-server-}" "" "$ts"
        ;;
    esac
  ) || true
  return 0
}

# Keep the log small: past 1 MiB, keep the newest 2000 lines.
dune_trim_lifecycle_log() {
  local size=0
  [ -f "$DUNE_LIFECYCLE_LOG" ] || return 0
  size="$(wc -c <"$DUNE_LIFECYCLE_LOG" 2>/dev/null || echo 0)"
  [ "$size" -gt 1048576 ] || return 0
  tail -n 2000 "$DUNE_LIFECYCLE_LOG" >"$DUNE_LIFECYCLE_LOG.part" && mv -f "$DUNE_LIFECYCLE_LOG.part" "$DUNE_LIFECYCLE_LOG"
}

# Keep the newest N files matching a pattern in a directory.
dune_prune_newest() {
  local dir="$1" pattern="$2" keep="$3"
  keep="$(dune_positive_or_default "$keep" 10)"
  # shellcheck disable=SC2012
  ls -1t "$dir"/$pattern 2>/dev/null | tail -n +"$((keep + 1))" | while IFS= read -r old; do rm -f -- "$old"; done
}

# Compresses one game log into a destination, redacted, through a temp file.
dune_archive_one() {
  local src="$1" dest_file="$2"
  [ -f "$src" ] && [ ! -L "$src" ] || return 0
  if (set -o pipefail; timeout "$(dune_positive_or_default "${DUNE_ARCHIVE_TIMEOUT:-}" 60)" cat -- "$src" | dune_redact_stream | gzip -c >"$dest_file.part"); then
    mv -f "$dest_file.part" "$dest_file"
    dune_lifecycle_path_owner "$dest_file"
  else
    rm -f "$dest_file.part"
  fi
}

# Compress the game's rotated logs before the game deletes them. When a
# timestamp is given (a removal), the run that is ending is saved too, as
# "<name>-final-<ts>.log.gz". The live log itself is never modified. Symlinks
# in the log directory are skipped.
dune_archive_game_logs() {
  local server="$1" logs_dir="${2:-}" final_ts="${3:-}" dest="" f="" days="" max=""
  [ "${DUNE_ARCHIVE_GAME_LOGS:-1}" != "0" ] || return 0
  [ -n "$logs_dir" ] || logs_dir="runtime/game/$server/Saved/Logs"
  [ -d "$logs_dir" ] || return 0
  days="$(dune_positive_or_default "${DUNE_GAME_LOG_ARCHIVE_DAYS:-}" 30)"
  max="$(dune_positive_or_default "${DUNE_GAME_LOG_ARCHIVE_MAX_FILES:-}" 60)"
  dest="$DUNE_GAME_LOG_ARCHIVE_DIR/$server"
  (
    set +e
    umask 077
    dune_private_dir "$dest"
    for f in "$logs_dir"/*-backup-*.log; do
      [ -f "$f" ] && [ ! -L "$f" ] || continue
      [ -e "$dest/$(basename "$f").gz" ] && continue
      dune_archive_one "$f" "$dest/$(basename "$f").gz"
    done
    if [ -n "$final_ts" ]; then
      for f in "$logs_dir"/*.log; do
        case "$f" in *-backup-*) continue ;; esac
        dune_archive_one "$f" "$dest/$(basename "$f" .log)-final-$final_ts.log.gz"
      done
    fi
    find "$dest" -maxdepth 1 -name '*.gz' -mtime "+$days" -delete 2>/dev/null
    find "$dest" -maxdepth 1 -name '*.part' -mmin +60 -delete 2>/dev/null
    dune_prune_newest "$dest" "*.gz" "$max"
  ) || true
  return 0
}
