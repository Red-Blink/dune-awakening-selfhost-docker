import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReadOnlySql } from "../src/db.js";
import {
  ADDON_SCHEDULED_RUN_RATE_SCOPE,
  EDA_EXCHANGE_BOT_ADDON_ID,
  buildBuybackEligibilitySql,
  buildBuybackSql,
  buybackPlanValuesSql,
  createAddonJobScheduler,
  loadBuybackSeedPlan,
  normalizeBuybackSchedule,
  normalizeExchangeId,
  probeBuybackEligibility,
  readBuybackSchedule,
  saveBuybackSchedule
} from "../src/addonJobs.js";

const SAMPLE_PLAN = {
  panel_version: "0.9.2-test",
  price_multiplier: 5,
  rows: [
    { template_id: "WaterBottle", display_name: "Water Bottle", kind: "resource", stack_size: 10, price: 1000, category_mask: 1, category_depth: 1, quality_level: 0, listings: 4 },
    { template_id: "Sword", display_name: "Sword Schematic", kind: "schematic", stack_size: 1, price: 2500, category_mask: 2, category_depth: 2, quality_level: 2, listings: 2 },
    { template_id: "O'Brien", display_name: "Quoted Template", kind: "resource", stack_size: 1, price: 100, category_mask: 1, category_depth: 1, quality_level: 0, listings: 1 }
  ]
};

function makeRepoRoot(plan = SAMPLE_PLAN) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-jobs-"));
  const webDir = join(repoRoot, "runtime/addons/installed", EDA_EXCHANGE_BOT_ADDON_ID, "web");
  mkdirSync(webDir, { recursive: true });
  if (plan) writeFileSync(join(webDir, "market-seed-plan.json"), JSON.stringify(plan));
  return repoRoot;
}

function schedulePath(repoRoot) {
  return join(repoRoot, "runtime/addons/jobs", EDA_EXCHANGE_BOT_ADDON_ID, "buyback.json");
}

// Fake db: the first statement of the eligibility probe is WITH, the sweep
// starts with its first temp table; capability support queries get empty rows.
function fakeDb({ eligible = "0", sweepRow = null, onQuery = null } = {}) {
  const probes = [];
  const sweeps = [];
  const db = {
    probes,
    sweeps,
    transactions: 0,
    query: async (sql) => {
      if (onQuery) {
        const intercepted = await onQuery(sql);
        if (intercepted) return intercepted;
      }
      const text = String(sql).trim();
      if (/^WITH market_buy_plan/.test(text)) {
        probes.push(sql);
        return { rows: [{ eligible_orders: String(eligible) }], fields: [{ name: "eligible_orders" }], rowCount: 1, command: "SELECT" };
      }
      if (/^CREATE TEMP TABLE market_buy_plan/.test(text)) {
        sweeps.push(sql);
        return {
          rows: [sweepRow || { purchased: "2", total_units: "20", total_solari: "999", threshold_percent: "60", max_buys: "500" }],
          fields: [{ name: "purchased" }],
          rowCount: 1,
          command: "SELECT"
        };
      }
      return { rows: [], fields: [], rowCount: 0, command: "SELECT" };
    },
    transaction: async (fn) => {
      db.transactions += 1;
      return fn({ query: db.query });
    }
  };
  return db;
}

function makeScheduler(config, overrides = {}) {
  const backups = [];
  const audits = [];
  const permissionChecks = [];
  const state = { clock: Date.parse("2026-07-23T12:00:00.000Z") };
  const scheduler = createAddonJobScheduler(config, {
    getDb: () => overrides.db,
    now: () => state.clock,
    runDuneImpl: async (_config, args, options = {}) => {
      backups.push({ args, env: options.env });
      return { code: 0, stdout: "backup ok", stderr: "" };
    },
    assertPermission: (cfg, addonId, permission) => {
      permissionChecks.push(permission);
      if (overrides.deniedPermissions?.includes(permission)) {
        throw new Error(`${addonId} is not approved for ${permission} permission.`);
      }
      return { id: addonId, permission };
    },
    auditImpl: (_config, _req, action, detail) => audits.push({ action, detail }),
    failureBackoffMs: overrides.failureBackoffMs ?? 60000,
    mutationLimiter: overrides.mutationLimiter ?? null,
    log: { error: () => {} }
  });
  return { scheduler, backups, audits, permissionChecks, state };
}

