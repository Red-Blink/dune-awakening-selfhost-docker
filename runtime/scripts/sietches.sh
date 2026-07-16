#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

PARTITION_CATALOG="runtime/generated/partition-catalog.json"
SERVER_CATALOG="runtime/generated/server-catalog.json"
CONFIG_FILE="runtime/generated/sietch-config.json"
LIFECYCLE_LOG="runtime/generated/sietch-lifecycle.log"

set_config_permissions() {
  # The web console may invoke this script from a container user such as
  # nobody. Keep generated state readable by the host/admin user after writes.
  chmod a+r "$CONFIG_FILE" 2>/dev/null || true
  chmod u+w "$CONFIG_FILE" 2>/dev/null || true
}

log_sietch_lifecycle() {
  local operation="$1"
  local detail="${2:-}"
  mkdir -p "$(dirname "$LIFECYCLE_LOG")"
  printf '%s\t%s\t%s\n' "$(date -Iseconds)" "$operation" "$detail" >>"$LIFECYCLE_LOG"
}

normalize_config_defaults() {
  python3 - "$CONFIG_FILE" <<'PY'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
if not config_path.exists():
    raise SystemExit

config = json.loads(config_path.read_text())
maps_cfg = config.setdefault("maps", {})
changed = False

for map_name in ("Survival_1", "DeepDesert_1"):
    entry = maps_cfg.setdefault(map_name, {})
    explicit = entry.get("active_dimensions_explicit")
    if explicit is None:
        entry["active_dimensions_explicit"] = False
        explicit = False
        changed = True

    explicit = str(explicit).strip().lower() in {"1", "true", "yes", "on"}
    # Do not downgrade an already-expanded Survival_1/DeepDesert_1 topology during
    # passive sync/validation. Only explicit set-active should change the target.
    if not explicit and "active_dimensions" in entry and int(entry.get("active_dimensions") or 1) < 1:
        entry["active_dimensions"] = 1
        changed = True

if changed:
    config_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n")
PY
  set_config_permissions
}

sync_sietch_config_from_db() {
  local operation="${1:-sync}"
  local db_rows=""
  local db_json=""

  if docker_postgres_running; then
    db_rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "
      select partition_id,
             map,
             dimension_index,
             coalesce(label, ''),
             blocked,
             coalesce(server_id, '')
      from dune.world_partition
      order by map, dimension_index, partition_id;
    " 2>/dev/null || true)"
    if [ -n "$db_rows" ]; then
      db_json="$(SIETCH_DB_ROWS="$db_rows" python3 -c '
import json
import os
rows = []
for line in os.environ.get("SIETCH_DB_ROWS", "").splitlines():
    parts = line.split("\t")
    if len(parts) < 6:
        continue
    partition_id, map_name, dimension, label, blocked, server_id = parts[:6]
    try:
        rows.append({
            "id": int(partition_id),
            "map": map_name,
            "dimension": int(dimension or 0),
            "label": label,
            "blocked": blocked.lower() in ("t", "true", "1", "yes"),
            "server_id": server_id,
        })
    except ValueError:
        continue
print(json.dumps(rows, separators=(",", ":")))
' 2>/dev/null || true)"
    fi
  fi

  SIETCH_DB_ROWS_JSON="$db_json" python3 - "$CONFIG_FILE" "$PARTITION_CATALOG" "$operation" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

config_path = Path(sys.argv[1])
catalog_path = Path(sys.argv[2])
operation = sys.argv[3]

if config_path.exists():
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        config = {}
else:
    config = {}

config.setdefault("maps", {})
partitions_cfg = config.setdefault("partitions", {})

db_raw = os.environ.get("SIETCH_DB_ROWS_JSON", "")
if not db_raw:
    db_raw = os.environ.get("SIETCH_DB_PARTITIONS_JSON", "")

rows = []
if db_raw:
    try:
        rows = json.loads(db_raw)
    except Exception:
        rows = []
elif catalog_path.exists():
    try:
        rows = json.loads(catalog_path.read_text(encoding="utf-8"))
    except Exception:
        rows = []

rows = [
    row for row in rows
    if row.get("id") is not None and row.get("map") and row.get("dimension") is not None
]
rows.sort(key=lambda row: (str(row.get("map")), int(row.get("dimension") or 0), int(row.get("id") or 0)))

by_id = {str(row["id"]): row for row in rows}
by_map_dim = {}
for row in rows:
    by_map_dim[(str(row["map"]), str(int(row.get("dimension") or 0)))] = row

changed = False
events = []

def meaningful(entry):
    return {
        key: value for key, value in dict(entry or {}).items()
        if key in {"display_name", "password"} and value not in ("", None)
    }

def merge_user_state(dest, src):
    global changed
    for key, value in meaningful(src).items():
        if dest.get(key) != value:
            dest[key] = value
            changed = True

def default_display_name(map_name, label):
    label = str(label or "").strip()
    if not label:
        return ""
    if str(map_name) != "Survival_1":
        return ""
    return label if label.lower().startswith("sietch ") else f"Sietch {label}"

def profile_partition_engine_values():
    values = {}
    profile_path = Path("runtime/generated/gameplay-profile.ini")
    if not profile_path.exists():
        return values
    current = None
    try:
        lines = profile_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith((";", "#")):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = None
            header = line[1:-1]
            parts = header.split(":")
            if len(parts) == 4 and parts[0] == "Partition" and parts[1] == "Survival_1" and parts[3] == "ConsoleVariables":
                current = parts[2]
                values.setdefault(current, {})
            continue
        if current and "=" in line:
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"')
            if key == "Bgd.ServerDisplayName" and value:
                values.setdefault(current, {})["display_name"] = value
            elif key == "Bgd.ServerLoginPassword" and value:
                values.setdefault(current, {})["password"] = value
    return values

profile_engine_values = profile_partition_engine_values()

now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

# First, copy existing partition-scoped user values into stable map/dimension slots.
for partition_id, entry in list(partitions_cfg.items()):
    user_state = meaningful(entry)
    if not user_state:
        continue
    row = by_id.get(str(partition_id))
    map_name = entry.get("map")
    dimension = entry.get("dimension")
    if row:
        map_name = str(row.get("map"))
        dimension = int(row.get("dimension") or 0)
    elif map_name is not None and dimension is not None:
        map_name = str(map_name)
        dimension = int(dimension)
    else:
        orphaned = config.setdefault("orphaned_partition_user_state", {})
        if orphaned.get(str(partition_id)) != user_state:
            orphaned[str(partition_id)] = dict(user_state, preserved_at=now)
            events.append(f"preserved orphan partition={partition_id}")
            changed = True
        continue

    map_entry = config.setdefault("maps", {}).setdefault(map_name, {})
    dim_entry = map_entry.setdefault("dimensions", {}).setdefault(str(dimension), {})
    before = dict(dim_entry)
    merge_user_state(dim_entry, user_state)

for partition_id, user_state in profile_engine_values.items():
    row = by_id.get(str(partition_id))
    if not row or str(row.get("map")) != "Survival_1":
        continue
    entry = partitions_cfg.setdefault(str(partition_id), {})
    merge_user_state(entry, user_state)
    dimension = str(int(row.get("dimension") or 0))
    dim_entry = config.setdefault("maps", {}).setdefault("Survival_1", {}).setdefault("dimensions", {}).setdefault(dimension, {})
    before = dict(dim_entry)
    merge_user_state(dim_entry, user_state)
    if dim_entry != before:
        events.append(f"copied profile partition={partition_id} to Survival_1 dimension={dimension}")

# Then mirror dimension-scoped state back to current partition IDs and prune stale IDs.
new_partitions = {}
for row in rows:
    partition_id = str(row["id"])
    map_name = str(row["map"])
    dimension = str(int(row.get("dimension") or 0))
    label = str(row.get("label") or "")
    map_entry = config.setdefault("maps", {}).setdefault(map_name, {})
    dim_entry = map_entry.setdefault("dimensions", {}).setdefault(dimension, {})
    old_entry = partitions_cfg.get(partition_id, {})

    # Current partition values win if a user just edited this partition directly.
    merge_user_state(dim_entry, old_entry)

    mirrored = {
        "map": map_name,
        "dimension": int(dimension),
    }
    mirrored.update(meaningful(dim_entry))
    derived_display = default_display_name(map_name, label)
    if label:
        mirrored["label"] = label
    new_partitions[partition_id] = mirrored

for old_id, old_entry in partitions_cfg.items():
    if old_id not in new_partitions:
        user_state = meaningful(old_entry)
        if user_state:
            map_name = old_entry.get("map")
            dimension = old_entry.get("dimension")
            if map_name is not None and dimension is not None:
                dim_entry = config.setdefault("maps", {}).setdefault(str(map_name), {}).setdefault("dimensions", {}).setdefault(str(int(dimension)), {})
                merge_user_state(dim_entry, user_state)
                events.append(f"removed stale partition={old_id}; preserved on {map_name} dimension={dimension}")
            else:
                orphaned = config.setdefault("orphaned_partition_user_state", {})
                orphaned[str(old_id)] = dict(user_state, preserved_at=now)
                events.append(f"removed stale partition={old_id}; preserved as orphan")
        else:
            events.append(f"removed stale partition={old_id}")

if new_partitions != partitions_cfg:
    config["partitions"] = new_partitions
    changed = True

if events:
    config["last_sietch_sync"] = {
        "operation": operation,
        "updated_at": now,
        "events": events[-25:],
    }
    changed = True

if changed:
    tmp = config_path.with_name(f".{config_path.name}.tmp.{os.getpid()}")
    tmp.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(config_path)

print(json.dumps({"changed": changed, "events": events}, separators=(",", ":")))
PY
  set_config_permissions
}

