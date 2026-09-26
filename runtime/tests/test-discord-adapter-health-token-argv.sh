#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || { echo "SKIP: git not available"; exit 0; }

test_root="$(mktemp -d)"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

secret_token="s3cr3t-discord-adapter-bearer-token-do-not-leak"

cat > "$fake_bin/docker" <<'SH'
#!/bin/sh
case "$1" in
  ps) exit 0 ;;
  rm) exit 0 ;;
  compose) exit 0 ;;
  *) exit 1 ;;
esac
SH
chmod +x "$fake_bin/docker"

# Fake `curl`: records its full argv (one argument per line) to
# CURL_ARGV_CAPTURE_FILE, and -- when invoked with -K/--config -- also
# copies whatever config file it was pointed at, so the test can inspect
# what the *file* contained separately from what reached argv (which is
# what `ps aux`/`/proc/<pid>/cmdline` can actually see).
cat > "$fake_bin/curl" <<'SH'
#!/bin/sh
: > "$CURL_ARGV_CAPTURE_FILE"
prev=""
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$CURL_ARGV_CAPTURE_FILE"
  if [ "$prev" = "-K" ] || [ "$prev" = "--config" ]; then
    cp "$arg" "$CURL_CONFIG_CAPTURE_FILE" 2>/dev/null || true
  fi
  prev="$arg"
done
exit 0
SH
chmod +x "$fake_bin/curl"

fresh_root="$test_root/fresh"
mkdir -p "$fresh_root"
git archive --format=tar HEAD | tar -x -C "$fresh_root"

# Provide the token via the direct-env-var fallback (resolve_discord_adapter_
# token checks the token file first, then this) -- simplest way to get a
# known, distinctive token value into the health check without needing a
# real token file on disk.
mkdir -p "$fresh_root/runtime/generated"
{
  echo "DUNE_DISCORD_ADAPTER_TOKEN=${secret_token}"
} >> "$fresh_root/.env" 2>/dev/null || {
  cp .env "$fresh_root/.env" 2>/dev/null || true
  echo "DUNE_DISCORD_ADAPTER_TOKEN=${secret_token}" >> "$fresh_root/.env"
}

run_id="88888888-8888-4888-8888-888888888888"
curl_argv_capture="$test_root/curl-argv.txt"
curl_config_capture="$test_root/curl-config.txt"

env PATH="$fake_bin:$PATH" \
  DUNE_COMPOSE_PROJECT_NAME=test-discord-adapter-token-argv \
  DUNE_SELF_UPDATE_RUN_ID="$run_id" \
  CURL_ARGV_CAPTURE_FILE="$curl_argv_capture" \
  CURL_CONFIG_CAPTURE_FILE="$curl_config_capture" \
  "$fresh_root/runtime/scripts/self-update.sh" apply-discord-adapter-env redblink-dune-docker-console \
  >"$test_root/out.log" 2>"$test_root/err.log" \
  || { cat "$test_root/err.log" >&2; fail "apply-discord-adapter-env failed unexpectedly"; }

[ -f "$curl_argv_capture" ] || fail "fake curl was never invoked -- health check did not run"

if grep -qF "$secret_token" "$curl_argv_capture"; then
  fail "the Discord adapter bearer token appeared directly in curl's argv -- this is visible via ps aux/proc/<pid>/cmdline for the duration of the request (audit finding #3, Requirement 24 violation). argv was:
$(cat "$curl_argv_capture")"
fi

grep -qx -- '-H' "$curl_argv_capture" && grep -q "Authorization: Bearer" "$curl_argv_capture" \
  && fail "curl was still invoked with -H \"Authorization: Bearer ...\" directly in argv"

[ -f "$curl_config_capture" ] || fail "curl was not invoked with -K/--config -- expected the token to be passed via a curl config file instead of argv"
grep -qF "$secret_token" "$curl_config_capture" \
  || fail "the curl config file did not contain the token -- the health check would no longer actually authenticate"

echo "OK: the Discord adapter bearer token never appears in curl's argv, only in a short-lived config file"
