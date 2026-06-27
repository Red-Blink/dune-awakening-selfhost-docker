#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

ITEMS_FILE="runtime/data/admin-items.json"
VEHICLES_FILE="runtime/data/admin-vehicles.json"
SKILL_MODULES_FILE="runtime/data/admin-skill-modules.json"
XP_EVENT_TAGS_FILE="runtime/data/admin-xp-event-tags.json"
TOKEN_FILE="runtime/secrets/funcom-token.txt"
COMMAND_TOKEN_FILE="runtime/secrets/command-auth-token.txt"
BUILTIN_COMMAND_AUTH_TOKEN="Nu6VmPWUMvdPMeB7qErr"
RMQ_CONTAINER="dune-rmq-game"
POSTGRES_CONTAINER="dune-postgres"
ADMIN_HISTORY_TSV="runtime/generated/admin-command-history.tsv"
ADMIN_AUDIT_JSONL="runtime/generated/admin-command-audit.jsonl"
ADMIN_COMMAND_PATH="rabbitmq-game:heartbeats/notifications"

usage() {
  cat <<'EOF'
Usage:
  runtime/scripts/dune admin players [--online] [--show-full-ids]
  runtime/scripts/dune admin kick <player-fls-id> [--dry-run] [--yes] [--force] [--label <name>]
  runtime/scripts/dune admin kick --all-online [--dry-run] [--yes]
  runtime/scripts/dune admin login-queues [--all]
  runtime/scripts/dune admin repair-login-queue <player-fls-id|queue-name> [--yes] [--force]
  runtime/scripts/dune admin item-search <query>
  runtime/scripts/dune admin item-list [category]
  runtime/scripts/dune admin grant-item <player-id|*> <item-name-or-id> [quantity] [durability] [grade]
  runtime/scripts/dune admin grant-item-id <player-id|*> <item-id> [quantity] [durability] [grade]
  runtime/scripts/dune admin grant-template <player-id|*> scout-ornithopter-mk6
  runtime/scripts/dune admin player-location <player-id>
  runtime/scripts/dune admin award-xp <player-id|*> <amount>
  runtime/scripts/dune admin skill-points <player-id|*> <points>
  runtime/scripts/dune admin skill-module <player-id|*> <module> <level>
  runtime/scripts/dune admin skill-modules [query]
  runtime/scripts/dune admin specialization-xp <character-name> (--all|--track <track>) [--level <level>] [--xp <xp>] [--grant-keystones] [--unlock-faction <Atreides|Harkonnen>] [--dry-run] [--yes] [--actor-id <id>]
  runtime/scripts/dune admin specialization-max <character-name> [--grant-keystones] [--unlock-faction <Atreides|Harkonnen>] [--dry-run] [--yes]
  runtime/scripts/dune admin refill-water <player-id|*> [amount]
  runtime/scripts/dune admin clean-inventory <player-id|*>
  runtime/scripts/dune admin reset-progression <player-id|*>
  runtime/scripts/dune admin teleport <player-id> <x> <y> <z> [yaw]
  runtime/scripts/dune admin spawn-vehicle <player-id> <vehicle-id> <template-name> [offset-units]
  runtime/scripts/dune admin spawn-vehicle-at <player-id> <vehicle-id> <template-name> <x> <y> <z> [rotation]
  runtime/scripts/dune admin broadcast-restart-warning <minutes>
  runtime/scripts/dune admin vehicle-list
  runtime/scripts/dune admin unsupported
  runtime/scripts/dune admin history
EOF
}

redact_fls() {
  local value="$1"
  local len="${#value}"
  if [ "$len" -le 10 ]; then
    printf '<redacted:%s>' "$len"
  else
    printf '%s...%s' "${value:0:4}" "${value: -4}"
  fi
}

redact_payload_summary() {
  local payload="$1"
  python3 - "$payload" <<'PY'
import json, sys
try:
    obj = json.loads(sys.argv[1])
except Exception:
    print("<invalid-json>")
    raise SystemExit(0)
if obj.get("PlayerId") and obj.get("PlayerId") != "*":
    obj["PlayerId"] = "<redacted>"
print(json.dumps(obj, separators=(",", ":")))
PY
}

audit_admin_action() {
  local command="$1" target="$2" friendly="$3" payload="$4" path="$5" result="$6" error="${7:-}"
  mkdir -p runtime/generated
  local ts payload_summary
  ts="$(date -Iseconds)"
  payload_summary="$(redact_payload_summary "$payload")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ts" "$command" "$target" "$friendly" "$path" "$result" "$payload_summary" >> "$ADMIN_HISTORY_TSV"
  python3 - "$ADMIN_AUDIT_JSONL" "$ts" "$command" "$target" "$friendly" "$payload_summary" "$path" "$result" "$error" <<'PY'
import json, sys
path, ts, command, target, friendly, payload, command_path, result, error = sys.argv[1:]
row = {
    "timestamp": ts,
    "action": command,
    "target": target,
    "friendly_label": friendly,
    "payload_summary": payload,
    "command_path": command_path,
    "result": result,
}
if error:
    row["error"] = error
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, separators=(",", ":")) + "\n")
PY
}

audit_admin_command() {
  local command="$1" target="$2" dry_run="$3" result="$4"
  audit_admin_action "$command" "$target" "$command dry_run=$dry_run" '{}' "$ADMIN_COMMAND_PATH" "$result"
}

require_items_file() {
  if [ ! -r "$ITEMS_FILE" ]; then
    echo "Missing readable item dataset: $ITEMS_FILE" >&2
    echo "Admin grants require the vendored item dataset." >&2
    exit 1
  fi
}

require_catalog_file() {
  local path="$1" label="$2"
  if [ ! -r "$path" ]; then
    echo "Missing readable $label catalog: $path" >&2
    exit 1
  fi
}

require_token_file() {
  if [ ! -s "$TOKEN_FILE" ]; then
    echo "Missing non-empty Funcom auth token: $TOKEN_FILE" >&2
    exit 1
  fi
}

display_category() {
  local value="${1:-}"
  printf '%s' "${value^}"
}

command_auth_token() {
  local raw

  if [ -n "${DUNE_COMMAND_AUTH_TOKEN:-}" ]; then
    printf '%s' "$DUNE_COMMAND_AUTH_TOKEN"
    return 0
  fi

  if [ -s "$COMMAND_TOKEN_FILE" ]; then
    raw="$(tr -d '\r\n' < "$COMMAND_TOKEN_FILE")"
    if [ -n "$raw" ]; then
      printf '%s' "$raw"
      return 0
    fi
  fi

  # Matches the working upstream manager's command-auth fallback.
  printf '%s' "$BUILTIN_COMMAND_AUTH_TOKEN"
}

require_rmq_game_running() {
  if ! docker exec "$RMQ_CONTAINER" rabbitmqctl status >/dev/null 2>&1; then
    echo "RabbitMQ game container is not running: $RMQ_CONTAINER" >&2
    echo "Start the battlegroup first; item grants are published live to the running container." >&2
    exit 1
  fi
}

require_postgres_running() {
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$POSTGRES_CONTAINER"; then
    echo "Postgres container is not running: $POSTGRES_CONTAINER" >&2
    exit 1
  fi
}

