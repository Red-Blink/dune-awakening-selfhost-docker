import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redact } from "../redact.js";
import { clampInt, writeJsonAtomic } from "../jsonStore.js";

// Operator-editable tuning for the two auto-refill scanners. Owns only the
// four numbers; enrollment stays in autoRefill.js / autoRefillWater.js, which
// import from here and not the reverse, so there is no cycle.
//
// Layered: this file beats the env var, which beats the hardcoded default.
const AUTO_REFILL_SETTINGS_PATH = "runtime/generated/auto-refill-settings.json";

// The single place these names, defaults and ranges are written down. The
// bounds are what the scanners can act on: 0% never fires, 100% always does.
export const AUTO_REFILL_SETTING_SPECS = Object.freeze({
  thresholdPercent:      { env: "ADMIN_AUTO_REFILL_THRESHOLD_PERCENT",       fallback: 50, min: 1, max: 99  },
  intervalHours:         { env: "ADMIN_AUTO_REFILL_INTERVAL_HOURS",          fallback: 24, min: 1, max: 168 },
  waterThresholdPercent: { env: "ADMIN_AUTO_REFILL_WATER_THRESHOLD_PERCENT", fallback: 50, min: 1, max: 99  },
  waterIntervalHours:    { env: "ADMIN_AUTO_REFILL_WATER_INTERVAL_HOURS",    fallback: 24, min: 1, max: 168 }
});

export const AUTO_REFILL_SETTING_KEYS = Object.freeze(Object.keys(AUTO_REFILL_SETTING_SPECS));

function settingsFile(repoRoot) {
  return resolve(repoRoot || "", AUTO_REFILL_SETTINGS_PATH);
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// THE TRAP, which both layers below are shaped around: clampInt turns null and
// "" into 0, which clamps to min rather than to the fallback -- so any blank
// value silently reads as 1% / 1h instead of the documented default. "Unset"
// must therefore be an ABSENT key, never null, "" or a sentinel.
function isStorableValue(key, value) {
  const spec = AUTO_REFILL_SETTING_SPECS[key];
  return Number.isInteger(value) && value >= spec.min && value <= spec.max;
}

// The trap on the env side: `ADMIN_AUTO_REFILL_INTERVAL_HOURS=` is how .env
// carries a declared-but-unset optional, so blank must read as absent BEFORE
// clampInt sees it. A real value still clamps, so a typo degrades as before.
function hasEnvValue(spec, env) {
  const raw = env?.[spec.env];
  return raw !== undefined && raw !== null && String(raw).trim() !== "";
}

function envValue(spec, env) {
  if (!hasEnvValue(spec, env)) return spec.fallback;
  return clampInt(env[spec.env], spec.fallback, spec.min, spec.max);
}

// Lenient, like readExchangeConfig: a corrupt file degrades to "no overrides"
// rather than blocking the console. An out-of-range value is DROPPED, not
// clamped -- only saveAutoRefillSettings writes here, so a bad value means a
// hand edit, and falling through to the env var reads intent more honestly
// than pinning to the nearest legal number.
export function readAutoRefillSettings(repoRoot) {
  const file = settingsFile(repoRoot);
  if (!existsSync(file)) return {};
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.warn(`Ignoring unreadable auto-refill settings: ${redact(error?.message || "Unexpected error.")}`);
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const settings = {};
  for (const key of AUTO_REFILL_SETTING_KEYS) {
    if (isStorableValue(key, raw[key])) settings[key] = raw[key];
  }
  return settings;
}

// Strict, unlike the read above: this is the only writer, so it is the only
// place that can keep the file's invariants. A number sets, null resets
// (deletes the key), an omitted key leaves the stored value alone.
export function saveAutoRefillSettings(repoRoot, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw badRequest("Auto-refill settings must be an object.");
  }
  const next = { ...readAutoRefillSettings(repoRoot) };
  let touched = false;
  for (const key of AUTO_REFILL_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    touched = true;
    const value = patch[key];
    if (value === null) {
      delete next[key];
      continue;
    }
    const spec = AUTO_REFILL_SETTING_SPECS[key];
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
      throw badRequest(`${key} must be a whole number between ${spec.min} and ${spec.max}.`);
    }
    next[key] = value;
  }
  if (!touched) throw badRequest("No auto-refill settings were supplied.");
  writeJsonAtomic(settingsFile(repoRoot), next, 0o600);
  return next;
}

// Re-read every call rather than cached: config is loaded once per process, so
// a cached value would be stale from the first save on (see config.js's `ports`
// getter). The scanners already read their enrollment file every 10s tick.
export function resolveAutoRefillSetting(key, { repoRoot = "", env = process.env } = {}) {
  const spec = AUTO_REFILL_SETTING_SPECS[key];
  if (!spec) throw new Error(`Unknown auto-refill setting: ${key}`);
  const stored = repoRoot ? readAutoRefillSettings(repoRoot)[key] : undefined;
  // Only the env layer goes through clampInt; a stored value is already known
  // in range, so it never meets the trap above.
  if (stored !== undefined) return stored;
  return envValue(spec, env);
}

// Shape returned by GET /api/bases/auto-refill/settings. `defaults` is what
// Reset restores -- the env value when one is set, otherwise the hardcoded
// fallback -- so the overlay can offer Reset without knowing the layering.
export function autoRefillSettingsView(repoRoot, env = process.env) {
  const stored = readAutoRefillSettings(repoRoot);
  const settings = {};
  const sources = {};
  const defaults = {};
  const limits = {};
  const envNames = {};
  for (const key of AUTO_REFILL_SETTING_KEYS) {
    const spec = AUTO_REFILL_SETTING_SPECS[key];
    const fromEnv = envValue(spec, env);
    settings[key] = stored[key] !== undefined ? stored[key] : fromEnv;
    sources[key] = stored[key] !== undefined ? "console" : hasEnvValue(spec, env) ? "env" : "default";
    defaults[key] = fromEnv;
    limits[key] = { min: spec.min, max: spec.max };
    envNames[key] = spec.env;
  }
  return { settings, sources, defaults, limits, envNames };
}
