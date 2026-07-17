import test from "node:test";
import assert from "node:assert/strict";
import { assertIdentifier, discoverDbConfig, isReadOnlySql, quoteQualified, redactDbError, rowsResult } from "../src/db.js";
import { addCurrency, addFactionReputation, addIntel, addonLeadershipPlayers, addonOpsHealthFarms, addonOpsHealthPlayers, addonOpsHealthSummary, addonOpsHealthSummaryV2, augmentInventoryItem, augmentNewestPlayerItem, changeDunePassword, completeJourneyNode, completeTutorial, deleteInventoryItem, giveItemToPlayer, giveItemToStorage, guildMembers, landsraadOverview, listGuilds, listPlayers, listSpicefieldTypes, listTables, liveMapPlayers, liveMapServices, playerCraftingRecipes, playerInventory, playerJourney, playerPosition, playerProfile, playerResearchItems, repairVehicleDecay, resetJourneyNode, resetTutorial, runSql, setLandsraadPlayerContribution, tablePreview, teleportOfflinePlayerToCoords, unlockCraftingRecipe, unlockResearchItem, updateInventoryItem, updateLandsraadRewardTier, updateLandsraadTaskGoal, updateLandsraadTermTaskGoals, updateSpicefieldType, updateTableRow, UnsupportedCapabilityError } from "../src/duneDb.js";

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

test("database password change uses server-side literal quoting", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("quote_literal")) {
        assert.deepEqual(values, ["new'pass; alter role postgres superuser; --"]);
        return { rows: [{ password: "'new''pass; alter role postgres superuser; --'" }] };
      }
      return { rows: [] };
    }
  };

  const result = await changeDunePassword(db, "new'pass; alter role postgres superuser; --");
  assert.deepEqual(result, { ok: true, user: "dune" });
  assert.equal(calls[0].text, "select quote_literal($1::text) as password");
  assert.equal(calls[1].text, "alter role dune with password 'new''pass; alter role postgres superuser; --'");
});

test("detects destructive SQL and redacts connection strings", () => {
  assert.equal(isReadOnlySql("/* ok */ select * from dune.player_state"), true);
  assert.equal(isReadOnlySql("with x as (select 1) select * from x"), true);
  assert.equal(isReadOnlySql("delete from dune.items"), false);
  assert.doesNotMatch(redactDbError("postgres://dune:secret@127.0.0.1:15432/dune password=secret"), /secret/);
});

test("formats single database query results", () => {
  assert.deepEqual(rowsResult({
    fields: [{ name: "status", dataTypeID: 25 }],
    rows: [{ status: "ok" }],
    rowCount: 1,
    command: "SELECT"
  }), {
    columns: [{ name: "status", dataTypeId: 25 }],
    rows: [{ status: "ok" }],
    rowCount: 1,
    command: "SELECT"
  });
});

test("formats multi-statement database query results using the final row result", () => {
  assert.deepEqual(rowsResult([
    { fields: [], rows: [], rowCount: null, command: "BEGIN" },
    { fields: [], rows: [], rowCount: null, command: "DO" },
    {
      fields: [{ name: "status", dataTypeID: 25 }],
      rows: [{ status: "seeded" }],
      rowCount: 1,
      command: "SELECT"
    },
    { fields: [], rows: [], rowCount: null, command: "COMMIT" }
  ]), {
    columns: [{ name: "status", dataTypeId: 25 }],
    rows: [{ status: "seeded" }],
    rowCount: 1,
    command: "SELECT"
  });
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

test("manual row edit preserves Postgres arrays instead of JSON stringifying them", async () => {
  const calls = [];
  const rowId = JSON.stringify({ pk: { id: 42 } });
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) {
        return { rows: [
          { name: "id" },
          { name: "authorized_fls_ids", data_type: "ARRAY" },
          { name: "metadata", data_type: "jsonb" },
          { name: "json_array", data_type: "jsonb" }
        ] };
      }
      return { fields: [], rows: [], rowCount: 1, command: "UPDATE" };
    }
  };
  const result = await updateTableRow(db, "dune", "totems", rowId, {
    authorized_fls_ids: ["A5C0DE5E12A00001", "B5C0DE5E12A00002"],
    metadata: { name: "Totem" },
    json_array: ["kept", "as json"]
  });
  assert.equal(result.updatedRows, 1);
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  assert.deepEqual(updateCall.values, [
    ["A5C0DE5E12A00001", "B5C0DE5E12A00002"],
    JSON.stringify({ name: "Totem" }),
    JSON.stringify(["kept", "as json"]),
    42
  ]);
});

test("manual row edit accepts JSON array text for Postgres array columns", async () => {
  const calls = [];
  const rowId = JSON.stringify({ pk: { id: 72 } });
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) {
        return { rows: [
          { name: "id" },
          { name: "landclaim_original_global_location", data_type: "ARRAY" }
        ] };
      }
      return { fields: [], rows: [], rowCount: 1, command: "UPDATE" };
    }
  };
  const result = await updateTableRow(db, "dune", "totems", rowId, {
    landclaim_original_global_location: "[123.45,678.9,11]"
  });
  assert.equal(result.updatedRows, 1);
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  assert.deepEqual(updateCall.values, [[123.45, 678.9, 11], 72]);
});

test("spicefield controls list live DB rows", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      return { rows: [{ spicefield_type_id: 25, map_name: "DeepDesert", field_type: "Large", max_globally_active: 1 }] };
    }
  };
  const result = await listSpicefieldTypes(db);
  assert.equal(result.capabilities.spicefields, true);
  assert.equal(result.rows[0].field_type, "Large");
  assert.ok(calls.some((call) => String(call.text).includes("from dune.spicefield_types")));
});

test("spicefield controls update only editable tuning columns", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      return { rows: [{ spicefield_type_id: 25, map_name: "DeepDesert", field_type: "Large", max_globally_active: 2 }], rowCount: 1 };
    }
  };
  const result = await updateSpicefieldType(db, 25, {
    max_globally_active: 2,
    max_globally_primed: 3,
    is_spawning_active: false,
    global_spawn_weight: 1.5,
    current_globally_active: 999
  });
  assert.equal(result.updatedRows, 1);
  const updateCall = calls.find((call) => String(call.text).includes("update dune.spicefield_types"));
  assert.ok(updateCall);
  assert.match(updateCall.text, /max_globally_active/);
  assert.match(updateCall.text, /max_globally_primed/);
  assert.match(updateCall.text, /is_spawning_active/);
  assert.match(updateCall.text, /global_spawn_weight/);
  assert.doesNotMatch(updateCall.text, /current_globally_active\s*=/);
  assert.deepEqual(updateCall.values, [2, 3, false, 1.5, 25]);
  await assert.rejects(() => updateSpicefieldType(db, 25, { max_globally_active: -1 }), /Invalid max active/);
});

test("landsraad overview reads current term tasks and rewards", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        const columns = table === "landsraad_decree_term"
          ? ["term_id", "start_time", "end_time", "test_term", "active_decree_id", "elected_decree_id", "winning_faction_id"]
          : ["id", "term_id", "board_index", "house_name", "goal_amount", "completed", "winning_faction_id", "sysselraad"];
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (text.includes("from dune.landsraad_decree_term")) return { rows: [{ term_id: 7, active_decree: "Active", elected_decree: "Elected" }] };
      if (text.includes("from dune.landsraad_decrees")) return { rows: [{ id: 1, name: "Active", weight: 1, disabled: false }] };
      if (text.includes("from dune.landsraad_tasks t") && text.includes("group by")) {
        return { rows: [{ task_id: "42", board_index: 1, display_name: "Alexin", goal_amount: 1000, faction_progress: 250, completed: false }] };
      }
      if (text.includes("from dune.landsraad_task_rewards")) {
        return { rows: [{ task_id: "42", threshold: 500, template_id: "Reward", amount: 1 }] };
      }
      return { rows: [] };
    }
  };
  const result = await landsraadOverview(db);
  assert.equal(result.capabilities.landsraad, true);
  assert.equal(result.term.term_id, 7);
  assert.equal(result.tasks[0].task_id, "42");
  assert.equal(result.rewards[0].threshold, 500);
  assert.ok(calls.some((call) => String(call.text).includes("where t.term_id = $1") && call.values[0] === 7));
  const taskQuery = calls.find((call) => String(call.text).includes("from dune.landsraad_tasks t") && String(call.text).includes("group by"));
  assert.ok(taskQuery);
  assert.match(taskQuery.text, /order by coalesce\(t\.board_index, 0\), t\.id::text/);
});