test("validates exchange ids as decimal strings up to PG BIGINT max", () => {
  assert.equal(normalizeExchangeId("42"), "42");
  assert.equal(normalizeExchangeId(" 9223372036854775807 "), "9223372036854775807");
  assert.equal(normalizeExchangeId("9223372036854775808"), null);
  assert.equal(normalizeExchangeId("0"), null);
  assert.equal(normalizeExchangeId("-5"), null);
  assert.equal(normalizeExchangeId("12abc"), null);
  assert.equal(normalizeExchangeId("1e3"), null);
  assert.equal(normalizeExchangeId(""), null);
});

test("normalizes schedule fields with clamped interval and strict ranges", () => {
  const schedule = normalizeBuybackSchedule({ enabled: true, exchangeId: "42", intervalMinutes: 5, priceMultiplier: 7, buybackPercent: 55, maxBuys: 100 });
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.exchangeId, "42");
  assert.equal(schedule.intervalMinutes, 10, "interval below floor clamps to 10");
  assert.equal(normalizeBuybackSchedule({ intervalMinutes: 100000 }).intervalMinutes, 1440, "interval above ceiling clamps to 1440");
  assert.deepEqual(
    [schedule.priceMultiplier, schedule.buybackPercent, schedule.maxBuys],
    [7, 55, 100]
  );

  const defaults = normalizeBuybackSchedule({});
  assert.deepEqual(
    [defaults.enabled, defaults.intervalMinutes, defaults.exchangeId, defaults.priceMultiplier, defaults.buybackPercent, defaults.maxBuys],
    [false, 30, "", 5, 60, 500]
  );

  assert.throws(() => normalizeBuybackSchedule({ enabled: true }), /requires an exchangeId/);
  assert.throws(() => normalizeBuybackSchedule({ enabled: "yes" }), /must be true or false/);
  assert.throws(() => normalizeBuybackSchedule({ exchangeId: "0" }), /exchangeId/);
  assert.throws(() => normalizeBuybackSchedule({ exchangeId: "9223372036854775808" }), /exchangeId/);
  assert.throws(() => normalizeBuybackSchedule({ intervalMinutes: "soon" }), /intervalMinutes/);
  assert.throws(() => normalizeBuybackSchedule({ priceMultiplier: 0 }), /priceMultiplier/);
  assert.throws(() => normalizeBuybackSchedule({ buybackPercent: 101 }), /buybackPercent/);
  assert.throws(() => normalizeBuybackSchedule({ maxBuys: 5001 }), /maxBuys/);
});

