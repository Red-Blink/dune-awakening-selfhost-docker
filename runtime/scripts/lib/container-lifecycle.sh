#!/usr/bin/env bash
# Records why a game container went away and keeps what it logged.
#
# A removed container takes its `docker logs` with it and leaves no trace of who
# asked. Call dune_container_removal_hook just BEFORE `docker rm`. It never
# fails the caller: evidence gathering must not stop a stop.
#
#   runtime/generated/container-lifecycle.log   one line per removal: time, container,
#                                               exit state and caller
#   runtime/generated/logs/containers/<name>-<UTC>.log.gz the container's output
#   runtime/generated/logs/archive/<server>/              rotated game logs (Saved/Logs backups)
#
# Switches (all optional):
#   DUNE_KEEP_CONTAINER_LOGS=0     do not save container output (default 1)
#   DUNE_KEPT_CONTAINER_LOGS=N     saved outputs kept per container (default 10)
#   DUNE_ARCHIVE_GAME_LOGS=0       do not archive rotated game logs (default 1)
#   DUNE_GAME_LOG_ARCHIVE_DAYS=N   days to keep archived game logs (default 30)
#   DUNE_REQUEST_SOURCE=text       free-form requester label recorded in the log

DUNE_LIFECYCLE_LOG="${DUNE_LIFECYCLE_LOG:-runtime/generated/container-lifecycle.log}"
DUNE_CONTAINER_LOG_DIR="${DUNE_CONTAINER_LOG_DIR:-runtime/generated/logs/containers}"
DUNE_GAME_LOG_ARCHIVE_DIR="${DUNE_GAME_LOG_ARCHIVE_DIR:-runtime/generated/logs/archive}"

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

dune_container_removal_hook() {
  local container="$1" reason="${2:-removal}" state="" caller="" who="" ts=""
  command -v docker >/dev/null 2>&1 || return 0
  docker inspect "$container" >/dev/null 2>&1 || return 0
  (
    set +e
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    state="$(docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} restarts={{.RestartCount}}' "$container" 2>/dev/null)"
    who="user=$(id -un 2>/dev/null)"
    [ -z "${SUDO_USER:-}" ] || who="$who sudo_user=$SUDO_USER"
    [ -z "${SSH_CONNECTION:-}" ] || who="$who ssh=${SSH_CONNECTION%% *}"
    [ -z "${DUNE_REQUEST_SOURCE:-}" ] || who="$who source=$(dune_lifecycle_clean "$DUNE_REQUEST_SOURCE")"
    caller="$(dune_caller_chain)"
    mkdir -p "$(dirname "$DUNE_LIFECYCLE_LOG")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -Iseconds)" "$reason" "$container" "$state" "$who" "$caller" >>"$DUNE_LIFECYCLE_LOG"
    if [ "${DUNE_KEEP_CONTAINER_LOGS:-1}" != "0" ]; then
      mkdir -p "$DUNE_CONTAINER_LOG_DIR"
      docker logs --timestamps "$container" 2>&1 | gzip -c >"$DUNE_CONTAINER_LOG_DIR/$container-$ts.log.gz"
      dune_prune_newest "$DUNE_CONTAINER_LOG_DIR" "$container-*.log.gz" "${DUNE_KEPT_CONTAINER_LOGS:-10}"
    fi
    case "$container" in
      dune-server-*)
        dune_archive_game_logs "${container#dune-server-}" "" "$ts"
        ;;
    esac
  ) || true
  return 0
}

# Keep the newest N files matching a pattern in a directory.
dune_prune_newest() {
  local dir="$1" pattern="$2" keep="$3"
  case "$keep" in '' | *[!0-9]*) keep=10 ;; esac
  # shellcheck disable=SC2012
  ls -1t "$dir"/$pattern 2>/dev/null | tail -n +"$((keep + 1))" | while IFS= read -r old; do rm -f -- "$old"; done
}

# Compress the game's rotated logs before the game deletes them. When a
# timestamp is given (a removal), the run that is ending is saved too, as
# "<name>-final-<ts>.log.gz". The live log itself is never modified.
dune_archive_game_logs() {
  local server="$1" logs_dir="${2:-}" final_ts="${3:-}" days="${DUNE_GAME_LOG_ARCHIVE_DAYS:-30}" dest="" f=""
  [ "${DUNE_ARCHIVE_GAME_LOGS:-1}" != "0" ] || return 0
  [ -n "$logs_dir" ] || logs_dir="runtime/game/$server/Saved/Logs"
  [ -d "$logs_dir" ] || return 0
  case "$days" in '' | *[!0-9]*) days=30 ;; esac
  dest="$DUNE_GAME_LOG_ARCHIVE_DIR/$server"
  (
    set +e
    mkdir -p "$dest"
    for f in "$logs_dir"/*-backup-*.log; do
      [ -f "$f" ] || continue
      [ -e "$dest/$(basename "$f").gz" ] && continue
      gzip -c "$f" >"$dest/$(basename "$f").gz.part" && mv -f "$dest/$(basename "$f").gz.part" "$dest/$(basename "$f").gz"
    done
    if [ -n "$final_ts" ]; then
      for f in "$logs_dir"/*.log; do
        [ -f "$f" ] || continue
        case "$f" in *-backup-*) continue ;; esac
        gzip -c "$f" >"$dest/$(basename "$f" .log)-final-$final_ts.log.gz"
      done
    fi
    find "$dest" -maxdepth 1 -name '*.gz' -mtime "+$days" -delete 2>/dev/null
    find "$dest" -maxdepth 1 -name '*.part' -mmin +60 -delete 2>/dev/null
  ) || true
  return 0
}