test("landsraad goal and reward mutations validate and target explicit rows", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("update dune.landsraad_tasks") && text.includes("where id = $2")) return { rows: [{ task_id: "42", goal_amount: 7500 }], rowCount: 1 };
      if (text.includes("update dune.landsraad_tasks") && text.includes("where term_id = $2")) return { rows: [], rowCount: 4 };
      if (text.includes("update dune.landsraad_task_rewards")) return { rows: [{ task_id: "42", threshold: 2000, template_id: "Template", amount: 3 }], rowCount: 1 };
      return { rows: [] };
    }
  };
  await updateLandsraadTaskGoal(db, 42, 7500);
  await updateLandsraadTermTaskGoals(db, 7, 8000);
  await updateLandsraadRewardTier(db, { taskId: 42, threshold: 1000, newThreshold: 2000, templateId: "Template", amount: 3 });
  assert.ok(calls.some((call) => String(call.text).includes("where id = $2") && call.values.join(",") === "7500,42"));
  assert.ok(calls.some((call) => String(call.text).includes("where term_id = $2") && call.values.join(",") === "8000,7"));
  assert.ok(calls.some((call) => String(call.text).includes("threshold = $5") && call.values.join(",") === "2000,Template,3,42,1000"));
  await assert.rejects(() => updateLandsraadRewardTier(db, { taskId: 42, threshold: 1000, newThreshold: 1000, templateId: "", amount: 1 }), /Reward template id/);
});

test("landsraad player contribution recalculates faction and guild totals in one transaction", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    playerRows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }]
  });
  const result = await setLandsraadPlayerContribution(db, { playerId: 123, taskId: 42, amount: 99 });
  assert.equal(result.player.controllerId, 55);
  assert.equal(result.taskId, 42);
  assert.ok(calls.some((call) => call.text === "begin"));
  assert.ok(calls.some((call) => String(call.text).includes("delete from dune.landsraad_task_player_contributions") && call.values[0] === 55 && call.values[1] === 42));
  assert.ok(calls.some((call) => String(call.text).includes("insert into dune.landsraad_task_player_contributions") && call.values[0] === 55 && call.values[2] === 42 && call.values[3] === 99));
  assert.ok(calls.some((call) => String(call.text).includes("insert into dune.landsraad_task_faction_contributions")));
  assert.ok(calls.some((call) => String(call.text).includes("insert into dune.landsraad_task_guild_contributions")));
  assert.ok(calls.some((call) => call.text === "commit"));
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
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        const names = table === "journey_story_node"
          ? ["account_id", "story_node_id", "override_reward_block", "has_pending_reward", "complete_condition_state", "reveal_condition_state", "fail_condition_state", "metadata_state", "reset_group"]
          : table === "player_tags"
            ? ["account_id", "tag"]
            : [];
        return { rows: names.map((column_name) => ({ column_name })) };
      }
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

test("database player faction writes pledge guild admin allegiance", async () => {
  const calls = [];
  let factionSnapshot = 0;
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.player_faction") && text.includes("order by actor_id")) {
        factionSnapshot += 1;
        return { rows: [{ actor_id: "4", faction_id: factionSnapshot === 1 ? "3" : "1", utc_time_faction_change: "2026-06-19 15:00:00" }] };
      }
      if (text.includes("from dune.guild_members gm") && text.includes("join dune.guilds")) {
        return { rows: [{ guild_id: "1", guild_faction: 3 }] };
      }
      return { fields: [], rows: [], rowCount: 1, command: "UPDATE" };
    }
  };
  const result = await runSql(db, "update dune.player_faction set faction_id = 1 where actor_id = 4", true);
  assert.equal(result.rowCount, 1);
  assert.ok(calls.some((call) => String(call.text).includes("dune.change_player_faction") && call.values[0] === "4" && call.values[1] === 1));
  assert.ok(calls.some((call) => String(call.text).includes("dune.pledge_guild_allegiance") && call.values[0] === "1" && call.values[1] === "4"));
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
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        const names = table === "journey_story_node"
          ? ["account_id", "story_node_id", "override_reward_block", "has_pending_reward", "complete_condition_state", "reveal_condition_state", "fail_condition_state", "metadata_state", "reset_group"]
          : table === "player_tags"
            ? ["account_id", "tag"]
            : [];
        return { rows: names.map((column_name) => ({ column_name })) };
      }
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
      if (text.includes("information_schema.columns")) return { rows: [] };
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

test("players query filters stale actor rows when player_state has current pawn id", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: ["player_pawn_id", "last_login_time", "online_status"].map((column_name) => ({ column_name })) };
      return { rows: [{ actor_id: 78, player_pawn_id: 78, account_id: 2, character_name: "RedBlink", map: "HaggaBasin", online_status: "Online" }] };
    }
  };

  const result = await listPlayers(db, { online: true });
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors"));
  assert.ok(playerQuery);
  assert.match(playerQuery.text, /ps\.player_pawn_id = a\.id/);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].actor_id, 78);
});

test("players query filters offline transferred character placeholder actor rows", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: ["player_pawn_id", "player_controller_id", "online_status"].map((column_name) => ({ column_name })) };
      return { rows: [] };
    }
  };

  const result = await listPlayers(db, {});
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors"));
  assert.ok(playerQuery);
  assert.match(playerQuery.text, /distinct on \(dedupe_key\)/);
  assert.match(playerQuery.text, /coalesce\(nullif\(ps\.player_controller_id, 0\), nullif\(a\.owner_account_id, 0\), a\.id\) as dedupe_key/);
  assert.match(playerQuery.text, /nullif\(trim\(coalesce\(ps\.character_name, ''\)\), ''\) is null/);
  assert.match(playerQuery.text, /coalesce\(ps\.online_status::text, ''\) <> 'Online'/);
  assert.match(playerQuery.text, /when ps\.player_pawn_id = a\.id then 0/);
  assert.match(playerQuery.text, /order by dedupe_key, row_priority, online_priority, actor_id desc/);
  assert.equal(result.rows.length, 0);
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

test("list guilds returns capability response when dune.guilds is missing", async () => {
  const db = {
    query: async () => ({ rows: [{ exists: false }] })
  };
  const result = await listGuilds(db, {});
  assert.equal(result.capabilities.guilds, false);
  assert.match(result.reason, /dune\.guilds/);
});

test("list guilds returns rows with description and member count", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.guilds", "dune.guild_members"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guilds") return { rows: ["guild_id", "guild_name", "guild_faction", "guild_description"].map((column_name) => ({ column_name })) };
        if (table === "guild_members") return { rows: ["player_id", "guild_id", "role_id"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      return { rows: [
        { guild_id: "1", guild_name: "Water Sellers", guild_faction: "1", guild_faction_name: "", guild_description: "Trade guild", member_count: 4 }
      ] };
    }
  };
  const result = await listGuilds(db, {});
  assert.equal(result.capabilities.guilds, true);
  assert.equal(result.capabilities.guildMembers, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].guild_name, "Water Sellers");
  assert.equal(result.rows[0].guild_description, "Trade guild");
  assert.equal(result.rows[0].member_count, 4);
});

test("list guilds resolves faction id to a name when dune.factions has a match", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.guilds", "dune.guild_members", "dune.factions"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guilds") return { rows: ["guild_id", "guild_name", "guild_faction"].map((column_name) => ({ column_name })) };
        if (table === "guild_members") return { rows: ["player_id", "guild_id"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      return { rows: [
        { guild_id: "1", guild_name: "House Guard", guild_faction: "1", guild_faction_name: "Atreides", guild_description: "", member_count: 2 }
      ] };
    }
  };
  const result = await listGuilds(db, {});
  assert.equal(result.rows[0].guild_faction, "Atreides");
});

test("list guilds treats faction id 3 as Neutral even when dune.factions is present", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.guilds", "dune.guild_members", "dune.factions"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guilds") return { rows: ["guild_id", "guild_name", "guild_faction"].map((column_name) => ({ column_name })) };
        if (table === "guild_members") return { rows: ["player_id", "guild_id"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      return { rows: [
        { guild_id: "2", guild_name: "Unaligned Traders", guild_faction: "3", guild_faction_name: "", guild_description: "", member_count: 1 }
      ] };
    }
  };
  const result = await listGuilds(db, {});
  assert.equal(result.rows[0].guild_faction, "Neutral");
});

