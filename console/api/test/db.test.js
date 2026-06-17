import test from "node:test";
import assert from "node:assert/strict";
import { assertIdentifier, discoverDbConfig, isReadOnlySql, quoteQualified, redactDbError } from "../src/db.js";
import { addCurrency, addFactionReputation, addIntel, addonLeadershipPlayers, completeJourneyNode, completeTutorial, deleteInventoryItem, giveItemToPlayer, giveItemToStorage, listPlayers, listTables, liveMapPlayers, liveMapServices, playerCraftingRecipes, playerJourney, playerResearchItems, resetJourneyNode, resetTutorial, runSql, tablePreview, unlockCraftingRecipe, unlockResearchItem, updateTableRow, UnsupportedCapabilityError } from "../src/duneDb.js";

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
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      return { fields: [{ name: "id", dataTypeID: 20 }], rows: [{ id: 1 }] };
    }
  };
  const result = await tablePreview(db, "dune", "player_state", 25, 5);
  assert.match(calls[1].text, /json_build_object\('pk'/);
  assert.match(calls[1].text, /"dune"\."player_state" order by "id" limit \$1 offset \$2/);
  assert.deepEqual(calls[1].values, [25, 5]);
  assert.equal(result.rows[0].id, 1);
});

test("manual row edit uses stable primary key row identifiers when available", async () => {
  const calls = [];
  const rowId = JSON.stringify({ pk: { id: 1 } });
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) {
        return { rows: [
          { name: "id" },
          { name: "goal_amount" }
        ] };
      }
      return { fields: [], rows: [], rowCount: 1, command: "UPDATE" };
    }
  };
  const result = await updateTableRow(db, "dune", "landsraad_tasks", rowId, { id: "1", goal_amount: "70001" });
  assert.equal(result.updatedRows, 1);
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  assert.match(updateCall.text, /where "id" = \$3$/);
  assert.deepEqual(updateCall.values, ["1", "70001", 1]);
});

test("database table list returns exact row counts", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("information_schema.tables")) {
        return { rows: [{ schema: "dune", name: "player_virtual_currency_balances" }] };
      }
      if (text.includes("count(*)::bigint")) return { rows: [{ row_count: "2" }] };
      return { rows: [] };
    }
  };
  const rows = await listTables(db, "dune");
  assert.equal(rows[0].row_count, "2");
  assert.match(calls[1].text, /"dune"\."player_virtual_currency_balances"/);
});

test("database currency writes emit Solaris live refresh hook", async () => {
  const calls = [];
  let solarisSnapshot = 0;
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.player_virtual_currency_balances") && text.includes("dune.get_solaris_id()")) {
        solarisSnapshot += 1;
        return { rows: [{ player_controller_id: "719", balance: solarisSnapshot === 1 ? "101" : "5000" }] };
      }
      return { fields: [], rows: [], rowCount: 1, command: "UPDATE" };
    }
  };
  const result = await runSql(db, "update dune.player_virtual_currency_balances set balance = 5000", true);
  assert.equal(result.rowCount, 1);
  assert.ok(calls.some((call) => String(call.text).includes("dune.log_event_solaris")));
});

test("manual currency row edit uses game balance function", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("information_schema.columns")) {
        return { rows: [
          { name: "player_controller_id" },
          { name: "currency_id" },
          { name: "balance" }
        ] };
      }
      if (text.includes("select player_controller_id, currency_id, balance")) {
        return { rows: [{ player_controller_id: "719", currency_id: "0", balance: "5000" }] };
      }
      return { fields: [], rows: [], rowCount: 1, command: "SELECT" };
    }
  };
  const result = await updateTableRow(db, "dune", "player_virtual_currency_balances", "(1,1)", {
    player_controller_id: "719",
    currency_id: "0",
    balance: "550"
  });
  assert.equal(result.updatedRows, 1);
  const adjustCall = calls.find((call) => String(call.text).includes("adjust_player_virtual_currency_balance"));
  assert.ok(adjustCall);
  assert.deepEqual(adjustCall.values, [719, 0, "-4450"]);
});