test("persists the schedule atomically with owner-only permissions and survives reload", () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  const now = () => Date.parse("2026-07-23T12:00:00.000Z");
  try {
    const saved = saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 15 }, { now });
    assert.equal(saved.nextRunAt, "2026-07-23T12:15:00.000Z", "enabling arms one full interval out");
    assert.equal(statSync(schedulePath(repoRoot)).mode & 0o777, 0o600);
    assert.deepEqual(readBuybackSchedule(config), saved);

    const unchanged = saveBuybackSchedule(config, { enabled: true, exchangeId: "43" }, { now: () => Date.parse("2026-07-23T12:10:00.000Z") });
    assert.equal(unchanged.nextRunAt, saved.nextRunAt, "changing other fields keeps the armed time");
    assert.equal(unchanged.exchangeId, "43");

    const rearmed = saveBuybackSchedule(config, { intervalMinutes: 30 }, { now: () => Date.parse("2026-07-23T12:10:00.000Z") });
    assert.equal(rearmed.nextRunAt, "2026-07-23T12:40:00.000Z", "interval changes re-arm from now");

    const disabled = saveBuybackSchedule(config, { enabled: false }, { now });
    assert.equal(disabled.nextRunAt, "");
    assert.equal(disabled.exchangeId, "43", "disabling keeps the configured exchange");

    writeFileSync(schedulePath(repoRoot), "not json");
    assert.equal(readBuybackSchedule(config).enabled, false, "corrupt schedule file falls back to disabled defaults");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("builds buyback SQL server-side from the bundled seed plan", () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const plan = loadBuybackSeedPlan(config);
    const schedule = normalizeBuybackSchedule({ enabled: true, exchangeId: "77", priceMultiplier: 5, buybackPercent: 60, maxBuys: 250 });

    // Sword is bundled at grade 2 (multiplier 1.25): 2500 normalizes to a
    // grade-0 price of 2000, then 60% rounds up to 1200. WaterBottle stays
    // 1000 grade-0, 60% -> 600. Quotes in template ids are escaped.
    const values = buybackPlanValuesSql(plan, schedule);
    assert.equal(values, "('O''Brien',60),\n('Sword',1200),\n('WaterBottle',600)");

    const eligibilitySql = buildBuybackEligibilitySql(plan, schedule);
    assert.ok(isReadOnlySql(eligibilitySql), "eligibility probe must be read-only SQL");
    assert.match(eligibilitySql, /o\.exchange_id = 77\b/);
    assert.match(eligibilitySql, /eligible_orders/);

    const sweepSql = buildBuybackSql(plan, schedule);
    assert.ok(!isReadOnlySql(sweepSql), "sweep is a write");
    assert.match(sweepSql, /FOR UPDATE OF o, s SKIP LOCKED/);
    assert.match(sweepSql, /LIMIT 250 FOR UPDATE/);
    assert.match(sweepSql, /999999999/, "payment entries use the never-expires sentinel");
    assert.match(sweepSql, /\(ARRAY\[1\.0,1\.0,1\.25,1\.5,1\.75,2\.0\]\)/, "grade multipliers are applied in SQL");
    assert.match(sweepSql, /o\.exchange_id = 77\b/);
    assert.doesNotMatch(sweepSql, /\b(?:BEGIN|COMMIT)\s*;/i, "transaction ownership stays with the database wrapper");

    assert.throws(() => buildBuybackSql(plan, { ...schedule, exchangeId: "77; DROP TABLE dune.items" }), /exchangeId is invalid/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("rejects missing or malformed bundled seed plans", () => {
  const missing = makeRepoRoot(null);
  const malformed = makeRepoRoot({ price_multiplier: 5, rows: [{ template_id: "", price: 10 }] });
  try {
    assert.throws(() => loadBuybackSeedPlan({ repoRoot: missing }), /market-seed-plan\.json/);
    assert.throws(() => loadBuybackSeedPlan({ repoRoot: malformed }), /invalid template_id/);
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(malformed, { recursive: true, force: true });
  }
});

test("probe runs the read-only eligibility query without touching backups", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    saveBuybackSchedule(config, { exchangeId: "42", buybackPercent: 70 });
    const db = fakeDb({ eligible: "3" });
    const result = await probeBuybackEligibility(config, db, {});
    assert.deepEqual(result, { eligible: 3, exchangeId: "42", priceMultiplier: 5, buybackPercent: 70, maxBuys: 500 });
    assert.equal(db.probes.length, 1);
    assert.equal(db.sweeps.length, 0);

    const overridden = await probeBuybackEligibility(config, db, { exchangeId: "99", buybackPercent: 10 });
    assert.equal(overridden.exchangeId, "99");
    assert.match(db.probes[1], /o\.exchange_id = 99\b/);

    await assert.rejects(() => probeBuybackEligibility({ repoRoot: makeRepoRoot() }, db, {}), /exchangeId is required/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("tick waits for the armed time, skips the backup when idle, and re-arms from completion", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "0" });
    const { scheduler, backups, audits, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10 }, { now: () => state.clock });

    await scheduler.tick();
    assert.equal(db.probes.length, 0, "first tick arms without running");

    state.clock += 5 * 60000;
    await scheduler.tick();
    assert.equal(db.probes.length, 0, "not due yet");

    state.clock += 5 * 60000;
    const dueAt = state.clock;
    // Simulate a probe that takes 2 minutes so re-arm-from-completion is visible.
    let bumpClock = () => {};
    const slowDb = fakeDb({ eligible: "0", onQuery: async (sql) => {
      if (/^WITH market_buy_plan/.test(String(sql).trim())) bumpClock();
      return null;
    } });
    const slow = makeScheduler(config, { db: slowDb });
    bumpClock = () => { slow.state.clock = dueAt + 2 * 60000; };
    slow.state.clock = dueAt - 60000;
    await slow.scheduler.tick(); // arms; persisted nextRunAt is still one minute out
    slow.state.clock = dueAt;
    await slow.scheduler.tick();
    assert.equal(slowDb.probes.length, 1, "due tick runs the eligibility probe");
    assert.equal(slowDb.sweeps.length, 0, "idle probe takes no sweep");
    assert.equal(slow.backups.length, 0, "idle probe takes no backup");

    const persisted = readBuybackSchedule(config);
    assert.equal(persisted.lastRunStatus, "idle");
    assert.match(persisted.lastRunDetail, /sweep and backup skipped/);
    assert.equal(persisted.nextRunAt, new Date(dueAt + 2 * 60000 + 10 * 60000).toISOString(), "re-armed from completion time, not start time");
    assert.equal(slow.audits.length, 1);
    assert.equal(slow.audits[0].detail.status, "idle");
    assert.equal(backups.length, 0);
    assert.equal(audits.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("eligible run takes exactly one backup before the sweep and audits the result", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "4", sweepRow: { purchased: "4", total_units: "40", total_solari: "1234" } });
    const { scheduler, backups, audits, permissionChecks, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10, maxBuys: 50 }, { now: () => state.clock });

    await scheduler.tick(); // arms
    state.clock += 10 * 60000;
    await scheduler.tick();

    assert.equal(db.probes.length, 1);
    assert.equal(db.sweeps.length, 1);
    assert.equal(db.transactions, 1, "eligible sweep runs through the rollback-safe transaction helper");
    assert.match(db.sweeps[0], /LIMIT 50 FOR UPDATE OF o, s SKIP LOCKED/);
    assert.equal(backups.length, 1, "eligible run takes exactly one backup");
    assert.deepEqual(backups[0].args, ["db", "backup"]);
    assert.equal(backups[0].env.DB_BACKUP_ORIGIN, "addon-eda-exchange-bot");
    assert.deepEqual(permissionChecks, ["database:read", "database:write", "scheduler:server"], "installed/enabled/approved is verified on every run");

    const persisted = readBuybackSchedule(config);
    assert.equal(persisted.lastRunStatus, "swept");
    assert.match(persisted.lastRunDetail, /Bought 4 listings \(40 units\) for 1234 solari/);
    assert.equal(persisted.lastRunAt, new Date(state.clock).toISOString());
    assert.equal(persisted.nextRunAt, new Date(state.clock + 10 * 60000).toISOString());
    assert.equal(audits.length, 1);
    assert.deepEqual(
      [audits[0].action, audits[0].detail.status, audits[0].detail.purchased, audits[0].detail.trigger, audits[0].detail.ok],
      ["addons.scheduled-job", "swept", 4, "schedule", true]
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("permission revocation stops scheduled runs before any query or backup", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "5" });
    const { scheduler, backups, audits, state } = makeScheduler(config, { db, deniedPermissions: ["scheduler:server"], failureBackoffMs: 60000 });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10 }, { now: () => state.clock });

    await scheduler.tick(); // arms
    state.clock += 10 * 60000;
    await scheduler.tick();

    assert.equal(db.probes.length, 0, "no eligibility query after revocation");
    assert.equal(db.sweeps.length, 0);
    assert.equal(backups.length, 0);
    const persisted = readBuybackSchedule(config);
    assert.equal(persisted.lastRunStatus, "error");
    assert.match(persisted.lastRunDetail, /not approved for scheduler:server/);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].detail.ok, false);

    state.clock += 30000;
    await scheduler.tick();
    assert.equal(audits.length, 1, "failure backoff prevents immediate retries");

    state.clock += 10 * 60000;
    await scheduler.tick();
    assert.equal(audits.length, 2, "after backoff and re-arm the guard re-checks permissions");
    assert.equal(db.probes.length, 0, "runs stay blocked while the permission is revoked");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("concurrent ticks and manual runs are guarded by the running flag", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    let releaseProbe;
    const gate = new Promise((resolve) => { releaseProbe = resolve; });
    const db = fakeDb({ eligible: "0", onQuery: async (sql) => {
      if (/^WITH market_buy_plan/.test(String(sql).trim())) await gate;
      return null;
    } });
    const { scheduler, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10 }, { now: () => state.clock });

    await scheduler.tick(); // arms
    state.clock += 10 * 60000;
    const first = scheduler.tick();
    const second = scheduler.tick();
    await second;
    assert.equal(scheduler.isRunning(), true);
    await assert.rejects(() => scheduler.runNow(), /already in progress/);
    releaseProbe();
    await first;
    assert.equal(db.probes.length, 1, "only one run enters while another is in flight");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("restart recovery re-arms an overdue schedule instead of firing immediately", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "1" });
    const { scheduler, backups, state } = makeScheduler(config, { db });
    const enabledAt = state.clock - 3 * 60 * 60000;
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10 }, { now: () => enabledAt });
    assert.ok(Date.parse(readBuybackSchedule(config).nextRunAt) < state.clock, "persisted nextRunAt is overdue after downtime");

    await scheduler.tick();
    assert.equal(db.probes.length, 0, "overdue schedule does not fire at boot");
    assert.equal(backups.length, 0);
    const rearmed = readBuybackSchedule(config);
    assert.equal(rearmed.nextRunAt, new Date(state.clock + 10 * 60000).toISOString(), "nextRunAt recomputed from boot time");

    state.clock += 10 * 60000;
    await scheduler.tick();
    assert.equal(db.probes.length, 1, "runs once the recomputed time arrives");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a future nextRunAt persisted before restart is kept", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "0" });
    const { scheduler, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 20 }, { now: () => state.clock });
    const persistedNextRun = readBuybackSchedule(config).nextRunAt;

    state.clock += 5 * 60000; // "restart" 5 minutes later with 15 still to go
    await scheduler.tick();
    assert.equal(readBuybackSchedule(config).nextRunAt, persistedNextRun, "future arm time survives restart untouched");
    state.clock = Date.parse(persistedNextRun);
    await scheduler.tick();
    assert.equal(db.probes.length, 1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("scheduled runs consume a dedicated mutation rate-limit scope", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "0" });
    const limited = [];
    const recorded = [];
    let allow = true;
    const mutationLimiter = {
      check: (key) => {
        limited.push(key);
        return allow ? { allowed: true } : { allowed: false, retryAfterSeconds: 30 };
      },
      record: (key) => recorded.push(key)
    };
    const { scheduler, state } = makeScheduler(config, { db, mutationLimiter });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10 }, { now: () => state.clock });

    await scheduler.tick(); // arms
    state.clock += 10 * 60000;
    allow = false;
    await scheduler.tick();
    assert.equal(db.probes.length, 0, "rate-limited tick does not run");
    assert.deepEqual(limited, [ADDON_SCHEDULED_RUN_RATE_SCOPE]);
    assert.deepEqual(recorded, []);

    allow = true;
    state.clock += 60000; // past failure backoff
    await scheduler.tick();
    assert.equal(db.probes.length, 1);
    assert.deepEqual(recorded, [ADDON_SCHEDULED_RUN_RATE_SCOPE]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("manual runNow sweeps immediately and leaves a disabled schedule unarmed", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "2", sweepRow: { purchased: "2", total_units: "8", total_solari: "500" } });
    const { scheduler, backups, audits, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: false, exchangeId: "42" }, { now: () => state.clock });

    const result = await scheduler.runNow();
    assert.equal(result.status, "swept");
    assert.equal(result.purchased, 2);
    assert.equal(backups.length, 1);
    assert.equal(audits[0].detail.trigger, "manual");
    const persisted = readBuybackSchedule(config);
    assert.equal(persisted.lastRunStatus, "swept");
    assert.equal(persisted.nextRunAt, "", "manual run on a disabled schedule does not arm it");

    rmSync(schedulePath(repoRoot));
    await assert.rejects(() => scheduler.runNow(), /Save a schedule with an exchangeId/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("eligible runs refuse to sweep without rollback-safe transaction support", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "1" });
    delete db.transaction;
    const { scheduler, backups } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: false, exchangeId: "42" });

    await assert.rejects(() => scheduler.runNow(), /requires database transaction support/);
    assert.equal(backups.length, 0, "no unnecessary backup is taken when the sweep cannot run safely");
    assert.equal(db.sweeps.length, 0, "no write starts without guaranteed rollback support");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("disabling mid-run is respected when the run completes", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "0", onQuery: async (sql) => {
      if (/^WITH market_buy_plan/.test(String(sql).trim())) {
        saveBuybackSchedule(config, { enabled: false });
      }
      return null;
    } });
    const { scheduler, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10 }, { now: () => state.clock });

    await scheduler.tick(); // arms
    state.clock += 10 * 60000;
    await scheduler.tick();
    const persisted = readBuybackSchedule(config);
    assert.equal(persisted.enabled, false);
    assert.equal(persisted.nextRunAt, "", "completion does not re-arm a schedule disabled mid-run");
    assert.equal(persisted.lastRunStatus, "idle");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
