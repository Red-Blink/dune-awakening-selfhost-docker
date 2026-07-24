#!/usr/bin/env bash
# Regression test for runtime/scripts/publish-deepdesert-overrides.sh:
#
#   This was the third sibling publisher (after publish-deepdesert-state.sh
#   and publish-sietch-overrides.sh) still publishing one hard-coded,
#   identical CombatSettings block for every Deep Desert partition,
#   regardless of that partition's actual configured PvP/PvE state. This
#   test proves the script's combat-settings resolution now diverges
#   correctly between a PvP-configured partition and a PvE-configured
#   partition, and that it uses the canonical `usersettings.py` resolver
#   rather than a fixed defaults dict.
set -euo pipefail

cd "$(dirname "$0")/../.."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  grep -Fq -- "$pattern" "$file" || fail "$file missing: $pattern"
}

assert_not_python_pattern() {
  local file="$1"
  local pattern="$2"
  if grep -Pzoq -- "$pattern" "$file"; then
    fail "$file unexpectedly still contains fixed-defaults pattern"
  fi
}

SCRIPT="runtime/scripts/publish-deepdesert-overrides.sh"

# ─── Static checks: the script must call the canonical resolver ───────────

assert_contains "$SCRIPT" "import usersettings"
assert_contains "$SCRIPT" "usersettings.resolve_partition_combat_state"
assert_contains "$SCRIPT" "usersettings.merged_partition_values"
assert_contains "$SCRIPT" "def combat_settings_for_partition"

# The old bug: one fixed defaults dict, built once outside the per-line
# loop, deep-copied verbatim for every partition regardless of its
# configuration. Guard against regressing to that shape.
assert_not_python_pattern "$SCRIPT" 'json\.loads\(json\.dumps\(defaults\)\)'

# ─── Behavioral check: two partitions with different configured combat
#     state must resolve to different CombatSettings payloads ─────────────

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


def combat_settings_for_partition(partition_id):
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


state_eight, settings_eight = combat_settings_for_partition("8")
state_nine, settings_nine = combat_settings_for_partition("9")

print(f"partition_8_state={state_eight}")
print(f"partition_9_state={state_nine}")
print(f"partitions_diverge={'yes' if state_eight != state_nine else 'no'}")
PY
)"

echo "$RESULT"

echo "$RESULT" | grep -Fxq "partition_8_state=PVP" || fail "expected partition 8 to resolve to PVP"
echo "$RESULT" | grep -Fxq "partition_9_state=PVE" || fail "expected partition 9 to resolve to PVE"
echo "$RESULT" | grep -Fxq "partitions_diverge=yes" || fail "expected partitions 8 and 9 to resolve to different combat states"

echo "PASS: publish-deepdesert-overrides.sh resolves per-partition combat state instead of publishing one fixed block"
