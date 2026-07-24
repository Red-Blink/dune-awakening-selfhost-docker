// Server-side scheduled jobs for installed addons.
//
// The first (and currently only) job is the EDA Exchange Bot buyback sweep.
// The addon's browser page can only automate while its iframe stays open, so
// the console API process runs the same loop unattended: a read-only
// eligibility probe every interval, and a buyback sweep (preceded by a
// database backup) only when eligible player listings exist.
//
// No SQL from the addon iframe is ever persisted or replayed. The SQL below
// is built server-side from the addon's bundled web/market-seed-plan.json and
// a strictly validated schedule config, following the typed-action precedent
// of admin.items.grant.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildDuneArgs, runDune } from "./runner.js";
import { assertInstalledAddonPermission } from "./addons.js";
import { runSql } from "./duneDb.js";
import { audit } from "./audit.js";
import { redact } from "./redact.js";

export const EDA_EXCHANGE_BOT_ADDON_ID = "eda-exchange-bot";
export const ADDON_SCHEDULER_PERMISSION = "scheduler:server";
export const ADDON_SCHEDULED_RUN_RATE_SCOPE = `addon-scheduler:${EDA_EXCHANGE_BOT_ADDON_ID}`;

// Quality-grade price multipliers for grades 0-5, matching Easy Dune Admin's
// market bot defaults (ported from the addon's web/addon.js).
const GRADE_MULTIPLIERS = [1.0, 1.0, 1.25, 1.5, 1.75, 2.0];
const GRADE_MULTIPLIER_SQL = "(ARRAY[1.0,1.0,1.25,1.5,1.75,2.0])[LEAST(GREATEST(COALESCE(o.quality_level, 0), 0), 5) + 1]";

// Sentinel expiration used by EDA's market bot for seller "Take Solari"
// payment entries. The game server's exchange housekeeping procs purge
// past-dated orders; a payment entry must never expire or the seller's item
// is consumed with no Solari paid out.
//
// Time-base note: dune_exchange_orders.expiration_time is NOT a Unix epoch.
// The exchange procs compare it against the game server's own clock, whose
// values sit well below 999,999,999 — Easy Dune Admin's marketbot
// (internal/marketbot/exchange.go, the source this fix is ported from)
// reconstructs "gameNow" from real player/bot listing expirations using
// `WHERE expiration_time < 999_999_999` as the non-sentinel filter, which
// only works because live expirations are below that cutoff. Its deployed
// sellerPaymentExpiry() returns exactly this sentinel. Do not "fix" this to a
// far-future Unix timestamp; it must simply stay far above the game clock and
// aligned with the sentinel the addon's own browser sweep writes.
const PAYMENT_SENTINEL_EXPIRY = 999999999;

// PostgreSQL BIGINT ids can exceed Number.MAX_SAFE_INTEGER (2^53 - 1), so
// exchange ids are kept as validated decimal strings end-to-end and are never
// converted with Number().
const EXCHANGE_ID_PATTERN = /^[1-9][0-9]*$/;
const PG_BIGINT_MAX = 9223372036854775807n;

const MAX_RUN_DETAIL_LENGTH = 500;
const MAX_SEED_PLAN_BYTES = 10 * 1024 * 1024;

export function normalizeExchangeId(value) {
  const raw = String(value ?? "").trim();
  if (!EXCHANGE_ID_PATTERN.test(raw)) return null;
  if (BigInt(raw) > PG_BIGINT_MAX) return null;
  return raw;
}

export function normalizeBuybackSchedule(payload = {}, previous = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Buyback schedule must be a JSON object.");
  const enabled = payload.enabled === undefined ? Boolean(previous.enabled) : payload.enabled;
  if (typeof enabled !== "boolean") throw new Error("Buyback schedule enabled must be true or false.");

  const rawExchangeId = payload.exchangeId === undefined ? String(previous.exchangeId ?? "").trim() : String(payload.exchangeId ?? "").trim();
  let exchangeId = "";
  if (rawExchangeId) {
    exchangeId = normalizeExchangeId(rawExchangeId) ?? "";
    if (!exchangeId) throw new Error("Buyback schedule exchangeId must be a positive whole number (PostgreSQL BIGINT).");
  }
  if (enabled && !exchangeId) throw new Error("Buyback schedule requires an exchangeId before it can be enabled.");

  return {
    enabled,
    intervalMinutes: clampedIntegerField(payload.intervalMinutes ?? previous.intervalMinutes ?? 30, "intervalMinutes", 10, 1440),
    exchangeId,
    priceMultiplier: integerField(payload.priceMultiplier ?? previous.priceMultiplier ?? 5, "priceMultiplier", 1, 100),
    buybackPercent: integerField(payload.buybackPercent ?? previous.buybackPercent ?? 60, "buybackPercent", 1, 100),
    maxBuys: integerField(payload.maxBuys ?? previous.maxBuys ?? 500, "maxBuys", 1, 5000),
    lastRunAt: isoField(previous.lastRunAt),
    lastRunStatus: String(previous.lastRunStatus ?? "").slice(0, 40),
    lastRunDetail: String(previous.lastRunDetail ?? "").slice(0, MAX_RUN_DETAIL_LENGTH),
    nextRunAt: isoField(previous.nextRunAt)
  };
}

