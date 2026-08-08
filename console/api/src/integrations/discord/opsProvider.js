// OPS Bridge Providers — maps Discord adapter routes to OPS observability data.
// Each provider returns the data shape expected by the bot's /dune ops-* commands.
//
// Integration: When the OPS observability addon provides a server-side bridge,
// replace each function body with the corresponding bridge action call.
// The addon's bridge actions are defined in yacketrj/dune-ops-observability-addon.
//
// Seven of the nine providers below (activity, combat, resources, economy,
// inventory, soc, prometheus) are wired to real, working data sources.
// Five of those seven (activity, combat, resources, economy, inventory)
// use duneDb.js query functions the addon-bridge handler in server.js
// already calls successfully for installed third-party addons (see
// addonOpsActivitySummary() et al., called from server.js's
// "ops.activity.summary" etc. bridge actions) — this is the Discord
// adapter calling the identical underlying queries through a different,
// already-existing auth path (requireDiscordBotToken in routes.js, not
// assertInstalledAddonPermission), not a new capability, permission
// system, or write path. SOC uses a different, non-SQL data source (an
// in-memory rolling counter over this project's own addons.bridge audit
// log entries — see audit.js's getBridgeRequestSummary()), since no
// aggregate query backs it. Prometheus is a real HTTP integration against
// this project's optional, opt-in metrics stack (`dune metrics start`) —
// it honestly reports its own "not running" state
// (reason: "metrics_stack_not_running") when that stack isn't started,
// which is the common/default case, rather than either failing or
// fabricating data; see duneDb.js's addonOpsPrometheusHealth() for the
// full verified detail, including a real, live-confirmed limitation in
// this project's current cAdvisor configuration that prevents
// per-container restart counts from ever being real — that field is
// always null, deliberately, not estimated.
//
// The remaining one (location, and dashboard's reference to it) is
// intentionally, permanently out of scope for this addon (decided
// 2026-07-24) — per-player real-time location tracking already belongs
// to, and is already surfaced by, the Console's own map UI
// (duneDb.liveMapMarkers/liveMapPlayers and siblings); this addon's scope
// is aggregate operational/observability metrics (AAA-style NOC/SOC KPIs),
// not per-player tracking. This is a design decision, not a gap awaiting
// a maintainer call — do not wire opsLocationProvider to real per-player
// data.

import {
  addonOpsActivitySummary,
  addonOpsCombatDeaths,
  addonOpsResourcesSummary,
  addonOpsEconomySummary,
  addonOpsInventorySummary,
  addonOpsSocSummary,
  addonOpsPrometheusHealth
} from "../../duneDb.js";

const OPS_BRIDGE_ACTIONS = Object.freeze({
  "ops-activity":   { action: "ops.activity.summary",     desc: "Player activity statistics" },
  "ops-combat":     { action: "ops.combat.deaths",         desc: "Combat and death statistics" },
  "ops-resources":  { action: "ops.resources.summary",     desc: "Resource field statistics" },
  "ops-economy":    { action: "ops.economy.summary",       desc: "Economy statistics" },
  "ops-inventory":  { action: "ops.inventory.summary",     desc: "Inventory and crafting stats" },
  "ops-location":   { action: "ops.location.activity",     desc: "Map location activity" },
  "ops-soc":        { action: "ops.soc.summary",           desc: "OPS bridge health and stats" },
  "ops-prometheus": { action: "ops.health.prometheus",     desc: "Container and infra metrics" },
  "ops-dashboard":  { action: "ops.aggregated.dashboard",  desc: "Aggregated dashboard summary" },
});

export function opsBridgeActionFor(routeKey) {
  return OPS_BRIDGE_ACTIONS[routeKey]?.action || null;
}

export function opsBridgeDescription(routeKey) {
  return OPS_BRIDGE_ACTIONS[routeKey]?.desc || "OPS observability data";
}

// Provider functions — each maps to a Discord adapter OPS route.
// TODO: Wire the remaining three (location, soc, prometheus) to
// server-side bridge actions when available from the addon, or per an
// explicit maintainer decision for location's privacy consideration.

export async function opsActivityProvider(config, db) {
  const result = await addonOpsActivitySummary(db);
  return { ok: true, result };
}

export async function opsCombatProvider(config, db) {
  const result = await addonOpsCombatDeaths(db);
  return { ok: true, result };
}

