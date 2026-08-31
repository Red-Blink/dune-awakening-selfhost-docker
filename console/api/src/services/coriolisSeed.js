import { runDockerLogs } from "../runner.js";

// Every running game-server instance -- Deep Desert, Hagga Basin, the
// static-heavy sietches, overmap -- logs this identical farm-wide block at
// startup, e.g. "LogCoriolis: Display: Current Coriolis World Seed: 2". This
// is the same signal the user's private dune-spice-tools toolkit parses to
// key its position archive (cor-<seed>), so re-parsing it here keeps both
// sides in the same identity space without either side needing to write a
// pointer for the other to read.
const SEED_LINE = /Current Coriolis World Seed:\s*(\d+)/;

// Same startup log block also prints the current cycle's boundaries, e.g.
// "LogCoriolis: Display: Next Coriolis Cycle start date UTC: 2026.08.25-05.00.00".
const NEXT_CYCLE_LINE = /Next Coriolis Cycle start date UTC:\s*(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})/;

function toIso(match) {
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))).toISOString();
}

// "overmap" is checked first since it's the cheapest single container to
// ask and normally always running, but its map mode can be set to
// "disabled" (see config.js), in which case it never logs anything --
// "survival-1" (Hagga Basin, the one persistent world every self-hoster
// runs) is the fallback so a disabled overmap doesn't blank out the seed
// and countdown farm-wide.
const FALLBACK_SERVICES = ["overmap", "survival-1"];
const CYCLE_CACHE_MS = 30000;
const CYCLE_CACHE_MAX_ENTRIES = 128;
const cycleCache = new Map();

// Dynamic per-partition containers follow the same naming convention
// memoryBalancer.js already relies on the other direction (container name ->
// map/partition): Hagga Basin's first partition runs bare
// ("dune-server-survival-1", no suffix, confirmed live on dune2 as
// partition_id 1 "Abbir"); every other Hagga Basin partition and every Deep
// Desert partition is suffixed with its partition_id
// (dune-server-survival-1-60 = "Alraab", dune-server-deepdesert-1-59, etc).
// Asking the selected partition's own container first (before the
// farm-wide overmap/survival-1 fallback) means a self-hoster running
// several Deep Desert instances gets each one's real countdown rather than
// always reading whichever happens to be Hagga Basin's.
function partitionContainerCandidates(map, partitionId) {
  const id = partitionId === undefined || partitionId === null ? "" : String(partitionId).trim();
  if (!/^[1-9]\d{0,18}$/.test(id)) return [];
  if (map === "HaggaBasin") return id === "1" ? ["dune-server-survival-1"] : [`dune-server-survival-1-${id}`];
  if (map === "DeepDesert") return [`dune-server-deepdesert-1-${id}`, "dune-server-deepdesert-1"];
  return [];
}

// The seed line only prints once at server startup, so the tail has to reach
// back far enough to survive whatever log volume accumulates before the next
// restart. Measured on dune2's own overmap container: ~740 lines across its
// entire uptime since the last restart (a few days) -- 10k gives a wide
// margin over that without meaningfully slowing the `docker logs` call. This
// keeps a short request-level timeout instead of the runner's 30s default,
// since a hung `docker logs` shouldn't stall the whole /api/map/markers
// response for that long.
async function fetchCoriolisLog(service, { tail = 10000, timeoutMs = 5000, runLogs = runDockerLogs } = {}) {
  try {
    const result = await runLogs(service, { tail, timeoutMs, captureOutput: true });
    return `${result?.stdout || ""}\n${result?.stderr || ""}`;
  } catch {
    return null;
  }
}

function lastMatch(lines, pattern) {
  let match = null;
  for (const line of lines) {
    const found = line.match(pattern);
    if (found) match = found;
  }
  return match;
}

function parseCoriolisLog(combined) {
  if (combined === null) return { seed: null, nextCycleAt: null };
  const lines = combined.split(/\r?\n/);
  const seedMatch = lastMatch(lines, SEED_LINE);
  return {
    seed: seedMatch ? `cor-${seedMatch[1]}` : null,
    nextCycleAt: toIso(lastMatch(lines, NEXT_CYCLE_LINE))
  };
}

export async function resolveCurrentSeed(options = {}) {
  return (await resolveCoriolisCycle(options)).seed;
}

// The seed line only prints at container startup, but the Deep Desert world
// re-rolls at every weekly Coriolis boundary whether or not anything
// restarts. Between a boundary and the next restart the logs therefore still
// advertise the *previous* cycle's seed -- confirmed live on dune2, where
// fields observed the day after the 2026-08-25 boundary were filed under
// cor-2 and 39% of them later reappeared under cor-3 (against a 2% baseline
// overlap between genuinely different seeds). Serving that stale seed puts
// the previous cycle's static pool on the map and poisons the learned pool
// with the new cycle's fields.
//
// The same log block tells us when the seed expires, so a cycle boundary
// already in the past is proof the logged seed is stale. Treat it as unknown
// rather than wrong: callers already handle a null seed by dropping the
// static-pool layer and skipping the learned-pool write, so the map falls
// back to live active fields only until the container restarts and prints
// the new seed. When the log has a seed but no boundary line there is
// nothing to check it against, so it is passed through unchanged.
function applyCycleExpiry(resolved, now) {
  const expiresAt = resolved.nextCycleAt ? Date.parse(resolved.nextCycleAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return { seed: null, nextCycleAt: null, staleSince: resolved.nextCycleAt };
  }
  return { ...resolved, staleSince: null };
}

// One combined resolver so a single cached `docker logs` result covers both
// the seed and the countdown, rather than doubling the Docker call rate --
// and only falls through to
// another container when the current one comes up genuinely empty. Pass the
// selected map/partitionId so the countdown reflects that partition's own
// container instead of always reading overmap/Hagga Basin's.
export async function resolveCoriolisCycle({ map, partitionId, services, ...options } = {}) {
  const candidates = [...new Set(services || [...partitionContainerCandidates(map, partitionId), ...FALLBACK_SERVICES])];
  // The Live Map polls every five seconds, while both values only change at
  // the weekly Coriolis boundary. Avoid repeatedly tailing up to 10,000 log
  // lines for every open browser. Injected log runners bypass this cache so
  // tests and diagnostics always observe the call they requested.
  const cacheable = !options.runLogs;
  const cacheKey = candidates.join("\u0000");
  const now = Date.now();
  const cached = cacheable ? cycleCache.get(cacheKey) : null;
  // The cache holds the raw parse and expiry is re-evaluated on every read,
  // so an entry cached seconds before a boundary can't serve a seed that has
  // since expired.
  if (cached && cached.expiresAt > now) return applyCycleExpiry(cached.value, now);

  let resolved = { seed: null, nextCycleAt: null };
  for (const service of candidates) {
    const result = parseCoriolisLog(await fetchCoriolisLog(service, options));
    if (result.seed || result.nextCycleAt) {
      resolved = result;
      break;
    }
  }
  if (cacheable) {
    for (const [key, entry] of cycleCache) {
      if (entry.expiresAt <= now) cycleCache.delete(key);
    }
    if (!cycleCache.has(cacheKey) && cycleCache.size >= CYCLE_CACHE_MAX_ENTRIES) {
      cycleCache.delete(cycleCache.keys().next().value);
    }
    cycleCache.set(cacheKey, { expiresAt: now + CYCLE_CACHE_MS, value: resolved });
  }
  return applyCycleExpiry(resolved, now);
}
