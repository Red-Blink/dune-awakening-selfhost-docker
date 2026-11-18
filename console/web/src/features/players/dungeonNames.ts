import { friendlyMapName, hasFriendlyMapName } from "../maps/mapNames";

// dungeon_completion stores the dungeon asset. A numbered one (DA_Dgn_089_Radiation)
// shares its number with the map (CB_Ecolab_Bronze_Green_089); a named one
// (DA_Dgn_Pit) matches CB_Dungeon_<Name>, sometimes with "The" (CB_Dungeon_ThePit).
const NUMBERED_DUNGEON_ID = /^DA_Dgn_(\d{3})_(.+)$/i;
const NAMED_DUNGEON_ID = /^DA_Dgn_(.+)$/i;

export function dungeonDisplayName(dungeonId: string) {
  const id = dungeonId.trim();
  const numbered = NUMBERED_DUNGEON_ID.exec(id);
  if (numbered) {
    const map = `CB_Ecolab_Bronze_Green_${numbered[1]}`;
    return hasFriendlyMapName(map) ? friendlyMapName(map) : numbered[2].replace(/_/g, " ");
  }
  const named = NAMED_DUNGEON_ID.exec(id);
  if (named) {
    const map = [`CB_Dungeon_${named[1]}`, `CB_Dungeon_The${named[1]}`].find(hasFriendlyMapName);
    return map ? friendlyMapName(map) : named[1].replace(/_/g, " ");
  }
  return id || "Unknown";
}

export function formatDungeonDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  const parts = hours > 0 ? [String(hours), pad(minutes), pad(totalSeconds % 60)] : [String(minutes), pad(totalSeconds % 60)];
  return parts.join(":");
}
