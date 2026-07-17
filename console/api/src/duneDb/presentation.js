const CUMULATIVE_XP_BY_LEVEL = [
  0, 40, 215, 440, 740, 1240, 1790, 2390, 2990, 3590, 4190,
  4790, 5390, 5990, 6590, 7190, 7790, 8390, 8990, 9590, 10190,
  10790, 11390, 11990, 12590, 13190, 13790, 14390, 14990, 15590, 16190,
  16790, 17390, 17990, 18590, 19190, 19790, 20390, 20990, 21590, 22190,
  22790, 23390, 23990, 24590, 25190, 25790, 26390, 26990, 27590, 28190,
  28790, 29390, 29990, 30590, 31190, 31790, 32390, 32990, 33590, 34190,
  34790, 35390, 35990, 36590, 37190, 37790, 38390, 38990, 39590, 40190,
  40790, 41390, 41990, 42590, 43190, 43790, 44390, 44990, 45590, 46190,
  46790, 47390, 47990, 48590, 49190, 49790, 50390, 50990, 51590, 52190,
  52790, 53390, 53990, 54590, 55190, 55790, 56390, 56990, 57590, 58190,
  58840, 59490, 60140, 60790, 61440, 62090, 62740, 63390, 64040, 64690,
  65340, 65990, 66640, 67290, 67940, 68590, 69240, 69890, 70540, 71190,
  71840, 72490, 73140, 73790, 74440, 75090, 75740, 76391, 77044, 77699,
  78357, 79018, 79683, 80353, 81030, 81714, 82407, 83110, 83825, 84554,
  85298, 86060, 86842, 87646, 88475, 89332, 90220, 91141, 92100, 93099,
  94143, 95235, 96380, 97582, 98845, 100175, 101576, 103054, 104614, 106263,
  108006, 109849, 111799, 113862, 116046, 118358, 120806, 123397, 126139, 129041,
  132112, 135360, 138795, 142426, 146263, 150316, 154596, 159114, 163880, 168906,
  174203, 179784, 185661, 191846, 198353, 205195, 212385, 219938, 227868, 236190,
  244918, 254069, 263657, 273700, 284213, 295214, 306719, 318746, 331314, 344440
];

const FACTION_TIER_THRESHOLDS = [0, 99, 249, 499, 999, 1999, 2224, 2524, 2899, 3349, 3874, 4474, 5149, 5899, 6724, 7624, 8599, 9649, 10774, 11974, 12474];

