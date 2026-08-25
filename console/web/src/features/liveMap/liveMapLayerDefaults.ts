const STORAGE_KEY = "duneLiveMapDefaultLayers";
const SUBTYPE_STORAGE_KEY = "duneLiveMapDefaultSubtypeLayers";

function readBooleanMap(key: string): Record<string, boolean> | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result: Record<string, boolean> = {};
    for (const [entryKey, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") result[entryKey] = value;
    }
    return result;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Browser storage can be unavailable in hardened modes.
  }
}

export function loadDefaultLayerFilters(): Record<string, boolean> | null {
  return readBooleanMap(STORAGE_KEY);
}

export function saveDefaultLayerFilters(filters: Record<string, boolean>) {
  writeJson(STORAGE_KEY, filters);
}

export function clearDefaultLayerFilters() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Browser storage can be unavailable in hardened modes.
  }
}

// Per-category sub-type defaults (e.g. hazard -> { Hazard_Quicksand: false }).
// Sub-types are discovered at runtime from whatever markers have actually
// loaded, so this only ever covers sub-types the settings popover has seen
// -- same limitation the live legend itself already has.
export function loadDefaultSubtypeLayerFilters(): Record<string, Record<string, boolean>> | null {
  try {
    const raw = window.localStorage.getItem(SUBTYPE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result: Record<string, Record<string, boolean>> = {};
    for (const [categoryKey, subtypes] of Object.entries(parsed)) {
      const cleaned = subtypes && typeof subtypes === "object" && !Array.isArray(subtypes)
        ? Object.fromEntries(Object.entries(subtypes as Record<string, unknown>).filter(([, value]) => typeof value === "boolean"))
        : null;
      if (cleaned && Object.keys(cleaned).length > 0) result[categoryKey] = cleaned as Record<string, boolean>;
    }
    return result;
  } catch {
    return null;
  }
}

export function saveDefaultSubtypeLayerFilters(subtypeFilters: Record<string, Record<string, boolean>>) {
  writeJson(SUBTYPE_STORAGE_KEY, subtypeFilters);
}

export function clearDefaultSubtypeLayerFilters() {
  try {
    window.localStorage.removeItem(SUBTYPE_STORAGE_KEY);
  } catch {
    // Browser storage can be unavailable in hardened modes.
  }
}