resolve_player_id() {
  local player_id="$1"
  local resolved

  if [ "$player_id" = "*" ]; then
    printf '%s' "$player_id"
    return 0
  fi

  if ! printf '%s' "$player_id" | grep -Eq '^[0-9]+$'; then
    printf '%s' "$player_id"
    return 0
  fi

  resolved="$(
    docker exec "$POSTGRES_CONTAINER" psql -U dune -d dune -At -c "
      select coalesce(nullif(\"user\", ''), nullif(funcom_id, ''))
      from dune.accounts
      where id = ${player_id}
      limit 1;
    " 2>/dev/null | tr -d '[:space:]' || true
  )"

  if [ -z "$resolved" ]; then
    echo "Could not resolve local account id '$player_id' to an FLS id in dune.accounts." >&2
    echo "Use the player's FLS id instead, or make sure $POSTGRES_CONTAINER is running." >&2
    exit 1
  fi

  printf '%s' "$resolved"
}

account_id_for_player_id() {
  local player_id="$1"

  [ "$player_id" != "*" ] || return 0
  docker exec "$POSTGRES_CONTAINER" psql -U dune -d dune -At -c "
    select id
    from dune.accounts
    where \"user\" = '${player_id//\'/\'\'}'
       or funcom_id = '${player_id//\'/\'\'}'
    limit 1;
  " 2>/dev/null | tr -d '[:space:]' || true
}

player_item_stack_count() {
  local account_id="$1"
  local item_id="$2"

  [ -n "$account_id" ] || return 0
  docker exec "$POSTGRES_CONTAINER" psql -U dune -d dune -At -c "
    select coalesce(sum(it.stack_size), 0)
    from dune.items it
    join dune.inventories inv on inv.id = it.inventory_id
    join dune.actors a on a.id = inv.actor_id
    where a.owner_account_id = ${account_id}
      and it.template_id = '${item_id//\'/\'\'}';
  " 2>/dev/null | tr -d '[:space:]' || true
}

validate_quantity() {
  local quantity="$1"
  if ! printf '%s' "$quantity" | grep -Eq '^[1-9][0-9]*$'; then
    echo "Quantity must be a positive integer." >&2
    exit 1
  fi
}

validate_durability() {
  local durability="$1"
  python3 - "$durability" <<'PY'
import sys
try:
    value = float(sys.argv[1])
except ValueError:
    print("Durability must be a number between 0 and 1.", file=sys.stderr)
    raise SystemExit(1)
if not 0 <= value <= 1:
    print("Durability must be a number between 0 and 1.", file=sys.stderr)
    raise SystemExit(1)
PY
}

validate_quality() {
  local quality="$1"
  python3 - "$quality" <<'PY'
import sys
try:
    value = int(sys.argv[1])
except Exception:
    print("Grade must be a whole number between 0 and 5.", file=sys.stderr)
    raise SystemExit(1)
if value < 0 or value > 5:
    print("Grade must be a whole number between 0 and 5.", file=sys.stderr)
    raise SystemExit(1)
PY
}

item_search() {
  local query="${1:-}"
  if [ -z "$query" ]; then
    echo "Usage: runtime/scripts/dune admin item-search <query>" >&2
    exit 1
  fi
  require_items_file
  python3 - "$ITEMS_FILE" "$query" <<'PY'
import json
import sys

items_path, query = sys.argv[1], sys.argv[2]
needle = query.casefold()
with open(items_path, encoding="utf-8") as f:
    items = json.load(f)

matches = []
for item in items:
    name = str(item.get("name") or "")
    category = str(item.get("category") or "")
    source = str(item.get("source") or "")
    item_id = str(item.get("id") or "")
    haystacks = (name, category, source, item_id)
    if any(needle in value.casefold() for value in haystacks):
        rank = 0 if needle in name.casefold() else 1
        matches.append((rank, name.casefold(), item))

if not matches:
    print(f"No items found for: {query}")
    raise SystemExit(1)

for index, (_, __, item) in enumerate(sorted(matches, key=lambda row: (row[0], row[1], row[2].get("source") or ""))[:100], 1):
    category = str(item.get("category") or "")
    category = category[:1].upper() + category[1:]
    print(f"{index}) {item.get('name', '')}")
    print(f"   category: {category}")
    print(f"   source: {item.get('source', '')}")
PY
}

item_list() {
  local category="${1:-}"
  require_items_file
  python3 - "$ITEMS_FILE" "$category" <<'PY'
import collections
import json
import sys

items_path, category_filter = sys.argv[1], sys.argv[2]
with open(items_path, encoding="utf-8") as f:
    items = json.load(f)

if category_filter:
    wanted = category_filter.casefold()
    filtered = [item for item in items if str(item.get("category") or "").casefold() == wanted]
    if not filtered:
        print(f"No items found in category: {category_filter}", file=sys.stderr)
        raise SystemExit(1)
    for item in sorted(filtered, key=lambda value: (str(value.get("name") or "").casefold(), str(value.get("source") or ""))):
        category = str(item.get("category") or "")
        category = category[:1].upper() + category[1:]
        print(f"{item.get('name', '')}")
        print(f"  category: {category}")
        print(f"  source: {item.get('source', '')}")
    raise SystemExit(0)

by_category = collections.defaultdict(list)
for item in items:
    by_category[str(item.get("category") or "uncategorized")].append(item)

for category in sorted(by_category, key=str.casefold):
    label = category[:1].upper() + category[1:]
    print(f"{label} ({len(by_category[category])})")
    for item in sorted(by_category[category], key=lambda value: str(value.get("name") or "").casefold()):
        print(f"  - {item.get('name', '')} [{item.get('source', '')}]")
PY
}

resolve_item() {
  local mode="$1"
  local value="$2"
  require_items_file
  python3 - "$ITEMS_FILE" "$mode" "$value" <<'PY'
import json
import sys

items_path, mode, value = sys.argv[1], sys.argv[2], sys.argv[3]
with open(items_path, encoding="utf-8") as f:
    items = json.load(f)

def emit(item):
    print(json.dumps({
        "id": item.get("id") or value,
        "name": item.get("name") or item.get("id") or value,
        "category": item.get("category") or "manual",
        "source": item.get("source") or "manual",
    }, ensure_ascii=False))

if mode == "id":
    for item in items:
        if str(item.get("id") or "") == value:
            emit(item)
            raise SystemExit(0)
    emit({"id": value, "name": value, "category": "manual", "source": "manual"})
    raise SystemExit(0)

folded = value.casefold()
name_matches = [item for item in items if str(item.get("name") or "").casefold() == folded]
if len(name_matches) > 1:
    non_schematics = [item for item in name_matches if str(item.get("category") or "").casefold() != "schematics"]
    if len(non_schematics) == 1:
        emit(non_schematics[0])
        raise SystemExit(0)
if len(name_matches) == 1:
    emit(name_matches[0])
    raise SystemExit(0)
if len(name_matches) > 1:
    print(f"Ambiguous item name: {value}", file=sys.stderr)
    for index, item in enumerate(name_matches[:25], 1):
        print(f"{index}) {item.get('name', '')}", file=sys.stderr)
        print(f"   category: {item.get('category', '')}", file=sys.stderr)
        print(f"   source: {item.get('source', '')}", file=sys.stderr)
    raise SystemExit(2)

id_matches = [item for item in items if str(item.get("id") or "") == value]
if len(id_matches) == 1:
    emit(id_matches[0])
    raise SystemExit(0)

partial = [
    item for item in items
    if folded in str(item.get("name") or "").casefold()
    or folded in str(item.get("category") or "").casefold()
    or folded in str(item.get("source") or "").casefold()
    or folded in str(item.get("id") or "").casefold()
]
if partial:
    print(f"No exact item name or id found for: {value}", file=sys.stderr)
    print("Close matches:", file=sys.stderr)
    for index, item in enumerate(sorted(partial, key=lambda x: str(x.get("name") or "").casefold())[:25], 1):
        print(f"{index}) {item.get('name', '')}", file=sys.stderr)
        print(f"   category: {item.get('category', '')}", file=sys.stderr)
        print(f"   source: {item.get('source', '')}", file=sys.stderr)
    raise SystemExit(1)

print(f"No item found for: {value}", file=sys.stderr)
print("Use item-search with a human-readable name, or grant-item-id for an advanced raw id grant.", file=sys.stderr)
raise SystemExit(1)
PY
}

build_inner_json() {
  local player_id="$1"
  local item_id="$2"
  local quantity="$3"
  local durability="$4"
  local quality="${5:-0}"
  python3 - "$player_id" "$item_id" "$quantity" "$durability" "$quality" <<'PY'
import json
import sys

player_id, item_id, quantity, durability, quality = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5])
print(json.dumps({
    "ServerCommand": "AddItemToInventory",
    "PlayerId": player_id,
    "ItemName": item_id,
    "Quantity": quantity,
    "Durability": durability,
    "Quality": quality,
    "Grade": quality,
    "ItemQuality": quality,
}, separators=(",", ":")))
PY
}

build_kick_json() {
  local player_id="$1"
  python3 - "$player_id" <<'PY'
import json
import sys
print(json.dumps({"ServerCommand": "KickPlayer", "PlayerId": sys.argv[1]}, separators=(",", ":")))
PY
}

build_passthrough_json() {
  local command_id="$1"
  shift
  python3 - "$command_id" "$@" <<'PY'
import json
import sys

command = sys.argv[1]
obj = {"ServerCommand": command}
for arg in sys.argv[2:]:
    key, value, kind = arg.split("=", 2)
    if kind == "int":
        obj[key] = int(value)
    elif kind == "float":
        obj[key] = float(value)
    else:
        obj[key] = value
if command == "AwardXP" and "Category" not in obj:
    obj["Category"] = "Combat"
print(json.dumps(obj, separators=(",", ":")))
PY
}

build_restart_warning_json() {
  local minutes="$1"
  python3 - "$minutes" <<'PY'
import json
import sys

minutes = int(sys.argv[1])
title = "Server Restart Incoming"
body = f"The server will restart in approximately {minutes} minutes."
print(json.dumps({
    "ServerCommand": "ServiceBroadcast",
    "BroadcastType": "Generic",
    "BroadcastPayload": {
        "BroadcastDuration": 30,
        "LocalizedText": [
            {"Key": "en", "Title": title, "Body": body},
            {"Key": "en-US", "Title": title, "Body": body},
        ],
    },
}, separators=(",", ":")))
PY
}

vehicle_list_command() {
  local query="${1:-}"
  require_catalog_file "$VEHICLES_FILE" "vehicle"
  python3 - "$VEHICLES_FILE" "$query" <<'PY'
import json, sys
path, query = sys.argv[1], sys.argv[2].casefold()
vehicles = json.load(open(path, encoding="utf-8"))
for vehicle in vehicles:
    vid = str(vehicle.get("id") or "")
    actor = str(vehicle.get("actor_class") or "")
    templates = [str(t) for t in vehicle.get("templates") or []]
    haystack = " ".join([vid, actor, *templates]).casefold()
    if query and query not in haystack:
        continue
    print(vid)
    print(f"  actor: {actor}")
    print(f"  templates: {', '.join(templates)}")
PY
}

resolve_vehicle() {
  local vehicle_id="$1" template_name="${2:-}"
  require_catalog_file "$VEHICLES_FILE" "vehicle"
  python3 - "$VEHICLES_FILE" "$vehicle_id" "$template_name" <<'PY'
import json, sys
path, vehicle_id, template_name = sys.argv[1], sys.argv[2], sys.argv[3]
vehicles = json.load(open(path, encoding="utf-8"))
for vehicle in vehicles:
    if str(vehicle.get("id") or "").casefold() != vehicle_id.casefold():
        continue
    templates = [str(t) for t in vehicle.get("templates") or []]
    if template_name:
        matched = next((t for t in templates if t.casefold() == template_name.casefold()), None)
        if not matched:
            print(f"Template '{template_name}' is not valid for vehicle '{vehicle.get('id')}'.", file=sys.stderr)
            print("Valid templates: " + ", ".join(templates), file=sys.stderr)
            raise SystemExit(1)
        template_name = matched
    elif templates:
        template_name = templates[0]
    print(json.dumps({
        "id": vehicle.get("id"),
        "actor_class": vehicle.get("actor_class") or "",
        "template": template_name,
        "templates": templates,
    }, separators=(",", ":")))
    raise SystemExit(0)
print(f"Unknown vehicle id: {vehicle_id}", file=sys.stderr)
print("Run: dune admin vehicle-list", file=sys.stderr)
raise SystemExit(1)
PY
}

skill_modules_command() {
  local query="${1:-}"
  require_catalog_file "$SKILL_MODULES_FILE" "skill module"
  python3 - "$SKILL_MODULES_FILE" "$query" <<'PY'
import json, sys
path, query = sys.argv[1], sys.argv[2].casefold()
rows = json.load(open(path, encoding="utf-8"))
matches = []
for row in rows:
    haystack = " ".join(str(row.get(k) or "") for k in ("id", "name", "category")).casefold()
    if not query or query in haystack:
        matches.append(row)
for row in sorted(matches, key=lambda r: (str(r.get("category") or ""), str(r.get("name") or "")))[:200]:
    print(f"{row.get('name')} [{row.get('category')}]")
    print(f"  id: {row.get('id')}")
    print(f"  max level: {row.get('maxLevel', 1)}")
PY
}

resolve_skill_module() {
  local value="$1"
  require_catalog_file "$SKILL_MODULES_FILE" "skill module"
  python3 - "$SKILL_MODULES_FILE" "$value" <<'PY'
import json, sys
path, value = sys.argv[1], sys.argv[2]
rows = json.load(open(path, encoding="utf-8"))
folded = value.casefold()
for row in rows:
    if str(row.get("id") or "").casefold() == folded:
        print(json.dumps(row, separators=(",", ":")))
        raise SystemExit(0)
name_matches = [row for row in rows if str(row.get("name") or "").casefold() == folded]
if len(name_matches) == 1:
    print(json.dumps(name_matches[0], separators=(",", ":")))
    raise SystemExit(0)
if len(name_matches) > 1:
    print(f"Ambiguous skill module name: {value}", file=sys.stderr)
    for row in name_matches[:25]:
        print(f"  {row.get('name')} [{row.get('category')}] id={row.get('id')}", file=sys.stderr)
    raise SystemExit(1)
partial = [
    row for row in rows
    if folded in " ".join(str(row.get(k) or "") for k in ("id", "name", "category")).casefold()
]
print(f"No exact skill module found for: {value}", file=sys.stderr)
if partial:
    print("Close matches:", file=sys.stderr)
    for row in partial[:25]:
        print(f"  {row.get('name')} [{row.get('category')}] id={row.get('id')}", file=sys.stderr)
raise SystemExit(1)
PY
}

