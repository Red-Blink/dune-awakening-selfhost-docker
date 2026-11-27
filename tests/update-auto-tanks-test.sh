#!/usr/bin/env bash
# Scheduled updates preserve the Tank policy and honor existing restore records.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

project="$test_root/project"
mkdir -p "$project/runtime/scripts/lib" "$project/runtime/generated" "$test_root/bin" "$test_root/state"
for file in update.sh runtime-env.sh host-file-ownership.sh env-file.sh memory-swap-common.sh compose-project.sh steamcmd-signals.sh fls-signals.sh; do
  cp "$repo_root/runtime/scripts/$file" "$project/runtime/scripts/$file"
done
for file in ports.sh secrets.sh secrets_aead.py; do
  cp "$repo_root/runtime/scripts/lib/$file" "$project/runtime/scripts/lib/$file"
done

log="$test_root/calls.log"
: > "$log"

# --- fakes ---------------------------------------------------------------
cat > "$test_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$test_root/bin/docker"

# Stands in for `update.sh check` / `update.sh --yes`.
cat > "$test_root/fake-update.sh" <<EOF
#!/usr/bin/env bash
case "\$1" in
  check) [ -f "$test_root/state/game-applied" ] && exit 0; echo "Remote build: 4242"; exit 100 ;;
  --yes) [ -n "\${MOCK_GAME_UPDATE_FAILS:-}" ] && { echo "SteamCMD failed" >&2; exit 1; }; echo b2 > "$test_root/state/build"; echo "GAME UPDATE APPLIED (tanks=\$(cat "$test_root/state/tanks"))" >> "$log"; touch "$test_root/state/game-applied"; exit 0 ;;
esac
EOF
chmod +x "$test_root/fake-update.sh"

cat > "$project/runtime/scripts/experimental-tanks.sh" <<EOF
#!/usr/bin/env bash
state_file="$test_root/state/tanks"
case "\$1" in
  status)
    if [ -n "\${MOCK_TANKS_STATUS_JSON:-}" ] && [ "\$(cat "\$state_file")" = off ]; then printf '%s\\n' "\$MOCK_TANKS_STATUS_JSON"; exit 0; fi
    enabled=false; [ "\$(cat "\$state_file")" = on ] && enabled=true
    applying=\${MOCK_TANKS_APPLYING:-false}
    [ -f "$test_root/state/apply-unsettled" ] && applying=true
    echo "{\"enabled\": \$enabled, \"supported\": \${MOCK_TANKS_SUPPORTED:-true}, \"build\": \"\$(cat "$test_root/state/build")\", \"applying\": \$applying, \"error\": \"\${MOCK_TANKS_ERROR:-}\"}" ;;
  apply)
    echo "tanks apply \$2" >> "$log"
    if [ "\$2" = false ] && [ -n "\${MOCK_APPLY_FALSE_FAILS:-}" ]; then echo "cannot switch" >&2; exit 1; fi
    [ "\$2" = true ] && echo on > "\$state_file" || echo off > "\$state_file"
    if [ "\$2" = true ] && [ -n "\${MOCK_APPLY_TRUE_UNSETTLED:-}" ]; then touch "$test_root/state/apply-unsettled"; fi ;;
  update-guard)
    echo "update-guard" >> "$log"
    if [ "\$(cat "\$state_file")" = on ]; then echo "Disable Experimental Tanks in Settings before updating game-server files." >&2; exit 1; fi ;;
esac
EOF
chmod +x "$project/runtime/scripts/experimental-tanks.sh"

cat > "$project/runtime/scripts/self-update.sh" <<EOF
#!/usr/bin/env bash
case "\$1" in
  check) echo "self-update check" >> "$log"; [ "\${MOCK_CONSOLE_UPDATE:-1}" = 1 ] && [ "\$(cat VERSION)" != v9.9.9 ] && exit 100; exit 0 ;;
  install) echo "console install" >> "$log"; echo "v9.9.9" > VERSION; exit "\${MOCK_CONSOLE_INSTALL_RC:-0}" ;;
esac
EOF
chmod +x "$project/runtime/scripts/self-update.sh"

state_file="$test_root/state/update-auto.env"
pending_file="$test_root/state/update-auto-pending.env"
tanks_file="$test_root/state/update-auto-tanks.env"

