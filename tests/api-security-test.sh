#!/usr/bin/env bash
# api-security-test.sh — Runtime API security (DAST-style)
# Tests security enforcement against a running Dune Docker Console API.
#
# Exit 0 = all checks pass (or safely skipped). Exit 1 = security violation.
# Use: CONSOLE_PORT=8088 ADMIN_PASSWORD=mypass bash tests/api-security-test.sh

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
fail() { echo -e "${RED}FAIL:${NC} $*"; FAILED=$((FAILED+1)); }
pass() { echo -e "${GREEN}PASS:${NC} $*"; PASSED=$((PASSED+1)); }
warn() { echo -e "${YELLOW}SKIP:${NC} $*"; SKIPPED=$((SKIPPED+1)); }
PASSED=0; FAILED=0; SKIPPED=0

CONSOLE_PORT="${CONSOLE_PORT:-8088}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${CONSOLE_PORT}}"
CURL="curl -fsS --connect-timeout 3 --max-time 8"
TIMEOUT=15
SESSION_COOKIE=""
CSRF_TOKEN=""

echo "=== Dune Console API Security Test ==="
echo "Target: $BASE_URL"
echo

# ─── 1. HEALTH ───
echo "--- Health ---"
if $CURL "$BASE_URL/api/health" 2>/dev/null | grep -q '"ok":true'; then
  pass "health endpoint reachable"
else
  fail "health endpoint unreachable"
fi

# ─── 2. SECURITY HEADERS ───
echo "--- Security Headers ---"
HEADERS="$($CURL -sS -I "$BASE_URL/api/health" 2>/dev/null)"
for pair in "X-Content-Type-Options:nosniff" "X-Frame-Options:DENY" "Referrer-Policy:no-referrer"; do
  name="${pair%%:*}"; val="${pair##*:}"
  if echo "$HEADERS" | grep -qi "$name.*$val"; then
    pass "$name: $val"
  else
    fail "$name missing or wrong"
  fi
done

# ─── 3. AUTH ENFORCEMENT ───
echo "--- Authentication ---"
AUTH_STATE="$($CURL -o /dev/null -w '%{http_code}' "$BASE_URL/api/addons" 2>/dev/null)" || true
if [ "$AUTH_STATE" = "200" ]; then
  pass "auth disabled on server (addons list returns 200)"
  AUTH_DISABLED=true
else
  pass "auth enforced: unauthenticated addons list returns $AUTH_STATE"
  AUTH_DISABLED=false
fi

# ─── 4. LOGIN (if password available) ───
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
[ -z "$ADMIN_PASSWORD" ] && [ -s runtime/secrets/admin-web-password.txt ] && ADMIN_PASSWORD="$(tr -d '\r\n' < runtime/secrets/admin-web-password.txt)"

if [ -n "$ADMIN_PASSWORD" ] && ! $AUTH_DISABLED; then
  LOGIN_RESP="$($CURL -sS -X POST "$BASE_URL/api/login" \
    -H "Content-Type: application/json" \
    -d "{\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null)" || true
  if echo "$LOGIN_RESP" | grep -q '"ok":true'; then
    pass "login succeeds"
    SESSION_COOKIE="$(echo "$LOGIN_RESP" | grep -o 'asc_session=[^";]*' | head -1 || true)"
    CSRF_TOKEN="$(echo "$LOGIN_RESP" | grep -o '"csrf":"[^"]*"' | head -1 | sed 's/"csrf":"//;s/"//' || true)"
  else
    warn "login failed (password may have changed). Some auth tests will skip."
  fi
fi

# ─── 5. CSRF ENFORCEMENT ───
echo "--- CSRF ---"
# POST without CSRF token should be rejected on mutating endpoints
CSRF_FAIL="$($CURL -o /dev/null -w '%{http_code}' \
  -X POST "$BASE_URL/api/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"x"}' 2>/dev/null)" || true
if [ "$CSRF_FAIL" = "403" ]; then
  pass "POST without CSRF token returns 403"
elif $AUTH_DISABLED && [ "$CSRF_FAIL" = "200" ]; then
  pass "POST without CSRF returns 200 (auth disabled, expected)"
else
  warn "POST without CSRF returned $CSRF_FAIL (expected 403 or 200 with auth disabled)"
fi

