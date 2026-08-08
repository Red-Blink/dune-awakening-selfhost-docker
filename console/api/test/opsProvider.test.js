import test from "node:test";
import assert from "node:assert/strict";
import {
  opsActivityProvider,
  opsCombatProvider,
  opsResourcesProvider,
  opsEconomyProvider,
  opsInventoryProvider,
  opsLocationProvider,
  opsSocProvider,
  opsPrometheusProvider,
  opsDashboardProvider
} from "../src/integrations/discord/opsProvider.js";

// Wiring the real OPS routes (activity/combat/resources/economy/
// inventory) to their already-working duneDb.js query functions — see
// server.js's "ops.activity.summary" etc. bridge actions for the
// pre-existing pattern this mirrors. These tests exercise the real
// duneDb.js functions through a mock db (following the `to_regclass`
// mock convention used across this test suite, e.g. db.test.js), proving
// each provider returns { ok: true, result } with real, correctly-shaped
// data when the underlying tables have rows, and each function's own
// genuine empty/zero shape (not a placeholder) when the tables don't
// exist — never a fabricated or estimated value. opsSocProvider is
// wired too, but reads from an in-memory audit-log counter rather than
// a SQL query — see its own tests below for why it doesn't fit the
// mock-db pattern the same way.

function mockDb(overrides = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const table = String(values[0] || "");
        const exists = overrides.tables ? overrides.tables.has(table.split(".").pop()) : true;
        return { rows: [{ exists }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        const columns = overrides.columns?.[table] || [];
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      const handler = overrides.query;
      if (handler) {
        const result = handler(text, values);
        if (result) return result;
      }
      return { rows: [] };
    }
  };
}

test("opsActivityProvider returns real activity data wrapped in { ok, result }", async () => {
  const db = mockDb({
    columns: { player_state: ["last_avatar_activity", "last_returning_player_event_time", "transfer_count"] },
    query: (text) => {
      if (text.includes("from dune.player_state") && text.includes("count(*)::int as total_players")) {
        return { rows: [{ total_players: 42, online_players: 10, players_dead: 3, active_last_1h: 5, active_last_24h: 12, active_last_7d: 30, inactive_players: 2, returning_players: 1, new_players: 4 }] };
      }
      return null;
    }
  });

  const response = await opsActivityProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal(response.result.totalPlayers, 42);
  assert.equal(response.result.onlinePlayers, 10);
  assert.equal(response.result.playersDead, 3);
  assert.ok(Array.isArray(response.result.guildActivity));
});

test("opsActivityProvider returns the real empty shape (not a placeholder) when player_state doesn't exist", async () => {
  const db = mockDb({ tables: new Set() });
  const response = await opsActivityProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal(response.result.totalPlayers, 0);
  assert.equal(response.result.onlinePlayers, 0);
  assert.equal("status" in response.result, false, "must not resemble the old placeholder shape");
  assert.deepEqual(response.result.guildActivity, []);
});

test("opsCombatProvider returns real combat-death data wrapped in { ok, result }", async () => {
  const db = mockDb({
    query: (text) => {
      if (text.includes("from dune.player_death_log")) {
        return { rows: [{ total_deaths: 7, unknown_deaths: 1, coriolis_deaths: 2, sandworm_deaths: 4 }] };
      }
      return null;
    }
  });

  const response = await opsCombatProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal(response.result.totalDeaths, 7);
  assert.equal(response.result.pveDeaths, 7);
  assert.equal(response.result.pvpDeaths, 0);
  assert.ok(response.result.deathsByCause.some((d) => d.cause === "Sandworm" && d.count === 4));
});

test("opsCombatProvider returns the real empty shape when player_death_log doesn't exist", async () => {
  const db = mockDb({ tables: new Set() });
  const response = await opsCombatProvider({}, db);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { totalDeaths: 0, pvpDeaths: 0, pveDeaths: 0, deathsByCause: [], deathsByMap: [], topHostileNpcs: [], kdRatio: null });
});

// addonOpsResourcesSummary()'s own full behavior (Deep Desert/Hagga Basin
// separation, per-instance PvP/PvE resolution, size-tier rows, sorting,
// empty states) is covered exhaustively in its own dedicated test file
// (test/addonOpsResourcesSummary.test.js), which uses a real
// mapCombatState.js resolver sandbox rather than a mock -- that level of
// detail doesn't belong duplicated here. These two tests only verify
// opsResourcesProvider's own job: wrap the result in { ok, result} and
// pass `config` through (needed for the real PvP/PvE resolver's
// subprocess calls) -- a wiring concern, not a data-correctness one.
test("opsResourcesProvider wraps addonOpsResourcesSummary's result in { ok, result } and forwards config", async () => {
  const db = mockDb({ tables: new Set() }); // no world_partition/resourcefield_state -> both sections empty
  const response = await opsResourcesProvider({ repoRoot: "/tmp", duneScript: "/tmp/dune" }, db);
  assert.equal(response.ok, true);
  assert.ok("deepDesert" in response.result);
  assert.ok("haggaBasin" in response.result);
});

