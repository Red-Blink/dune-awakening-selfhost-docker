import { existsSync, readFileSync } from "node:fs";

// Reads the Large-spice position archive at console/api/data/large-spice-locations.json --
// a committed, seed-keyed lookup built from the user's private dune-spice-tools
// toolkit (not part of this repo -- see the live-map plan for the full data
// flow and why it's safe to ship: a Coriolis seed's pool is the same on every
// Deep Desert server). The file is still treated as optional at read time so a
// missing/malformed file just skips the spice layer rather than erroring.
export function readSpiceArchive(file) {
  if (!file || !existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const seeds = parsed.seeds && typeof parsed.seeds === "object" && !Array.isArray(parsed.seeds) ? parsed.seeds : {};
  return {
    generatedAt: typeof parsed.generated_at === "string" ? parsed.generated_at : "",
    seeds
  };
}

export function fieldsForSeed(archive, currentSeed) {
  if (!archive || !currentSeed) return null;
  const entry = archive.seeds[currentSeed];
  if (!entry || !Array.isArray(entry.fields)) return null;
  return entry.fields.filter((field) => field && typeof field === "object" && field.field_id != null && Number.isFinite(Number(field.x)) && Number.isFinite(Number(field.y)));
}