map_supports_configurable_active_dimensions() {
  case "$1" in
    Survival_1|DeepDesert_1) return 0 ;;
    *) return 1 ;;
  esac
}

prune_orphan_partition_config() {
  local summary
  summary="$(sync_sietch_config_from_db "ensure-config" || true)"
  if printf '%s' "$summary" | grep -q '"changed":true'; then
    log_sietch_lifecycle "sync_config" "$summary"
  fi
}

generate_partition_catalog_from_server_catalog() {
  [ -s "$SERVER_CATALOG" ] || return 1

  mkdir -p runtime/generated
  python3 - "$SERVER_CATALOG" "$PARTITION_CATALOG" <<'PY'
import json
import os
import sys
from pathlib import Path

server_path = Path(sys.argv[1])
partition_path = Path(sys.argv[2])
servers = json.loads(server_path.read_text())
rows = []

for server in servers:
    map_name = str(server.get("map", ""))
    raw = server.get("raw", {}) or {}
    partitions = raw.get("partitions") or []
    for dim, partition_id in enumerate(partitions):
        try:
            rows.append({
                "id": int(partition_id),
                "map": map_name,
                "dimension": dim,
                "label": "",
                "disable": False,
            })
        except (TypeError, ValueError):
            continue

partition_path.write_text(json.dumps(rows, indent=2) + "\n")
PY
}

usage() {
  cat <<'EOF'
Usage:
  dune sietches
  dune sietches list
  dune sietches show <map-name>
  dune sietches dimensions <map-name> [--active-only] [--numbered|--labels|--ids|--partition-at=N]
  dune sietches set-max <map-name> <count>
  dune sietches set-active <map-name> <count>
  dune sietches set-display <partition-id> <display-name>
  dune sietches set-password <partition-id> [password]
  dune sietches set-settings <partition-id> <display-name> <password>
  dune sietches sync
  dune sietches validate
  dune sietches reconcile <map-name>
  dune sietches runtime-args <map-name> <partition-id>

Sietch data comes from the live world_partition table when Postgres is running,
falling back to the generated world partition catalog.
Passwords are stored locally and are never printed by status commands.
EOF
}

require_catalog() {
  if [ ! -s "$PARTITION_CATALOG" ] && [ -s "$SERVER_CATALOG" ]; then
    generate_partition_catalog_from_server_catalog || true
  fi

  if [ ! -s "$PARTITION_CATALOG" ] && [ ! -s "$SERVER_CATALOG" ]; then
    echo "Map catalog not found. Run dune init first, or regenerate world partitions."
    echo "Expected one of:"
    echo "  $PARTITION_CATALOG"
    echo "  $SERVER_CATALOG"
    exit 1
  fi
}

ensure_config() {
  local content tmp

  mkdir -p runtime/generated
  if [ ! -f "$CONFIG_FILE" ]; then
    printf '{\n  "maps": {},\n  "partitions": {}\n}\n' > "$CONFIG_FILE"
  fi

  if [ ! -r "$CONFIG_FILE" ] || [ ! -w "$CONFIG_FILE" ]; then
    content='{
  "maps": {},
  "partitions": {}
}
'
    if [ -r "$CONFIG_FILE" ]; then
      content="$(cat "$CONFIG_FILE")"
      case "$content" in
        *$'\n') ;;
        *) content="${content}"$'\n' ;;
      esac
    fi

    tmp="${CONFIG_FILE}.tmp.$$"
    printf '%s' "$content" > "$tmp"
    mv -f "$tmp" "$CONFIG_FILE"
  fi

  normalize_config_defaults
  prune_orphan_partition_config
  set_config_permissions
}

validate_positive_integer() {
  printf '%s' "$1" | grep -Eq '^[1-9][0-9]*$'
}

sanitize_positive_integer_arg() {
  printf '%s' "$1" | tr -d '[:cntrl:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

docker_postgres_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres
}

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "$1"
}

python_common() {
  local db_rows=""
  local db_json=""

  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
    db_rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "
      select partition_id, map, dimension_index, coalesce(label, ''), blocked, coalesce(server_id, '')
      from dune.world_partition
      order by partition_id;
    " 2>/dev/null || true)"
    if [ -n "$db_rows" ]; then
      db_json="$(SIETCH_DB_ROWS="$db_rows" python3 -c '
import json
import os
rows = []
for line in os.environ.get("SIETCH_DB_ROWS", "").splitlines():
    parts = line.split("\t")
    if len(parts) < 6:
        continue
    partition_id, map_name, dimension, label, blocked, server_id = parts[:6]
    try:
        rows.append({
            "id": int(partition_id),
            "map": map_name,
            "dimension": int(dimension or 0),
            "label": label,
            "disable": blocked.lower() in ("t", "true", "1", "yes"),
            "server_id": server_id,
        })
    except ValueError:
        continue
print(json.dumps(rows))
' 2>/dev/null || true)"
    fi
  fi

  SIETCH_DB_PARTITIONS_JSON="$db_json" python3 - "$PARTITION_CATALOG" "$SERVER_CATALOG" "$CONFIG_FILE" "$@"
}

list_sietches() {
  local mode="${1:-table}"

  require_catalog
  ensure_config
  python_common "$mode" <<'PY'
import json
import os
import sys
from pathlib import Path

partition_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])
config_path = Path(sys.argv[3])
mode = sys.argv[4]

db_partitions = os.environ.get("SIETCH_DB_PARTITIONS_JSON")
partitions = json.loads(db_partitions) if db_partitions else json.loads(partition_path.read_text())
servers = json.loads(server_path.read_text()) if server_path.exists() and server_path.stat().st_size > 0 else []
config = json.loads(config_path.read_text()) if config_path.exists() else {"maps": {}, "partitions": {}}

env = {}
env_path = Path(".env")
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key] = value.strip().strip('"')

server_by_map = {str(server.get("map", "")): server for server in servers if server.get("map")}

def env_key(name):
    normalized = "".join(ch if ch.isalnum() else "_" for ch in name.upper())
    while "__" in normalized:
        normalized = normalized.replace("__", "_")
    return f"DUNE_MEMORY_{normalized.strip('_')}"

grouped = {}
order = []
for row in partitions:
    name = str(row.get("map", ""))
    if not name:
        continue
    if name not in grouped:
        grouped[name] = []
        order.append(name)
    grouped[name].append(row)