test("opsResourcesProvider returns the real empty shape (both sections, not a placeholder) when resourcefield_state doesn't exist", async () => {
  const db = mockDb({ tables: new Set() });
  const response = await opsResourcesProvider({}, db);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    deepDesert: { summary: { totalActiveFields: 0, totalRemainingSpice: 0, pvpInstances: 0, pveInstances: 0, bySize: [] }, instances: [] },
    haggaBasin: { summary: { totalActiveFields: 0, totalRemainingSpice: 0, pvpInstances: 0, pveInstances: 0, bySize: [] }, instances: [] }
  });
});

test("opsEconomyProvider returns real economy data wrapped in { ok, result }", async () => {
  const db = mockDb({
    tables: new Set(["player_virtual_currency_balances"]),
    query: (text) => {
      if (text.includes("from dune.player_virtual_currency_balances") && text.includes("count(distinct player_controller_id)")) {
        return { rows: [{ holders: 20, total_supply: 500000 }] };
      }
      if (text.includes("group by currency_id")) {
        return { rows: [{ currency_id: "1", holders: 20, supply: 500000, avg_balance: 25000, min_balance: 0, max_balance: 100000 }] };
      }
      return null;
    }
  });

  const response = await opsEconomyProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal(response.result.totalCurrencyHolders, 20);
  assert.equal(response.result.totalSupply, 500000);
  assert.ok(Array.isArray(response.result.currencyBreakdown));
});

test("opsEconomyProvider returns the real empty shape when no economy tables exist", async () => {
  const db = mockDb({ tables: new Set() });
  const response = await opsEconomyProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal(response.result.totalCurrencyHolders, 0);
  assert.equal(response.result.totalSupply, 0);
  assert.equal(response.result.activeOrders, 0);
  assert.equal(response.result.fulfilledOrders, 0);
  assert.equal(response.result.taxCollected, 0);
});

test("opsInventoryProvider returns real inventory/storage data wrapped in { ok, result }", async () => {
  const db = mockDb({
    tables: new Set(["items", "inventories", "placeables"]),
    query: (text) => {
      if (text.includes("from dune.items i") && text.includes("count(*)::int as total_items")) {
        return { rows: [{ total_items: 5 }] };
      }
      if (text.includes("from dune.items i") && text.includes("group by i.template_id")) {
        return { rows: [{ template_id: "Stone", count: 5, total_stack: 2477 }] };
      }
      if (text.includes("from dune.placeables p") && text.includes("building_type in")) {
        return { rows: [{ id: 13, name: "", class: "SpiceSilo_Placeable", map: "HaggaBasin", item_count: 5, owner_name: "Sihaya" }] };
      }
      return null;
    }
  });

  const response = await opsInventoryProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal(response.result.totalItems, 5);
  assert.equal(response.result.totalInventories, 1);
  assert.ok(Array.isArray(response.result.itemsByTemplate));
  assert.equal(response.result.itemsByTemplate[0].template_id, "Stone");
  assert.equal(response.result.itemsByTemplate[0].count, 5);
  // totalCrafted has no real source anywhere in this schema (verified by
  // direct search — only per-player recipe-unlock tracking exists, a
  // different concept). It must always be null, never a guessed number.
  assert.equal(response.result.totalCrafted, null);
  assert.ok(Array.isArray(response.result.storageUsage));
  assert.equal(response.result.storageUsage[0].inventoryId, 13);
  assert.equal(response.result.storageUsage[0].itemCount, 5);
});

test("opsInventoryProvider returns the real empty shape (not a placeholder) when items/inventories/placeables don't exist", async () => {
  const db = mockDb({ tables: new Set() });
  const response = await opsInventoryProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal("status" in response.result, false, "must not resemble the old placeholder shape");
  assert.deepEqual(response.result, { totalItems: 0, totalInventories: 0, itemsByTemplate: [], totalCrafted: null, storageUsage: [] });
});

// opsSocProvider is unusual among the OPS providers: it takes no db
// parameter at all and reads from an in-memory rolling counter
// (audit.js's getBridgeRequestSummary()) over this project's own
// addons.bridge audit-log entries, rather than a SQL query. Verified
// directly against this project's own live, running audit log
// (runtime/generated/web-admin-audit.jsonl) that the real detail.ok field
// shape this depends on matches production, not just a mocked assumption.
test("opsSocProvider returns a real, non-placeholder shape reflecting the in-memory bridge-request counter", async () => {
  const db = mockDb();
  const response = await opsSocProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal("status" in response.result, false, "must not resemble the old placeholder shape");
  assert.equal(typeof response.result.bridgeRequests, "number");
  assert.equal(typeof response.result.bridgeErrors, "number");
  assert.ok(["Unknown", "Healthy", "Degraded"].includes(response.result.platformHealth));
});

// Location is intentionally, permanently out of scope for this addon
// (per-player real-time location tracking already belongs to the
// Console's own map UI, not an OPS-metrics addon — decided 2026-07-24)
// and must remain a permanent "status: planned" placeholder — do not
// wire real data for it.
test("the one untouched OPS provider still returns a status: planned placeholder", async () => {
  const db = mockDb();
  const response = await opsLocationProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal(response.status, "planned");
  assert.equal(response.domain, "location");
  assert.deepEqual(response.summary, {});
});