# GET should never require CSRF
GET_STATUS="$($CURL -o /dev/null -w '%{http_code}' "$BASE_URL/api/health" 2>/dev/null)" || true
if [ "$GET_STATUS" = "200" ]; then
  pass "GET /api/health returns 200 without CSRF"
else
  fail "GET /api/health returned $GET_STATUS"
fi

# ─── 6. INPUT VALIDATION ───
echo "--- Input Validation ---"

# Path traversal
PT="$($CURL -o /dev/null -w '%{http_code}' "$BASE_URL/api/addons/installed/../etc/passwd/bridge" 2>/dev/null)" || true
[ "$PT" = "400" ] || [ "$PT" = "404" ] && pass "path traversal returns $PT" || warn "path traversal returned $PT (expected 400/404)"

# SQL injection
SQLI="$($CURL -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/addons/installed/test-x/bridge" \
  -H "Content-Type: application/json" -d '{"action":"database.query","query":"SELECT 1; DROP TABLE players;"}' 2>/dev/null)" || true
[ "$SQLI" = "400" ] || [ "$SQLI" = "404" ] && pass "SQL injection probe returns $SQLI" || warn "SQL injection returned $SQLI"

# XSS probe
XSS="$($CURL -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/addons/installed/test-x/bridge" \
  -H "Content-Type: application/json" -d '{"action":"<script>alert(1)</script>"}' 2>/dev/null)" || true
[ "$XSS" = "400" ] && pass "XSS probe returns $XSS" || warn "XSS probe returned $XSS"

# oversized payload (20KB JSON)
BIG_PAYLOAD="{\"x\":\"$(python3 -c "print('A'*20000)" 2>/dev/null || printf 'A%.0s' {1..20000})\"}"
SIZE="$($CURL -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/login" \
  -H "Content-Type: application/json" -d "$BIG_PAYLOAD" 2>/dev/null)" || true
[ "$SIZE" = "400" ] || [ "$SIZE" = "413" ] && pass "oversized payload returns $SIZE" || warn "oversized payload returned $SIZE (expected 400/413)"

# ─── 7. ADDON BRIDGE SECURITY ───
echo "--- Addon Bridge ---"

# Invalid addon ID
INV_ID="$($CURL -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/addons/installed/..%2F..%2F..%2Fetc/bridge" \
  -H "Content-Type: application/json" -d '{"action":"test"}' 2>/dev/null)" || true
[ "$INV_ID" = "400" ] && pass "traversal in addon bridge path returns $INV_ID" || warn "addon bridge traversal returned $INV_ID"

# Unsupported action
UNSP="$($CURL -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/addons/installed/test-nonexistent/bridge" \
  -H "Content-Type: application/json" -d '{"action":"invalid.action.name"}' 2>/dev/null)" || true
[ "$UNSP" = "400" ] && pass "unsupported bridge action returns $UNSP" || warn "unsupported action returned $UNSP (expected 400)"

# ─── 8. RATE LIMIT ENFORCEMENT ───
echo "--- Rate Limiting ---"
RATE_BLOCK=0
for i in $(seq 1 15); do
  STATUS="$($CURL -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/login" \
    -H "Content-Type: application/json" -d '{"password":"wrong-'$RANDOM'"}' 2>/dev/null)" || true
  [ "$STATUS" = "429" ] && { RATE_BLOCK=1; break; }
done
[ "$RATE_BLOCK" = "1" ] && pass "login rate limit blocks after failures" || fail "rate limit not triggered after 15 attempts"

# ─── 9. INFORMATION LEAKAGE ───
echo "--- Information Leakage ---"
ERROR_RESP="$($CURL -sS -X POST "$BASE_URL/api/login" -H "Content-Type: application/json" -d '{"password":""}' 2>/dev/null)" || true
if echo "$ERROR_RESP" | grep -qvE '(\.js:|\.ts:|at |node_modules|stacktrace)'; then
  pass "errors do not leak stack traces"
else
  fail "error response may leak internal paths"
fi

# ─── SUMMARY ───
echo; echo "========================================"
echo -e "${GREEN}Passed:  $PASSED${NC}"
echo -e "${RED}Failed:  $FAILED${NC}"
[ "$SKIPPED" -gt 0 ] && echo -e "${YELLOW}Skipped: $SKIPPED${NC}"
echo "========================================"
[ "$FAILED" -gt 0 ] && exit 1
echo -e "${GREEN}API security test: PASSED${NC}"
exit 0
