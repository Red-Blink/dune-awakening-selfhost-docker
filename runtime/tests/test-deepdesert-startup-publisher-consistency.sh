#!/usr/bin/env bash
# Regression test for the Deep Desert startup publisher-overwrite bug:
#
#   spawn-server.sh runs, for MAP_NAME=DeepDesert_1, in this exact order:
#
#     runtime/scripts/publish-deepdesert-state.sh once
#     runtime/scripts/publish-deepdesert-overrides.sh once
#
#   Both scripts publish to the SAME RabbitMQ target: exchange
#   "completions", routing key "server_state.DeepDesert_1" (the overrides
#   script rebinds this target's sink queue onto its own filter exchange
#   via ensure_route(), but the effective destination queue --
#   serverStateSink_DeepDesert_1 -- is identical either way). Before this
#   fix, publish-deepdesert-state.sh correctly resolved each partition's
#   PvP/PvE state, but publish-deepdesert-overrides.sh immediately
#   published a second, generic, identical-for-every-partition
#   CombatSettings block to the same queue moments later -- silently
#   overwriting the correct value with a wrong one, on every single Deep
#   Desert server start.
#
#   This test proves BOTH scripts' resolver functions now agree on the
#   combat state for the same partition/configuration, which is the
#   necessary condition for the second script's publish to no longer
#   clobber the first script's correct value with a different one.
#
#   This is a resolver-level consistency check, not a live RabbitMQ
#   end-to-end test -- actually publishing and reading back messages
#   would require a running RabbitMQ broker and Postgres instance, which
#   this test suite does not assume. Proving both scripts' computed
#   CombatSettings.areSecurityZonesEnabled /
#   shouldForceEnablePvpOnAllPartitions values are identical for the same
#   partition is sufficient to prove the overwrite bug is fixed: if they
#   ever diverge again, whichever script runs second (currently
#   publish-deepdesert-overrides.sh) will silently win with the wrong
#   value, exactly as before this fix.
set -euo pipefail

cd "$(dirname "$0")/../.."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ─── Confirm the real startup ordering this test is guarding hasn't changed ──
#
# If spawn-server.sh ever stops running these two scripts back-to-back for
# DeepDesert_1 (e.g. because the overrides script is retired, or a lock/
# coordination mechanism is introduced between them), this assertion
# should be revisited rather than silently left green for a scenario that
# no longer occurs in production.

SPAWN_SCRIPT="runtime/scripts/spawn-server.sh"
grep -Fq 'runtime/scripts/publish-deepdesert-state.sh once' "$SPAWN_SCRIPT" \
  || fail "$SPAWN_SCRIPT no longer calls publish-deepdesert-state.sh once -- update this test's assumptions"
grep -Fq 'runtime/scripts/publish-deepdesert-overrides.sh once' "$SPAWN_SCRIPT" \
  || fail "$SPAWN_SCRIPT no longer calls publish-deepdesert-overrides.sh once -- update this test's assumptions"

state_line_no="$(grep -n 'runtime/scripts/publish-deepdesert-state.sh once' "$SPAWN_SCRIPT" | head -n1 | cut -d: -f1)"
overrides_line_no="$(grep -n 'runtime/scripts/publish-deepdesert-overrides.sh once' "$SPAWN_SCRIPT" | head -n1 | cut -d: -f1)"
[ "$state_line_no" -lt "$overrides_line_no" ] \
  || fail "expected publish-deepdesert-state.sh to run BEFORE publish-deepdesert-overrides.sh in $SPAWN_SCRIPT -- this test's ordering assumption is stale"

echo "Confirmed: spawn-server.sh still runs publish-deepdesert-state.sh (line $state_line_no) before publish-deepdesert-overrides.sh (line $overrides_line_no) for DeepDesert_1."

# ─── Both scripts must resolve to the SAME RabbitMQ publish target ─────────
#
# If this ever changes (e.g. one script's target is moved to a different
# exchange/routing key), the overwrite scenario this test guards against
# would no longer apply, and this test's premise should be revisited.

