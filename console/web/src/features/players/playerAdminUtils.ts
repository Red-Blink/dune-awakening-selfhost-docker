import type { Task } from "../../api/setup";
import { friendlyApiError } from "../../api/client";
import { friendlyCatalogName } from "../../components/common/ItemCatalog";
import { stripAnsi } from "../../lib/display";

export const VEHICLE_SPAWN_OFFSET_UNITS = 2000; // 20 meters in Unreal units.
export const FLYING_VEHICLE_SPAWN_OFFSET_UNITS = 2000; // 20 meters in Unreal units.

const PLAYER_FACTIONS: Record<string, { id: number; name: string }> = {
  atreides: { id: 1, name: "Atreides" },
  harkonnen: { id: 2, name: "Harkonnen" },
  smuggler: { id: 4, name: "Smuggler" }
};

export function playerAssignedFaction(value: unknown, assigned: unknown) {
  if (assigned !== true) return null;
  return PLAYER_FACTIONS[String(value || "").trim().toLowerCase()] || null;
}

export function vehicleSpawnOffsetUnits(vehicleId: string) {
  return /ornithopter/i.test(String(vehicleId || "")) ? FLYING_VEHICLE_SPAWN_OFFSET_UNITS : VEHICLE_SPAWN_OFFSET_UNITS;
}

export function vehicleSpawnDistanceLabel(offsetUnits: number) {
  const meters = offsetUnits / 100;
  return `${Number.isInteger(meters) ? meters : meters.toFixed(1)} meters`;
}

export function friendlyInlineError(error: unknown) {
  const text = friendlyApiError(error || "Action failed.");
  if (/crafting recipe unlocks require the player to be offline/i.test(text)) return "Player must be offline to unlock recipes.";
  if (/research unlocks require the player to be offline/i.test(text)) return "Player must be offline to unlock research.";
  return text.replace(/^Error:\s*/i, "").trim() || "Action failed.";
}

export function playerAdmin_taskFailureMessage(task: Task) {
  const text = [task.errorMessage, task.progressMessage, ...(task.logLines || []).map((row) => row.line)].filter(Boolean).join("\n");
  if (/player.*offline|offline|not online|online player|no route|no recipient/i.test(text)) return "The player appears to be offline, so this live admin action could not be delivered.";
  if (/failed with exit \d+/i.test(text)) return "The live admin command failed. Make sure the selected player is online and try again.";
  return "The player action failed.";
}

export function playerAdmin_friendlyFailure(error: unknown, actionName: string, playerName: string) {
  const text = friendlyInlineError(error);
  if (/player.*offline|offline|not online|online player|no route|no recipient/i.test(text)) return `${playerName} appears to be offline, so ${actionName.toLowerCase()} could not be delivered.`;
  if (/failed with exit \d+|^dune\s+admin\b/i.test(text)) return `${actionName} failed for ${playerName}. Make sure the player is online and try again.`;
  return text || `${actionName} failed for ${playerName}.`;
}

export function playerAdmin_bulkItemFailure(results: Record<string, unknown>[] = []) {
  const failed = results.filter((row) => !row.ok);
  if (!failed.length) return "No items were granted.";
  const first = failed[0];
  const item = first.item && typeof first.item === "object" ? first.item as Record<string, unknown> : {};
  const itemName = item.itemName || item.itemId || "item";
  const error = String(first.error || "").replace(/^Error:\s*/i, "").trim();
  if (/offline|not online|failed with exit \d+|^dune\s+admin\b/i.test(error)) return `Failed to grant ${itemName}. Make sure the player is online and try again.`;
  return `Failed to grant ${itemName}.${error ? ` ${error}` : ""}`;
}

export function adminTaskFailureDetail(task: Task) {
  const lines = [...(task.logLines || [])].reverse().map((row) => String(row.line || "").trim()).filter(Boolean);
  const usefulLines = lines.filter((line) =>
    !/^dune\s+.+?\s+failed with exit \d+$/i.test(line) &&
    !/^Running\s+/i.test(line) &&
    !/^Task started$/i.test(line) &&
    !/^Task failed$/i.test(line)
  );
  return usefulLines.find((line) => /failed|failure|offline|cannot verify|requires?|refusing|unavailable|not found/i.test(line)) || usefulLines[0] || "";
}