validate_int() {
  local value="$1" label="$2"
  if ! printf '%s' "$value" | grep -Eq '^-?[0-9]+$'; then
    echo "$label must be an integer." >&2
    exit 1
  fi
}

validate_float() {
  local value="$1" label="$2"
  python3 - "$value" "$label" <<'PY'
import sys
try:
    float(sys.argv[1])
except ValueError:
    print(f"{sys.argv[2]} must be a number.", file=sys.stderr)
    raise SystemExit(1)
PY
}

psql_admin() {
  require_postgres_running
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d dune "$@"
}

backup_database_for_admin_write() {
  local output backup_file

  output="$(runtime/scripts/db.sh backup)"
  printf '%s\n' "$output" >&2
  backup_file="$(printf '%s\n' "$output" | awk '/runtime\/backups\/db\/.*\.backup$/ {print $1; exit}')"
  [ -n "$backup_file" ] || backup_file="unknown"
  printf '%s' "$backup_file"
}

specialization_tracks_csv() {
  local mode="$1" track="$2"
  if [ "$mode" = "all" ]; then
    printf '%s' "Crafting,Gathering,Exploration,Combat,Sabotage"
  else
    printf '%s' "$track"
  fi
}

specialization_track_sql_array() {
  local tracks_csv="$1" track out="" sep=""
  IFS=',' read -r -a tracks <<< "$tracks_csv"
  for track in "${tracks[@]}"; do
    case "$track" in
      Crafting|Gathering|Exploration|Combat|Sabotage) ;;
      *) echo "Invalid specialization track: $track" >&2; return 1 ;;
    esac
    out="$out$sep'$track'"
    sep=","
  done
  printf 'ARRAY[%s]::dune.specializationtracktype[]' "$out"
}

validate_specialization_schema() {
  local missing

  missing="$(psql_admin -At -v ON_ERROR_STOP=1 -c "
    with required(kind, name, present) as (
      values
        ('table', 'dune.specialization_tracks', to_regclass('dune.specialization_tracks') is not null),
        ('table', 'dune.purchased_specialization_keystones', to_regclass('dune.purchased_specialization_keystones') is not null),
        ('table', 'dune.specialization_keystones_map', to_regclass('dune.specialization_keystones_map') is not null),
        ('table', 'dune.actors', to_regclass('dune.actors') is not null),
        ('table', 'dune.player_state', to_regclass('dune.player_state') is not null),
        ('table', 'dune.factions', to_regclass('dune.factions') is not null),
        ('table', 'dune.player_faction', to_regclass('dune.player_faction') is not null),
        ('table', 'dune.player_faction_reputation', to_regclass('dune.player_faction_reputation') is not null),
        ('table', 'dune.journey_story_node', to_regclass('dune.journey_story_node') is not null),
        ('type', 'dune.specializationtracktype', to_regtype('dune.specializationtracktype') is not null)
    )
    select string_agg(kind || ' ' || name, ', ')
    from required
    where not present;
  " | tr -d '\r')"

  if [ -n "$missing" ]; then
    echo "Missing required specialization schema object(s): $missing" >&2
    exit 1
  fi
}

specialization_character_matches() {
  local character="$1" character_sql
  character_sql="${character//\'/\'\'}"
  psql_admin -At -F $'\t' -v ON_ERROR_STOP=1 -c "
    with exact_matches as (
      select distinct
        coalesce(ps.player_pawn_id, a.id) as actor_id,
        ps.character_name,
        ps.account_id,
        coalesce(ps.online_status::text, 'Unknown') as online_status,
        true as exact_match
      from dune.player_state ps
      left join dune.actors a on a.id = ps.player_pawn_id
      where lower(ps.character_name) = lower('$character_sql')
        and coalesce(ps.player_pawn_id, a.id) is not null
        and (a.id is null or a.class ilike '%PlayerCharacter%')
      union
      select distinct
        a.id as actor_id,
        ps.character_name,
        ps.account_id,
        coalesce(ps.online_status::text, 'Unknown') as online_status,
        true as exact_match
      from dune.player_state ps
      join dune.actors a on a.owner_account_id = ps.account_id
      where ps.player_pawn_id is null
        and lower(ps.character_name) = lower('$character_sql')
        and a.class ilike '%PlayerCharacter%'
    ),
    partial_matches as (
      select distinct
        coalesce(ps.player_pawn_id, a.id) as actor_id,
        ps.character_name,
        ps.account_id,
        coalesce(ps.online_status::text, 'Unknown') as online_status,
        false as exact_match
      from dune.player_state ps
      left join dune.actors a on a.id = ps.player_pawn_id
      where ps.character_name ilike '%' || '$character_sql' || '%'
        and coalesce(ps.player_pawn_id, a.id) is not null
        and (a.id is null or a.class ilike '%PlayerCharacter%')
      union
      select distinct
        a.id as actor_id,
        ps.character_name,
        ps.account_id,
        coalesce(ps.online_status::text, 'Unknown') as online_status,
        false as exact_match
      from dune.player_state ps
      join dune.actors a on a.owner_account_id = ps.account_id
      where ps.player_pawn_id is null
        and ps.character_name ilike '%' || '$character_sql' || '%'
        and a.class ilike '%PlayerCharacter%'
    ),
    chosen as (
      select * from exact_matches
      union all
      select * from partial_matches
      where not exists (select 1 from exact_matches)
    )
    select actor_id, character_name, account_id, online_status, exact_match
    from chosen
    order by exact_match desc, character_name, actor_id;
  " | tr -d '\r'
}

resolve_specialization_character() {
  local character="$1" actor_override="${2:-}" rows count

  if [ -n "$actor_override" ]; then
    validate_int "$actor_override" "Actor id"
    rows="$(psql_admin -At -F $'\t' -v ON_ERROR_STOP=1 -c "
      select a.id, coalesce(ps.character_name, '<unknown>'), coalesce(ps.account_id::text, ''), coalesce(ps.online_status::text, 'Unknown'), true
      from dune.actors a
      left join dune.player_state ps on ps.player_pawn_id = a.id or ps.account_id = a.owner_account_id
      where a.id = $actor_override::bigint
        and a.class ilike '%PlayerCharacter%'
      limit 1;
    " | tr -d '\r')"
    [ -n "$rows" ] || { echo "No PlayerCharacter actor found for actor_id $actor_override." >&2; exit 1; }
    printf '%s\n' "$rows"
    return 0
  fi

  rows="$(specialization_character_matches "$character")"
  count="$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
  case "${count:-0}" in
    0)
      echo "No character matched: $character" >&2
      exit 1
      ;;
    1)
      printf '%s\n' "$rows"
      ;;
    *)
      echo "Character name is ambiguous: $character" >&2
      echo "Matches:" >&2
      printf '%s\n' "$rows" | awk -F '\t' '{ printf "  - %s (actor_id=%s, account_id=%s, status=%s)\n", $2, $1, $3, $4 }' >&2
      echo "Rerun with an exact full character name, or use --actor-id <id>." >&2
      exit 1
      ;;
  esac
}

specialization_preview() {
  local actor_id="$1"
  psql_admin -P pager=off -v ON_ERROR_STOP=1 -c "
    select track_type, xp_amount, level
    from dune.specialization_tracks
    where player_id = $actor_id::bigint
    order by track_type::text;
  "
}

normalize_faction_name() {
  local faction="$1"
  case "${faction,,}" in
    atreides) printf '%s' "Atreides" ;;
    harkonnen) printf '%s' "Harkonnen" ;;
    none|"") printf '%s' "" ;;
    *) echo "Faction must be Atreides or Harkonnen." >&2; return 1 ;;
  esac
}

specialization_apply_sql() {
  local actor_id="$1" account_id="$2" level="$3" xp="$4" tracks_csv="$5" grant_keystones="$6" unlock_faction="$7"
  local track_array keystone_sql faction_sql unlock_faction_sql journey_id_column journey_id_value

  track_array="$(specialization_track_sql_array "$tracks_csv")"
  unlock_faction_sql="${unlock_faction//\'/\'\'}"
  keystone_sql=""
  if [ "$grant_keystones" = "1" ]; then
    keystone_sql="
      insert into dune.purchased_specialization_keystones (player_id, keystone_id)
      select $actor_id::bigint, id
      from dune.specialization_keystones_map
      on conflict do nothing;
    "
  fi
  faction_sql=""
  if [ -n "$unlock_faction" ]; then
    journey_id_column="$(psql_admin -At -v ON_ERROR_STOP=1 -c "
      select case
        when exists (
          select 1 from information_schema.columns
          where table_schema = 'dune' and table_name = 'journey_story_node' and column_name = 'character_id'
        ) then 'character_id'
        when exists (
          select 1 from information_schema.columns
          where table_schema = 'dune' and table_name = 'journey_story_node' and column_name = 'account_id'
        ) then 'account_id'
        else ''
      end;
    " | tr -d '\r[:space:]')"
    if [ -z "$journey_id_column" ]; then
      echo "Cannot unlock faction journey because dune.journey_story_node has no supported player identity column." >&2
      exit 1
    fi
    if [ "$journey_id_column" = "character_id" ]; then
      journey_id_value="$(psql_admin -At -v ON_ERROR_STOP=1 -c "select id from dune.player_state where account_id = $account_id::bigint limit 1;" | tr -d '\r[:space:]')"
      if [ -z "$journey_id_value" ]; then
        echo "Cannot unlock faction journey because no player_state row was found for account_id $account_id." >&2
        exit 1
      fi
    else
      journey_id_value="$account_id"
    fi
    faction_sql="
      insert into dune.player_faction (actor_id, faction_id, utc_time_faction_change)
      select $actor_id::bigint, f.id, now()
      from dune.factions f
      where lower(f.name) = lower('$unlock_faction_sql')
      on conflict (actor_id)
      do update set faction_id = excluded.faction_id, utc_time_faction_change = excluded.utc_time_faction_change;

      insert into dune.player_faction_reputation (actor_id, faction_id, reputation_amount)
      select $actor_id::bigint, f.id, 0
      from dune.factions f
      where lower(f.name) = lower('$unlock_faction_sql')
      on conflict (actor_id, faction_id)
      do nothing;

      update dune.journey_story_node
      set complete_condition_state = 'true'::jsonb,
          reveal_condition_state = 'true'::jsonb,
          has_pending_reward = false,
          fail_condition_state = '{}'::jsonb
      where $journey_id_column = $journey_id_value::bigint
        and story_node_id like 'DA_FQ_ClimbTheRanks.JoinAHouse%';
    "
  fi

  psql_admin -v ON_ERROR_STOP=1 -c "
      begin;
      insert into dune.specialization_tracks (player_id, track_type, xp_amount, level)
      select $actor_id::bigint, unnest($track_array), $xp::bigint, $level::integer
      on conflict (player_id, track_type)
      do update set xp_amount = excluded.xp_amount, level = excluded.level;
      $keystone_sql
      $faction_sql
      commit;
    "
}