test("database faction writes sync reputation component", async () => {
  const calls = [];
  let factionSnapshot = 0;
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "properties" }] };
      if (text.includes("from dune.player_faction_reputation") && text.includes("order by actor_id")) {
        factionSnapshot += 1;
        return { rows: [{ actor_id: "721", faction_id: "1", reputation_amount: factionSnapshot === 1 ? "101" : "500" }] };
      }
      if (text.includes("from dune.player_faction_reputation") && text.includes("faction_id in (1, 2)")) {
        return { rows: [{ faction_id: 1, reputation_amount: 500 }] };
      }
      return { fields: [], rows: [], rowCount: 1, command: "UPDATE" };
    }
  };
  const result = await runSql(db, "update dune.player_faction_reputation set reputation_amount = 500", true);
  assert.equal(result.rowCount, 1);
  assert.ok(calls.some((call) => String(call.text).includes("dune.set_player_faction_reputation")));
  assert.ok(calls.some((call) => String(call.text).includes("FactionPlayerComponent")));
});

test("database writes replay known tutorial journey tag and item functions", async () => {
  const calls = [];
  let tutorialSnapshot = 0;
  let journeySnapshot = 0;
  let tagSnapshot = 0;
  let itemSnapshot = 0;
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (/^\s*select/i.test(text) && text.includes("from dune.tutorial_per_player")) {
        tutorialSnapshot += 1;
        return { rows: [{ player_id: "719", tutorial_id: "3", tutorial_state: tutorialSnapshot === 1 ? "1" : "2" }] };
      }
      if (/^\s*select/i.test(text) && text.includes("from dune.journey_story_node")) {
        journeySnapshot += 1;
        return { rows: [{
          account_id: "424",
          story_node_id: "DA_Test",
          override_reward_block: false,
          has_pending_reward: false,
          complete_condition_state: journeySnapshot === 1 ? "false" : "true",
          reveal_condition_state: "true",
          fail_condition_state: "{}",
          metadata_state: "{}",
          reset_group: "Default"
        }] };
      }
      if (/^\s*select/i.test(text) && text.includes("from dune.player_tags")) {
        tagSnapshot += 1;
        return { rows: tagSnapshot === 1 ? [] : [{ account_id: "424", tag: "Faction.Atreides.Tier1" }] };
      }
      if (/^\s*select/i.test(text) && text.includes("from dune.items")) {
        itemSnapshot += 1;
        return { rows: itemSnapshot === 1 ? [{ id: "9001", inventory_id: "42", template_id: "WaterBottle_1" }] : [] };
      }
      return { fields: [], rows: [], rowCount: 1, command: "UPDATE" };
    }
  };
  await runSql(db, "update dune.tutorial_per_player set tutorial_state = 2", true);
  await runSql(db, "update dune.journey_story_node set complete_condition_state = 'true'", true);
  await runSql(db, "insert into dune.player_tags(account_id, tag) values (424, 'Faction.Atreides.Tier1')", true);
  await runSql(db, "delete from dune.items where id = 9001", true);
  assert.ok(calls.some((call) => String(call.text).includes("dune.create_or_update_tutorial_entry")));
  assert.ok(calls.some((call) => String(call.text).includes("dune.save_journey_story_node")));
  assert.ok(calls.some((call) => String(call.text).includes("dune.update_player_tags")));
  assert.ok(calls.some((call) => String(call.text).includes("dune._add_item_delete_log")));
});

test("players query uses parameterized search input", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      return { rows: [{ actor_id: 82, player_pawn_id: 82, account_id: 276, funcom_id: "RedBlink#75570", fls_id: "RedBlink#75570", action_player_id: "RedBlink#75570" }] };
    }
  };
  const result = await listPlayers(db, { q: "RedBlink'; drop table dune.actors; --" });
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors"));
  assert.ok(playerQuery);
  assert.match(playerQuery.text, /as player_pawn_id/);
  assert.match(playerQuery.text, /as funcom_id/);
  assert.match(playerQuery.text, /as action_player_id/);
  assert.match(playerQuery.text, /A5C0DE5E12A00001/);
  assert.match(playerQuery.text, /Server#0001/);
  assert.match(playerQuery.text, /\$1/);
  assert.deepEqual(playerQuery.values, ["%RedBlink'; drop table dune.actors; --%"]);
  assert.equal(result.rows[0].actor_id, 82);
  assert.equal(result.rows[0].player_pawn_id, 82);
  assert.equal(result.rows[0].account_id, 276);
  assert.equal(result.rows[0].funcom_id, "RedBlink#75570");
  assert.equal(result.rows[0].fls_id, "RedBlink#75570");
  assert.equal(result.rows[0].action_player_id, "RedBlink#75570");
});