rows = []
for name in order:
    partition_rows = grouped[name]
    catalog_max = len(partition_rows)
    map_config = config.get("maps", {}).get(name, {})
    max_dimensions = int(map_config.get("max_dimensions") or catalog_max)
    raw = server_by_map.get(name, {}).get("raw", {})
    dedicated = bool(raw.get("dedicatedScaling"))
    if name == "Overmap":
        active_dimensions = "1"
        kind = "Always-On"
    elif dedicated and name != "DeepDesert_1":
        active_dimensions = "Managed"
        kind = "Dedicated Scaling"
    elif name == "Survival_1":
        active_dimensions = str(int(map_config.get("active_dimensions") or min(max_dimensions, catalog_max)))
        kind = "Always-On"
    elif name == "DeepDesert_1":
        active_dimensions = str(int(map_config.get("active_dimensions") or min(max_dimensions, catalog_max)))
        kind = "Dedicated Scaling"
    else:
        active_dimensions = str(int(map_config.get("active_dimensions") or min(max_dimensions, catalog_max)))
        kind = "Dynamic"

    configured_memory = env.get(env_key(name))
    catalog_memory = server_by_map.get(name, {}).get("resources", {}).get("limits", {}).get("memory", "")
    map_default_overrides = {
        "DLC_Story_LostHarvest_EcolabA": "2g",
        "DLC_Story_LostHarvest_EcolabB": "2g",
        "DLC_Story_LostHarvest_ForgottenLab": "2g",
    }
    memory = configured_memory or map_default_overrides.get(name) or catalog_memory or env.get("DUNE_MEMORY_DEFAULT") or "default"
    rows.append((name, str(max_dimensions), str(active_dimensions), memory, kind))

if mode == "--names":
    for row in rows:
        print(row[0])
elif mode == "--numbered":
    print(f"{'#':>3}  {'MAP':<28} {'MAX DIMENSIONS':<14} {'ACTIVE DIMENSIONS':<18} {'MEMORY':<10} TYPE")
    for idx, (name, max_dimensions, active_dimensions, memory, kind) in enumerate(rows, 1):
        print(f"{idx:>3}  {name:<28} {max_dimensions:<14} {active_dimensions:<18} {memory:<10} {kind}")
elif mode.startswith("--map-at="):
    index = int(mode.split("=", 1)[1])
    if index < 1 or index > len(rows):
        raise SystemExit(1)
    print(rows[index - 1][0])
else:
    print(f"{'MAP':<28} {'MAX DIMENSIONS':<14} {'ACTIVE DIMENSIONS':<18} {'MEMORY':<10} TYPE")
    for name, max_dimensions, active_dimensions, memory, kind in rows:
        print(f"{name:<28} {max_dimensions:<14} {active_dimensions:<18} {memory:<10} {kind}")
PY
}

show_sietch() {
  local map="$1"

  require_catalog
  ensure_config
  python_common "$map" <<'PY'
import json
import os
import sys
from pathlib import Path

partition_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])
config_path = Path(sys.argv[3])
target = sys.argv[4].lower()

db_partitions = os.environ.get("SIETCH_DB_PARTITIONS_JSON")
partitions = json.loads(db_partitions) if db_partitions else json.loads(partition_path.read_text())
servers = json.loads(server_path.read_text()) if server_path.exists() and server_path.stat().st_size > 0 else []
config = json.loads(config_path.read_text()) if config_path.exists() else {"maps": {}, "partitions": {}}

env = {}
env_path = Path(".env")
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key] = value.strip().strip('"')

def env_key(name):
    normalized = "".join(ch if ch.isalnum() else "_" for ch in name.upper())
    while "__" in normalized:
        normalized = normalized.replace("__", "_")
    return f"DUNE_MEMORY_{normalized.strip('_')}"

server_by_map = {str(s.get("map", "")): s for s in servers if s.get("map")}
maps = {}
for row in partitions:
    name = str(row.get("map", ""))
    if name:
        maps.setdefault(name, []).append(row)

name = next((item for item in maps if item.lower() == target), None)
if not name:
    print(f"Unknown map: {sys.argv[4]}")
    raise SystemExit(1)

rows = maps[name]
raw = server_by_map.get(name, {}).get("raw", {})
dedicated = bool(raw.get("dedicatedScaling"))
map_config = config.get("maps", {}).get(name, {})
max_dimensions = int(map_config.get("max_dimensions") or len(rows))
if name == "Overmap":
    kind = "Always-On"
    active = "1"
elif dedicated and name != "DeepDesert_1":
    kind = "Dedicated Scaling"
    active = "Managed"
elif name == "Survival_1":
    kind = "Always-On"
    active = str(int(map_config.get("active_dimensions") or min(max_dimensions, len(rows))))
elif name == "DeepDesert_1":
    kind = "Dedicated Scaling"
    active = str(int(map_config.get("active_dimensions") or min(max_dimensions, len(rows))))
else:
    kind = "Dynamic"
    active = str(int(map_config.get("active_dimensions") or min(max_dimensions, len(rows))))

catalog_memory = server_by_map.get(name, {}).get("resources", {}).get("limits", {}).get("memory", "")
map_default_overrides = {
    "DLC_Story_LostHarvest_EcolabA": "2g",
    "DLC_Story_LostHarvest_EcolabB": "2g",
    "DLC_Story_LostHarvest_ForgottenLab": "2g",
}
memory = env.get(env_key(name)) or map_default_overrides.get(name) or catalog_memory or env.get("DUNE_MEMORY_DEFAULT") or "default"

partition_config = config.get("partitions", {})
def default_display_name(row):
    label = str(row.get("label") or "").strip()
    if not label:
        return "(unset)"
    return label if label.lower().startswith("sietch ") else f"Sietch {label}"

display_values = [
    partition_config.get(str(row.get("id")), {}).get("display_name") or default_display_name(row)
    for row in rows
]
password_set = [bool(partition_config.get(str(row.get("id")), {}).get("password")) for row in rows]
display_summary = "(mixed)" if len(set(display_values)) > 1 else display_values[0]
password_summary = "(set)" if any(password_set) else "(unset)"

print(f"Map: {name}")
print(f"Type: {kind}")
print(f"Max dimensions: {max_dimensions}")
print(f"Active dimensions: {active}")
print(f"Memory: {memory}")
print(f"Display name: {display_summary}")
print(f"Password: {password_summary}")
PY
}

dimensions() {
  local map="$1"
  shift
  local active_only=0
  local mode="table"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --active-only)
        active_only=1
        ;;
      --numbered|--labels|--ids|--partition-at=*)
        mode="$1"
        ;;
      *)
        mode="$1"
        ;;
    esac
    shift
  done

  require_catalog
  ensure_config
  python_common "$map" "$mode" "$active_only" <<'PY'
import json
import os
import sys
from pathlib import Path

partition_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])
config_path = Path(sys.argv[3])
target = sys.argv[4].lower()
mode = sys.argv[5]
active_only = sys.argv[6] == "1"

db_partitions = os.environ.get("SIETCH_DB_PARTITIONS_JSON")
partitions = json.loads(db_partitions) if db_partitions else json.loads(partition_path.read_text())
servers = json.loads(server_path.read_text()) if server_path.exists() and server_path.stat().st_size > 0 else []
config = json.loads(config_path.read_text()) if config_path.exists() else {"maps": {}, "partitions": {}}

rows = [row for row in partitions if str(row.get("map", "")).lower() == target]
if not rows:
    print(f"Unknown map: {sys.argv[4]}", file=sys.stderr)
    raise SystemExit(1)

rows.sort(key=lambda row: (int(row.get("dimension", 0)), int(row.get("id", 0))))

server_by_map = {str(s.get("map", "")): s for s in servers if s.get("map")}
raw = server_by_map.get(rows[0].get("map"), {}).get("raw", {})
dedicated = bool(raw.get("dedicatedScaling"))
map_config = config.get("maps", {}).get(rows[0].get("map"), {})
max_dimensions = int(map_config.get("max_dimensions") or len(rows))
if rows[0].get("map") == "Overmap":
    active_dimensions = 1
elif dedicated and rows[0].get("map") != "DeepDesert_1":
    active_dimensions = len(rows)
else:
    active_dimensions = int(map_config.get("active_dimensions") or min(max_dimensions, len(rows)))