export async function opsResourcesProvider(config, db) {
  const result = await addonOpsResourcesSummary(db, config);
  // Compute totalValueRemaining so the bot's statsPusher fetchAggregate
  // can populate spice_fields without needing to know the internal map
  // structure (issue #95).
  let totalValueRemaining = 0;
  for (const section of [result.deepDesert, result.haggaBasin]) {
    if (!section || !Array.isArray(section.instances)) continue;
    for (const inst of section.instances) {
      if (typeof inst.totalValueRemaining === "number") {
        totalValueRemaining += inst.totalValueRemaining;
      }
    }
  }
  return { ok: true, result: { ...result, totalValueRemaining } };
}

export async function opsEconomyProvider(config, db) {
  const result = await addonOpsEconomySummary(db);
  return { ok: true, result };
}

export async function opsInventoryProvider(config, db) {
  const result = await addonOpsInventorySummary(db);
  return { ok: true, result };
}

// Decided (2026-07-24), not a pending TODO: per-player real-time location
// tracking (duneDb.liveMapMarkers/liveMapPlayers and siblings) stays out
// of this addon by design — that data already belongs to, and is already
// surfaced by, the Console's own map UI (session-authed, admin-only). This
// addon's scope is aggregate operational/observability metrics (AAA-style
// NOC/SOC KPIs — population, combat, economy, inventory, platform health),
// not per-player tracking. Signature kept as (config, db) for consistency
// with the real providers above, even though this placeholder doesn't use
// db — there is no plan to wire this from Core.
export async function opsLocationProvider(config, db) {
  // TODO: return await opsBridgeRequest(config, "ops.location.activity");
  return opsPlaceholder("location");
}

export async function opsSocProvider(config, db) {
  const result = addonOpsSocSummary();
  return { ok: true, result };
}

// Unlike every other real provider, addonOpsPrometheusHealth()'s return
// value is already either a real data object OR a
// {status: "planned", reason: "metrics_stack_not_running", ...} shape —
// it decides for itself whether the (optional, opt-in) metrics stack is
// reachable. Wrap it in { ok: true, result } exactly like every other
// provider regardless of which shape it returned; do not special-case
// the "not running" branch here — the consumer (Discord bot or addon)
// is responsible for reading `result.status` to tell real data from
// "not currently available", same as opsPlaceholder()'s shape already
// requires for opsLocationProvider (which, unlike this one, has no real
// data source planned at all — see that provider's own comment).
export async function opsPrometheusProvider(config, db) {
  const result = await addonOpsPrometheusHealth();
  return { ok: true, result };
}

export async function opsDashboardProvider(config, db) {
  // Aggregate from all other providers. Seven of these (activity, combat,
  // resources, economy, inventory, soc, prometheus) now return real data
  // (prometheus conditionally — see addonOpsPrometheusHealth's own
  // comment for why it may itself report "not running"); the remaining
  // one (location) is a permanent "status: planned" placeholder by
  // design — per-player location tracking is intentionally out of scope
  // for this addon (see opsLocationProvider's own comment), not a gap
  // waiting to be filled. This intentionally produces a mixed shape —
  // that is the correct, honest reflection of Core's actual current
  // state, not something to hide or special-case.
  const results = await Promise.allSettled([
    opsActivityProvider(config, db), opsCombatProvider(config, db),
    opsResourcesProvider(config, db), opsEconomyProvider(config, db),
    opsInventoryProvider(config, db), opsLocationProvider(config, db),
    opsSocProvider(config, db), opsPrometheusProvider(config, db),
  ]);
  const data = {};
  results.forEach((r, i) => {
    const keys = ["activity","combat","resources","economy","inventory","location","soc","prometheus"];
    data[keys[i]] = r.status === "fulfilled" ? r.value : { error: r.reason?.message || "failed" };
  });
  return { ok: true, dashboard: data };
}

function opsPlaceholder(domain) {
  return {
    ok: true,
    status: "planned",
    domain,
    message: `OPS ${domain} bridge integration pending. See yacketrj/dune-ops-observability-addon.`,
    summary: {}
  };
}

// Template for server-side bridge implementation:
// async function opsBridgeRequest(config, action, payload = {}) {
//   // TODO: Call the console's internal ops bridge handler.
//   // Example: const result = await internalOpsBridge.getAction(action, payload);
//   //   return { ok: true, result };
// }
