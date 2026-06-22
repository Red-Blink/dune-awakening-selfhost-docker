#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"

  grep -Fq -- "$pattern" "$file" || fail "$file missing: $pattern"
}

assert_not_contains_anywhere() {
  local pattern="$1"
  local output
  shift
  output="$(mktemp)"

  if grep -RIn -- "$pattern" "$@" >"$output"; then
    cat "$output" >&2
    rm -f "$output"
    fail "unexpected source match: $pattern"
  fi
  rm -f "$output"
}

assert_not_contains_anywhere 'Nu6VmPWUMvdPMeB7qErr' console/api/src runtime/scripts .env.example
assert_not_contains_anywhere 'BUILTIN_COMMAND_AUTH_TOKEN' console/api/src runtime/scripts
assert_contains runtime/scripts/admin-tools.sh 'generate_command_auth_token'
assert_contains runtime/scripts/admin-tools.sh 'openssl rand -hex 32'
assert_contains console/api/src/rmq.js 'randomBytes(COMMAND_AUTH_TOKEN_BYTES).toString("base64url")'
assert_contains .env.example 'creates runtime/secrets/command-auth-token.txt'

echo "PASS: command auth token is generated instead of built in"