test("addon leadership players include level and faction summaries", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.actors", "dune.player_state", "dune.specialization_tracks", "dune.player_faction", "dune.factions", "dune.guild_members", "dune.guilds"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guild_members") return { rows: ["player_id", "guild_id", "role_id"].map((column_name) => ({ column_name })) };
        if (table === "guilds") return { rows: ["guild_id", "guild_name", "guild_description"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      if (text.includes("from dune.actors a")) {
        return { rows: [
          { actor_id: 101, player_pawn_id: 101, account_id: 201, character_name: "Test One", player_controller_id: 301, map: "Survival_1", online_status: "Online", last_seen: "" },
          { actor_id: 102, player_pawn_id: 102, account_id: 202, character_name: "Test Two", player_controller_id: 302, map: "Overmap", online_status: "Offline", last_seen: "2026-06-14T01:02:03Z" }
        ] };
      }
      if (text.includes("from dune.specialization_tracks")) {
        return { rows: [
          { player_id: "301", level: 18 },
          { player_id: "302", level: 7 }
        ] };
      }
      if (text.includes("from dune.player_faction pf")) {
        return { rows: [
          { actor_id: "301", faction_id: "1", faction_name: "Atreides" },
          { actor_id: "302", faction_id: "2", faction_name: "Harkonnen" }
        ] };
      }
      if (text.includes("from dune.guild_members gm")) {
        return { rows: [
          { player_id: "301", guild_name: "Water Sellers" },
          { player_id: "302", guild_name: "Spice Guild" }
        ] };
      }
      return { rows: [] };
    }
  };
  const result = await addonLeadershipPlayers(db);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => [row.name, row.level, row.faction]), [
    ["Test One", 18, "Atreides"],
    ["Test Two", 7, "Harkonnen"]
  ]);
  assert.deepEqual(result.rows.map((row) => row.guild), ["Water Sellers", "Spice Guild"]);
});

test("addon leadership players derive character level from level component XP", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.actors", "dune.player_state", "dune.actor_fgl_entities", "dune.fgl_entities"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) return { rows: [] };
      if (text.includes("from dune.actors a")) {
        return { rows: [
          { actor_id: 475, player_pawn_id: 475, account_id: 201, character_name: "Kerplunk Kersplat", player_controller_id: 473, map: "Survival_1", online_status: "Online", last_seen: "" },
          { actor_id: 746, player_pawn_id: 746, account_id: 202, character_name: "Test9", player_controller_id: 744, map: "Overmap", online_status: "Offline", last_seen: "" }
        ] };
      }
      if (text.includes("from dune.player_state ps") && text.includes("FLevelComponent")) {
        return { rows: [
          { player_controller_id: "473", player_pawn_id: "475", xp: 42044 },
          { player_controller_id: "744", player_pawn_id: "746", xp: 0 }
        ] };
      }
      return { rows: [] };
    }
  };
  const result = await addonLeadershipPlayers(db);
  assert.deepEqual(result.rows.map((row) => [row.name, row.level]), [
    ["Kerplunk Kersplat", 73],
    ["Test9", 0]
  ]);
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

test("player give-item persists selected item grade", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 501, template_id: "WaterBottle_1", stack_size: 3, quality_level: 5, position_index: 2, inventory_id: 7 }]
  });
  const result = await giveItemToPlayer(db, 123, { templateId: "WaterBottle_1", quantity: 3, quality: 5 });
  assert.equal(result.inserted.quality_level, 5);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 5), [7, "WaterBottle_1", 3, 5, 2]);
  assert.deepEqual(JSON.parse(insert.values[5]), {
    FCustomizationStats: [[], {}],
    FItemStackAndDurabilityStats: [[], {}]
  });
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

test("intel mutation updates TechKnowledge points on the player actor", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    intelRows: [{ intel: 10 }]
  });
  const result = await addIntel(db, 123, { amount: 25 });
  assert.equal(result.oldValue, 10);
  assert.equal(result.newValue, 35);
  assert.equal(result.amount, 25);
  assert.equal(result.capped, false);
  assert.ok(calls.some((call) => call.text.includes("TechKnowledgePlayerComponent") && call.text.includes("jsonb_set") && call.values[1] === 35));
});