if active_only:
    rows = rows[:max(0, active_dimensions)]

partition_config = config.get("partitions", {})
def default_display_name(row):
    label = str(row.get("label") or "").strip()
    if not label:
        return "(unset)"
    return label if label.lower().startswith("sietch ") else f"Sietch {label}"

if mode == "--ids":
    for row in rows:
        print(row.get("id"))
elif mode.startswith("--partition-at="):
    index = int(mode.split("=", 1)[1])
    if index < 1 or index > len(rows):
        raise SystemExit(1)
    print(rows[index - 1].get("id"))
elif mode == "--numbered":
    for idx, row in enumerate(rows, 1):
        pid = str(row.get("id"))
        cfg = partition_config.get(pid, {})
        display = cfg.get("display_name") or default_display_name(row)
        password = "(set)" if cfg.get("password") else "(unset)"
        print(f"{idx}) {row.get('map')} Dimension {row.get('dimension', 0)}")
        print(f"   Display Name: {display}")
        print(f"   Password: {password}")
elif mode == "--labels":
    for row in rows:
        pid = str(row.get("id"))
        cfg = partition_config.get(pid, {})
        display = cfg.get("display_name") or default_display_name(row)
        password = "(set)" if cfg.get("password") else "(unset)"
        print(f"{row.get('map')} Dimension {row.get('dimension', 0)}  Display Name: {display}  Password: {password}")
else:
    print(f"{'DIMENSION':<10} {'DISPLAY NAME':<32} PASSWORD")
    for row in rows:
        pid = str(row.get("id"))
        cfg = partition_config.get(pid, {})
        display = cfg.get("display_name") or default_display_name(row)
        password = "(set)" if cfg.get("password") else "(unset)"
        print(f"{str(row.get('dimension', 0)):<10} {display:<32} {password}")
PY
}

set_map_value() {
  local map="$1"
  local key="$2"
  local value="$3"

  ensure_config
  python_common "$map" "$key" "$value" <<'PY'
import json
import os
import sys
from pathlib import Path

partition_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])
config_path = Path(sys.argv[3])
target = sys.argv[4]
key = sys.argv[5]
value = int(sys.argv[6])

db_partitions = os.environ.get("SIETCH_DB_PARTITIONS_JSON")
partitions = json.loads(db_partitions) if db_partitions else json.loads(partition_path.read_text())
servers = json.loads(server_path.read_text()) if server_path.exists() and server_path.stat().st_size > 0 else []
config = json.loads(config_path.read_text()) if config_path.exists() else {"maps": {}, "partitions": {}}
maps = {}
for row in partitions:
    name = str(row.get("map", ""))
    maps.setdefault(name, []).append(row)

name = next((item for item in maps if item.lower() == target.lower()), None)
if not name:
    print(f"Unknown map: {target}", file=sys.stderr)
    raise SystemExit(1)

catalog_max = len(maps[name])
maps_cfg = config.setdefault("maps", {})
entry = maps_cfg.setdefault(name, {})
max_dimensions = int(entry.get("max_dimensions") or catalog_max)
if name == "Overmap":
    print("Overmap must remain at one dimension.", file=sys.stderr)
    raise SystemExit(1)
if key == "active_dimensions":
    raw = next((server.get("raw", {}) for server in servers if str(server.get("map", "")).lower() == name.lower()), {})
    if raw.get("dedicatedScaling") and name != "DeepDesert_1":
        print(f"{name} has dedicated scaling enabled; active dimensions are managed at runtime.", file=sys.stderr)
        raise SystemExit(1)
can_create_dimensions = name in {"Survival_1", "DeepDesert_1"}
if value > catalog_max and not (
    (key == "max_dimensions" and can_create_dimensions)
    or (key == "active_dimensions" and can_create_dimensions and value <= max_dimensions)
):
    print(f"{name} currently has {catalog_max} available partition(s).", file=sys.stderr)
    print("Increasing beyond that requires regenerating and applying world partitions, which this command will not do automatically.", file=sys.stderr)
    raise SystemExit(1)

if key == "active_dimensions":
    if value > max_dimensions:
        print(f"Active dimensions must be less than or equal to max dimensions ({max_dimensions}).", file=sys.stderr)
        raise SystemExit(1)
    entry["active_dimensions_explicit"] = True
entry[key] = value
if key == "max_dimensions":
    active = int(entry.get("active_dimensions") or min(value, catalog_max))
    if active > value:
        entry["active_dimensions"] = value
config_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n")
PY
  set_config_permissions
}

sync_partition_catalog_from_db() {
  ensure_config
  if ! docker_postgres_running; then
    return 0
  fi

  python3 - <<'PY'
import json
import subprocess
from pathlib import Path

out = subprocess.check_output([
    "docker", "exec", "dune-postgres", "psql",
    "-U", "postgres", "-d", "dune", "-At", "-F", "\t",
    "-c",
    "select partition_id, map, dimension_index, blocked, partition_definition::text "
    "from dune.world_partition order by partition_id;"
], text=True)

rows = []
for line in out.splitlines():
    if not line.strip():
      continue
    partition_id, map_name, dimension_index, blocked, definition = line.split("\t", 4)
    payload = json.loads(definition)
    box = payload.get("box", {})
    rows.append({
        "map": map_name,
        "id": int(partition_id),
        "dimension": int(dimension_index),
        "disable": blocked.lower() in ("t", "true", "1", "yes"),
        "minX": box.get("min_x"),
        "minY": box.get("min_y"),
        "maxX": box.get("max_x"),
        "maxY": box.get("max_y"),
    })

Path("runtime/generated/partition-catalog.json").write_text(
    json.dumps(rows, indent=2) + "\n",
    encoding="utf-8",
)
PY
}

normalize_deepdesert_labels() {
  if ! docker_postgres_running; then
    return 0
  fi

  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
update dune.world_partition
set label = case
  when dimension_index = 0 then 'PvP'
  when dimension_index = 1 then 'PvE'
  else label
end
where map = 'DeepDesert_1'
  and dimension_index in (0, 1);
" >/dev/null
}

refresh_survival_browser_state() {
  if [ -x runtime/scripts/publish-sietch-overrides.sh ]; then
    runtime/scripts/publish-sietch-overrides.sh restart >/dev/null 2>&1 || true
    runtime/scripts/publish-sietch-overrides.sh once >/dev/null 2>&1 || true
  fi
}

survival_active_target() {
  python3 - <<'PY'
import json
from pathlib import Path

config_path = Path("runtime/generated/sietch-config.json")
target = 1
if config_path.exists():
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        target = int(config.get("maps", {}).get("Survival_1", {}).get("active_dimensions") or 1)
    except Exception:
        target = 1
if target < 1:
    target = 1
print(target)
PY
}

wait_for_survival_topology_settle() {
  local target="${1:-1}"
  local timeout_seconds="${2:-90}"
  local deadline current_rows assigned_rows

  docker_postgres_running || return 0
  deadline=$(( $(date +%s) + timeout_seconds ))

  while [ "$(date +%s)" -lt "$deadline" ]; do
    current_rows="$(psql_value "
with ranked as (
  select
    partition_id,
    coalesce(server_id, '') as server_id,
    row_number() over (order by dimension_index, partition_id) as ord
  from dune.world_partition
  where lower(map) = lower('Survival_1')
)
select count(*) from ranked where ord <= ${target};
" | tr -d '[:space:]')"
    assigned_rows="$(psql_value "
with ranked as (
  select
    partition_id,
    coalesce(server_id, '') as server_id,
    row_number() over (order by dimension_index, partition_id) as ord
  from dune.world_partition
  where lower(map) = lower('Survival_1')
)
select count(*) from ranked where ord <= ${target} and server_id <> '';
" | tr -d '[:space:]')"
    [ -n "$current_rows" ] || current_rows=0
    [ -n "$assigned_rows" ] || assigned_rows=0
    if [ "$current_rows" -ge "$target" ] && [ "$assigned_rows" -ge "$target" ]; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for Survival_1 topology to settle at ${target} active dimension(s)." >&2
  return 1
}

