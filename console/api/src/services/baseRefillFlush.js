import { redact } from "../redact.js";

// A map restart must not begin its start/spawn half until every queue has
// finished using the brief write-safe window. Promise.allSettled is
// deliberate: if one queue fails, we still wait for the others rather than
// returning early while one of them is writing to PostgreSQL.
//
// The delete and permission flushes are optional and additive: existing
// callers that pass only flushGenerators/flushWater are unaffected, since an
// undefined leg is simply skipped rather than awaited.
export async function flushBaseRefillQueues({
  flushGenerators,
  flushWater,
  flushDeletes,
  flushChildAccess,
  flushVehicleDeletes
}) {
  const jobs = [Promise.resolve().then(flushGenerators), Promise.resolve().then(flushWater)];
  const labels = ["generator", "water"];
  if (flushDeletes) {
    jobs.push(Promise.resolve().then(flushDeletes));
    labels.push("delete");
  }
  if (flushChildAccess) {
    jobs.push(Promise.resolve().then(flushChildAccess));
    labels.push("childAccess");
  }
  if (flushVehicleDeletes) {
    jobs.push(Promise.resolve().then(flushVehicleDeletes));
    labels.push("vehicle-delete");
  }
  const results = await Promise.allSettled(jobs);

  const flushed = [];
  const failures = [];
  results.forEach((result, index) => {
    const refillType = labels[index];
    if (result.status === "fulfilled") {
      flushed.push(...(result.value?.flushed || []).map((entry) => ({ ...entry, refillType })));
    } else {
      failures.push({ refillType, error: redact(String(result.reason?.message || result.reason)) });
    }
  });

  return { flushed, failures };
}