test("intel mutation requires offline player to avoid live state overwrite", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    playerRows: [{ actor_id: 123, account_id: 44, controller_id: 55, online_status: "Online" }],
    intelRows: [{ intel: 10 }]
  });
  await assert.rejects(
    () => addIntel(db, 123, { amount: 25 }),
    /require the player to be offline/
  );
  assert.equal(calls.some((call) => call.text.includes("m_TechKnowledgePoints") && call.text.includes("update")), false);
});

test("intel mutation clamps grants to the spendable cap", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    intelRows: [{ intel: 2770 }]
  });
  const result = await addIntel(db, 123, { amount: 25 });
  assert.equal(result.oldValue, 2770);
  assert.equal(result.newValue, 2779);
  assert.equal(result.amount, 9);
  assert.equal(result.requestedAmount, 25);
  assert.equal(result.maxValue, 2779);
  assert.equal(result.capped, true);
  assert.ok(calls.some((call) => call.text.includes("TechKnowledgePlayerComponent") && call.text.includes("jsonb_set") && call.values[1] === 2779));
});

test("crafting recipe listing uses verified BaseRecipeId names and player unlock status", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    craftingListRows: [
      { recipe_id: "T2_Material_Silicone_Recipe", source: "SchematicPickup", quality_level: 0, unlocked: true },
      { recipe_id: "BuggyEngine_4_Recipe", source: "SchematicPickup", quality_level: 0, unlocked: false }
    ]
  });
  const result = await playerCraftingRecipes(db, 123);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].recipeId, "T2_Material_Silicone_Recipe");
  assert.equal(result.rows[0].displayName, "T2 Material Silicone");
  assert.equal(result.rows[0].unlocked, true);
  assert.equal(result.rows[1].category, "Vehicles");
  assert.ok(calls.some((call) => call.text.includes("CraftingRecipesLibraryActorComponent") && call.text.includes("all_recipes")));
});

test("crafting recipe unlock appends exact recipe object without dropping existing recipes", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    recipeExists: true,
    currentCraftingRecipes: [{ BaseRecipeId: { Name: "HealthPackRecipe" }, m_Source: "SchematicPickup" }]
  });
  const result = await unlockCraftingRecipe(db, 123, { recipeId: "BuggyEngine_4_Recipe" });
  assert.equal(result.recipeId, "BuggyEngine_4_Recipe");
  assert.equal(result.alreadyUnlocked, false);
  const update = calls.find((call) => call.text.includes("CraftingRecipesLibraryActorComponent,m_KnownItemRecipes") && call.text.includes("update dune.actors"));
  assert.ok(update);
  const recipes = JSON.parse(update.values[1]);
  assert.equal(recipes.length, 2);
  assert.equal(recipes[0].BaseRecipeId.Name, "HealthPackRecipe");
  assert.equal(recipes[1].BaseRecipeId.Name, "BuggyEngine_4_Recipe");
  assert.equal(recipes[1].m_Source, "SchematicPickup");
});

test("crafting recipe unlock does not duplicate an already unlocked recipe", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    recipeExists: true,
    currentCraftingRecipes: [{ BaseRecipeId: { Name: "BuggyEngine_4_Recipe" }, m_Source: "SchematicPickup" }]
  });
  const result = await unlockCraftingRecipe(db, 123, { recipeId: "BuggyEngine_4_Recipe" });
  assert.equal(result.alreadyUnlocked, true);
  assert.equal(calls.some((call) => call.text.includes("update dune.actors") && call.text.includes("m_KnownItemRecipes")), false);
});

test("research listing uses TechKnowledge item keys and selected player state", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchListRows: [
      { item_key: "RCP_HealthPackRecipe", unlocked_state: "Purchased", is_new: false },
      { item_key: "DA_GRP_SandbikePack", unlocked_state: "NotPurchased", is_new: true },
      { item_key: "DA_GRP_BuggyPack", unlocked_state: "NotPurchased", is_new: true },
      { item_key: "RCP_RecyclerDUMMY_UniqueBikeBoost", unlocked_state: "NotPurchased", is_new: true }
    ]
  });
  const result = await playerResearchItems(db, 123);
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[0].itemKey, "RCP_HealthPackRecipe");
  assert.equal(result.rows[0].type, "Recipe");
  assert.equal(result.rows[0].unlocked, true);
  assert.equal(result.rows[1].type, "Group");
  assert.equal(result.rows[2].category, "Vehicles");
  assert.equal(result.rows[2].productGroup, "Copper Products");
  assert.equal(result.rows[3].category, "Uniques");
  assert.equal(result.rows[3].productGroup, "Copper Products");
  assert.ok(calls.some((call) => call.text.includes("TechKnowledgePlayerComponent") && call.text.includes("all_research")));
});