survival_port_bases() {
  (
    # shellcheck disable=SC1091
    [ -f .env ] && . ./.env
    # shellcheck disable=SC1091
    [ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
    # shellcheck disable=SC1091
    source runtime/scripts/runtime-env.sh
    printf '%s\t%s\n' "$(resolve_client_port_base)" "$(resolve_igw_port_base)"
  )
}

relocate_survival_port_conflicts() {
  local target="${1:-1}"
  local client_base igw_base first_client last_client first_igw last_igw
  local conflicts partition_id map game_port igw_port connected_players

  [ "$target" -gt 1 ] 2>/dev/null || return 0
  IFS=$'\t' read -r client_base igw_base < <(survival_port_bases)
  validate_positive_integer "$client_base" || return 1
  validate_positive_integer "$igw_base" || return 1

  first_client=$((client_base + 2))
  last_client=$((client_base + target))
  first_igw=$((igw_base + 2))
  last_igw=$((igw_base + target))

  conflicts="$(docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "
select
  wp.partition_id,
  wp.map,
  coalesce(fs.game_port, 0),
  coalesce(fs.igw_port, 0),
  coalesce(fs.connected_players, 0)
from dune.world_partition wp
join dune.farm_state fs on fs.server_id = wp.server_id
where lower(wp.map) <> lower('Survival_1')
  and coalesce(fs.alive, false) = true
  and (
    fs.game_port between ${first_client} and ${last_client}
    or fs.igw_port between ${first_igw} and ${last_igw}
  )
order by wp.partition_id;
" 2>/dev/null || true)"

  [ -n "$conflicts" ] || return 0

  while IFS=$'\t' read -r partition_id map game_port igw_port connected_players; do
    if [ "${connected_players:-0}" -gt 0 ] 2>/dev/null; then
      echo "Cannot reserve Sietch ports ${game_port}/${igw_port} while $map partition $partition_id has connected players." >&2
      echo "Wait for that map to empty, then retry the Sietch change." >&2
      return 1
    fi
  done <<< "$conflicts"

  while IFS=$'\t' read -r partition_id map game_port igw_port connected_players; do
    [ -n "${partition_id:-}" ] || continue
    echo "Relocating $map partition $partition_id from newly reserved Sietch ports ${game_port}/${igw_port}..."
    runtime/scripts/despawn-server.sh "$partition_id" --force
    runtime/scripts/spawn-server.sh "$partition_id"
  done <<< "$conflicts"
}

sync_survival_usersettings_state() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

root = Path(".")
sietch_path = root / "runtime" / "generated" / "sietch-config.json"
usersettings_path = root / "runtime" / "generated" / "usersettings.json"

if not sietch_path.exists():
    raise SystemExit(0)

try:
    sietch = json.loads(sietch_path.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)

if usersettings_path.exists():
    try:
        usersettings = json.loads(usersettings_path.read_text(encoding="utf-8"))
    except Exception:
        usersettings = {}
else:
    usersettings = {}

usersettings.setdefault("engine", {})
usersettings.setdefault("maps", {})
partitions_cfg = usersettings.setdefault("partitions", {})
sietch_partitions = sietch.get("partitions", {})
changed = False
current_survival_ids = set()

def derived_display_name(entry):
    label = str(entry.get("label") or "").strip()
    if not label:
        return ""
    if str(entry.get("map") or "") != "Survival_1":
        return ""
    return label if label.lower().startswith("sietch ") else f"Sietch {label}"

for partition_id, entry in sietch_partitions.items():
    if str(entry.get("map") or "") != "Survival_1":
        continue
    current_survival_ids.add(str(partition_id))
    user_entry = partitions_cfg.setdefault(str(partition_id), {})
    if user_entry.get("map") != "Survival_1":
        user_entry["map"] = "Survival_1"
        changed = True
    engine_entry = user_entry.setdefault("userengine", {})
    display_name = entry.get("display_name") or derived_display_name(entry)
    password = entry.get("password") or ""
    if display_name:
        if engine_entry.get("server_display_name") != display_name:
            engine_entry["server_display_name"] = display_name
            changed = True
    elif "server_display_name" in engine_entry:
        engine_entry.pop("server_display_name", None)
        changed = True
    if password:
        if engine_entry.get("server_login_password") != password:
            engine_entry["server_login_password"] = password
            changed = True
    elif "server_login_password" in engine_entry:
        engine_entry.pop("server_login_password", None)
        changed = True
    if not engine_entry:
        user_entry.pop("userengine", None)
    if not user_entry:
        partitions_cfg.pop(str(partition_id), None)
        changed = True

for partition_id, user_entry in list(partitions_cfg.items()):
    if partition_id in current_survival_ids:
        continue
    engine_entry = user_entry.get("userengine", {})
    removed = False
    if "server_display_name" in engine_entry:
        engine_entry.pop("server_display_name", None)
        removed = True
    if "server_login_password" in engine_entry:
        engine_entry.pop("server_login_password", None)
        removed = True
    if not engine_entry:
        user_entry.pop("userengine", None)
    if removed:
        changed = True
    if not user_entry:
        partitions_cfg.pop(partition_id, None)
        changed = True

if changed:
    tmp = usersettings_path.with_name(f".{usersettings_path.name}.tmp.{os.getpid()}")
    tmp.write_text(json.dumps(usersettings, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(usersettings_path)
PY
  python3 runtime/scripts/usersettings.py materialize-current >/dev/null 2>&1 || true
}

apply_survival_sietch_labels_from_config() {
  docker_postgres_running || return 0
  ensure_config

  while IFS=$'\t' read -r partition_id display_name; do
    [ -n "${partition_id:-}" ] || continue
    [ -n "${display_name:-}" ] || continue
    docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
update dune.world_partition
set label = '${display_name//\'/\'\'}'
where partition_id = ${partition_id}
  and map = 'Survival_1';
" >/dev/null || true
  done < <(python3 - <<'PY'
import json
from pathlib import Path

path = Path("runtime/generated/sietch-config.json")
try:
    config = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)

for partition_id, entry in sorted(config.get("partitions", {}).items(), key=lambda item: int(item[0]) if str(item[0]).isdigit() else 0):
    if str(entry.get("map") or "") != "Survival_1":
        continue
    display = str(entry.get("display_name") or "").strip()
    if display:
        print(f"{partition_id}\t{display}")
PY
)
}

refresh_survival_director_state() {
  if docker ps --format '{{.Names}}' | grep -qx dune-director; then
    runtime/scripts/start-director.sh >/dev/null 2>&1 || true
  fi
}

refresh_survival_gateway_state() {
  if docker ps --format '{{.Names}}' | grep -qx dune-server-gateway; then
    runtime/scripts/start-server-gateway.sh >/dev/null 2>&1 || true
  fi
}

refresh_survival_control_plane_state() {
  sync_survival_usersettings_state
  apply_survival_sietch_labels_from_config
  refresh_survival_browser_state
  refresh_survival_director_state
  refresh_survival_gateway_state
}

refresh_survival_sietch_metadata_state() {
  sync_survival_usersettings_state
  apply_survival_sietch_labels_from_config
  refresh_survival_browser_state
  refresh_survival_director_state
  refresh_survival_gateway_state
}

sync_survival_sietch_topology_state() {
  sync_survival_usersettings_state
  apply_survival_sietch_labels_from_config
}

restart_survival_server_if_running() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-server-survival-1; then
    echo "Restarting Survival_1 so sietch display/password changes are published by the running server..."
    runtime/scripts/start-server-survival-1.sh >/dev/null
  fi
}

restart_sietch_partition_if_running() {
  local partition_id="$1"
  local container=""

  if [ "$partition_id" = "1" ]; then
    restart_survival_server_if_running
    return 0
  fi

  container="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E "^dune-server-survival-1-${partition_id}$" | head -n1 || true)"
  [ -n "$container" ] || return 0

  echo "Restarting Survival_1 partition ${partition_id} so sietch display/password changes are published by the running server..."
  runtime/scripts/despawn-server.sh "$partition_id" >/dev/null
  runtime/scripts/spawn-server.sh "$partition_id" >/dev/null
}

