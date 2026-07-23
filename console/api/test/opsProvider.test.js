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

// Wiring the four real OPS routes (activity/combat/resources/economy) to
// their already-working duneDb.js query functions — see
// server.js's "ops.activity.summary" etc. bridge actions for the
// pre-existing pattern this mirrors. These tests exercise the real
// duneDb.js functions through a mock db (following the `to_regclass`
// mock convention used across this test suite, e.g. db.test.js), proving
// each provider returns { ok: true, result } with real, correctly-shaped
// data when the underlying tables have rows, and each function's own
// genuine empty/zero shape (not a placeholder) when the tables don't
// exist — never a fabricated or estimated value.

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

test("opsResourcesProvider returns real resource-field data wrapped in { ok, result }", async () => {
  const db = mockDb({
    tables: new Set(["resourcefield_state"]),
    query: (text) => {
      if (text.includes("from dune.resourcefield_state") && text.includes("count(*)::int as total_fields")) {
        return { rows: [{ total_fields: 15, total_value: 90000 }] };
      }
      if (text.includes("group by map")) {
        return { rows: [{ map: "DeepDesert", fields: 15, total_value: 90000 }] };
      }
      return null;
    }
  });

  const response = await opsResourcesProvider({}, db);
  assert.equal(response.ok, true);
  assert.equal(response.result.totalFields, 15);
  assert.equal(response.result.totalValueRemaining, 90000);
  assert.ok(Array.isArray(response.result.resourcesByMap));
});

test("opsResourcesProvider returns the real empty shape when resourcefield_state doesn't exist", async () => {
  const db = mockDb({ tables: new Set() });
  const response = await opsResourcesProvider({}, db);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { totalFields: 0, totalValueRemaining: 0, resourcesByMap: [], spiceFieldsBySize: [] });
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

// The five OPS domains with no backing query anywhere in this codebase
// (inventory, location, soc, prometheus, and dashboard's aggregation of
// them) must remain unchanged "status: planned" placeholders — do not
// fabricate data for these.
test("the five untouched OPS providers still return status: planned placeholders", async () => {
  const db = mockDb();
  for (const [provider, domain] of [
    [opsInventoryProvider, "inventory"],
    [opsLocationProvider, "location"],
    [opsSocProvider, "soc"],
    [opsPrometheusProvider, "prometheus"]
  ]) {
    const response = await provider({}, db);
    assert.equal(response.ok, true);
    assert.equal(response.status, "planned");
    assert.equal(response.domain, domain);
    assert.deepEqual(response.summary, {});
  }
});

test("opsDashboardProvider aggregates a mix of real data and planned placeholders", async () => {
  const db = mockDb({
    columns: { player_state: [] },
    tables: new Set(["player_state", "player_death_log", "resourcefield_state", "player_virtual_currency_balances"]),
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
      return null;
    }
  });

  const response = await opsDashboardProvider({}, db);
  assert.equal(response.ok, true);
  // Real data for the four wired domains. opsDashboardProvider() stores
  // each provider's full response (not just its .result) under
  // dashboard[domain], since it aggregates via Promise.allSettled over
  // the providers' own return values.
  assert.equal(response.dashboard.activity.ok, true);
  assert.equal(response.dashboard.activity.result.totalPlayers, 5);
  assert.equal(response.dashboard.combat.result.totalDeaths, 1);
  assert.equal(response.dashboard.resources.result.totalFields, 3);
  assert.equal(response.dashboard.economy.result.totalCurrencyHolders, 1);
  // Still-planned placeholders for the untouched four
  assert.equal(response.dashboard.inventory.status, "planned");
  assert.equal(response.dashboard.location.status, "planned");
  assert.equal(response.dashboard.soc.status, "planned");
  assert.equal(response.dashboard.prometheus.status, "planned");
});
