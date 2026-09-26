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

# Fake `docker`: `ps` succeeds (access check), but `compose ... up
# -d --force-recreate` fails with a distinctive exit code -- simulating a
# real failure (bad image, resource exhaustion, etc.) that recreate_discord_
# adapter_env() must not let `set -e` silently swallow. Never invokes `curl`
# in this scenario, since verify_discord_adapter_health() must never run
# after a failed recreate.
#
# `rm` is instrumented, not just stubbed: maintainer review finding (PR
# #215) -- recreate_discord_adapter_env() used to call `docker rm -f
# "$service"` UNCONDITIONALLY before attempting the recreate, destroying the
# still-running, still-serving old console before its replacement was
# confirmed working. `--force-recreate` already performs a safe atomic swap
# (create the replacement, then stop/remove the old one only once the new
# one exists) -- the extra `rm -f` defeated that safety net. This fake `rm`
# writes a marker so the assertion below can prove that direct, pre-emptive
# `docker rm` call is gone: with the fix applied, this scenario's ONLY
# container-lifecycle command is `compose ... up`, which itself fails and
# leaves whatever was running before completely untouched.
cat > "$fake_bin/docker" <<SH
#!/bin/sh
case "\$1" in
  ps) exit 0 ;;
  rm) echo "docker rm invoked: \$*" >> "$test_root/docker-rm-invocations.log"; exit 0 ;;
  compose)
    for arg in "\$@"; do
      if [ "\$arg" = "up" ]; then
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

# The actual continuity check (maintainer review finding, PR #215): proving
# the status file says "failed" is not enough on its own -- the pre-emptive
# `docker rm -f` this fix removes would ALSO have made the status file say
# "failed" (compose would still fail after the old container was already
# gone), so that assertion alone cannot distinguish "recreate failed, old
# console still running" from "recreate failed, old console also destroyed
# first". This is the assertion that actually tells the two apart: no
# `docker rm` invocation of any kind occurred during the whole attempt, so
# whatever was running before this call is exactly as it was.
[ ! -f "$test_root/docker-rm-invocations.log" ] \
  || fail "recreate_discord_adapter_env() invoked 'docker rm' during a failed recreate -- the old, still-serving console must never be destroyed before its replacement is confirmed working (invocations: $(cat "$test_root/docker-rm-invocations.log"))"

echo "OK: a failed container recreate never pre-emptively destroys the still-running old console"
