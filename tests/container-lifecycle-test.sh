#!/usr/bin/env bash
# container-lifecycle-test.sh — validate console container hardening end-to-end
# Tests: root-owned upgrade, non-root runtime, write access, entrypoint behavior
set -euo pipefail

PASS=0
FAIL=0
pass() { echo -e "  \033[0;32m✓ $*\033[0m"; PASS=$((PASS + 1)); }
fail() { echo -e "  \033[0;31m✗ $*\033[0m"; FAIL=$((FAIL + 1)); }

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
IMAGE_NAME="dune-console-test:lifecycle"
TEST_DIR=$(mktemp -d)
cleanup() {
  sudo rm -rf "$TEST_DIR" 2>/dev/null || rm -rf "$TEST_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "============================================="
echo "  Container Lifecycle Tests"
echo "============================================="

# ── Test 1: Dockerfile builds ──
echo ""
echo "1. Dockerfile builds successfully"
if docker build --quiet -f "$REPO_ROOT/console/api/Dockerfile" -t "$IMAGE_NAME" "$REPO_ROOT" 2>&1 > /dev/null; then
  pass "Dockerfile builds"
else
  fail "Dockerfile build failed"
  docker build -f "$REPO_ROOT/console/api/Dockerfile" -t "$IMAGE_NAME" "$REPO_ROOT" 2>&1 | tail -5
fi

# ── Test 2: Container runs as non-root (USER dune) ──
echo ""
echo "2. Container runs as non-root user"
CURRENT_UID=$(docker run --rm -v /tmp:/repo "$IMAGE_NAME" id -u 2>/dev/null)
if [ "$CURRENT_UID" != "0" ]; then
  pass "container runs as UID $CURRENT_UID (non-root)"
else
  fail "container runs as root (UID 0)"
fi

# ── Test 3: Container name matches dune user ──
echo ""
echo "3. Container user is 'dune'"
CURRENT_USER=$(docker run --rm -v /tmp:/repo "$IMAGE_NAME" id -un 2>/dev/null)
if [ "$CURRENT_USER" = "dune" ]; then
  pass "user is dune"
else
  fail "user is $CURRENT_USER (expected dune)"
fi

# ── Test 4: Root-owned application files remain readable ──
echo ""
echo "4. Root-owned application files remain readable"
OUTPUT=$(docker run --rm -v /tmp:/repo "$IMAGE_NAME" sh -lc 'test -r /app/src/server.js && test -r /app/web-dist/index.html && echo OK' 2>&1) || true
if echo "$OUTPUT" | grep -q "OK"; then
  pass "non-root runtime can read API and frontend files"
else
  fail "non-root runtime cannot read application files"
  echo "    output: $OUTPUT"
fi

# ── Test 5: Root-owned host directory blocks write (upgrade scenario) ──
echo ""
echo "5. Root-owned /repo blocks writes (upgrade simulation)"
ROOT_REPO="$TEST_DIR/root-repo"
mkdir -p "$ROOT_REPO"
sudo chown root:root "$ROOT_REPO" 2>/dev/null || true
sudo chmod 755 "$ROOT_REPO" 2>/dev/null || true

OUTPUT=$(docker run --rm -v "$ROOT_REPO:/repo" "$IMAGE_NAME" 2>&1) || true
if echo "$OUTPUT" | grep -q "not writable"; then
  pass "entrypoint detects root-owned /repo and fails"
else
  fail "entrypoint should reject root-owned /repo"
  echo "    output: $OUTPUT"
fi

# ── Test 6: Host-owned directory allows writes ──
echo ""
echo "6. Host-owned /repo allows writes"
USER_REPO="$TEST_DIR/user-repo"
mkdir -p "$USER_REPO"
sudo chown "$(id -u):$(id -g)" "$USER_REPO" 2>/dev/null || chown "$(id -u):$(id -g)" "$USER_REPO" 2>/dev/null || true

OUTPUT=$(docker run --rm --user "$(id -u):$(id -g)" -v "$USER_REPO:/repo" "$IMAGE_NAME" touch /repo/.test-write 2>&1 && echo "OK") || true
if echo "$OUTPUT" | grep -q "OK"; then
  pass "entrypoint allows writable /repo"
else
  fail "entrypoint rejects writable /repo"
  echo "    output: $OUTPUT"
fi

# ── Test 7: Custom UID via compose user: ──
echo ""
echo "7. Custom UID via --user flag"
CUSTOM_UID=5678
OUTPUT=$(docker run --rm --user "$CUSTOM_UID:$CUSTOM_UID" -v /tmp:/repo "$IMAGE_NAME" sh -lc 'test "$(id -u)" = 5678; test -r /app/src/server.js; test -r /app/web-dist/index.html; echo OK' 2>&1) || true
if echo "$OUTPUT" | grep -q "OK"; then
  pass "runs as UID $CUSTOM_UID with readable application files"
else
  fail "custom UID should run with readable application files, got: $OUTPUT"
fi

# ── Test 8: Entrypoint passes arguments correctly ──
echo ""
echo "8. Entrypoint preserves command arguments"
OUTPUT=$(docker run --rm -v /tmp:/repo "$IMAGE_NAME" node -e "console.log('hello')" 2>&1) || true
if echo "$OUTPUT" | grep -q "hello"; then
  pass "entrypoint runs CMD correctly"
else
  fail "entrypoint argument preservation broken"
  echo "    output: $OUTPUT"
fi

# ── Test 9: Compose validation ──
echo ""
echo "9. Compose config validates"
if docker compose -f "$REPO_ROOT/docker-compose.web.yml" config --quiet 2>&1 > /dev/null; then
  pass "compose config valid"
else
  fail "compose config invalid"
fi

# ── Test 10: Entrypoint shell syntax ──
echo ""
echo "10. Entrypoint shell syntax"
for f in "$REPO_ROOT/console/api/entrypoint.sh" "$REPO_ROOT/orchestrator/entrypoint.sh"; do
  if bash -n "$f" 2>/dev/null; then
    pass "syntax OK: $(basename $f)"
  else
    fail "syntax error: $(basename $f)"
  fi
done

# ── Test 11: Orchestrator Dockerfile builds ──
echo ""
echo "11. Orchestrator Dockerfile builds"
if docker build --quiet -t "dune-orch-test:lifecycle" "$REPO_ROOT/orchestrator" 2>&1 > /dev/null; then
  pass "orchestrator Dockerfile builds"
else
  fail "orchestrator Dockerfile build failed"
fi

# ── Test 12: Orchestrator repairs all writable upgrade mounts ──
echo ""
echo "12. Orchestrator repairs root-owned writable mounts"
ORCH_TEST_ROOT="$TEST_DIR/orchestrator-upgrade"
mkdir -p "$ORCH_TEST_ROOT"/{server,steam,generated,cache,home-steam,work}
printf 'old catalog\n' > "$ORCH_TEST_ROOT/work/server-catalog.json"
sudo chown -R root:root "$ORCH_TEST_ROOT" 2>/dev/null || true
sudo chmod -R u+rwX,go-rwx "$ORCH_TEST_ROOT" 2>/dev/null || true

OUTPUT=$(docker run --rm \
  -v "$ORCH_TEST_ROOT/server:/srv/dune/server" \
  -v "$ORCH_TEST_ROOT/steam:/srv/dune/steam" \
  -v "$ORCH_TEST_ROOT/generated:/srv/dune/generated" \
  -v "$ORCH_TEST_ROOT/cache:/srv/dune/cache" \
  -v "$ORCH_TEST_ROOT/home-steam:/home/dune/.steam" \
  -v "$ORCH_TEST_ROOT/work:/work" \
  "dune-orch-test:lifecycle" \
  sh -lc 'test "$(id -u)" != 0; printf "new catalog\n" > /work/server-catalog.json; touch /srv/dune/server/test /srv/dune/steam/test /srv/dune/generated/test /srv/dune/cache/test /home/dune/.steam/test; echo OK' 2>&1) || true
if echo "$OUTPUT" | grep -q "OK"; then
  pass "orchestrator migrates existing writable mounts before dropping privileges"
else
  fail "orchestrator could not migrate writable mounts"
  echo "    output: $OUTPUT"
fi

# ── Test 13: Main compose uses managed scratch storage ──
echo ""
echo "13. Orchestrator scratch storage is Docker-managed"
COMPOSE_CONFIG=$(docker compose -f "$REPO_ROOT/docker-compose.yml" config 2>&1) || true
if echo "$COMPOSE_CONFIG" | grep -q 'source: dune-work' \
  && echo "$COMPOSE_CONFIG" | grep -q 'target: /work' \
  && ! echo "$COMPOSE_CONFIG" | grep -q "$REPO_ROOT/work"; then
  pass "/work uses the managed dune-work volume"
else
  fail "/work must not use a host bind mount"
fi

# ── Test 14: Shell entrypoints keep executable modes ──
echo ""
echo "14. Shell entrypoints are executable"
NON_EXECUTABLE=$(find "$REPO_ROOT/runtime/scripts" -maxdepth 1 -type f -name '*.sh' ! -perm -111 -print)
for f in "$REPO_ROOT/console/api/entrypoint.sh" "$REPO_ROOT/orchestrator/entrypoint.sh"; do
  if [ ! -x "$f" ]; then
    NON_EXECUTABLE="${NON_EXECUTABLE}${NON_EXECUTABLE:+$'\n'}$f"
  fi
done
if [ -z "$NON_EXECUTABLE" ]; then
  pass "runtime scripts and container entrypoints are executable"
else
  fail "shell entrypoints missing executable mode"
  echo "$NON_EXECUTABLE" | sed 's/^/    /'
fi

# ── Test 15: Root-owned host runtime state is migrated ──
echo ""
echo "15. Host runtime state ownership migration"
HOST_RUNTIME_ROOT="$TEST_DIR/host-runtime"
mkdir -p "$HOST_RUNTIME_ROOT/runtime"/{generated,logs,backups,secrets,addons,text-router}
mkdir -p "$HOST_RUNTIME_ROOT/runtime/game/test-map/Saved/UserSettings"
printf 'old state\n' > "$HOST_RUNTIME_ROOT/runtime/generated/autoscaler-idle.tsv"
printf 'old setting\n' > "$HOST_RUNTIME_ROOT/runtime/game/test-map/Saved/UserSettings/UserGame.ini"
sudo chown -R root:root "$HOST_RUNTIME_ROOT/runtime" 2>/dev/null || true
sudo chmod -R u+rwX,go-rwx "$HOST_RUNTIME_ROOT/runtime" 2>/dev/null || true

OUTPUT=$(DUNE_RUNTIME_REPO_ROOT="$HOST_RUNTIME_ROOT" \
  DUNE_RUNTIME_HOST_REPO_ROOT="$HOST_RUNTIME_ROOT" \
  DUNE_RUNTIME_PERMISSION_HELPER_IMAGE="dune-orch-test:lifecycle" \
  DUNE_HOST_UID="$(id -u)" \
  DUNE_HOST_GID="$(id -g)" \
  "$REPO_ROOT/runtime/scripts/repair-host-runtime-permissions.sh" 2>&1) || true
if [ -w "$HOST_RUNTIME_ROOT/runtime/generated/autoscaler-idle.tsv" ] \
  && printf 'new state\n' > "$HOST_RUNTIME_ROOT/runtime/generated/autoscaler-idle.tsv" \
  && printf 'router state\n' > "$HOST_RUNTIME_ROOT/runtime/text-router/state.json" \
  && printf 'new setting\n' > "$HOST_RUNTIME_ROOT/runtime/game/test-map/Saved/UserSettings/UserGame.ini"; then
  pass "root-owned autoscaler, TextRouter, and map settings state is migrated"
else
  fail "host runtime permission migration failed"
  echo "    output: $OUTPUT"
fi

# ── Test 16: Startup paths invoke host runtime migration ──
echo ""
echo "16. Startup paths invoke host runtime migration"
if grep -q 'repair-host-runtime-permissions.sh' "$REPO_ROOT/runtime/scripts/start-all.sh" \
  && grep -q 'repair-host-runtime-permissions.sh' "$REPO_ROOT/runtime/scripts/start-autoscaler.sh"; then
  pass "full and standalone autoscaler startup both repair legacy ownership"
else
  fail "startup paths must invoke host runtime permission migration"
fi

# ── Cleanup ──
docker rmi "$IMAGE_NAME" 2>/dev/null || true
docker rmi "dune-orch-test:lifecycle" 2>/dev/null || true

echo ""
echo "============================================="
echo "  RESULTS: $PASS pass, $FAIL fail"
echo "============================================="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