test("list guilds falls back to a numeric faction label when dune.factions has no matching row", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.guilds", "dune.guild_members", "dune.factions"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guilds") return { rows: ["guild_id", "guild_name", "guild_faction"].map((column_name) => ({ column_name })) };
        if (table === "guild_members") return { rows: ["player_id", "guild_id"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      return { rows: [
        { guild_id: "3", guild_name: "Unknown Alliance", guild_faction: "9", guild_faction_name: "", guild_description: "", member_count: 0 }
      ] };
    }
  };
  const result = await listGuilds(db, {});
  assert.equal(result.rows[0].guild_faction, "Faction 9");
});

test("list guilds filters by name when a search query is given", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.guilds", "dune.guild_members"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guilds") return { rows: ["guild_id", "guild_name"].map((column_name) => ({ column_name })) };
        if (table === "guild_members") return { rows: ["player_id", "guild_id"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  await listGuilds(db, { q: "Water" });
  const guildQuery = calls.find((call) => call.text.includes("from dune.guilds g"));
  assert.ok(guildQuery);
  assert.match(guildQuery.text, /ilike \$1/);
  assert.deepEqual(guildQuery.values, ["%Water%"]);
});

test("guild members returns capability response when required tables are missing", async () => {
  const db = {
    query: async () => ({ rows: [{ exists: false }] })
  };
  const result = await guildMembers(db, 1);
  assert.equal(result.capabilities.guildMembers, false);
  assert.match(result.reason, /dune\.guild_members/);
});

test("guild members returns member rows with player id, role, and character name", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.guild_members", "dune.guilds", "dune.player_state"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guild_members") return { rows: ["player_id", "guild_id", "role_id"].map((column_name) => ({ column_name })) };
        if (table === "guilds") return { rows: ["guild_id", "guild_name"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      if (text.includes("from dune.guild_members gm")) {
        return { rows: [
          { player_id: "301", role_id: "100", character_name: "Leader One" },
          { player_id: "302", role_id: "1", character_name: "Member Two" }
        ] };
      }
      return { rows: [] };
    }
  };
  const result = await guildMembers(db, 1);
  assert.equal(result.capabilities.guildMembers, true);
  assert.deepEqual(result.rows, [
    { player_id: "301", role_id: "100", character_name: "Leader One" },
    { player_id: "302", role_id: "1", character_name: "Member Two" }
  ]);
});

test("guild members joins player_controller_id, actor id, and owning account as a defensive identity fallback", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.guild_members", "dune.guilds", "dune.player_state", "dune.actors"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guild_members") return { rows: ["player_id", "guild_id", "role_id"].map((column_name) => ({ column_name })) };
        if (table === "guilds") return { rows: ["guild_id", "guild_name"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  await guildMembers(db, 1);
  const memberQuery = calls.find((call) => call.text.includes("from dune.guild_members gm"));
  assert.ok(memberQuery);
  assert.match(memberQuery.text, /left join dune\.player_state ps_by_controller on ps_by_controller\.player_controller_id = gm\."player_id"/);
  assert.match(memberQuery.text, /left join dune\.actors a_by_actor_id on a_by_actor_id\.id = gm\."player_id"/);
  assert.match(memberQuery.text, /left join dune\.player_state ps_by_account on ps_by_account\.account_id = coalesce\(a_by_actor_id\.owner_account_id, gm\."player_id"\)/);
  assert.match(memberQuery.text, /coalesce\(ps_by_controller\.character_name, ps_by_account\.character_name, ''\)/);
});

test("guild members falls back to a direct account-id join when dune.actors is unavailable", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.guild_members", "dune.guilds", "dune.player_state"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guild_members") return { rows: ["player_id", "guild_id", "role_id"].map((column_name) => ({ column_name })) };
        if (table === "guilds") return { rows: ["guild_id", "guild_name"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  await guildMembers(db, 1);
  const memberQuery = calls.find((call) => call.text.includes("from dune.guild_members gm"));
  assert.ok(memberQuery);
  assert.doesNotMatch(memberQuery.text, /dune\.actors/);
  assert.match(memberQuery.text, /left join dune\.player_state ps_by_account on ps_by_account\.account_id = coalesce\(null, gm\."player_id"\)/);
});

test("player profile includes faction and guild when addon tables are present", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.actors", "dune.player_state", "dune.accounts", "dune.player_faction", "dune.factions", "dune.guild_members", "dune.guilds"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guild_members") return { rows: ["player_id", "guild_id", "role_id"].map((column_name) => ({ column_name })) };
        if (table === "guilds") return { rows: ["guild_id", "guild_name", "guild_description"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      if (text.includes("as fls_id") && text.includes("where a.id = $1")) {
        return { rows: [{ actor_id: 101, player_pawn_id: 101, account_id: 201, character_name: "Test One", player_controller_id: 301, funcom_id: "FN1", fls_id: "user1", action_player_id: "user1", class: "Foo", map: "Survival_1", online_status: "Online" }] };
      }
      if (text.includes("from dune.player_faction pf")) {
        return { rows: [{ actor_id: "301", faction_id: "1", faction_name: "Atreides" }] };
      }
      if (text.includes("from dune.guild_members gm")) {
        return { rows: [{ player_id: "301", guild_name: "Water Sellers" }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerProfile(db, "101");
  assert.equal(result.player.faction, "Atreides");
  assert.equal(result.player.guild, "Water Sellers");
});

test("player profile falls back to placeholder faction/guild when addon tables are absent", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.actors", "dune.player_state", "dune.accounts"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) return { rows: [] };
      if (text.includes("as fls_id") && text.includes("where a.id = $1")) {
        return { rows: [{ actor_id: 101, player_pawn_id: 101, account_id: 201, character_name: "Test One", player_controller_id: 301, funcom_id: "FN1", fls_id: "user1", action_player_id: "user1", class: "Foo", map: "Survival_1", online_status: "Online" }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerProfile(db, "101");
  assert.equal(result.player.faction, "Unassigned");
  assert.equal(result.player.guild, "Unavailable");
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

test("player position exposes numeric coordinates for Use Current Position", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      return { rows: [{ actor_id: 123, map: "Survival_1", x: "101.5", y: "202.25", z: "303.75", yaw: "0", location: "(101.5,202.25,303.75)", rotation: "(0,0,0)" }] };
    }
  };
  const result = await playerPosition(db, 123);
  assert.equal(result.capabilities.position, true);
  assert.deepEqual(result.position, { actor_id: 123, map: "Survival_1", x: "101.5", y: "202.25", z: "303.75", yaw: "0", location: "(101.5,202.25,303.75)", rotation: "(0,0,0)" });
  assert.match(calls[0].text, /\(\(transform\)\.location\)\.x as x/);
  assert.match(calls[0].text, /where id = \$1 and transform is not null/);
  assert.deepEqual(calls[0].values, [123]);
});

test("live map services returns capability response when world partitions are missing", async () => {
  const db = {
    query: async () => ({ rows: [{ exists: false }] })
  };
  const result = await liveMapServices(db);
  assert.equal(result.capabilities.services, false);
  assert.match(result.reason, /dune\.world_partition/);
});

test("player inventory selects DecayedMaxDurability as a max_durability fallback and hides a stored zero", async () => {
  const calls = [];
  const db = fakeMutationDb(calls);
  await playerInventory(db, 123);
  const select = calls.find((call) => call.text.includes("order by i.template_id"));
  assert.ok(select);
  assert.match(select.text, /nullif\(\(i\.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability'\)::numeric, 0\)/);
  assert.match(select.text, /nullif\(\(i\.stats->'FItemStackAndDurabilityStats'->1->>'DecayedMaxDurability'\)::numeric, 0\)/);
});

test("player inventory enriches rows with catalog category and source for augment eligibility", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.items i")) return { rows: [{
        id: 501,
        template_id: "SmugDmr5",
        stack_size: 1,
        quality_level: 5,
        position_index: 0,
        inventory_id: 7,
        current_durability: "100",
        max_durability: "100",
        stats: {}
      }] };
      return { rows: [] };
    }
  };
  const result = await playerInventory(db, 123);
  assert.equal(result.rows[0].template_id, "SmugDmr5");
  assert.equal(result.rows[0].category, "weapons");
  assert.equal(result.rows[0].source, "Weapons");
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

test("inventory update rejects rows not owned by the selected player", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { itemRows: [] });
  await assert.rejects(() => updateInventoryItem(db, 123, 99, { quality_level: "5" }), /selected player's directly-owned inventory/);
  assert.equal(calls.some((call) => String(call.text).startsWith("update dune.items")), false);
});

test("inventory update verifies ownership then applies the validated column changes", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 99 }] };
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) return { rows: [{ name: "id" }, { name: "quality_level" }] };
      return { rows: [], rowCount: 1 };
    },
    transaction: async (fn) => fn(db)
  };
  const result = await updateInventoryItem(db, 123, 99, { quality_level: "5" });
  assert.equal(result.updatedRows, 1);
  assert.ok(calls.some((call) => call.text.includes("where i.id = $1 and inv.actor_id = $2") && call.values[0] === 99 && call.values[1] === 123));
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  assert.match(updateCall.text, /"dune"\."items"/);
});

