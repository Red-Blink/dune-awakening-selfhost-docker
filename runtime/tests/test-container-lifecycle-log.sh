#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/work"
repo="$PWD"

# A docker stand-in: `inspect` answers for known containers only, `logs` prints
# what the game would have said before it was removed (including the kind of
# command line the game echoes, which carries credentials). FAKE_LOGS=hang or
# fail makes `logs` misbehave.
cat >"$test_root/bin/docker" <<'SH'
#!/usr/bin/env bash
case "$1" in
  inspect)
    case "${*: -1}" in dune-server-survival-1-38 | dune-server-survival-1) ;; *) exit 1 ;; esac
    case " $* " in
      *" --format "*) echo "status=running exit=0 oom=false started=2026-11-06T05:00:00Z finished=0001-01-01T00:00:00Z restarts=0" ;;
    esac
    ;;
  logs)
    case "${FAKE_LOGS:-ok}" in
      hang) sleep 30 ;;
      fail) echo "partial" ; exit 1 ;;
    esac
    echo "2026-11-06T10:29:00Z last line before removal"
    echo 'Command Line: Survival_1 -DatabasePassword=hunter2pass -ini:engine:[FuncomLiveServices]:ServiceAuthToken=abc123tok -RMQGameTlsEnabled=true'
    echo '{"loginPassword":"Sw0rdfish","displayName":"Atrium"}'
    ;;
  ps) exit 0 ;;
  rm) exit 0 ;;
  *) exit 1 ;;
esac
SH
chmod +x "$test_root/bin/docker"
export PATH="$test_root/bin:$PATH"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 0. Every removal site calls the hook, and before it removes the container.
check_order() {
  local file="$1" rm_pattern="$2" hook rmline
  hook="$(grep -n 'dune_container_removal_hook' "$repo/$file" | grep -v '^[0-9]*:#' | grep -v 'declare -F' | head -n1 | cut -d: -f1 || true)"
  rmline="$(grep -n "$rm_pattern" "$repo/$file" | head -n1 | cut -d: -f1 || true)"
  [ -n "$hook" ] || fail "$file never calls dune_container_removal_hook"
  [ -n "$rmline" ] || fail "$file: no line matches '$rm_pattern'"
  [ "$hook" -lt "$rmline" ] || fail "$file calls the hook (line $hook) after removing the container (line $rmline)"
}
check_order runtime/scripts/despawn-server.sh 'docker rm -f "\$container"'
check_order runtime/scripts/stop-server-survival-1.sh 'docker rm -f dune-server-survival-1 '
check_order runtime/scripts/stop-server-overmap.sh 'docker rm -f dune-server-overmap '
check_order runtime/scripts/recycle-world-game-servers.sh 'docker rm -f "\$name"'
check_order runtime/scripts/db.sh "xargs -r docker rm -f"
check_order runtime/scripts/lib/game-container.sh 'docker rm'

cd "$test_root/work"
saved="runtime/game/survival-1-38/Saved/Logs"
mkdir -p "$saved"
echo "live run" >"$saved/DuneSandbox_PIDX-38.log"
echo "older run" >"$saved/DuneSandbox_PIDX-38-backup-2026.11.05-13.00.44.log"
echo "Command Line: -DatabasePassword=gamelogpass -ServiceAuthToken=gamelogtok" >>"$saved/DuneSandbox_PIDX-38.log"

# shellcheck source=runtime/scripts/lib/container-lifecycle.sh
source "$repo/runtime/scripts/lib/container-lifecycle.sh"

# The shared state directory is not an archive directory. Tightening it during
# a root-run stop can lock the installation owner and Console out of state.
mkdir -p runtime/generated
chmod 775 runtime/generated

# 1. A removal records the requester and the exit state, and saves the output.
SSH_CONNECTION="192.0.2.7 50000 192.0.2.1 22" DUNE_REQUEST_SOURCE="unit test" \
  dune_container_removal_hook dune-server-survival-1-38 despawn-server
line="$(tail -n1 runtime/generated/container-lifecycle.log)"
for want in "despawn-server" "dune-server-survival-1-38" "oom=false" "ssh=192.0.2.7" "source=unit test" "user="; do
  case "$line" in *"$want"*) ;; *) fail "lifecycle line missing '$want': $line" ;; esac
done
[ "$(awk -F'\t' '{print NF}' <<<"$line")" = "6" ] || fail "lifecycle line is not 6 tab-separated fields"
awk -F'\t' '{print $6}' <<<"$line" | grep -q '(' || fail "caller chain is empty"
saved_log="$(ls runtime/generated/logs/containers/dune-server-survival-1-38-*.log.gz)"
zcat "$saved_log" | grep -q "last line before removal" || fail "container output was not saved"

