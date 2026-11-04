#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

# Inspect the actual configuration emitted by startup, including appended
# map sections. Do not start Docker or touch the live Director configuration.
python3 - "$repo_root/runtime/scripts/start-director.sh" <<'PY'
import configparser
from pathlib import Path
import re
import sys

script = Path(sys.argv[1]).read_text()
blocks = re.findall(
    r"cat (?:>|>>) runtime/director/config/director_config.ini <<'EOF'\n(.*?)\nEOF",
    script, re.S,
)
assert len(blocks) == 2, "Director startup configuration blocks were not found"
config = configparser.ConfigParser(strict=True)
config.read_string("\n".join(blocks))

# Funcom's 2147284 stock director_config.ini sets both values for these maps.
# Spare partitions do not enforce admission: the Director must not pack the
# second player into the first player's story.
solo_maps = [
    "CB_Story_Hephaestus",
    "CB_Story_Ecolab_Carthag",
    "CB_Story_WaterFatManor",
    "CB_Arrakis_Generic_Sietch_Room",
    "CB_Arrakis_Story_Paranoid_PrayerRoom",
    "CB_Arrakis_Story_Glutton_DiningRoom",
    "CB_Story_DestroyedZanovar",
    "CB_Story_OrbitalMonitor",
]
for map_name in solo_maps:
    cap = config.getint(map_name, "PlayerHardCap", fallback=config.getint("Server", "PlayerHardCap"))
    assert cap == 1, f"{map_name} admits {cap} players instead of the stock solo limit"
    assert config.getboolean(map_name, "KeepPartiesTogether") is False, map_name
    assert config.getint(map_name, "NumExtraServers") == 0, map_name

# Funcom's Steam 26324834 Director defines Halloween as one four-player
# party per classical instance, matching the client FirstOfGroup contract.
event_map = "CB_Halloween_Event_Shipwreck_01"
assert config.get("InstancingModes", event_map, fallback=None) == "ClassicalInstancing", \
    "Halloween must retain the native classical-instancing mode"
assert config.getint(event_map, "PlayerHardCap", fallback=config.getint("Server", "PlayerHardCap")) == 4, \
    "Halloween must admit four players, not inherit the global hard cap"
assert config.getint(event_map, "MaxParties", fallback=0) == 1, \
    "Halloween must isolate parties, not individual party members"
assert config.get(event_map, "QueueFailMap", fallback=None) == "Overmap"
# Neither flag is overridden by the native event section. In particular,
# the global AllowGroupTravel=false also exists in Funcom's co-op config.
assert not config.has_option(event_map, "KeepPartiesTogether")
assert not config.has_option(event_map, "AllowGroupTravel")
assert config.getboolean("Server", "AllowGroupTravel") is False

# Shared maps keep their existing limits and instancing modes.
assert config.getint("Server", "PlayerHardCap") == 40
assert config.getint("Survival_1", "PlayerHardCap") == 60
assert config.getint("DeepDesert_1", "PlayerHardCap") == 80
for map_name in ["SH_Arrakeen", "SH_HarkoVillage"]:
    assert config.getint(map_name, "PlayerHardCap") == 80
for map_name in ["CB_Dungeon_Hephaestus", "CB_Dungeon_OldCarthag", "CB_Dungeon_ThePit"]:
    assert not config.has_option(map_name, "PlayerHardCap"), map_name
assert config.get("InstancingModes", "Survival_1") == "Dimension"
assert config.get("InstancingModes", "DeepDesert_1") == "Dimension"
print("PASS: solo story limits, four-player single-party Halloween admission, and shared maps retain their contracts")
PY
