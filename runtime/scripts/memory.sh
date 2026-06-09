#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

CATALOG="runtime/generated/partition-catalog.json"
SERVER_CATALOG="runtime/generated/server-catalog.json"

generate_partition_catalog_from_server_catalog() {
  [ -s "$SERVER_CATALOG" ] || return 1

  mkdir -p runtime/generated
  python3 - "$SERVER_CATALOG" "$CATALOG" <<'PY'
import json
import sys
from pathlib import Path

server_path = Path(sys.argv[1])
catalog_path = Path(sys.argv[2])
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

catalog_path.write_text(json.dumps(rows, indent=2) + "\n")
PY
}

usage() {
  cat <<'EOF'
Usage:
  dune memory status
  dune memory list-maps
  dune memory set <map-name> <memory>
  dune memory unset <map-name>
  dune memory set default <memory>
  dune memory unset default

Memory values use Docker formats such as 512m, 4096m, 4g, 8g, 12g, or 16g.
Map names come from the generated world partition catalog.
EOF
}

normalize_key() {
  local name="$1"
  case "${name,,}" in
    survival|survival-1|survival_1) echo "SURVIVAL_1" ;;
    overmap) echo "OVERMAP" ;;
    default) echo "DEFAULT" ;;
    *) printf '%s' "$name" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g; s/__*/_/g; s/^_//; s/_$//' ;;
  esac
}

validate_memory() {
  printf '%s' "$1" | grep -Eq '^[1-9][0-9]*[mMgG]$'
}

env_key_for() {
  local name="$1"
  echo "DUNE_MEMORY_$(normalize_key "$name")"
}

env_value() {
  local key="$1"

  [ -f .env ] || return 1
  awk -F= -v key="$key" '$1 == key { print $2; exit }' .env
}

set_env_raw() {
  local key="$1"
  local value="$2"
  local tmp

  touch .env
  tmp="$(mktemp)"

  awk -F= -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $1 == key {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) print key "=" value
    }
  ' .env > "$tmp"

  mv "$tmp" .env
  chmod 644 .env
}

unset_env_raw() {
  local key="$1"
  local tmp

  [ -f .env ] || return 0
  tmp="$(mktemp)"
  awk -F= -v key="$key" '$1 != key { print }' .env > "$tmp"
  mv "$tmp" .env
  chmod 644 .env
}

require_catalog() {
  if [ ! -s "$CATALOG" ] && [ -s "$SERVER_CATALOG" ]; then
    generate_partition_catalog_from_server_catalog || true
  fi

  if [ ! -s "$CATALOG" ] && [ ! -s "$SERVER_CATALOG" ]; then
    echo "Map catalog not found. Run dune init first, or regenerate world partitions."
    echo "Expected one of:"
    echo "  $CATALOG"
    echo "  $SERVER_CATALOG"
    exit 1
  fi
}

canonical_map() {
  local target="$1"

  case "${target,,}" in
    survival|survival-1|survival_1) echo "Survival_1"; return 0 ;;
    overmap) echo "Overmap"; return 0 ;;
  esac

  require_catalog
  python3 - "$CATALOG" "$target" <<'PY'
import json
import sys
from pathlib import Path

catalog = json.loads(Path(sys.argv[1]).read_text())
target = sys.argv[2].lower()

seen = []
for row in catalog:
    name = str(row.get("map", ""))
    if name and name not in seen:
        seen.append(name)

for name in seen:
    if name.lower() == target:
        print(name)
        raise SystemExit(0)

raise SystemExit(1)
PY
}

