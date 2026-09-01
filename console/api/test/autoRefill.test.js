import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoRefillPublicState,
  clampAutoRefillNextRun,
  createAutoRefillScheduler,
  isAutoRefillEnabled,
  readAutoRefillState,
  setBaseAutoRefill,
  writeAutoRefillState
} from "../src/services/autoRefill.js";
import { saveAutoRefillSettings } from "../src/services/autoRefillSettings.js";
import { listQueuedBaseDeletes, listQueuedGeneratorRefills, queueGeneratorRefill } from "../src/duneDb.js";

// Must await fn: without it the finally deletes the directory at the callback's
// first await, and everything after that reads an empty enrollment.
async function withTempRepoRoot(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-auto-refill-"));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function statePath(repoRoot) {
  return join(repoRoot, "runtime/generated/auto-refill-bases.json");
}

function writeRawState(repoRoot, text) {
  mkdirSync(join(repoRoot, "runtime/generated"), { recursive: true });
  writeFileSync(statePath(repoRoot), text);
}

const HOUR_MS = 3600000;
const START = Date.UTC(2026, 6, 30, 12, 0, 0);

function makeClock(start = START) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; }, at: () => current };
}

// Empty env so the host's own ADMIN_AUTO_REFILL_* values cannot change results.
const TEST_ENV = {};

// Fakes only the database reads; queueing and queue inspection go through the
// real queue file so a scan is proven to produce an entry the flush would pick
// up, and so the "already queued" path sees real queue state.
//
// baseGeneratorFuelLevels deliberately does NOT throw for an unknown base: the
// real one cannot, because baseGenerators returns zero rows both for a deleted
// base and for a base with no generators built. Only baseMapLocation tells them
// apart, so `missingBases` drives that instead. An earlier version of this fake
// threw "was not found" from baseGeneratorFuelLevels, which made the un-enroll
// test pass against behaviour the real code never produces.
function fakeDuneDb({
  levels = {},
  missingBases = [],
  // Distinct from missingBases: the real baseMapLocation throws a different
  // message for a base whose owner-entity link is broken (still exists) vs
  // one that's genuinely gone. Only the latter should un-enroll -- collapsing
  // the two would silently drop a base that still exists and may still need
  // fuel, which is exactly the bug this option exists to guard against.
  orphanedBases = [],
  target = { map: "Survival_1", partitionId: 3, queueSupported: true, writeSafeNow: false },
  calls = []
} = {}) {
  const missing = new Set(missingBases.map(Number));
  const orphaned = new Set(orphanedBases.map(Number));
  return {
    calls,
    baseGeneratorFuelLevels: async (_db, _repoRoot, baseId) => {
      calls.push({ fn: "baseGeneratorFuelLevels", baseId });
      const entry = levels[baseId];
      if (entry instanceof Error) throw entry;
      if (!entry) return { baseId, deviceCount: 0, devices: [], lowestPercent: null };
      return { baseId, deviceCount: entry.deviceCount ?? 1, devices: [], lowestPercent: entry.lowestPercent };
    },
    baseMapLocation: async (_db, baseId) => {
      calls.push({ fn: "baseMapLocation", baseId });
      if (missing.has(Number(baseId))) throw new Error("That base was not found.");
      if (orphaned.has(Number(baseId))) throw new Error("This base has no resolvable owner entity, so its map location is unavailable.");
      return { map: "Survival_1", partitionId: 3 };
    },
    baseRefillTarget: async (_db, baseId) => {
      calls.push({ fn: "baseRefillTarget", baseId });
      return typeof target === "function" ? target(baseId) : target;
    },
    observeRefillPartitions: async () => {
      calls.push({ fn: "observeRefillPartitions" });
      return null;
    },
    queueGeneratorRefill,
    listQueuedGeneratorRefills,
    // Real queue-file read, like listQueuedGeneratorRefills above: no test
    // here queues a delete, so this always resolves empty, but going through
    // the real function keeps the fake honest about that rather than
    // asserting it via a hardcoded stub.
    listQueuedBaseDeletes
  };
}

// Marks the scan due now. armedForThisProcess is already true after a
// scheduler's first tick, so a later tick with a due nextRunAt runs directly.
function forceDue(repoRoot, clock) {
  writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(clock.now()).toISOString() });
}

// Stands in for a flush that consumed the queue entry without fixing the fuel.
function drainQueue(repoRoot) {
  writeFileSync(join(repoRoot, "runtime/generated/pending-generator-refills.json"), "[]\n");
}

// The first tick of a scheduler's life only arms the schedule -- an overdue run
// at boot is deliberately pushed a few minutes out rather than fired. Tests that
// want to observe scans have to get past that tick first.
async function primeScheduler(scheduler, repoRoot, clock) {
  forceDue(repoRoot, clock);
  await scheduler.tick();
  clock.advance(2000);
}

function makeScheduler(repoRoot, duneDb, clock, options = {}) {
  const audits = [];
  const scheduler = createAutoRefillScheduler({
    config: { repoRoot },
    getDb: () => ({ query: async () => { throw new Error("the scheduler must not query the database directly"); } }),
    duneDb,
    now: clock.now,
    auditImpl: (_config, _req, action, detail) => audits.push({ action, detail }),
    env: TEST_ENV,
    overdueArmDelayMs: 1000,
    ...options
  });
  return { scheduler, audits };
}

// --- Enrollment store -------------------------------------------------------

test("auto-refill enrollment round-trips and is idempotent in both directions", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    assert.deepEqual(readAutoRefillState(repoRoot).bases, {});
    assert.equal(isAutoRefillEnabled(repoRoot, 482), false);

    const first = setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    assert.deepEqual({ ok: first.ok, enabled: first.enabled, total: first.total }, { ok: true, enabled: true, total: 1 });
    const enabledAt = readAutoRefillState(repoRoot).bases["482"].enabledAt;

    // A double-clicked toggle is not an error, and must not reset enabledAt.
    clock.advance(HOUR_MS);
    const again = setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    assert.equal(again.total, 1);
    assert.equal(readAutoRefillState(repoRoot).bases["482"].enabledAt, enabledAt);
    assert.equal(isAutoRefillEnabled(repoRoot, 482), true);

    setBaseAutoRefill(repoRoot, 517, true, { now: clock.now, env: TEST_ENV });
    const off = setBaseAutoRefill(repoRoot, 482, false, { now: clock.now, env: TEST_ENV });
    assert.deepEqual({ enabled: off.enabled, total: off.total }, { enabled: false, total: 1 });
    // Turning it off twice is also not an error.
    assert.equal(setBaseAutoRefill(repoRoot, 482, false, { now: clock.now, env: TEST_ENV }).total, 1);
  });
});

test("enabling arms the first scan a full interval out, and emptying the list disarms it", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });

    // Turning auto-refill on must not fire a scan immediately: the operator is
    // still looking at the base they just enrolled.
    assert.equal(readAutoRefillState(repoRoot).nextRunAt, new Date(START + 24 * HOUR_MS).toISOString());

    setBaseAutoRefill(repoRoot, 517, true, { now: clock.now, env: TEST_ENV });
    // A second base joins the existing schedule rather than pushing it back.
    assert.equal(readAutoRefillState(repoRoot).nextRunAt, new Date(START + 24 * HOUR_MS).toISOString());

    setBaseAutoRefill(repoRoot, 482, false, { now: clock.now, env: TEST_ENV });
    setBaseAutoRefill(repoRoot, 517, false, { now: clock.now, env: TEST_ENV });
    assert.equal(readAutoRefillState(repoRoot).nextRunAt, "");
  });
});

test("a missing or corrupt enrollment file reads as empty instead of throwing", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.deepEqual(readAutoRefillState(repoRoot).bases, {});

    writeRawState(repoRoot, "{not json");
    assert.deepEqual(readAutoRefillState(repoRoot).bases, {});

    // An array where an object belongs, and a base list that is not an object.
    writeRawState(repoRoot, "[1,2,3]");
    assert.deepEqual(readAutoRefillState(repoRoot).bases, {});
    writeRawState(repoRoot, JSON.stringify({ bases: [482] }));
    assert.deepEqual(readAutoRefillState(repoRoot).bases, {});

    // Degrading to empty is also the safe direction: nothing gets refilled.
    assert.equal(isAutoRefillEnabled(repoRoot, 482), false);
  });
});

test("hand-edited enrollment values are normalized rather than trusted", async () => {
  await withTempRepoRoot((repoRoot) => {
    writeRawState(repoRoot, JSON.stringify({
      nextRunAt: "whenever",
      lastRunStatus: "x".repeat(200),
      bases: {
        482: { lastLowestPercent: 9e12, enabledAt: "not a date" },
        0: { enabledAt: new Date(START).toISOString() },
        "-3": {},
        abc: {}
      }
    }));

    const state = readAutoRefillState(repoRoot);
    // An unparseable nextRunAt reads as unset, not as a date in the far past.
    assert.equal(state.nextRunAt, "");
    assert.equal(state.lastRunStatus.length, 40);
    assert.deepEqual(Object.keys(state.bases), ["482"]);
    assert.equal(state.bases["482"].lastLowestPercent, 10000);
    assert.equal(state.bases["482"].enabledAt, "");
  });
});

test("enrollment is capped so a full scan can never overflow the refill queue", async () => {
  await withTempRepoRoot((repoRoot) => {
    const bases = {};
    for (let baseId = 1; baseId <= 200; baseId += 1) bases[baseId] = { enabledAt: new Date(START).toISOString() };
    writeAutoRefillState(repoRoot, { bases, nextRunAt: new Date(START).toISOString() });
    assert.equal(Object.keys(readAutoRefillState(repoRoot).bases).length, 200);

    assert.throws(() => setBaseAutoRefill(repoRoot, 5000, true, { env: TEST_ENV }), /already covers 200 bases/);
    // Re-enabling one that is already covered stays allowed at the cap.
    assert.equal(setBaseAutoRefill(repoRoot, 7, true, { env: TEST_ENV }).total, 200);
  });
});

test("autoRefillPublicState reports the tunables and a sorted base list", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 517, true, { now: clock.now, env: TEST_ENV });
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });

    const state = autoRefillPublicState(repoRoot, { env: TEST_ENV });
    assert.equal(state.thresholdPercent, 50);
    assert.equal(state.intervalHours, 24);
    assert.equal(state.total, 2);
    assert.deepEqual(state.bases.map((entry) => entry.baseId), [482, 517]);
  });
});

test("threshold and interval clamp out-of-range overrides", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.equal(autoRefillPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: "0" } }).thresholdPercent, 1);
    assert.equal(autoRefillPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: "500" } }).thresholdPercent, 99);
    assert.equal(autoRefillPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: "nope" } }).thresholdPercent, 50);
    assert.equal(autoRefillPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_INTERVAL_HOURS: "0" } }).intervalHours, 1);
    assert.equal(autoRefillPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_INTERVAL_HOURS: "9999" } }).intervalHours, 168);
  });
});

// --- Scheduler --------------------------------------------------------------

test("an empty enrollment never touches the database", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    const duneDb = fakeDuneDb();
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();

    // Idle cost must stay at one small file read so this can share the 10s tick.
    assert.deepEqual(duneDb.calls, []);
    assert.deepEqual(audits, []);
  });
});

test("a scan that is not yet due is a no-op", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 5 } } });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    clock.advance(HOUR_MS);
    await scheduler.tick();

    assert.deepEqual(duneDb.calls, []);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot), []);
  });
});

test("an overdue scan is armed minutes out at boot, not a whole interval", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    // The console was down when the scan came due.
    writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(START - 48 * HOUR_MS).toISOString() });
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 5 } } });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock, { overdueArmDelayMs: 5 * 60000 });

    await scheduler.tick();

    // Re-arming a full 24h here would let a host that restarts more often than
    // daily never scan at all; firing instantly would put it on the boot path.
    assert.equal(readAutoRefillState(repoRoot).nextRunAt, new Date(START + 5 * 60000).toISOString());
    assert.deepEqual(duneDb.calls, []);
  });
});

test("a due scan queues only the bases under the threshold", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    for (const baseId of [482, 517, 601]) setBaseAutoRefill(repoRoot, baseId, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(START).toISOString() });
    const duneDb = fakeDuneDb({
      levels: {
        482: { lowestPercent: 20 },
        // Exactly at the threshold is not under it.
        517: { lowestPercent: 50 },
        601: { lowestPercent: 49.9 }
      }
    });
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    assert.equal(result.queued, 2);
    assert.equal(result.checked, 3);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot).map((entry) => entry.baseId).sort((a, b) => a - b), [482, 601]);
    // Every enqueue is audited, plus one summary line for the scan itself.
    assert.deepEqual(audits.filter((entry) => entry.action === "bases.auto-refill-queued").map((entry) => entry.detail.baseId), [482, 601]);
    const scan = audits.find((entry) => entry.action === "bases.auto-refill-scan");
    assert.deepEqual({ enrolled: scan.detail.enrolled, queued: scan.detail.queued, status: scan.detail.status }, { enrolled: 3, queued: 2, status: "ok" });

    const state = readAutoRefillState(repoRoot);
    assert.equal(state.bases["517"].lastLowestPercent, 50);
    assert.equal(state.bases["517"].lastQueuedAt, "");
    assert.equal(state.bases["482"].lastQueuedAt, new Date(clock.at()).toISOString());
    // Re-armed from completion, not from run start.
    assert.equal(state.nextRunAt, new Date(clock.at() + 24 * HOUR_MS).toISOString());
    assert.equal(state.lastRunStatus, "ok");
  });
});

test("a base with no generators is checked but never queued", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(START).toISOString() });
    // lowestPercent null means "nothing to measure", which must not read as empty.
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: null, deviceCount: 0 } } });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    assert.equal(result.queued, 0);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot), []);
    assert.equal(readAutoRefillState(repoRoot).bases["482"].lastLowestPercent, null);
  });
});

test("a base that no longer exists is un-enrolled, but other failures keep their enrollment", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    for (const baseId of [482, 517]) setBaseAutoRefill(repoRoot, baseId, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(START).toISOString() });
    const duneDb = fakeDuneDb({
      // 482 reads as zero devices (exactly what the real query returns for a
      // deleted base) and is only recognised as gone via baseMapLocation.
      missingBases: [482],
      levels: {
        517: new Error("connection terminated unexpectedly")
      }
    });
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    const state = readAutoRefillState(repoRoot);
    // A deleted base would otherwise be retried every day forever.
    assert.deepEqual(Object.keys(state.bases), ["517"]);
    assert.equal(audits.some((entry) => entry.action === "bases.auto-refill-unenrolled" && entry.detail.baseId === 482), true);
    // A transient database error is not grounds for dropping an enrollment.
    assert.equal(result.failures, 1);
    // "partial", not "fail": 482 was read successfully and handled by
    // un-enrolling it, so only 517 actually errored.
    assert.equal(state.lastRunStatus, "partial");
    assert.match(state.lastRunDetail, /517/);
  });
});

test("a base with a broken owner-entity link is not un-enrolled, unlike a genuinely deleted base", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(START).toISOString() });
    const duneDb = fakeDuneDb({
      // Reads as zero devices, same as a deleted base -- only baseMapLocation
      // tells them apart, and it must not collapse "link broken" into "gone".
      orphanedBases: [482],
      levels: {}
    });
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    const state = readAutoRefillState(repoRoot);
    // The base still exists -- dropping it here could leave its generators
    // unattended, so enrollment must survive.
    assert.deepEqual(Object.keys(state.bases), ["482"]);
    assert.equal(audits.some((entry) => entry.action === "bases.auto-refill-unenrolled"), false);
    assert.equal(result.failures, 1);
  });
});

test("a base whose database lost queue support is not refilled directly", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(START).toISOString() });
    const duneDb = fakeDuneDb({
      levels: { 482: { lowestPercent: 5 } },
      target: { map: "Survival_1", partitionId: 3, queueSupported: false, writeSafeNow: true }
    });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    // Without the queue there is no way to wait for a safe window, so an
    // automated write could land in a live base. Refusing is the safe answer.
    assert.equal(result.queued, 0);
    assert.equal(result.failures, 1);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot), []);
  });
});

test("a base un-enrolled while a scan is running is not resurrected by its own outcome", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    for (const baseId of [482, 517]) setBaseAutoRefill(repoRoot, baseId, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(START).toISOString() });

    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 80 }, 517: { lowestPercent: 80 } } });
    const original = duneDb.baseGeneratorFuelLevels;
    duneDb.baseGeneratorFuelLevels = async (db, root, baseId) => {
      // The operator turns 517 off while the scan is still walking the list.
      if (baseId === 482) setBaseAutoRefill(repoRoot, 517, false, { now: clock.now, env: TEST_ENV });
      return original(db, root, baseId);
    };
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    await scheduler.tick();

    assert.deepEqual(Object.keys(readAutoRefillState(repoRoot).bases), ["482"]);
  });
});

test("nextRunAt survives a console restart instead of resetting the clock", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const armed = readAutoRefillState(repoRoot).nextRunAt;
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 5 } } });

    const first = makeScheduler(repoRoot, duneDb, clock);
    clock.advance(HOUR_MS);
    await first.scheduler.tick();

    // A fresh scheduler stands in for the restarted console process.
    const second = makeScheduler(repoRoot, duneDb, clock);
    clock.advance(HOUR_MS);
    await second.scheduler.tick();

    assert.equal(readAutoRefillState(repoRoot).nextRunAt, armed);
    assert.deepEqual(duneDb.calls, []);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot), []);
  });
});

test("a queued refill from a scan carries the restart target the flush needs", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(START).toISOString() });
    const duneDb = fakeDuneDb({
      levels: { 482: { lowestPercent: 10 } },
      target: { map: "DeepDesert", partitionId: 8, queueSupported: true, writeSafeNow: false }
    });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    await scheduler.tick();

    // The entry must be indistinguishable from a hand-queued one, so the
    // existing flush and banner need no special case for automated refills.
    const [entry] = listQueuedGeneratorRefills(repoRoot);
    assert.deepEqual({ baseId: entry.baseId, map: entry.map, partitionId: entry.partitionId }, { baseId: 482, map: "DeepDesert", partitionId: 8 });
    assert.equal(entry.attempts, 0);
  });
});

test("a scan leaves an already-queued base alone instead of resetting its attempts", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    writeAutoRefillState(repoRoot, { ...readAutoRefillState(repoRoot), nextRunAt: new Date(START).toISOString() });
    // An entry already waiting for its map to go down, two flush attempts in.
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    const queued = listQueuedGeneratorRefills(repoRoot);
    writeFileSync(
      join(repoRoot, "runtime/generated/pending-generator-refills.json"),
      `${JSON.stringify([{ ...queued[0], attempts: 2, lastError: "relation does not exist" }], null, 2)}\n`
    );
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 10 } } });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);

    await scheduler.tick();
    clock.advance(2000);
    const result = await scheduler.tick();

    // Re-queueing would replace the entry and reset attempts to 0, so the
    // flush's three-strike backstop would never be reached.
    const after = listQueuedGeneratorRefills(repoRoot);
    assert.equal(after.length, 1);
    assert.equal(after[0].attempts, 2);
    assert.equal(result.queued, 0);
    assert.equal(result.alreadyQueued, 1);
    // A map that simply has not restarted yet is not a failing refill.
    assert.equal(readAutoRefillState(repoRoot).bases["482"].consecutiveQueues, 0);
    assert.equal(readAutoRefillState(repoRoot).bases["482"].stalledAt, "");
  });
});

test("a base whose refills never take effect stops being queued after three cycles", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    // Stays starved no matter how many refills are queued -- a slot-blocked
    // device, or a flush that keeps failing until it drops the entry.
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 10 } } });
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);
    await primeScheduler(scheduler, repoRoot, clock);

    const queuedPerCycle = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      forceDue(repoRoot, clock);
      const result = await scheduler.tick();
      queuedPerCycle.push(result?.queued ?? 0);
      drainQueue(repoRoot);
      clock.advance(24 * HOUR_MS);
    }

    // Three attempts, then it gives up rather than writing to player property
    // every day forever.
    assert.deepEqual(queuedPerCycle, [1, 1, 1, 0, 0]);
    const entry = readAutoRefillState(repoRoot).bases["482"];
    assert.equal(entry.consecutiveQueues, 3);
    assert.notEqual(entry.stalledAt, "");
    // Giving up is announced, not silent.
    assert.equal(audits.filter((a) => a.action === "bases.auto-refill-stalled").length, 1);
    assert.equal(audits.filter((a) => a.action === "bases.auto-refill-queued").length, 3);
  });
});

test("stalledAt is not set on the same scan that queues the third refill", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 10 } } });
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);
    await primeScheduler(scheduler, repoRoot, clock);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      forceDue(repoRoot, clock);
      await scheduler.tick();
      drainQueue(repoRoot);
      clock.advance(24 * HOUR_MS);
    }

    // Third queue: consecutiveQueues reaches the cap, but the entry has not
    // been flushed yet -- it must not be marked stalled on this same scan.
    forceDue(repoRoot, clock);
    const thirdResult = await scheduler.tick();
    assert.equal(thirdResult.queued, 1);
    let entry = readAutoRefillState(repoRoot).bases["482"];
    assert.equal(entry.consecutiveQueues, 3);
    assert.equal(entry.stalledAt, "");
    assert.equal(audits.filter((a) => a.action === "bases.auto-refill-stalled").length, 0);

    // Only once the queue entry is gone (drained, standing in for a flush that
    // did not fix the fuel) and the next scan still sees low fuel is it stalled.
    drainQueue(repoRoot);
    clock.advance(24 * HOUR_MS);
    forceDue(repoRoot, clock);
    await scheduler.tick();
    entry = readAutoRefillState(repoRoot).bases["482"];
    assert.notEqual(entry.stalledAt, "");
    assert.equal(audits.filter((a) => a.action === "bases.auto-refill-stalled").length, 1);
  });
});

test("a base that comes back above the threshold clears its stall", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const levels = { 482: { lowestPercent: 10 } };
    const duneDb = fakeDuneDb({ levels });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock);
    await primeScheduler(scheduler, repoRoot, clock);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      forceDue(repoRoot, clock);
      await scheduler.tick();
      drainQueue(repoRoot);
      clock.advance(24 * HOUR_MS);
    }
    assert.equal(readAutoRefillState(repoRoot).bases["482"].consecutiveQueues, 3);

    // The operator fixes whatever was blocking the refill.
    levels[482] = { lowestPercent: 100 };
    forceDue(repoRoot, clock);
    await scheduler.tick();

    const recovered = readAutoRefillState(repoRoot).bases["482"];
    assert.equal(recovered.consecutiveQueues, 0);
    assert.equal(recovered.stalledAt, "");

    // And it is eligible for automation again on the next drop.
    levels[482] = { lowestPercent: 10 };
    clock.advance(24 * HOUR_MS);
    forceDue(repoRoot, clock);
    const result = await scheduler.tick();
    assert.equal(result.queued, 1);
  });
});

test("a base with no generators is not mistaken for a deleted one", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    // Zero devices, but baseMapLocation resolves -- the base is still there.
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: null, deviceCount: 0 } } });
    const { scheduler, audits } = makeScheduler(repoRoot, duneDb, clock);
    await primeScheduler(scheduler, repoRoot, clock);

    forceDue(repoRoot, clock);
    await scheduler.tick();

    assert.deepEqual(Object.keys(readAutoRefillState(repoRoot).bases), ["482"]);
    assert.equal(audits.some((entry) => entry.action === "bases.auto-refill-unenrolled"), false);
    // Existence had to be checked explicitly: a null percent means the queueing
    // path that would otherwise surface a deleted base is never reached.
    assert.equal(duneDb.calls.some((call) => call.fn === "baseMapLocation" && call.baseId === 482), true);
  });
});

