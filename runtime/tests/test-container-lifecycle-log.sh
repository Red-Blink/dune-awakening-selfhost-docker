#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/work"
repo="$PWD"

# A docker stand-in: `inspect` answers for known containers only, `logs` prints
# what the game would have said before it was removed.
cat >"$test_root/bin/docker" <<'SH'
#!/usr/bin/env bash
case "$1" in
  inspect)
    [ "${*: -1}" = "dune-server-survival-1-38" ] || exit 1
    case " $* " in
      *" --format "*) echo "status=running exit=0 oom=false started=2026-11-06T05:00:00Z finished=0001-01-01T00:00:00Z restarts=0" ;;
    esac
    ;;
  logs) echo "2026-11-06T10:29:00Z last line before removal" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$test_root/bin/docker"
export PATH="$test_root/bin:$PATH"

cd "$test_root/work"
saved="runtime/game/survival-1-38/Saved/Logs"
mkdir -p "$saved"
echo "live run" >"$saved/DuneSandbox_PIDX-38.log"
echo "older run" >"$saved/DuneSandbox_PIDX-38-backup-2026.11.05-13.00.44.log"

# shellcheck source=runtime/scripts/lib/container-lifecycle.sh
source "$repo/runtime/scripts/lib/container-lifecycle.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. A removal records the requester and the exit state, and saves the output.
SSH_CONNECTION="192.0.2.7 50000 192.0.2.1 22" DUNE_REQUEST_SOURCE="unit test" \
  dune_container_removal_hook dune-server-survival-1-38 despawn-server
line="$(tail -n1 runtime/generated/container-lifecycle.log)"
for want in "despawn-server" "dune-server-survival-1-38" "oom=false" "ssh=192.0.2.7" "source=unit test" "user="; do
  case "$line" in *"$want"*) ;; *) fail "lifecycle line missing '$want': $line" ;; esac
done
[ "$(awk -F'\t' '{print NF}' <<<"$line")" = "6" ] || fail "lifecycle line is not 6 tab-separated fields"
saved_log="$(ls runtime/generated/logs/containers/dune-server-survival-1-38-*.log.gz)"
zcat "$saved_log" | grep -q "last line before removal" || fail "container output was not saved"

# 2. The run that is ending and the older rotated log are both archived; the
#    live log itself is left alone.
ls runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-final-*.log.gz >/dev/null || fail "ending run was not archived"
zcat runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-final-*.log.gz | grep -q "live run" || fail "archived ending run has wrong content"
[ -f runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-backup-2026.11.05-13.00.44.log.gz ] || fail "rotated log was not archived"
[ "$(cat "$saved/DuneSandbox_PIDX-38.log")" = "live run" ] || fail "live log was modified"

# 3. Only the newest N saved outputs are kept.
for i in 1 2 3 4; do
  touch -d "2026-01-0$i" "runtime/generated/logs/containers/dune-server-survival-1-38-2026010${i}T000000Z.log.gz"
done
DUNE_KEPT_CONTAINER_LOGS=2 dune_container_removal_hook dune-server-survival-1-38 despawn-server
[ "$(ls runtime/generated/logs/containers | wc -l)" = "2" ] || fail "pruning did not keep exactly 2 outputs"

# 4. Archived game logs older than the window are removed; recent ones stay.
echo old | gzip -c >runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-backup-2026.08.01-13.00.00.log.gz
touch -d "90 days ago" runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-backup-2026.08.01-13.00.00.log.gz
dune_archive_game_logs survival-1-38 "" ""
[ ! -e runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-backup-2026.08.01-13.00.00.log.gz ] || fail "expired archive was not removed"
[ -f runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-backup-2026.11.05-13.00.44.log.gz ] || fail "recent archive was removed"

# 5. Switches turn the saving off; the line is still written.
rm -rf runtime/generated
DUNE_KEEP_CONTAINER_LOGS=0 DUNE_ARCHIVE_GAME_LOGS=0 dune_container_removal_hook dune-server-survival-1-38 despawn-server
[ -s runtime/generated/container-lifecycle.log ] || fail "line not written with saving disabled"
[ ! -d runtime/logs ] || fail "logs were saved although disabled"

# 6. It never fails the caller: unknown container, and no docker at all.
dune_container_removal_hook not-a-container despawn-server || fail "unknown container made the hook fail"
PATH="/usr/bin:/bin" bash -c 'source "$1"; command -v docker >/dev/null && exit 0; dune_container_removal_hook dune-server-survival-1-38 x' _ "$repo/runtime/scripts/lib/container-lifecycle.sh" || fail "missing docker made the hook fail"

echo "container removal records the requester, keeps output and game logs, and never blocks a stop"
