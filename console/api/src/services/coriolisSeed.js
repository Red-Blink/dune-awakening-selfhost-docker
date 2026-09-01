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

// Which of the Deep Desert's 12 cartography layouts the current cycle picked,
// logged only by a Deep Desert map server, e.g. "LogWorldLayout: Display:
// BP_DuneGameState_C_2147481382: 'DA_DeepDesert_1_Layout_03' layout selected".
// Taken from the log rather than derived from the seed: the two have matched
// wherever observed, but this is the game stating its own choice, so it needs
// no mapping assumption. Anchored on the quoted asset name, as SEED_LINE is.
const LAYOUT_LINE = /'DA_DeepDesert_\d+_Layout_(\d{1,3})'\s+layout selected/;

// Sanity bound, deliberately wider than the 12 layouts that ship today: a
// future Layout_12 should be reported truthfully and left for the client to
// fall back on, not nulled here and made to look like a log failure.
const MAX_LAYOUT = 63;

// A caller need not pass a partitionId (the public directory does not), and
// only a Deep Desert container logs the layout, so without one the fan-out
// below is the only way to reach it. Capped: each candidate is a `docker logs`.
const DEEP_DESERT_FANOUT_LIMIT = 3;
const PARTITION_ID = /^[1-9]\d{0,18}$/;

// Only a Deep Desert map server logs LAYOUT_LINE at all.
const logsLayout = (service) => String(service).startsWith("dune-server-deepdesert-1");

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
function partitionContainerCandidates(map, partitionId, deepDesertPartitionIds = []) {
  const id = partitionId === undefined || partitionId === null ? "" : String(partitionId).trim();
  const selected = PARTITION_ID.test(id);
  if (map === "HaggaBasin") {
    if (!selected) return [];
    return id === "1" ? ["dune-server-survival-1"] : [`dune-server-survival-1-${id}`];
  }
  if (map !== "DeepDesert") return [];
  const known = [...new Set((deepDesertPartitionIds || [])
    .map((value) => String(value).trim())
    .filter((value) => PARTITION_ID.test(value)))];
  if (selected) {
    // The selected partition's own container first, then its siblings. The seed,
    // the boundary and the layout are all farm-wide for the map, so any Deep
    // Desert container can answer -- and containers restart independently, so
    // the selected one may be the stale one. Asking only it blanked the map
    // while a sibling had the current cycle. Siblings cost nothing in the normal
    // case: the loop stops as soon as the first container answers in full.
    const siblings = known.filter((value) => value !== id).slice(0, DEEP_DESERT_FANOUT_LIMIT - 1);
    return [
      `dune-server-deepdesert-1-${id}`,
      ...siblings.map((value) => `dune-server-deepdesert-1-${value}`),
      "dune-server-deepdesert-1"
    ];
  }
  // Without a selected partition there is no single container to ask, and the
  // bare "dune-server-deepdesert-1" is not guaranteed to exist -- confirmed on
  // dune2, which runs only -8 and -59. So fan out over the partition ids the
  // caller already knows about, and keep the bare name as a last resort for
  // deployments that do run it.
  const ids = known.slice(0, DEEP_DESERT_FANOUT_LIMIT);
  return [...ids.map((value) => `dune-server-deepdesert-1-${value}`), "dune-server-deepdesert-1"];
}

// The seed line only prints once at server startup, so the tail has to reach
// back far enough to survive whatever log volume accumulates before the next
// restart. Measured on dune2's own overmap container: ~740 lines across its
// entire uptime since the last restart (a few days) -- 10k gives a wide
// margin over that without meaningfully slowing the `docker logs` call. This
// keeps a short request-level timeout instead of the runner's 30s default,
// since a hung `docker logs` shouldn't stall the whole /api/map/markers
// response for that long.
//
// The layout line prints in the same startup block, and a Deep Desert server is
// busier than overmap: ~3,900 lines over a 7-day cycle against this 10,000
// tail, so it stays reachable with roughly 2.5x headroom.
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

function parseLayout(match) {
  if (!match) return null;
  // "03" -> 3. Number() rather than parseInt with a radix guess: the capture is
  // already digits-only.
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 && value <= MAX_LAYOUT ? value : null;
}

