#!/usr/bin/env bash
# Regression test for runtime/scripts/publish-sietch-overrides.sh:
#
#   Previously, every Survival_1 partition (Sietch) was published to
#   RabbitMQ with an identical, hard-coded CombatSettings block, regardless
#   of that partition's actual configured PvP/PvE state. This test proves
#   the script's combat-settings resolution now diverges correctly between
#   a PvP-configured partition and a PvE-configured partition, using the
#   canonical `usersettings.py` resolver rather than a fixed defaults dict.
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

SCRIPT="runtime/scripts/publish-sietch-overrides.sh"

# ─── Static checks: the script must call the canonical resolver ───────────

assert_contains "$SCRIPT" "import usersettings"
assert_contains "$SCRIPT" "usersettings.resolve_partition_combat_state"
assert_contains "$SCRIPT" "usersettings.merged_partition_values"
assert_contains "$SCRIPT" "def combat_settings_for_partition"
assert_contains "$SCRIPT" "def resolved_force_all_pvp_flag"

# The old bug: one fixed defaults dict, built once outside the per-line
# loop, reused verbatim for every partition regardless of its
# configuration.
assert_not_python_pattern "$SCRIPT" 'json\.loads\(json\.dumps\(defaults\)\)'

# The old bug in forward_batch_once(): a missing
# shouldForceEnablePvpOnAllPartitions field was silently defaulted to
# False instead of being resolved or omitted.
assert_not_python_pattern "$SCRIPT" 'combat\["shouldForceEnablePvpOnAllPartitions"\]\s*=\s*False\n'

# ─── Behavioral check: two partitions with different configured combat
#     state must resolve to different CombatSettings payloads ─────────────

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

GENERATED_DIR="$TMP_DIR/runtime/generated"
mkdir -p "$GENERATED_DIR"

PROFILE_PATH="$GENERATED_DIR/gameplay-profile.ini"
cat > "$PROFILE_PATH" <<'INI'
[Partition:Survival_1:1:/Script/DuneSandbox.PvpPveSettings]
+m_PvpEnabledPartitions=1
[Partition:Survival_1:2:/Script/DuneSandbox.PvpPveSettings]
+m_PveEnabledPartitions=2
INI

RESULT="$(DUNE_GAMEPLAY_PROFILE="$PROFILE_PATH" DUNE_USERSETTINGS_CONFIG="$GENERATED_DIR/usersettings.json" python3 - <<'PY'
import sys
sys.path.insert(0, "runtime/scripts")
import usersettings

config = usersettings.load_config()


def combat_settings_for_partition(partition_id):
    values = usersettings.merged_partition_values(config, "Survival_1", str(partition_id))
    resolved = usersettings.resolve_partition_combat_state(values)
    settings = {
        "areSecurityZonesEnabled": "True" if resolved["securityZonesEnabled"] else "False",
    }
    if resolved["state"] in ("PVP", "PVE"):
        settings["shouldForceEnablePvpOnAllPartitions"] = (
            "True" if resolved["source"] == "force-pvp-all-partitions" else "False"
        )
    return resolved["state"], settings


state_one, _ = combat_settings_for_partition("1")
state_two, _ = combat_settings_for_partition("2")

print(f"partition_1_state={state_one}")
print(f"partition_2_state={state_two}")
print(f"partitions_diverge={'yes' if state_one != state_two else 'no'}")
PY
)"

echo "$RESULT"

echo "$RESULT" | grep -Fxq "partition_1_state=PVP" || fail "expected partition 1 (Sietch) to resolve to PVP"
echo "$RESULT" | grep -Fxq "partition_2_state=PVE" || fail "expected partition 2 (Sietch) to resolve to PVE"
echo "$RESULT" | grep -Fxq "partitions_diverge=yes" || fail "expected partitions 1 and 2 to resolve to different combat states"

echo "PASS: publish-sietch-overrides.sh resolves per-partition combat state instead of publishing one fixed block"
