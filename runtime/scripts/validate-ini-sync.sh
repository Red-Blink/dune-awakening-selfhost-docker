#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

USERSETTINGS="runtime/scripts/usersettings.py"
ROOT_DIR="runtime/generated/ini-sync-validation"
BASE_DIR="$ROOT_DIR/survival-1/Saved/UserSettings"
ENGINE="$BASE_DIR/UserEngine.ini"
GAME="$BASE_DIR/UserGame.ini"
CONFIG="$ROOT_DIR/usersettings.json"

rm -rf "$ROOT_DIR"
mkdir -p "$BASE_DIR"

DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" python3 "$USERSETTINGS" materialize Survival_1 "$ROOT_DIR/survival-1/Saved" 1

cat >> "$GAME" <<'EOF'

[Custom.Section]
CustomKey=KeepMe
; custom comment
EOF

DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" python3 "$USERSETTINGS" partition-set Survival_1 1 global_xp_multiplier 3.5 >/dev/null
if ! DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" python3 "$USERSETTINGS" partition-values Survival_1 1 | grep -q $'global_xp_multiplier\t3.5'; then
  echo "UserGame live value was not reflected." >&2
  exit 1
fi
DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" python3 "$USERSETTINGS" partition-set Survival_1 1 global_fame_multiplier 2.0 >/dev/null
grep -q 'CustomKey=KeepMe' "$GAME" || { echo "UserGame unknown key was not preserved." >&2; exit 1; }
grep -q '; custom comment' "$GAME" || { echo "UserGame comment was not preserved." >&2; exit 1; }

cat >> "$ENGINE" <<'EOF'

[Custom.Engine]
EngineCustomKey=KeepMeToo
; engine custom comment
EOF

DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" python3 "$USERSETTINGS" engine-set mining_output_multiplier 7.77 >/dev/null
if ! DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" python3 "$USERSETTINGS" engine-values | grep -q $'mining_output_multiplier\t7.77'; then
  echo "UserEngine live value was not reflected." >&2
  exit 1
fi
DUNE_USERSETTINGS_GAME_ROOT="$ROOT_DIR" DUNE_USERSETTINGS_CONFIG="$CONFIG" python3 "$USERSETTINGS" engine-set vehicle_mining_output_multiplier 8.88 >/dev/null
grep -q 'EngineCustomKey=KeepMeToo' "$ENGINE" || { echo "UserEngine unknown key was not preserved." >&2; exit 1; }
grep -q '; engine custom comment' "$ENGINE" || { echo "UserEngine comment was not preserved." >&2; exit 1; }

echo "INI sync validation passed."