specialization_xp_command() {
  local character="${1:-}" mode="" track="" level="100" xp="44182" grant_keystones=0 dry_run=0 assume_yes=0 actor_override="" unlock_faction=""
  local arg tracks_csv row actor_id character_name account_id online_status exact_match answer backup_file payload

  [ -n "$character" ] || { echo "Usage: dune admin specialization-xp <character-name> (--all|--track <track>) [--level <level>] [--xp <xp>] [--grant-keystones] [--unlock-faction <Atreides|Harkonnen>] [--dry-run] [--yes]" >&2; exit 2; }
  shift || true
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --all) mode="all" ;;
      --track)
        shift || { echo "--track requires a value." >&2; exit 2; }
        mode="track"; track="$1"
        ;;
      --level)
        shift || { echo "--level requires a value." >&2; exit 2; }
        level="$1"
        ;;
      --xp)
        shift || { echo "--xp requires a value." >&2; exit 2; }
        xp="$1"
        ;;
      --grant-keystones) grant_keystones=1 ;;
      --unlock-faction)
        shift || { echo "--unlock-faction requires a value." >&2; exit 2; }
        unlock_faction="$(normalize_faction_name "$1")"
        ;;
      --dry-run) dry_run=1 ;;
      --yes|-y) assume_yes=1 ;;
      --actor-id)
        shift || { echo "--actor-id requires a value." >&2; exit 2; }
        actor_override="$1"
        ;;
      --*) echo "Unknown specialization-xp option: $arg" >&2; exit 2 ;;
      *) echo "Unexpected argument: $arg" >&2; exit 2 ;;
    esac
    shift
  done
  [ "${DUNE_ADMIN_DRY_RUN:-0}" = "1" ] && dry_run=1
  [ "${DUNE_ADMIN_ASSUME_YES:-0}" = "1" ] && assume_yes=1
  [ -n "$mode" ] || { echo "Choose --all or --track <track>." >&2; exit 2; }
  validate_int "$level" "Level"
  validate_int "$xp" "XP amount"
  [ "$level" -ge 0 ] && [ "$level" -le 100 ] || { echo "Level must be between 0 and 100." >&2; exit 1; }
  [ "$xp" -ge 0 ] || { echo "XP amount must be zero or greater." >&2; exit 1; }

  tracks_csv="$(specialization_tracks_csv "$mode" "$track")"
  specialization_track_sql_array "$tracks_csv" >/dev/null
  validate_specialization_schema
  row="$(resolve_specialization_character "$character" "$actor_override")"
  IFS=$'\t' read -r actor_id character_name account_id online_status exact_match <<< "$row"
  if [ -n "$unlock_faction" ] && [ -z "${account_id:-}" ]; then
    echo "Cannot unlock faction journey because the selected actor did not resolve to a player_state account_id." >&2
    exit 1
  fi

  echo "Specialization update preview:"
  echo "  Character: $character_name"
  echo "  Actor id: $actor_id"
  echo "  Account id: ${account_id:-unknown}"
  echo "  Status: ${online_status:-Unknown}"
  echo "  Tracks: $tracks_csv"
  echo "  Level: $level"
  echo "  XP amount: $xp"
  echo "  Grant all keystones: $([ "$grant_keystones" = "1" ] && echo yes || echo no)"
  echo "  Unlock faction journey: ${unlock_faction:-no}"
  echo
  echo "Current specialization tracks:"
  specialization_preview "$actor_id" || true

  payload="$(python3 - "$actor_id" "$character_name" "$tracks_csv" "$level" "$xp" "$grant_keystones" "$unlock_faction" <<'PY'
import json, sys
actor_id, name, tracks, level, xp, keystones, faction = sys.argv[1:]
print(json.dumps({
    "ActorId": int(actor_id),
    "Character": name,
    "Tracks": tracks.split(","),
    "Level": int(level),
    "XpAmount": int(xp),
    "GrantKeystones": keystones == "1",
    "UnlockFaction": faction or None,
}, separators=(",", ":")))
PY
)"

  if [ "$dry_run" = "1" ]; then
    echo
    echo "Dry run: no backup created and no database writes performed."
    echo "Would upsert dune.specialization_tracks and grant keystones: $([ "$grant_keystones" = "1" ] && echo yes || echo no)."
    [ -z "$unlock_faction" ] || echo "Would unlock faction journey for: $unlock_faction."
    audit_admin_action "SpecializationXP" "$actor_id" "$character_name" "$payload" "postgres:dune" "dry-run"
    return 0
  fi

  echo
  echo "WARNING: this directly edits specialization tables in PostgreSQL."
  [ -z "$unlock_faction" ] || echo "WARNING: this will also set the player's faction to $unlock_faction and mark JoinAHouse journey nodes complete."
  echo "A database backup will be created before the write."
  if [ "$assume_yes" != "1" ]; then
    read -r -p "Type APPLY SPECIALIZATION XP to continue: " answer
    [ "$answer" = "APPLY SPECIALIZATION XP" ] || { echo "Cancelled."; exit 1; }
  fi

  backup_file="$(backup_database_for_admin_write)"
  echo
  specialization_apply_sql "$actor_id" "$account_id" "$level" "$xp" "$tracks_csv" "$grant_keystones" "$unlock_faction"
  audit_admin_action "SpecializationXP" "$actor_id" "$character_name" "$payload" "postgres:dune" "applied backup=$backup_file"

  echo
  echo "Specialization update applied."
  echo "  Character: $character_name"
  echo "  Actor id: $actor_id"
  echo "  Tracks updated: $tracks_csv"
  echo "  XP amount: $xp"
  echo "  Level: $level"
  echo "  Keystones granted: $([ "$grant_keystones" = "1" ] && echo yes || echo no)"
  echo "  Faction journey unlocked: ${unlock_faction:-no}"
  echo "  Backup: $backup_file"
  echo "The player may need to relog, or affected services may need a restart, if specialization state is cached."
}

specialization_max_command() {
  local character="${1:-}"
  [ -n "$character" ] || { echo "Usage: dune admin specialization-max <character-name> [--grant-keystones] [--unlock-faction <Atreides|Harkonnen>] [--dry-run] [--yes]" >&2; exit 2; }
  shift || true
  specialization_xp_command "$character" --all --level 100 --xp 44182 "$@"
}

build_outer_b64() {
  local inner_json="$1"
  local token
  token="$(command_auth_token)"
  python3 - "$token" "$inner_json" <<'PY'
import base64
import json
import sys

token, inner_json = sys.argv[1], sys.argv[2]
outer = {
    "Version": 2,
    "AuthToken": token,
    "MessageContent": inner_json,
}
encoded = base64.b64encode(json.dumps(outer, separators=(",", ":")).encode("utf-8")).decode("ascii")
print(encoded)
PY
}

redact_sensitive_output() {
  sed -E 's/("AuthToken"[[:space:]]*:[[:space:]]*")[^"]+/\1<redacted>/g; s/[A-Za-z0-9+\/]{80,}={0,2}/<redacted-base64>/g'
}

publish_inner_json() {
  local inner_json="$1"
  local label="${2:-admin-command}"
  local outer_b64 eval_code output

  require_token_file
  require_rmq_game_running
  outer_b64="$(build_outer_b64 "$inner_json")"
  eval_code='Outer = base64:decode(<<"'"$outer_b64"'">>), XName = rabbit_misc:r(<<"/">>, exchange, <<"heartbeats">>), X = rabbit_exchange:lookup_or_die(XName), MsgId = list_to_binary("smgmt-'"$label"'-" ++ integer_to_list(erlang:system_time(millisecond))), P = {list_to_atom("P_basic"), <<"Content">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, undefined, <<"fls">>, <<"fls_backend">>, undefined}, Content = rabbit_basic:build_content(P, Outer), {ok, Msg} = rabbit_basic:message(XName, <<"notifications">>, Content), Result = rabbit_queue_type:publish_at_most_once(X, Msg), io:format("publish=~p exchange=heartbeats routing=notifications app_id=fls_backend user_id=fls label='"$label"'~n", [Result]).'

  set +e
  output="$(docker exec "$RMQ_CONTAINER" rabbitmqctl eval "$eval_code" 2>&1)"
  local rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$output" | redact_sensitive_output >&2
    echo "RabbitMQ publish command failed." >&2
    exit "$rc"
  fi

  printf '%s\n' "$output" | redact_sensitive_output
  if ! printf '%s\n' "$output" | grep -q 'publish=ok'; then
    echo "RabbitMQ publish did not report publish=ok." >&2
    exit 1
  fi
}

player_rows() {
  local online_only="$1"
  require_postgres_running
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d dune -At -F '|' -c "
    select
      convert_from(e.encrypted_funcom_id, 'UTF8') as fls_id,
      coalesce(ps.character_name, '') as character_name,
      coalesce(ps.online_status::text, 'Unknown') as online_status,
      coalesce(fs.map, '') as map,
      coalesce(wp.partition_id::text, '') as partition_id
    from dune.encrypted_accounts e
    left join dune.player_state ps on ps.account_id = e.id
    left join dune.farm_state fs on fs.server_id = ps.server_id
    left join dune.world_partition wp on wp.server_id = ps.server_id
    where convert_from(e.encrypted_funcom_id, 'UTF8') <> ''
      $([ "$online_only" = "1" ] && printf "and coalesce(ps.online_status::text, 'Offline') <> 'Offline'")
    order by ps.online_status desc nulls last, ps.character_name nulls last, fls_id;
  " 2>/dev/null
}