ensure_map_partitions() {
  local map="$1"
  local wanted="$2"
  ENSURE_MAP_PARTITIONS_CHANGED=0

  docker_postgres_running || {
    echo "dune-postgres must be running to add dimensions." >&2
    return 1
  }

  local safe_map current
  safe_map="${map//\'/\'\'}"
  current="$(psql_value "select count(*) from dune.world_partition where lower(map) = lower('$safe_map');" | tr -d '[:space:]')"
  [ -n "$current" ] || current=0

  if [ "$current" -ge "$wanted" ] 2>/dev/null; then
    return 0
  fi

  local next_dim
  next_dim="$(psql_value "select coalesce(max(dimension_index), -1) + 1 from dune.world_partition where lower(map) = lower('$safe_map');" | tr -d '[:space:]')"
  [ -n "$next_dim" ] || next_dim=0

  while [ "$current" -lt "$wanted" ]; do
    docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
set search_path = dune, public;

with template as (
  select map, partition_definition
  from dune.world_partition
  where lower(map) = lower('$safe_map')
  order by dimension_index, partition_id
  limit 1
)
insert into dune.world_partition (
  partition_id,
  server_id,
  map,
  partition_definition,
  dimension_index,
  blocked,
  label
)
select
  nextval('dune.world_partition_partition_id_seq'),
  null,
  map,
  partition_definition,
  $next_dim,
  false,
  null
from template;

select dune.update_partition_labels(true);
" >/dev/null
    if [ "$map" = "DeepDesert_1" ]; then
      normalize_deepdesert_labels
    fi
    current=$((current + 1))
    next_dim=$((next_dim + 1))
    ENSURE_MAP_PARTITIONS_CHANGED=1
  done

  sync_partition_catalog_from_db
  if [ "$map" = "Survival_1" ]; then
    sync_survival_sietch_topology_state
  fi
}

reconcile_map_dimensions() {
  local map="$1"
  local safe_map target available base_partition assigned_count initial_assigned_count
  local topology_changed=0

  ensure_config

  case "$map" in
    Overmap)
      return 0
      ;;
  esac

  docker_postgres_running || {
    echo "dune-postgres must be running to reconcile active dimensions." >&2
    return 1
  }

  safe_map="${map//'/'''}"
  target="$(python3 - "$map" <<'PY'
import json
import sys
from pathlib import Path

target = sys.argv[1]
config_path = Path("runtime/generated/sietch-config.json")
if not config_path.exists():
    print("1")
    raise SystemExit
config = json.loads(config_path.read_text())
print(int(config.get("maps", {}).get(target, {}).get("active_dimensions") or 1))
PY
)"
  validate_positive_integer "$target" || target=1
  if [ "$target" -le 0 ] 2>/dev/null; then
    return 0
  fi

  if map_supports_configurable_active_dimensions "$map"; then
    ensure_map_partitions "$map" "$target"
    if [ "${ENSURE_MAP_PARTITIONS_CHANGED:-0}" -eq 1 ]; then
      topology_changed=1
    fi
    if [ "$map" = "Survival_1" ]; then
      relocate_survival_port_conflicts "$target"
    fi
  fi

  available="$(psql_value "select count(*) from dune.world_partition where lower(map) = lower('$safe_map');" | tr -d '[:space:]')"
  [ -n "$available" ] || available=0
  if [ "$target" -gt "$available" ] 2>/dev/null; then
    target="$available"
  fi
  if [ "$target" -le 0 ] 2>/dev/null; then
    return 0
  fi

  base_partition="$(psql_value "select partition_id from dune.world_partition where lower(map) = lower('$safe_map') order by dimension_index, partition_id limit 1;" | tr -d '[:space:]')"
  [ -n "$base_partition" ] || return 1

  assigned_count="$(psql_value "select count(*) from dune.world_partition where lower(map) = lower('$safe_map') and coalesce(server_id, '') <> '';" | tr -d '[:space:]')"
  [ -n "$assigned_count" ] || assigned_count=0
  initial_assigned_count="$assigned_count"

  if map_supports_configurable_active_dimensions "$map"; then
    base_server_id="$(psql_value "
      select coalesce(server_id, '')
      from dune.world_partition
      where partition_id = $base_partition
      limit 1;
    " | tr -d '[:space:]')"

    if [ "$assigned_count" -lt "$target" ] && [ "$map" != "Survival_1" ] && [ -z "$base_server_id" ]; then
      runtime/scripts/spawn-server.sh "$base_partition"
      assigned_count=$((assigned_count + 1))
      topology_changed=1
    fi

    mapfile -t survival_partitions < <(psql_value "
      select partition_id || '|' || coalesce(server_id, '')
      from dune.world_partition
      where lower(map) = lower('$safe_map')
        and partition_id <> $base_partition
      order by dimension_index, partition_id;
    ")

    for partition_row in "${survival_partitions[@]}"; do
      [ "$assigned_count" -lt "$target" ] || break
      IFS='|' read -r next_partition next_server_id <<< "$partition_row"
      [ -n "$next_partition" ] || continue
      if [ -n "$next_server_id" ]; then
        continue
      fi
      runtime/scripts/spawn-server.sh "$next_partition"
      assigned_count=$((assigned_count + 1))
      topology_changed=1
    done

    while [ "$assigned_count" -gt "$target" ]; do
      remove_row="$(psql_value "
        select partition_id || '|' || coalesce(server_id, '')
        from dune.world_partition
        where lower(map) = lower('$safe_map')
          and partition_id <> $base_partition
          and coalesce(server_id, '') <> ''
        order by dimension_index desc, partition_id desc
        limit 1;
      ")"
      remove_partition="$(printf '%s' "$remove_row" | cut -d'|' -f1 | tr -d '[:space:]')"
      remove_server_id="$(printf '%s' "$remove_row" | cut -d'|' -f2- | tr -d '[:space:]')"
      [ -n "$remove_partition" ] || break
      base_server_id="$(psql_value "
        select coalesce(server_id, '')
        from dune.world_partition
        where partition_id = $base_partition
        limit 1;
      " | tr -d '[:space:]')"
      if [ -n "$base_server_id" ]; then
        docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
update dune.encrypted_player_state
set
  server_id = '$base_server_id',
  previous_server_partition_id = $base_partition,
  return_dimension_index = 0
where previous_server_partition_id = $remove_partition
   or server_id = '$remove_server_id';
" >/dev/null
      fi
      runtime/scripts/despawn-server.sh "$remove_partition"
      assigned_count=$((assigned_count - 1))
      topology_changed=1
    done

    if docker exec dune-postgres psql -U postgres -d dune -Atc "
with ranked as (
  select
    partition_id,
    row_number() over (order by dimension_index, partition_id) as ord,
    coalesce(server_id, '') as server_id
  from dune.world_partition
  where lower(map) = lower('$safe_map')
)
select count(*)
from ranked
where ord > $target
  and server_id = '';
" | grep -qv '^0$'; then
      topology_changed=1
    fi

    docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
set search_path = dune, public;

with ranked as (
  select
    partition_id,
    row_number() over (order by dimension_index, partition_id) as ord,
    coalesce(server_id, '') as server_id
  from dune.world_partition
  where lower(map) = lower('$safe_map')
)
delete from dune.world_partition wp
using ranked
where wp.partition_id = ranked.partition_id
  and ranked.ord > $target
  and ranked.server_id = '';

select dune.update_partition_labels(true);
" >/dev/null
    if [ "$map" = "DeepDesert_1" ]; then
      normalize_deepdesert_labels
    fi
  else
    docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
with ranked as (
  select
    partition_id,
    row_number() over (order by dimension_index, partition_id) as ord
  from dune.world_partition
  where lower(map) = lower('$safe_map')
)
update dune.world_partition wp
set blocked = ranked.ord > $target
from ranked
where wp.partition_id = ranked.partition_id;
" >/dev/null
  fi

  sync_partition_catalog_from_db
  sync_sietch_config_from_db "reconcile-$map" >/dev/null || true
  if [ "$map" = "Survival_1" ]; then
    refresh_survival_control_plane_state
  fi
  if [ "$map" = "Survival_1" ] && [ "$topology_changed" -eq 1 ] && [ "$target" -gt "$initial_assigned_count" ] 2>/dev/null; then
    wait_for_survival_topology_settle "$target" 90 || true
    sync_sietch_config_from_db "reconcile-$map-settled" >/dev/null || true
    sync_survival_sietch_topology_state
  fi
}