test("inventory update strips template_id even if explicitly submitted", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 99, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] } }] };
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) return { rows: [{ name: "id" }, { name: "template_id" }, { name: "quality_level" }] };
      return { rows: [], rowCount: 1 };
    },
    transaction: async (fn) => fn(db)
  };
  await updateInventoryItem(db, 123, 99, { template_id: "Hacked_Item", quality_level: "5" });
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  assert.doesNotMatch(updateCall.text, /"template_id"/);
});

test("inventory update whitelists editable columns and rejects id, inventory_id, template_id, and raw stats", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 99, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] } }] };
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) return { rows: [{ name: "id" }, { name: "inventory_id" }, { name: "template_id" }, { name: "stats" }, { name: "quality_level" }] };
      return { rows: [], rowCount: 1 };
    },
    transaction: async (fn) => fn(db)
  };
  await updateInventoryItem(db, 123, 99, { id: 99, inventory_id: 7, template_id: "Hacked_Item", stats: { FCustomizationStats: [[], { color: "hacked" }] }, quality_level: "5" });
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  const setClause = updateCall.text.split(" where ")[0];
  assert.match(setClause, /"quality_level"/);
  assert.doesNotMatch(setClause, /"id"\s*=/);
  assert.doesNotMatch(setClause, /"inventory_id"/);
  assert.doesNotMatch(setClause, /"template_id"/);
  assert.doesNotMatch(setClause, /"stats"/);
});

test("inventory update rejects max_durability outside the 0-100 range", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemRows: [{ id: 99, template_id: "WaterBottle_1", stack_size: 1, quality_level: 0, position_index: 0, inventory_id: 7, actor_id: 123, stats: { FItemStackAndDurabilityStats: [[], { CurrentDurability: 50, DecayedMaxDurability: 80 }] } }]
  });
  await assert.rejects(() => updateInventoryItem(db, 123, 99, { max_durability: "150" }), /Invalid max durability/);
  assert.equal(calls.some((call) => String(call.text).startsWith("update dune.items")), false);
});

test("inventory update rejects current_durability greater than max_durability", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemRows: [{ id: 99, template_id: "WaterBottle_1", stack_size: 1, quality_level: 0, position_index: 0, inventory_id: 7, actor_id: 123, stats: { FItemStackAndDurabilityStats: [[], { CurrentDurability: 50, DecayedMaxDurability: 80 }] } }]
  });
  await assert.rejects(() => updateInventoryItem(db, 123, 99, { current_durability: "95", max_durability: "80" }), /Invalid current durability/);
  assert.equal(calls.some((call) => String(call.text).startsWith("update dune.items")), false);
});

test("inventory update merges durability into the existing DecayedMaxDurability key", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 99, stats: { FCustomizationStats: [[], { color: "sand" }], FItemStackAndDurabilityStats: [[], { CurrentDurability: 50, DecayedMaxDurability: 80 }] } }] };
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) return { rows: [{ name: "id" }, { name: "stats", data_type: "jsonb" }] };
      return { rows: [], rowCount: 1 };
    },
    transaction: async (fn) => fn(db)
  };
  const result = await updateInventoryItem(db, 123, 99, { current_durability: "60", max_durability: "90" });
  assert.equal(result.updatedRows, 1);
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  const statsValue = JSON.parse(updateCall.values[0]);
  assert.deepEqual(statsValue.FCustomizationStats, [[], { color: "sand" }]);
  assert.deepEqual(statsValue.FItemStackAndDurabilityStats[1], { CurrentDurability: 60, DecayedMaxDurability: 90 });
});

test("inventory update treats explicit null durability values as not provided", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 99, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] } }] };
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) return { rows: [{ name: "id" }, { name: "quality_level" }] };
      return { rows: [], rowCount: 1 };
    },
    transaction: async (fn) => fn(db)
  };
  const result = await updateInventoryItem(db, 123, 99, { current_durability: null, max_durability: null, quality_level: "3" });
  assert.equal(result.updatedRows, 1);
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  assert.doesNotMatch(updateCall.text, /"stats"/);
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
  const stats = JSON.parse(insert.values[5]);
  assert.deepEqual(stats.FCustomizationStats, [[], {}]);
  assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 100);
  assert.equal(stats.FItemStackAndDurabilityStats[1].MaxDurability, 100);
});

test("player give-item bumps standalone augment grade zero to grade one", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 501, template_id: "T6_Augment_Melee4", stack_size: 1, quality_level: 1, position_index: 2, inventory_id: 7 }]
  });
  await giveItemToPlayer(db, 123, { templateId: "T6_Augment_Melee4", quantity: 1, quality: 0 });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 5), [7, "T6_Augment_Melee4", 1, 1, 2]);
});

test("player give-item keeps normal weapon grade zero", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 501, template_id: "SMG_Unique_LargeMag_06", stack_size: 1, quality_level: 0, position_index: 2, inventory_id: 7 }]
  });
  await giveItemToPlayer(db, 123, { templateId: "SMG_Unique_LargeMag_06", quantity: 1, quality: 0 });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 5), [7, "SMG_Unique_LargeMag_06", 1, 0, 2]);
});

test("player give-item with augments populates FAugmentedItemStats", async () => {
  const calls = [];
  const augmentRollRows = [
    { template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } },
    { template_id: "T6_Augment_Melee4", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }
  ];
  const db = fakeMutationDb(calls, {
    augmentRollRows,
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 502, template_id: "UniqueSword_05", stack_size: 1, quality_level: 0, position_index: 3, inventory_id: 7 }]
  });
  const result = await giveItemToPlayer(db, 123, { templateId: "UniqueSword_05", quantity: 1, quality: 0, augments: ["T6_Augment_Melee1", "T6_Augment_Melee4"] });
  assert.deepEqual(result.augments, ["T6_Augment_Melee1", "T6_Augment_Melee4"]);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const stats = JSON.parse(insert.values[5]);
  assert.deepEqual(stats.FCustomizationStats, [[], {}]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugments, [{ Name: "T6_Augment_Melee1" }, { Name: "T6_Augment_Melee4" }]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentQualities, [1, 1]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1], AppliedEffectIndices: [] }, { StatRolls: [1], AppliedEffectIndices: [] }]);
});

test("player give-item with augments writes normal acquisition metadata when supported", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [{ template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }],
    itemColumns: ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats", "is_new", "acquisition_time"],
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 502, template_id: "UniqueSword_05", stack_size: 1, quality_level: 0, position_index: 3, inventory_id: 7 }]
  });
  await giveItemToPlayer(db, 123, { templateId: "UniqueSword_05", quantity: 1, quality: 0, augments: ["T6_Augment_Melee1"] });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  assert.match(insert.text, /is_new/);
  assert.match(insert.text, /acquisition_time/);
  assert.equal(insert.values[6], false);
  assert.ok(Number(insert.values[7]) > 0);
});

test("player give-item with grade zero augments requires offline", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    playerRows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Online" }],
    augmentRollRows: [{ template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }],
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }]
  });
  await assert.rejects(
    () => giveItemToPlayer(db, 123, { templateId: "UniqueSword_05", quantity: 1, quality: 0, augments: ["T6_Augment_Melee1"] }),
    /Pre-augmented item grants require the player to be offline/
  );
  assert.equal(calls.some((call) => call.text.includes("insert into dune.items")), false);
});

test("player give-item with grade zero item and higher augment grade requires offline", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    playerRows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Online" }],
    augmentRollRows: [{ template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }],
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }]
  });
  await assert.rejects(
    () => giveItemToPlayer(db, 123, { templateId: "UniqueSword_05", quantity: 1, quality: 0, augments: ["T6_Augment_Melee1"], augmentQuality: 2 }),
    /Pre-augmented item grants require the player to be offline/
  );
  assert.equal(calls.some((call) => call.text.includes("insert into dune.items")), false);
});

