import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../jsonStore.js";

// A runtime-generated (gitignored) companion to the committed
// large-spice-locations.json archive -- the console fills this in itself
// as it observes fields going active, so "Static Spice Spawns" grows to
// cover Medium/Small tiers and Hagga Basin over time without needing the
// private dune-spice-tools toolkit at all. Same defensive read shape as
// spiceLocations.js's readSpiceArchive(): a missing or malformed file
// never throws, it just means nothing has been learned yet.
export function readLearnedPool(file) {
  if (!file || !existsSync(file)) return { seeds: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { seeds: {} };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { seeds: {} };
  const seeds = parsed.seeds && typeof parsed.seeds === "object" && !Array.isArray(parsed.seeds) ? parsed.seeds : {};
  return { seeds };
}

export function fieldsForLearnedSeed(pool, seed) {
  if (!pool || !seed) return [];
  const entry = pool.seeds[seed];
  if (!entry || !Array.isArray(entry.fields)) return [];
  return entry.fields.filter((field) => field && typeof field === "object" && field.field_id != null && Number.isFinite(Number(field.x)) && Number.isFinite(Number(field.y)));
}

// Persists any observedFields not already known for this seed. No-ops
// (no write at all) when everything's already recorded. Read-modify-write
// with no file locking -- same accepted race-condition exposure
// spicefieldOverrides.js already carries: a lost write under concurrent
// requests just means that particular new field gets picked up on a later
// poll instead of this one, not a correctness problem for stable state.
export function recordObservedFields(file, seed, observedFields) {
  if (!file || !seed || !Array.isArray(observedFields) || observedFields.length === 0) return;

  const pool = readLearnedPool(file);
  const existing = fieldsForLearnedSeed(pool, seed);
  const knownIds = new Set(existing.map((field) => String(field.field_id)));

  const newFields = [];
  for (const field of observedFields) {
    if (!field || field.field_id == null) continue;
    const fieldId = String(field.field_id);
    if (knownIds.has(fieldId)) continue;
    knownIds.add(fieldId);
    newFields.push({
      field_id: fieldId,
      map: String(field.map || ""),
      size: String(field.size || ""),
      x: Number(field.x),
      y: Number(field.y),
      confidence: String(field.confidence || "decoded"),
      first_seen_utc: new Date().toISOString()
    });
  }
  if (newFields.length === 0) return;

  const nextSeeds = { ...pool.seeds, [seed]: { fields: [...existing, ...newFields] } };
  writeJsonAtomic(file, { generated_at: new Date().toISOString(), seeds: nextSeeds });
}
