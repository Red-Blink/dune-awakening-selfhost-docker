#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "runtime" / "generated" / "usersettings.json"
SIETCH_CONFIG_PATH = ROOT / "runtime" / "generated" / "sietch-config.json"

ENGINE_FIELDS = {
    "port": (None, None, "7777"),
    "igw_port": (None, None, "7888"),
    "mining_output_multiplier": ("HarvestingSettings", "miningOutputMultiplier", "1.0"),
    "vehicle_mining_output_multiplier": ("HarvestingSettings", "vehicleMiningOutputMultiplier", "1.0"),
    "pvp_resource_multiplier": ("HarvestingSettings", "securityZonesPvpResourceMultiplier", "2.5"),
    "vehicle_durability_damage_multiplier": ("CombatSettings", "vehicleDurabilityDamageMultiplier", "1.0"),
    "sandstorm_enabled": ("SurvivalSettings", "sandstormEnabled", "1"),
    "sandstorm_treasure_enabled": ("SurvivalSettings", "sandStormTreasureEnabled", "1"),
    "sandworm_enabled": ("SurvivalSettings", "sandwormEnabled", "1"),
    "sandworm_collision_interaction": ("SurvivalSettings", "vehicleSandwormCollisionInteraction", "false"),
    "sandworm_danger_zones_enabled": ("SurvivalSettings", "sandwormDangerZonesEnabled", "true"),
    "sandworm_invulnerability_on_exit": ("SurvivalSettings", "vehicleSandwormInvulnerabilitySecondsOnExit", "900.0"),
    "sandworm_invulnerability_on_restart": ("SurvivalSettings", "vehicleSandwormInvulnerabilitySecondsOnServerRestart", "7200.0"),
}

MAP_FIELDS = {
    "security_zones_enabled": ("/Script/DuneSandbox.SecurityZonesSubsystem", "m_bAreSecurityZonesEnabled", "True"),
    "item_deterioration_rate": ("/Script/DuneSandbox.SecurityZonesSubsystem", "UpdateRateInSeconds", "1.0"),
    "coriolis_auto_spawn_enabled": ("/Script/DuneSandbox.SandStormConfig", "m_bCoriolisAutoSpawnEnabled", "True"),
    "max_landclaim_segments": ("/Script/DuneSandbox.BuildingSettings", "m_MaxNumLandclaimSegments", "6"),
    "building_blueprint_max_extensions": ("/Script/DuneSandbox.BuildingSettings", "m_BuildingBlueprintMaxExtensions", "4"),
    "base_backup_max_extensions": ("/Script/DuneSandbox.BuildingSettings", "m_BaseBackupMaxExtensions", "8"),
    "building_restriction_limits_enabled": ("/Script/DuneSandbox.BuildingSettings", "m_bBuildingRestrictionLimitsEnabled", "True"),
}

PARTITION_FIELDS = {
    "partition_pvp_enabled": (None, None, "False"),
    **MAP_FIELDS,
}


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {"engine": {}, "maps": {}, "partitions": {}}
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"engine": {}, "maps": {}, "partitions": {}}
    config.setdefault("engine", {})
    config.setdefault("maps", {})
    config.setdefault("partitions", {})
    return config


def atomic_write_text(path: Path, content: str, mode: int = 0o664) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / f".{path.name}.tmp.{os.getpid()}"
    tmp_path.write_text(content, encoding="utf-8")
    try:
        tmp_path.chmod(mode)
    except OSError:
        pass
    tmp_path.replace(path)
    try:
        path.chmod(mode)
    except OSError:
        pass


def save_config(config: dict) -> None:
    atomic_write_text(CONFIG_PATH, json.dumps(config, indent=2, sort_keys=True) + "\n")


def canonical_map(value: str) -> str:
    target = value.strip().lower()
    aliases = {
        "survival": "Survival_1",
        "survival-1": "Survival_1",
        "survival_1": "Survival_1",
        "overmap": "Overmap",
    }
    if target in aliases:
        return aliases[target]
    return value


def max_survival_dimensions() -> int:
    if SIETCH_CONFIG_PATH.exists():
        config = json.loads(SIETCH_CONFIG_PATH.read_text(encoding="utf-8"))
        value = config.get("maps", {}).get("Survival_1", {}).get("max_dimensions")
        try:
            parsed = int(value)
            if parsed > 0:
                return parsed
        except (TypeError, ValueError):
            pass
    return 4