export function readBuybackSchedule(config) {
  const path = buybackSchedulePath(config);
  let raw = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
    } catch {
      raw = {};
    }
  }
  try {
    return normalizeBuybackSchedule({}, raw);
  } catch {
    // A corrupt or hand-edited schedule never blocks the console: fall back
    // to a disabled schedule and let the operator re-save it from the addon.
    return normalizeBuybackSchedule({}, {});
  }
}

// Read-modify-write over the schedule file. This function and
// persistRunCompletion in createAddonJobScheduler are deliberately fully
// synchronous (no await between read and write), so within the single console
// process they cannot interleave and clobber each other's fields; the atomic
// temp-file rename covers crash safety. Multiple console processes sharing one
// repoRoot are not a supported deployment for runtime/ state files.
export function saveBuybackSchedule(config, payload = {}, { now = () => Date.now() } = {}) {
  const previous = readBuybackSchedule(config);
  const next = normalizeBuybackSchedule(payload, previous);
  if (!next.enabled) {
    next.nextRunAt = "";
  } else if (!previous.enabled || next.intervalMinutes !== previous.intervalMinutes || !previous.nextRunAt) {
    // Arm one full interval out so enabling (or shortening the interval)
    // never fires an immediate surprise write.
    next.nextRunAt = new Date(now() + next.intervalMinutes * 60000).toISOString();
  } else {
    next.nextRunAt = previous.nextRunAt;
  }
  writeBuybackSchedule(config, next);
  return next;
}

