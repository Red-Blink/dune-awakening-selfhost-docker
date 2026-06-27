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

docker compose exec -T orchestrator python3 - <<'PY' > runtime/generated/reset-world-partitions.sql
from pathlib import Path
import json
import re
import yaml

src = Path("/srv/dune/server/scripts/setup/templates/world-template.yaml")
text = src.read_text()
text = re.sub(r"\{([A-Z0-9_]+)\}", r"PLACEHOLDER_\1", text)
doc = yaml.safe_load(text)

world_partitions = (
    doc.get("spec", {})
       .get("database", {})
       .get("template", {})
       .get("spec", {})
       .get("deployment", {})
       .get("spec", {})
       .get("worldPartitions", [])
)

rows = []
for wp in world_partitions:
    map_name = wp["map"]
    for p in wp.get("partitions", []):
        definition = {
            "type": "box2d_array",
            "box": {
                "min_x": p.get("minX", 0),
                "min_y": p.get("minY", 0),
                "max_x": p.get("maxX", 1),
                "max_y": p.get("maxY", 1),
            },
        }
        rows.append({
            "partition_id": int(p["id"]),
            "map": map_name,
            "dimension_index": int(p.get("dimension", 0)),
            "blocked": bool(p.get("disable", False)),
            "definition": definition,
        })

def q(s):
    return "'" + str(s).replace("'", "''") + "'"

print("-- Generated from Funcom world-template.yaml")
print("-- Review before applying.")
print("begin;")
print("delete from dune.farm_state;")
print("update dune.world_partition set server_id = null;")
print("delete from dune.world_partition;")
print()
for r in rows:
    print(
        "insert into dune.world_partition "
        "(partition_id, server_id, map, partition_definition, dimension_index, blocked, label) values "
        f"({r['partition_id']}, null, {q(r['map'])}, "
        f"{q(json.dumps(r['definition'], separators=(',', ':')))}::jsonb, "
        f"{r['dimension_index']}, {'true' if r['blocked'] else 'false'}, null);"
    )

print()
print("select setval('dune.world_partition_partition_id_seq', (select max(partition_id) from dune.world_partition));")
print("select dune.update_partition_labels(true);")
print("commit;")
PY

echo "Wrote runtime/generated/reset-world-partitions.sql"
