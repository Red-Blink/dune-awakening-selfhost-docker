#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || { echo "SKIP: git not available"; exit 0; }
command -v flock >/dev/null 2>&1 || { echo "SKIP: flock not available"; exit 0; }

test_root="$(mktemp -d)"
lock_holder_pid=""
cleanup() {
  if [ -n "$lock_holder_pid" ]; then
    kill "$lock_holder_pid" >/dev/null 2>&1 || true
    wait "$lock_holder_pid" 2>/dev/null || true
  fi
  rm -rf "$test_root"
}
trap cleanup EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

# Finding 4 (MEDIUM, Layer 3 test-coverage audit): both `self-update.sh
# apply-discord-adapter-env` and `install|apply` call the same
# acquire_self_update_lock() (a non-blocking `flock -n 9` on
# runtime/generated/self-update.lock, exits 75 with "Another console update
# is already running." on contention). The lock check happens BEFORE any
# docker invocation (see the cmd dispatch for apply-discord-adapter-env in
# self-update.sh: acquire_self_update_lock runs first, docker access/recreate
# only after), so this fake `docker` must never be invoked at all if the lock
# gate is working -- same "the fake for the thing that must never run just
# fails loudly" technique test-discord-adapter-recreate-failure.sh already
# uses for `curl`.
cat > "$fake_bin/docker" <<'SH'
#!/bin/sh
echo "docker should not have been invoked -- the self-update lock must be checked first" >&2
exit 1
SH
chmod +x "$fake_bin/docker"

# Exercise a real, isolated checkout of the current tree (same technique the
# sibling Discord-adapter tests already use) rather than the real working
# directory, since self-update.sh resolves its own repo root from its own
# script path and writes real files (runtime/generated/...) relative to it.
fresh_root="$test_root/fresh"
mkdir -p "$fresh_root"
git archive --format=tar HEAD | tar -x -C "$fresh_root"

lock_file="$fresh_root/runtime/generated/self-update.lock"
mkdir -p "$(dirname "$lock_file")"

# Pre-acquire the lock in a backgrounded subshell and hold it open for the
# duration of this test, simulating a concurrent self-update (or a
# concurrent apply-discord-adapter-env) already in flight.
acquired_marker="$test_root/lock-acquired"
(
  exec 9>"$lock_file"
  flock -n 9 || exit 1
  touch "$acquired_marker"
  sleep 60
) &
lock_holder_pid=$!

# Poll for the marker instead of a fixed sleep -- avoids a flaky race
# against however long the background subshell takes to actually flock().
deadline=$((SECONDS + 10))
while [ ! -f "$acquired_marker" ]; do
  if ! kill -0 "$lock_holder_pid" >/dev/null 2>&1; then
    fail "background lock holder exited before acquiring the lock"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    fail "background lock holder never acquired the self-update lock"
  fi
  sleep 0.1
done

run_id="44444444-4444-4444-8444-444444444444"
rc=0
env PATH="$fake_bin:$PATH" \
  DUNE_COMPOSE_PROJECT_NAME=test-discord-adapter-lock-contention \
  DUNE_SELF_UPDATE_RUN_ID="$run_id" \
  "$fresh_root/runtime/scripts/self-update.sh" apply-discord-adapter-env redblink-dune-docker-console \
  >"$test_root/out.log" 2>"$test_root/err.log" || rc=$?

[ "$rc" -eq 75 ] \
  || fail "apply-discord-adapter-env exited $rc while the self-update lock was held elsewhere -- expected exit 75 (got stderr: $(cat "$test_root/err.log"))"

grep -qF 'Another console update is already running.' "$test_root/err.log" \
  || fail "stderr did not contain the expected lock-contention message (got: $(cat "$test_root/err.log"))"

status_file="$fresh_root/runtime/generated/self-update-status/$run_id.env"
[ -f "$status_file" ] || fail "no status file was written for the lock-contention failure"

grep -qx 'state=failed' "$status_file" \
  || fail "status file did not report state=failed on lock contention -- a real, currently-live update must never be masked by a false success (got: $(grep '^state=' "$status_file" || echo 'MISSING'))"

grep -qx 'stage=busy' "$status_file" \
  || fail "status file did not report stage=busy on lock contention (got: $(grep '^stage=' "$status_file" || echo 'MISSING'))"

grep -q '^message=.*already running' "$status_file" \
  || fail "status file's message does not describe the lock contention (got: $(grep '^message=' "$status_file" || echo 'MISSING'))"

echo "OK: apply-discord-adapter-env fails closed (exit 75, state=failed, no false success) when another self-update already holds the lock, without ever invoking docker"
