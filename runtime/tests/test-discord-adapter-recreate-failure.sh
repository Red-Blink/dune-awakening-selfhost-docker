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

# Fake `docker`: `ps`/`rm` succeed (access check, cleanup), but `compose ...
# up -d --force-recreate` fails with a distinctive exit code -- simulating a
# real failure (bad image, resource exhaustion, etc.) that recreate_discord_
# adapter_env() must not let `set -e` silently swallow. Never invokes `curl`
# in this scenario, since verify_discord_adapter_health() must never run
# after a failed recreate.
cat > "$fake_bin/docker" <<'SH'
#!/bin/sh
case "$1" in
  ps) exit 0 ;;
  rm) exit 0 ;;
  compose)
    for arg in "$@"; do
      if [ "$arg" = "up" ]; then
        exit 42
      fi
    done
    exit 0
    ;;
  *) exit 1 ;;
esac
SH
chmod +x "$fake_bin/docker"

# Fake `curl`: must never be invoked once the recreate itself has failed --
# a call here means verify_discord_adapter_health() ran anyway, which is
# exactly the ordering bug this test guards against.
cat > "$fake_bin/curl" <<'SH'
#!/bin/sh
echo "curl should not have been invoked after a failed recreate" >&2
exit 1
SH
chmod +x "$fake_bin/curl"

fresh_root="$test_root/fresh"
mkdir -p "$fresh_root"
git archive --format=tar HEAD | tar -x -C "$fresh_root"

run_id="33333333-3333-4333-8333-333333333333"
rc=0
env PATH="$fake_bin:$PATH" \
  DUNE_COMPOSE_PROJECT_NAME=test-discord-adapter-recreate-failure \
  DUNE_SELF_UPDATE_RUN_ID="$run_id" \
  "$fresh_root/runtime/scripts/self-update.sh" apply-discord-adapter-env redblink-dune-docker-console \
  >"$test_root/out.log" 2>"$test_root/err.log" || rc=$?

[ "$rc" -ne 0 ] || fail "apply-discord-adapter-env exited 0 despite the container recreate failing"

status_file="$fresh_root/runtime/generated/self-update-status/$run_id.env"
[ -f "$status_file" ] || fail "no status file was written after a failed container recreate"

grep -qx 'state=failed' "$status_file" \
  || fail "status file did not reach a terminal 'failed' state after the container recreate failed (state stuck at: $(grep '^state=' "$status_file" || echo 'MISSING'))"

grep -q '^message=.*[Cc]ontainer recreation failed' "$status_file" \
  || fail "status file's failure message does not describe the container recreation failure specifically (got: $(grep '^message=' "$status_file" || echo 'MISSING'))"

echo "OK: a failed container recreate reaches a terminal failed status instead of leaving the run stuck"
