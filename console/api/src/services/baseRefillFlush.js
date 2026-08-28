import { redactDbError } from "../db.js";

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

  // redactDbError, not plain redact: these failures are surfaced to the
  // operator in the task panel, and only the former strips the connection
  // strings that PostgreSQL driver errors routinely carry.
  const flushed = [];
  const failures = [];
  results.forEach((result, index) => {
    const refillType = labels[index];
    if (result.status === "fulfilled") {
      flushed.push(...(result.value?.flushed || []).map((entry) => ({ ...entry, refillType })));
      // A pass that aborted at its mandatory safety backup resolves normally
      // with an empty flushed list, so without this it reports nothing at all
      // -- the operator sees a clean restart while the queue was never touched,
      // which is the exact silent failure this summary exists to prevent.
      if (result.value?.backupFailed) {
        failures.push({
          refillType,
          error: redactDbError({ message: String(result.value.error || "the safety backup failed") })
        });
      }
    } else {
      failures.push({
        refillType,
        error: redactDbError({ message: String(result.reason?.message || result.reason) })
      });
    }
  });

  return { flushed, failures };
}