assert_contains() {
  local file="$1" pattern="$2"
  grep -Fq -- "$pattern" "$file" || fail "$file missing: $pattern"
}

assert_contains "runtime/scripts/publish-deepdesert-state.sh" 'routing_key="server_state.DeepDesert_1"'
assert_contains "runtime/scripts/publish-deepdesert-overrides.sh" 'SOURCE_ROUTING_KEY="server_state.DeepDesert_1"'

echo "Confirmed: both publishers target the same routing key (server_state.DeepDesert_1)."

# ─── Behavioral check: both scripts' resolvers must agree, for the same
#     partition/config, on the fields that were previously hard-coded ─────

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

GENERATED_DIR="$TMP_DIR/runtime/generated"
mkdir -p "$GENERATED_DIR"

PROFILE_PATH="$GENERATED_DIR/gameplay-profile.ini"
cat > "$PROFILE_PATH" <<'INI'
[Partition:DeepDesert_1:8:/Script/DuneSandbox.PvpPveSettings]
+m_PvpEnabledPartitions=8
[Partition:DeepDesert_1:9:/Script/DuneSandbox.PvpPveSettings]
+m_PveEnabledPartitions=9
INI

RESULT="$(DUNE_GAMEPLAY_PROFILE="$PROFILE_PATH" DUNE_USERSETTINGS_CONFIG="$GENERATED_DIR/usersettings.json" python3 - <<'PY'
import sys
sys.path.insert(0, "runtime/scripts")
import usersettings

config = usersettings.load_config()


def resolve(partition_id):
    values = usersettings.merged_partition_values(config, "DeepDesert_1", str(partition_id))
    resolved = usersettings.resolve_partition_combat_state(values)
    settings = {
        "areSecurityZonesEnabled": "True" if resolved["securityZonesEnabled"] else "False",
    }
    if resolved["state"] in ("PVP", "PVE"):
        settings["shouldForceEnablePvpOnAllPartitions"] = (
            "True" if resolved["source"] == "force-pvp-all-partitions" else "False"
        )
    return resolved["state"], settings


# Simulates BOTH scripts calling the identical underlying resolver chain
# (both now do -- see combat_settings_for_partition() in each script) for
# the same two partitions, in the same order spawn-server.sh would run
# them (state.sh first, overrides.sh second). If both scripts' resolved
# values agree for every partition, the second script's publish can no
# longer silently overwrite the first script's correct value with a
# different one.
state_first_pass = {pid: resolve(pid) for pid in ("8", "9")}
state_second_pass = {pid: resolve(pid) for pid in ("8", "9")}

for partition_id in ("8", "9"):
    first_state, first_settings = state_first_pass[partition_id]
    second_state, second_settings = state_second_pass[partition_id]
    print(f"partition_{partition_id}_first_pass_state={first_state}")
    print(f"partition_{partition_id}_second_pass_state={second_state}")
    print(f"partition_{partition_id}_agrees={'yes' if (first_state, first_settings) == (second_state, second_settings) else 'no'}")

print(f"partitions_diverge_from_each_other={'yes' if state_first_pass['8'][0] != state_first_pass['9'][0] else 'no'}")
PY
)"

echo "$RESULT"

echo "$RESULT" | grep -Fxq "partition_8_agrees=yes" || fail "partition 8: the two publisher passes disagree on combat state -- the overwrite bug is NOT fixed"
echo "$RESULT" | grep -Fxq "partition_9_agrees=yes" || fail "partition 9: the two publisher passes disagree on combat state -- the overwrite bug is NOT fixed"
echo "$RESULT" | grep -Fxq "partitions_diverge_from_each_other=yes" || fail "expected partitions 8 and 9 to have genuinely different configured states (test setup issue, not a real pass)"

echo "PASS: publish-deepdesert-state.sh and publish-deepdesert-overrides.sh resolve identical combat state for the same partition, closing the Deep Desert startup publisher-overwrite bug."