test("research unlock updates TechKnowledge and materializes verified recipe", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchExists: true,
    currentResearchItems: [{ ItemKey: "RCP_HealthPackRecipe", bIsNewEntry: true, UnlockedState: "NotPurchased" }],
    recipeExists: true,
    currentCraftingRecipes: []
  });
  const result = await unlockResearchItem(db, 123, { itemKey: "RCP_HealthPackRecipe" });
  assert.equal(result.alreadyUnlocked, false);
  assert.equal(result.recipeId, "HealthPackRecipe");
  assert.equal(result.recipeMaterialized, true);
  const researchUpdate = calls.find((call) => call.text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && call.text.includes("update dune.actors"));
  assert.ok(researchUpdate);
  const items = JSON.parse(researchUpdate.values[1]);
  assert.deepEqual(items[0], { ItemKey: "RCP_HealthPackRecipe", bIsNewEntry: false, UnlockedState: "Purchased" });
  const recipeUpdate = calls.find((call) => call.text.includes("CraftingRecipesLibraryActorComponent,m_KnownItemRecipes") && call.text.includes("update dune.actors"));
  assert.ok(recipeUpdate);
  assert.equal(JSON.parse(recipeUpdate.values[1])[0].BaseRecipeId.Name, "HealthPackRecipe");
});

test("research unlock appends missing verified key without duplicating existing entries", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchExists: true,
    currentResearchItems: [{ ItemKey: "DA_GRP_SandbikePack", bIsNewEntry: true, UnlockedState: "NotPurchased" }],
    recipeExists: false
  });
  const result = await unlockResearchItem(db, 123, { itemKey: "BLD_Windtrap_Patent" });
  assert.equal(result.recipeId, "");
  const researchUpdate = calls.find((call) => call.text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && call.text.includes("update dune.actors"));
  assert.ok(researchUpdate);
  const items = JSON.parse(researchUpdate.values[1]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], { ItemKey: "BLD_Windtrap_Patent", bIsNewEntry: false, UnlockedState: "Purchased" });
});

test("research unlock requires offline player to avoid live state overwrite", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    playerRows: [{ actor_id: 123, account_id: 44, controller_id: 55, online_status: "Online" }],
    researchExists: true,
    currentResearchItems: [{ ItemKey: "RCP_HealthPackRecipe", bIsNewEntry: true, UnlockedState: "NotPurchased" }]
  });
  await assert.rejects(
    () => unlockResearchItem(db, 123, { itemKey: "RCP_HealthPackRecipe" }),
    /require the player to be offline/
  );
  assert.equal(calls.some((call) => call.text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && call.text.includes("update dune.actors")), false);
});

test("journey listing groups story contract codex and tutorial rows with player status", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    codexRows: [{ story_node_id: "DA_Dunipedia_KnownUniverse" }],
    journeyStateRows: [
      { story_node_id: "DA_Story.Root", is_complete: false, is_revealed: true, has_pending_reward: false },
      { story_node_id: "DA_CT_Arrakeen.Contract", is_complete: true, is_revealed: true, has_pending_reward: false },
      { story_node_id: "DA_Dunipedia_KnownUniverse", is_complete: true, is_revealed: true, has_pending_reward: false }
    ],
    tutorialRows: [{ id: 7, name: "AttackTutorial", tutorial_state: 2 }]
  });
  const result = await playerJourney(db, 123, { journey_node_tags: { "DA_Story.Root": ["Story.Tag"], "DA_Story.Root.Child": ["Story.Child"], "DA_CT_Arrakeen.Contract": ["Contract.Tag"] } });
  assert.equal(result.rows.story.length, 2);
  assert.equal(result.rows.story[1].parentId, "DA_Story.Root");
  assert.equal(result.rows.contract[0].status, "Complete");
  assert.equal(result.rows.codex[0].category, "Codex");
  assert.equal(result.rows.tutorial[0].status, "Complete");
  assert.ok(calls.some((call) => call.text.includes("from dune.tutorials")));
});