def validate_port_ranges(config: dict, field_id: str, value: str) -> None:
    try:
        candidate = int(value)
    except ValueError as exc:
        raise SystemExit(f"{field_id} must be a positive integer.") from exc
    if candidate <= 0:
        raise SystemExit(f"{field_id} must be a positive integer.")

    engine = dict(config.get("engine", {}))
    engine[field_id] = str(candidate)
    client_start = int(engine.get("port") or ENGINE_FIELDS["port"][2])
    igw_start = int(engine.get("igw_port") or ENGINE_FIELDS["igw_port"][2])
    end_offset = max_survival_dimensions()
    client_end = client_start + end_offset
    igw_end = igw_start + end_offset
    if not (client_end < igw_start or igw_end < client_start):
        raise SystemExit(
            f"Configured Port range {client_start}-{client_end} intersects with IGWPort range {igw_start}-{igw_end}."
        )


def merged_engine_values(config: dict) -> dict[str, str]:
    values = {key: spec[2] for key, spec in ENGINE_FIELDS.items()}
    values.update(config.get("engine", {}))
    return values


def merged_map_values(config: dict, map_name: str) -> dict[str, str]:
    values = {key: spec[2] for key, spec in MAP_FIELDS.items()}
    values.update(config.get("maps", {}).get(map_name, {}))
    return values


def merged_partition_values(config: dict, map_name: str, partition_id: str) -> dict[str, str]:
    values = {key: spec[2] for key, spec in PARTITION_FIELDS.items()}
    values.update(config.get("maps", {}).get(map_name, {}))
    partition_entry = config.get("partitions", {}).get(str(partition_id), {})
    values.update(partition_entry.get("usergame", {}))
    return values


def print_rows(rows: dict[str, str], order: dict[str, tuple[str | None, str | None, str]]) -> int:
    for key in order:
        print(f"{key}\t{rows.get(key, '')}")
    return 0


def set_field(scope: str, name: str | None, field_id: str, value: str) -> int:
    config = load_config()
    if scope == "engine":
        if field_id not in ENGINE_FIELDS:
            raise SystemExit(f"Unknown engine field: {field_id}")
        if field_id in {"port", "igw_port"}:
            validate_port_ranges(config, field_id, value)
        config.setdefault("engine", {})[field_id] = value
    else:
        if field_id not in MAP_FIELDS:
            raise SystemExit(f"Unknown map field: {field_id}")
        map_name = canonical_map(name or "")
        config.setdefault("maps", {}).setdefault(map_name, {})[field_id] = value
    save_config(config)
    return 0


def set_partition_field(map_name: str, partition_id: str, field_id: str, value: str) -> int:
    if field_id not in PARTITION_FIELDS:
        raise SystemExit(f"Unknown partition field: {field_id}")
    config = load_config()
    entry = config.setdefault("partitions", {}).setdefault(str(partition_id), {})
    entry["map"] = canonical_map(map_name)
    entry.setdefault("usergame", {})[field_id] = value
    save_config(config)
    return 0


def reset_all() -> int:
    if CONFIG_PATH.exists():
        CONFIG_PATH.unlink()
    return 0


def write_userengine_ini(path: Path, values: dict[str, str]) -> None:
    section_order = ["HarvestingSettings", "CombatSettings", "SurvivalSettings"]
    section_lines: dict[str, list[str]] = {section: [] for section in section_order}
    for field_id, (section, key, _) in ENGINE_FIELDS.items():
        if section is None or key is None:
            continue
        value = values.get(field_id, "")
        if value == "":
            continue
        section_lines.setdefault(section, []).append(f"{key}={value}")

    lines: list[str] = []
    for section in section_order:
        entries = section_lines.get(section, [])
        if not entries:
            continue
        if lines:
            lines.append("")
        lines.append(f"[{section}]")
        lines.extend(entries)
    atomic_write_text(path, "\n".join(lines) + "\n")


def truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def write_usergame_ini(path: Path, values: dict[str, str], partition_id: str | None = None) -> None:
    lines = ["[/Script/DuneSandbox.PvpPveSettings]"]
    if partition_id:
        prefix = "" if truthy(values.get("partition_pvp_enabled", "False")) else ";"
        lines.append(f"{prefix}+m_PvpEnabledPartitions={partition_id}")
    else:
        lines.append(";+m_PvpEnabledPartitions=1")
        lines.append(";+m_PvpEnabledPartitions=2")

    lines.extend([
        "",
        "[/Script/DuneSandbox.SecurityZonesSubsystem]",
        f"m_bAreSecurityZonesEnabled={values.get('security_zones_enabled', MAP_FIELDS['security_zones_enabled'][2])}",
        f"UpdateRateInSeconds={values.get('item_deterioration_rate', MAP_FIELDS['item_deterioration_rate'][2])}",
        "",
        "[/Script/DuneSandbox.SandStormConfig]",
        f"m_bCoriolisAutoSpawnEnabled={values.get('coriolis_auto_spawn_enabled', MAP_FIELDS['coriolis_auto_spawn_enabled'][2])}",
        "",
        "[/Script/DuneSandbox.BuildingSettings]",
        f"m_MaxNumLandclaimSegments={values.get('max_landclaim_segments', MAP_FIELDS['max_landclaim_segments'][2])}",
        f"m_BuildingBlueprintMaxExtensions={values.get('building_blueprint_max_extensions', MAP_FIELDS['building_blueprint_max_extensions'][2])}",
        f"m_BaseBackupMaxExtensions={values.get('base_backup_max_extensions', MAP_FIELDS['base_backup_max_extensions'][2])}",
        f"m_bBuildingRestrictionLimitsEnabled={values.get('building_restriction_limits_enabled', MAP_FIELDS['building_restriction_limits_enabled'][2])}",
    ])
    atomic_write_text(path, "\n".join(lines) + "\n")


