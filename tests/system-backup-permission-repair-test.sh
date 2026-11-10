#!/usr/bin/env bash
# The saved scheduled-backup passphrase lives in runtime/system-backup/. The
# permission repair must reach it (a root-owned key fails every scheduled run)
# without ever loosening its 0600/0700 modes. Unlike
# runtime-permission-helper-rebuild-test.sh, the fake docker here actually runs
# the helper's inner script against the fixture, so the chown/chmod logic is
# exercised rather than stubbed.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fixture="$test_root/project"
mkdir -p "$fixture/runtime/scripts" "$fixture/runtime/generated" "$fixture/runtime/logs" \
  "$fixture/runtime/text-router" "$fixture/runtime/system-backup" "$test_root/bin"
cp "$repo_root/runtime/scripts/repair-host-runtime-permissions.sh" \
  "$repo_root/runtime/scripts/host-paths.sh" "$fixture/runtime/scripts/"

cat > "$test_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  "image inspect") exit 0 ;;
  "run --rm")
    shift 2
    envs=()
    host=""
    script=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --user|--entrypoint|-w) shift 2 ;;
        -e) envs+=("$2"); shift 2 ;;
        -v) host="${2%:/repo}"; shift 2 ;;
        -lc) script="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    cd "$host"
    env "${envs[@]}" bash -c "$script"
    ;;
  *) echo "Unexpected fake Docker call: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$test_root/bin/docker"
export PATH="$test_root/bin:$PATH"

passphrase="$fixture/runtime/system-backup/passphrase"
printf 'saved-passphrase-value' > "$passphrase"
printf '{"savedAt":"2026-11-09T10:00:00.000Z"}\n' > "$fixture/runtime/system-backup/passphrase.json"
chmod 700 "$fixture/runtime/system-backup"
chmod 600 "$passphrase" "$fixture/runtime/system-backup/passphrase.json"

target_uid="$(id -u)"
target_gid="$(id -g)"
# Only root can hand a file to someone else, so the "foreign owner" half of the
# check runs where the suite runs as root and is skipped on a non-root runner.
foreign_owner=0
if [ "$target_uid" = "0" ]; then
  chown 4242:4242 "$fixture/runtime/system-backup" "$passphrase"
  foreign_owner=1
fi

(
  cd "$fixture"
  DUNE_HOST_UID="$target_uid" DUNE_HOST_GID="$target_gid" \
    DUNE_RUNTIME_REPO_ROOT="$fixture" DUNE_RUNTIME_HOST_REPO_ROOT="$fixture" \
    runtime/scripts/repair-host-runtime-permissions.sh
) > "$test_root/repair.log" 2>&1 || { cat "$test_root/repair.log"; echo "FAIL permission repair exited non-zero"; exit 1; }

if [ "$(stat -c '%u:%g' "$passphrase")" != "$target_uid:$target_gid" ] \
    || [ "$(stat -c '%u:%g' "$fixture/runtime/system-backup")" != "$target_uid:$target_gid" ]; then
  echo "FAIL the repair did not hand runtime/system-backup to $target_uid:$target_gid"
  ls -ln "$fixture/runtime/system-backup"
  exit 1
fi
if [ "$(stat -c '%a' "$passphrase")" != "600" ] || [ "$(stat -c '%a' "$fixture/runtime/system-backup")" != "700" ]; then
  echo "FAIL the repair loosened the saved passphrase's permissions"
  stat -c '%a %n' "$passphrase" "$fixture/runtime/system-backup"
  exit 1
fi
if [ "$(cat "$passphrase")" != "saved-passphrase-value" ]; then
  echo "FAIL the repair changed the saved passphrase"
  exit 1
fi

if [ "$foreign_owner" = "1" ]; then
  echo "PASS system-backup permission repair (foreign owner repaired, modes kept)"
else
  echo "PASS system-backup permission repair (modes kept; foreign-owner case needs root)"
fi