list_maps() {
  local mode="${1:-table}"

  require_catalog
  python3 - "$CATALOG" "$mode" ".env" <<'PY'
import json
import sys
from pathlib import Path

catalog = json.loads(Path(sys.argv[1]).read_text())
mode = sys.argv[2]
env_path = Path(sys.argv[3])

env = {}
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if "=" in line and line.startswith("DUNE_MEMORY_"):
            key, value = line.split("=", 1)
            env[key] = value.strip().strip('"')

def env_key(name):
    key = "".join(ch if ch.isalnum() else "_" for ch in name.upper())
    while "__" in key:
        key = key.replace("__", "_")
    key = key.strip("_")
    return f"DUNE_MEMORY_{key}"

rows = []
seen = set()
for row in catalog:
    name = str(row.get("map", ""))
    if not name or name in seen:
        continue
    seen.add(name)
    partition = row.get("id", "")
    label = row.get("label") or "-"
    kind = "always-on" if name in {"Survival_1", "Overmap"} else "dynamic"
    memory = env.get(env_key(name), "default")
    rows.append((name, partition, label, kind, memory))

if mode == "--names":
    for name, _, _, _, _ in rows:
        print(name)
elif mode == "--numbered":
    print(f"{'#':>3}  {'MAP':<28} {'PARTITION':<10} {'LABEL':<18} {'TYPE':<10} MEMORY")
    for idx, (name, partition, label, kind, memory) in enumerate(rows, 1):
        print(f"{idx:>3}  {name:<28} {str(partition):<10} {label:<18} {kind:<10} {memory}")
else:
    print(f"{'MAP':<28} {'PARTITION':<10} {'LABEL':<18} {'TYPE':<10} MEMORY")
    for name, partition, label, kind, memory in rows:
        print(f"{name:<28} {str(partition):<10} {label:<18} {kind:<10} {memory}")
PY
}

safe_container_fragment() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//'
}

running_info_for_map() {
  local map="$1"
  local safe
  local container

  case "$map" in
    Survival_1)
      if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-server-survival-1; then
        echo "always|dune-server-survival-1|1"
      fi
      return
      ;;
    Overmap)
      if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-server-overmap; then
        echo "always|dune-server-overmap|2"
      fi
      return
      ;;
  esac

  safe="$(safe_container_fragment "$map")"
  container="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E "^dune-server-${safe}-[0-9]+$" | head -n1 || true)"
  if [ -n "$container" ] && [[ "$container" =~ -([0-9]+)$ ]]; then
    echo "dynamic|$container|${BASH_REMATCH[1]}"
  fi
}

restart_map_if_running() {
  local map="$1"
  local info kind container partition

  if [ "${DUNE_MEMORY_SKIP_RESTART:-0}" = "1" ]; then
    return 0
  fi

  info="$(running_info_for_map "$map" || true)"
  [ -n "$info" ] || return 0

  IFS='|' read -r kind container partition <<< "$info"

  echo
  echo "$map is currently running."
  echo "The relevant map container will restart now so the memory change can apply."

  case "$map" in
    Survival_1) runtime/scripts/dune restart survival ;;
    Overmap) runtime/scripts/dune restart overmap ;;
    *)
      runtime/scripts/despawn-server.sh "$partition"
      runtime/scripts/spawn-server.sh "$partition"
      ;;
  esac
}

show_status() {
  local default_memory

  default_memory="$(env_value DUNE_MEMORY_DEFAULT || true)"

  echo "=== Memory configuration ==="
  echo "Default memory: ${default_memory:-built-in per-map defaults, or server catalog for other dynamic maps}"
  echo

  if [ -s "$CATALOG" ]; then
    python3 - "$CATALOG" "$SERVER_CATALOG" ".env" <<'PY'
import json
import re
import sys
from pathlib import Path

catalog = json.loads(Path(sys.argv[1]).read_text())
server_catalog_path = Path(sys.argv[2])
env_path = Path(sys.argv[3])
env = {}
if env_path.exists():
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()

def env_key(name: str) -> str:
    lowered = name.lower()
    if lowered in {"survival", "survival-1", "survival_1"}:
        return "DUNE_MEMORY_SURVIVAL_1"
    if lowered == "overmap":
        return "DUNE_MEMORY_OVERMAP"
    normalized = re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")
    return f"DUNE_MEMORY_{normalized}"

server_catalog = []
if server_catalog_path.exists():
    try:
        server_catalog = json.loads(server_catalog_path.read_text())
    except Exception:
        server_catalog = []

server_by_map = {}
for row in server_catalog:
    name = str(row.get("map", "")).strip()
    if name and name not in server_by_map:
        server_by_map[name] = row

rows = []
seen = set()
global_default = env.get("DUNE_MEMORY_DEFAULT", "")
for row in catalog:
    name = str(row.get("map", ""))
    if not name or name in seen:
        continue
    seen.add(name)
    override = env.get(env_key(name), "")
    catalog_memory = str(
        server_by_map.get(name, {}).get("resources", {}).get("limits", {}).get("memory", "")
    ).strip()

    if override:
        display = override
    elif catalog_memory:
        display = f"{catalog_memory} default"
    elif global_default:
        display = global_default
    else:
        fallback_defaults = {
            "Survival_1": "16g default",
            "Overmap": "3g default",
            "DeepDesert_1": "16g default",
        }
        display = fallback_defaults.get(name, "3g default")

    rows.append((name, display))

print(f"{'MAP':<28} MEMORY")
for name, display in rows:
    print(f"{name:<28} {display}")
PY
  else
    echo "Map catalog not found. Run dune memory list-maps after init."
    echo
    echo "Configured overrides:"
    if [ -f .env ]; then
      grep '^DUNE_MEMORY_' .env || echo "No custom memory settings configured."
    else
      echo ".env not found."
    fi
  fi
}