export function loadBuybackSeedPlan(config, addonId = EDA_EXCHANGE_BOT_ADDON_ID) {
  const path = resolve(config.repoRoot, "runtime/addons/installed", addonId, "web", "market-seed-plan.json");
  if (!existsSync(path)) throw new Error(`Installed addon ${addonId} does not include web/market-seed-plan.json.`);
  const text = readFileSync(path, "utf8");
  if (text.length > MAX_SEED_PLAN_BYTES) throw new Error("Addon market seed plan is too large.");
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new Error("Addon market seed plan is not valid JSON.");
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Addon market seed plan must be a JSON object.");
  if (!Array.isArray(plan.rows) || !plan.rows.length) throw new Error("Addon market seed plan has no seed rows.");
  const sourceMultiplier = Math.max(1, Number(plan.price_multiplier) || 1);
  const rows = plan.rows.map((row, index) => {
    const templateId = String(row?.template_id ?? "").trim();
    if (!templateId || templateId.length > 200) throw new Error(`Addon market seed plan row ${index + 1} has an invalid template_id.`);
    const price = Number(row?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Addon market seed plan row ${index + 1} has an invalid price.`);
    return { templateId, price, qualityLevel: clampInteger(row?.quality_level, 0, 0, 5) };
  });
  return { sourceMultiplier, rows };
}

// Buyback plan: per-template base (grade 0) max unit price scaled by the
// buyback threshold percent. Grade-adjusted reference prices are computed in
// SQL from the player order's quality_level using the same grade multipliers
// the seeder uses (ported from the addon's buybackPlanValuesSql).
export function buybackPlanValuesSql(plan, { priceMultiplier, buybackPercent }) {
  const maxPrice = new Map();
  for (const row of plan.rows) {
    const repriced = roundPrice((row.price / plan.sourceMultiplier) * priceMultiplier);
    // Normalize to a grade-0 price: some bundled plan rows carry a non-zero
    // quality_level with an already grade-adjusted price, and the SQL applies
    // the grade multiplier itself. Without this the multiplier stacks twice.
    const mult = GRADE_MULTIPLIERS[row.qualityLevel] || 1.0;
    const grade0Price = Math.round(repriced / mult);
    maxPrice.set(row.templateId, Math.max(maxPrice.get(row.templateId) || 0, grade0Price));
  }
  return Array.from(maxPrice.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([templateId, price]) => `(${sqlLiteral(templateId)},${Math.max(1, Math.floor((price * buybackPercent + 99) / 100))})`)
    .join(",\n");
}

// Read-only eligibility probe. This runs without a backup, so idle scheduled
// ticks are cheap; the write sweep only runs when this finds at least one
// player listing at or below the threshold.
export function buildBuybackEligibilitySql(plan, schedule) {
  const exchangeId = requireScheduleExchangeId(schedule);
  const valuesSql = buybackPlanValuesSql(plan, schedule);
  return `WITH market_buy_plan(template_id, max_unit_price) AS (
    VALUES
${valuesSql}
),
bot AS (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1
)
SELECT COUNT(*)::text AS eligible_orders
FROM dune.dune_exchange_orders o
JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id
JOIN market_buy_plan p ON p.template_id = o.template_id
LEFT JOIN bot b ON TRUE
WHERE o.exchange_id = ${exchangeId}
  AND o.is_npc_order = FALSE
  AND (b.owner_id IS NULL OR o.owner_id <> b.owner_id)
  AND o.item_price <= FLOOR(p.max_unit_price * ${GRADE_MULTIPLIER_SQL});`;
}

export function buildBuybackSql(plan, schedule) {
  const exchangeId = requireScheduleExchangeId(schedule);
  const threshold = schedule.buybackPercent;
  const maxBuys = schedule.maxBuys;
  const valuesSql = buybackPlanValuesSql(plan, schedule);
  return `CREATE TEMP TABLE market_buy_plan (template_id TEXT PRIMARY KEY, max_unit_price BIGINT NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_result (purchased INTEGER NOT NULL, total_units BIGINT NOT NULL, total_solari BIGINT NOT NULL, threshold_percent INTEGER NOT NULL, max_buys INTEGER NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE market_buy_diagnostics (player_sell_orders BIGINT NOT NULL, known_player_sell_orders BIGINT NOT NULL, eligible_player_sell_orders BIGINT NOT NULL, above_threshold_sell_orders BIGINT NOT NULL, unknown_template_sell_orders BIGINT NOT NULL) ON COMMIT DROP;
INSERT INTO market_buy_plan (template_id, max_unit_price) VALUES
${valuesSql};
DO $$
DECLARE
    v_owner_id BIGINT; v_partition_id BIGINT; v_log_order_id BIGINT; v_balance BIGINT; v_purchased INTEGER := 0; v_units BIGINT := 0; v_solari BIGINT := 0; rec RECORD;
BEGIN
    SELECT id INTO v_owner_id FROM dune.actors WHERE class = 'Revy' LIMIT 1;
    IF v_owner_id IS NULL THEN
        SELECT partition_id INTO v_partition_id FROM dune.world_partition ORDER BY partition_id LIMIT 1;
        INSERT INTO dune.actors (class, serial, gas_attributes, properties, dimension_index, partition_id) VALUES ('Revy', 0, '{}', '{}', 0, v_partition_id) RETURNING id INTO v_owner_id;
    END IF;
    -- No dune_exchange_get_user_id call here: its INSERT .. ON CONFLICT would
    -- wait on another sweep's uncommitted balance update, serializing sweeps
    -- that SKIP LOCKED lets run side by side. The top-up below creates the
    -- users row itself when it is missing (balance coalesces to 0 < floor).
    SELECT COALESCE(dune.dune_exchange_retrieve_solari_balance(v_owner_id), 0) INTO v_balance;
    IF v_balance < 1000000000000 THEN
        PERFORM dune.dune_exchange_modify_user_solari_balance(v_owner_id, 9000000000000 - v_balance);
    END IF;
    INSERT INTO market_buy_diagnostics SELECT COUNT(*), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND o.item_price <= FLOOR(p.max_unit_price * ${GRADE_MULTIPLIER_SQL})), COUNT(*) FILTER (WHERE p.template_id IS NOT NULL AND o.item_price > FLOOR(p.max_unit_price * ${GRADE_MULTIPLIER_SQL})), COUNT(*) FILTER (WHERE p.template_id IS NULL) FROM dune.dune_exchange_orders o JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id LEFT JOIN market_buy_plan p ON p.template_id = o.template_id WHERE o.exchange_id = ${exchangeId} AND o.is_npc_order = FALSE AND o.owner_id <> v_owner_id;
    -- FOR UPDATE OF o, s SKIP LOCKED is the database-level concurrency guard:
    -- a scheduled sweep racing a manual browser sweep locks the selected order
    -- rows, so concurrent sweeps skip anything already claimed and rows
    -- deleted by a committed sweep drop out of the re-checked result.
    FOR rec IN SELECT o.id AS order_id, o.exchange_id, o.access_point_id, o.owner_id AS seller_actor_id, o.template_id, o.item_price, o.item_id, COALESCE(i.stack_size, s.initial_stack_size, 1) AS actual_stack, p.max_unit_price FROM dune.dune_exchange_orders o JOIN dune.dune_exchange_sell_orders s ON s.order_id = o.id JOIN market_buy_plan p ON p.template_id = o.template_id LEFT JOIN dune.items i ON i.id = o.item_id WHERE o.exchange_id = ${exchangeId} AND o.is_npc_order = FALSE AND o.owner_id <> v_owner_id AND o.item_price <= FLOOR(p.max_unit_price * ${GRADE_MULTIPLIER_SQL}) ORDER BY o.item_price ASC, o.id ASC LIMIT ${maxBuys} FOR UPDATE OF o, s SKIP LOCKED LOOP
        -- Seller "Take Solari" payment entry. item_price stays the per-unit
        -- price (the game multiplies by stack_size itself) and expiration is
        -- the never-expires sentinel so the game server's expire proc cannot
        -- purge an uncollected payment (EDA "items eaten without payment" fix).
        INSERT INTO dune.dune_exchange_orders (exchange_id, access_point_id, owner_id, template_id, expiration_time, durability_cur, durability_max, item_price, category_mask, category_depth, is_npc_order) VALUES (rec.exchange_id, rec.access_point_id, rec.seller_actor_id, rec.template_id, ${PAYMENT_SENTINEL_EXPIRY}, 1.0, 1.0, rec.item_price, 0, 0, FALSE) RETURNING id INTO v_log_order_id;
        INSERT INTO dune.dune_exchange_fulfilled_orders (order_id, source_order_id, completion_type, stack_size, original_order_id) VALUES (v_log_order_id, NULL, 4, rec.actual_stack, rec.order_id);
        UPDATE dune.dune_exchange_users SET solari_balance = solari_balance - (rec.item_price * rec.actual_stack) WHERE owner_id = v_owner_id;
        DELETE FROM dune.dune_exchange_sell_orders WHERE order_id = rec.order_id;
        DELETE FROM dune.dune_exchange_orders WHERE id = rec.order_id;
        IF rec.item_id IS NOT NULL THEN DELETE FROM dune.items WHERE id = rec.item_id; END IF;
        v_purchased := v_purchased + 1; v_units := v_units + rec.actual_stack; v_solari := v_solari + (rec.item_price * rec.actual_stack);
    END LOOP;
    INSERT INTO market_buy_result (purchased, total_units, total_solari, threshold_percent, max_buys) VALUES (v_purchased, v_units, v_solari, ${threshold}, ${maxBuys});
END $$;
SELECT r.purchased, r.total_units, r.total_solari, r.threshold_percent, r.max_buys, d.player_sell_orders, d.known_player_sell_orders, d.eligible_player_sell_orders, d.above_threshold_sell_orders, d.unknown_template_sell_orders FROM market_buy_result r CROSS JOIN market_buy_diagnostics d;`;
}

export async function probeBuybackEligibility(config, db, overrides = {}) {
  const saved = readBuybackSchedule(config);
  const schedule = normalizeBuybackSchedule({
    exchangeId: overrides.exchangeId,
    priceMultiplier: overrides.priceMultiplier,
    buybackPercent: overrides.buybackPercent,
    maxBuys: overrides.maxBuys
  }, saved);
  if (!schedule.exchangeId) throw new Error("An exchangeId is required to probe buyback eligibility.");
  const plan = loadBuybackSeedPlan(config);
  const result = await runSql(db, buildBuybackEligibilitySql(plan, schedule), false);
  return {
    eligible: eligibleCount(result),
    exchangeId: schedule.exchangeId,
    priceMultiplier: schedule.priceMultiplier,
    buybackPercent: schedule.buybackPercent,
    maxBuys: schedule.maxBuys
  };
}

export function createAddonJobScheduler(config, options = {}) {
  const {
    getDb = () => null,
    runDuneImpl = runDune,
    now = () => Date.now(),
    assertPermission = assertInstalledAddonPermission,
    auditImpl = audit,
    mutationLimiter = null,
    failureBackoffMs = 60000,
    log = console
  } = options;

  // Module-level style guards, scoped to the single scheduler instance the
  // server creates (same role as carePackageAutoRunning in server.js).
  let running = false;
  let nextAllowedAttemptAt = 0;
  let armedForThisProcess = false;

  function persistRunCompletion(completedAtMs, status, detail) {
    // Re-read before writing so a schedule.set that landed while the run was
    // in flight (new interval, disabled, new exchange) is not clobbered.
    // Synchronous read-modify-write: see the note on saveBuybackSchedule.
    const current = readBuybackSchedule(config);
    writeBuybackSchedule(config, {
      ...current,
      lastRunAt: new Date(completedAtMs).toISOString(),
      lastRunStatus: status,
      lastRunDetail: String(detail || "").slice(0, MAX_RUN_DETAIL_LENGTH),
      // Re-arm from completion time, not run start, so a sweep that outlasts
      // the interval cannot trigger back-to-back runs.
      nextRunAt: current.enabled ? new Date(completedAtMs + current.intervalMinutes * 60000).toISOString() : ""
    });
  }

  function auditRun(trigger, detail) {
    try {
      auditImpl(config, null, "addons.scheduled-job", { id: EDA_EXCHANGE_BOT_ADDON_ID, job: "buyback", trigger, ...detail });
    } catch (error) {
      log.error(`Addon scheduled job audit failed: ${redact(error?.message || error)}`);
    }
  }

  async function tick() {
    if (running) return;
    const startedAt = now();
    if (startedAt < nextAllowedAttemptAt) return;
    const schedule = readBuybackSchedule(config);
    if (!schedule.enabled) {
      armedForThisProcess = false;
      return;
    }
    const dueAtMs = Date.parse(schedule.nextRunAt || "") || 0;
    if (!armedForThisProcess) {
      armedForThisProcess = true;
      if (!dueAtMs || dueAtMs <= startedAt) {
        // Restart recovery: the console was down (or never armed) when the
        // run came due. Recompute nextRunAt one interval out instead of
        // firing a write immediately at boot.
        writeBuybackSchedule(config, { ...schedule, nextRunAt: new Date(startedAt + schedule.intervalMinutes * 60000).toISOString() });
        return;
      }
    }
    if (!dueAtMs) {
      writeBuybackSchedule(config, { ...schedule, nextRunAt: new Date(startedAt + schedule.intervalMinutes * 60000).toISOString() });
      return;
    }
    if (startedAt < dueAtMs) return;

    if (mutationLimiter) {
      // Scheduled runs have no session or client IP, so they consume a
      // dedicated mutation rate-limit scope instead of a session:ip key.
      const limit = mutationLimiter.check(ADDON_SCHEDULED_RUN_RATE_SCOPE);
      if (!limit.allowed) {
        nextAllowedAttemptAt = startedAt + failureBackoffMs;
        return;
      }
      mutationLimiter.record(ADDON_SCHEDULED_RUN_RATE_SCOPE);
    }

    running = true;
    try {
      // Verified on every run so uninstalling, disabling, blocking, or
      // revoking a permission stops scheduled writes immediately.
      assertPermission(config, EDA_EXCHANGE_BOT_ADDON_ID, "database:read");
      assertPermission(config, EDA_EXCHANGE_BOT_ADDON_ID, "database:write");
      assertPermission(config, EDA_EXCHANGE_BOT_ADDON_ID, ADDON_SCHEDULER_PERMISSION);
      const outcome = await executeBuybackRun(config, getDb(), schedule, { runDuneImpl });
      const completedAt = now();
      persistRunCompletion(completedAt, outcome.status, outcome.detail);
      nextAllowedAttemptAt = 0;
      auditRun("schedule", { status: outcome.status, eligible: outcome.eligible, purchased: outcome.purchased, totalUnits: outcome.totalUnits, totalSolari: outcome.totalSolari, exchangeId: schedule.exchangeId, ok: true });
    } catch (error) {
      const completedAt = now();
      const message = redact(String(error?.message || error));
      nextAllowedAttemptAt = completedAt + failureBackoffMs;
      try {
        persistRunCompletion(completedAt, "error", message);
      } catch {
        // Status persistence is best effort on failure paths.
      }
      auditRun("schedule", { status: "error", exchangeId: schedule.exchangeId, ok: false, error: message });
      log.error(`Addon scheduled buyback run failed: ${message}`);
    } finally {
      running = false;
    }
  }

  async function runNow({ trigger = "manual" } = {}) {
    if (running) throw new Error("An exchange buyback run is already in progress.");
    const schedule = readBuybackSchedule(config);
    if (!schedule.exchangeId) throw new Error("Save a schedule with an exchangeId before running a manual buyback sweep.");
    running = true;
    try {
      const outcome = await executeBuybackRun(config, getDb(), schedule, { runDuneImpl });
      persistRunCompletion(now(), outcome.status, outcome.detail);
      auditRun(trigger, { status: outcome.status, eligible: outcome.eligible, purchased: outcome.purchased, totalUnits: outcome.totalUnits, totalSolari: outcome.totalSolari, exchangeId: schedule.exchangeId, ok: true });
      return { ...outcome, schedule: readBuybackSchedule(config) };
    } catch (error) {
      const message = redact(String(error?.message || error));
      try {
        persistRunCompletion(now(), "error", message);
      } catch {
        // Status persistence is best effort on failure paths.
      }
      auditRun(trigger, { status: "error", exchangeId: schedule.exchangeId, ok: false, error: message });
      throw error;
    } finally {
      running = false;
    }
  }

  return { tick, runNow, isRunning: () => running };
}

async function executeBuybackRun(config, db, schedule, { runDuneImpl }) {
  const plan = loadBuybackSeedPlan(config);
  const probe = await runSql(db, buildBuybackEligibilitySql(plan, schedule), false);
  const eligible = eligibleCount(probe);
  if (eligible <= 0) {
    return {
      status: "idle",
      eligible: 0,
      purchased: 0,
      totalUnits: "0",
      totalSolari: "0",
      detail: `No eligible player listings at ${schedule.buybackPercent}% threshold on exchange ${schedule.exchangeId}; sweep and backup skipped.`
    };
  }
  if (typeof db?.transaction !== "function") {
    throw new Error("Exchange buyback requires database transaction support.");
  }
  if (!config.mockMode) {
    await runDuneImpl(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: `addon-${EDA_EXCHANGE_BOT_ADDON_ID}` } });
  }
  // Keep the entire sweep on one checked-out client. createDb.transaction()
  // guarantees ROLLBACK before releasing that client if any statement fails,
  // preventing an aborted transaction from being returned to the pool.
  const sweep = await db.transaction((tx) => runSql(tx, buildBuybackSql(plan, schedule), true));
  const row = sweep?.rows?.[0] || {};
  // purchased is a plain INTEGER bounded by maxBuys; the unit/solari totals
  // are BIGINT sums, so they stay decimal strings end-to-end like exchange
  // ids do (never converted with Number()).
  const purchased = Number(row.purchased || 0);
  const totalUnits = decimalString(row.total_units);
  const totalSolari = decimalString(row.total_solari);
  return {
    status: "swept",
    eligible,
    purchased,
    totalUnits,
    totalSolari,
    detail: `Bought ${purchased} listings (${totalUnits} units) for ${totalSolari} solari on exchange ${schedule.exchangeId} (${eligible} eligible).`
  };
}

function decimalString(value) {
  const text = String(value ?? "0").trim();
  return /^-?[0-9]+$/.test(text) ? text : "0";
}

function eligibleCount(result) {
  const eligible = Number(result?.rows?.[0]?.eligible_orders || 0);
  return Number.isFinite(eligible) && eligible > 0 ? eligible : 0;
}

function requireScheduleExchangeId(schedule) {
  const exchangeId = normalizeExchangeId(schedule?.exchangeId);
  if (!exchangeId) throw new Error("Buyback schedule exchangeId is invalid.");
  return exchangeId;
}

function buybackSchedulePath(config) {
  return resolve(config.repoRoot, "runtime/addons/jobs", EDA_EXCHANGE_BOT_ADDON_ID, "buyback.json");
}

function writeBuybackSchedule(config, schedule) {
  const path = buybackSchedulePath(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(schedule, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function sqlLiteral(value) {
  return "'" + String(value ?? "").replaceAll("'", "''") + "'";
}

function roundPrice(value) {
  const number = Math.max(1, Number(value) || 1);
  let step = 1;
  if (number >= 1000000) step = 10000;
  else if (number >= 100000) step = 1000;
  else if (number >= 10000) step = 100;
  else if (number >= 1000) step = 10;
  return Math.max(1, Math.round(number / step) * step);
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function integerField(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Buyback schedule ${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function clampedIntegerField(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`Buyback schedule ${name} must be an integer.`);
  return Math.min(max, Math.max(min, number));
}

function isoField(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : "";
}