set_partition_value() {
  local partition_id="$1"
  local key="$2"
  local value="$3"

  ensure_config
  python_common "$partition_id" "$key" "$value" <<'PY'
import json
import os
import sys
from pathlib import Path

partition_path = Path(sys.argv[1])
config_path = Path(sys.argv[3])
partition_id = str(sys.argv[4])
key = sys.argv[5]
value = sys.argv[6]

db_partitions = os.environ.get("SIETCH_DB_PARTITIONS_JSON")
partitions = json.loads(db_partitions) if db_partitions else json.loads(partition_path.read_text())
row = next((item for item in partitions if str(item.get("id")) == partition_id), None)
if not row:
    print(f"Unknown partition: {partition_id}", file=sys.stderr)
    raise SystemExit(1)

config = json.loads(config_path.read_text()) if config_path.exists() else {"maps": {}, "partitions": {}}
entry = config.setdefault("partitions", {}).setdefault(partition_id, {})
if value == "":
    entry.pop(key, None)
else:
    entry[key] = value
if not entry:
    config.get("partitions", {}).pop(partition_id, None)

# Partition IDs can be recreated when active dimensions change. Keep the stable
# map/dimension copy in sync too, otherwise a cleared password can be restored
# from older preserved dimension state during the next sync.
map_name = str(row.get("map") or "")
dimension = str(int(row.get("dimension") or 0))
if map_name:
    dim_entry = config.setdefault("maps", {}).setdefault(map_name, {}).setdefault("dimensions", {}).setdefault(dimension, {})
    if value == "":
        dim_entry.pop(key, None)
    else:
        dim_entry[key] = value
config_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n")
PY
  set_config_permissions
  sync_sietch_config_from_db "set-$key" >/dev/null || true
  if [ "$(partition_map_name "$partition_id")" = "Survival_1" ]; then
    sync_survival_usersettings_state
  fi
}

set_partition_label_if_possible() {
  local partition_id="$1"
  local label="$2"

  docker_postgres_running || return 0
  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
update dune.world_partition
set label = '${label//\'/\'\'}'
where partition_id = ${partition_id};
" >/dev/null
}

reset_partition_label_if_possible() {
  local partition_id="$1"
  local row=""
  local map_name=""
  local dimension_index=""
  local default_label=""

  docker_postgres_running || return 0

  row="$(psql_value "
    select coalesce(map, ''), coalesce(dimension_index, 0)
    from dune.world_partition
    where partition_id = ${partition_id}
    limit 1;
  " | tr -d '\r')"
  if [ -n "$row" ]; then
    map_name="$(printf '%s\n' "$row" | awk -F'|' '{print $1}' | xargs)"
    dimension_index="$(printf '%s\n' "$row" | awk -F'|' '{print $2}' | xargs)"
  fi

  if [ "$map_name" = "Survival_1" ]; then
    case "$dimension_index" in
      0) default_label="Sietch Abbir" ;;
      1) default_label="Sietch Alraab" ;;
      *) default_label="" ;;
    esac
  fi

  if [ -n "$default_label" ]; then
    docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
update dune.world_partition
set label = '${default_label//\'/\'\'}'
where partition_id = ${partition_id};
" >/dev/null
    return 0
  fi

  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
set search_path = dune, public;
update dune.world_partition
set label = null
where partition_id = ${partition_id};
select dune.update_partition_labels(true);
" >/dev/null
}

partition_map_name() {
  local partition_id="$1"
  local row

  if docker_postgres_running; then
    row="$(psql_value "
      select coalesce(map, '')
      from dune.world_partition
      where partition_id = ${partition_id}
      limit 1;
    " | tr -d '\r')"
    if [ -n "$row" ]; then
      printf '%s' "$row"
      return 0
    fi
  fi

  python3 - "$PARTITION_CATALOG" "$partition_id" <<'PY'
import json
import sys
from pathlib import Path

catalog_path = Path(sys.argv[1])
partition_id = str(sys.argv[2])
if not catalog_path.exists():
    raise SystemExit
rows = json.loads(catalog_path.read_text())
for row in rows:
    if str(row.get("id")) == partition_id:
        print(str(row.get("map") or ""))
        raise SystemExit
PY
}

runtime_args() {
  local map="$1"
  local partition_id="$2"

  ensure_config
python_common "$map" "$partition_id" <<'PY'
import json
import os
import sys
from pathlib import Path

config_path = Path(sys.argv[3])
partition_id = str(sys.argv[5])
partition_path = Path(sys.argv[1])
config = json.loads(config_path.read_text()) if config_path.exists() else {"maps": {}, "partitions": {}}
entry = config.get("partitions", {}).get(partition_id, {})
db_partitions = os.environ.get("SIETCH_DB_PARTITIONS_JSON")
partitions = json.loads(db_partitions) if db_partitions else (json.loads(partition_path.read_text()) if partition_path.exists() else [])
row = next((item for item in partitions if str(item.get("id")) == partition_id), {})

def ini_quote(value):
    return str(value)

def default_display_name(partition_row):
    label = str(partition_row.get("label") or "").strip()
    if not label:
        return ""
    return label if label.lower().startswith("sietch ") else f"Sietch {label}"

args = []
display_name = entry.get("display_name") or default_display_name(row)
if display_name:
    args.append(f"-ServerDisplayName={ini_quote(display_name)}")
if entry.get("password"):
    password = ini_quote(entry['password'])
    args.append(f"-ServerLoginPassword={password}")
    args.append(f"-ServerPassword={password}")

for arg in args:
    print(arg)
PY
}