players_command() {
  local online_only=0 show_full=0 rows row fls name status map partition id_label count=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --online) online_only=1 ;;
      --show-full-ids) show_full=1 ;;
      *) echo "Unknown players option: $1" >&2; exit 2 ;;
    esac
    shift
  done
  rows="$(player_rows "$online_only" || true)"
  if [ "$online_only" = "1" ] && [ -z "$(printf '%s\n' "$rows" | sed '/^$/d')" ]; then
    echo "No online players were found, or online state is unavailable from player_state/farm_state." >&2
    exit 1
  fi
  printf '%-24s %-22s %-12s %-20s %s\n' "FLS" "Character" "Status" "Map" "Partition"
  while IFS='|' read -r fls name status map partition; do
    [ -n "${fls:-}" ] || continue
    if [ "$show_full" = "1" ]; then id_label="$fls"; else id_label="$(redact_fls "$fls")"; fi
    printf '%-24s %-22s %-12s %-20s %s\n' "$id_label" "${name:-}" "${status:-Unknown}" "${map:-}" "${partition:-}"
    count=$((count + 1))
  done <<< "$rows"
  [ "$count" -gt 0 ] || echo "No known players found."
}

normalize_login_queue_name() {
  local target="$1"

  target="${target%$'\r'}"
  target="${target%$'\n'}"
  [ -n "$target" ] || { echo "Player FLS id or queue name is required." >&2; exit 2; }
  case "$target" in
    *_queue) ;;
    *) target="${target}_queue" ;;
  esac
  if ! printf '%s' "$target" | grep -Eq '^[A-Za-z0-9_+.-]+_queue$'; then
    echo "Invalid login queue name: $target" >&2
    exit 2
  fi
  printf '%s' "$target"
}

login_queue_player_id() {
  local queue="$1"
  printf '%s' "${queue%_queue}"
}

rmq_login_queues() {
  require_rmq_game_running
  docker exec "$RMQ_CONTAINER" rabbitmqctl -q list_queues name consumers messages state 2>/dev/null \
    | awk -F '\t' '$1 ~ /_queue$/ { print }'
}

rmq_login_queue_row() {
  local queue="$1"
  rmq_login_queues | awk -F '\t' -v queue="$queue" '$1 == queue { print; found = 1 } END { exit found ? 0 : 1 }'
}

login_queues_command() {
  local show_all=0 rows row queue consumers messages state player status_row online_status map shown=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --all) show_all=1 ;;
      *) echo "Unknown login-queues option: $1" >&2; exit 2 ;;
    esac
    shift
  done

  rows="$(rmq_login_queues || true)"
  if [ -z "$(printf '%s\n' "$rows" | sed '/^$/d')" ]; then
    echo "No per-player login queues found."
    return 0
  fi

  printf '%-24s %-9s %-9s %-10s %-12s %s\n' "Player" "Consumers" "Messages" "State" "DB Status" "Map"
  while IFS=$'\t' read -r queue consumers messages state; do
    [ -n "${queue:-}" ] || continue
    player="$(login_queue_player_id "$queue")"
    status_row="$(player_status_for_fls "$player" || true)"
    IFS='|' read -r online_status map <<< "$status_row"
    online_status="${online_status:-Unknown}"
    map="${map:-}"

    if [ "$show_all" != "1" ] && printf '%s' "$online_status" | grep -Eiq '^online$'; then
      continue
    fi

    printf '%-24s %-9s %-9s %-10s %-12s %s\n' "$(redact_fls "$player")" "${consumers:-0}" "${messages:-0}" "${state:-unknown}" "$online_status" "$map"
    shown=$((shown + 1))
  done <<< "$rows"

  if [ "$shown" -eq 0 ]; then
    echo "No offline/unknown per-player login queues found. Use --all to include online players."
  fi
}

repair_login_queue_command() {
  local target="${1:-}" yes=0 force=0 queue player row consumers messages state status_row online_status map answer payload output rc
  [ -n "$target" ] || { echo "Usage: dune admin repair-login-queue <player-fls-id|queue-name> [--yes] [--force]" >&2; exit 2; }
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes|-y) yes=1 ;;
      --force) force=1 ;;
      *) echo "Unknown repair-login-queue option: $1" >&2; exit 2 ;;
    esac
    shift
  done

  queue="$(normalize_login_queue_name "$target")"
  player="$(login_queue_player_id "$queue")"
  row="$(rmq_login_queue_row "$queue" || true)"
  if [ -z "$row" ]; then
    echo "No RabbitMQ login queue exists for $(redact_fls "$player")."
    return 0
  fi

  IFS=$'\t' read -r queue consumers messages state <<< "$row"
  status_row="$(player_status_for_fls "$player" || true)"
  IFS='|' read -r online_status map <<< "$status_row"
  online_status="${online_status:-Unknown}"
  map="${map:-}"

  echo "Target queue: $queue"
  echo "Player:       $(redact_fls "$player")"
  echo "Queue state:  consumers=${consumers:-0} messages=${messages:-0} state=${state:-unknown}"
  echo "DB status:    $online_status${map:+ on $map}"

  if printf '%s' "$online_status" | grep -Eiq '^online$' && [ "$force" != "1" ]; then
    echo "Refusing to delete the login queue because the player still appears Online." >&2
    echo "If the player is confirmed stuck/offline from the client side, rerun with --force --yes." >&2
    exit 1
  fi

  if [ "$yes" != "1" ]; then
    printf 'Delete this login queue so the next login can recreate it? [y/N]: '
    read -r answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Cancelled."; return 0 ;;
    esac
  fi

  payload="{\"Queue\":\"$queue\",\"PlayerId\":\"$player\",\"Consumers\":\"${consumers:-0}\",\"Messages\":\"${messages:-0}\",\"State\":\"${state:-unknown}\",\"DbStatus\":\"$online_status\"}"
  set +e
  output="$(docker exec "$RMQ_CONTAINER" rabbitmqctl -q delete_queue "$queue" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$output" >&2
    audit_admin_action "RepairLoginQueue" "$(redact_fls "$player")" "$queue" "$payload" "rabbitmq-game" "failed" "$output"
    exit "$rc"
  fi

  audit_admin_action "RepairLoginQueue" "$(redact_fls "$player")" "$queue" "$payload" "rabbitmq-game" "deleted"
  echo "Deleted stale login queue for $(redact_fls "$player")."
  echo "Ask the player to connect again; the game client should recreate a clean queue."
}

