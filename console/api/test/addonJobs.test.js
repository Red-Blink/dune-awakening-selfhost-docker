import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReadOnlySql } from "../src/db.js";
import {
  ADDON_SCHEDULED_RUN_RATE_SCOPE,
  EDA_EXCHANGE_BOT_ADDON_ID,
  BUYBACK_LOG_RETENTION_MS,
  BUYBACK_LOG_CLEANUP_INTERVAL_MS,
  applyDryRunMaxBuysRanking,
  applySweepLeftoverRanking,
  appendBuybackLogBatch,
  buildBuybackClassifySql,
  buildBuybackEligibilitySql,
  buildBuybackSql,
  buybackLogPath,
  buybackPlanValuesSql,
  cleanupBuybackLog,
  clearBuybackLog,
  createAddonJobScheduler,
  loadBuybackSeedPlan,
  normalizeBuybackLogEntry,
  normalizeBuybackSchedule,
  normalizeExchangeId,
  probeBuybackEligibility,
  readBuybackLog,
  readBuybackSchedule,
  refreshBuybackLog,
  saveBuybackSchedule,
  saveSeedSchedule,
  selectStoredBuybackLogEntries
} from "../src/addonJobs.js";

const SAMPLE_PLAN = {
  panel_version: "0.9.2-test",
  price_multiplier: 5,
  rows: [
    { template_id: "WaterBottle", display_name: "Water Bottle", kind: "resource", stack_size: 10, price: 1000, category_mask: 1, category_depth: 1, quality_level: 0, listings: 4 },
    { template_id: "Sword", display_name: "Sword", kind: "equippable", stack_size: 1, price: 2000, category_mask: 2, category_depth: 2, quality_level: 0, listings: 2 },
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
  return join(repoRoot, "runtime/generated/market-bot/buyback.json");
}

function writeBuybackLogBatches(config, batches) {
  const path = buybackLogPath(config);
  mkdirSync(join(config.repoRoot, "runtime/generated/market-bot"), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ batches }, null, 2)}\n`);
}

// Fake db: eligibility probes are WITH ... AS eligible_orders, classify
// queries are WITH ... AS result_code, and the sweep starts with its first
// temp table. Capability support queries get empty rows.
function fakeDb({ eligible = "0", probeRow = null, sweepRow = null, classifyRows = [], onQuery = null } = {}) {
  const probes = [];
  const classifies = [];
  const sweeps = [];
  const db = {
    probes,
    classifies,
    sweeps,
    transactions: 0,
    query: async (sql) => {
      if (onQuery) {
        const intercepted = await onQuery(sql);
        if (intercepted) return intercepted;
      }
      const text = String(sql).trim();
      if (/^WITH /.test(text) && /\bAS result_code\b/.test(text)) {
        classifies.push(sql);
        return {
          rows: classifyRows,
          fields: [{ name: "result_code" }],
          rowCount: classifyRows.length,
          command: "SELECT"
        };
      }
      if (/^WITH /.test(text)) {
        probes.push(sql);
        return {
          rows: [{
            player_sell_orders: String(eligible),
            known_player_sell_orders: String(eligible),
            eligible_orders: String(eligible),
            above_threshold_sell_orders: "0",
            unknown_template_sell_orders: "0",
            invalid_price_or_stack_sell_orders: "0",
            ...(probeRow || {})
          }],
          fields: [{ name: "eligible_orders" }], rowCount: 1, command: "SELECT"
        };
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
  assert.deepEqual(
    [defaults.augmentMultiplier, defaults.rankedArmorMultiplier, defaults.rankedWeaponMultiplier],
    [1, 1, 1],
    "category multipliers default to a neutral 1x"
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

test("normalizes category multipliers within 1-5x and keeps stored values on partial saves", () => {
  const schedule = normalizeBuybackSchedule({ augmentMultiplier: 2.5, rankedArmorMultiplier: 5, rankedWeaponMultiplier: 1.339 });
  assert.deepEqual(
    [schedule.augmentMultiplier, schedule.rankedArmorMultiplier, schedule.rankedWeaponMultiplier],
    [2.5, 5, 1.34],
    "multipliers accept decimals and round to two places"
  );

  // Saves that omit the fields (for example through the addon bridge) keep
  // the stored values instead of resetting to 1x.
  const kept = normalizeBuybackSchedule({ buybackPercent: 55 }, schedule);
  assert.deepEqual([kept.augmentMultiplier, kept.rankedArmorMultiplier, kept.rankedWeaponMultiplier], [2.5, 5, 1.34]);

  assert.throws(() => normalizeBuybackSchedule({ augmentMultiplier: 0.5 }), /augmentMultiplier must be a number from 1 to 5/);
  assert.throws(() => normalizeBuybackSchedule({ rankedArmorMultiplier: 6 }), /rankedArmorMultiplier must be a number from 1 to 5/);
  assert.throws(() => normalizeBuybackSchedule({ rankedWeaponMultiplier: "big" }), /rankedWeaponMultiplier must be a number from 1 to 5/);
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

    // Caps are calculated independently for every seeded grade. Sword grade
    // 0 is 1200 and grade 2 is 1500 at 60%; quotes remain escaped.
    const values = buybackPlanValuesSql(plan, schedule);
    assert.equal(values, "('O''Brien',0,60),\n('Sword',0,1200),\n('Sword',2,1500),\n('WaterBottle',0,600)");

    const eligibilitySql = buildBuybackEligibilitySql(plan, schedule);
    assert.ok(isReadOnlySql(eligibilitySql), "eligibility probe must be read-only SQL");
    assert.match(eligibilitySql, /o\.exchange_id = 77\b/);
    assert.match(eligibilitySql, /eligible_orders/);

    const classifySql = buildBuybackClassifySql(plan, schedule);
    assert.ok(isReadOnlySql(classifySql), "classify query must be read-only SQL");
    assert.match(classifySql, /AS result_code/);
    assert.match(classifySql, /o\.owner_id::text AS seller_actor_id/, "portal classification retains the local seller identity");
    assert.match(classifySql, /COALESCE\(o\.item_price, 0\) <= 0/, "NULL asks are invalid, not eligible");
    assert.match(classifySql, /eligible_band AS/, "eligible listings take the cap first");
    assert.match(classifySql, /skip_band AS/, "ineligible listings share one leftover top-N band");
    assert.match(classifySql, /UNION ALL/, "skip reasons fill remaining cap after eligible rows");
    assert.match(classifySql, /LIMIT GREATEST\(0, 1000 -/, "the skip band only fills leftover cap");
    assert.match(classifySql, /IS NOT TRUE/, "NULL asks stay in the skip band (NOT unknown would drop them)");
    assert.match(classifySql, /price too high/);
    assert.match(classifySql, /no reference price/);
    assert.match(classifySql, /order_id::bigint ASC/, "final order uses numeric ids, not text sort");
    assert.doesNotMatch(classifySql, /above_cap_band/, "skip reasons are not four extra listing scans");
    assert.doesNotMatch(classifySql, /\b(?:BEGIN|COMMIT)\s*;/i);

    const sweepSql = buildBuybackSql(plan, schedule);
    assert.ok(!isReadOnlySql(sweepSql), "sweep is a write");
    assert.match(sweepSql, /FOR UPDATE OF o, s SKIP LOCKED/);
    assert.match(sweepSql, /LIMIT 250 FOR UPDATE/);
    assert.match(sweepSql, /999999999/, "payment entries use the never-expires sentinel");
    assert.match(sweepSql, /PRIMARY KEY \(template_id, quality_level\)/, "the plan preserves exact per-grade caps");
    assert.match(sweepSql, /order_id BIGINT NOT NULL PRIMARY KEY/);
    assert.match(sweepSql, /GREATEST\(COALESCE\(i\.stack_size, 0\), COALESCE\(s\.initial_stack_size, 0\)\) AS actual_stack/, "the entire listed stack is purchased");
    assert.match(sweepSql, /LEAST\(GREATEST\(COALESCE\(o\.quality_level, 0\), COALESCE\(i\.quality_level, 0\), 0\), 5\)/, "grade can come from the order or backing item");
    assert.match(sweepSql, /LEFT JOIN LATERAL \(/, "unseeded grades use the conservative fallback lookup");
    assert.match(sweepSql, /o\.item_price > 0 AND GREATEST\(/, "non-positive prices and empty stacks are rejected");
    assert.match(sweepSql, /COALESCE\(o\.item_price, 0\)/, "NULL asks cannot abort the NOT NULL log insert");
    assert.match(sweepSql, /COALESCE\(rec\.template_id, ''\)/);
    assert.match(sweepSql, /'order_id', l\.order_id::text/, "BIGINT ids stay decimal strings in JSON");
    assert.match(sweepSql, /'seller_actor_id', l\.seller_actor_id::text/, "purchased rows retain their seller for private portal filtering");
    assert.match(sweepSql, /result_label, detail\)\s*VALUES \(rec\.order_id/, "purchases are logged in the loop, not by copying the whole exchange first");
    assert.match(sweepSql, /CREATE TEMP TABLE market_buy_claim_snapshot/, "leftovers are limited to pre-claim eligible ids");
    assert.match(sweepSql, /EXISTS \(SELECT 1 FROM market_buy_claim_snapshot/, "post-claim newcomers are not labeled skipped locked");
    assert.match(sweepSql, /AND NOT EXISTS \(SELECT 1 FROM market_buy_log/, "leftover log rows are remaining eligible listings only");
    assert.doesNotMatch(sweepSql, /ROW_NUMBER\(\)/, "0x5 vs 0x6 is ranked in JS from purchases-before-this-row");
    assert.doesNotMatch(sweepSql, /to_jsonb\(l\)/, "row-to-json would emit BIGINT as a JSON number");
    assert.doesNotMatch(sweepSql, /FLOOR\(p\.max_unit_price \*/, "exact grade caps are not multiplied a second time");
    assert.match(sweepSql, /o\.exchange_id = 77\b/);
    assert.match(sweepSql, /CREATE TEMP TABLE market_buy_log/);
    assert.match(sweepSql, /buyback_log/);
    assert.doesNotMatch(sweepSql, /market_buy_diagnostics/, "the write transaction does not recount every player listing");
    assert.doesNotMatch(sweepSql, /\b(?:BEGIN|COMMIT)\s*;/i, "transaction ownership stays with the database wrapper");

    assert.throws(() => buildBuybackSql(plan, { ...schedule, exchangeId: "77; DROP TABLE dune.items" }), /exchangeId is invalid/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a commodity stack is bought whole and counts as one Max Buys purchase", () => {
  // Exchange sell orders are atomic: the bot either takes the whole listing
  // or leaves it. Max Buys therefore limits listings per sweep, not units.
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const plan = loadBuybackSeedPlan(config);
    const schedule = normalizeBuybackSchedule({
      enabled: true,
      exchangeId: "42",
      priceMultiplier: 5,
      buybackPercent: 60,
      maxBuys: 3
    });
    const sweepSql = buildBuybackSql(plan, schedule);

    assert.match(
      sweepSql,
      /GREATEST\(COALESCE\(i\.stack_size, 0\), COALESCE\(s\.initial_stack_size, 0\)\) AS actual_stack/,
      "stale item.stack_size=1 must not shrink a commodity sell order"
    );
    assert.match(
      sweepSql,
      /item_price <= p\.max_unit_price/,
      "eligibility compares the per-unit ask to the cap, not stack total"
    );
    assert.match(
      sweepSql,
      /solari_balance = solari_balance - \(rec\.item_price \* rec\.actual_stack\)/,
      "seller is paid ask × whole stack"
    );
    assert.match(
      sweepSql,
      /INSERT INTO dune\.dune_exchange_fulfilled_orders \(order_id, source_order_id, completion_type, stack_size, original_order_id\) VALUES \(v_log_order_id, NULL, 4, rec\.actual_stack, rec\.order_id\)/,
      "Take Solari payment entry carries the full stack size"
    );
    assert.match(sweepSql, /DELETE FROM dune\.dune_exchange_sell_orders WHERE order_id = rec\.order_id/);
    assert.match(sweepSql, /DELETE FROM dune\.dune_exchange_orders WHERE id = rec\.order_id/);
    assert.match(sweepSql, /IF rec\.item_id IS NOT NULL THEN DELETE FROM dune\.items WHERE id = rec\.item_id/);
    assert.match(
      sweepSql,
      /v_purchased := v_purchased \+ 1; v_units := v_units \+ rec\.actual_stack; v_solari := v_solari \+ \(rec\.item_price \* rec\.actual_stack\)/,
      "one listing = one purchase; units and solari still track the full stack"
    );
    assert.match(sweepSql, /LIMIT 3 FOR UPDATE OF o, s SKIP LOCKED/, "Max Buys caps listings claimed this sweep");

    // Dry-run ranking: a 500-unit commodity stack and a 1-unit sword each
    // consume one Max Buys slot when Max Buys is 1.
    const ranked = applyDryRunMaxBuysRanking([
      normalizeBuybackLogEntry({
        order_id: "100",
        template_id: "WaterBottle",
        item_price: "50",
        stack_size: "500",
        max_unit_price: "600",
        result_code: 0,
        result_label: "eligible"
      }),
      normalizeBuybackLogEntry({
        order_id: "101",
        template_id: "Sword",
        item_price: "100",
        stack_size: "1",
        max_unit_price: "1200",
        result_code: 0,
        result_label: "eligible"
      })
    ], 1);
    assert.equal(ranked.find((row) => row.orderId === "100").resultCode, 0, "cheapest listing is bought (whole stack)");
    assert.equal(ranked.find((row) => row.orderId === "100").stackSize, "500");
    assert.equal(ranked.find((row) => row.orderId === "101").resultCode, 5, "second listing is past Max Buys, not past a unit budget");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("admin buyback rules set exchange, caps, basis, and Max Buys as intended", () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const plan = loadBuybackSeedPlan(config);

    // WaterBottle seed price 1000 at plan multiplier 5 → basis 1000 when
    // schedule priceMultiplier is 5; 60% buyback → cap 600. Lower percent or
    // higher market multiplier must change the cap the admin expects.
    assert.equal(
      buybackPlanValuesSql(plan, normalizeBuybackSchedule({ exchangeId: "1", priceMultiplier: 5, buybackPercent: 60 })),
      "('O''Brien',0,60),\n('Sword',0,1200),\n('Sword',2,1500),\n('WaterBottle',0,600)"
    );
    assert.equal(
      buybackPlanValuesSql(plan, normalizeBuybackSchedule({ exchangeId: "1", priceMultiplier: 5, buybackPercent: 30 })),
      "('O''Brien',0,30),\n('Sword',0,600),\n('Sword',2,750),\n('WaterBottle',0,300)",
      "buybackPercent scales the per-unit cap"
    );
    assert.equal(
      buybackPlanValuesSql(plan, normalizeBuybackSchedule({ exchangeId: "1", priceMultiplier: 10, buybackPercent: 60 })),
      "('O''Brien',0,120),\n('Sword',0,2400),\n('Sword',2,3000),\n('WaterBottle',0,1200)",
      "priceMultiplier reprices the seeded basis before the percent"
    );

    const seeded = buildBuybackEligibilitySql(plan, normalizeBuybackSchedule({
      exchangeId: "99",
      buybackPercent: 60,
      buybackPriceBasis: "seeded",
      maxBuys: 10
    }));
    assert.match(seeded, /o\.exchange_id = 99\b/, "only the configured exchange is probed");
    assert.match(seeded, /VALUES\n\('O''Brien',0,60\)/, "seeded basis embeds the percent caps");
    assert.doesNotMatch(seeded, /live_buy_basis/, "seeded basis does not average live asks");
    assert.match(seeded, /o\.item_price <= p\.max_unit_price/, "eligible = ask at or under the admin cap");
    assert.match(seeded, /o\.item_price > p\.max_unit_price/, "above-threshold counts use the same cap");
    assert.match(seeded, /p\.template_id IS NULL/, "unknown templates are counted, not bought");
    assert.match(seeded, /COALESCE\(o\.item_price, 0\) <= 0 OR GREATEST/, "invalid price/stack rows are counted");

    const lowest = buildBuybackEligibilitySql(plan, normalizeBuybackSchedule({
      exchangeId: "99",
      buybackPercent: 50,
      buybackPriceBasis: "lowest"
    }));
    assert.match(lowest, /MIN\(o\.item_price\)/, "lowest basis uses the cheapest live ask per grade");
    assert.match(lowest, /FLOOR\(\(basis_price \* 50 \+ 99\) \/ 100\)/, "live caps still apply buybackPercent");
    assert.match(lowest, /live_buy_caps/, "live basis still falls back to seeded caps for quiet grades");

    const average = buildBuybackEligibilitySql(plan, normalizeBuybackSchedule({
      exchangeId: "99",
      buybackPercent: 40,
      buybackPriceBasis: "average"
    }));
    assert.match(average, /AVG\(o\.item_price\)/, "average basis uses the mean live ask");
    assert.match(average, /FLOOR\(\(basis_price \* 40 \+ 99\) \/ 100\)/);

    const sweepSql = buildBuybackSql(plan, normalizeBuybackSchedule({
      exchangeId: "55",
      buybackPercent: 70,
      maxBuys: 12
    }));
    assert.match(sweepSql, /o\.exchange_id = 55\b/);
    assert.match(sweepSql, /LIMIT 12 FOR UPDATE OF o, s SKIP LOCKED/, "Max Buys is the loop claim limit");
    assert.match(sweepSql, /VALUES \(v_purchased, v_units, v_solari, 70, 12\)/, "result row records the admin percent and Max Buys");

    const classifySql = buildBuybackClassifySql(plan, normalizeBuybackSchedule({ exchangeId: "55", buybackPercent: 60 }));
    assert.match(classifySql, /WHEN p\.template_id IS NULL THEN 2/);
    assert.match(classifySql, /WHEN COALESCE\(o\.item_price, 0\) <= 0 THEN 3/);
    assert.match(classifySql, /WHEN GREATEST\(COALESCE\(i\.stack_size, 0\), COALESCE\(s\.initial_stack_size, 0\)\) <= 0 THEN 4/);
    assert.match(classifySql, /WHEN o\.item_price > p\.max_unit_price THEN 1/);
    assert.match(classifySql, /ELSE 0/);

    assert.equal(normalizeBuybackSchedule({ buybackPriceBasis: "lowest" }).buybackPriceBasis, "lowest");
    assert.equal(normalizeBuybackSchedule({ buybackPriceBasis: "average" }).buybackPriceBasis, "average");
    assert.equal(normalizeBuybackSchedule({ buybackPriceBasis: "weird" }).buybackPriceBasis, "seeded", "unknown basis falls back to seeded");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buyback caps reprice ranked categories the same way the seed run does", () => {
  // Realistic masks: high byte 0 = armor, 1 = weapons, 4 = augments.
  const plan = {
    price_multiplier: 5,
    rows: [
      { template_id: "Combat_Heavy_Unique_Top_06", kind: "equippable", price: 8000000, category_mask: 65792, quality_level: 3 },
      { template_id: "Combat_Heavy_Unique_Top_06", kind: "equippable", price: 5500000, category_mask: 65792, quality_level: 0 },
      { template_id: "UniqueDualBlades_6", kind: "equippable", price: 9600000, category_mask: 16777216, quality_level: 4 },
      { template_id: "T6_Augment_Armor1", kind: "equippable", price: 28000000, category_mask: 67239936, quality_level: 3 },
      { template_id: "WaterBottle", kind: "resource", price: 1000, category_mask: 84017152, quality_level: 0 }
    ]
  };
  const repoRoot = makeRepoRoot(plan);
  const config = { repoRoot, mockMode: false };
  try {
    const loaded = loadBuybackSeedPlan(config);
    const schedule = {
      ...normalizeBuybackSchedule({
        enabled: true,
        exchangeId: "77",
        priceMultiplier: 5,
        augmentMultiplier: 2,
        rankedArmorMultiplier: 3,
        rankedWeaponMultiplier: 1.5,
        buybackPercent: 50,
        maxBuys: 100
      }),
      augmentPricing: "original"
    };
    // Seeded basis per row: armor grade 3 8M -> 24M, grade 0 stays 5.5M,
    // weapon grade 4 9.6M -> 14.4M, augment 28M -> 56M, resource unchanged;
    // caps are 50% of that basis.
    assert.equal(
      buybackPlanValuesSql(loaded, schedule),
      "('Combat_Heavy_Unique_Top_06',0,2750000),\n" +
      "('Combat_Heavy_Unique_Top_06',3,12000000),\n" +
      "('T6_Augment_Armor1',3,28000000),\n" +
      "('UniqueDualBlades_6',4,7200000),\n" +
      "('WaterBottle',0,500)"
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buyback seeded caps follow reseed discounted augment pricing", () => {
  const plan = {
    price_multiplier: 5,
    rows: [
      { template_id: "T6_Augment_Armor3", kind: "equippable", price: 37500000, category_mask: 67108864, quality_level: 5 },
      { template_id: "T6_Augment_Armor3_Schematic", kind: "schematic", price: 3800000, category_mask: 67371008, quality_level: 5 },
      { template_id: "WaterBottle", kind: "resource", price: 1000, category_mask: 1, quality_level: 0 }
    ]
  };
  const repoRoot = makeRepoRoot(plan);
  const config = { repoRoot, mockMode: false };
  try {
    const loaded = loadBuybackSeedPlan(config);
    const base = normalizeBuybackSchedule({
      exchangeId: "1",
      priceMultiplier: 5,
      augmentMultiplier: 1,
      buybackPercent: 60
    });
    const discounted = { ...base, augmentPricing: "discounted" };
    assert.match(buybackPlanValuesSql(loaded, discounted), /\('T6_Augment_Armor3',5,1140000\)/);
    assert.match(buybackPlanValuesSql(loaded, discounted), /\('T6_Augment_Armor3_Schematic',5,2280000\)/);
    assert.match(buybackPlanValuesSql(loaded, discounted), /\('WaterBottle',0,600\)/);

    const original = { ...base, augmentPricing: "original" };
    assert.match(buybackPlanValuesSql(loaded, original), /\('T6_Augment_Armor3',5,22500000\)/);
    assert.match(buybackPlanValuesSql(loaded, original), /\('T6_Augment_Armor3_Schematic',5,2280000\)/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("probe buyback SQL inherits reseed augmentPricing for seeded caps", async () => {
  const plan = {
    price_multiplier: 5,
    rows: [
      { template_id: "T6_Augment_Armor3", kind: "equippable", price: 37500000, category_mask: 67108864, quality_level: 5 },
      { template_id: "T6_Augment_Armor3_Schematic", kind: "schematic", price: 3800000, category_mask: 67371008, quality_level: 5 }
    ]
  };
  const repoRoot = makeRepoRoot(plan);
  const config = { repoRoot, mockMode: false };
  try {
    saveBuybackSchedule(config, { exchangeId: "42", priceMultiplier: 5, augmentMultiplier: 1, buybackPercent: 60 });
    saveSeedSchedule(config, { enabled: false, exchangeId: "42", augmentPricing: "original" });
    const db = fakeDb({ eligible: "0" });
    await probeBuybackEligibility(config, db, {});
    assert.match(db.probes[0], /\('T6_Augment_Armor3',5,22500000\)/, "original reseed keeps the 37.5M item ladder");

    saveSeedSchedule(config, { enabled: false, exchangeId: "42", augmentPricing: "discounted" });
    await probeBuybackEligibility(config, db, {});
    assert.match(db.probes[1], /\('T6_Augment_Armor3',5,1140000\)/, "discounted reseed uses half the schematic");
    assert.match(db.probes[1], /\('T6_Augment_Armor3_Schematic',5,2280000\)/);
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

test("probe reports why player listings are ineligible without touching backups", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    saveBuybackSchedule(config, { exchangeId: "42", buybackPercent: 70 });
    const db = fakeDb({
      eligible: "3",
      probeRow: {
        player_sell_orders: "12",
        known_player_sell_orders: "9",
        above_threshold_sell_orders: "5",
        unknown_template_sell_orders: "3",
        invalid_price_or_stack_sell_orders: "1"
      }
    });
    const result = await probeBuybackEligibility(config, db, {});
    assert.deepEqual(result, {
      eligible: 3,
      playerListings: 12,
      knownListings: 9,
      aboveThreshold: 5,
      unknownTemplate: 3,
      invalidPriceOrStack: 1,
      exchangeId: "42",
      priceMultiplier: 5,
      augmentMultiplier: 1,
      rankedArmorMultiplier: 1,
      rankedWeaponMultiplier: 1,
      buybackPercent: 70,
      buybackPriceBasis: "seeded",
      maxBuys: 500
    });
    assert.equal(db.probes.length, 1);
    assert.equal(db.sweeps.length, 0);
    assert.match(db.probes[0], /player_sell_orders/);
    assert.match(db.probes[0], /above_threshold_sell_orders/);
    assert.match(db.probes[0], /unknown_template_sell_orders/);
    assert.ok(isReadOnlySql(db.probes[0]), "diagnostic probe remains read-only");

    const overridden = await probeBuybackEligibility(config, db, { exchangeId: "99", buybackPercent: 10, buybackPriceBasis: "lowest" });
    assert.equal(overridden.exchangeId, "99");
    assert.equal(overridden.buybackPriceBasis, "lowest");
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
      if (/\bAS eligible_orders\b/.test(String(sql))) bumpClock();
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
    assert.equal(backups[0].env.DB_BACKUP_ORIGIN, "market-bot-buyback");
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
      if (/\bAS eligible_orders\b/.test(String(sql))) await gate;
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
      if (/\bAS eligible_orders\b/.test(String(sql))) {
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

test("idle buyback runs persist a dry-run classify batch with skip reasons", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const classifyRows = [
      { order_id: "11", template_id: "Sword", quality_level: "0", item_price: "500", stack_size: "1", max_unit_price: "1200", result_code: "0", result_label: "eligible", detail: "ask 500/unit <= cap 1200" },
      { order_id: "12", template_id: "UnknownThing", quality_level: "0", item_price: "10", stack_size: "1", max_unit_price: "0", result_code: "2", result_label: "no reference price", detail: "template not in seed plan" },
      { order_id: "13", template_id: "WaterBottle", quality_level: "0", item_price: "900", stack_size: "4", max_unit_price: "600", result_code: "1", result_label: "price too high", detail: "ask 900 > cap 600" }
    ];
    const db = fakeDb({
      eligible: "0",
      probeRow: {
        player_sell_orders: "3",
        known_player_sell_orders: "2",
        above_threshold_sell_orders: "1",
        unknown_template_sell_orders: "1"
      },
      classifyRows
    });
    const { scheduler, backups, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10, maxBuys: 500 }, { now: () => state.clock });
    await scheduler.tick();
    state.clock += 10 * 60000;
    await scheduler.tick();

    assert.equal(db.probes.length, 1);
    assert.equal(db.classifies.length, 1);
    assert.equal(db.sweeps.length, 0);
    assert.equal(backups.length, 0);
    const log = readBuybackLog(config);
    assert.equal(log.batches.length, 1);
    assert.equal(log.batches[0].source, "Scheduled buyback");
    assert.equal(log.batches[0].exchangeId, "42");
    assert.match(log.batches[0].note, /nothing purchased/);
    assert.equal(log.batches[0].entries[0].displayName, "Sword");
    assert.deepEqual(log.batches[0].entries.map((entry) => entry.resultHex), ["0x0", "0x1", "0x2"]);
    assert.match(log.batches[0].entries[1].detail, /ask 900 > cap 600/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("idle buyback with no player listings skips classify but still logs an empty batch", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb({ eligible: "0" });
    const { scheduler, backups, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10 }, { now: () => state.clock });
    await scheduler.tick();
    state.clock += 10 * 60000;
    await scheduler.tick();

    assert.equal(db.probes.length, 1);
    assert.equal(db.classifies.length, 0, "empty exchange does not run a second listing scan");
    assert.equal(db.sweeps.length, 0);
    assert.equal(backups.length, 0);
    const log = readBuybackLog(config);
    assert.equal(log.batches.length, 1);
    assert.equal(log.batches[0].source, "Scheduled buyback");
    assert.equal(log.batches[0].entries.length, 0);
    assert.match(log.batches[0].note, /nothing purchased/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a write sweep persists purchases plus post-commit reasons for every remaining listing", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const buybackLog = JSON.stringify([
      { order_id: "21", template_id: "WaterBottle", result_code: 0, result_label: "success", item_price: "100", stack_size: "10", max_unit_price: "600", quality_level: 0, detail: "bought stack 10 at 100/unit (cap 600)" },
      { order_id: "22", template_id: "Sword", result_code: 0, result_label: "eligible", item_price: "200", stack_size: "1", max_unit_price: "1200", quality_level: 0, detail: "ask 200/unit <= cap 1200" }
    ]);
    const classifyRows = [
      { order_id: "22", template_id: "Sword", quality_level: "0", item_price: "200", stack_size: "1", max_unit_price: "1200", result_code: "0", result_label: "eligible", detail: "ask 200/unit <= cap 1200" },
      { order_id: "23", template_id: "WaterBottle", quality_level: "0", item_price: "900", stack_size: "1", max_unit_price: "600", result_code: "1", result_label: "price too high", detail: "ask 900 > cap 600" },
      { order_id: "24", template_id: "UnknownThing", quality_level: "0", item_price: "50", stack_size: "1", max_unit_price: "0", result_code: "2", result_label: "no reference price", detail: "template not in seed plan" }
    ];
    const db = fakeDb({ eligible: "2", classifyRows, sweepRow: { purchased: "1", total_units: "10", total_solari: "1000", buyback_log: buybackLog } });
    const { scheduler } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: false, exchangeId: "42", maxBuys: 1 });
    const result = await scheduler.runNow({ trigger: "console" });
    assert.equal(result.status, "swept");
    const log = readBuybackLog(config);
    assert.equal(log.batches[0].source, "Buyback sweep");
    assert.equal(log.batches[0].entries[0].resultHex, "0x0");
    assert.equal(log.batches[0].entries[0].resultLabel, "success");
    assert.equal(log.batches[0].entries[0].displayName, "Water Bottle");
    assert.deepEqual(log.batches[0].entries.map((entry) => entry.orderId), ["21", "23", "24", "22"]);
    assert.deepEqual(log.batches[0].entries.map((entry) => entry.resultHex), ["0x0", "0x1", "0x2", "0x5"]);
    assert.equal(db.classifies.length, 1, "completed sweeps classify the remaining board after commit");
    assert.match(log.batches[0].note, /post-sweep read-only classification/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("dry-run refresh ranks leftover eligible listings as max buys and can be cleared", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    saveBuybackSchedule(config, { exchangeId: "42", maxBuys: 1 });
    const classifyRows = [
      { order_id: "31", template_id: "WaterBottle", quality_level: "0", item_price: "10", stack_size: "2", max_unit_price: "600", result_code: "0", result_label: "eligible", detail: "ask 10" },
      { order_id: "32", template_id: "Sword", quality_level: "0", item_price: "20", stack_size: "1", max_unit_price: "1200", result_code: "0", result_label: "eligible", detail: "ask 20" }
    ];
    const db = fakeDb({ classifyRows });
    const refreshed = await refreshBuybackLog(config, db, {});
    assert.equal(refreshed.entries[0].resultHex, "0x0");
    assert.equal(refreshed.entries[1].resultHex, "0x5");
    assert.equal(refreshed.entries[1].resultLabel, "max buys limit");
    assert.equal(refreshed.batches.length, 1);
    assert.equal(refreshed.batches[0].source, "Dry-run classify");
    assert.equal((await clearBuybackLog(config)).batches.length, 0);
    assert.equal(readBuybackLog(config).batches.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buyback log cleanup drops batches older than five days and keeps the rest", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot };
  const nowMs = Date.parse("2026-08-17T12:00:00.000Z");
  try {
    writeBuybackLogBatches(config, [
      { source: "fresh", at: new Date(nowMs - BUYBACK_LOG_RETENTION_MS).toISOString(), entries: [] },
      { source: "expired", at: new Date(nowMs - BUYBACK_LOG_RETENTION_MS - 1).toISOString(), entries: [] },
      { source: "unparseable", at: "not-a-date", entries: [] },
      { source: "yesterday", at: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(), entries: [] }
    ]);
    const cleaned = await cleanupBuybackLog(config, { now: nowMs });
    assert.equal(cleaned.removed, 2);
    assert.deepEqual(cleaned.batches.map((batch) => batch.source), ["fresh", "yesterday"]);
    assert.deepEqual(readBuybackLog(config, { now: nowMs }).batches.map((batch) => batch.source), ["fresh", "yesterday"]);
    assert.deepEqual(JSON.parse(readFileSync(buybackLogPath(config), "utf8")).batches.map((batch) => batch.source), ["fresh", "yesterday"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buyback log cleanup does not rewrite the file when every batch is still fresh", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot };
  const nowMs = Date.parse("2026-08-17T12:00:00.000Z");
  try {
    const path = buybackLogPath(config);
    mkdirSync(join(config.repoRoot, "runtime/generated/market-bot"), { recursive: true });
    const payload = JSON.stringify({ batches: [{ source: "fresh", at: new Date(nowMs).toISOString(), entries: [] }] });
    writeFileSync(path, payload);
    assert.equal((await cleanupBuybackLog(config, { now: nowMs })).removed, 0);
    assert.equal(readFileSync(path, "utf8"), payload);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("appending a buyback log batch drops batches older than five days", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot };
  const nowMs = Date.parse("2026-08-17T12:00:00.000Z");
  try {
    writeBuybackLogBatches(config, [
      { source: "expired", at: new Date(nowMs - BUYBACK_LOG_RETENTION_MS - 1000).toISOString(), entries: [] },
      { source: "kept", at: new Date(nowMs - 60 * 60 * 1000).toISOString(), entries: [] }
    ]);
    await appendBuybackLogBatch(config, [{ order_id: "1", template_id: "Sword", result_code: 0, result_label: "success" }], {
      source: "Buyback sweep",
      exchangeId: "42",
      now: nowMs
    });
    assert.deepEqual(readBuybackLog(config, { now: nowMs }).batches.map((batch) => batch.source), ["Buyback sweep", "kept"]);
    const raw = readFileSync(buybackLogPath(config), "utf8");
    assert.equal(raw.endsWith("\n"), true);
    assert.equal(raw.trimEnd().includes("\n"), false, "sweep log is compact JSON to keep hourly parse cheap");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("scheduler tick prunes expired buyback log batches even when buyback is disabled", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb();
    const { scheduler, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: false, exchangeId: "42" }, { now: () => state.clock });
    writeBuybackLogBatches(config, [
      { source: "expired", at: new Date(state.clock - BUYBACK_LOG_RETENTION_MS - 1000).toISOString(), entries: [] },
      { source: "fresh", at: new Date(state.clock).toISOString(), entries: [] }
    ]);
    await scheduler.tick();
    assert.equal(db.probes.length, 0);
    assert.deepEqual(readBuybackLog(config, { now: state.clock }).batches.map((batch) => batch.source), ["fresh"]);
    assert.deepEqual(JSON.parse(readFileSync(buybackLogPath(config), "utf8")).batches.map((batch) => batch.source), ["fresh"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("scheduler tick does not re-parse the buyback log on every 10s tick", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const db = fakeDb();
    const { scheduler, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: false, exchangeId: "42" }, { now: () => state.clock });
    writeBuybackLogBatches(config, [
      { source: "expired", at: new Date(state.clock - BUYBACK_LOG_RETENTION_MS - 1000).toISOString(), entries: [] },
      { source: "fresh", at: new Date(state.clock).toISOString(), entries: [] }
    ]);
    await scheduler.tick();
    assert.deepEqual(JSON.parse(readFileSync(buybackLogPath(config), "utf8")).batches.map((batch) => batch.source), ["fresh"]);

    writeBuybackLogBatches(config, [
      { source: "expired-again", at: new Date(state.clock - BUYBACK_LOG_RETENTION_MS - 1000).toISOString(), entries: [] },
      { source: "fresh", at: new Date(state.clock).toISOString(), entries: [] }
    ]);
    state.clock += 10 * 1000;
    await scheduler.tick();
    assert.deepEqual(
      JSON.parse(readFileSync(buybackLogPath(config), "utf8")).batches.map((batch) => batch.source),
      ["expired-again", "fresh"],
      "cleanup is throttled inside the hourly window"
    );

    state.clock += BUYBACK_LOG_CLEANUP_INTERVAL_MS;
    await scheduler.tick();
    assert.deepEqual(JSON.parse(readFileSync(buybackLogPath(config), "utf8")).batches.map((batch) => batch.source), ["fresh"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("applySweepLeftoverRanking marks in-window unbought rows as skipped locked", () => {
  const ranked = applySweepLeftoverRanking([
    normalizeBuybackLogEntry({ order_id: "1", template_id: "A", item_price: "10", result_code: 0, result_label: "eligible" }),
    normalizeBuybackLogEntry({ order_id: "2", template_id: "B", item_price: "20", result_code: 0, result_label: "success" }),
    normalizeBuybackLogEntry({ order_id: "3", template_id: "C", item_price: "30", result_code: 0, result_label: "eligible" }),
    normalizeBuybackLogEntry({ order_id: "4", template_id: "D", item_price: "40", result_code: 0, result_label: "success" })
  ], 2);
  assert.equal(ranked.find((row) => row.orderId === "1").resultCode, 6, "cheaper locked row was in the fill window");
  assert.equal(ranked.find((row) => row.orderId === "2").resultCode, 0);
  assert.equal(ranked.find((row) => row.orderId === "3").resultCode, 6, "locked after one purchase, still filling maxBuys=2");
  assert.equal(ranked.find((row) => row.orderId === "4").resultCode, 0);
});

test("applySweepLeftoverRanking marks rows past a filled maxBuys as 0x5", () => {
  const ranked = applySweepLeftoverRanking([
    normalizeBuybackLogEntry({ order_id: "1", template_id: "A", item_price: "10", result_code: 0, result_label: "success" }),
    normalizeBuybackLogEntry({ order_id: "2", template_id: "B", item_price: "20", result_code: 0, result_label: "success" }),
    normalizeBuybackLogEntry({ order_id: "3", template_id: "C", item_price: "30", result_code: 0, result_label: "eligible" })
  ], 2);
  assert.equal(ranked.find((row) => row.orderId === "3").resultCode, 5);
  assert.equal(ranked.find((row) => row.orderId === "3").resultLabel, "max buys limit");
});

test("applyDryRunMaxBuysRanking keeps cheaper eligible listings and marks the rest 0x5", () => {
  const ranked = applyDryRunMaxBuysRanking([
    normalizeBuybackLogEntry({ order_id: "2", template_id: "B", item_price: "50", result_code: 0, result_label: "eligible" }),
    normalizeBuybackLogEntry({ order_id: "1", template_id: "A", item_price: "10", result_code: 0, result_label: "eligible" }),
    normalizeBuybackLogEntry({ order_id: "3", template_id: "C", item_price: "5", result_code: 1, result_label: "price too high" })
  ], 1);
  assert.equal(ranked.find((row) => row.orderId === "1").resultCode, 0);
  assert.equal(ranked.find((row) => row.orderId === "2").resultCode, 5);
  assert.equal(ranked.find((row) => row.orderId === "3").resultCode, 1);
  assert.deepEqual(ranked.map((row) => row.resultCode), [0, 1, 5], "after ranking, rows follow result_code then price like the sweep json_agg");
});

test("normalizeBuybackLogEntry prefers the seed-plan name for that template grade", () => {
  const names = new Map([
    ["Sword\u00000", "Sword"],
    ["Sword\u00002", "Sword Schematic"],
    ["Sword", "Sword"]
  ]);
  assert.equal(normalizeBuybackLogEntry({ order_id: "1", template_id: "Sword", quality_level: "2", result_code: 0 }, names).displayName, "Sword Schematic");
  assert.equal(normalizeBuybackLogEntry({ order_id: "2", template_id: "Sword", quality_level: "0", result_code: 0 }, names).displayName, "Sword");
});

test("normalizeBuybackLogEntry keeps seller ids as exact decimal strings", () => {
  const entry = normalizeBuybackLogEntry({
    order_id: "9223372036854775806",
    seller_actor_id: "9223372036854775805",
    template_id: "Sword",
    result_code: 0
  });
  assert.equal(entry.orderId, "9223372036854775806");
  assert.equal(entry.sellerActorId, "9223372036854775805");
});

test("idle buyback with unchanged skip buckets skips classify until buckets change", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    const classifyRows = [
      { order_id: "13", template_id: "WaterBottle", quality_level: "0", item_price: "900", stack_size: "4", max_unit_price: "600", result_code: "1", result_label: "price too high", detail: "ask 900 > cap 600" }
    ];
    const probeRow = {
      player_sell_orders: "2",
      known_player_sell_orders: "2",
      above_threshold_sell_orders: "2",
      unknown_template_sell_orders: "0"
    };
    const db = fakeDb({ eligible: "0", probeRow, classifyRows });
    const { scheduler, state } = makeScheduler(config, { db });
    saveBuybackSchedule(config, { enabled: true, exchangeId: "42", intervalMinutes: 10 }, { now: () => state.clock });
    await scheduler.tick();
    state.clock += 10 * 60000;
    await scheduler.tick();
    assert.equal(db.classifies.length, 1);
    assert.equal(readBuybackLog(config).batches.length, 1);

    state.clock += 10 * 60000;
    await scheduler.tick();
    assert.equal(db.classifies.length, 1, "unchanged overpriced board does not re-scan within the idle classify window");
    assert.equal(readBuybackLog(config).batches.length, 1);

    probeRow.player_sell_orders = "5";
    probeRow.above_threshold_sell_orders = "5";
    state.clock += 10 * 60000;
    await scheduler.tick();
    assert.equal(db.classifies.length, 2, "probe bucket changes force a fresh classify");
    assert.equal(readBuybackLog(config).batches.length, 2);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("selectStoredBuybackLogEntries reserves leftover slots when purchases fill the cap", () => {
  const purchases = Array.from({ length: 800 }, (_, index) => normalizeBuybackLogEntry({
    order_id: String(index + 1),
    template_id: "WaterBottle",
    item_price: String(index + 1),
    result_code: 0,
    result_label: "success"
  }));
  const leftovers = Array.from({ length: 400 }, (_, index) => normalizeBuybackLogEntry({
    order_id: String(1000 + index),
    template_id: "Sword",
    item_price: String(1000 + index),
    result_code: 5,
    result_label: "max buys limit"
  }));
  const stored = selectStoredBuybackLogEntries([...purchases, ...leftovers], 1000);
  assert.equal(stored.length, 1000);
  assert.equal(stored.filter((entry) => entry.resultLabel === "success").length, 600, "leftovers fit under half the cap, so purchases keep the rest");
  assert.equal(stored.filter((entry) => entry.resultCode === 5).length, 400, "all leftovers are kept when they fit the reserved share");

  const manyLeftovers = Array.from({ length: 900 }, (_, index) => normalizeBuybackLogEntry({
    order_id: String(2000 + index),
    template_id: "Sword",
    item_price: String(2000 + index),
    result_code: 6,
    result_label: "skipped locked"
  }));
  const balanced = selectStoredBuybackLogEntries([...purchases, ...manyLeftovers], 1000);
  assert.equal(balanced.filter((entry) => entry.resultLabel === "success").length, 500);
  assert.equal(balanced.filter((entry) => entry.resultCode === 6).length, 500);
});

test("clear during an in-flight dry-run refresh wins and skips the append", async () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot, mockMode: false };
  try {
    saveBuybackSchedule(config, { exchangeId: "42", maxBuys: 1 });
    let releaseClassify;
    const gate = new Promise((resolve) => { releaseClassify = resolve; });
    const db = fakeDb({
      classifyRows: [
        { order_id: "31", template_id: "WaterBottle", quality_level: "0", item_price: "10", stack_size: "2", max_unit_price: "600", result_code: "0", result_label: "eligible", detail: "ask 10" }
      ],
      onQuery: async (sql) => {
        if (/\bAS result_code\b/.test(String(sql))) await gate;
        return null;
      }
    });
    const refreshPromise = refreshBuybackLog(config, db, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await clearBuybackLog(config)).batches.length, 0);
    releaseClassify();
    const refreshed = await refreshPromise;
    assert.equal(refreshed.clearedDuringRefresh, true);
    assert.equal(readBuybackLog(config).batches.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("readBuybackLog hides expired batches without rewriting the file", () => {
  const repoRoot = makeRepoRoot();
  const config = { repoRoot };
  const nowMs = Date.parse("2026-08-17T12:00:00.000Z");
  try {
    const path = buybackLogPath(config);
    mkdirSync(join(config.repoRoot, "runtime/generated/market-bot"), { recursive: true });
    const payload = JSON.stringify({
      batches: [
        { source: "expired", at: new Date(nowMs - BUYBACK_LOG_RETENTION_MS - 1).toISOString(), entries: [] },
        { source: "fresh", at: new Date(nowMs).toISOString(), entries: [] }
      ]
    });
    writeFileSync(path, payload);
    assert.deepEqual(readBuybackLog(config, { now: nowMs }).batches.map((batch) => batch.source), ["fresh"]);
    assert.equal(readFileSync(path, "utf8"), payload);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