test("player give-item writes selected augment grade into applied augment qualities", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [{ template_id: "T6_Augment_Melee1", quality_level: 1, stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }],
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 502, template_id: "UniqueSword_05", stack_size: 1, quality_level: 0, position_index: 3, inventory_id: 7 }]
  });
  await giveItemToPlayer(db, 123, { templateId: "UniqueSword_05", quantity: 1, quality: 0, augments: ["T6_Augment_Melee1"], augmentQuality: 4 });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const stats = JSON.parse(insert.values[5]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentQualities, [4]);
});

test("player give-item generates perfect augment roll when no rolled source row exists", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [],
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 505, template_id: "UniqueScattergun5", stack_size: 1, quality_level: 5, position_index: 4, inventory_id: 7 }]
  });
  await giveItemToPlayer(db, 123, { templateId: "UniqueScattergun5", quantity: 1, quality: 5, augments: ["T6_Augment_Scattergun5"] });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const stats = JSON.parse(insert.values[5]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1, 1, 1], AppliedEffectIndices: [] }]);
});

test("player give-item uses real augment roll length before catalog fallback", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [{ template_id: "T6_Augment_Scattergun5", stats: { FAugmentItemStats: [[], { StatRolls: [0.25], AppliedEffectIndices: [] }] } }],
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 505, template_id: "UniqueScattergun5", stack_size: 1, quality_level: 5, position_index: 4, inventory_id: 7 }]
  });
  await giveItemToPlayer(db, 123, { templateId: "UniqueScattergun5", quantity: 1, quality: 5, augments: ["T6_Augment_Scattergun5"] });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const stats = JSON.parse(insert.values[5]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1], AppliedEffectIndices: [] }]);
});

test("player give-item can source augment roll data from existing augmented gear", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [],
    augmentedItemRows: [{
      stats: {
        FAugmentedItemStats: [[], {
          AppliedAugments: [{ Name: "T6_Augment_ReloadSpeed1" }],
          AppliedAugmentQualities: [1],
          AppliedAugmentRollData: [{ StatRolls: [0.0], AppliedEffectIndices: [] }]
        }]
      }
    }],
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 506, template_id: "UniqueScattergun5", stack_size: 1, quality_level: 0, position_index: 4, inventory_id: 7 }]
  });
  await giveItemToPlayer(db, 123, { templateId: "UniqueScattergun5", quantity: 1, quality: 0, augments: ["T6_Augment_ReloadSpeed1"] });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const stats = JSON.parse(insert.values[5]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1], AppliedEffectIndices: [] }]);
});

test("player give-item with augments forces DB path with durability on grade 0 items", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [{ template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }],
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 503, template_id: "UniqueSword_05", stack_size: 1, quality_level: 0, position_index: 4, inventory_id: 7 }]
  });
  const result = await giveItemToPlayer(db, 123, { templateId: "UniqueSword_05", quantity: 1, quality: 0, augments: ["T6_Augment_Melee1"] });
  assert.equal(result.inserted.quality_level, 0);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const stats = JSON.parse(insert.values[5]);
  assert.ok(stats.FItemStackAndDurabilityStats[1].CurrentDurability > 0);
});

test("live grant augment patch excludes existing item IDs instead of relying on monotonic item IDs", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [{ template_id: "T6_Augment_Acuracy1", quality_level: 1, stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }],
    newItemRows: [{ id: 27082752, stats: {}, template_id: "SMG_Unique_LargeMag_06" }]
  });
  const result = await augmentNewestPlayerItem(db, 123, "SMG_Unique_LargeMag_06", {
    existingItemIds: [27339050],
    augments: ["T6_Augment_Acuracy1"],
    augmentQuality: 1
  });
  assert.equal(result.itemId, 27082752);
  const select = calls.find((call) => call.text.includes("not (i.id = any($3::bigint[]))"));
  assert.ok(select);
  assert.deepEqual(select.values.slice(0, 3), [123, "SMG_Unique_LargeMag_06", [27339050]]);
  const update = calls.find((call) => call.text.includes("update dune.items set stats"));
  assert.ok(update);
  assert.equal(update.values.at(-1), 27082752);
  const stats = JSON.parse(update.values[0]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugments, [{ Name: "T6_Augment_Acuracy1" }]);
});

test("storage give-item with augments populates FAugmentedItemStats", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [{ template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }],
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 504, template_id: "UniqueSword_05", stack_size: 1, quality_level: 0, position_index: 5, inventory_id: 7 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "UniqueSword_05", quantity: 1, quality: 0, augments: ["T6_Augment_Melee1"] });
  assert.deepEqual(result.augments, ["T6_Augment_Melee1"]);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const stats = JSON.parse(insert.values[5]);
  assert.deepEqual(stats.FCustomizationStats, [[], {}]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugments, [{ Name: "T6_Augment_Melee1" }]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentQualities, [1]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1], AppliedEffectIndices: [] }]);
  assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 100);
});

test("augment inventory item applies augment IDs to existing item FAugmentedItemStats", async () => {
  const calls = [];
  const existingStats = { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], { CurrentDurability: 80 }] };
  const db = fakeMutationDb(calls, {
    augmentRollRows: [
      { template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } },
      { template_id: "T6_Augment_Melee4", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }
    ],
    itemRows: [{ id: 501, stats: existingStats, template_id: "UniqueSword_05" }]
  });
  const result = await augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Melee1", "T6_Augment_Melee4"] });
  assert.deepEqual(result.augments, ["T6_Augment_Melee1", "T6_Augment_Melee4"]);
  const update = calls.find((call) => call.text.includes("update dune.items set stats"));
  assert.ok(update);
  const stats = JSON.parse(update.values[0]);
  assert.deepEqual(stats.FCustomizationStats, [[], {}]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugments, [{ Name: "T6_Augment_Melee1" }, { Name: "T6_Augment_Melee4" }]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentQualities, [1, 1]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1], AppliedEffectIndices: [] }, { StatRolls: [1], AppliedEffectIndices: [] }]);
  assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 80);
});

test("augment inventory item applies selected augment grade", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [
      { template_id: "T6_Augment_Melee1", quality_level: 1, stats: { FAugmentItemStats: [[], { StatRolls: [0.4], AppliedEffectIndices: [] }] } }
    ],
    itemRows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] }, template_id: "UniqueSword_05" }]
  });
  const result = await augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Melee1"], augmentQuality: 5 });
  assert.equal(result.augmentQuality, 5);
  const update = calls.find((call) => call.text.includes("update dune.items set stats"));
  assert.ok(update);
  const stats = JSON.parse(update.values[0]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentQualities, [5]);
});

test("augment inventory item normalizes generated item metadata when supported", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [{ template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }],
    itemColumns: ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats", "is_new", "acquisition_time"],
    itemRows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] }, template_id: "UniqueSword_05", is_new: true, acquisition_time: 0 }]
  });
  await augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Melee1"] });
  const update = calls.find((call) => call.text.includes("update dune.items set stats"));
  assert.ok(update);
  assert.match(update.text, /is_new =/);
  assert.match(update.text, /acquisition_time =/);
  assert.equal(update.values[1], false);
  assert.ok(Number(update.values[2]) > 0);
});

test("augment inventory item repairs empty ranged weapon stats while applying augments", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [
      { template_id: "T6_Augment_Acuracy1", stats: { FAugmentItemStats: [[], { StatRolls: [0.2], AppliedEffectIndices: [] }] } },
      { template_id: "T6_Augment_Damage1", stats: { FAugmentItemStats: [[], { StatRolls: [0.3], AppliedEffectIndices: [] }] } },
      { template_id: "T6_Augment_DeathDurabilityOff", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }
    ],
    itemRows: [{
      id: 501,
      stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] },
      template_id: "UniqueScattergun5"
    }]
  });
  await augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Acuracy1", "T6_Augment_Damage1", "T6_Augment_DeathDurabilityOff"] });
  const update = calls.find((call) => call.text.includes("update dune.items set stats"));
  assert.ok(update);
  const stats = JSON.parse(update.values[0]);
  assert.deepEqual(stats.FWeaponItemStats, [[], { CurrentAmmo: 0 }]);
  assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 100);
  assert.equal(stats.FItemStackAndDurabilityStats[1].MaxDurability, 100);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugments, [
    { Name: "T6_Augment_Acuracy1" },
    { Name: "T6_Augment_Damage1" },
    { Name: "T6_Augment_DeathDurabilityOff" }
  ]);
});