player_status_for_fls() {
  local fls="$1"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$POSTGRES_CONTAINER"; then
    return 2
  fi
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d dune -At -F '|' -c "
    with matched_accounts as (
      select a.id
      from dune.accounts a
      where lower(coalesce(nullif(a.\"user\", ''), '')) = lower('${fls//\'/\'\'}')
         or lower(coalesce(nullif(a.funcom_id, ''), '')) = lower('${fls//\'/\'\'}')
      union
      select e.id
      from dune.encrypted_accounts e
      where lower(convert_from(e.encrypted_funcom_id, 'UTF8')) = lower('${fls//\'/\'\'}')
    )
    select coalesce(ps.online_status::text, 'Unknown') || '|' || coalesce(fs.map, wp.map, '')
    from matched_accounts m
    left join dune.player_state ps on ps.account_id = m.id
    left join dune.farm_state fs on fs.server_id = ps.server_id
    left join dune.world_partition wp on wp.partition_id = ps.previous_server_partition_id
    limit 1;
  " 2>/dev/null | tr -d '\r' || true
}

player_location_for_fls() {
  local fls="$1"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$POSTGRES_CONTAINER"; then
    return 2
  fi
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d dune -At -F '|' -c "
    with matched_accounts as (
      select a.id
      from dune.accounts a
      where lower(coalesce(nullif(a.\"user\", ''), '')) = lower('${fls//\'/\'\'}')
         or lower(coalesce(nullif(a.funcom_id, ''), '')) = lower('${fls//\'/\'\'}')
      union
      select e.id
      from dune.encrypted_accounts e
      where lower(convert_from(e.encrypted_funcom_id, 'UTF8')) = lower('${fls//\'/\'\'}')
    )
    select
      coalesce(ps.online_status::text, 'Unknown'),
      coalesce(fs.map, wp.map, ''),
      coalesce(wp.partition_id::text, ps.previous_server_partition_id::text, ''),
      coalesce(ps.server_id, '')
    from matched_accounts m
    left join dune.player_state ps on ps.account_id = m.id
    left join dune.farm_state fs on fs.server_id = ps.server_id
    left join dune.world_partition wp on wp.server_id = ps.server_id
    limit 1;
  " 2>/dev/null | tr -d '\r' || true
}

player_position_for_fls() {
  local fls="$1"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$POSTGRES_CONTAINER"; then
    return 2
  fi
  docker exec "$POSTGRES_CONTAINER" psql -U postgres -d dune -At -F '|' -c "
    with matched_accounts as (
      select a.id
      from dune.accounts a
      where lower(coalesce(nullif(a.\"user\", ''), '')) = lower('${fls//\'/\'\'}')
         or lower(coalesce(nullif(a.funcom_id, ''), '')) = lower('${fls//\'/\'\'}')
      union
      select e.id
      from dune.encrypted_accounts e
      where lower(convert_from(e.encrypted_funcom_id, 'UTF8')) = lower('${fls//\'/\'\'}')
         or lower(coalesce(e.\"user\"::text, '')) = lower('${fls//\'/\'\'}')
    )
    select
      coalesce(ps.online_status::text, 'Unknown'),
      coalesce(fs.map, wp.map, ''),
      coalesce(a.partition_id::text, wp.partition_id::text, ps.previous_server_partition_id::text, ''),
      coalesce(ps.server_id, ''),
      ((a.transform).location).x::float8,
      ((a.transform).location).y::float8,
      ((a.transform).location).z::float8,
      ((a.transform).rotation).x::float8,
      ((a.transform).rotation).y::float8,
      ((a.transform).rotation).z::float8,
      ((a.transform).rotation).w::float8,
      coalesce(a.dimension_index::text, ''),
      coalesce(a.class, '')
    from matched_accounts m
    join dune.player_state ps on ps.account_id = m.id
    join dune.actors a on a.id = ps.player_pawn_id
    left join dune.farm_state fs on fs.server_id = ps.server_id
    left join dune.world_partition wp on wp.server_id = ps.server_id
    limit 1;
  " 2>/dev/null | tr -d '\r' || true
}

compute_spawn_in_front() {
  local x="$1" y="$2" z="$3" qx="$4" qy="$5" qz="$6" qw="$7" offset="$8" z_offset="${9:-0}"
  python3 - "$x" "$y" "$z" "$qx" "$qy" "$qz" "$qw" "$offset" "$z_offset" <<'PY'
import json, math, sys
x, y, z, qx, qy, qz, qw, offset, z_offset = map(float, sys.argv[1:])
# Unreal uses X/Y as horizontal axes and Z as up. Use the pawn's +X forward vector,
# projected onto the ground plane, so pitch/roll do not skew the spawn point.
fx = 1.0 - 2.0 * (qy * qy + qz * qz)
fy = 2.0 * (qx * qy + qw * qz)
length = math.hypot(fx, fy)
if length < 1e-6:
    siny_cosp = 2.0 * (qw * qz + qx * qy)
    cosy_cosp = 1.0 - 2.0 * (qy * qy + qz * qz)
    yaw = math.atan2(siny_cosp, cosy_cosp)
    fx, fy = math.cos(yaw), math.sin(yaw)
else:
    fx, fy = fx / length, fy / length
yaw = math.atan2(fy, fx)
sx = x + fx * offset
sy = y + fy * offset
print(json.dumps({
    "x": sx,
    "y": sy,
    "z": z + z_offset,
    "rotation": math.degrees(yaw),
    "yawRadians": yaw,
}, separators=(",", ":")))
PY
}

is_flying_vehicle() {
  local vehicle_id="$1" actor_class="$2"
  case "$vehicle_id:$actor_class" in
    *Ornithopter*|*ornithopter*|*FlyingVehicles*) return 0 ;;
    *) return 1 ;;
  esac
}

kick_command() {
  local target="" dry_run=0 assume_yes=0 force=0 all_online=0 inner_json status map answer audit_target result
  local row status_rc resolved_target friendly_label="" output rc error_text
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1 ;;
      --yes|-y) assume_yes=1 ;;
      --force) force=1 ;;
      --all-online) all_online=1; target="*" ;;
      --label)
        shift || { echo "--label requires a value." >&2; exit 2; }
        friendly_label="$1"
        ;;
      --*) echo "Unknown kick option: $1" >&2; exit 2 ;;
      *) target="$1" ;;
    esac
    shift
  done
  if [ "${DUNE_ADMIN_DRY_RUN:-0}" = "1" ]; then
    dry_run=1
  fi

  [ -n "$target" ] || { echo "Usage: dune admin kick <player-fls-id> [--dry-run] [--yes] [--force] [--label <name>]" >&2; exit 2; }
  if [ "$target" = "*" ] && [ "$all_online" != "1" ]; then
    echo "Use --all-online to target PlayerId='*'." >&2
    exit 2
  fi

  if [ "$all_online" = "1" ]; then
    resolved_target="*"
    audit_target="*"
    friendly_label="${friendly_label:-All online players}"
    echo "Target: all players the server considers online (PlayerId='*')."
    echo "WARNING: this publishes a kick command for all online players."
    if [ "$assume_yes" != "1" ] && [ "$dry_run" != "1" ]; then
      read -r -p "Type KICK ALL ONLINE PLAYERS to continue: " answer
      [ "$answer" = "KICK ALL ONLINE PLAYERS" ] || { echo "Cancelled."; exit 1; }
    fi
  else
    resolved_target="$(resolve_player_id "$target")"
    audit_target="$(redact_fls "$resolved_target")"
    friendly_label="${friendly_label:-KickPlayer}"
    set +e
    row="$(player_status_for_fls "$resolved_target")"
    status_rc=$?
    set -e
    if [ "$status_rc" -eq 2 ]; then
      echo "WARNING: Postgres is unavailable, so target player validation was skipped."
      [ "$force" = "1" ] || [ "$dry_run" = "1" ] || exit 1
    elif [ -z "$row" ]; then
      echo "WARNING: target was not found in local accounts: $(redact_fls "$resolved_target")"
      [ "$force" = "1" ] || echo "Use --force if you still want to publish to RabbitMQ."
      [ "$force" = "1" ] || [ "$dry_run" = "1" ] || exit 1
    else
      IFS='|' read -r status map <<< "$row"
      echo "Target: $(redact_fls "$resolved_target") status=${status:-Unknown} map=${map:-unknown}"
      if [ "${status:-Offline}" = "Offline" ] && [ "$force" != "1" ] && [ "$dry_run" != "1" ]; then
        echo "Refusing to kick an offline player without --force."
        exit 1
      fi
    fi
    if [ "$assume_yes" != "1" ] && [ "$dry_run" != "1" ]; then
      read -r -p "Publish KickPlayer for $(redact_fls "$resolved_target")? [y/N]: " answer
      case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 1 ;; esac
    fi
  fi

  inner_json="$(build_kick_json "$resolved_target")"
  echo "Command path: $ADMIN_COMMAND_PATH"
  echo "Payload shape:"
  python3 - "$inner_json" <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
if payload.get("PlayerId") != "*":
    payload["PlayerId"] = "<redacted>"
print(json.dumps(payload, separators=(",", ":")))
PY

  if [ "$dry_run" = "1" ]; then
    echo "Dry run: not publishing."
    audit_admin_action "KickPlayer" "$audit_target" "$friendly_label" "$inner_json" "$ADMIN_COMMAND_PATH" "dry-run"
    return 0
  fi

  set +e
  output="$(publish_inner_json "$inner_json" "kick-player" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$output" >&2
    error_text="$(printf '%s' "$output" | tail -n 4 | tr '\n' ' ')"
    audit_admin_action "KickPlayer" "$audit_target" "$friendly_label" "$inner_json" "$ADMIN_COMMAND_PATH" "failed" "$error_text"
    exit "$rc"
  fi
  printf '%s\n' "$output"
  result="published"
  audit_admin_action "KickPlayer" "$audit_target" "$friendly_label" "$inner_json" "$ADMIN_COMMAND_PATH" "$result"
  echo "KickPlayer command accepted by $ADMIN_COMMAND_PATH. This means the command was queued, not that disconnection was verified."
}

grant_item() {
  local mode="$1"
  local player_id="${2:-}"
  local item_value="${3:-}"
  local quantity="${4:-1}"
  local durability="${5:-1.0}"
  local quality="${6:-0}"
  local original_player_id item_json item_id item_name item_category item_source inner_json
  local verify_account_id before_count after_count
  local status_row status_rc online_status online_map error_text

  if [ -z "$player_id" ] || [ -z "$item_value" ]; then
    usage >&2
    exit 1
  fi

  require_items_file
  validate_quantity "$quantity"
  validate_durability "$durability"
  validate_quality "$quality"

  original_player_id="$player_id"
  player_id="$(resolve_player_id "$player_id")"
  item_json="$(resolve_item "$mode" "$item_value")"
  item_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$item_json")"
  item_name="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["name"])' "$item_json")"
  item_category="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["category"])' "$item_json")"
  item_source="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["source"])' "$item_json")"

  inner_json="$(build_inner_json "$player_id" "$item_id" "$quantity" "$durability" "$quality")"

  echo "Grant item:"
  if [ "$original_player_id" != "$player_id" ]; then
    echo "  Player: $original_player_id"
    echo "  Resolved PlayerId: $player_id"
  else
    echo "  Player: $player_id"
  fi
  echo "  Item: $item_name"
  echo "  Category: $(display_category "$item_category")"
  echo "  Source: $item_source"
  echo "  Resolved id: $item_id"
  echo "  Quantity: $quantity"
  echo "  Durability: $durability"
  echo "  Grade: $quality"

  if [ "${DUNE_ADMIN_DRY_RUN:-0}" = "1" ]; then
    echo
    echo "Dry run: not publishing to RabbitMQ."
    echo "Inner JSON:"
    printf '%s\n' "$inner_json"
    audit_admin_action "AddItemToInventory" "$(redact_fls "$player_id")" "$item_name x$quantity" "$inner_json" "$ADMIN_COMMAND_PATH" "dry-run"
    return 0
  fi

  echo
  set +e
  status_row="$(player_status_for_fls "$player_id")"
  status_rc=$?
  set -e
  if [ "$status_rc" -eq 2 ]; then
    error_text="Cannot verify whether the player is online because Postgres is unavailable."
    echo "$error_text" >&2
    audit_admin_action "AddItemToInventory" "$(redact_fls "$player_id")" "$item_name x$quantity" "$inner_json" "$ADMIN_COMMAND_PATH" "failed" "$error_text"
    exit 1
  fi
  if [ -z "$status_row" ]; then
    error_text="Cannot verify whether the player is online. Item grants require an online player."
    echo "$error_text" >&2
    audit_admin_action "AddItemToInventory" "$(redact_fls "$player_id")" "$item_name x$quantity" "$inner_json" "$ADMIN_COMMAND_PATH" "failed" "$error_text"
    exit 1
  fi
  IFS='|' read -r online_status online_map <<< "$status_row"
  echo "  Player status: ${online_status:-Unknown}"
  echo "  Player map: ${online_map:-unknown}"
  if ! printf '%s' "${online_status:-Offline}" | grep -Eiq '^online$'; then
    error_text="Player is ${online_status:-Offline}."
    echo "$error_text" >&2
    audit_admin_action "AddItemToInventory" "$(redact_fls "$player_id")" "$item_name x$quantity" "$inner_json" "$ADMIN_COMMAND_PATH" "failed" "$error_text"
    exit 1
  fi

  require_token_file
  verify_account_id="$(account_id_for_player_id "$player_id")"
  before_count="$(player_item_stack_count "$verify_account_id" "$item_id")"
  if ! publish_inner_json "$inner_json" "grant-item"; then
    audit_admin_action "AddItemToInventory" "$(redact_fls "$player_id")" "$item_name x$quantity" "$inner_json" "$ADMIN_COMMAND_PATH" "failed" "RabbitMQ publish failed"
    exit 1
  fi
  audit_admin_action "AddItemToInventory" "$(redact_fls "$player_id")" "$item_name x$quantity" "$inner_json" "$ADMIN_COMMAND_PATH" "published"
  after_count="$(player_item_stack_count "$verify_account_id" "$item_id")"
  if [ -n "${before_count:-}" ] && [ -n "${after_count:-}" ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ "$after_count" -gt "$before_count" ] && break
      sleep 1
      after_count="$(player_item_stack_count "$verify_account_id" "$item_id")"
      [ -n "${after_count:-}" ] || break
    done
  fi
  echo "Grant item command published."

  if [ -n "${before_count:-}" ] && [ -n "${after_count:-}" ]; then
    if [ "$after_count" -gt "$before_count" ]; then
      echo "Verified inventory stack increased: $item_name ($before_count -> $after_count)."
    else
      echo "WARNING: publish succeeded, but the player's inventory stack did not increase for $item_name." >&2
      echo "The game server may reject this template for AddItemToInventory, or the player may need to relog/refresh inventory." >&2
    fi
  fi
}

template_scout_ornithopter_mk6_components() {
  cat <<'EOF'
OrnithopterLightChassis_6	1
OrnithopterLightHullFront_6	1
OrnithopterLightEngine_6	1
OrnithopterLightGenerator_6	1
OrnithopterLightHullBack_6	1
OrnithopterLightLocomotion_6	4
OrnithopterLightBoost_6	1
OrnithopterLightInventory_4	1
FuelCanister_Large	5
RepairTool5	1
EOF
}

grant_template() {
  local player_id="${1:-}"
  local template_name="${2:-}"
  local original_player_id verify_account_id
  local item_id quantity item_json item_name item_category item_source inner_json
  local before_count after_count expected_count
  local failures=0
  local work_file

  if [ -z "$player_id" ] || [ -z "$template_name" ]; then
    usage >&2
    exit 1
  fi

  case "${template_name,,}" in
    scout-ornithopter-mk6|"scout ornithopter mk6")
      ;;
    *)
      echo "Unknown admin item template: $template_name" >&2
      echo "Available templates: scout-ornithopter-mk6" >&2
      exit 1
      ;;
  esac

  require_items_file

  original_player_id="$player_id"
  player_id="$(resolve_player_id "$player_id")"

  echo "Grant template:"
  if [ "$original_player_id" != "$player_id" ]; then
    echo "  Player: $original_player_id"
    echo "  Resolved PlayerId: $player_id"
  else
    echo "  Player: $player_id"
  fi
  echo "  Template: Scout Ornithopter Mk6"
  echo "  Components:"

  while IFS=$'\t' read -r item_id quantity; do
    item_json="$(resolve_item "id" "$item_id")"
    item_name="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["name"])' "$item_json")"
    item_category="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["category"])' "$item_json")"
    item_source="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["source"])' "$item_json")"
    printf '  %sx %s (%s / %s, id: %s)\n' "$quantity" "$item_name" "$(display_category "$item_category")" "$item_source" "$item_id"
  done < <(template_scout_ornithopter_mk6_components)

  if [ "${DUNE_ADMIN_DRY_RUN:-0}" = "1" ]; then
    echo
    echo "Dry run: not publishing to RabbitMQ."
    echo "Inner JSON commands:"
    while IFS=$'\t' read -r item_id quantity; do
      inner_json="$(build_inner_json "$player_id" "$item_id" "$quantity" "1.0")"
      printf '%s\n' "$inner_json"
    done < <(template_scout_ornithopter_mk6_components)
    return 0
  fi

  echo
  require_token_file
  verify_account_id="$(account_id_for_player_id "$player_id")"
  work_file="$(mktemp)"
  trap 'rm -f "$work_file"' RETURN

  while IFS=$'\t' read -r item_id quantity; do
    item_json="$(resolve_item "id" "$item_id")"
    item_name="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["name"])' "$item_json")"
    before_count="$(player_item_stack_count "$verify_account_id" "$item_id")"
    printf '%s\t%s\t%s\t%s\n' "$item_id" "$quantity" "${before_count:-}" "$item_name" >> "$work_file"
  done < <(template_scout_ornithopter_mk6_components)

  echo "Publishing template component grants..."
  while IFS=$'\t' read -r item_id quantity before_count item_name; do
    inner_json="$(build_inner_json "$player_id" "$item_id" "$quantity" "1.0")"
    publish_inner_json "$inner_json" "grant-item" >/dev/null
  done < "$work_file"
  echo "Published all Scout Ornithopter Mk6 component grants."
  audit_admin_action "GrantTemplate" "$(redact_fls "$player_id")" "Scout Ornithopter Mk6" '{"Template":"scout-ornithopter-mk6"}' "$ADMIN_COMMAND_PATH" "published"

  echo "Verifying inventory changes..."
  sleep 1
  while IFS=$'\t' read -r item_id quantity before_count item_name; do
    [ -n "${before_count:-}" ] || continue
    after_count="$(player_item_stack_count "$verify_account_id" "$item_id")"
    [ -n "${after_count:-}" ] || continue
    expected_count=$((before_count + quantity))
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ "$after_count" -ge "$expected_count" ] && break
      sleep 1
      after_count="$(player_item_stack_count "$verify_account_id" "$item_id")"
      [ -n "${after_count:-}" ] || break
    done
    if [ "$after_count" -ge "$expected_count" ]; then
      echo "Verified: $item_name ($before_count -> $after_count)."
    else
      failures=$((failures + 1))
      echo "WARNING: published $item_name, but inventory count did not reach expected value ($before_count -> $after_count, expected at least $expected_count)." >&2
    fi
  done < "$work_file"

  if [ "$failures" -ne 0 ]; then
    echo "Template grant completed with $failures verification warning(s)." >&2
    exit 1
  fi
  echo "Template grant completed: Scout Ornithopter Mk6."
}

