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

compose_up_log="$test_root/compose-up.log"
: > "$compose_up_log"
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
  "compose ps")
    # Only what MOCK_RUNNING_SERVICES names, so a case can start from a host
    # where the orchestrator has never been started.
    [ -z "${MOCK_RUNNING_SERVICES:-}" ] || printf '%s
' ${MOCK_RUNNING_SERVICES}
    ;;
  "compose up")
    printf '%s
' "$*" >> "${MOCK_COMPOSE_UP_LOG:-/dev/null}"
    ;;
  "compose exec")
    # preflight, the SteamCMD download, the image-tarball load loop and the
    # installed-size measurement all arrive here. Succeeding is what lets the
    # asset phase run to completion.
    case "$*" in
      *"du -sh"*) [ -n "${MOCK_ASSET_SIZE-unset}" ] && printf '%s\n' "${MOCK_ASSET_SIZE-4.9G}" ;;
    esac
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
  : > "$compose_up_log"
  (
    cd "$project"
    PATH="$bin_dir:$PATH" MOCK_DOCKER_LOG="$docker_log" \
      MOCK_COMPOSE_UP_LOG="$compose_up_log" \
      MOCK_RUNNING_SERVICES="${MOCK_RUNNING_SERVICES:-}" \
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

# --- Case 3b: an autoscaled shard counts as a running world ---------------
# The autoscaler spawns dune-server-<map>-<partition>, not just the two fixed
# names. A guard that matches only overmap and survival-N leaves the common
# case -- a busy world with shards up -- completely unprotected.

status=0
MOCK_RUNNING_CONTAINERS="dune-server-sh-arrakeen-23" run_update shard install-assets || status=$?
[ "$status" -eq 3 ] || fail "install-assets: expected exit 3 with an autoscaled shard running, got $status" "$test_root/shard.log"
if grep -q "compose exec" "$docker_log"; then
  fail "install-assets: loaded images while an autoscaled shard was running" "$docker_log"
fi
echo "PASS install-assets-refuses-while-an-autoscaled-shard-runs"

# --- Case 3c: the gateway alone is not a world server ---------------------
# It runs whenever the stack is up, so refusing on it would block
# install-assets on a host with no world running at all.

MOCK_RUNNING_CONTAINERS="dune-server-gateway" run_update gateway install-assets \
  || fail "install-assets: refused with only the gateway running" "$test_root/gateway.log"
echo "PASS install-assets-allows-a-lone-gateway"

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


# --- Case 6: the orchestrator is started when it is not already running ----
# Nothing but init.sh starts that container, and init.sh never runs on a host
# that has not deployed -- the one a system restore is for.

MOCK_RUNNING_SERVICES="" run_update fresh install-assets || fail "install-assets on a host with no orchestrator: expected exit 0" "$test_root/fresh.log"
grep -q orchestrator "$compose_up_log" \
  || fail "install-assets did not start the orchestrator on a host where it was not running" "$compose_up_log" "$test_root/fresh.log"
echo "PASS install-assets-starts-the-orchestrator"

# --- Case 7: an already-running orchestrator is left alone -----------------

MOCK_RUNNING_SERVICES="orchestrator" run_update running-orch install-assets || fail "install-assets with the orchestrator up: expected exit 0" "$test_root/running-orch.log"
if grep -q orchestrator "$compose_up_log"; then
  fail "install-assets recreated an orchestrator that was already running" "$compose_up_log"
fi
echo "PASS install-assets-leaves-a-running-orchestrator-alone"

# --- Case 8: it reports how much was installed -----------------------------
# The console shows this against the install step.

run_update sized install-assets || fail "install-assets: expected exit 0" "$test_root/sized.log"
grep -q "^DUNE_GAME_ASSETS_SIZE=4.9G$" "$test_root/sized.log" \
  || fail "install-assets: did not report the installed size" "$test_root/sized.log"
echo "PASS install-assets-reports-the-installed-size"

# --- Case 9: an unmeasurable install reports no size at all ----------------
# A marker with an empty value would render as a size of nothing beside a step
# that did install something.

MOCK_ASSET_SIZE="" run_update unsized install-assets || fail "install-assets: expected exit 0 with no size available" "$test_root/unsized.log"
if grep -q "DUNE_GAME_ASSETS_SIZE" "$test_root/unsized.log"; then
  fail "install-assets: emitted a size marker with nothing to report" "$test_root/unsized.log"
fi
grep -q "No database work was performed" "$test_root/unsized.log" \
  || fail "install-assets: did not finish when the size could not be measured" "$test_root/unsized.log"
echo "PASS install-assets-omits-an-unmeasurable-size"

# --- Case 10: the image-load loop counts what it is loading ----------------
# Run for real, not asserted as a string: the loop is a single-quoted script, so
# `bash -n update.sh` never parses it and the docker mock stubs the exec away.
# A syntax error or a miscount in there would otherwise ship unseen.

load_script="$test_root/load-loop.sh"
awk '/^docker compose exec -T orchestrator bash -lc .$/{flag=1;next} flag&&/^.$/{exit} flag' \
  "$repo_root/runtime/scripts/update.sh" > "$load_script"
grep -q "DUNE_GAME_ASSETS_LOAD" "$load_script" \
  || fail "could not extract the image-load loop from update.sh" "$load_script"

images_fixture="$test_root/images"
mkdir -p "$images_fixture/battlegroup"
for name in alpha.tar bravo.tar.gz charlie.tgz; do
  : > "$images_fixture/battlegroup/$name"
done

load_out="$test_root/load.out"
DUNE_ASSET_IMAGES_DIR="$images_fixture" MOCK_DOCKER_LOG="$test_root/load-docker.log" PATH="$bin_dir:$PATH" bash "$load_script" > "$load_out" 2>&1 \
  || fail "the image-load loop failed to run" "$load_out"

for expected in "DUNE_GAME_ASSETS_LOAD=1/3 alpha.tar" "DUNE_GAME_ASSETS_LOAD=2/3 bravo.tar.gz" "DUNE_GAME_ASSETS_LOAD=3/3 charlie.tgz"; do
  grep -qF "$expected" "$load_out" || fail "image-load loop did not report '$expected'" "$load_out"
done
echo "PASS install-assets-counts-the-images-it-loads"

# --- Case 11: an empty image directory loads nothing and still succeeds ----
# `mapfile` on no matches leaves an empty array, and `for x in "${a[@]}"` under
# `set -u` is the classic place that turns into an unbound-variable crash.

empty_out="$test_root/load-empty.out"
DUNE_ASSET_IMAGES_DIR="$test_root/no-images" MOCK_DOCKER_LOG="$test_root/load-docker.log" PATH="$bin_dir:$PATH" bash "$load_script" > "$empty_out" 2>&1 \
  || fail "the image-load loop failed on an empty directory" "$empty_out"
if grep -q "DUNE_GAME_ASSETS_LOAD" "$empty_out"; then
  fail "image-load loop reported loading an image when there were none" "$empty_out"
fi
echo "PASS install-assets-load-loop-handles-no-images"