test("augment inventory item replaces existing augments", async () => {
  const calls = [];
  const existingStats = { FCustomizationStats: [[], {}], FAugmentedItemStats: [[], { AppliedAugments: ["T6_Augment_Damage1"], AppliedAugmentQualities: [1], AppliedAugmentRollData: [{ StatRolls: [] }] }], FItemStackAndDurabilityStats: [[], {}] };
  const db = fakeMutationDb(calls, {
    augmentRollRows: [
      { template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } },
      { template_id: "T6_Augment_Melee4", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }
    ],
    itemRows: [{ id: 501, stats: existingStats, template_id: "UniqueSword_05" }]
  });
  const result = await augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Melee1", "T6_Augment_Melee4"] });
  assert.deepEqual(result.previous, ["T6_Augment_Damage1"]);
  assert.deepEqual(result.augments, ["T6_Augment_Melee1", "T6_Augment_Melee4"]);
});

test("augment inventory item rejects augments that do not match the item family", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemRows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] }, template_id: "UniqueScattergun5" }]
  });
  await assert.rejects(
    () => augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Armor6"] }),
    /Select augment\(s\) that match this weapon/
  );
});

test("augment inventory item allows Method-compatible light shotgun augments", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [
      { template_id: "T6_Augment_Scattergun5", stats: { FAugmentItemStats: [[], { StatRolls: [0.25], AppliedEffectIndices: [] }] } },
      { template_id: "T6_Augment_Damage1", stats: { FAugmentItemStats: [[], { StatRolls: [0.13], AppliedEffectIndices: [] }] } }
    ],
    itemRows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] }, template_id: "UniqueScattergun5" }]
  });
  const result = await augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Scattergun5", "T6_Augment_Damage1"] });
  assert.deepEqual(result.augments, ["T6_Augment_Scattergun5", "T6_Augment_Damage1"]);
});

test("augment inventory item enforces Method weapon subfamilies", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemRows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] }, template_id: "SmugDmr5" }]
  });
  await assert.rejects(
    () => augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Scattergun5"] }),
    /Select augment\(s\) that match this weapon/
  );
});

test("augment inventory item rejects unsupported JABAL Spitdart items", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemRows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] }, template_id: "SmugDmr5" }]
  });
  await assert.rejects(
    () => augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_SpitdartRifle5", "T6_Augment_Damage1"] }),
    /Select augment\(s\) that match this weapon/
  );
});

test("augment inventory item allows catalog-compatible Spitdart augments", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [
      { template_id: "T6_Augment_SpitdartRifle5", stats: { FAugmentItemStats: [[], { StatRolls: [0.33], AppliedEffectIndices: [] }] } },
      { template_id: "T6_Augment_Damage1", stats: { FAugmentItemStats: [[], { StatRolls: [0.13], AppliedEffectIndices: [] }] } }
    ],
    itemRows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] }, template_id: "B1C4_Unique_SmugDmr1" }]
  });
  const result = await augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_SpitdartRifle5", "T6_Augment_Damage1"] });
  assert.deepEqual(result.augments, ["T6_Augment_SpitdartRifle5", "T6_Augment_Damage1"]);
});

test("augment inventory item allows clothing augments but rejects weapon augments on clothing", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [
      { template_id: "T6_Augment_Armor6", stats: { FAugmentItemStats: [[], { StatRolls: [0.06], AppliedEffectIndices: [] }] } }
    ],
    itemRows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], {}] }, template_id: "Combat_Hark_MedUnique02_Gloves" }]
  });
  const result = await augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Armor6"] });
  assert.deepEqual(result.augments, ["T6_Augment_Armor6"]);
  await assert.rejects(
    () => augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Damage1"] }),
    /Select augment\(s\) that match this clothing/
  );
});

test("augment inventory item deduplicates augment IDs", async () => {
  const calls = [];
  const existingStats = { FCustomizationStats: [[], {}], FAugmentedItemStats: [[], { AppliedAugments: ["T6_Augment_Melee1"], AppliedAugmentQualities: [1], AppliedAugmentRollData: [{ StatRolls: [] }] }], FItemStackAndDurabilityStats: [[], {}] };
  const db = fakeMutationDb(calls, {
    augmentRollRows: [
      { template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } },
      { template_id: "T6_Augment_Melee4", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }
    ],
    itemRows: [{ id: 501, stats: existingStats, template_id: "UniqueSword_05" }]
  });
  const result = await augmentInventoryItem(db, 123, 501, { augments: ["T6_Augment_Melee1", "T6_Augment_Melee4", "T6_Augment_Melee1"] });
  assert.deepEqual(result.augments, ["T6_Augment_Melee1", "T6_Augment_Melee4"]);
});

test("augment inventory item requires valid augment IDs", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemRows: [{ id: 501, stats: { FCustomizationStats: [[], {}] }, template_id: "UniqueSword_05" }]
  });
  await assert.rejects(() => augmentInventoryItem(db, 123, 501, { augments: [] }), /At least one augment ID is required/);
  await assert.rejects(() => augmentInventoryItem(db, 123, 501, { augments: ["bad;id"] }), /Invalid item template/);
});

test("vehicle decay repair is scoped to the selected player's owned vehicles", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    vehicleModuleScanRows: [{ scanned: 3, vehicles: 2 }],
    repairedVehicleModuleRows: [{ id: 10, vehicle_id: 900 }, { id: 11, vehicle_id: 900 }, { id: 12, vehicle_id: 901 }]
  });
  const result = await repairVehicleDecay(db, 123, { thresholdPercent: 50 });
  assert.equal(result.scanned, 3);
  assert.equal(result.vehicles, 2);
  assert.equal(result.repaired, 3);
  assert.equal(result.repairedVehicles, 2);
  const update = calls.find((call) => call.text.includes("update dune.vehicle_modules vm"));
  assert.ok(update);
  assert.match(update.text, /join dune\.actors a on a\.id = vm\.vehicle_id/);
  assert.match(update.text, /a\.owner_account_id = \$1/);
  assert.match(update.text, /DecayedMaxDurability/);
  assert.match(update.text, /CurrentDurability/);
  assert.deepEqual(update.values, [44, 0.5]);
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

test("crafting recipe listing uses catalog schematics and player unlock status", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    craftingListRows: [
      { recipe_id: "HealthPackRecipe" }
    ]
  });
  const result = await playerCraftingRecipes(db, 123);
  assert.ok(result.rows.length > 500);
  const healthPack = result.rows.find((row) => row.recipeId === "HealthPackRecipe");
  const buggyBoost = result.rows.find((row) => row.recipeId === "UniqueBuggyBoostRecipe");
  assert.equal(healthPack.displayName, "Healkit");
  assert.equal(healthPack.unlocked, true);
  assert.equal(buggyBoost.category, "Vehicles");
  assert.equal(buggyBoost.unlocked, false);
  assert.ok(calls.some((call) => call.text.includes("CraftingRecipesLibraryActorComponent") && call.text.includes("player_recipes")));
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
    currentCraftingRecipes: []
  });
  const result = await unlockResearchItem(db, 123, { itemKey: "BLD_WaterCistern_Patent" });
  assert.equal(result.recipeId, "WaterCistern_Patent");
  assert.equal(result.recipeMaterialized, true);
  const researchUpdate = calls.find((call) => call.text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && call.text.includes("update dune.actors"));
  assert.ok(researchUpdate);
  const items = JSON.parse(researchUpdate.values[1]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], { ItemKey: "BLD_WaterCistern_Patent", bIsNewEntry: false, UnlockedState: "Purchased" });
  const recipeUpdate = calls.find((call) => call.text.includes("CraftingRecipesLibraryActorComponent,m_KnownItemRecipes") && call.text.includes("update dune.actors"));
  assert.ok(recipeUpdate);
  assert.equal(JSON.parse(recipeUpdate.values[1])[0].BaseRecipeId.Name, "WaterCistern_Patent");
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
  const result = await playerJourney(db, 123, {
    journey_aliases: {
      "DA_Story.Root": "Official Journey Name",
      "DA_Story.Root.CatalogOnly": "Catalog-only Objective"
    },
    journey_node_tags: { "DA_Story.Root": ["Story.Tag"], "DA_Story.Root.Child": ["Story.Child"], "DA_CT_Arrakeen.Contract": ["Contract.Tag"] }
  });
  assert.equal(result.rows.story.length, 3);
  assert.equal(result.rows.story[0].name, "Official Journey Name");
  assert.equal(result.rows.story[0].rawName, "DA_Story.Root");
  assert.equal(result.rows.story.find((row) => row.rawName === "DA_Story.Root.CatalogOnly").name, "Catalog-only Objective");
  assert.ok(result.rows.story.slice(1).every((row) => row.parentId === "DA_Story.Root"));
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

