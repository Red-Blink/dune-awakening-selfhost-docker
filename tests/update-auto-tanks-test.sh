#!/usr/bin/env bash
# Automatic game update: Regis Tanks switched off before the game update and on
# again only after a newer Dune Docker release is installed.
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
    enabled=false; [ "\$(cat "\$state_file")" = on ] && enabled=true
    echo "{\"enabled\": \$enabled, \"supported\": \${MOCK_TANKS_SUPPORTED:-true}, \"build\": \"\$(cat "$test_root/state/build")\", \"applying\": false, \"error\": \"\"}" ;;
  apply)
    echo "tanks apply \$2" >> "$log"
    if [ "\$2" = false ] && [ -n "\${MOCK_APPLY_FALSE_FAILS:-}" ]; then echo "cannot switch" >&2; exit 1; fi
    [ "\$2" = true ] && echo on > "\$state_file" || echo off > "\$state_file" ;;
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
  rm -f "$pending_file" "$tanks_file" "$test_root/state/game-applied"
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

# 1. Management off: the old behaviour. Tanks on blocks the game update.
reset 0 0 on
if out="$(auto_run)"; then echo "update ran although Tanks were enabled and unmanaged" >&2; exit 1; fi
grep -Fq "Disable Experimental Tanks in Settings" <<<"$out"
! grep -Fq "GAME UPDATE APPLIED" "$log"
! grep -Fq "tanks apply" "$log"

# 2. Managed + Console option, release available: off -> game -> Console -> on.
reset 1 1 on
out="$(auto_run)"
expect_order "tanks apply false" "GAME UPDATE APPLIED (tanks=off)" "console install" "tanks apply true"
[ "$(cat "$test_root/state/tanks")" = on ]
[ ! -f "$tanks_file" ]
grep -Fq "Regis Tanks are enabled again." <<<"$out"

# 3. Managed, no Console release: Tanks stay off and the intent is remembered.
reset 1 1 on
MOCK_CONSOLE_UPDATE=0 auto_run >/dev/null
[ "$(cat "$test_root/state/tanks")" = off ]
[ -f "$tanks_file" ]
grep -Fq "DUNE_AUTO_TANKS_BASE_VERSION=v1.0.0" "$tanks_file"
! grep -Fq "tanks apply true" "$log"

# 3a. `auto status` reports both options and the pending restore in the keys the UI parses.
status_out="$(cd "$project" && PATH="$test_root/bin:$PATH" DUNE_AUTO_UPDATE_STATE_FILE="$state_file" \
  DUNE_AUTO_UPDATE_TANKS_FILE="$tanks_file" DUNE_AUTO_UPDATE_PENDING_FILE="$pending_file" bash runtime/scripts/update.sh auto status 2>&1 || true)"
grep -Eq '^Update Console: +1$' <<<"$status_out"
grep -Eq '^Manage Regis Tanks: +1$' <<<"$status_out"
grep -Eq '^Regis Tanks restore: +pending \(disabled for game build b1' <<<"$status_out"

# 3b. A later run with still no release keeps them off.
: > "$log"
out="$(MOCK_CONSOLE_UPDATE=0 auto_run)"
grep -Fq "Regis Tanks stay disabled" <<<"$out"
[ "$(cat "$test_root/state/tanks")" = off ]

# 3c. When the release finally appears, the next run installs it and re-enables Tanks.
: > "$log"
out="$(auto_run)"
expect_order "console install" "tanks apply true"
[ "$(cat "$test_root/state/tanks")" = on ]
[ ! -f "$tanks_file" ]

# 4. The new release has no patch for this build yet: stay off, wait for the next one.
reset 1 1 on
MOCK_TANKS_SUPPORTED=false auto_run >/dev/null
[ "$(cat "$test_root/state/tanks")" = off ]
grep -Fq "DUNE_AUTO_TANKS_BASE_VERSION=v9.9.9" "$tanks_file"
grep -Fq "DUNE_AUTO_TANKS_BUILD=b2" "$tanks_file"

# 5. Tanks cannot be switched off: the game update must not start.
reset 1 1 on
if out="$(MOCK_APPLY_FALSE_FAILS=1 auto_run)"; then echo "game update ran with Tanks still on" >&2; exit 1; fi
grep -Fq "The game update was not started." <<<"$out"
! grep -Fq "GAME UPDATE APPLIED" "$log"
[ ! -f "$tanks_file" ]

# 6. Tanks were off from the start: nothing to restore afterwards.
reset 1 1 off
auto_run >/dev/null
[ "$(cat "$test_root/state/tanks")" = off ]
[ ! -f "$tanks_file" ]
! grep -Fq "tanks apply" "$log"

# 8. The game update fails after Tanks were switched off: they stay off while the
#    update is still pending, and the failure is reported.
reset 1 1 on
if MOCK_GAME_UPDATE_FAILS=1 auto_run >/dev/null; then echo "failed game update reported success" >&2; exit 1; fi
[ "$(cat "$test_root/state/tanks")" = off ]
[ -f "$tanks_file" ]
: > "$log"
auto_run >/dev/null            # retry succeeds, console update brings the release
[ "$(cat "$test_root/state/tanks")" = on ]

# 9. Nothing changed (build unchanged, no update pending): Tanks come back at once,
#    without waiting for a Console release.
reset 1 1 off
printf 'DUNE_AUTO_TANKS_BUILD=b1\nDUNE_AUTO_TANKS_BASE_VERSION=v1.0.0\nDUNE_AUTO_TANKS_SINCE=1\n' > "$tanks_file"
touch "$test_root/state/game-applied"
MOCK_CONSOLE_UPDATE=0 auto_run >/dev/null
[ "$(cat "$test_root/state/tanks")" = on ]
[ ! -f "$tanks_file" ]
! grep -Fq "console install" "$log"

# 10. Unmanaged + Tanks enabled: players must not be warned about a blocked update.
reset 0 0 on
printf 'DUNE_AUTO_UPDATE_ENABLED=1\nDUNE_AUTO_UPDATE_INTERVAL_MINUTES=60\nDUNE_AUTO_UPDATE_NOTIFY_ENABLED=1\nDUNE_AUTO_UPDATE_NOTIFY_MINUTES=15,10,5,1\nDUNE_AUTO_UPDATE_MANAGE_TANKS=0\n' > "$state_file"
if out="$(auto_run)"; then echo "unmanaged update ran with Tanks enabled" >&2; exit 1; fi
! grep -Eqi "countdown|warning|notif" <<<"$out"
grep -Fq "update-guard" "$log"

# 7. Console option off but Tanks managed and a release is present later: no install.
reset 0 1 on
MOCK_CONSOLE_UPDATE=1 auto_run >/dev/null
! grep -Fq "console install" "$log"
[ "$(cat "$test_root/state/tanks")" = off ]

echo "update-auto-tanks tests passed"