publish_player_command() {
  local command_id="$1"
  local player_id="$2"
  local destructive="${3:-0}"
  shift 3
  local resolved_player inner_json answer audit_target output rc result error_text status_row status map require_online=0

  [ -n "$player_id" ] || { echo "PlayerId is required." >&2; exit 2; }
  resolved_player="$(resolve_player_id "$player_id")"
  audit_target="$resolved_player"
  [ "$audit_target" = "*" ] || audit_target="$(redact_fls "$audit_target")"

  if [ "${DUNE_ADMIN_ASSUME_YES:-0}" = "1" ]; then
    :
  elif [ "$destructive" = "1" ]; then
    echo "WARNING: $command_id is destructive for target $audit_target."
    read -r -p "Type CONFIRM to continue: " answer
    [ "$answer" = "CONFIRM" ] || { echo "Cancelled."; exit 1; }
  else
    read -r -p "Publish $command_id for $audit_target? [y/N]: " answer
    case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 1 ;; esac
  fi

  inner_json="$(build_passthrough_json "$command_id" "PlayerId=$resolved_player=string" "$@")"
  case "$command_id" in
    AwardXP|UpdateAllWaterFillables) require_online=1 ;;
  esac

  if [ "${DUNE_ADMIN_DRY_RUN:-0}" = "1" ]; then
    echo "Payload shape:"
    python3 - "$inner_json" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
if payload.get("PlayerId") != "*":
    payload["PlayerId"] = "<redacted>"
print(json.dumps(payload, separators=(",", ":")))
PY
    echo "Dry run: not publishing."
    audit_admin_action "$command_id" "$audit_target" "$command_id" "$inner_json" "$ADMIN_COMMAND_PATH" "dry-run"
    return 0
  fi

  if [ "$resolved_player" != "*" ]; then
    set +e
    status_row="$(player_status_for_fls "$resolved_player")"
    rc=$?
    set -e
    if [ "$rc" -eq 2 ] && [ "$require_online" = "1" ]; then
      error_text="Cannot verify whether the player is online."
      echo "$error_text" >&2
      audit_admin_action "$command_id" "$audit_target" "$command_id" "$inner_json" "$ADMIN_COMMAND_PATH" "failed" "$error_text"
      exit 1
    fi
    if [ -n "$status_row" ]; then
      IFS='|' read -r status map <<< "$status_row"
      echo "Target state: status=${status:-Unknown} map=${map:-unknown}"
      if [ "$require_online" = "1" ] && ! printf '%s' "${status:-Offline}" | grep -Eiq '^online$'; then
        error_text="Player is ${status:-Offline}."
        echo "$error_text" >&2
        audit_admin_action "$command_id" "$audit_target" "$command_id" "$inner_json" "$ADMIN_COMMAND_PATH" "failed" "$error_text"
        exit 1
      fi
    elif [ "$require_online" = "1" ]; then
      error_text="Cannot verify whether the player is online."
      echo "$error_text" >&2
      audit_admin_action "$command_id" "$audit_target" "$command_id" "$inner_json" "$ADMIN_COMMAND_PATH" "failed" "$error_text"
      exit 1
    else
      echo "WARNING: target was not found in local player_state/accounts; publishing by FLS id anyway." >&2
    fi
  fi

  echo "Payload shape:"
  python3 - "$inner_json" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
if payload.get("PlayerId") != "*":
    payload["PlayerId"] = "<redacted>"
print(json.dumps(payload, separators=(",", ":")))
PY

  set +e
  output="$(publish_inner_json "$inner_json" "$command_id" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$output" >&2
    error_text="$(printf '%s' "$output" | tail -n 4 | tr '\n' ' ')"
    audit_admin_action "$command_id" "$audit_target" "$command_id" "$inner_json" "$ADMIN_COMMAND_PATH" "failed" "$error_text"
    exit "$rc"
  fi
  printf '%s\n' "$output"
  result="published"
  audit_admin_action "$command_id" "$audit_target" "$command_id" "$inner_json" "$ADMIN_COMMAND_PATH" "$result"
  echo "$command_id command accepted by $ADMIN_COMMAND_PATH."
}

player_location_command() {
  local target="${1:-}" row status map partition server x y z qx qy qz qw dimension actor_class
  [ -n "$target" ] || { echo "Usage: dune admin player-location <player-id>" >&2; exit 2; }
  target="$(resolve_player_id "$target")"
  row="$(player_position_for_fls "$target" || true)"
  [ -n "$row" ] || { echo "No player location found for $(redact_fls "$target")." >&2; exit 1; }
  IFS='|' read -r status map partition server x y z qx qy qz qw dimension actor_class <<< "$row"
  echo "Player: $(redact_fls "$target")"
  echo "Status: ${status:-Unknown}"
  echo "Map: ${map:-unknown}"
  echo "Partition: ${partition:-unknown}"
  echo "Server: ${server:-unknown}"
  echo "Location: X=${x:-unknown} Y=${y:-unknown} Z=${z:-unknown}"
  echo "Rotation quaternion: X=${qx:-unknown} Y=${qy:-unknown} Z=${qz:-unknown} W=${qw:-unknown}"
  echo "Dimension: ${dimension:-unknown}"
  echo "Actor: ${actor_class:-unknown}"
}

history_command() {
  local file="runtime/generated/admin-command-history.tsv"
  if [ ! -s "$file" ]; then
    echo "No admin command history found."
    return 0
  fi
  tail -n "${1:-50}" "$file"
}

award_xp_command() {
  local player="${1:-}" amount="${2:-}"
  [ -n "$player" ] && [ -n "$amount" ] || { echo "Usage: dune admin award-xp <player-id|*> <amount>" >&2; exit 2; }
  validate_int "$amount" "Experience"
  [ "$amount" -gt 0 ] || { echo "Experience must be positive." >&2; exit 1; }
  publish_player_command "AwardXP" "$player" 0 "Experience=$amount=int"
}

skill_points_command() {
  local player="${1:-}" points="${2:-}"
  [ -n "$player" ] && [ -n "$points" ] || { echo "Usage: dune admin skill-points <player-id|*> <points>" >&2; exit 2; }
  validate_int "$points" "SkillPoints"
  [ "$points" -ge 0 ] || { echo "SkillPoints must be zero or greater." >&2; exit 1; }
  publish_player_command "SkillsSetUnspentSkillPoints" "$player" 0 "SkillPoints=$points=int"
}

