#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p runtime/generated

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
source runtime/scripts/runtime-env.sh
source runtime/scripts/image-tags.sh
[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env

SERVER_REGION="$(resolve_server_region)"
SERVER_IP="$(resolve_server_ip)"
export SERVER_REGION SERVER_IP
catalog_extract_timeout_seconds="${DUNE_CATALOG_EXTRACT_TIMEOUT_SECONDS:-120}"
catalog_output="runtime/generated/partition-catalog.json"
catalog_tmp="$(mktemp "${catalog_output}.tmp.XXXXXX")"
orchestrator_container="$(dune_compose_running_service_container "$DUNE_COMPOSE_PROJECT_NAME" orchestrator 2>/dev/null || true)"

if [ -z "$orchestrator_container" ]; then
  echo "The orchestrator container is not running; cannot extract the partition catalog." >&2
  exit 1
fi

cleanup_catalog_tmp() {
  rm -f -- "$catalog_tmp"
}
trap cleanup_catalog_tmp EXIT

echo "Extracting partition catalog from world-template.yaml..."

timeout --kill-after=2s "${catalog_extract_timeout_seconds}s" docker exec -i "$orchestrator_container" python3 - > "$catalog_tmp" <<'PY'
import json
import re
import sys
from pathlib import Path
import yaml

src = Path("/srv/dune/server/scripts/setup/templates/world-template.yaml")
text = src.read_text()
text = re.sub(r"\{([A-Z0-9_]+)\}", r"PLACEHOLDER_\1", text)

doc = yaml.safe_load(text)

db = (
    doc.get("spec", {})
       .get("database", {})
       .get("template", {})
       .get("spec", {})
       .get("deployment", {})
       .get("spec", {})
)

world_partitions = db.get("worldPartitions", [])

rows = []
for wp in world_partitions:
    map_name = wp.get("map")
    for p in wp.get("partitions", []):
        rows.append({
            "map": map_name,
            "id": p.get("id"),
            "dimension": p.get("dimension"),
            "disable": p.get("disable"),
            "minX": p.get("minX"),
            "minY": p.get("minY"),
            "maxX": p.get("maxX"),
            "maxY": p.get("maxY"),
        })

json.dump(rows, sys.stdout, indent=2)
sys.stdout.write("\n")

print(f"partitions: {len(rows)}", file=sys.stderr)
for r in rows:
    print(
        f"id={str(r['id']).rjust(3)} "
        f"map={r['map']} "
        f"dim={r['dimension']} "
        f"disabled={r['disable']} "
        f"box=({r['minX']},{r['minY']})-({r['maxX']},{r['maxY']})",
        file=sys.stderr,
    )
PY

if [ ! -s "$catalog_tmp" ]; then
  echo "Generated partition catalog is empty." >&2
  exit 1
fi

# Temporary upstream omission (issue #268). Use the same image as dune spawn;
# preserve native definitions and skip builds without the event map assets.
python3 runtime/scripts/supplement-event-partitions.py "$catalog_tmp" \
  "$(resolve_game_server_image CB_Halloween_Event_Shipwreck_01)"

chmod 0644 "$catalog_tmp"
mv -f -- "$catalog_tmp" "$catalog_output"
trap - EXIT

echo
echo "Wrote $catalog_output"