def safe_runtime_dir_name(map_name: str, partition_id: str) -> str:
    raw = f"{map_name}-{partition_id}".lower()
    chars: list[str] = []
    previous_dash = False
    for char in raw:
        if char.isalnum():
            chars.append(char)
            previous_dash = False
        else:
            if not previous_dash:
                chars.append("-")
                previous_dash = True
    return "".join(chars).strip("-")


def materialize_current_runtime_files() -> int:
    config = load_config()
    game_root = ROOT / "runtime" / "game"
    partition_catalog_path = SIETCH_CONFIG_PATH.parent / "partition-catalog.json"
    if not game_root.exists():
        return 0

    targets: list[tuple[str, Path, str | None]] = []

    overmap_dir = game_root / "overmap" / "Saved"
    if overmap_dir.exists():
        targets.append(("Overmap", overmap_dir, None))

    survival_dir = game_root / "survival-1" / "Saved"
    if survival_dir.exists():
        targets.append(("Survival_1", survival_dir, "1"))

    catalog_rows = []
    if partition_catalog_path.exists():
        try:
            catalog_rows = json.loads(partition_catalog_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            catalog_rows = []

    seen_paths = {path.resolve() for _, path, _ in targets if path.exists()}
    for row in catalog_rows:
        map_name = str(row.get("map", "")).strip()
        partition_id = str(row.get("id", "")).strip()
        if not map_name or not partition_id:
            continue
        saved_dir = game_root / safe_runtime_dir_name(map_name, partition_id) / "Saved"
        if not saved_dir.exists():
            continue
        resolved = saved_dir.resolve()
        if resolved in seen_paths:
            continue
        targets.append((canonical_map(map_name), saved_dir, partition_id))
        seen_paths.add(resolved)

    for map_name, saved_dir, partition_id in targets:
        user_settings_dir = saved_dir / "UserSettings"
        user_settings_dir.mkdir(parents=True, exist_ok=True)
        write_userengine_ini(user_settings_dir / "UserEngine.ini", merged_engine_values(config))
        if partition_id:
            values = merged_partition_values(config, canonical_map(map_name), str(partition_id))
        else:
            values = merged_map_values(config, canonical_map(map_name))
        write_usergame_ini(user_settings_dir / "UserGame.ini", values, partition_id)
    return 0


def materialize(map_name: str, saved_dir: str, partition_id: str | None = None) -> int:
    config = load_config()
    target_map = canonical_map(map_name)
    user_settings_dir = Path(saved_dir) / "UserSettings"
    user_settings_dir.mkdir(parents=True, exist_ok=True)
    write_userengine_ini(user_settings_dir / "UserEngine.ini", merged_engine_values(config))
    if partition_id:
        values = merged_partition_values(config, target_map, str(partition_id))
    else:
        values = merged_map_values(config, target_map)
    write_usergame_ini(user_settings_dir / "UserGame.ini", values, str(partition_id) if partition_id else None)
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        return 2

    command = argv[1]
    config = load_config()

    if command == "engine-values":
        return print_rows(merged_engine_values(config), ENGINE_FIELDS)
    if command == "map-values" and len(argv) == 3:
        return print_rows(merged_map_values(config, canonical_map(argv[2])), MAP_FIELDS)
    if command == "partition-values" and len(argv) == 4:
        return print_rows(merged_partition_values(config, canonical_map(argv[2]), argv[3]), PARTITION_FIELDS)
    if command == "engine-set" and len(argv) == 4:
        return set_field("engine", None, argv[2], argv[3])
    if command == "map-set" and len(argv) == 5:
        return set_field("map", argv[2], argv[3], argv[4])
    if command == "partition-set" and len(argv) == 6:
        return set_partition_field(argv[2], argv[3], argv[4], argv[5])
    if command == "reset-all":
        return reset_all()
    if command == "materialize-current":
        return materialize_current_runtime_files()
    if command == "materialize" and len(argv) == 4:
        return materialize(argv[2], argv[3])
    if command == "materialize" and len(argv) == 5:
        return materialize(argv[2], argv[3], argv[4])

    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
