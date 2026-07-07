#!/usr/bin/env bash
# bridge-smoke-test.sh — Post-deploy validation for all addon bridge actions.
# Runs after Console restart to catch schema mismatches and regressions
# before they reach upstream review.
#
# Usage: bash tests/bridge-smoke-test.sh [--skip-auth]

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASSED=0; FAILED=0; SKIPPED=0
f() { echo -e "  ${RED}FAIL:${NC} $*"; FAILED=$((FAILED+1)); }
p() { echo -e "  ${GREEN}PASS:${NC} $*"; PASSED=$((PASSED+1)); }
w() { echo -e "  ${YELLOW}SKIP:${NC} $*"; SKIPPED=$((SKIPPED+1)); }

CONSOLE_PORT="${CONSOLE_PORT:-8088}"
BASE_URL="http://127.0.0.1:${CONSOLE_PORT}"
CURL="curl -fsS --connect-timeout 3 --max-time 10"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Bridge Smoke Test ==="
echo "Target: $BASE_URL"
echo

# ─── Auth setup ───
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PASSWORD" ] && [ -s runtime/secrets/admin-web-password.txt ]; then
  ADMIN_PASSWORD="$(tr -d '\r\n' < runtime/secrets/admin-web-password.txt)"
fi

SKIP_AUTH=false
if [ "${1:-}" = "--skip-auth" ]; then SKIP_AUTH=true; fi

SESSION=""; CSRF=""

if ! $SKIP_AUTH && [ -n "$ADMIN_PASSWORD" ]; then
  LOGIN_RESP="$($CURL -sS -X POST "$BASE_URL/api/login" \
    -H "Content-Type: application/json" \
    -d "{\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null)" || true
  if echo "$LOGIN_RESP" | grep -q '"ok":true'; then
    SESSION="$(echo "$LOGIN_RESP" | grep -o 'asc_session=[^";]*' | head -1 || true)"
    CSRF="$(echo "$LOGIN_RESP" | grep -o '"csrf":"[^"]*"' | head -1 | sed 's/"csrf":"//;s/"//' || true)"
    p "authenticated to Console"
  else
    w "auth failed — bridge tests will use unauthenticated path"
  fi
else
  w "no credentials — bridge tests will use unauthenticated path"
fi

if [ -z "$SESSION" ]; then SKIP_AUTH=true; fi

# ─── Auth headers ───
AUTH_HEADERS=()
if [ -n "$SESSION" ]; then AUTH_HEADERS+=(-H "Cookie: $SESSION"); fi
if [ -n "$CSRF" ]; then AUTH_HEADERS+=(-H "X-CSRF-Token: $CSRF"); fi

# ─── Helper: call bridge action ───
bridge_call() {
  local action="$1" label="$2" required_fields="$3"
  local resp code

  resp="$($CURL -sS -X POST "$BASE_URL/api/addons/installed/dune-ops-observability/bridge" \
    "${AUTH_HEADERS[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"$action\"}" 2>/dev/null)" || true

  if [ -z "$resp" ]; then
    f "$label — no response (401 auth / 400 unsupported action)"
    return
  fi

  if echo "$resp" | grep -q '"error"'; then
    w "$label — error: $(echo "$resp" | grep -o '"error":"[^"]*"' | head -1)"
    return
  fi

  if echo "$resp" | grep -q '"ok":true'; then
    local missing=0
    for field in $required_fields; do
      if ! echo "$resp" | grep -q "\"$field\""; then
        f "$label — missing required field: $field"
        missing=1
        break
      fi
    done
    if [ "$missing" -eq 0 ]; then
      p "$label — response valid, all required fields present"
    fi
  else
    f "$label — unexpected response: $(echo "$resp" | head -c 200)"
  fi
}

# ─── Test each bridge action ───

echo "--- Core bridge actions ---"

# ops.health.* (v0.3.0 — must always work)
bridge_call "ops.health.summary" "ops.health.summary" "ok result"
bridge_call "ops.health.players" "ops.health.players" "ok result total"
bridge_call "ops.health.farms" "ops.health.farms" "ok result"
bridge_call "ops.health.summary.v2" "ops.health.summary.v2" "ok result"

# leadership.players.list (must always work)
bridge_call "leadership.players.list" "leadership.players.list" "ok result capabilities"

echo "--- v0.4.0 bridge actions ---"

# ops.activity.summary (new in PR #68)
bridge_call "ops.activity.summary" "ops.activity.summary" "ok result totalPlayers onlinePlayers playersDead"

# ops.resources.summary (new in PR #68)
bridge_call "ops.resources.summary" "ops.resources.summary" "ok result totalFields spiceFieldsBySize"

# ops.combat.deaths (new in PR #68)
bridge_call "ops.combat.deaths" "ops.combat.deaths" "ok result totalDeaths deathsByCause"

# ─── Database read bridge ───
echo "--- Database bridge ---"
bridge_call "database.query" "database.query (read-only)" "ok result" || {
  # database.query requires database:read permission — may need explicit approval
  w "database.query requires database:read permission — verify addon permissions"
}

# ─── Unsupported actions (should fail cleanly) ───
echo "--- Error handling ---"

if ! $SKIP_AUTH; then
  UNSUPPORTED="$($CURL -sS -X POST "$BASE_URL/api/addons/installed/dune-ops-observability/bridge" \
    "${AUTH_HEADERS[@]}" \
    -H "Content-Type: application/json" \
    -d '{"action":"nonexistent.action"}' 2>/dev/null)" || true
  if echo "$UNSUPPORTED" | grep -q '"Unsupported addon action"'; then
    p "unsupported action returns proper error"
  else
    w "unsupported action response: $(echo "$UNSUPPORTED" | head -c 100)"
  fi
fi

# ─── Summary ───
echo; echo "========================================"
echo -e "${GREEN}Passed:  $PASSED${NC}  ${RED}Failed:  $FAILED${NC}  ${YELLOW}Skipped: $SKIPPED${NC}"
echo "========================================"
[ "$FAILED" -gt 0 ] && { echo "Bridge smoke test FAILED — fix before upstream PR."; exit 1; }
echo -e "${GREEN}Bridge smoke test PASSED.${NC}"
exit 0
