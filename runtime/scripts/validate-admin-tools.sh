#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

failures=0

ok() { printf 'OK   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; failures=$((failures + 1)); }
warn() { printf 'WARN %s\n' "$*" >&2; }

check_file() {
  local path="$1"
  [ -r "$path" ] && ok "$path exists" || fail "$path is missing or unreadable"
}

check_json_array() {
  local path="$1" label="$2"
  check_file "$path"
  python3 - "$path" "$label" <<'PY' || exit 1
import json, sys
path, label = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
if not isinstance(data, list) or not data:
    raise SystemExit(f"{label} must be a non-empty JSON array")
print(f"OK   {label} parses ({len(data)} rows)")
PY
}

if ! bash -n runtime/scripts/admin-tools.sh; then fail "admin-tools.sh syntax"; else ok "admin-tools.sh syntax"; fi
if ! bash -n runtime/scripts/manager.sh; then fail "manager.sh syntax"; else ok "manager.sh syntax"; fi
if ! bash -n runtime/scripts/dune; then fail "dune syntax"; else ok "dune syntax"; fi

check_json_array runtime/data/admin-items.json "item catalog"
check_json_array runtime/data/admin-vehicles.json "vehicle catalog"
check_json_array runtime/data/admin-skill-modules.json "skill module catalog"
check_json_array runtime/data/admin-xp-event-tags.json "XP event tag catalog"

python3 - <<'PY' || fail "catalog required fields"
import json
from pathlib import Path

vehicles = json.loads(Path("runtime/data/admin-vehicles.json").read_text())
for row in vehicles:
    assert row.get("id"), row
    assert row.get("actor_class"), row
    assert isinstance(row.get("templates"), list) and row["templates"], row

skills = json.loads(Path("runtime/data/admin-skill-modules.json").read_text())
for row in skills:
    assert row.get("id"), row
    assert row.get("name"), row
    assert row.get("category"), row
    assert int(row.get("maxLevel", 1)) >= 1, row
print("OK   catalog required fields")
PY

if grep -q 'publish_inner_json "$inner_json" "$command_id"' runtime/scripts/admin-tools.sh; then
  ok "non-item commands use Grant Item RabbitMQ path"
else
  fail "non-item commands do not use publish_inner_json"
fi

if grep -q 'exchange=grant' runtime/scripts/admin-tools.sh; then
  warn "legacy grant exchange helper remains for compatibility; normal non-item path should not call it"
fi

payload_checks=(
  "kick FLS_TEST --dry-run --yes --force --label TestPlayer"
  "award-xp FLS_TEST 1000"
  "skill-points FLS_TEST 10"
  "skill-module FLS_TEST Skills.Ability.Hypersprint 1"
  "refill-water FLS_TEST 1000000"
  "teleport FLS_TEST 1 2 3 90"
  "spawn-vehicle-at FLS_TEST Sandbike T6 1 2 3 90"
)

for args in "${payload_checks[@]}"; do
  if DUNE_ADMIN_DRY_RUN=1 DUNE_ADMIN_ASSUME_YES=1 runtime/scripts/dune admin $args >/tmp/admin-tools-validate.out 2>/tmp/admin-tools-validate.err; then
    ok "payload builds: dune admin $args"
  else
    fail "payload build failed: dune admin $args"
    sed -n '1,12p' /tmp/admin-tools-validate.err >&2 || true
  fi
done

kick_menu_count="$(grep -c '"Kick Player"' runtime/scripts/manager.sh || true)"
if [ "$kick_menu_count" = "1" ]; then
  ok "Kick Player menu entry exists exactly once"
else
  fail "Kick Player menu entry count is $kick_menu_count, expected 1"
fi

if grep -q 'admin_run_flow admin_kick_player_flow' runtime/scripts/manager.sh; then
  ok "Kick Player menu dispatch is wired"
else
  fail "Kick Player menu dispatch is missing"
fi

if grep -q 'build_kick_json' runtime/scripts/admin-tools.sh && grep -q '"ServerCommand": "KickPlayer"' runtime/scripts/admin-tools.sh; then
  ok "KickPlayer payload builder exists"
else
  fail "KickPlayer payload builder is missing"
fi

mkdir -p runtime/generated
if [ -w runtime/generated ]; then
  ok "runtime/generated is writable for admin logs"
else
  fail "runtime/generated is not writable"
fi

if docker ps --format '{{.Names}}' >/tmp/admin-tools-docker.out 2>/tmp/admin-tools-docker.err; then
  for container in dune-rmq-game dune-postgres; do
    if grep -qx "$container" /tmp/admin-tools-docker.out; then
      ok "$container container detected"
    else
      warn "$container container is not running; live admin commands will fail until the battlegroup is running"
    fi
  done
else
  warn "docker is unavailable; live container checks skipped"
fi

rm -f /tmp/admin-tools-validate.out /tmp/admin-tools-validate.err /tmp/admin-tools-docker.out /tmp/admin-tools-docker.err

if [ "$failures" -ne 0 ]; then
  printf '\n%d validation failure(s).\n' "$failures" >&2
  exit 1
fi

printf '\nAdmin Tools static validation passed.\n'
