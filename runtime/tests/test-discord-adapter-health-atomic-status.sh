#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- Structural regression check -----------------------------------------
# verify_discord_adapter_health() used to write state=succeeded via its own
# self_update_write_status call, then in a LATER, SEPARATE statement append
# discord_health_ok=<0|1> to the same file. A poller landing in the gap
# between those two writes could observe state: "succeeded" with no
# discordHealthOk field at all -- the frontend treats
# progress.discordHealthOk === false as "failed", but undefined !== false,
# so it took the plain-success branch and stopped polling before the real
# health result ever landed (audit finding #2, HIGH).
#
# The fix must make discord_health_ok part of the SAME atomic write as
# state=succeeded (self_update_write_status's tmp-file+mv), not a
# subsequent append. Assert that directly against the source: the
# self_update_write_status call for the "succeeded" state must itself
# already carry discord_health_ok, and no `>>` append targeting the status
# file may appear anywhere after it in this function.
health_fn="$(awk '/^verify_discord_adapter_health\(\) \{/,/^\}/' runtime/scripts/self-update.sh)"

[ -n "$health_fn" ] || fail "could not locate verify_discord_adapter_health() in runtime/scripts/self-update.sh"

echo "$health_fn" | grep -q 'self_update_write_status succeeded .*discord_health_ok' \
  || fail "the 'succeeded' self_update_write_status call does not carry discord_health_ok as part of the same write -- discord_health_ok must be included in the SAME atomic status write as state=succeeded, not appended afterward"

succeeded_line="$(echo "$health_fn" | grep -n 'self_update_write_status succeeded' | head -n1 | cut -d: -f1)"
after_succeeded="$(echo "$health_fn" | tail -n "+$((succeeded_line + 1))")"
echo "$after_succeeded" | grep -q '>>.*SELF_UPDATE_STATUS_DIR' \
  && fail "a separate '>>' append to the status file still exists after the state=succeeded write -- this reintroduces the race this test guards against"

echo "OK: discord_health_ok is written atomically with state=succeeded, not appended afterward"

# --- Behavioral check -- the end state is still correct -------------------
command -v git >/dev/null 2>&1 || { echo "SKIP: git not available for the behavioral check"; exit 0; }

test_root="$(mktemp -d)"
cleanup() { rm -rf "$test_root"; }
trap cleanup EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
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
cat > "$fake_bin/curl" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$fake_bin/curl"

fresh_root="$test_root/fresh"
mkdir -p "$fresh_root"
git archive --format=tar HEAD | tar -x -C "$fresh_root"

run_id="77777777-7777-4777-8777-777777777777"
env PATH="$fake_bin:$PATH" \
  DUNE_COMPOSE_PROJECT_NAME=test-discord-adapter-health-atomic \
  DUNE_SELF_UPDATE_RUN_ID="$run_id" \
  "$fresh_root/runtime/scripts/self-update.sh" apply-discord-adapter-env redblink-dune-docker-console \
  >"$test_root/out.log" 2>"$test_root/err.log" \
  || fail "apply-discord-adapter-env failed with a healthy container (see $test_root/err.log)"

status_file="$fresh_root/runtime/generated/self-update-status/$run_id.env"
[ -f "$status_file" ] || fail "expected status file was not created: $status_file"
grep -qx 'state=succeeded' "$status_file" || fail "expected state=succeeded in the final status file"
grep -qx 'discord_health_ok=1' "$status_file" || fail "expected discord_health_ok=1 in the final status file"

echo "OK: final status file has both state=succeeded and discord_health_ok=1"