skill_module_command() {
  local player="${1:-}" module="${2:-}" level="${3:-}" module_json module_id module_name max_level
  [ -n "$player" ] && [ -n "$module" ] && [ -n "$level" ] || { echo "Usage: dune admin skill-module <player-id|*> <module> <level>" >&2; exit 2; }
  validate_int "$level" "Level"
  module_json="$(resolve_skill_module "$module")"
  module_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$module_json")"
  module_name="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("name",""))' "$module_json")"
  max_level="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("maxLevel",1))' "$module_json")"
  if [ "$level" -lt 0 ] || [ "$level" -gt "$max_level" ]; then
    echo "Level must be between 0 and $max_level for $module_name." >&2
    exit 1
  fi
  echo "Skill module: $module_name ($module_id), max level $max_level"
  publish_player_command "SkillsSetModuleLevel" "$player" 0 "Module=$module_id=string" "Level=$level=int"
}

refill_water_command() {
  local player="${1:-}" amount="${2:-1000000}"
  [ -n "$player" ] || { echo "Usage: dune admin refill-water <player-id|*> [amount]" >&2; exit 2; }
  validate_int "$amount" "WaterAmount"
  [ "$amount" -gt 0 ] || { echo "WaterAmount must be positive." >&2; exit 1; }
  publish_player_command "UpdateAllWaterFillables" "$player" 0 "WaterAmount=$amount=int"
}

clean_inventory_command() {
  local player="${1:-}"
  [ -n "$player" ] || { echo "Usage: dune admin clean-inventory <player-id|*>" >&2; exit 2; }
  publish_player_command "CleanPlayerInventory" "$player" 1
}

reset_progression_command() {
  local player="${1:-}"
  [ -n "$player" ] || { echo "Usage: dune admin reset-progression <player-id|*>" >&2; exit 2; }
  publish_player_command "ResetProgression" "$player" 1
}

teleport_command() {
  local player="${1:-}" x="${2:-}" y="${3:-}" z="${4:-}" yaw="${5:-}"
  [ -n "$player" ] && [ -n "$x" ] && [ -n "$y" ] && [ -n "$z" ] || { echo "Usage: dune admin teleport <player-id> <x> <y> <z> [yaw]" >&2; exit 2; }
  validate_float "$x" "X"; validate_float "$y" "Y"; validate_float "$z" "Z"
  local args=("X=$x=float" "Y=$y=float" "Z=$z=float")
  if [ -n "$yaw" ]; then validate_float "$yaw" "Yaw"; args+=("Yaw=$yaw=float"); fi
  publish_player_command "TeleportTo" "$player" 0 "${args[@]}"
}

spawn_vehicle_at_command() {
  local player="${1:-}" class_name="${2:-}" template="${3:-}" x="${4:-}" y="${5:-}" z="${6:-}" rotation="${7:-0}"
  local vehicle_json vehicle_id actor_class
  [ -n "$player" ] && [ -n "$class_name" ] && [ -n "$template" ] && [ -n "$x" ] && [ -n "$y" ] && [ -n "$z" ] || {
    echo "Usage: dune admin spawn-vehicle-at <player-id> <vehicle-id> <template-name> <x> <y> <z> [rotation]" >&2
    exit 2
  }
  validate_float "$x" "X"; validate_float "$y" "Y"; validate_float "$z" "Z"; validate_float "$rotation" "Rotation"
  vehicle_json="$(resolve_vehicle "$class_name" "$template")"
  vehicle_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$vehicle_json")"
  actor_class="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["actor_class"])' "$vehicle_json")"
  template="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["template"])' "$vehicle_json")"
  echo "Vehicle: $vehicle_id"
  echo "Actor class: $actor_class"
  echo "Template: $template"
  publish_player_command "SpawnVehicleAt" "$player" 0 \
    "ClassName=$vehicle_id=string" "TemplateName=$template=string" \
    "X=$x=float" "Y=$y=float" "Z=$z=float" "Rotation=$rotation=float" "Persistent=1.0=float"
}

spawn_vehicle_command() {
  local player="${1:-}" class_name="${2:-}" template="${3:-}" offset="${4:-1000}"
  local resolved_player row status map partition server x y z qx qy qz qw dimension actor_class spawn_json sx sy sz rotation
  local vehicle_json vehicle_id vehicle_actor_class z_offset=0 original_offset
  [ -n "$player" ] && [ -n "$class_name" ] && [ -n "$template" ] || {
    echo "Usage: dune admin spawn-vehicle <player-id> <vehicle-id> <template-name> [offset-units]" >&2
    echo "Use spawn-vehicle-at for advanced manual coordinates." >&2
    exit 2
  }
  validate_float "$offset" "Offset"
  original_offset="$offset"
  vehicle_json="$(resolve_vehicle "$class_name" "$template")"
  vehicle_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$vehicle_json")"
  vehicle_actor_class="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["actor_class"])' "$vehicle_json")"
  template="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["template"])' "$vehicle_json")"
  if is_flying_vehicle "$vehicle_id" "$vehicle_actor_class"; then
    z_offset="${DUNE_ADMIN_FLYING_VEHICLE_Z_OFFSET:-700}"
    offset="$(python3 - "$offset" "${DUNE_ADMIN_FLYING_VEHICLE_MIN_OFFSET:-3000}" <<'PY'
import sys
offset = float(sys.argv[1])
minimum = float(sys.argv[2])
print(max(offset, minimum))
PY
)"
  fi
  resolved_player="$(resolve_player_id "$player")"
  [ "$resolved_player" != "*" ] || { echo "Vehicle spawn requires a specific player." >&2; exit 2; }
  row="$(player_position_for_fls "$resolved_player" || true)"
  if [ -z "$row" ]; then
    echo "No live pawn location found for $(redact_fls "$resolved_player")." >&2
    echo "Vehicle spawn-in-front requires the player to be online with player_state.player_pawn_id and actors.transform available." >&2
    exit 1
  fi
  IFS='|' read -r status map partition server x y z qx qy qz qw dimension actor_class <<< "$row"
  for value in "$x" "$y" "$z" "$qx" "$qy" "$qz" "$qw"; do
    [ -n "$value" ] || { echo "Live location/facing is incomplete for $(redact_fls "$resolved_player")." >&2; exit 1; }
  done
  spawn_json="$(compute_spawn_in_front "$x" "$y" "$z" "$qx" "$qy" "$qz" "$qw" "$offset" "$z_offset")"
  sx="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["x"])' "$spawn_json")"
  sy="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["y"])' "$spawn_json")"
  sz="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["z"])' "$spawn_json")"
  rotation="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["rotation"])' "$spawn_json")"
  echo "Player location: map=${map:-unknown} partition=${partition:-unknown} X=$x Y=$y Z=$z"
  if [ "$z_offset" != "0" ] || [ "$offset" != "$original_offset" ]; then
    echo "Flying vehicle adjustment: offset=$offset units, Z lift=$z_offset units"
  fi
  echo "Computed spawn point $offset units in front: X=$sx Y=$sy Z=$sz Rotation=$rotation"
  spawn_vehicle_at_command "$resolved_player" "$vehicle_id" "$template" "$sx" "$sy" "$sz" "$rotation"
}

broadcast_restart_warning_command() {
  local minutes="${1:-}"
  [ -n "$minutes" ] || { echo "Usage: dune admin broadcast-restart-warning <minutes>" >&2; exit 2; }
  validate_int "$minutes" "Minutes"
  if [ "$minutes" -lt 1 ] || [ "$minutes" -gt 1440 ]; then
    echo "Minutes must be between 1 and 1440." >&2
    exit 2
  fi
  local inner_json
  inner_json="$(build_restart_warning_json "$minutes")"
  publish_inner_json "$inner_json" "restart-warning"
  audit_admin_action "ServiceBroadcast" "all" "Server Restart Incoming" "$inner_json" "$ADMIN_COMMAND_PATH" "published"
}

unsupported_command() {
  cat <<'EOF'
Unsupported upstream admin actions in this Docker port:

- Journey / quest / tag progression commands are not exposed. The inspected upstream
  service removed JourneyCompleteJourneyEntry because it publishes successfully but
  produces no observable player-state change.
- AwardXPByEventTag is not exposed because the inspected command path has no verified
  server-side handler in this stack.
- CheatScript and ServerExec are not exposed because the inspected upstream service
  marks them as live-tested no-ops.
- Direct specialization track edits are exposed as specialization-xp/specialization-max
  database admin tools. They update PostgreSQL directly and create a backup before writes.

Implemented tools use the same Docker-native RabbitMQ admin command path as item
grants and write audit history to runtime/generated/admin-command-history.tsv.
Detailed JSONL audit records are written to runtime/generated/admin-command-audit.jsonl.
EOF
}

cmd="${1:-help}"
case "$cmd" in
  players)
    shift || true
    players_command "$@"
    ;;
  login-queues)
    shift || true
    login_queues_command "$@"
    ;;
  repair-login-queue)
    shift || true
    repair_login_queue_command "$@"
    ;;
  kick)
    shift || true
    kick_command "$@"
    ;;
  item-search)
    shift || true
    item_search "${1:-}"
    ;;
  item-list)
    shift || true
    item_list "${1:-}"
    ;;
  grant-item)
    shift || true
    grant_item "name" "$@"
    ;;
  grant-item-id)
    shift || true
    grant_item "id" "$@"
    ;;
  grant-template)
    shift || true
    grant_template "$@"
    ;;
  player-location)
    shift || true
    player_location_command "$@"
    ;;
  award-xp)
    shift || true
    award_xp_command "$@"
    ;;
  skill-points)
    shift || true
    skill_points_command "$@"
    ;;
  skill-module)
    shift || true
    skill_module_command "$@"
    ;;
  skill-modules)
    shift || true
    skill_modules_command "${1:-}"
    ;;
  specialization-xp)
    shift || true
    specialization_xp_command "$@"
    ;;
  specialization-max)
    shift || true
    specialization_max_command "$@"
    ;;
  refill-water)
    shift || true
    refill_water_command "$@"
    ;;
  clean-inventory)
    shift || true
    clean_inventory_command "$@"
    ;;
  reset-progression)
    shift || true
    reset_progression_command "$@"
    ;;
  teleport)
    shift || true
    teleport_command "$@"
    ;;
  spawn-vehicle)
    shift || true
    spawn_vehicle_command "$@"
    ;;
  spawn-vehicle-at)
    shift || true
    spawn_vehicle_at_command "$@"
    ;;
  broadcast-restart-warning)
    shift || true
    broadcast_restart_warning_command "$@"
    ;;
  vehicle-list)
    shift || true
    vehicle_list_command "${1:-}"
    ;;
  unsupported)
    shift || true
    unsupported_command
    ;;
  history)
    shift || true
    history_command "${1:-50}"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown admin command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac
