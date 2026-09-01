import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { audit } from "../audit.js";
import { redact } from "../redact.js";
import { clampInt, writeJsonAtomic } from "../jsonStore.js";
import { resolveAutoRefillSetting } from "./autoRefillSettings.js";

// Opt-in per-base automatic generator refills. This owns only the enrollment
// list and the daily decision; the refill itself goes through the existing
// pending-refill queue in duneDb.js, so the write still lands in a window where
// the base's map is confirmed down and is still audited by the flush.
const AUTO_REFILL_PATH = "runtime/generated/auto-refill-bases.json";

// Bounded well under the queue's own MAX_PENDING_REFILLS (500) so a scan that
// enqueues every enrolled base can never overflow it.
const MAX_AUTO_REFILL_BASES = 200;
const MAX_RUN_DETAIL_LENGTH = 500;

// How many completed queue cycles a base gets before auto-refill stops trying.
// Mirrors MAX_REFILL_FLUSH_ATTEMPTS: some bases cannot be fixed by a refill at
// all, and queueing a write against player property daily forever is not an
// acceptable answer to that. Reset the moment a scan finds the base healthy.
const MAX_CONSECUTIVE_QUEUES = 3;

// How far out an overdue scan is armed at boot. See the note in tick().
const OVERDUE_ARM_DELAY_MS = 5 * 60 * 1000;

// Layered: console settings file > env var > hardcoded default, resolved in
// services/autoRefillSettings.js. These two are the ones an operator retunes
// while watching a server, so they got a settings surface; the ADMIN_REFILL_*
// queue tunables stay env-only.
//
// repoRoot is optional only so the env layer stays directly testable -- every
// production call site passes it.
export function autoRefillThresholdPercent(env = process.env, repoRoot = "") {
  return resolveAutoRefillSetting("thresholdPercent", { env, repoRoot });
}

export function autoRefillIntervalHours(env = process.env, repoRoot = "") {
  return resolveAutoRefillSetting("intervalHours", { env, repoRoot });
}

function autoRefillFile(repoRoot) {
  return resolve(repoRoot || "", AUTO_REFILL_PATH);
}

// Keeps only a parseable timestamp: a hand-edited nextRunAt that does not parse
// must read as "unset" rather than as a date in the distant past or future.
function isoField(value) {
  if (typeof value !== "string") return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString();
}

function normalizeEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  // Checked before Number(), which turns null and "" into 0 -- that would make a
  // base with no generators at all persist as 0% and read as starved.
  const raw = source.lastLowestPercent;
  const percent = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return {
    enabledAt: isoField(source.enabledAt),
    lastCheckedAt: isoField(source.lastCheckedAt),
    lastQueuedAt: isoField(source.lastQueuedAt),
    // A device can hold more than its cap if it was filled by hand, so the
    // ceiling is generous; the point is only that it stays a bounded number.
    lastLowestPercent: Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 10000) : null,
    consecutiveQueues: clampInt(source.consecutiveQueues, 0, 0, MAX_CONSECUTIVE_QUEUES),
    stalledAt: isoField(source.stalledAt)
  };
}

function normalizeState(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawBases = source.bases && typeof source.bases === "object" && !Array.isArray(source.bases)
    ? source.bases
    : {};
  const bases = {};
  let overCap = 0;
  for (const [key, value] of Object.entries(rawBases)) {
    const baseId = Math.floor(Number(key));
    if (!Number.isInteger(baseId) || baseId < 1) continue;
    // `continue` rather than `break` so the count below is the real overage.
    if (Object.keys(bases).length >= MAX_AUTO_REFILL_BASES) {
      overCap += 1;
      continue;
    }
    bases[String(baseId)] = normalizeEntry(value);
  }
  // Every write path re-normalizes, so a silent truncation here would erase the
  // dropped bases permanently on the next save. Say so, as the pending refill
  // queue does when it discards state it cannot use.
  if (overCap) {
    console.warn(`Auto-refill enrollment lists more than ${MAX_AUTO_REFILL_BASES} bases; ignoring ${overCap} beyond the cap.`);
  }
  return {
    schemaVersion: 1,
    nextRunAt: isoField(source.nextRunAt),
    lastRunAt: isoField(source.lastRunAt),
    lastRunStatus: String(source.lastRunStatus ?? "").slice(0, 40),
    lastRunDetail: String(source.lastRunDetail ?? "").slice(0, MAX_RUN_DETAIL_LENGTH),
    bases
  };
}

// A corrupt or hand-edited file never blocks the console: it degrades to an
// empty enrollment, which is also the safe direction (nothing gets refilled).
export function readAutoRefillState(repoRoot) {
  const file = autoRefillFile(repoRoot);
  if (!existsSync(file)) return normalizeState({});
  try {
    return normalizeState(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    console.warn(`Ignoring unreadable auto-refill enrollment file: ${redact(error?.message || "Unexpected error.")}`);
    return normalizeState({});
  }
}

// Deliberately synchronous read-modify-write, matching
// writeQueuedGeneratorRefills in duneDb.js: with no await between read and
// write, two requests in one console process cannot drop each other's change.
// The temp-file rename covers crash safety.
export function writeAutoRefillState(repoRoot, state) {
  const file = autoRefillFile(repoRoot);
  const next = normalizeState(state);
  writeJsonAtomic(file, next);
  return next;
}

export function isAutoRefillEnabled(repoRoot, baseId) {
  const target = Math.floor(Number(baseId));
  if (!Number.isInteger(target) || target < 1) return false;
  return Boolean(readAutoRefillState(repoRoot).bases[String(target)]);
}

// Called after the interval setting changes. tick() only re-arms once a run
// completes or when nextRunAt is empty, so a nextRunAt written under the old,
// longer interval would otherwise stand -- shortening 24h to 4h would look
// like it did nothing for up to a day.
//
// Clamps toward now ONLY: lengthening leaves the armed run alone, because
// pushing back a scan the operator is already waiting on is the more
// surprising of the two. The asymmetry is in the overlay copy and the
// operator guide. No-ops when nothing is enrolled or the interval grew, so it
// is safe to call on every save.
export function clampAutoRefillNextRun(repoRoot, { now = () => Date.now(), env = process.env } = {}) {
  const state = readAutoRefillState(repoRoot);
  if (!Object.keys(state.bases).length || !state.nextRunAt) return state.nextRunAt;
  const latest = now() + autoRefillIntervalHours(env, repoRoot) * 3600000;
  const current = Date.parse(state.nextRunAt);
  if (Number.isFinite(current) && current <= latest) return state.nextRunAt;
  return writeAutoRefillState(repoRoot, { ...state, nextRunAt: new Date(latest).toISOString() }).nextRunAt;
}

// Idempotent in both directions: a double-clicked toggle is not an error.
export function setBaseAutoRefill(repoRoot, baseId, enabled, { now = () => Date.now(), env = process.env } = {}) {
  const target = Number(baseId);
  if (!Number.isInteger(target) || target < 1) throw new Error("Invalid base id");
  const state = readAutoRefillState(repoRoot);
  const key = String(target);
  const bases = { ...state.bases };
  const wasEmpty = Object.keys(bases).length === 0;

  if (enabled) {
    if (!bases[key]) {
      if (Object.keys(bases).length >= MAX_AUTO_REFILL_BASES) {
        throw new Error(`Auto-refill already covers ${MAX_AUTO_REFILL_BASES} bases. Turn it off somewhere before adding another.`);
      }
      bases[key] = normalizeEntry({ enabledAt: new Date(now()).toISOString() });
    }
  } else {
    delete bases[key];
  }

  const remaining = Object.keys(bases).length;
  let nextRunAt = state.nextRunAt;
  if (!remaining) {
    nextRunAt = "";
  } else if (wasEmpty || !nextRunAt) {
    // Arm a full interval out, so turning auto-refill on never fires an
    // immediate surprise write into a base the operator was still looking at.
    nextRunAt = new Date(now() + autoRefillIntervalHours(env, repoRoot) * 3600000).toISOString();
  }

  const next = writeAutoRefillState(repoRoot, { ...state, bases, nextRunAt });
  return { ok: true, baseId: target, enabled: Boolean(next.bases[key]), total: remaining };
}

// Shape returned by GET /api/bases/auto-refill.
export function autoRefillPublicState(repoRoot, { env = process.env } = {}) {
  const state = readAutoRefillState(repoRoot);
  return {
    thresholdPercent: autoRefillThresholdPercent(env, repoRoot),
    intervalHours: autoRefillIntervalHours(env, repoRoot),
    nextRunAt: state.nextRunAt,
    lastRunAt: state.lastRunAt,
    lastRunStatus: state.lastRunStatus,
    lastRunDetail: state.lastRunDetail,
    total: Object.keys(state.bases).length,
    bases: Object.entries(state.bases)
      .map(([key, entry]) => ({ baseId: Number(key), ...entry }))
      .sort((a, b) => a.baseId - b.baseId)
  };
}

export function createAutoRefillScheduler(options = {}) {
  const {
    config,
    // A getter, not the pool: server.js reassigns `db` when the connection is
    // reconfigured, and a captured reference would keep using the dead pool.
    getDb,
    duneDb,
    now = () => Date.now(),
    auditImpl = audit,
    log = console,
    failureBackoffMs = 60000,
    overdueArmDelayMs = OVERDUE_ARM_DELAY_MS,
    env = process.env
  } = options;

  // Instance-scoped guards, the same role carePackageAutoRunning plays in
  // server.js and `running` plays in createAddonJobScheduler.
  let running = false;
  let nextAllowedAttemptAt = 0;
  let armedForThisProcess = false;

  function intervalMs() {
    return autoRefillIntervalHours(env, config.repoRoot) * 3600000;
  }

  function auditSafely(action, detail) {
    try {
      auditImpl(config, null, action, detail);
    } catch (error) {
      log.error(`Auto-refill audit failed: ${redact(error?.message || "Unexpected error.")}`);
    }
  }

  function persistRunCompletion(completedAtMs, outcomes, removed, status, detail) {
    // Re-read before writing so a toggle that landed while the scan was in
    // flight is not clobbered, and so a base un-enrolled mid-scan is not
    // resurrected by its own outcome.
    const current = readAutoRefillState(config.repoRoot);
    const bases = { ...current.bases };
    for (const key of removed) delete bases[key];
    for (const [key, outcome] of outcomes) {
      if (!bases[key]) continue;
      bases[key] = { ...bases[key], ...outcome };
    }
    const remaining = Object.keys(bases).length;
    writeAutoRefillState(config.repoRoot, {
      ...current,
      bases,
      lastRunAt: new Date(completedAtMs).toISOString(),
      lastRunStatus: status,
      lastRunDetail: detail,
      // Re-arm from completion, not from run start, so a slow scan cannot
      // trigger back-to-back runs. A run where every base failed (status
      // "fail") never throws out of run(), so it would otherwise wait a full
      // interval before retrying a transient outage -- use the same short
      // backoff a failure that escapes run() gets instead.
      nextRunAt: remaining ? new Date(completedAtMs + (status === "fail" ? failureBackoffMs : intervalMs())).toISOString() : ""
    });
  }

  async function scanBase(baseId, threshold, context) {
    const { enrollment, pendingBaseIds, pendingDeleteBaseIds, outcomes, removed, failures, counters } = context;
    // A base marked for deletion is frozen from every other write (see
    // baseDeletePending in server.js) -- skip it entirely rather than queue a
    // refill that a 409 would just reject, or reset its stall tracking based
    // on a scan that never really evaluated its fuel.
    if (pendingDeleteBaseIds.has(baseId)) return;
    const key = String(baseId);
    const db = getDb();
    const previous = enrollment[key] || {};
    const priorQueues = previous.consecutiveQueues || 0;
    try {
      const levels = await duneDb.baseGeneratorFuelLevels(db, config.repoRoot, baseId);
      counters.checked += 1;
      const lowest = levels.lowestPercent;
      const outcome = {
        lastCheckedAt: new Date(now()).toISOString(),
        lastLowestPercent: lowest,
        consecutiveQueues: priorQueues,
        stalledAt: previous.stalledAt || ""
      };

      // null means no recognised generators -- which baseGenerators reports both
      // for a base with none built and for a base that no longer exists, since it
      // returns zero rows either way. Only baseMapLocation separates them, so it
      // is asked here rather than relying on a later call that a null percent
      // means we never reach.
      if (lowest === null) {
        await duneDb.baseMapLocation(db, baseId);
        outcome.consecutiveQueues = 0;
        outcome.stalledAt = "";
        outcomes.set(key, outcome);
        return;
      }

      // Healthy again: whatever kept it low before has been resolved.
      if (lowest >= threshold) {
        outcome.consecutiveQueues = 0;
        outcome.stalledAt = "";
        outcomes.set(key, outcome);
        return;
      }

      // An entry from an earlier scan is still waiting for its map to go down.
      // Re-queueing would replace it and reset its attempts to 0, defeating the
      // flush's three-strike backstop -- and a map that simply has not restarted
      // yet is not evidence that refills are failing, so the stall counter must
      // not advance either.
      if (pendingBaseIds.has(baseId)) {
        counters.alreadyQueued += 1;
        outcomes.set(key, outcome);
        return;
      }

      // Queued this many times without the fuel ever coming back up. Something
      // about this base cannot be fixed by a refill (a slot-blocked inventory, a
      // flush that keeps failing until it drops the entry), so stop rather than
      // queue a write against player property every day forever. This only
      // fires once the prior queue entry has left pendingBaseIds -- applied or
      // dropped by the flush -- so a map that simply has not restarted yet
      // never gets marked stalled before its queued refill had a chance to land.
      if (priorQueues >= MAX_CONSECUTIVE_QUEUES) {
        counters.stalled += 1;
        const stalledNow = !previous.stalledAt;
        outcome.stalledAt = previous.stalledAt || new Date(now()).toISOString();
        if (stalledNow) {
          auditSafely("bases.auto-refill-stalled", {
            baseId,
            lowestPercent: lowest,
            thresholdPercent: threshold,
            consecutiveQueues: priorQueues
          });
        }
        outcomes.set(key, outcome);
        return;
      }

      const target = await duneDb.baseRefillTarget(db, baseId, { observed: context.observed });
      if (!target.queueSupported) {
        // Enrollment is gated on the queue capability, so reaching here means
        // the database changed under a running console. Refusing keeps an
        // automated write out of a possibly-live base.
        failures.push(`${baseId}: refill queueing is unsupported on this database`);
        outcomes.set(key, outcome);
        return;
      }
      duneDb.queueGeneratorRefill(config.repoRoot, {
        baseId,
        map: target.map,
        partitionId: target.partitionId
      });
      outcome.lastQueuedAt = new Date(now()).toISOString();
      outcome.consecutiveQueues = priorQueues + 1;
      counters.queued += 1;
      auditSafely("bases.auto-refill-queued", {
        baseId,
        lowestPercent: lowest,
        thresholdPercent: threshold,
        deviceCount: levels.deviceCount,
        attempt: outcome.consecutiveQueues,
        map: target.map,
        partitionId: target.partitionId
      });
      // Do not mark stalled here: this refill was only just queued, not yet
      // applied. Stalling is decided on a later scan (above) once this queue
      // entry has left pendingBaseIds and fuel is still low.
      outcomes.set(key, outcome);
    } catch (error) {
      const message = String(error?.message || "Unexpected error.");
      // A base that no longer exists would otherwise be retried every day
      // forever. Every other error leaves the enrollment alone.
      if (/was not found/i.test(message)) {
        removed.push(key);
        counters.dropped += 1;
        auditSafely("bases.auto-refill-unenrolled", { baseId, reason: "base no longer exists" });
        return;
      }
      failures.push(`${baseId}: ${message}`);
    }
  }

  async function run(baseIds, enrollment) {
    const threshold = autoRefillThresholdPercent(env, config.repoRoot);
    const context = {
      enrollment,
      // Read once per scan: which bases already have an unflushed queue entry.
      pendingBaseIds: new Set(duneDb.listQueuedGeneratorRefills(config.repoRoot).map((entry) => entry.baseId)),
      // Read once per scan: which bases have a delete queued and are frozen.
      pendingDeleteBaseIds: new Set(duneDb.listQueuedBaseDeletes(config.repoRoot).map((entry) => entry.baseId)),
      // Observed once per scan and reused by every base's baseRefillTarget call
      // below, rather than every base re-running the same world_partition scan.
      observed: await duneDb.observeRefillPartitions(getDb()),
      outcomes: new Map(),
      removed: [],
      failures: [],
      counters: { checked: 0, queued: 0, dropped: 0, stalled: 0, alreadyQueued: 0 }
    };
    const { outcomes, removed, failures, counters } = context;

    for (const key of baseIds) {
      await scanBase(Number(key), threshold, context);
    }

    const status = failures.length ? (counters.checked ? "partial" : "fail") : "ok";
    const detail = failures.length
      ? redact(failures.join("; ")).slice(0, MAX_RUN_DETAIL_LENGTH)
      : `Checked ${counters.checked}, queued ${counters.queued}`;
    persistRunCompletion(now(), outcomes, removed, status, detail);

    auditSafely("bases.auto-refill-scan", {
      enrolled: baseIds.length,
      thresholdPercent: threshold,
      ...counters,
      failures: failures.length,
      status
    });
    return { status, ...counters, failures: failures.length };
  }

  async function tick() {
    if (running) return;
    const startedAt = now();
    if (startedAt < nextAllowedAttemptAt) return;

    const state = readAutoRefillState(config.repoRoot);
    const baseIds = Object.keys(state.bases);
    // Idle cost is one small file read and no database query at all, so this
    // can share the 10s background tick without adding load.
    if (!baseIds.length) {
      armedForThisProcess = false;
      return;
    }

    const dueAtMs = Date.parse(state.nextRunAt || "") || 0;
    if (!armedForThisProcess) {
      armedForThisProcess = true;
      if (!dueAtMs || dueAtMs <= startedAt) {
        // Overdue at boot. Arm a few minutes out rather than a full interval:
        // createAddonJobScheduler re-arms a whole interval, which is harmless at
        // 30 minutes but at 24 hours would let a host that restarts more often
        // than daily never scan at all. A few minutes also keeps the scan off
        // the boot path, where the stack is still coming up.
        writeAutoRefillState(config.repoRoot, {
          ...state,
          nextRunAt: new Date(startedAt + overdueArmDelayMs).toISOString()
        });
        return;
      }
    }
    if (!dueAtMs) {
      writeAutoRefillState(config.repoRoot, {
        ...state,
        nextRunAt: new Date(startedAt + intervalMs()).toISOString()
      });
      return;
    }
    if (startedAt < dueAtMs) return;

    running = true;
    try {
      return await run(baseIds, state.bases);
    } catch (error) {
      // A failure that escapes run() must still move nextRunAt, or every tick
      // retries it at the full tick rate.
      nextAllowedAttemptAt = now() + failureBackoffMs;
      persistRunCompletion(now(), new Map(), [], "fail", redact(String(error?.message || "Unexpected error.")).slice(0, MAX_RUN_DETAIL_LENGTH));
      throw error;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    publicState: () => autoRefillPublicState(config.repoRoot, { env }),
    thresholdPercent: () => autoRefillThresholdPercent(env, config.repoRoot),
    intervalHours: () => autoRefillIntervalHours(env, config.repoRoot)
  };
}
