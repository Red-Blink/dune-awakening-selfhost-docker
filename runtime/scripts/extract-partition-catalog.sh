#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p runtime/generated

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
source runtime/scripts/runtime-env.sh

SERVER_REGION="$(resolve_server_region)"
SERVER_IP="$(resolve_server_ip)"
export SERVER_REGION SERVER_IP
catalog_extract_timeout_seconds="${DUNE_CATALOG_EXTRACT_TIMEOUT_SECONDS:-120}"

echo "Extracting partition catalog from world-template.yaml..."

timeout --kill-after=2s "${catalog_extract_timeout_seconds}s" docker compose exec -T orchestrator python3 - <<'PY'
from pathlib import Path
import json
import re
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

out = Path("/work/partition-catalog.json")
out.write_text(json.dumps(rows, indent=2), encoding="utf-8")

print(f"partitions: {len(rows)}")
for r in rows:
    print(
        f"id={str(r['id']).rjust(3)} "
        f"map={r['map']} "
        f"dim={r['dimension']} "
        f"disabled={r['disable']} "
        f"box=({r['minX']},{r['minY']})-({r['maxX']},{r['maxY']})"
    )
PY

timeout --kill-after=2s "${catalog_extract_timeout_seconds}s" docker compose exec -T orchestrator cat /work/partition-catalog.json > runtime/generated/partition-catalog.json

echo
echo "Wrote runtime/generated/partition-catalog.json"
