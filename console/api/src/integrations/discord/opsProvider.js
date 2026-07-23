// OPS Bridge Providers — maps Discord adapter routes to OPS observability data.
// Each provider returns the data shape expected by the bot's /dune ops-* commands.
//
// Integration: When the OPS observability addon provides a server-side bridge,
// replace each function body with the corresponding bridge action call.
// The addon's bridge actions are defined in yacketrj/dune-ops-observability-addon.
//
// Four of the nine providers below (activity, combat, resources, economy)
// are wired to real, already-working duneDb.js query functions — the same
// ones the addon-bridge handler in server.js already calls successfully
// for installed third-party addons (see addonOpsActivitySummary() et al.,
// called from server.js's "ops.activity.summary" etc. bridge actions).
// This is the Discord adapter calling the identical underlying queries
// through a different, already-existing auth path (requireDiscordBotToken
// in routes.js, not assertInstalledAddonPermission) — not a new capability,
// permission system, or write path. The remaining five (inventory,
// location, soc, prometheus, and dashboard's references to those four)
// have no backing query anywhere in this codebase and remain placeholders.

import {
  addonOpsActivitySummary,
  addonOpsCombatDeaths,
  addonOpsResourcesSummary,
  addonOpsEconomySummary
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
// TODO: Wire the remaining five (inventory, location, soc, prometheus) to
// server-side bridge actions when available from the addon.

export async function opsActivityProvider(config, db) {
  const result = await addonOpsActivitySummary(db);
  return { ok: true, result };
}

export async function opsCombatProvider(config, db) {
  const result = await addonOpsCombatDeaths(db);
  return { ok: true, result };
}

export async function opsResourcesProvider(config, db) {
  const result = await addonOpsResourcesSummary(db);
  return { ok: true, result };
}

export async function opsEconomyProvider(config, db) {
  const result = await addonOpsEconomySummary(db);
  return { ok: true, result };
}

// Signature kept as (config, db) for consistency with the four real
// providers above, even though these five placeholders don't use db yet —
// no backing query exists anywhere in this codebase for these domains.
// Do not implement these from Core; they require the OPS observability
// addon's own bridge (yacketrj/dune-ops-observability-addon).
export async function opsInventoryProvider(config, db) {
  // TODO: return await opsBridgeRequest(config, "ops.inventory.summary");
  return opsPlaceholder("inventory");
}

export async function opsLocationProvider(config, db) {
  // TODO: return await opsBridgeRequest(config, "ops.location.activity");
  return opsPlaceholder("location");
}

export async function opsSocProvider(config, db) {
  // TODO: return await opsBridgeRequest(config, "ops.soc.summary");
  return opsPlaceholder("soc");
}

export async function opsPrometheusProvider(config, db) {
  // TODO: return await opsBridgeRequest(config, "ops.health.prometheus");
  return opsPlaceholder("prometheus");
}

export async function opsDashboardProvider(config, db) {
  // Aggregate from all other providers. Four of these (activity, combat,
  // resources, economy) now return real data; the other four
  // (inventory, location, soc, prometheus) remain "status: planned"
  // placeholders. This intentionally produces a mixed shape — that is
  // the correct, honest reflection of Core's actual current state, not
  // something to hide or special-case.
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