export function titleCaseWords(value: string) {
  const smallWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of", "on", "or", "the", "to", "with"]);
  const acronyms = new Set(["pvp", "pve"]);
  return String(value || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().split(" ").map((word, index) => {
    const lower = word.toLowerCase();
    if (acronyms.has(lower)) return lower.toUpperCase();
    if (index > 0 && smallWords.has(lower)) return lower;
    return lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : word;
  }).join(" ");
}

export function friendlyCraftingSource(value: string) {
  const raw = String(value || "").trim();
  const labels: Record<string, string> = {
    SchematicPickup: "Pickup",
    Pickup: "Pickup",
    Unknown: "Unknown"
  };
  if (labels[raw]) return labels[raw];
  return titleCaseWords(raw.replace(/([a-z])([A-Z])/g, "$1 $2"));
}

export function friendlyVehicleName(value: string) {
  const labels: Record<string, string> = {
    Buggy: "Buggy",
    ContainerVehicle: "Container Vehicle",
    OrnithopterLight: "Light Ornithopter",
    OrnithopterMedium: "Medium Ornithopter",
    OrnithopterTransport: "Transport Ornithopter",
    Sandbike: "Sandbike",
    Sandcrawler: "Sandcrawler",
    Tank: "Tank",
    TreadWheel: "Treadwheel"
  };
  const raw = String(value || "").trim();
  return labels[raw] || titleCaseWords(raw.replace(/([a-z])([A-Z])/g, "$1 $2"));
}

export function friendlyVehicleTemplateName(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "Manual Template";
  if (raw === "Container") return "Container";
  const match = /^T(\d+)(?:_(.+))?$/.exec(raw);
  if (!match) return titleCaseWords(raw.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const tier = `Tier ${match[1]}`;
  const suffix = match[2] ? titleCaseWords(match[2].replace(/([a-z])([A-Z])/g, "$1 $2")) : "Standard";
  return `${tier} ${suffix}`;
}

export function parseVehicleCatalog(text: string) {
  const catalog: Record<string, string[]> = {};
  let currentVehicle = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^vehicle/i.test(line) || /^templates?$/i.test(line)) continue;
    if (/^actor:/i.test(line)) continue;
    if (/^templates?:/i.test(line) && currentVehicle) {
      catalog[currentVehicle] = uniqueValues((catalog[currentVehicle] || []).concat(splitTemplateList(line.replace(/^templates?\s*:?/i, ""))));
      continue;
    }
    const colon = line.match(/^([A-Za-z][A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (colon) {
      currentVehicle = colon[1];
      catalog[currentVehicle] = uniqueValues((catalog[currentVehicle] || []).concat(splitTemplateList(colon[2])));
      continue;
    }
    const bullet = line.match(/^[-*]\s*(.+)$/);
    if (bullet && currentVehicle) {
      catalog[currentVehicle] = uniqueValues((catalog[currentVehicle] || []).concat(splitTemplateList(bullet[1])));
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9_-]+$/.test(line)) {
      if (!currentVehicle || /^[A-Z][a-z]/.test(line)) {
        currentVehicle = line;
        catalog[currentVehicle] ||= [];
      } else if (currentVehicle) {
        catalog[currentVehicle] = uniqueValues((catalog[currentVehicle] || []).concat(line));
      }
    }
  }
  return Object.fromEntries(Object.entries(catalog).filter(([vehicle]) => vehicle));
}

function splitTemplateList(text: string) {
  return text.split(/[,\s]+/).map((part) => part.trim()).filter((part) => /^[A-Za-z0-9_.:-]+$/.test(part));
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function parseSkillModuleRows(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | null = null;
  for (const rawLine of stripAnsi(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[-=]{3,}$/.test(line)) continue;
    const header = line.match(/^(.+?)\s+\[([^\]]+)\]$/);
    if (header) {
      if (current) rows.push(current);
      current = { skillModule: friendlyCatalogName(header[1].trim()), category: header[2].trim(), maxLevel: "", id: "" };
      continue;
    }
    if (!current) continue;
    const id = line.match(/^id:\s*(.+)$/i);
    if (id) {
      current.id = id[1].trim();
      continue;
    }
    const maxLevel = line.match(/^max level:\s*(.+)$/i);
    if (maxLevel) current.maxLevel = maxLevel[1].trim();
  }
  if (current) rows.push(current);
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${String(row.skillModule)}-${String(row.id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return String(row.skillModule || row.id).trim();
  }).slice(0, 500);
}