test("journey listing includes faction contract aliases from game data", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    playerTagRows: [{ tag: "Faction.Atreides.Tier1" }]
  });
  const result = await playerJourney(db, 123, {
    journey_node_tags: {},
    contract_aliases: { Fac_Atre_Rank00_02_FacFunnel: "DA_CT_Fac_Atre_Rank00_02_FacFunnel" },
    contract_tags: { DA_CT_Fac_Atre_Rank00_02_FacFunnel: ["Faction.Atreides.Tier1"] }
  });
  assert.equal(result.rows.contract.length, 1);
  assert.equal(result.rows.contract[0].rawName, "Fac_Atre_Rank00_02_FacFunnel");
  assert.equal(result.rows.contract[0].category, "Contract");
  assert.equal(result.rows.contract[0].status, "Complete");
});

test("faction quest journey nodes stay under story instead of contracts", async () => {
  const calls = [];
  const db = fakeMutationDb(calls);
  const result = await playerJourney(db, 123, {
    journey_node_tags: { "DA_FQ_ClimbTheRanks.Rank5To20.MeetSponsor.TalkToSponsor": ["DialogueFlags.Factions.CannotBetray"] },
    contract_aliases: {},
    contract_tags: {}
  });
  assert.equal(result.rows.story.length, 1);
  assert.equal(result.rows.contract.length, 0);
  assert.equal(result.rows.story[0].category, "Story");
});

test("main quest nodes with contract in the name stay under story", async () => {
  const calls = [];
  const db = fakeMutationDb(calls);
  const result = await playerJourney(db, 123, {
    journey_node_tags: { "DA_MQ_ANewBeginning.Reach Civilization.Tradepost.PickupContract": ["Contract.UniqueInstance.ZantaraBounty.Taken"] },
    contract_aliases: {},
    contract_tags: {}
  });
  assert.equal(result.rows.story.length, 1);
  assert.equal(result.rows.contract.length, 0);
  assert.equal(result.rows.story[0].category, "Story");
});

test("journey complete updates subtree and applies tags", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    journeyUpdateRows: 2,
    reputationRows: [{ reputation_amount: 0 }],
    factionRows: [{ faction_id: 1, reputation_amount: 100 }]
  });
  const result = await completeJourneyNode(db, 123, { nodeId: "DA_Story.Root" }, { journey_node_tags: { "DA_Story.Root": ["Story.Tag", "Faction.Atreides.Tier1"], "DA_Story.Root.Child": ["Child.Tag"] } });
  assert.equal(result.updatedRows, 2);
  assert.equal(result.tagsApplied, 3);
  assert.ok(calls.some((call) => call.text.includes("story_node_id = $2 or story_node_id like $2 || '.%'") && call.values[1] === "DA_Story.Root"));
  assert.ok(calls.some((call) => call.text.includes("dune.update_player_tags") && call.values[1].includes("Child.Tag")));
  assert.ok(calls.some((call) => call.text.includes("set_player_faction_reputation") && call.values[2] === 100));
});

test("journey reset clears subtree completion and removes tags", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { journeyUpdateRows: 1 });
  const result = await resetJourneyNode(db, 123, { nodeId: "DA_Story.Root" }, { journey_node_tags: { "DA_Story.Root": ["Story.Tag"], "DA_Story.Root.Child": ["Child.Tag"] } });
  assert.equal(result.updatedRows, 1);
  assert.equal(result.tagsRemoved, 2);
  assert.ok(calls.some((call) => call.text.includes("complete_condition_state = 'false'::jsonb")));
  assert.ok(calls.some((call) => call.text.includes("dune.update_player_tags") && call.values[1].includes("Child.Tag")));
});