validate_sietch_state() {
  ensure_config
  sync_sietch_config_from_db "validate" >/dev/null || true
  sync_survival_usersettings_state
  python_common <<'PY'
import json
import os
import sys
from pathlib import Path

partition_path = Path(sys.argv[1])
config_path = Path(sys.argv[3])
usersettings_path = Path("runtime/generated/usersettings.json")
db_partitions = os.environ.get("SIETCH_DB_PARTITIONS_JSON")
partitions = json.loads(db_partitions) if db_partitions else (json.loads(partition_path.read_text()) if partition_path.exists() else [])
config = json.loads(config_path.read_text()) if config_path.exists() else {"maps": {}, "partitions": {}}
usersettings = json.loads(usersettings_path.read_text()) if usersettings_path.exists() else {"partitions": {}}
errors = []
warnings = []

by_id = {str(row.get("id")): row for row in partitions if row.get("id") is not None}
partition_cfg = config.get("partitions", {})

for pid, entry in partition_cfg.items():
    row = by_id.get(str(pid))
    if not row:
        errors.append(f"partition config references missing partition id {pid}")
        continue
    if entry.get("map") and str(entry.get("map")) != str(row.get("map")):
        errors.append(f"partition {pid} map drift: config={entry.get('map')} db={row.get('map')}")
    if entry.get("dimension") is not None and int(entry.get("dimension")) != int(row.get("dimension") or 0):
        errors.append(f"partition {pid} dimension drift: config={entry.get('dimension')} db={row.get('dimension')}")

survival_rows = sorted(
    [row for row in partitions if str(row.get("map")) == "Survival_1"],
    key=lambda row: (int(row.get("dimension") or 0), int(row.get("id") or 0)),
)
if not survival_rows:
    errors.append("no Survival_1 world_partition rows found")
else:
    survival_cfg = config.get("maps", {}).get("Survival_1", {})
    target = int(survival_cfg.get("active_dimensions") or 1)
    active = survival_rows[:max(1, min(target, len(survival_rows)))]
    if len(active) < target:
        errors.append(f"Survival_1 active_dimensions={target} but only {len(active)} partition row(s) exist")
    for row in active:
        pid = str(row.get("id"))
        entry = partition_cfg.get(pid, {})
        label = str(row.get("label") or "").strip()
        default_display = label if label.lower().startswith("sietch ") else (f"Sietch {label}" if label else "")
        display = entry.get("display_name") or default_display
        if not display:
            warnings.append(f"Survival_1 partition {pid} has no display name or label")
        user_entry = usersettings.get("partitions", {}).get(pid, {})
        engine_entry = user_entry.get("userengine", {})
        if entry.get("display_name") and engine_entry.get("server_display_name") != entry.get("display_name"):
            errors.append(f"usersettings drift for Survival_1 partition {pid}: server_display_name does not match sietch-config")
        if entry.get("password") and engine_entry.get("server_login_password") != entry.get("password"):
            errors.append(f"usersettings drift for Survival_1 partition {pid}: server_login_password does not match sietch-config")
        if not row.get("server_id"):
            errors.append(f"Survival_1 partition {pid} has no live server_id assigned")
    assigned = [row for row in active if row.get("server_id")]
    if not assigned:
        warnings.append("no active Survival_1 partition currently has server_id assigned; this may be normal when stopped")

seen = set()
for row in partitions:
    key = (str(row.get("map")), int(row.get("dimension") or 0))
    if key in seen:
        warnings.append(f"duplicate map/dimension row present: {key[0]} dimension {key[1]}")
    seen.add(key)

print("Sietch state validation")
print("=======================")
print(f"Partitions seen: {len(partitions)}")
print(f"Configured partition entries: {len(partition_cfg)}")
if survival_rows:
    print()
    print("Survival_1 configured state:")
    print(f"  Active dimensions: {int(config.get('maps', {}).get('Survival_1', {}).get('active_dimensions') or 1)}")
    print(f"  Max dimensions:    {int(config.get('maps', {}).get('Survival_1', {}).get('max_dimensions') or len(survival_rows))}")
    print()
    print("Survival_1 live partitions:")
    for row in survival_rows:
        pid = str(row.get("id"))
        entry = partition_cfg.get(pid, {})
        label = str(row.get("label") or "").strip()
        default_display = label if label.lower().startswith("sietch ") else (f"Sietch {label}" if label else "(unset)")
        display = entry.get("display_name") or default_display
        password_state = "(set)" if entry.get("password") else "(unset)"
        server_state = row.get("server_id") or "(unassigned)"
        print(f"  partition={pid} dimension={int(row.get('dimension') or 0)} display={display} password={password_state} server_id={server_state}")
for warning in warnings:
    print(f"WARN {warning}")
for error in errors:
    print(f"FAIL {error}")
if errors:
    raise SystemExit(1)
print("OK   Sietch generated state matches current partition ids.")
PY
}

cmd="${1:-list}"
case "$cmd" in
  list)
    list_sietches "${2:-table}"
    ;;
  show)
    [ "$#" -eq 2 ] || { usage; exit 2; }
    show_sietch "$2"
    ;;
  dimensions)
    [ "$#" -ge 2 ] || { usage; exit 2; }
    shift
    dimensions "$@"
    ;;
  set-max)
    [ "$#" -eq 3 ] || { usage; exit 2; }
    count="$(sanitize_positive_integer_arg "$3")"
    validate_positive_integer "$count" || { echo "Max dimensions must be a positive integer."; exit 1; }
    set_map_value "$2" max_dimensions "$count"
    if docker_postgres_running; then
      ensure_map_partitions "$2" "$count"
      set_map_value "$2" max_dimensions "$count"
    else
      echo "dune-postgres is not running; saved max dimensions and will create missing rows on next start/reconcile."
    fi
    echo "Max dimensions for $2 set to $count."
    ;;
  set-active)
    [ "$#" -eq 3 ] || { usage; exit 2; }
    count="$(sanitize_positive_integer_arg "$3")"
    validate_positive_integer "$count" || { echo "Active dimensions must be a positive integer."; exit 1; }
    set_map_value "$2" active_dimensions "$count"
    if docker_postgres_running; then
      reconcile_map_dimensions "$2"
      set_map_value "$2" active_dimensions "$count"
    else
      echo "dune-postgres is not running; saved active dimensions and will apply them on next start/reconcile."
    fi
    echo "Active dimensions for $2 set to $count."
    ;;
  set-display)
    [ "$#" -ge 3 ] || { usage; exit 2; }
    partition_id="$2"
    shift 2
    display_name="$*"
    python3 runtime/scripts/usersettings.py partition-engine-set "$(partition_map_name "$partition_id")" "$partition_id" server_display_name "$display_name" >/dev/null 2>&1 || true
    set_partition_value "$partition_id" display_name "$display_name"
    if [ -n "$display_name" ]; then
      set_partition_label_if_possible "$partition_id" "$display_name"
    else
      reset_partition_label_if_possible "$partition_id"
    fi
    sync_sietch_config_from_db "set-display-label" >/dev/null || true
    if [ "$(partition_map_name "$partition_id")" = "Survival_1" ]; then
      sync_survival_usersettings_state
    fi
    python3 runtime/scripts/usersettings.py materialize-current >/dev/null 2>&1 || true
    if [ "$(partition_map_name "$partition_id")" = "Survival_1" ]; then
      restart_sietch_partition_if_running "$partition_id"
      refresh_survival_sietch_metadata_state
    fi
    echo "Display name updated."
    ;;
  set-password)
    [ "$#" -eq 2 ] || [ "$#" -eq 3 ] || { usage; exit 2; }
    password_value="${3:-${SIETCH_PASSWORD:-}}"
    python3 runtime/scripts/usersettings.py partition-engine-set "$(partition_map_name "$2")" "$2" server_login_password "$password_value" >/dev/null 2>&1 || true
    set_partition_value "$2" password "$password_value"
    python3 runtime/scripts/usersettings.py materialize-current >/dev/null 2>&1 || true
    if [ "$(partition_map_name "$2")" = "Survival_1" ]; then
      restart_sietch_partition_if_running "$2"
      refresh_survival_sietch_metadata_state
    fi
    if [ -n "$password_value" ]; then
      echo "Password updated."
    else
      echo "Password cleared."
    fi
    ;;
  set-settings)
    [ "$#" -eq 4 ] || { usage; exit 2; }
    partition_id="$2"
    display_name="$3"
    password_value="$4"
    python3 runtime/scripts/usersettings.py partition-engine-set "$(partition_map_name "$partition_id")" "$partition_id" server_display_name "$display_name" >/dev/null 2>&1 || true
    python3 runtime/scripts/usersettings.py partition-engine-set "$(partition_map_name "$partition_id")" "$partition_id" server_login_password "$password_value" >/dev/null 2>&1 || true
    set_partition_value "$partition_id" display_name "$display_name"
    set_partition_value "$partition_id" password "$password_value"
    if [ -n "$display_name" ]; then
      set_partition_label_if_possible "$partition_id" "$display_name"
    else
      reset_partition_label_if_possible "$partition_id"
    fi
    sync_sietch_config_from_db "set-settings" >/dev/null || true
    if [ "$(partition_map_name "$partition_id")" = "Survival_1" ]; then
      sync_survival_usersettings_state
    fi
    python3 runtime/scripts/usersettings.py materialize-current >/dev/null 2>&1 || true
    if [ "$(partition_map_name "$partition_id")" = "Survival_1" ]; then
      restart_sietch_partition_if_running "$partition_id"
      refresh_survival_sietch_metadata_state
    fi
    echo "Sietch settings updated."
    ;;
  sync)
    summary="$(sync_sietch_config_from_db "manual-sync")"
    sync_survival_usersettings_state
    log_sietch_lifecycle "manual_sync" "$summary"
    printf '%s\n' "$summary"
    ;;
  validate|check)
    validate_sietch_state
    ;;
  runtime-args)
    [ "$#" -eq 3 ] || { usage; exit 2; }
    runtime_args "$2" "$3"
    ;;
  reconcile)
    [ "$#" -eq 2 ] || { usage; exit 2; }
    reconcile_map_dimensions "$2"
    ;;
  --names|--numbered)
    list_sietches "$cmd"
    ;;
  --map-at=*)
    list_sietches "$cmd"
    ;;
  edit)
    echo "Use Dune Docker Console Maps for the guided Sietch edit flow."
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown sietches command: $cmd"
    usage
    exit 2
    ;;
esac
