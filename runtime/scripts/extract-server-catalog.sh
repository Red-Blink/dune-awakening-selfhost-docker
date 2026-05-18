#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p runtime/generated

docker compose exec -T orchestrator python3 - <<'PY'
from pathlib import Path
import json
import re
import yaml

src = Path("/srv/dune/server/scripts/setup/templates/world-template.yaml")
text = src.read_text()

# Replace Funcom placeholders so YAML can parse.
text = re.sub(r"\{([A-Z0-9_]+)\}", r"PLACEHOLDER_\1", text)

doc = yaml.safe_load(text)

spec = doc.get("spec", {})
server_group = spec.get("serverGroup", {})
template = server_group.get("template", {})
template_spec = template.get("spec", {})

sets = template_spec.get("sets", [])

catalog = []

for i, s in enumerate(sets):
    name = s.get("name") or s.get("metadata", {}).get("name") or f"server-set-{i}"
    map_name = s.get("map")
    image = s.get("image")
    args = s.get("args") or s.get("command") or []
    env = s.get("env") or s.get("envVars") or []
    resources = s.get("resources") or {}

    catalog.append({
        "index": i,
        "name": name,
        "map": map_name,
        "image": image,
        "args": args,
        "env": env,
        "resources": resources,
        "raw": s,
    })

out = Path("/work/server-catalog.json")
out.write_text(json.dumps(catalog, indent=2), encoding="utf-8")

print(f"server sets: {len(catalog)}")
for item in catalog:
    print(f"{item['index']:02d} name={item['name']} map={item['map']}")
PY

docker compose cp orchestrator:/work/server-catalog.json runtime/generated/server-catalog.json

echo
echo "Wrote runtime/generated/server-catalog.json"