confirm_set() {
  local map="$1"
  local memory="$2"

  if [ "$map" = "default" ]; then
    cat <<EOF
Set default memory to $memory?

This affects future spawned/restarted maps that do not have a map-specific override.
Running maps will not be restarted automatically for default memory changes.
EOF
  else
    cat <<EOF
Set memory for $map to $memory?

This will update the memory setting for $map.
If $map is currently running, it must restart for the new memory limit to apply.
EOF
  fi

  echo
  if [ "${DUNE_MEMORY_ASSUME_YES:-0}" = "1" ]; then
    return 0
  fi
  read -r -p "Continue? [y/N]: " answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) echo "Cancelled. No changes were made."; return 1 ;;
  esac
}

confirm_unset() {
  local map="$1"

  if [ "$map" = "default" ]; then
    cat <<'EOF'
Remove default memory setting?

Removing the default memory setting affects future spawned/restarted maps.
Running maps will not be restarted automatically for default memory removal.
EOF
  else
    cat <<EOF
Remove memory override for $map?

This will remove the custom memory setting for $map.
If $map is currently running, it must restart for the change to apply.
EOF
  fi

  echo
  if [ "${DUNE_MEMORY_ASSUME_YES:-0}" = "1" ]; then
    return 0
  fi
  read -r -p "Continue? [y/N]: " answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) echo "Cancelled. No changes were made."; return 1 ;;
  esac
}

set_memory() {
  local target="$1"
  local memory="$2"
  local map
  local key

  if ! validate_memory "$memory"; then
    echo "Invalid memory value: $memory"
    echo "Use values like 512m, 4096m, 4g, 8g, 12g, or 16g."
    exit 1
  fi

  if [ "${target,,}" = "default" ]; then
    confirm_set default "$memory" || exit 1
    set_env_raw DUNE_MEMORY_DEFAULT "$memory"
    echo "Set DUNE_MEMORY_DEFAULT=$memory"
    echo "New default applies to future spawned/restarted maps."
    return
  fi

  map="$(canonical_map "$target" || true)"
  if [ -z "$map" ]; then
    echo "Unknown map: $target"
    echo "Run: dune memory list-maps"
    exit 1
  fi

  confirm_set "$map" "$memory" || exit 1
  key="$(env_key_for "$map")"
  set_env_raw "$key" "$memory"
  echo "Set $key=$memory"
  restart_map_if_running "$map"
}

unset_memory() {
  local target="$1"
  local map
  local key

  if [ "${target,,}" = "default" ]; then
    confirm_unset default || exit 1
    unset_env_raw DUNE_MEMORY_DEFAULT
    echo "Removed DUNE_MEMORY_DEFAULT"
    echo "New default behavior applies to future spawned/restarted maps."
    return
  fi

  map="$(canonical_map "$target" || true)"
  if [ -z "$map" ]; then
    echo "Unknown map: $target"
    echo "Run: dune memory list-maps"
    exit 1
  fi

  confirm_unset "$map" || exit 1
  key="$(env_key_for "$map")"
  unset_env_raw "$key"
  echo "Removed $key"
  restart_map_if_running "$map"
}

cmd="${1:-status}"

case "$cmd" in
  status)
    show_status
    ;;
  list-maps)
    list_maps "${2:-table}"
    ;;
  set)
    if [ "$#" -ne 3 ]; then
      usage
      exit 2
    fi
    set_memory "$2" "$3"
    ;;
  set-no-restart)
    if [ "$#" -ne 3 ]; then
      usage
      exit 2
    fi
    DUNE_MEMORY_SKIP_RESTART=1 set_memory "$2" "$3"
    ;;
  unset)
    if [ "$#" -ne 2 ]; then
      usage
      exit 2
    fi
    unset_memory "$2"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown memory command: $cmd"
    usage
    exit 2
    ;;
esac
