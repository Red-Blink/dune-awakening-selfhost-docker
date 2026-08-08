// Two keyspaces resolve through this one table. Most callers hold a *service*
// id (survival_1, sh_arrakeen) from the runtime; anything reading dune.actors
// instead holds the *game's* map name (HaggaBasin, DeepDesert), which is a
// different string for the same place. Both are listed so callers need not
// know which kind of id they were handed.
const MAP_FRIENDLY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  haggabasin: "Hagga Basin",
  deepdesert: "Deep Desert",
  harkovillage: "Harko Village",
  overland: "Overland",
  survival_1: "Hagga Basin",
  overmap: "Overland",
  sh_arrakeen: "Arrakeen",
  sh_harkovillage: "Harko Village",
  deepdesert_1: "Deep Desert",
  cb_ecolab_bronze_green_089: "RadiationLab",
  cb_ecolab_bronze_green_152: "ElectricityLab",
  cb_ecolab_bronze_green_024: "Darkness",
  cb_ecolab_bronze_green_195: "PoisonLab",
  cb_ecolab_bronze_green_136: "Fire Lab",
  cb_dungeon_thepit: "The Old Quarry",
  cb_dungeon_hephaestus: "Wreck Of Hephaestus",
  cb_dungeon_oldcarthag: "Ruins Of Old Carthag",
  cb_overland_m_01: "Wreck of the Tyche",
  cb_overland_s_04: "Blushing Cavern",
  cb_overland_s_06: "Smugglers Run",
  cb_overland_s_07: "Ruins of Tsimpo",
  cb_overland_s_08: "Wind Pass",
  cb_story_banditfortress01: "The Broodworks",
  story_artofkanly: "New Carthag",
  story_heighlinerdungeon: "Fallen Light",
  cb_story_hephaestus: "Wreck of Hephaestus",
  cb_story_waterfatmanor: "The Water Fat",
  cb_story_ecolab_carthag: "Old Carthag",
  story_procesverbal: "Proces Verbal Private Room",
  dlc_story_lostharvest_ecolaba: "Lost Harvest Ecolab A",
  dlc_story_lostharvest_ecolabb: "Lost Harvest Ecolab B",
  dlc_story_lostharvest_forgottenlab: "Lost Harvest Forgotten Lab",
  story_faction_outpost_atre: "Arsunt Garrison (Atreides)",
  story_faction_outpost_hark: "Arsunt Garrison (Harkonnen)"
});

export function friendlyMapName(mapId: unknown) {
  const rawId = String(mapId || "").trim();
  return MAP_FRIENDLY_NAMES[rawId.toLowerCase()] || rawId || "Unknown Map";
}

export function hasFriendlyMapName(mapId: unknown) {
  return Object.hasOwn(MAP_FRIENDLY_NAMES, String(mapId || "").trim().toLowerCase());
}