test("journey listing includes story nodes discovered from the database", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    discoveredJourneyRows: [{ story_node_id: "DA_MQ_FindTheFremen.SixthTest.SixthQuestion.CompleteSixthTest" }]
  });
  const result = await playerJourney(db, 123, { journey_node_tags: {} });
  assert.equal(result.rows.story.length, 1);
  assert.equal(result.rows.story[0].rawName, "DA_MQ_FindTheFremen.SixthTest.SixthQuestion.CompleteSixthTest");
});

test("journey listing supports current character_id schema", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    journeyIdentityColumn: "character_id",
    journeyStateRows: [
      { story_node_id: "DA_Story.Root", is_complete: true, is_revealed: true, has_pending_reward: false }
    ]
  });
  const result = await playerJourney(db, 123, { journey_node_tags: { "DA_Story.Root": ["Story.Tag"] } });
  assert.equal(result.rows.story[0].status, "Complete");
  assert.ok(calls.some((call) => call.text.includes('where "character_id" = $1') && call.values[0] === 5));
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
  assert.equal(result.updatedRows, 3);
  assert.equal(result.tagsApplied, 3);
  assert.ok(calls.some((call) => call.text.includes("story_node_id = any($2::text[])") && call.values[2] === "DA_Story.Root"));
  assert.ok(calls.some((call) => call.text.includes("insert into dune.player_tags") && call.values[0] === 44 && call.values[1].includes("Child.Tag")));
  assert.ok(!calls.some((call) => call.text.includes("dune.update_player_tags")));
  assert.ok(calls.some((call) => call.text.includes("set_player_faction_reputation") && call.values[2] === 100));
});

test("journey complete materializes parent path for leaf quest steps", async () => {
  const calls = [];
  const db = fakeMutationDb(calls);
  const result = await completeJourneyNode(db, 123, { nodeId: "DA_MQ_FindTheFremen.FifthTest.FifthQuestion.CompleteFifthTest" }, { journey_node_tags: {} });
  assert.equal(result.updatedRows, 1);
  const insert = calls.find((call) => call.text.includes("with wanted(story_node_id)"));
  assert.ok(insert);
  assert.deepEqual(insert.values[1], [
    "DA_MQ_FindTheFremen.FifthTest",
    "DA_MQ_FindTheFremen.FifthTest.FifthQuestion",
    "DA_MQ_FindTheFremen.FifthTest.FifthQuestion.CompleteFifthTest"
  ]);
});

test("journey reset clears subtree completion and removes tags", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { journeyUpdateRows: 1 });
  const result = await resetJourneyNode(db, 123, { nodeId: "DA_Story.Root" }, { journey_node_tags: { "DA_Story.Root": ["Story.Tag"], "DA_Story.Root.Child": ["Child.Tag"] } });
  assert.equal(result.updatedRows, 1);
  assert.equal(result.tagsRemoved, 2);
  assert.ok(calls.some((call) => call.text.includes("complete_condition_state = 'false'::jsonb")));
  assert.ok(calls.some((call) => call.text.includes("delete from dune.player_tags") && call.values[0] === 44 && call.values[1].includes("Child.Tag")));
  assert.ok(!calls.some((call) => call.text.includes("dune.update_player_tags")));
});

test("journey complete writes tags through current character_id schema", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { journeyIdentityColumn: "character_id", journeyUpdateRows: 1 });
  const result = await completeJourneyNode(db, 123, { nodeId: "DA_Story.Root" }, {
    journey_node_tags: { "DA_Story.Root": ["Story.Tag"] }
  });
  assert.equal(result.tagsApplied, 1);
  assert.ok(calls.some((call) => call.text.includes("insert into dune.player_tags") && call.text.includes('"character_id"') && call.values[0] === 5 && call.values[1].includes("Story.Tag")));
  assert.ok(!calls.some((call) => call.text.includes("dune.update_player_tags")));
});

test("contract complete writes player tags directly", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { reputationRows: [{ reputation_amount: 0 }] });
  const result = await completeJourneyNode(db, 123, { nodeId: "DA_CT_Trainer_Trooper1_01" }, {
    contract_tags: { DA_CT_Trainer_Trooper1_01: ["Contract.Trainer.Trooper1.Completed"] }
  });
  assert.equal(result.contract, true);
  assert.equal(result.tagsApplied, 1);
  assert.ok(calls.some((call) => call.text.includes("insert into dune.player_tags") && call.values[0] === 44 && call.values[1].includes("Contract.Trainer.Trooper1.Completed")));
  assert.ok(!calls.some((call) => call.text.includes("dune.update_player_tags")));
});

test("contract reset removes player tags directly", async () => {
  const calls = [];
  const db = fakeMutationDb(calls);
  const result = await resetJourneyNode(db, 123, { nodeId: "DA_CT_Trainer_Trooper1_01" }, {
    contract_tags: { DA_CT_Trainer_Trooper1_01: ["Contract.Trainer.Trooper1.Completed"] }
  });
  assert.equal(result.contract, true);
  assert.equal(result.tagsRemoved, 1);
  assert.ok(calls.some((call) => call.text.includes("delete from dune.player_tags") && call.values[0] === 44 && call.values[1].includes("Contract.Trainer.Trooper1.Completed")));
  assert.ok(!calls.some((call) => call.text.includes("dune.update_player_tags")));
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


test("OPS health players returns aggregate counts only", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        return { rows: ["online_status", "life_state", "character_state"].map((column_name) => ({ column_name })) };
      }
      if (text.includes("from dune.player_state") && text.includes("group by 1, 2, 3")) {
        return { rows: [
          { online_status: "Online", life_state: "Alive", character_state: "Active", players: 2 },
          { online_status: "Offline", life_state: "Alive", character_state: "Active", players: 1 }
        ] };
      }
      return { rows: [] };
    }
  };

  const result = await addonOpsHealthPlayers(db);
  assert.deepEqual(result, {
    total: 3,
    onlineStatus: { Online: 2, Offline: 1 },
    lifeState: { Alive: 3 },
    characterState: { Active: 3 },
    combinations: [
      { onlineStatus: "Online", lifeState: "Alive", characterState: "Active", players: 2 },
      { onlineStatus: "Offline", lifeState: "Alive", characterState: "Active", players: 1 }
    ]
  });
  assert.equal(Object.hasOwn(result, "rows"), false);
  assert.ok(calls.some((call) => String(call.text).includes("count(*)::int as players")));
});

test("OPS health players falls back to empty aggregate shape when source is missing", async () => {
  const db = {
    query: async () => ({ rows: [{ exists: false }] })
  };

  assert.deepEqual(await addonOpsHealthPlayers(db), {
    total: 0,
    onlineStatus: {},
    lifeState: {},
    characterState: {},
    combinations: []
  });
});

test("OPS health farms returns aggregate counters only", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        return { rows: [
          "ready",
          "alive",
          "connected_players",
          "incoming_s2s_connections",
          "outgoing_s2s_connections"
        ].map((column_name) => ({ column_name })) };
      }
      if (text.includes("from dune.farm_state")) {
        return { rows: [{
          total: 2,
          ready: 2,
          alive: 1,
          connected_players: 7,
          incoming_s2s_connections: 3,
          outgoing_s2s_connections: 4
        }] };
      }
      return { rows: [] };
    }
  };

  assert.deepEqual(await addonOpsHealthFarms(db), {
    total: 2,
    ready: 2,
    alive: 1,
    connectedPlayers: 7,
    incomingS2SConnections: 3,
    outgoingS2SConnections: 4
  });
  assert.ok(calls.some((call) => String(call.text).includes("count(*)::int as total")));
});

test("OPS health farms falls back to empty aggregate shape when source is missing", async () => {
  const db = {
    query: async () => ({ rows: [{ exists: false }] })
  };

  assert.deepEqual(await addonOpsHealthFarms(db), {
    total: 0,
    ready: 0,
    alive: 0,
    connectedPlayers: 0,
    incomingS2SConnections: 0,
    outgoingS2SConnections: 0
  });
});

