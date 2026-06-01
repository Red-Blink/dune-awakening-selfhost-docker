import test from "node:test";
import assert from "node:assert/strict";
import { assertIdentifier, discoverDbConfig, isReadOnlySql, quoteQualified, redactDbError } from "../src/db.js";
import { addCurrency, addFactionReputation, deleteInventoryItem, giveItemToStorage, listPlayers, liveMapPlayers, liveMapServices, tablePreview, UnsupportedCapabilityError } from "../src/duneDb.js";

test("discovers RedBlink Postgres defaults and env overrides", () => {
  assert.deepEqual(discoverDbConfig({}), {
    host: "127.0.0.1",
    port: 15432,
    database: "dune",
    user: "dune",
    password: "dune",
    source: "RedBlink defaults"
  });
  assert.equal(discoverDbConfig({ ADMIN_DATABASE_URL: "postgres://user:secret@host/db" }).source, "ADMIN_DATABASE_URL");
  assert.equal(discoverDbConfig({ DUNE_DB_HOST: "db", DUNE_DB_PORT: "5432" }).host, "db");
});

test("validates and quotes SQL identifiers", () => {
  assert.equal(assertIdentifier("player_state"), "player_state");
  assert.equal(quoteQualified("dune", "player_state"), '"dune"."player_state"');
  assert.throws(() => assertIdentifier("player_state;drop"));
  assert.throws(() => quoteQualified("dune", "../accounts"));
});

test("detects destructive SQL and redacts connection strings", () => {
  assert.equal(isReadOnlySql("/* ok */ select * from dune.player_state"), true);
  assert.equal(isReadOnlySql("with x as (select 1) select * from x"), true);
  assert.equal(isReadOnlySql("delete from dune.items"), false);
  assert.doesNotMatch(redactDbError("postgres://dune:secret@127.0.0.1:15432/dune password=secret"), /secret/);
});

test("builds table preview query with quoted identifiers and parameters", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      return { fields: [{ name: "id", dataTypeID: 20 }], rows: [{ id: 1 }] };
    }
  };
  const result = await tablePreview(db, "dune", "player_state", 25, 5);
  assert.match(calls[0].text, /"dune"\."player_state" limit \$1 offset \$2/);
  assert.deepEqual(calls[0].values, [25, 5]);
  assert.equal(result.rows[0].id, 1);
});

test("players query uses parameterized search input", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      return { rows: [] };
    }
  };
  await listPlayers(db, { q: "RedBlink'; drop table dune.actors; --" });
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors"));
  assert.ok(playerQuery);
  assert.match(playerQuery.text, /\$1/);
  assert.deepEqual(playerQuery.values, ["%RedBlink'; drop table dune.actors; --%"]);
});

test("live map player markers validate map filter and use parameterized transform query", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      return { rows: [{ id: 10, type: "player", name: "Red", online_status: "Online", map: "Survival_1", partition_id: 1, class: "Player", x: "1", y: "2", z: "3" }] };
    }
  };
  const result = await liveMapPlayers(db, "Survival_1");
  assert.equal(result.rows[0].type, "player");
  const markerQuery = calls.find((call) => call.text.includes("join dune.player_state"));
  assert.ok(markerQuery);
  assert.match(markerQuery.text, /a\.map = \$1/);
  assert.deepEqual(markerQuery.values, ["Survival_1"]);
  await assert.rejects(() => liveMapPlayers(db, "bad;map"), /Invalid map name/);
});

test("live map services returns capability response when world partitions are missing", async () => {
  const db = {
    query: async () => ({ rows: [{ exists: false }] })
  };
  const result = await liveMapServices(db);
  assert.equal(result.capabilities.services, false);
  assert.match(result.reason, /dune\.world_partition/);
});

test("inventory delete verifies ownership before calling dune.delete_item", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemRows: [{ id: 99, template_id: "WaterBottle_1", stack_size: 1, quality_level: 0, position_index: 0, inventory_id: 7, actor_id: 123 }]
  });
  const result = await deleteInventoryItem(db, 123, 99);
  assert.equal(result.deleted.id, 99);
  assert.ok(calls.some((call) => call.text.includes("where i.id = $1 and inv.actor_id = $2") && call.values[0] === 99 && call.values[1] === 123));
  assert.ok(calls.some((call) => call.text.includes("dune.delete_item($1::bigint)") && call.values[0] === 99));
});