test("tutorial complete and reset use player controller tutorial records", async () => {
  const completeCalls = [];
  const completeDb = fakeMutationDb(completeCalls, { tutorialExists: true });
  const complete = await completeTutorial(completeDb, 123, { tutorialId: 7 });
  assert.equal(complete.state, 2);
  assert.ok(completeCalls.some((call) => call.text.includes("create_or_update_tutorial_entry") && call.values[0] === 55 && call.values[1] === 7));

  const resetCalls = [];
  const resetDb = fakeMutationDb(resetCalls, { tutorialDeleteRows: 1 });
  const reset = await resetTutorial(resetDb, 123, { tutorialId: 7 });
  assert.equal(reset.deletedRows, 1);
  assert.ok(resetCalls.some((call) => call.text.includes("delete from dune.tutorial_per_player") && call.values[0] === 55 && call.values[1] === 7));
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
      if (text.includes("TechKnowledgePlayerComponent") && text.includes("all_research")) return { rows: fixtures.researchListRows || [] };
      if (text.includes("TechKnowledgePlayerComponent") && text.includes("select exists")) return { rows: [{ exists: Boolean(fixtures.researchExists) }] };
      if (text.includes("TechKnowledgePlayerComponent") && text.includes("m_TechKnowledgeData") && text.includes("for update")) return { rows: fixtures.currentResearchItems === null ? [] : [{ items: fixtures.currentResearchItems || [] }] };
      if (text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && text.includes("update dune.actors")) return { rows: [{ ok: true }] };
      if (text.includes("CraftingRecipesLibraryActorComponent") && text.includes("all_recipes")) return { rows: fixtures.craftingListRows || [] };
      if (text.includes("CraftingRecipesLibraryActorComponent") && text.includes("select exists")) return { rows: [{ exists: Boolean(fixtures.recipeExists) }] };
      if (text.includes("CraftingRecipesLibraryActorComponent") && text.includes("for update")) return { rows: fixtures.currentCraftingRecipes === null ? [] : [{ recipes: fixtures.currentCraftingRecipes || [] }] };
      if (text.includes("CraftingRecipesLibraryActorComponent,m_KnownItemRecipes") && text.includes("update dune.actors")) return { rows: [{ ok: true }] };
      if (text.includes("story_node_id like 'DA_Dunipedia_%'")) return { rows: fixtures.codexRows || [] };
      if (text.includes("from dune.journey_story_node") && text.includes("where account_id = $1")) return { rows: fixtures.journeyStateRows || [] };
      if (text.includes("select tag from dune.player_tags")) return { rows: fixtures.playerTagRows || [] };
      if (text.includes("update dune.journey_story_node")) return { rows: [], rowCount: fixtures.journeyUpdateRows ?? 0 };
      if (text.includes("insert into dune.journey_story_node")) return { rows: [{ ok: true }], rowCount: 1 };
      if (text.includes("from dune.tutorials t")) return { rows: fixtures.tutorialRows || [] };
      if (text.includes("select exists (select 1 from dune.tutorials")) return { rows: [{ exists: Boolean(fixtures.tutorialExists) }] };
      if (text.includes("create_or_update_tutorial_entry")) return { rows: [{ ok: true }] };
      if (text.includes("delete from dune.tutorial_per_player")) return { rows: [], rowCount: fixtures.tutorialDeleteRows ?? 0 };
      if (text.includes("dune.update_player_tags")) return { rows: [{ ok: true }] };
      if (text.includes("from dune.actors a")) return { rows: fixtures.playerRows || [{ actor_id: 123, account_id: 44, controller_id: 55, online_status: "Offline" }] };
      if (text.includes("dune.get_solaris_id")) return { rows: [{ currency_id: 0 }] };
      if (text.includes("adjust_player_virtual_currency_balance")) return { rows: [{ ok: true }] };
      if (text.includes("player_virtual_currency_balances")) return { rows: fixtures.balanceRows || [] };
      if (text.includes("select reputation_amount")) return { rows: fixtures.reputationRows || [] };
      if (text.includes("set_player_faction_reputation")) return { rows: [{ ok: true }] };
      if (text.includes("where actor_id = $1 and faction_id in")) return { rows: fixtures.factionRows || [] };
      if (text.includes("jsonb_set") && text.includes("FactionPlayerComponent")) return { rows: [] };
      if (text.includes("m_TechKnowledgePoints") && text.includes("select")) return { rows: fixtures.intelRows || [] };
      if (text.includes("m_TechKnowledgePoints") && text.includes("update")) return { rows: [{ ok: true }] };
      if (text.includes("from dune.items i") && text.includes("where i.id = $1")) return { rows: fixtures.itemRows || [] };
      if (text.includes("not exists(select 1 from dune.items where id = $1")) return { rows: [{ deleted: true }] };
      if (text.includes("exists(select 1 from dune.items where id = $1")) return { rows: [{ exists: Boolean(fixtures.itemStillExists) }] };
      if (text.includes("delete from dune.items where id = $1")) return { rows: [], rowCount: 1 };
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