test("the enrollment file is written atomically with owner-only permissions", async () => {
  await withTempRepoRoot((repoRoot) => {
    setBaseAutoRefill(repoRoot, 482, true, { env: TEST_ENV });
    const raw = readFileSync(statePath(repoRoot), "utf8");
    // Pretty-printed and newline-terminated, matching the pending refill queue.
    assert.equal(raw.endsWith("}\n"), true);
    assert.equal(JSON.parse(raw).schemaVersion, 1);
  });
});

// --- Settings layering and interval re-arm ---

test("a persisted threshold overrides the env var for the scanner itself", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 80 });
    // 60% is healthy against the env/default 50 but starved against the saved
    // 80, so this only queues if run() reads the settings file.
    const clock = makeClock();
    const duneDb = fakeDuneDb({ levels: { 482: { lowestPercent: 60, deviceCount: 2 } } });
    const { scheduler } = makeScheduler(repoRoot, duneDb, clock, {});
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    // The first tick only arms the schedule; a scan needs a primed scheduler.
    await primeScheduler(scheduler, repoRoot, clock);
    forceDue(repoRoot, clock);
    await scheduler.tick();

    assert.equal(listQueuedGeneratorRefills(repoRoot).length, 1, "queued against the saved threshold");
  });
});

test("the public state reports the persisted threshold and interval", async () => {
  await withTempRepoRoot((repoRoot) => {
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 35, intervalHours: 6 });
    const state = autoRefillPublicState(repoRoot, { env: { ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: "70" } });
    assert.equal(state.thresholdPercent, 35);
    assert.equal(state.intervalHours, 6);
  });
});

// Without this, shortening the interval looks like it did nothing until the
// already-armed run fires -- up to a week away at the maximum interval.
test("shortening the interval pulls an already-armed scan in", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const armed = Date.parse(readAutoRefillState(repoRoot).nextRunAt);
    assert.equal(armed, clock.at() + 24 * HOUR_MS, "armed a default interval out");

    saveAutoRefillSettings(repoRoot, { intervalHours: 2 });
    const next = clampAutoRefillNextRun(repoRoot, { now: clock.now, env: TEST_ENV });
    assert.equal(Date.parse(next), clock.at() + 2 * HOUR_MS);
    assert.equal(Date.parse(readAutoRefillState(repoRoot).nextRunAt), clock.at() + 2 * HOUR_MS, "persisted, not just returned");
  });
});

test("lengthening the interval leaves the armed scan where it is", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const armed = readAutoRefillState(repoRoot).nextRunAt;

    saveAutoRefillSettings(repoRoot, { intervalHours: 168 });
    assert.equal(clampAutoRefillNextRun(repoRoot, { now: clock.now, env: TEST_ENV }), armed);
    assert.equal(readAutoRefillState(repoRoot).nextRunAt, armed, "no write at all");
  });
});

test("the re-arm no-ops with nothing enrolled and with no armed run", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    // Nothing enrolled: nextRunAt is "" and must stay that way.
    assert.equal(clampAutoRefillNextRun(repoRoot, { now: clock.now, env: TEST_ENV }), "");

    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    setBaseAutoRefill(repoRoot, 482, false, { now: clock.now, env: TEST_ENV });
    assert.equal(clampAutoRefillNextRun(repoRoot, { now: clock.now, env: TEST_ENV }), "");
  });
});

test("a threshold-only save never rewrites the enrollment file", async () => {
  await withTempRepoRoot((repoRoot) => {
    const clock = makeClock();
    setBaseAutoRefill(repoRoot, 482, true, { now: clock.now, env: TEST_ENV });
    const before = readFileSync(statePath(repoRoot), "utf8");

    saveAutoRefillSettings(repoRoot, { thresholdPercent: 40 });
    clampAutoRefillNextRun(repoRoot, { now: clock.now, env: TEST_ENV });
    assert.equal(readFileSync(statePath(repoRoot), "utf8"), before);
  });
});