test("inventory delete rejects rows not owned by the selected player", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { itemRows: [] });
  await assert.rejects(() => deleteInventoryItem(db, 123, 99), /selected player's directly-owned inventory/);
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item")), false);
});

test("storage give-item validates capacity and inserts parameterized item rows", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 501, template_id: "WaterBottle_1", stack_size: 3, quality_level: 0, position_index: 2, inventory_id: 7 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "WaterBottle_1", quantity: 3 });
  assert.equal(result.inserted.id, 501);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 5), [7, "WaterBottle_1", 3, 0, 2]);
});

test("storage give-item reports unsupported capability when schema functions are absent", async () => {
  const db = {
    query: async (text) => text.includes("to_regclass") ? { rows: [{ exists: false }] } : { rows: [] },
    transaction: async (fn) => fn(db)
  };
  await assert.rejects(() => giveItemToStorage(db, 222, { templateId: "WaterBottle_1", quantity: 1 }), UnsupportedCapabilityError);
});

test("currency mutation resolves Solaris and calls adjust function in a transaction", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    balanceRows: [{ currency_id: 0, balance: 1234 }]
  });
  const result = await addCurrency(db, 123, { currencyId: 0, amount: 25 });
  assert.equal(result.currencyId, 0);
  assert.equal(result.balance.balance, 1234);
  const adjust = calls.find((call) => call.text.includes("adjust_player_virtual_currency_balance"));
  assert.ok(adjust);
  assert.deepEqual(adjust.values, [55, 0, 25]);
});

test("faction mutation clamps reputation and syncs actor component JSON", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    reputationRows: [{ reputation_amount: 12470 }],
    factionRows: [{ faction_id: 1, reputation_amount: 12474 }, { faction_id: 2, reputation_amount: 10 }]
  });
  const result = await addFactionReputation(db, 123, { factionId: 1, amount: 50 });
  assert.equal(result.newValue, 12474);
  assert.ok(calls.some((call) => call.text.includes("set_player_faction_reputation") && call.values[2] === 12474));
  assert.ok(calls.some((call) => call.text.includes("FactionPlayerComponent,m_FactionDataArray")));
});

function fakeMutationDb(calls, fixtures = {}) {
  const db = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        const names = table === "inventories"
          ? ["id", "actor_id", "max_item_count", "max_item_volume", "inventory_type"]
          : table === "actors"
            ? ["id", "class", "owner_account_id", "properties"]
            : ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"];
        return { rows: names.map((column_name) => ({ column_name })) };
      }
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, online_status: "Offline" }] };
      if (text.includes("dune.get_solaris_id")) return { rows: [{ currency_id: 0 }] };
      if (text.includes("adjust_player_virtual_currency_balance")) return { rows: [{ ok: true }] };
      if (text.includes("player_virtual_currency_balances")) return { rows: fixtures.balanceRows || [] };
      if (text.includes("select reputation_amount")) return { rows: fixtures.reputationRows || [] };
      if (text.includes("set_player_faction_reputation")) return { rows: [{ ok: true }] };
      if (text.includes("where actor_id = $1 and faction_id in")) return { rows: fixtures.factionRows || [] };
      if (text.includes("jsonb_set") && text.includes("FactionPlayerComponent")) return { rows: [] };
      if (text.includes("from dune.items i") && text.includes("where i.id = $1")) return { rows: fixtures.itemRows || [] };
      if (text.includes("dune.delete_item")) return { rows: [{ ok: true }] };
      if (text.includes("from dune.inventories") && text.includes("where actor_id")) return { rows: fixtures.storageRows || [] };
      if (text.includes("count(*)::int")) return { rows: fixtures.countRows || [{ count: 0 }] };
      if (text.includes("max(position_index)")) return { rows: [{ position_index: 2 }] };
      if (text.includes("insert into dune.items")) return { rows: fixtures.insertedRows || [] };
      return { rows: [] };
    },
    async transaction(fn) {
      calls.push({ text: "begin", values: [] });
      const result = await fn(db);
      calls.push({ text: "commit", values: [] });
      return result;
    }
  };
  return db;
}
