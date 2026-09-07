#!/usr/bin/env bash
set -euo pipefail

# `dune update install-assets` installs game files and images and must not touch
# the database. That is the whole reason it exists: a host about to receive a
# system restore needs the images, and must NOT have a database migrated or its
# world partitions wiped and reseeded underneath the restore.
#
# Every database action in update.sh is delegated to a sibling script, and the
# only inline SQL goes through `docker`. So stubbing the siblings and logging
# docker's argv makes "assets-only never touches the database" a mechanically
# checkable property rather than a claim in a comment.

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

project="$test_root/project"
bin_dir="$test_root/bin"
mkdir -p "$project/runtime/scripts/lib" "$project/runtime/generated" "$bin_dir"

for script in update.sh runtime-env.sh steamcmd-signals.sh fls-signals.sh \
  host-file-ownership.sh env-file.sh memory-swap-common.sh compose-project.sh; do
  [ ! -f "$repo_root/runtime/scripts/$script" ] \
    || cp "$repo_root/runtime/scripts/$script" "$project/runtime/scripts/$script"
done
cp "$repo_root/runtime/scripts/lib/secrets.sh" "$project/runtime/scripts/lib/secrets.sh"
cp "$repo_root/runtime/scripts/lib/secrets_aead.py" "$project/runtime/scripts/lib/secrets_aead.py"

printf 'SERVER_TITLE="Test Server"\nSERVER_REGION="Test Region"\n' > "$project/.env"
printf 'DUNE_WORLD_IMAGE_TAG=test\nDUNE_POSTGRES_IMAGE_TAG=test\n' \
  > "$project/runtime/generated/image-tags.env"

# Every sibling update.sh can call, stubbed to record that it ran. The database
# ones are the assertions; the asset ones prove assets-only still does its job.
calls_log="$test_root/calls.log"
: > "$calls_log"
for script in detect-image-tags.sh start-postgres.sh update-db.sh spicefield-overrides.sh \
  generate-world-partitions-sql.sh recycle-world-game-servers.sh autoscaler-control.sh \
  extract-partition-catalog.sh extract-server-catalog.sh storage.sh db.sh; do
  cat > "$project/runtime/scripts/$script" <<STUB
#!/usr/bin/env bash
printf '%s\n' "$script \$*" >> "$calls_log"
STUB
  chmod +x "$project/runtime/scripts/$script"
done

docker_log="$test_root/docker.log"
: > "$docker_log"
cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${MOCK_DOCKER_LOG:?}"
case "${1:-} ${2:-}" in
  "ps --format")
    # Only what MOCK_RUNNING_CONTAINERS names, so a case can put a live world
    # server in front of the guard.
    [ -z "${MOCK_RUNNING_CONTAINERS:-}" ] || printf '%s\n' ${MOCK_RUNNING_CONTAINERS}
    ;;
  "compose exec")
    # preflight, the SteamCMD download, and the image-tarball load loop all
    # arrive here. Succeeding is what lets the asset phase run to completion.
    exit 0
    ;;
esac
exit 0
EOF
chmod +x "$bin_dir/docker"

run_update() {
  local label="$1"
  shift
  : > "$calls_log"
  : > "$docker_log"
  local status=0
  (
    cd "$project"
    PATH="$bin_dir:$PATH" MOCK_DOCKER_LOG="$docker_log" \
      MOCK_RUNNING_CONTAINERS="${MOCK_RUNNING_CONTAINERS:-}" \
      bash runtime/scripts/update.sh "$@"
  ) > "$test_root/$label.log" 2>&1 || status=$?
  return "$status"
}

fail() {
  echo "FAIL $1"
  shift
  [ "$#" -eq 0 ] || cat "$@"
  exit 1
}

# --- Case 1: install-assets touches nothing that owns the database ---------

status=0
run_update assets install-assets || status=$?
[ "$status" -eq 0 ] || fail "install-assets: expected exit 0, got $status" "$test_root/assets.log"

for forbidden in update-db.sh start-postgres.sh spicefield-overrides.sh \
  generate-world-partitions-sql.sh recycle-world-game-servers.sh db.sh; do
  if grep -q "^$forbidden " "$calls_log"; then
    fail "install-assets: ran $forbidden, which owns or mutates the database" "$calls_log"
  fi
done

# The world-partition reset is inline SQL rather than a sibling script, so the
# script list above cannot catch it. The docker argv log can.
if grep -q "psql" "$docker_log"; then
  fail "install-assets: issued psql, so it reached the inline world-partition SQL" "$docker_log"
fi
echo "PASS install-assets-never-touches-the-database"

# --- Case 2: it still does the asset work it exists for --------------------

for expected in detect-image-tags.sh extract-partition-catalog.sh extract-server-catalog.sh; do
  grep -q "^$expected " "$calls_log" \
    || fail "install-assets: did not run $expected" "$calls_log" "$test_root/assets.log"
done
grep -q "compose exec" "$docker_log" \
  || fail "install-assets: never reached the orchestrator (no download or image load)" "$docker_log"
grep -q "No database work was performed" "$test_root/assets.log" \
  || fail "install-assets: did not report that the database was left alone" "$test_root/assets.log"
echo "PASS install-assets-still-installs-assets"

# --- Case 3: it refuses while a world server is running --------------------

status=0
MOCK_RUNNING_CONTAINERS="dune-server-survival-1" run_update running install-assets || status=$?
[ "$status" -eq 3 ] || fail "install-assets: expected exit 3 with a world server running, got $status" "$test_root/running.log"
if grep -q "compose exec" "$docker_log"; then
  fail "install-assets: downloaded or loaded images despite refusing" "$docker_log"
fi
grep -q -- "--force" "$test_root/running.log" \
  || fail "install-assets: the refusal does not mention the override" "$test_root/running.log"
echo "PASS install-assets-refuses-while-a-world-server-runs"

# --- Case 4: --force overrides that refusal --------------------------------

status=0
MOCK_RUNNING_CONTAINERS="dune-server-survival-1" run_update forced install-assets --force || status=$?
[ "$status" -eq 0 ] || fail "install-assets --force: expected exit 0, got $status" "$test_root/forced.log"
grep -q "compose exec" "$docker_log" \
  || fail "install-assets --force: did not proceed to the download" "$docker_log"
echo "PASS install-assets-force-overrides"

# --- Case 5: plain install still does the database work --------------------
# Without this, collapsing install into install-assets would be a refactor that
# passes every other case in this file.

# Exit status is deliberately not asserted: plain install goes on to apply real
# world-partition SQL and verify the row count, which stubs cannot satisfy. What
# matters here is only that it still reaches the database phase at all.
status=0
run_update install install || status=$?
for expected in update-db.sh start-postgres.sh generate-world-partitions-sql.sh; do
  grep -q "^$expected " "$calls_log" \
    || fail "install: no longer runs $expected -- the database phase was lost" "$calls_log" "$test_root/install.log"
done
echo "PASS install-still-runs-the-database-phase"