# 2. The run that is ending and the older rotated log are archived; backups are
#    not duplicated as finals; the live log is left alone.
final="$(ls runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-final-*.log.gz)"
zcat "$final" | grep -q "live run" || fail "archived ending run has wrong content"
[ -f runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-backup-2026.11.05-13.00.44.log.gz ] || fail "rotated log was not archived"
[ -z "$(find runtime/generated/logs/archive/survival-1-38 -name '*backup*final*')" ] || fail "a rotated backup was duplicated as a final"
grep -q "gamelogpass" "$saved/DuneSandbox_PIDX-38.log" || fail "live log was modified"

# 3. Credentials are masked in saved output and archived game logs.
for f in "$saved_log" "$final"; do
  content="$(zcat "$f")"
  for secret in hunter2pass abc123tok Sw0rdfish gamelogpass gamelogtok; do
    case "$content" in *"$secret"*) fail "$secret survived redaction in $f" ;; esac
  done
done
zcat "$saved_log" | grep -q "RMQGameTlsEnabled=true" || fail "redaction removed ordinary arguments"
zcat "$saved_log" | grep -q "Atrium" || fail "redaction removed ordinary JSON values"

# 4. Everything is private: files 0600, directories 0700.
for p in runtime/generated/container-lifecycle.log "$saved_log" "$final"; do
  [ "$(stat -c %a "$p")" = "600" ] || fail "$p is not mode 600"
done
[ "$(stat -c %a runtime/generated)" = "775" ] || fail "shared generated directory permissions changed"
for d in runtime/generated/logs runtime/generated/logs/containers runtime/generated/logs/archive runtime/generated/logs/archive/survival-1-38; do
  [ "$(stat -c %a "$d")" = "700" ] || fail "$d is not mode 700"
done

# 5. Only the newest N saved outputs are kept, and a bad setting falls back
#    to the default instead of deleting everything.
for i in 1 2 3 4; do
  echo x | gzip -c >"runtime/generated/logs/containers/dune-server-survival-1-38-2026010${i}T000000Z.log.gz"
  touch -d "2026-01-0$i" "runtime/generated/logs/containers/dune-server-survival-1-38-2026010${i}T000000Z.log.gz"
done
DUNE_KEPT_CONTAINER_LOGS=2 dune_container_removal_hook dune-server-survival-1-38 despawn-server
[ "$(ls runtime/generated/logs/containers | wc -l)" = "2" ] || fail "pruning did not keep exactly 2 outputs"
for bad in 0 abc -3 ""; do
  DUNE_KEPT_CONTAINER_LOGS="$bad" DUNE_GAME_LOG_ARCHIVE_DAYS="$bad" dune_container_removal_hook dune-server-survival-1-38 despawn-server
  [ "$(ls runtime/generated/logs/containers | wc -l)" -ge 2 ] || fail "setting '$bad' deleted saved outputs"
  [ -f runtime/generated/logs/archive/survival-1-38/DuneSandbox_PIDX-38-backup-2026.11.05-13.00.44.log.gz ] || fail "setting '$bad' deleted the archive"
done

# 6. Pruning one container does not touch another whose name it prefixes.
for i in 1 2 3; do
  echo x | gzip -c >"runtime/generated/logs/containers/dune-server-survival-1-38-2026020${i}T000000Z.log.gz"
done
DUNE_KEPT_CONTAINER_LOGS=1 dune_container_removal_hook dune-server-survival-1 despawn-server
[ "$(find runtime/generated/logs/containers -name 'dune-server-survival-1-38-2026020*.log.gz' | wc -l)" = "3" ] \
  || fail "pruning dune-server-survival-1 deleted dune-server-survival-1-38 outputs"
[ "$(find runtime/generated/logs/containers -name 'dune-server-survival-1-2*.log.gz' ! -name '*-1-38-*' | wc -l)" = "1" ] \
  || fail "pruning did not keep exactly 1 output for dune-server-survival-1"

# 7. Archived game logs older than the window are removed; a symlink planted
#    in the log directory is never followed.
dest=runtime/generated/logs/archive/survival-1-38
echo old | gzip -c >"$dest/DuneSandbox_PIDX-38-backup-2026.08.01-13.00.00.log.gz"
touch -d "90 days ago" "$dest/DuneSandbox_PIDX-38-backup-2026.08.01-13.00.00.log.gz"
echo "TOPSECRETDATA" >"$test_root/outside.txt"
ln -s "$test_root/outside.txt" "$saved/DuneSandbox_PIDX-38-backup-2026.11.06-00.00.00.log"
dune_archive_game_logs survival-1-38 "" ""
[ ! -e "$dest/DuneSandbox_PIDX-38-backup-2026.08.01-13.00.00.log.gz" ] || fail "expired archive was not removed"
[ -f "$dest/DuneSandbox_PIDX-38-backup-2026.11.05-13.00.44.log.gz" ] || fail "recent archive was removed"
[ ! -e "$dest/DuneSandbox_PIDX-38-backup-2026.11.06-00.00.00.log.gz" ] || fail "a symlinked log was archived"
rm -f "$saved/DuneSandbox_PIDX-38-backup-2026.11.06-00.00.00.log"

