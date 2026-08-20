import { tableExists } from "../duneDb.js";
import {
  readBuybackSchedule,
  saveBuybackSchedule,
  readSeedSchedule,
  saveSeedSchedule,
  COMMODITY_STACK_CATALOG,
  COMMODITY_STACK_GROUPS
} from "../addonJobs.js";
import {
  decodeSeedPlanCsvUpload,
  exportMarketSeedPlanCsv,
  importMarketSeedPlanFromCsv,
  listMarketSeedPlans,
  marketSeedPlanSummary,
  renameMarketSeedPlan,
  setActiveMarketSeedPlan
} from "./marketSeedPlans.js";

export {
  decodeSeedPlanCsvUpload,
  exportMarketSeedPlanCsv,
  importMarketSeedPlanFromCsv,
  listMarketSeedPlans,
  marketSeedPlanSummary,
  renameMarketSeedPlan,
  setActiveMarketSeedPlan
};

// First-class Market Bot for the CHOAM exchange: the same seed/buyback engine
// originally introduced for the EDA Exchange Bot addon (addonJobs.js /
// addonSeedJob.js), now surfaced and managed entirely by the Exchange panel.
// Schedules are source:"console" and the active seed plan (bundled by default,
// or an operator-named CSV-backed list) is what seed/buyback runs use.
const REQUIRED_TABLES = ["dune_exchange_orders", "dune_exchange_sell_orders", "dune_exchange_accesspoints", "items", "actors"];

async function marketSupported(db) {
  for (const table of REQUIRED_TABLES) {
    if (!(await tableExists(db, table))) return false;
  }
  return true;
}

export async function marketBotStatus(config, db) {
  const supported = await marketSupported(db);
  return {
    capabilities: { exchangeMarket: supported },
    plan: marketSeedPlanSummary(config),
    plans: listMarketSeedPlans(config),
    buyback: readBuybackSchedule(config),
    seed: readSeedSchedule(config),
    commodityStackCatalog: COMMODITY_STACK_CATALOG,
    commodityStackGroups: COMMODITY_STACK_GROUPS,
    ...(supported ? {} : { reason: `Unsupported by detected schema. Missing required table(s): ${REQUIRED_TABLES.map((t) => `dune.${t}`).join(", ")}` })
  };
}

// Exchange discovery for the exchange selector, ported from the EDA addon:
// exchanges with real access points come first (those are the ones players
// actually reach in-game), the Global exchange is flagged, and ids stay text
// end-to-end because they are BIGINTs beyond Number.MAX_SAFE_INTEGER.
const EXCHANGE_DISCOVERY_SQL = (globalCte) => `
WITH ${globalCte}
known_exchanges AS (
    SELECT exchange_id FROM dune.dune_exchange_orders
    UNION
    SELECT exchange_id FROM dune.dune_exchange_accesspoints
    UNION
    SELECT exchange_id FROM global_exchange WHERE exchange_id IS NOT NULL
)
SELECT
    k.exchange_id::text AS exchange_id,
    (k.exchange_id = (SELECT exchange_id FROM global_exchange)) AS is_global,
    (SELECT COUNT(*) FROM dune.dune_exchange_accesspoints a WHERE a.exchange_id = k.exchange_id)::text AS access_point_count,
    COUNT(o.id)::text AS order_count,
    COUNT(o.id) FILTER (WHERE o.owner_id = bot.owner_id OR o.is_npc_order = TRUE)::text AS bot_order_count,
    COUNT(o.id) FILTER (WHERE COALESCE(o.is_npc_order, FALSE) = FALSE AND (bot.owner_id IS NULL OR o.owner_id <> bot.owner_id))::text AS player_order_count
FROM known_exchanges k
LEFT JOIN dune.dune_exchange_orders o ON o.exchange_id = k.exchange_id
LEFT JOIN LATERAL (
    SELECT id AS owner_id FROM dune.actors WHERE class = 'Revy' ORDER BY id LIMIT 1
) bot ON TRUE
GROUP BY k.exchange_id
ORDER BY is_global ASC NULLS LAST, k.exchange_id ASC`;

export async function listMarketExchanges(db) {
  if (!(await marketSupported(db))) {
    return { capabilities: { exchangeMarket: false }, rows: [] };
  }
  let result;
  try {
    result = await db.query(EXCHANGE_DISCOVERY_SQL("global_exchange AS (SELECT dune.get_dune_exchange_id('Global')::bigint AS exchange_id),"));
  } catch {
    // Some schema versions ship without the get_dune_exchange_id() helper;
    // fall back to discovery without the Global marker.
    result = await db.query(EXCHANGE_DISCOVERY_SQL("global_exchange AS (SELECT NULL::bigint AS exchange_id),"));
  }
  const rows = (result.rows || []).map((row) => ({
    exchangeId: String(row.exchange_id || ""),
    isGlobal: row.is_global === true,
    accessPoints: Number(row.access_point_count || 0),
    orderCount: Number(row.order_count || 0),
    botOrders: Number(row.bot_order_count || 0),
    playerOrders: Number(row.player_order_count || 0)
  })).filter((row) => /^[1-9][0-9]*$/.test(row.exchangeId));
  rows.sort((a, b) => {
    const aAp = a.accessPoints > 0 ? 0 : 1;
    const bAp = b.accessPoints > 0 ? 0 : 1;
    if (aAp !== bAp) return aAp - bAp;
    if (a.isGlobal !== b.isGlobal) return a.isGlobal ? 1 : -1;
    return a.exchangeId.length - b.exchangeId.length || a.exchangeId.localeCompare(b.exchangeId);
  });
  return { capabilities: { exchangeMarket: true }, rows };
}

// source:"console" is forced here (never taken from the payload); `now` is a
// test seam that falls through to the schedule store's own default clock.
export function saveMarketBuybackSchedule(config, payload = {}, { now } = {}) {
  return saveBuybackSchedule(config, payload, { source: "console", now });
}

export function saveMarketSeedSchedule(config, payload = {}, { now } = {}) {
  return saveSeedSchedule(config, payload, { source: "console", now });
}