export function xpToLevel(xp) {
  if (xp <= 0) return 0;
  let lo = 1;
  let hi = CUMULATIVE_XP_BY_LEVEL.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (CUMULATIVE_XP_BY_LEVEL[mid] <= xp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function factionDisplayName(row) {
  return row.faction_name || (row.faction_id ? `Faction ${row.faction_id}` : "Unassigned");
}

export function journeyParentId(nodeId, allNodeIds) {
  const ids = new Set(allNodeIds);
  const parts = String(nodeId || "").split(".");
  while (parts.length > 1) {
    parts.pop();
    const parent = parts.join(".");
    if (ids.has(parent)) return parent;
  }
  return "";
}

export function journeyDepth(nodeId, allNodeIds) {
  let depth = 0;
  let parent = journeyParentId(nodeId, allNodeIds);
  while (parent) {
    depth += 1;
    parent = journeyParentId(parent, allNodeIds);
  }
  return depth;
}

export function journeyDisplayName(value, aliases = {}) {
  const alias = String(aliases?.[String(value || "")] || "").trim();
  if (alias) return alias;
  const raw = String(value || "").split(".").pop() || String(value || "");
  return raw
    .replace(/^(DA_|CT_|LDR_|FQ_|Dunipedia_)/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim() || String(value || "");
}

export function compareJourneyCatalogOrder(left, right, journeyData = {}) {
  const a = String(left || "");
  const b = String(right || "");
  if (a === b) return 0;
  const aParts = a.split(".");
  const bParts = b.split(".");
  const sharedLength = Math.min(aParts.length, bParts.length);
  let shared = 0;
  while (shared < sharedLength && aParts[shared] === bParts[shared]) shared += 1;
  if (shared === sharedLength) return aParts.length - bParts.length;

  const parentId = aParts.slice(0, shared).join(".");
  const siblings = Array.isArray(journeyData?.journey_children?.[parentId])
    ? journeyData.journey_children[parentId]
    : [];
  const aId = aParts.slice(0, shared + 1).join(".");
  const bId = bParts.slice(0, shared + 1).join(".");
  const aIndex = siblings.indexOf(aId);
  const bIndex = siblings.indexOf(bId);
  if (aIndex >= 0 || bIndex >= 0) {
    if (aIndex < 0) return 1;
    if (bIndex < 0) return -1;
    if (aIndex !== bIndex) return aIndex - bIndex;
  }
  return aId.localeCompare(bId);
}

export function tutorialStatus(value) {
  if (Number(value) === 2) return "Complete";
  if (Number(value) === 1) return "Started";
  return "Not Started";
}

export function tagsForJourneyNodeSubtree(nodeId, journeyTagsData = {}) {
  const tagMap = journeyTagsData?.journey_node_tags || {};
  const prefix = `${nodeId}.`;
  const seen = new Set();
  const tags = [];
  const add = (items = []) => {
    for (const item of items) {
      const tag = String(item || "").trim();
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  };
  add(tagMap[nodeId]);
  for (const [id, items] of Object.entries(tagMap)) {
    if (String(id).startsWith(prefix)) add(items);
  }
  return tags;
}

export function journeyCompletionNodeIds(nodeId, journeyTagsData = {}) {
  const safeNodeId = String(nodeId || "").trim();
  if (!safeNodeId) return [];
  const ids = new Set();
  const parts = safeNodeId.split(".");

  for (let i = 2; i <= parts.length; i += 1) {
    ids.add(parts.slice(0, i).join("."));
  }

  const prefix = `${safeNodeId}.`;
  for (const id of Object.keys(journeyTagsData?.journey_node_tags || {})) {
    if (String(id).startsWith(prefix)) ids.add(String(id));
  }

  return [...ids];
}

export function factionTierBumps(tags) {
  const out = new Map();
  for (const tag of tags) {
    const match = /^Faction\.([A-Za-z]+)\.Tier([0-5])$/.exec(String(tag || ""));
    if (!match) continue;
    const tier = Number(match[2]);
    const rep = tier > 0 ? FACTION_TIER_THRESHOLDS[tier] + 1 : 0;
    const current = out.get(match[1]) || 0;
    if (rep > current) out.set(match[1], rep);
  }
  return out;
}

export function factionIdByName(name) {
  if (name === "Atreides") return 1;
  if (name === "Harkonnen") return 2;
  if (name === "None") return 3;
  if (name === "Smuggler") return 4;
  return 0;
}

export function validateRecipeId(value) {
  const recipeId = String(value || "").trim();
  if (!/^[A-Za-z0-9_().-]+$/.test(recipeId)) throw new Error("Crafting recipe ID is invalid");
  return recipeId;
}

export function recipeDisplayName(recipeId) {
  return String(recipeId || "")
    .replace(/_?recipe$/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim() || recipeId;
}

export function recipeCategory(recipeId) {
  const value = String(recipeId || "").toLowerCase();
  if (/(buggy|sandbike|vehicle|treadwheel|ornithopter|sandcrawler)/.test(value)) return "Vehicles";
  if (/(stillsuit|literjon|bloodsack|blood_sack|bodyfluid|dew|water|stilltent)/.test(value)) return "Water Discipline";
  if (/(ammo|rifle|pistol|shotgun|smg|weapon|lasgun|flamethrower|staticcompactor|kindjal|crysknife|knife|sword|shield|napalm|disruptor)/.test(value)) return "Combat";
  if (/(building|basebackup|portablelight|decajon|totem|refinery|container|fabricator|placeable|structure|generator|turbine|pentashield|silo|lighting)/.test(value)) return "Construction";
  if (/(scanner|powerpack|radiation|cutteray|miningtool|mining_tool|thumper|suspensor|fuel|harvester)/.test(value)) return "Exploration";
  return "Essentials";
}

export function schematicRecipeId(itemId) {
  const raw = String(itemId || "").trim();
  if (!raw) return "";
  if (raw === "NPE_ScrapMetalKnife_Schematic") return "ScrapMetalKnifeRecipe";
  if (raw.endsWith("_Schematic")) return `${raw.slice(0, -"_Schematic".length)}_Recipe`;
  if (raw.endsWith("Schematic")) return `${raw.slice(0, -"Schematic".length)}Recipe`;
  if (raw.startsWith("Schematic_")) return `${raw.slice("Schematic_".length)}Recipe`;
  return "";
}

export function craftingRecipeCatalogRows(items = []) {
  return items
    .filter((item) => {
      const category = String(item?.category || "").toLowerCase();
      const itemId = String(item?.id || "");
      return category === "schematics" || (category === "buildings" && itemId.endsWith("_Patent"));
    })
    .map((item) => {
      const category = String(item?.category || "").toLowerCase();
      const recipeId = category === "buildings" ? String(item.id || "") : schematicRecipeId(item.id);
      if (!recipeId) return null;
      return {
        recipeId,
        displayName: String(item.name || "").trim() || recipeDisplayName(recipeId),
        category: recipeCategory(recipeId),
        source: category === "buildings" ? "Building Patents" : "Schematics",
        qualityLevel: 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.recipeId.localeCompare(b.recipeId));
}

export function validateResearchKey(value) {
  const itemKey = String(value || "").trim();
  if (!/^[A-Za-z0-9_().+\-]+$/.test(itemKey)) throw new Error("Research key is invalid");
  return itemKey;
}

export function researchRecipeId(itemKey) {
  const value = String(itemKey || "");
  if (value.startsWith("RCP_")) return value.slice(4);
  if (value.startsWith("BLD_")) {
    const recipeId = value.slice(4);
    return recipeId.endsWith("_Patent") ? recipeId : `${recipeId}_Patent`;
  }
  return "";
}

export function researchDisplayName(itemKey) {
  return String(itemKey || "")
    .replace(/^(RCP_|DA_GRP_|BLD_)/, "")
    .replace(/_?Patent$/i, "")
    .replace(/_?Recipe$/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim() || itemKey;
}

export function researchType(itemKey) {
  const value = String(itemKey || "");
  if (value.startsWith("RCP_")) return "Recipe";
  if (value.startsWith("BLD_")) return "Building";
  if (value.startsWith("DA_GRP_")) return "Group";
  return "Research";
}

export function researchCategory(itemKey) {
  const value = String(itemKey || "").toLowerCase();
  if (/(unique|recyclerdummy)/.test(value)) return "Uniques";
  if (/(vehicle|sandbike|buggy|orni|ornithopter|thopter|repairtool|welding|fuel)/.test(value)) return "Vehicles";
  if (/(stillsuit|literjon|blood|dew|water|windtrap|cistern|exsanguination|stilltent)/.test(value)) return "Water Discipline";
  if (/(armor|ammo|rifle|pistol|shotgun|smg|lmg|weapon|lasgun|compactor|kindjal|crysknife|knife|sword|shield|napalm|dirk|rapier|rocket)/.test(value)) return "Combat";
  if (/(bld_|building|shelter|totem|generator|lighting|silo|fabricator|refinery|container|staking|pentashield|turbine|spice)/.test(value)) return "Construction";
  if (/(scanner|binocular|powerpack|radiation|cutteray|mining|thumper|suspensor|probe|spice|stabilization)/.test(value)) return "Exploration";
  if (/(augment)/.test(value)) return "Augmentations";
  return "Essentials";
}

export function researchProductGroup(itemKey, category = "") {
  const value = String(itemKey || "").toLowerCase();
  if (/(t6|plastanium|regis)/.test(value)) return "Plastanium Products";
  if (/(t5|duraluminum|duraluminium)/.test(value)) return "Duraluminum Products";
  if (/(t4|aluminum|aluminium)/.test(value)) return "Aluminum Products";
  if (/(t3|steel)/.test(value)) return "Steel Products";
  if (/(t2|iron)/.test(value)) return "Iron Products";
  if (/(copper)/.test(value)) return "Copper Products";
  if (/(augment)/.test(value)) return "Generic Augmentations";
  if (category === "Uniques") return "Copper Products";
  if (category === "Vehicles") return "Copper Products";
  return "Salvage Products";
}

export function validateTemplateId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_./:-]{1,240}$/.test(raw)) return raw;
  throw new Error("Invalid item template/id");
}

export function repairTarget(durability) {
  const max = Number(durability.MaxDurability);
  const current = Number(durability.CurrentDurability || 0);
  const decayed = Number(durability.DecayedDurability || 0);
  const target = Number.isFinite(max) && max > 0 ? max : Math.max(current, decayed, 100);
  if (!Number.isFinite(target) || target <= 0) return 0;
  if (current >= target && decayed >= target) return 0;
  return target;
}

export function validateMapName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[A-Za-z0-9_:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid map name");
}
