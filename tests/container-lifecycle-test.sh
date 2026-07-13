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
trap "rm -rf $TEST_DIR" EXIT

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

# ── Test 4: Root-owned host directory blocks write (upgrade scenario) ──
echo ""
echo "4. Root-owned /repo blocks writes (upgrade simulation)"
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

# ── Test 5: Host-owned directory allows writes ──
echo ""
echo "5. Host-owned /repo allows writes"
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

# ── Test 6: Custom UID via compose user: ──
echo ""
echo "6. Custom UID via --user flag"
CUSTOM_UID=5678
OUTPUT=$(docker run --rm --user "$CUSTOM_UID:$CUSTOM_UID" "$IMAGE_NAME" id -u 2>&1) || true
if echo "$OUTPUT" | grep -q "$CUSTOM_UID"; then
  pass "runs as UID $CUSTOM_UID with --user"
else
  fail "should run as UID $CUSTOM_UID, got: $OUTPUT"
fi

# ── Test 7: Entrypoint passes arguments correctly ──
echo ""
echo "7. Entrypoint preserves command arguments"
OUTPUT=$(docker run --rm -v /tmp:/repo "$IMAGE_NAME" node -e "console.log('hello')" 2>&1) || true
if echo "$OUTPUT" | grep -q "hello"; then
  pass "entrypoint runs CMD correctly"
else
  fail "entrypoint argument preservation broken"
  echo "    output: $OUTPUT"
fi

# ── Test 8: Compose validation ──
echo ""
echo "8. Compose config validates"
if docker compose -f "$REPO_ROOT/docker-compose.web.yml" config --quiet 2>&1 > /dev/null; then
  pass "compose config valid"
else
  fail "compose config invalid"
fi

# ── Test 9: Entrypoint shell syntax ──
echo ""
echo "9. Entrypoint shell syntax"
for f in "$REPO_ROOT/console/api/entrypoint.sh" "$REPO_ROOT/orchestrator/entrypoint.sh"; do
  if bash -n "$f" 2>/dev/null; then
    pass "syntax OK: $(basename $f)"
  else
    fail "syntax error: $(basename $f)"
  fi
done

# ── Test 10: Orchestrator Dockerfile builds ──
echo ""
echo "10. Orchestrator Dockerfile builds"
if docker build --quiet -f "$REPO_ROOT/orchestrator/Dockerfile" -t "dune-orch-test:lifecycle" "$REPO_ROOT/orchestrator" 2>&1 > /dev/null; then
  pass "orchestrator Dockerfile builds"
else
  fail "orchestrator Dockerfile build failed"
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