test("OPS health summary compatibility action matches summary v2 shape", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        const columns = table === "player_state"
          ? ["online_status", "life_state", "character_state"]
          : ["ready", "alive", "connected_players", "incoming_s2s_connections", "outgoing_s2s_connections"];
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (text.includes("from dune.player_state")) {
        return { rows: [{ online_status: "Online", life_state: "Alive", character_state: "Active", players: 1 }] };
      }
      if (text.includes("from dune.farm_state")) {
        return { rows: [{ total: 1, ready: 1, alive: 1, connected_players: 1, incoming_s2s_connections: 1, outgoing_s2s_connections: 1 }] };
      }
      return { rows: [] };
    }
  };

  assert.deepEqual(await addonOpsHealthSummary(db), await addonOpsHealthSummaryV2(db));
});

test("OPS health summary v2 combines player and farm aggregate health", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        const columns = table === "player_state"
          ? ["online_status", "life_state", "character_state"]
          : ["ready", "alive", "connected_players", "incoming_s2s_connections", "outgoing_s2s_connections"];
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (text.includes("from dune.player_state")) {
        return { rows: [{ online_status: "Online", life_state: "Alive", character_state: "Active", players: 1 }] };
      }
      if (text.includes("from dune.farm_state")) {
        return { rows: [{ total: 1, ready: 1, alive: 1, connected_players: 1, incoming_s2s_connections: 1, outgoing_s2s_connections: 1 }] };
      }
      return { rows: [] };
    }
  };

  const result = await addonOpsHealthSummaryV2(db);
  assert.equal(result.players.total, 1);
  assert.equal(result.farms.total, 1);
});

test("offline teleport rejects unknown players before moving them", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("select exists")) return { rows: [{ exists: false }] };
      throw new Error("unexpected query after missing player check");
    }
  };

  await assert.rejects(
    () => teleportOfflinePlayerToCoords(db, "FLS_MISSING", { x: 1, y: 2, z: 3, partitionId: 1 }),
    (error) => error.statusCode === 404 && /not found/i.test(error.message)
  );
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls.map((call) => call.text).join("\n"), /admin_move_offline_player_to_partition/);
});

test("offline teleport moves existing players through the supported function", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("select exists")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ proc: "dune.admin_move_offline_player_to_partition(text,bigint,dune.vector)" }] };
      if (text.includes("admin_move_offline_player_to_partition")) return { rows: [{ ok: true }] };
      return { rows: [] };
    }
  };

  const result = await teleportOfflinePlayerToCoords(db, "FLS_OK", { x: 1.5, y: 2.5, z: 3.5, partitionId: 8 });
  const moveCall = calls.find((call) => call.text.includes("select dune.admin_move_offline_player_to_partition"));
  assert.equal(result.supported, true);
  assert.deepEqual(moveCall.values, ["FLS_OK", 8, 1.5, 2.5, 3.5]);
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
            : table === "vehicle_modules"
              ? ["id", "vehicle_id", "template_id", "stats"]
            : table === "journey_story_node"
              ? [fixtures.journeyIdentityColumn || "account_id", "story_node_id", "has_pending_reward", "complete_condition_state", "reveal_condition_state", "fail_condition_state", "metadata_state", "reset_group"]
              : table === "player_tags"
                ? [fixtures.journeyIdentityColumn || "account_id", "tag"]
                : fixtures.itemColumns || ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"];
        return { rows: names.map((column_name) => ({ column_name })) };
      }
      if (text.includes("TechKnowledgePlayerComponent") && text.includes("all_research")) return { rows: fixtures.researchListRows || [] };
      if (text.includes("TechKnowledgePlayerComponent") && text.includes("select exists")) return { rows: [{ exists: Boolean(fixtures.researchExists) }] };
      if (text.includes("TechKnowledgePlayerComponent") && text.includes("m_TechKnowledgeData") && text.includes("for update")) return { rows: fixtures.currentResearchItems === null ? [] : [{ items: fixtures.currentResearchItems || [] }] };
      if (text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && text.includes("update dune.actors")) return { rows: [{ ok: true }] };
      if (text.includes("CraftingRecipesLibraryActorComponent") && text.includes("player_recipes")) return { rows: fixtures.craftingListRows || [] };
      if (text.includes("CraftingRecipesLibraryActorComponent") && text.includes("select exists")) return { rows: [{ exists: Boolean(fixtures.recipeExists) }] };
      if (text.includes("CraftingRecipesLibraryActorComponent") && text.includes("for update")) return { rows: fixtures.currentCraftingRecipes === null ? [] : [{ recipes: fixtures.currentCraftingRecipes || [] }] };
      if (text.includes("CraftingRecipesLibraryActorComponent,m_KnownItemRecipes") && text.includes("update dune.actors")) return { rows: [{ ok: true }] };
      if (text.includes("story_node_id not like 'DA_Dunipedia_%'")) return { rows: fixtures.discoveredJourneyRows || [] };
      if (text.includes("story_node_id like 'DA_Dunipedia_%'")) return { rows: fixtures.codexRows || [] };
      if (text.includes("from dune.journey_story_node") && (text.includes("where account_id = $1") || text.includes('where "account_id" = $1') || text.includes("where character_id = $1") || text.includes('where "character_id" = $1'))) return { rows: fixtures.journeyStateRows || [] };
      if (text.includes("select tag from dune.player_tags")) return { rows: fixtures.playerTagRows || [] };
      if (text.includes("update dune.journey_story_node")) return { rows: [], rowCount: fixtures.journeyUpdateRows ?? 0 };
      if (text.includes("insert into dune.journey_story_node")) return { rows: [{ ok: true }], rowCount: 1 };
      if (text.includes("from dune.tutorials t")) return { rows: fixtures.tutorialRows || [] };
      if (text.includes("select exists (select 1 from dune.tutorials")) return { rows: [{ exists: Boolean(fixtures.tutorialExists) }] };
      if (text.includes("create_or_update_tutorial_entry")) return { rows: [{ ok: true }] };
      if (text.includes("delete from dune.tutorial_per_player")) return { rows: [], rowCount: fixtures.tutorialDeleteRows ?? 0 };
      if (text.includes("dune.update_player_tags")) return { rows: [{ ok: true }] };
      if (text.includes("from dune.actors a")) return { rows: fixtures.playerRows || [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("stats ? 'FAugmentItemStats'")) return { rows: fixtures.augmentRollRows || [] };
      if (text.includes("stats ? 'FAugmentedItemStats'")) return { rows: fixtures.augmentedItemRows || [] };
      if (/from\s+dune\.player_faction\b/.test(text)) return { rows: fixtures.playerFactionRows || [{ faction_id: 1 }] };
      if (text.includes("dune.get_solaris_id")) return { rows: [{ currency_id: 0 }] };
      if (text.includes("adjust_player_virtual_currency_balance")) return { rows: [{ ok: true }] };
      if (text.includes("player_virtual_currency_balances")) return { rows: fixtures.balanceRows || [] };
      if (text.includes("select reputation_amount")) return { rows: fixtures.reputationRows || [] };
      if (text.includes("set_player_faction_reputation")) return { rows: [{ ok: true }] };
      if (text.includes("where actor_id = $1 and faction_id in")) return { rows: fixtures.factionRows || [] };
      if (text.includes("jsonb_set") && text.includes("FactionPlayerComponent")) return { rows: [] };
      if (text.includes("m_TechKnowledgePoints") && text.includes("select")) return { rows: fixtures.intelRows || [] };
      if (text.includes("m_TechKnowledgePoints") && text.includes("update")) return { rows: [{ ok: true }] };
      if (text.includes("not (i.id = any($3::bigint[]))")) return { rows: fixtures.newItemRows || [] };
      if (text.includes("from dune.items i") && text.includes("where i.id = $1")) return { rows: fixtures.itemRows || [] };
      if (text.includes("not exists(select 1 from dune.items where id = $1")) return { rows: [{ deleted: true }] };
      if (text.includes("exists(select 1 from dune.items where id = $1")) return { rows: [{ exists: Boolean(fixtures.itemStillExists) }] };
      if (text.includes("delete from dune.items where id = $1")) return { rows: [], rowCount: 1 };
      if (text.includes("dune.delete_item")) return { rows: [{ ok: true }] };
      if (text.includes("from dune.inventories") && text.includes("where actor_id")) return { rows: fixtures.storageRows || [] };
      if (text.includes("from dune.vehicle_modules vm") && text.includes("count(*)::int as scanned")) return { rows: fixtures.vehicleModuleScanRows || [{ scanned: 0, vehicles: 0 }] };
      if (text.includes("update dune.vehicle_modules vm")) return { rows: fixtures.repairedVehicleModuleRows || [] };
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
