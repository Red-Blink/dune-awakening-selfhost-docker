#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p runtime/generated

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/runtime-env.sh
source runtime/scripts/image-tags.sh

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

# A game build can ship an instanced map before Funcom's template lists it (see
# partition_stopgaps.py). A stopgap applies only while the game image ships its map.
mapfile -t stopgap_umaps < <(python3 runtime/scripts/partition_stopgaps.py umaps)
shipped_umaps=()
if [ "${#stopgap_umaps[@]}" -gt 0 ]; then
  game_image="$(resolve_game_server_image)"
  pak_grep_args=()
  for umap in "${stopgap_umaps[@]}"; do
    pak_grep_args+=(-e "$umap")
  done
  pak_rc=0
  pak_hits=""
  # Never let this check pull the multi-GB game image.
  if docker image inspect "$game_image" >/dev/null 2>&1; then
    pak_hits="$(timeout --kill-after=2s "${catalog_extract_timeout_seconds}s" \
      docker run --rm --network=none --pull=never --entrypoint grep "$game_image" \
        -rahoF --include='*.utoc' "${pak_grep_args[@]}" /home/dune/server/DuneSandbox/Content/Paks)" || pak_rc=$?
  else
    pak_rc=2
  fi
  # grep exits 1 for "no match"; anything above that means the image could not be read.
  if [ "$pak_rc" -le 1 ]; then
    mapfile -t shipped_umaps < <(printf '%s\n' "$pak_hits" | sed '/^$/d' | sort -u)
  else
    echo "Could not read the game image paks ($game_image); skipping stopgap partitions." >&2
  fi
fi
python3 runtime/scripts/partition_stopgaps.py apply "$catalog_tmp" "${shipped_umaps[@]}"

chmod 0644 "$catalog_tmp"
mv -f -- "$catalog_tmp" "$catalog_output"
trap - EXIT

echo
echo "Wrote $catalog_output"