function parseCoriolisLog(combined) {
  if (combined === null) return { seed: null, nextCycleAt: null, layout: null };
  const lines = combined.split(/\r?\n/);
  const seedMatch = lastMatch(lines, SEED_LINE);
  return {
    seed: seedMatch ? `cor-${seedMatch[1]}` : null,
    nextCycleAt: toIso(lastMatch(lines, NEXT_CYCLE_LINE)),
    layout: parseLayout(lastMatch(lines, LAYOUT_LINE))
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
  const passed = (iso) => {
    const at = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(at) && at <= now;
  };
  if (passed(resolved.nextCycleAt)) {
    // The layout expires with the seed and for the same reason: printed once at
    // startup, so after a boundary the logs still name the previous cycle's
    // layout. Null makes the map fall back to the flat image until a restart.
    return { seed: null, nextCycleAt: null, layout: null, staleSince: resolved.nextCycleAt };
  }
  // The layout is checked against the boundary logged by the container that
  // named it, never one merged in from another container. Those are different
  // machines restarted at different times, so a fresh boundary from overmap
  // says nothing about whether a Deep Desert server's layout line is current --
  // and pairing the two is precisely how the map would draw last cycle's
  // terrain while reporting itself healthy.
  const layoutCurrent = resolved.layout !== null
    && resolved.layoutCycleAt !== null
    && !passed(resolved.layoutCycleAt);
  return {
    seed: resolved.seed,
    nextCycleAt: resolved.nextCycleAt,
    layout: layoutCurrent ? resolved.layout : null,
    // A container found stale only matters when no container had a current
    // cycle. If one did, its answer stands and there is nothing to report.
    staleSince: resolved.seed === null && resolved.nextCycleAt === null ? (resolved.staleSince ?? null) : null
  };
}

// One resolver so a single cached `docker logs` result covers the seed, the
// countdown and the layout rather than tripling the Docker call rate. Pass the
// selected map/partitionId so the countdown reflects that partition's own
// container instead of always reading overmap/Hagga Basin's.
export async function resolveCoriolisCycle({ map, partitionId, services, deepDesertPartitionIds, ...options } = {}) {
  const candidates = [...new Set(services || [...partitionContainerCandidates(map, partitionId, deepDesertPartitionIds), ...FALLBACK_SERVICES])];
  // Only Deep Desert has a layout to find; elsewhere the first answer will do.
  const wantLayout = map === "DeepDesert";
  // The Live Map polls every five seconds, while both values only change at
  // the weekly Coriolis boundary. Avoid repeatedly tailing up to 10,000 log
  // lines for every open browser. Injected log runners bypass this cache so
  // tests and diagnostics always observe the call they requested.
  const cacheable = !options.runLogs;
  // wantLayout is in the key because it changes how far the loop walks, so the
  // same candidate list can cache to two different results.
  const cacheKey = [wantLayout ? 'layout' : '-', ...candidates].join("\u0000");
  const now = Date.now();
  const cached = cacheable ? cycleCache.get(cacheKey) : null;
  // The cache holds the raw parse and expiry is re-evaluated on every read,
  // so an entry cached seconds before a boundary can't serve a seed that has
  // since expired.
  if (cached && cached.expiresAt > now) return applyCycleExpiry(cached.value, now);

  // Accumulate rather than take the first container that answers: overmap and
  // survival-1 carry the seed and countdown but never the layout, so stopping
  // there would blank the layout for the whole cycle.
  //
  // ?? not ||: Layout_00 is 0, and || would discard it.
  let resolved = { seed: null, nextCycleAt: null, layout: null, layoutCycleAt: null, staleSince: null };
  for (let i = 0; i < candidates.length; i++) {
    const result = parseCoriolisLog(await fetchCoriolisLog(candidates[i], options));
    const boundary = result.nextCycleAt ? Date.parse(result.nextCycleAt) : NaN;
    if (Number.isFinite(boundary) && boundary <= now) {
      // This container has not restarted since the boundary, so everything it
      // logged describes the previous cycle. Containers restart independently,
      // so a sibling partition may well have current logs -- taking this one's
      // word for the whole farm blanked the map while the answer was one
      // `docker logs` away. Remember it in case nobody has anything better.
      resolved = { ...resolved, staleSince: resolved.staleSince ?? result.nextCycleAt };
    } else {
      // A layout is only taken together with the boundary from the same log, so
      // its freshness can actually be checked later. The two print in one startup
      // block, but the layout line comes ~130 lines after the boundary, so a
      // container busy enough for the tail to cut between them yields a layout
      // with nothing to date it. Dropping it there costs a fall back to the flat
      // image; keeping it risks drawing the wrong world and calling it current.
      const datedLayout = result.nextCycleAt !== null && result.layout !== null;
      resolved = {
        ...resolved,
        seed: resolved.seed ?? result.seed,
        nextCycleAt: resolved.nextCycleAt ?? result.nextCycleAt,
        layout: resolved.layout ?? (datedLayout ? result.layout : null),
        layoutCycleAt: resolved.layout !== null ? resolved.layoutCycleAt : (datedLayout ? result.nextCycleAt : null)
      };
    }
    const stillWantLayout = wantLayout && resolved.layout === null;
    const stillWantSeed = !resolved.seed;
    if (!stillWantLayout && !stillWantSeed) break;
    const remaining = candidates.slice(i + 1);
    if (remaining.length === 0) break;
    // Only a Deep Desert map server logs a layout, so once the seed is in hand
    // and a layout is all that is left, walking on to overmap/survival-1 would
    // be a guaranteed-empty `docker logs`.
    if (!stillWantSeed && !remaining.some(logsLayout)) break;
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
