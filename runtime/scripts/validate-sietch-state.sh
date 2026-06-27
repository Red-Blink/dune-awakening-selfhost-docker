#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

failures=0

ok() { printf 'OK   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; failures=$((failures + 1)); }
warn() { printf 'WARN %s\n' "$*" >&2; }

if bash -n runtime/scripts/sietches.sh runtime/scripts/publish-sietch-overrides.sh runtime/scripts/publish-deepdesert-overrides.sh runtime/scripts/publish-network-server-state-overrides.sh runtime/scripts/start-all.sh runtime/scripts/spawn-server.sh runtime/scripts/despawn-server.sh runtime/scripts/manager.sh runtime/scripts/doctor.sh runtime/scripts/dune; then
  ok "shell syntax"
else
  fail "shell syntax"
fi

if grep -q 'docs/' README.md; then
  fail "README still links to docs/"
else
  ok "README has no docs/ dependency"
fi

if grep -q '"isStartingMap": True' runtime/scripts/publish-sietch-overrides.sh \
  && grep -q 'payload\["isStartingMap"\] = True' runtime/scripts/publish-sietch-overrides.sh \
  && ! grep -q 'isStartingMap.*not .*ready' runtime/scripts/publish-sietch-overrides.sh; then
  ok "Survival_1 Sietch publisher preserves starting-map entries"
else
  fail "Survival_1 Sietch publisher does not preserve starting-map entries"
fi

if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck runtime/scripts/sietches.sh runtime/scripts/validate-sietch-state.sh; then
    ok "shellcheck"
  else
    fail "shellcheck"
  fi
else
  warn "shellcheck not installed; skipped"
fi

python3 <<'PY' || fail "dimension state simulation"
import copy
import json

def sync(config, rows):
    config = copy.deepcopy(config)
    config.setdefault("maps", {})
    partitions_cfg = config.setdefault("partitions", {})
    rows = sorted(rows, key=lambda r: (r["map"], r["dimension"], r["id"]))
    by_id = {str(r["id"]): r for r in rows}

    def meaningful(entry):
        return {k: v for k, v in dict(entry or {}).items() if k in {"display_name", "password"} and v not in ("", None)}

    def merge(dest, src):
        for key, value in meaningful(src).items():
            dest[key] = value

    for partition_id, entry in list(partitions_cfg.items()):
        state = meaningful(entry)
        if not state:
            continue
        row = by_id.get(str(partition_id))
        map_name = entry.get("map")
        dimension = entry.get("dimension")
        if row:
            map_name = row["map"]
            dimension = row["dimension"]
        if map_name is None or dimension is None:
            config.setdefault("orphaned_partition_user_state", {})[str(partition_id)] = state
            continue
        dim_entry = config.setdefault("maps", {}).setdefault(str(map_name), {}).setdefault("dimensions", {}).setdefault(str(int(dimension)), {})
        merge(dim_entry, state)

    new_partitions = {}
    for row in rows:
        pid = str(row["id"])
        map_name = row["map"]
        dimension = str(row["dimension"])
        dim_entry = config.setdefault("maps", {}).setdefault(map_name, {}).setdefault("dimensions", {}).setdefault(dimension, {})
        merge(dim_entry, partitions_cfg.get(pid, {}))
        mirrored = {"map": map_name, "dimension": int(dimension)}
        mirrored.update(meaningful(dim_entry))
        new_partitions[pid] = mirrored
    config["partitions"] = new_partitions
    return config

rows_1 = [{"id": 1, "map": "Survival_1", "dimension": 0}]
rows_2 = [{"id": 1, "map": "Survival_1", "dimension": 0}, {"id": 41, "map": "Survival_1", "dimension": 1}]
rows_2_recreated = [{"id": 1, "map": "Survival_1", "dimension": 0}, {"id": 55, "map": "Survival_1", "dimension": 1}]

config = {
    "maps": {"Survival_1": {"active_dimensions": 2, "max_dimensions": 2}},
    "partitions": {
        "1": {"display_name": "Sietch Abbir", "password": "secret"},
        "41": {"display_name": "Sietch Alraab", "password": "secret2"},
    },
}

config = sync(config, rows_2)
assert config["maps"]["Survival_1"]["dimensions"]["0"]["display_name"] == "Sietch Abbir"
assert config["maps"]["Survival_1"]["dimensions"]["1"]["password"] == "secret2"
config = sync(config, rows_1)
assert "41" not in config["partitions"]
assert config["maps"]["Survival_1"]["dimensions"]["1"]["display_name"] == "Sietch Alraab"
config = sync(config, rows_2_recreated)
assert config["partitions"]["55"]["display_name"] == "Sietch Alraab"
assert config["partitions"]["55"]["password"] == "secret2"
print("OK   dimension state survives 1 -> 2 -> 1 -> recreated 2")
PY

python3 <<'PY' || fail "usersettings mirror simulation"
import copy

def sync_usersettings(sietch_cfg, usersettings):
    usersettings = copy.deepcopy(usersettings)
    partitions = usersettings.setdefault("partitions", {})
    current_ids = set()
    for partition_id, entry in sietch_cfg.get("partitions", {}).items():
        if entry.get("map") != "Survival_1":
            continue
        current_ids.add(str(partition_id))
        target = partitions.setdefault(str(partition_id), {})
        engine = target.setdefault("userengine", {})
        display = entry.get("display_name") or ""
        password = entry.get("password") or ""
        if display:
            engine["server_display_name"] = display
        else:
            engine.pop("server_display_name", None)
        if password:
            engine["server_login_password"] = password
        else:
            engine.pop("server_login_password", None)
        if not engine:
            target.pop("userengine", None)
        if not target:
            partitions.pop(str(partition_id), None)
    for partition_id, target in list(partitions.items()):
        if partition_id in current_ids:
            continue
        engine = target.get("userengine", {})
        engine.pop("server_display_name", None)
        engine.pop("server_login_password", None)
        if not engine:
            target.pop("userengine", None)
        if not target:
            partitions.pop(partition_id, None)
    return usersettings

sietch_2 = {
    "partitions": {
        "1": {"map": "Survival_1", "dimension": 0, "display_name": "Sietch Abbir", "password": "secret"},
        "41": {"map": "Survival_1", "dimension": 1, "display_name": "Sietch Alraab"},
    }
}
sietch_1 = {
    "partitions": {
        "1": {"map": "Survival_1", "dimension": 0, "display_name": "Sietch Abbir", "password": "secret"},
    }
}
sietch_2_recreated = {
    "partitions": {
        "1": {"map": "Survival_1", "dimension": 0, "display_name": "Sietch Abbir", "password": "secret"},
        "55": {"map": "Survival_1", "dimension": 1, "display_name": "Sietch Alraab"},
    }
}

usersettings = {"partitions": {"999": {"userengine": {"server_display_name": "stale", "server_login_password": "stale"}}}}
usersettings = sync_usersettings(sietch_2, usersettings)
assert usersettings["partitions"]["1"]["userengine"]["server_display_name"] == "Sietch Abbir"
assert usersettings["partitions"]["41"]["userengine"]["server_display_name"] == "Sietch Alraab"
assert "999" not in usersettings["partitions"]
usersettings = sync_usersettings(sietch_1, usersettings)
assert "41" not in usersettings["partitions"]
usersettings = sync_usersettings(sietch_2_recreated, usersettings)
assert usersettings["partitions"]["55"]["userengine"]["server_display_name"] == "Sietch Alraab"
print("OK   usersettings mirror survives 1 -> 2 -> 1 -> recreated 2")
PY

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
  if runtime/scripts/sietches.sh sync >/tmp/dune-sietch-sync.out 2>/tmp/dune-sietch-sync.err; then
    ok "live sietch sync"
  else
    fail "live sietch sync"
    sed -n '1,20p' /tmp/dune-sietch-sync.err >&2 || true
  fi

  if runtime/scripts/sietches.sh validate >/tmp/dune-sietch-validate.out 2>/tmp/dune-sietch-validate.err; then
    ok "live sietch validation"
  else
    fail "live sietch validation"
    sed -n '1,40p' /tmp/dune-sietch-validate.out >&2 || true
    sed -n '1,20p' /tmp/dune-sietch-validate.err >&2 || true
  fi

  if runtime/scripts/sietches.sh reconcile Survival_1 >/tmp/dune-sietch-reconcile-1.out 2>/tmp/dune-sietch-reconcile-1.err; then
    ok "live Survival_1 reconcile"
  else
    fail "live Survival_1 reconcile"
    sed -n '1,40p' /tmp/dune-sietch-reconcile-1.out >&2 || true
    sed -n '1,20p' /tmp/dune-sietch-reconcile-1.err >&2 || true
  fi

  if runtime/scripts/sietches.sh reconcile Survival_1 >/tmp/dune-sietch-reconcile-2.out 2>/tmp/dune-sietch-reconcile-2.err; then
    ok "live Survival_1 reconcile is idempotent"
  else
    fail "live Survival_1 reconcile is idempotent"
    sed -n '1,40p' /tmp/dune-sietch-reconcile-2.out >&2 || true
    sed -n '1,20p' /tmp/dune-sietch-reconcile-2.err >&2 || true
  fi

  python3 <<'PY' || fail "live Survival_1 active-dimensions state"
import json
import subprocess
from pathlib import Path

config = json.loads(Path("runtime/generated/sietch-config.json").read_text())
usersettings = json.loads(Path("runtime/generated/usersettings.json").read_text()) if Path("runtime/generated/usersettings.json").exists() else {"partitions": {}}
target = int(config.get("maps", {}).get("Survival_1", {}).get("active_dimensions") or 1)

rows_raw = subprocess.check_output([
    "docker", "exec", "dune-postgres", "psql",
    "-U", "postgres", "-d", "dune", "-At", "-F", "\t",
    "-c",
    "select wp.partition_id, wp.dimension_index, coalesce(wp.server_id, ''), coalesce(wp.label, '') "
    "from dune.world_partition wp "
    "where lower(wp.map)=lower('Survival_1') "
    "order by wp.dimension_index, wp.partition_id;"
], text=True)
rows = []
for line in rows_raw.splitlines():
    if not line.strip():
        continue
    pid, dimension, server_id, label = line.split("\t", 3)
    rows.append({"partition_id": pid, "dimension": int(dimension), "server_id": server_id, "label": label})

assert rows, "no Survival_1 rows found"
assert len({(row["dimension"], row["partition_id"]) for row in rows}) == len(rows), "duplicate Survival_1 dimension/partition rows"

active = rows[:target]
assert len(active) == target, f"active_dimensions={target}, but only {len(active)} Survival_1 rows exist"

for row in active:
    pid = row["partition_id"]
    assert row["server_id"], f"Survival_1 partition {pid} has no server_id"
    sietch_entry = config.get("partitions", {}).get(pid)
    assert sietch_entry, f"sietch-config missing active Survival_1 partition {pid}"
    assert sietch_entry.get("map") == "Survival_1", f"sietch-config partition {pid} has wrong map"
    if sietch_entry.get("display_name"):
        ue = usersettings.get("partitions", {}).get(pid, {})
        assert ue.get("userengine", {}).get("server_display_name") == sietch_entry.get("display_name"), f"usersettings drift for partition {pid}"
    if sietch_entry.get("password"):
        ue = usersettings.get("partitions", {}).get(pid, {})
        assert ue.get("userengine", {}).get("server_login_password") == sietch_entry.get("password"), f"password drift for partition {pid}"

print(f"OK   live Survival_1 state is consistent for active_dimensions={target}")
PY
else
  warn "dune-postgres is not running; live DB validation skipped"
fi

rm -f /tmp/dune-sietch-sync.out /tmp/dune-sietch-sync.err /tmp/dune-sietch-validate.out /tmp/dune-sietch-validate.err
rm -f /tmp/dune-sietch-reconcile-1.out /tmp/dune-sietch-reconcile-1.err /tmp/dune-sietch-reconcile-2.out /tmp/dune-sietch-reconcile-2.err

if [ "$failures" -ne 0 ]; then
  printf '\n%d validation failure(s).\n' "$failures" >&2
  exit 1
fi

echo
echo "Sietch state validation passed."