# 8. A hung or failing `docker logs` neither blocks the removal nor leaves a
#    partial file, and the lifecycle line is still written.
before="$(wc -l <runtime/generated/container-lifecycle.log)"
start=$SECONDS
FAKE_LOGS=hang DUNE_CONTAINER_LOG_TIMEOUT=1 dune_container_removal_hook dune-server-survival-1-38 despawn-server
[ $((SECONDS - start)) -lt 15 ] || fail "a hung docker logs held the removal for $((SECONDS - start))s"
saved_before="$(find runtime/generated/logs/containers -name '*.log.gz' | wc -l)"
FAKE_LOGS=fail DUNE_KEPT_CONTAINER_LOGS=50 dune_container_removal_hook dune-server-survival-1-38 despawn-server
[ "$(find runtime/generated/logs/containers -name '*.log.gz' | wc -l)" = "$saved_before" ] || fail "a failing docker logs left a saved output"
[ "$(wc -l <runtime/generated/container-lifecycle.log)" = "$((before + 2))" ] || fail "lifecycle lines missing after failed saves"
[ -z "$(find runtime/generated/logs -name '*.part')" ] || fail "a failed save left a .part file"
# no empty/truncated output was kept
[ -z "$(find runtime/generated/logs/containers -name '*.gz' -size -20c)" ] || fail "a failed save left an empty .gz"

# 9. The requester fields cannot break the one-line format.
before="$(wc -l <runtime/generated/container-lifecycle.log)"
SSH_CONNECTION=$'1.2.3.4\tforged 5 6 7' DUNE_REQUEST_SOURCE=$'a\tb\nforged\tline' \
  dune_container_removal_hook dune-server-survival-1-38 despawn-server
[ "$(wc -l <runtime/generated/container-lifecycle.log)" = "$((before + 1))" ] || fail "a newline in the source forged an extra line"
[ "$(tail -n1 runtime/generated/container-lifecycle.log | awk -F'\t' '{print NF}')" = "6" ] || fail "a tab in the source broke the field count"

# 10. The lifecycle log is bounded.
awk 'BEGIN { for (i = 0; i < 40000; i++) print "2026-01-01T00:00:00+00:00\told\tc\ts\tw\tx" }' >runtime/generated/container-lifecycle.log
dune_container_removal_hook dune-server-survival-1-38 despawn-server
[ "$(wc -l <runtime/generated/container-lifecycle.log)" -le 2002 ] || fail "lifecycle log was not trimmed"

# 11. Switches turn the saving off; the line is still written.
rm -rf runtime/generated
DUNE_KEEP_CONTAINER_LOGS=0 DUNE_ARCHIVE_GAME_LOGS=0 dune_container_removal_hook dune-server-survival-1-38 despawn-server
[ -s runtime/generated/container-lifecycle.log ] || fail "line not written with saving disabled"
[ ! -d runtime/generated/logs ] || fail "logs were saved although disabled"

# 12. It never fails the caller: unknown container, and no docker at all.
dune_container_removal_hook not-a-container despawn-server || fail "unknown container made the hook fail"
mkdir -p "$test_root/empty"
PATH="$test_root/empty" /bin/bash -c 'source "$1"; dune_container_removal_hook dune-server-survival-1-38 x' _ "$repo/runtime/scripts/lib/container-lifecycle.sh" || fail "missing docker made the hook fail"

# Root-created private directories and files must use the existing host-owner
# helper, including newly created intermediate archive directories. Spy on the
# ownership boundary so this regression works without root privileges in CI.
dune_set_host_path_owner() { printf '%s\n' "$1" >>"$test_root/owner-paths"; }
dune_container_removal_hook dune-server-survival-1-38 ownership-test
for path in runtime/generated/container-lifecycle.log runtime/generated/logs runtime/generated/logs/containers runtime/generated/logs/archive runtime/generated/logs/archive/survival-1-38; do
  grep -Fxq "$path" "$test_root/owner-paths" || fail "ownership not assigned for $path"
done
grep -q '/containers/.*\.log.gz$' "$test_root/owner-paths" || fail "saved output ownership not assigned"
grep -q '/archive/.*\.log.gz$' "$test_root/owner-paths" || fail "archived game log ownership not assigned"
unset -f dune_set_host_path_owner

# 13. The start path records a replaced container even though its caller never
#     sources the lifecycle helper itself.
mkdir -p "$test_root/work2/runtime/scripts/lib"
cp "$repo/runtime/scripts/lib/game-container.sh" "$repo/runtime/scripts/lib/container-lifecycle.sh" "$test_root/work2/runtime/scripts/lib/"
(
  cd "$test_root/work2"
  # shellcheck disable=SC1091
  source runtime/scripts/lib/game-container.sh
  remove_existing_game_container dune-server-survival-1-38 >/dev/null 2>&1 || true
  grep -q "start-replace" runtime/generated/container-lifecycle.log
) || fail "start path did not record the replaced container"

echo "container removal records the requester, keeps redacted private output and game logs, and never blocks a stop"