reset() {
  # $1 console option, $2 manage tanks, $3 initial tanks state
  printf 'DUNE_AUTO_UPDATE_ENABLED=1\nDUNE_AUTO_UPDATE_INTERVAL_MINUTES=60\nDUNE_AUTO_UPDATE_NOTIFY_ENABLED=0\nDUNE_AUTO_UPDATE_CONSOLE_ENABLED=%s\nDUNE_AUTO_UPDATE_MANAGE_TANKS=%s\n' "$1" "$2" > "$state_file"
  echo "$3" > "$test_root/state/tanks"
  echo "v1.0.0" > "$project/VERSION"
  echo '{"enabled": true}' > "$project/runtime/generated/experimental-tanks.json"
  rm -f "$pending_file" "$tanks_file" "$test_root/state/game-applied" "$test_root/state/apply-unsettled"
  echo b1 > "$test_root/state/build"
  : > "$log"
}

auto_run() {
  (
    cd "$project"
    PATH="$test_root/bin:$PATH" \
      DUNE_AUTO_UPDATE_STATE_FILE="$state_file" \
      DUNE_AUTO_UPDATE_PENDING_FILE="$pending_file" \
      DUNE_AUTO_UPDATE_TANKS_FILE="$tanks_file" \
      DUNE_AUTO_UPDATE_SELF="$test_root/fake-update.sh" \
      DUNE_HOST_REPO_ROOT="$project" \
      bash runtime/scripts/update.sh auto run
  ) 2>&1
}

expect_order() {
  # Asserts that the given log lines appear in this order.
  local previous=0 line number
  for line in "$@"; do
    number="$(grep -n -F -- "$line" "$log" | head -n1 | cut -d: -f1 || true)"
    if [ -z "$number" ] || [ "$number" -le "$previous" ]; then
      printf 'Expected "%s" after line %s in:\n%s\n' "$line" "$previous" "$(cat "$log")" >&2
      exit 1
    fi
    previous="$number"
  done
}

# Both old management settings now use the regular, compatibility-checked updater.
for legacy_setting in 0 1; do
  reset 1 "$legacy_setting" on
  auto_run >/dev/null
  expect_order "GAME UPDATE APPLIED (tanks=on)" "console install"
  [ ! -f "$tanks_file" ]
  if grep -q 'tanks apply' "$log"; then exit 1; fi
  reset 0 "$legacy_setting" on
  if MOCK_GAME_UPDATE_FAILS=1 auto_run >/dev/null; then exit 1; fi
  [ "$(cat "$test_root/state/tanks")" = on ]
done

# Older releases may already have disabled Tanks and recorded a restore.
reset 1 1 off
printf 'DUNE_AUTO_TANKS_BUILD=b1\nDUNE_AUTO_TANKS_BASE_VERSION=v1.0.0\n' > "$tanks_file"
MOCK_CONSOLE_UPDATE=0 auto_run >/dev/null
[ -f "$tanks_file" ]
: > "$log"
auto_run >/dev/null
expect_order "console install" "tanks apply true"
[ ! -f "$tanks_file" ]
seed_legacy_restore() {
  reset 1 1 off
  printf 'DUNE_AUTO_TANKS_BUILD=b1\nDUNE_AUTO_TANKS_BASE_VERSION=v1.0.0\nDUNE_AUTO_TANKS_SINCE=1\n' > "$tanks_file"
}

seed_legacy_restore
touch "$test_root/state/game-applied"
MOCK_CONSOLE_UPDATE=0 auto_run >/dev/null
[ "$(cat "$test_root/state/tanks")" = on ]
[ ! -f "$tanks_file" ]

seed_legacy_restore
MOCK_TANKS_SUPPORTED=false auto_run >/dev/null
grep -Fqx 'DUNE_AUTO_TANKS_BASE_VERSION=v9.9.9' "$tanks_file"
[ "$(cat "$test_root/state/tanks")" = off ]

seed_legacy_restore
if MOCK_CONSOLE_INSTALL_RC=1 auto_run >/dev/null; then exit 1; fi
grep -Fqx 'DUNE_AUTO_TANKS_CONSOLE_INSTALL_PENDING=1' "$tanks_file"
[ "$(cat "$test_root/state/tanks")" = off ]
: > "$log"
auto_run >/dev/null
expect_order "console install" "tanks apply true"

seed_legacy_restore
MOCK_APPLY_TRUE_UNSETTLED=1 auto_run >/dev/null
[ -f "$tanks_file" ]

echo "update-auto-tanks tests passed"