// opsPrometheusProvider is real (an HTTP integration against an optional,
// opt-in metrics stack), but this test environment does not have that
// stack running, so it correctly exercises the "not running" precondition
// path — a real, specific reason, distinct from a generically
// unimplemented route. Directly verified against a live, running instance
// of this exact metrics stack (both the "not running" and the real-data
// paths) before this test was written — see duneDb.js's
// addonOpsPrometheusHealth() for that verification.
test("opsPrometheusProvider reports the real 'metrics stack not running' state, not a placeholder, when the optional stack isn't running", async () => {
  const db = mockDb();
  const response = await opsPrometheusProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal(response.result.status, "planned");
  assert.equal(response.result.domain, "prometheus");
  assert.equal(response.result.reason, "metrics_stack_not_running");
});

test("opsDashboardProvider aggregates a mix of real data and planned placeholders", async () => {
  const db = mockDb({
    columns: { player_state: [] },
    tables: new Set(["player_state", "player_death_log", "resourcefield_state", "player_virtual_currency_balances", "items", "inventories", "placeables"]),
    query: (text) => {
      if (text.includes("from dune.player_state") && text.includes("count(*)::int as total_players")) {
        return { rows: [{ total_players: 5, online_players: 2, players_dead: 0, active_last_1h: 0, active_last_24h: 0, active_last_7d: 0, inactive_players: 0, returning_players: 0, new_players: 0 }] };
      }
      if (text.includes("from dune.player_death_log")) {
        return { rows: [{ total_deaths: 1, unknown_deaths: 0, coriolis_deaths: 0, sandworm_deaths: 1 }] };
      }
      if (text.includes("from dune.resourcefield_state") && text.includes("count(*)::int as total_fields")) {
        return { rows: [{ total_fields: 3, total_value: 100 }] };
      }
      if (text.includes("from dune.player_virtual_currency_balances") && text.includes("count(distinct player_controller_id)")) {
        return { rows: [{ holders: 1, total_supply: 10 }] };
      }
      if (text.includes("from dune.items i") && text.includes("count(*)::int as total_items")) {
        return { rows: [{ total_items: 2 }] };
      }
      if (text.includes("from dune.items i") && text.includes("group by i.template_id")) {
        return { rows: [{ template_id: "Stone", count: 2, total_stack: 100 }] };
      }
      if (text.includes("from dune.placeables p") && text.includes("building_type in")) {
        return { rows: [{ id: 1, name: "", class: "GenericContainer_Placeable", map: "HaggaBasin", item_count: 2, owner_name: "Test" }] };
      }
      return null;
    }
  });

  const response = await opsDashboardProvider({}, db);
  assert.equal(response.ok, true);
  // Real data for the five wired domains. opsDashboardProvider() stores
  // each provider's full response (not just its .result) under
  // dashboard[domain], since it aggregates via Promise.allSettled over
  // the providers' own return values.
  assert.equal(response.dashboard.activity.ok, true);
  assert.equal(response.dashboard.activity.result.totalPlayers, 5);
  assert.equal(response.dashboard.combat.result.totalDeaths, 1);
  // resources is real too, but this mock db has no world_partition table,
  // so both Deep Desert and Hagga Basin sections legitimately come back
  // in their own genuine empty shape (no instances currently provisioned
  // for either map in this mock) -- addonOpsResourcesSummary's own
  // dedicated test file covers the full instance/PvP-PvE/size-tier
  // behavior with a real mapCombatState.js resolver sandbox.
  assert.equal(response.dashboard.resources.ok, true);
  assert.deepEqual(response.dashboard.resources.result.deepDesert.instances, []);
  assert.deepEqual(response.dashboard.resources.result.haggaBasin.instances, []);
  assert.equal(response.dashboard.economy.result.totalCurrencyHolders, 1);
  assert.equal(response.dashboard.inventory.result.totalItems, 2);
  assert.equal(response.dashboard.inventory.result.totalCrafted, null);
  assert.equal(response.dashboard.soc.ok, true);
  assert.equal(typeof response.dashboard.soc.result.bridgeRequests, "number");
  // Still-planned placeholder for the one untouched domain. Note
  // opsLocationProvider returns opsPlaceholder() directly (unwrapped),
  // while opsPrometheusProvider wraps addonOpsPrometheusHealth()'s own
  // "not running" shape in { ok: true, result } like every other real
  // provider — dashboard[domain] stores each provider's full return
  // value verbatim, so the two "still not fully available" domains
  // legitimately have different shapes here, both honest, neither a bug.
  assert.equal(response.dashboard.location.status, "planned");
  assert.equal(response.dashboard.prometheus.ok, true);
  assert.equal(response.dashboard.prometheus.result.status, "planned");
  assert.equal(response.dashboard.prometheus.result.reason, "metrics_stack_not_running");
});
