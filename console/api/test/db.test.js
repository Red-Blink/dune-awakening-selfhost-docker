import test, { beforeEach } from "node:test";
import { deleteAllVehicleStorageItems, deleteMultipleVehicleStorageItems, deleteVehicleStorageItem, isVehicleStorageModule, listVehicles, portalVehicleDisplayName, vehicleStorage, vehicleStorageDeleteSafety } from "../src/duneDb.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIdentifier, bigintParam, discoverDbConfig, isReadOnlySql, quoteQualified, redactDbError, rowsResult } from "../src/db.js";
import {
  _resetRefillPartitionDwellForTests,
  baseRefillTarget,
  cancelQueuedGeneratorRefill,
  flushGeneratorRefills,
  flushWaterRefills,
  listQueuedGeneratorRefills,
  listQueuedWaterRefills,
  observeRefillPartitions,
  partitionRestartTargets,
  queueGeneratorRefill,
  queueWaterRefill,
  supportsGeneratorRefillQueue
} from "../src/duneDb.js";
import { deleteBaseCompletely } from "../src/duneDb.js";
import { addBaseContainerItem, addCurrency, addFactionReputation, addGuildMember, addIntel, addonLeadershipPlayers, addonOpsHealthFarms, addonOpsHealthPlayers, addonOpsHealthSummary, addonOpsHealthSummaryV2, addonPlayerIdentities, addSpecializationXp, applyLandsraadMilestonePreset, augmentInventoryItem, augmentNewestPlayerItem, baseContainerSlots, baseGeneratorFuelLevels, baseGenerators, baseIsBackedUp, changeDunePassword, completeJourneyNode, completeTutorial, dbStatus, deleteAllBaseContainerItems, deleteBaseContainerItem, deleteInventoryItem, deleteMultipleBaseContainerItems, demoteGuildMember, disbandGuild, exportBaseAsBlueprint, fillItemToBaseContainer, fillItemToStorage, generatorUptimePolicy, giveItemToBaseContainer, giveItemToPlayer, giveItemToStorage, giveMultipleItemsToBaseContainer, guildMembers, inspectDeletedCharacterRecovery, inspectLandsraadQuestRepairs, landsraadOverview, listBases, listGuilds, listPlayers, listRoutines, listSpicefieldTypes, listTables, liveMapPlayers, liveMapServices, playerBuildingUnlockState, playerCraftingRecipes, playerCurrency, playerCustomizationGrantState, playerFactions, playerIntel, playerInventory, playerInventoryAll, playerJourney, playerPortalSnapshots, playerPosition, playerProfile, playerProgression, playerResearchItems, playerServerMemberships, playerSolarisCoinTotal, playerTeleportDestinations, playerVitals, portalGeneratorFuel, portalVehicles, promoteGuildMember, recoverDeletedCharacter, refillBaseGenerators, removeGuildMember, repairFactionReputation, repairLandsraadQuests, repairVehicleDecay, resetJourneyNode, resetTutorial, resolvePlayerTarget, routineDefinition, runSql, setLandsraadPlayerContribution, setPlayerFaction, supportsGeneratorRefill, tablePreview, teleportOfflinePlayerToCoords, teleportPlayer, unlockCraftingRecipe, unlockResearchItem, updateInventoryItem, updateLandsraadRewardTier, updateLandsraadTaskGoal, updateLandsraadTermTaskGoals, updateSpicefieldType, updateTableRow, UnsupportedCapabilityError, _resetPlayerTargetCacheForTests } from "../src/duneDb.js";
import { listStorage, liveMapBases, liveMapStorage, liveMapVehicles, portalStorage, trackPlayerPlaytime } from "../src/duneDb.js";

beforeEach(() => {
  _resetPlayerTargetCacheForTests();
});

test("bigint parameters preserve identifiers beyond JavaScript's safe integer range", () => {
  assert.equal(bigintParam("9007199254740993", "item id"), "9007199254740993");
  assert.equal(bigintParam("9223372036854775807", "item id"), "9223372036854775807");
  assert.throws(() => bigintParam("9223372036854775808", "item id"), /Invalid item id/);
  assert.throws(() => bigintParam("1.5", "item id"), /Invalid item id/);
});

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

// Upstream review finding: discoverDbConfig() previously implemented
// its own precedence (DUNE_DB_PORT || PGPORT || resolvePorts().postgres),
// which disagreed with resolvePorts()'s own precedence
// (POSTGRES_PORT || DUNE_DB_PORT || PGPORT) whenever an operator had
// more than one of these set to different values -- status/preflight
// (which reads resolvePorts() directly) could then disagree with the
// actual database connection (which read this function), a real,
// silent split-brain misconfiguration. discoverDbConfig() must now
// always delegate to resolvePorts() for this field so there is exactly
// one place this precedence logic can ever drift from itself.
test("discoverDbConfig()'s postgres port precedence matches resolvePorts() exactly, even when multiple port env vars conflict", () => {
  const conflicting = { POSTGRES_PORT: "16432", DUNE_DB_PORT: "17432", PGPORT: "18432" };
  assert.equal(discoverDbConfig(conflicting).port, 16432, "POSTGRES_PORT must win, matching resolvePorts()'s precedence exactly");
  assert.equal(discoverDbConfig({ DUNE_DB_PORT: "17432", PGPORT: "18432" }).port, 17432, "DUNE_DB_PORT must win over PGPORT when POSTGRES_PORT is unset");
  assert.equal(discoverDbConfig({ PGPORT: "18432" }).port, 18432, "PGPORT must be used when neither POSTGRES_PORT nor DUNE_DB_PORT is set");
});

test("database status exposes SSH tunneling only for a loopback database endpoint", async () => {
  const responses = [
    { rows: [{ current_user: "dune", current_database: "dune", version: "PostgreSQL test" }] },
    { rows: [{ count: 42 }] }
  ];
  const loopback = await dbStatus({
    config: { host: "127.0.0.1", port: 15432, database: "dune", user: "dune" },
    query: async () => responses.shift()
  });
  assert.deepEqual(loopback.sshTunnelAccess, {
    available: true,
    loopbackOnly: true,
    host: "127.0.0.1",
    port: 15432,
    database: "dune",
    user: "dune"
  });

  const remoteResponses = [
    { rows: [{ current_user: "dune", current_database: "dune", version: "PostgreSQL test" }] },
    { rows: [{ count: 42 }] }
  ];
  const remote = await dbStatus({
    config: { host: "database.example", port: 5432, database: "dune", user: "dune" },
    query: async () => remoteResponses.shift()
  });
  assert.equal(remote.sshTunnelAccess.available, false);
  assert.equal(remote.sshTunnelAccess.loopbackOnly, false);
  assert.equal(remote.sshTunnelAccess.host, "");
});

test("lists function and procedure metadata with parameterized filters", async () => {
  const calls = [];
  const rows = [{ oid: "123", schema: "dune", name: "refresh_player", kind: "function", arguments: "account_id bigint" }];
  const db = { query: async (text, values) => { calls.push({ text, values }); return { rows }; } };
  assert.deepEqual(await listRoutines(db, "dune", "player"), rows);
  assert.deepEqual(calls[0].values, ["dune", "player"]);
  assert.match(calls[0].text, /p\.prokind in \('f', 'p'\)/);
  assert.match(calls[0].text, /limit 500/);
  await assert.rejects(() => listRoutines(db, "dune;drop", ""), /Invalid schema/);
  await assert.rejects(() => listRoutines(db, "dune", "x".repeat(121)), /too long/);
});

test("loads one routine definition by validated OID", async () => {
  const calls = [];
  const row = { oid: "123", schema: "dune", name: "refresh_player", kind: "function", arguments: "account_id bigint", definition: "CREATE FUNCTION ..." };
  const db = { query: async (text, values) => { calls.push({ text, values }); return { rows: [row] }; } };
  assert.deepEqual(await routineDefinition(db, "123"), row);
  assert.deepEqual(calls[0].values, [123]);
  assert.match(calls[0].text, /pg_get_functiondef/);
  await assert.rejects(() => routineDefinition(db, "1;drop"), /Invalid routine oid/);
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

test("player portal calculates normal and spice generator fuel with their game durations", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      return {
        rows: [
          { base_id: "133", generator_type: "fuel", generator_count: 1, fuel_cells: 49, runtime_seconds: 176400, unstocked_count: 0 },
          { base_id: "133", generator_type: "spice", generator_count: 1, fuel_cells: 2, runtime_seconds: 10800, unstocked_count: 0 }
        ]
      };
    }
  };

  const result = await portalGeneratorFuel(db, [133, 200], { now: new Date("2026-06-30T23:59:59.000Z") });

  // Burn rates are measured per fuel item, not per generator type: Oil and
  // Lubricant1 burn 3600s, SpicedFuelCell and Lubricant2 burn 5400s.
  const [baseIdsParam, templates, durations] = calls[0].values;
  assert.deepEqual(baseIdsParam, [133, 200]);
  assert.deepEqual(templates, ["oil", "spicedfuelcell", "windturbinelubricant1", "windturbinelubricant2"]);
  assert.deepEqual(durations, [3600, 5400, 3600, 5400]);
  assert.match(calls[0].text, /requested_claims as/);
  assert.match(calls[0].text, /claim_afe\.actor_id = rc\.actor_id/);
  assert.deepEqual(result.get("133"), {
    fuelCells: 51,
    generatorCount: 2,
    runtimeSeconds: 10800,
    unstockedCount: 0,
    allGeneratorsUnstocked: false,
    uptimeMultiplier: 1,
    uptimeEventLabel: "",
    uptimeEventEndsAt: "",
    generators: [
      {
        type: "fuel",
        name: "Fuel-Powered Generator",
        fuelName: "Fuel Cell",
        fuelCells: 49,
        generatorCount: 1,
        runtimeSeconds: 176400,
        unstockedCount: 0
      },
      {
        type: "spice",
        name: "Spice-Powered Generator",
        fuelName: "Spice-infused Fuel Cell",
        fuelCells: 2,
        generatorCount: 1,
        runtimeSeconds: 10800,
        unstockedCount: 0
      }
    ]
  });
});

test("generator uptime event doubles all supported consumables and ends automatically", async () => {
  assert.deepEqual(generatorUptimePolicy(new Date("2026-06-30T23:59:59.999Z")), {
    multiplier: 1, label: "", endsAt: ""
  });
  assert.deepEqual(generatorUptimePolicy(new Date("2026-07-01T00:00:00.000Z")), {
    multiplier: 2,
    label: "Double generator uptime event",
    endsAt: "2026-09-01T00:00:00.000Z"
  });
  assert.deepEqual(generatorUptimePolicy(new Date("2026-09-01T00:00:00.000Z")), {
    multiplier: 1, label: "", endsAt: ""
  });

  const calls = [];
  const db = { query: async (text, values) => { calls.push({ text, values }); return { rows: [] }; } };
  await portalGeneratorFuel(db, [133], { now: new Date("2026-07-27T00:00:00.000Z") });
  assert.deepEqual(calls[0].values[2], [7200, 10800, 7200, 10800]);
});

test("player portal reports wind turbines as their own generator types in a stable order", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      return {
        rows: [
          // Deliberately out of display order — the comparator must sort them.
          { base_id: "133", generator_type: "windTurbineDirectional", generator_count: 1, fuel_cells: 38, runtime_seconds: 205200, unstocked_count: 0 },
          { base_id: "133", generator_type: "spice", generator_count: 1, fuel_cells: 2, runtime_seconds: 10800, unstocked_count: 0 },
          { base_id: "133", generator_type: "windTurbineOmni", generator_count: 3, fuel_cells: 467, runtime_seconds: 1681200, unstocked_count: 0 },
          // One of the two fuel generators is empty; its stock (213 cells) sits
          // entirely on the other one, so the SQL's queued-reserve filter
          // reports the non-empty generator's own duration, not 0.
          { base_id: "133", generator_type: "fuel", generator_count: 2, fuel_cells: 213, runtime_seconds: 766800, unstocked_count: 1 }
        ]
      };
    }
  };

  const result = await portalGeneratorFuel(db, [133]);
  const base = result.get("133");

  assert.deepEqual(base.generators.map((entry) => entry.type), [
    "fuel",
    "spice",
    "windTurbineOmni",
    "windTurbineDirectional"
  ]);
  assert.deepEqual(base.generators.map((entry) => entry.name), [
    "Fuel-Powered Generator",
    "Spice-Powered Generator",
    "Omnidirectional Wind Turbine",
    "Directional Wind Turbine"
  ]);
  assert.deepEqual(base.generators.map((entry) => entry.fuelName), [
    "Fuel Cell",
    "Spice-infused Fuel Cell",
    "Low-grade Lubricant",
    "Industrial-grade Lubricant"
  ]);
  assert.equal(base.generatorCount, 7);
  assert.equal(base.fuelCells, 720);
  assert.equal(base.unstockedCount, 1);
  assert.equal(base.allGeneratorsUnstocked, false);
  // min() across types excludes generators with no queued fuel. The base-wide
  // value is the lowest verifiable queued reserve, not an exact countdown.
  assert.equal(base.runtimeSeconds, 10800);
});

test("player portal reports allGeneratorsUnstocked only when every generator has no queued fuel", async () => {
  const db = {
    query: async () => ({
      rows: [
        { base_id: "133", generator_type: "fuel", generator_count: 2, fuel_cells: 0, runtime_seconds: null, unstocked_count: 2 }
      ]
    })
  };

  const base = (await portalGeneratorFuel(db, [133])).get("133");

  assert.equal(base.allGeneratorsUnstocked, true);
  assert.equal(base.runtimeSeconds, 0);
  assert.equal(base.generators[0].runtimeSeconds, 0);
});

test("player portal matches fuel stock by generator type, never by the burning marker", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [] };
    }
  };

  await portalGeneratorFuel(db, [133]);

  // An idle generator stores the string 'None' rather than SQL null in
  // m_FuelBurningId.Name. Deriving the fuel id from that field matched no
  // inventory rows and reported 0 runtime for generators holding hundreds of
  // cells, so stock is matched against the fuels each type accepts instead.
  // Matched against the JSON extraction, not the bare field name, which still
  // appears in the comment explaining why it must not drive fuel matching.
  assert.doesNotMatch(calls[0].text, /->'m_FuelBurningId'/);
  // Burn rates now come from measured per-fuel constants, so the component is
  // not read at all — which retires the zeroed-duration failure mode rather
  // than guarding it, and lets mixed fuel tiers be rated individually.
  assert.doesNotMatch(calls[0].text, /m_FuelBurningDuration/);
  assert.match(calls[0].text, /join type_fuels tf on tf\.generator_type=gs\.generator_type/);
  assert.match(calls[0].text, /sum\(i\.stack_size \* fd\.seconds\)/);
  // Every type's accepted fuels reach the query as parameters, never inlined.
  const pairs = calls[0].values[3].map((type, index) => `${type}:${calls[0].values[4][index]}`);
  assert.deepEqual(pairs, [
    "fuel:oil",
    "spice:spicedfuelcell",
    "windTurbineOmni:windturbinelubricant1",
    "windTurbineDirectional:windturbinelubricant2"
  ]);
  // Nothing here needs the universe clock any more, so a missing or empty
  // farm_variables table must not be able to blank out generator data.
  assert.doesNotMatch(calls[0].text, /farm_variables/);
});

test("player portal only counts generators it can classify, never defaulting to fuel", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [] };
    }
  };

  await portalGeneratorFuel(db, [133]);

  // Classification is an explicit allowlist passed as query parameters. An
  // unknown name containing "generator" must not silently become oil-powered.
  assert.match(calls[0].text, /join generator_types gt on gt\.building_type=lower\(p\.building_type\)/);
  assert.doesNotMatch(calls[0].text, /like '%generator%'/);
  const buildingPairs = calls[0].values[5].map(
    (type, index) => `${type}:${calls[0].values[6][index]}`
  );
  assert.deepEqual(buildingPairs, [
    "fuel:generator_placeable",
    "spice:spicegenerator_placeable",
    "windTurbineOmni:windturbineomnidirectional_placeable",
    "windTurbineDirectional:windturbinedirectional_placeable"
  ]);
  assert.ok(!calls[0].values[6].includes("unknownnewgenerator_placeable"));
});

test("player server membership probes return only requested hashes, matches, and levels", async () => {
  const existingSteamId = "76561198000000001";
  const otherSteamId = "76561198000000002";
  const existingHash = createHash("sha256").update(existingSteamId).digest("hex");
  const missingHash = createHash("sha256").update("76561198000000003").digest("hex");
  const unrelatedHash = createHash("sha256").update(otherSteamId).digest("hex");
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("select distinct ac.platform_id")) return { rows: [
        { platform_id: existingSteamId, player_controller_id: "101", player_pawn_id: "201" },
        { platform_id: otherSteamId, player_controller_id: "102", player_pawn_id: "202" }
      ] };
      if (text.includes("select to_regclass")) {
        return { rows: [{ exists: values[0] === "dune.specialization_tracks" }] };
      }
      if (text.includes("from dune.specialization_tracks")) return { rows: [
        { player_id: "101", level: 87 },
        { player_id: "102", level: 42 }
      ] };
      return { rows: [] };
    }
  };

  const result = await playerServerMemberships(db, [existingHash, missingHash]);

  assert.deepEqual(result, [
    { accountHash: existingHash, found: true, level: 87 },
    { accountHash: missingHash, found: false, level: null }
  ]);
  assert.equal(JSON.stringify(result).includes(existingSteamId), false);
  assert.equal(JSON.stringify(result).includes(otherSteamId), false);
  assert.equal(JSON.stringify(result).includes(unrelatedHash), false);
  assert.match(calls[0].text, /join dune\.player_state/);
  assert.match(calls[0].text, /join dune\.actors pawn on pawn\.id=ps\.player_pawn_id/);
});

test("player portal never decays stocked runtime by elapsed burn time", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [] };
    }
  };

  await portalGeneratorFuel(db, [133]);

  // m_FuelBurningInitialTime resets on server restart / base load, so cohorts of
  // unrelated placeables share one value and elapsed time measured from it says
  // nothing about fuel consumed. Subtracting it reported well-stocked
  // generators as depleted, tripping on whichever held the least fuel.
  // Matched against the JSON extraction rather than the bare field name, which
  // still appears in the comment explaining why it must not be read.
  assert.doesNotMatch(calls[0].text, /elapsed_seconds/);
  assert.doesNotMatch(calls[0].text, /->>'m_FuelBurningInitialTime'/);
  assert.doesNotMatch(calls[0].text, /m_FuelBurningPassedTimeSinceStart/);
  // Runtime is exactly the burn time stocked in the generator.
  assert.match(calls[0].text, /stocked_seconds::bigint runtime_seconds/);
  // Zero means no accepted fuel is queued; it deliberately does not claim a
  // stale burning marker proves whether a partial active cycle remains.
  assert.match(calls[0].text, /\(fuel_cells = 0\) has_no_queued_fuel/);
  assert.match(calls[0].text, /min\(runtime_seconds\) filter \(where not has_no_queued_fuel\)/);
});

test("player portal rates every accepted fuel with a positive measured duration", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [] };
    }
  };

  await portalGeneratorFuel(db, [133]);

  const [, templates, durations, , typeFuelTemplates] = calls[0].values;

  // Runtime is stack_size * seconds, so a zero or missing rate silently voids
  // any amount of stocked fuel — that shipped once already. These tests use a
  // fake db and cannot evaluate SQL, so soundness is proved from the parameters:
  // every fuel a type can burn has a rate, and every rate is positive. Together
  // that means a generator holding fuel can never report 0 runtime.
  assert.equal(templates.length, durations.length, "each template must carry a rate");
  for (const seconds of durations) assert.ok(seconds > 0, `burn rate must be positive, got ${seconds}`);

  for (const template of new Set(typeFuelTemplates)) {
    assert.ok(templates.includes(template), `${template} is accepted by a type but has no burn rate`);
  }
});

test("player portal never reports a stocked generator type as having no queued fuel", async () => {
  const db = {
    query: async () => ({
      rows: [
        // The regression: three generators, all holding fuel. The old decay
        // model flagged the smallest-stocked of them as depleted.
        { base_id: "133", generator_type: "fuel", generator_count: 3, fuel_cells: 503, runtime_seconds: 1810800, unstocked_count: 0 }
      ]
    })
  };

  const base = (await portalGeneratorFuel(db, [133])).get("133");

  assert.equal(base.unstockedCount, 0);
  assert.equal(base.generators[0].unstockedCount, 0);
  assert.ok(base.runtimeSeconds > 0, "a fuelled base must report a non-zero runtime");
});

test("player portal skips the generator query when there are no bases", async () => {
  const db = { query: async () => assert.fail("generator query should not run") };
  assert.deepEqual(await portalGeneratorFuel(db, []), new Map());
});

test("player portal snapshot bases report generatorUnstockedCount and generatorAllUnstocked", async () => {
  const platformId = "12345678901234567";
  const accountHash = createHash("sha256").update(platformId).digest("hex");
  const db = {
    query: async (text, values = []) => {
      // Initial query for identities - get platform/character info
      if (text.includes("from dune.accounts ac")) {
        return { rows: [{
          account_id: "44",
          platform_id: platformId,
          character_name: "Test Player",
          controller_id: "55",
          actor_id: "123",
          online_status: "Offline",
          last_seen: "2026-07-26",
          home_sietch_dimension_index: "1",
          home_sietch_partition_id: "2",
          home_sietch_label: "Alraab",
          player_map: "TheDeepDesert",
          player_partition_id: "0",
          player_x: "100",
          player_y: "200",
          player_z: "30"
        }] };
      }
      // addonLeadershipPlayers - return empty for leader data
      if (text.includes("from dune.leadership_players")) {
        return { rows: [] };
      }
      // Table existence checks - required tables return true
      if (text.includes("to_regclass")) {
        const tableName = String(values[0] || "");
        const requiredForBases = ["buildings", "building_instances", "actor_fgl_entities", "actors", "placeables", "fgl_entities"];
        const isRequired = requiredForBases.some(table => tableName.includes(table));
        return { rows: [{ exists: isRequired }] };
      }
      // listBases totals query (with total_bases calculation)
      if (text.includes("with valid_claims as") || text.includes("total_bases")) {
        return { rows: [{ total_bases: "1", total_pieces: "100", total_placeables: "50" }] };
      }
      // listBases main query (with matched CTE)
      if (text.includes("with matched as")) {
        return { rows: [{
          base_id: "1006",
          name: "Test Base",
          base_type: "Sub-Fief",
          owner_name: "Test Player",
          map: "TheDeepDesert",
          partition_id: "0",
          x: "100",
          y: "200",
          z: "30",
          total_count: "1",
          piece_count: "100",
          placeable_count: "50",
          shared_with: null
        }] };
      }
      // Intel query
      if (text.includes("TechKnowledgePlayerComponent")) {
        return { rows: [] };
      }
      // Keystones query
      if (text.includes("purchased_specialization_keystones")) {
        return { rows: [] };
      }
      // Blueprints query
      if (text.includes("building_blueprints")) {
        return { rows: [] };
      }
      // portalVehicles
      if (text.includes("from dune.vehicles")) {
        return { rows: [] };
      }
      // portalGuild
      if (text.includes("from dune.guilds")) {
        return { rows: [] };
      }
      // portalGeneratorFuel - return generator data with one empty generator
      if (text.includes("from generator_runtime group by")) {
        return { rows: [{
          base_id: "1006",
          generator_type: "fuel",
          generator_count: 2,
          fuel_cells: 45,
          runtime_seconds: 7200,
          unstocked_count: 1
        }] };
      }
      if (text.includes("from containers group by water_type")) {
        return { rows: [{ water_type: "waterCistern", container_count: 2, water_stored: 8000, blood_stored: null }] };
      }
      return { rows: [] };
    }
  };

  const marketSnapshot = {
    available: true,
    configured: true,
    enabled: true,
    exchangeId: "77",
    buybackPercent: 60,
    buybackPriceBasis: "seeded",
    maxBuys: 500,
    evaluatedAt: "2026-08-19T12:00:00.000Z",
    overview: {
      available: true,
      evaluatedAt: "2026-08-19T12:00:01.000Z",
      items: [{ templateId: "WaterBottle", displayName: "Water", qualityLevel: "0", listingCount: 2, totalUnits: 20, lowestPrice: "500", highestPrice: "600", maxUnitPrice: "600" }]
    },
    listings: [
      { orderId: "1", sellerActorId: "123", displayName: "Water", itemPrice: "500", stackSize: "2", maxUnitPrice: "600", resultCode: 0, resultLabel: "eligible", detail: "eligible" },
      { orderId: "2", sellerActorId: "999", displayName: "Other Player Item", resultCode: 1 }
    ],
    batches: [{
      at: "2026-08-19T11:00:00.000Z",
      source: "Scheduled buyback",
      entries: [
        { orderId: "3", sellerActorId: "123", displayName: "Iron", itemPrice: "100", stackSize: "3", maxUnitPrice: "120", resultCode: 0, resultLabel: "success", detail: "bought" },
        { orderId: "4", sellerActorId: "999", displayName: "Private", resultCode: 1 }
      ]
    }]
  };
  const result = await playerPortalSnapshots(db, [accountHash], {}, [], marketSnapshot, {
    sietchNames: { "2": "Sietch Custom" },
    serverInfo: { messageOfTheDay: { enabled: true, title: "Welcome", message: "Welcome {playerName}!" } }
  });

  assert.equal(result.length, 1, "should return one result");
  assert.equal(result[0].found, true, "account should be found");
  assert.equal(result[0].accountHash, accountHash, "account hash should match");
  assert.ok(result[0].data, "result should have data");
  assert.ok(result[0].data.bases, "data should have bases array");
  assert.ok(result[0].data.bases.length > 0, "should have at least one base");
  const base = result[0].data.bases[0];
  assert.equal(base.id, "1006", "base id should match");
  assert.equal(base.name, "Test Base", "base name should match");
  assert.equal(base.generatorUnstockedCount, 1, "base should report the count with no queued fuel");
  assert.equal(base.generatorAllUnstocked, false, "not all generators are unstocked");
  assert.equal(base.waterSupported, true);
  assert.equal(base.waterStatus, "available");
  assert.equal(base.waterContainers[0].stored, 8000);
  assert.equal(base.waterContainers[0].capacity, 10000);
  assert.deepEqual(result[0].data.marketBot.listings.map((row) => row.orderId), ["1"]);
  assert.deepEqual(result[0].data.marketBot.history.map((row) => row.orderId), ["3"]);
  assert.equal(Object.hasOwn(result[0].data.marketBot.listings[0], "sellerActorId"), false, "local seller ids must not leave the server");
  assert.equal(JSON.stringify(result[0].data.marketBot).includes("Other Player Item"), false);
  assert.equal(JSON.stringify(result[0].data.marketBot).includes("Private"), false);
  assert.equal(result[0].data.exchangeOverview.available, true);
  assert.equal(result[0].data.exchangeOverview.items[0].listingCount, 2);
  assert.deepEqual(result[0].data.overview.homeSietch, { name: "Sietch Custom", partitionId: 2, dimensionIndex: 1 });
  assert.equal(result[0].data.specializations.unspentSkillPoints, 0);
  assert.equal(Object.hasOwn(result[0].data.specializations, "unspentPoints"), false, "portal payload must not misname skill points as generic specialization points");
  assert.equal(result[0].data.serverInfo.messageOfTheDay.message, "Welcome Test Player!");
});

test("player portal prefers custom vehicle names and ignores internal labels", async () => {
  const db = {
    query: async () => ({ rows: [
      { id: "183", type: "BP_LightOrnithopter_Choam_C", custom_name: " Scout Ornithopter 2 ", modules: [] },
      { id: "140", type: "BP_LightOrnithopter_Choam_C", custom_name: "##LightOrnithopterChoam", modules: [] }
    ] })
  };

  const result = await portalVehicles(db, [129]);

  assert.equal(result.rows[0].name, "Scout Ornithopter 2");
  assert.equal(result.rows[1].name, "Scout Ornithopter");
  assert.equal(Object.hasOwn(result.rows[0], "custom_name"), false);
});

test("player portal storage returns only the already ownership-scoped aggregate rows", async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [
      { container_id: "11", container_name: "Workshop", map: "Hagga Basin", template_id: "Iron_Ingot", quality_level: 0, stack_count: 2, quantity: "45" },
      { container_id: "11", container_name: "Workshop", map: "Hagga Basin", template_id: "Copper_Ingot", quality_level: 0, stack_count: 1, quantity: "12" }
    ] };
  } };
  const result = await portalStorage(db, 123);
  assert.deepEqual(calls[0].values, [123]);
  assert.match(calls[0].sql, /par\.player_id=\$1 and par\.rank=1/);
  assert.equal(result.containers[0].totalQuantity, 57);
  assert.equal(result.items[0].containerName, "Workshop");
  assert.equal(JSON.stringify(result).includes("player_id"), false);
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
        return { rows: [{ row_locator: "(7,1)", task_id: "42", threshold: 500, template_id: "Reward", amount: 1 }] };
      }
      return { rows: [] };
    }
  };
  const result = await landsraadOverview(db);
  assert.equal(result.capabilities.landsraad, true);
  assert.equal(result.term.term_id, 7);
  assert.equal(result.tasks[0].task_id, "42");
  assert.equal(result.rewards[0].threshold, 500);
  assert.equal(result.rewards[0].row_locator, "(7,1)");
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
      if (text.includes("update dune.landsraad_task_rewards")) return { rows: [{ row_locator: "(8,2)", task_id: "42", threshold: 2000, template_id: "Template", amount: 3 }], rowCount: 1 };
      return { rows: [] };
    }
  };
  await updateLandsraadTaskGoal(db, 42, 7500);
  await updateLandsraadTermTaskGoals(db, 7, 8000);
  await updateLandsraadRewardTier(db, { rowLocator: "(8,1)", taskId: 42, threshold: 1000, newThreshold: 2000, templateId: "Template", amount: 3 });
  assert.ok(calls.some((call) => String(call.text).includes("where id = $2") && call.values.join(",") === "7500,42"));
  assert.ok(calls.some((call) => String(call.text).includes("where term_id = $2") && call.values.join(",") === "8000,7"));
  assert.ok(calls.some((call) => String(call.text).includes("ctid = $4::tid") && call.values.join(",") === "2000,Template,3,(8,1),42,1000"));
  await assert.rejects(() => updateLandsraadRewardTier(db, { rowLocator: "(8,1)", taskId: 42, threshold: 1000, newThreshold: 1000, templateId: "", amount: 1 }), /Reward template id/);
  await assert.rejects(() => updateLandsraadRewardTier(db, { rowLocator: "invalid", taskId: 42, threshold: 1000, newThreshold: 1000, templateId: "Template", amount: 1 }), /valid Landsraad reward row locator/);
});

test("landsraad milestone preset updates every current task and ordered reward tier transactionally", async () => {
  const calls = [];
  const query = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
    if (text.includes("from dune.landsraad_decree_term")) return { rows: [{ term_id: "7" }] };
    if (text.includes("from (") && text.includes("current_tasks")) return { rows: [{ task_count: 2, minimum_tiers: 3, maximum_tiers: 3 }] };
    if (text.includes("max(r.threshold)")) return { rows: [{ maximum: "3000" }] };
    if (text.includes("update dune.landsraad_tasks")) return { rows: [], rowCount: 2 };
    if (text.includes("with ranked as")) return { rows: [], rowCount: 6 };
    if (text.includes("update dune.landsraad_task_rewards")) return { rows: [], rowCount: 2 };
    return { rows: [] };
  };
  const db = {
    query,
    transaction: async (fn) => fn({ query })
  };

  const result = await applyLandsraadMilestonePreset(db, { goalAmount: 9000, thresholds: [1500, 3000, 6000] });
  assert.equal(result.applied, true);
  assert.equal(result.tasksUpdated, 2);
  assert.equal(result.rewardsUpdated, 6);
  assert.ok(calls.some((call) => String(call.text).includes("set goal_amount = $1") && call.values.join(",") === "9000,7"));
  assert.ok(calls.some((call) => String(call.text).includes("row_number() over (partition by r.task_id order by r.threshold")));
  assert.deepEqual(calls.filter((call) => String(call.text).includes("and r.threshold = $3")).map((call) => call.values[0]), [1500, 3000, 6000]);
  assert.ok(calls.every((call) => !String(call.text).includes("set template_id") && !String(call.text).includes("set amount")));
});

test("landsraad milestone preset waits for matching generated tiers and rejects unordered thresholds", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.landsraad_decree_term")) return { rows: [{ term_id: "8" }] };
      if (text.includes("current_tasks")) return { rows: [{ task_count: 4, minimum_tiers: 0, maximum_tiers: 2 }] };
      return { rows: [] };
    },
    transaction: async () => assert.fail("transaction should not start before the term is ready")
  };
  const waiting = await applyLandsraadMilestonePreset(db, { goalAmount: 5000, thresholds: [1000, 2500, 4000] });
  assert.equal(waiting.applied, false);
  assert.match(waiting.reason, /0-2 reward tiers/);
  await assert.rejects(() => applyLandsraadMilestonePreset(db, { goalAmount: 5000, thresholds: [2500, 1000] }), /must increase/);
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

test("player currency labels Solari Credit and Scrip, falls back to a generic label for other ids", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("select dune.get_solaris_id() as id")) return { rows: [{ id: 0 }] };
      if (text.includes("from dune.player_virtual_currency_balances")) {
        assert.deepEqual(values, [91]);
        return { rows: [
          { currency_id: 0, balance: "5000", label: "Solari Credit" },
          { currency_id: 1, balance: "250", label: "Scrip" },
          { currency_id: 7, balance: "12", label: "Currency 7" }
        ] };
      }
      return { rows: [] };
    }
  };
  const result = await playerCurrency(db, "91");
  assert.deepEqual(result.rows.map((row) => row.label), ["Solari Credit", "Scrip", "Currency 7"]);
});

test("player currency fills in zero balances for Solari Credit and Scrip when the player has neither", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("select dune.get_solaris_id() as id")) return { rows: [{ id: 0 }] };
      if (text.includes("from dune.player_virtual_currency_balances")) {
        assert.deepEqual(values, [91]);
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  const result = await playerCurrency(db, "91");
  assert.deepEqual(result.rows, [
    { currency_id: 0, balance: 0, label: "Solari Credit" },
    { currency_id: 1, balance: 0, label: "Scrip" }
  ]);
});

test("player currency reports unsupported when the balances table is missing", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: false }] };
      return { rows: [] };
    }
  };
  const result = await playerCurrency(db, "91");
  assert.equal(result.capabilities.currency, false);
  assert.deepEqual(result.rows, []);
});

test("player Solari Coin total sums stack sizes across every matching inventory item", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.items i") && text.includes("i.template_id = 'SolarisCoin'")) {
        assert.deepEqual(values, [1549]);
        return { rows: [{ total: "51194" }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerSolarisCoinTotal(db, "1549");
  assert.equal(result.capabilities.solarisCoin, true);
  assert.equal(result.total, 51194);
});

test("player Solari Coin total reports zero when the player holds none", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.items i") && text.includes("i.template_id = 'SolarisCoin'")) {
        return { rows: [{ total: "0" }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerSolarisCoinTotal(db, "91");
  assert.equal(result.capabilities.solarisCoin, true);
  assert.equal(result.total, 0);
});

test("player Solari Coin total reports unsupported when inventory tables are missing", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: false }] };
      return { rows: [] };
    }
  };
  const result = await playerSolarisCoinTotal(db, "91");
  assert.equal(result.capabilities.solarisCoin, false);
});

test("player factions lists every known faction, each with its own reputation", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      if (text.includes("FactionPlayerComponent") && text.includes("from dune.actors")) {
        assert.deepEqual(values, [301]);
        return { rows: [{ faction_data: [
          { Faction: { Name: "Atreides" }, ReputationAmount: 500 },
          { Faction: { Name: "Harkonnen" }, ReputationAmount: 20 }
        ] }] };
      }
      if (text.includes("from dune.factions f")) {
        assert.match(text, /coalesce\(pfr\.reputation_amount, 0\)/);
        assert.match(text, /f\.name <> 'None'/);
        assert.deepEqual(values, [301]);
        return { rows: [
          { faction_id: 1, faction_name: "Atreides", reputation_amount: "500" },
          { faction_id: 2, faction_name: "Harkonnen", reputation_amount: "120" },
          { faction_id: 4, faction_name: "Smuggler", reputation_amount: "75" }
        ] };
      }
      return { rows: [] };
    }
  };
  const result = await playerFactions(db, "91");
  assert.equal(result.capabilities.factionNames, true);
  assert.deepEqual(result.rows.map((row) => [row.faction_name, row.reputation_amount]), [
    ["Atreides", "500"],
    ["Harkonnen", "120"],
    ["Smuggler", "75"]
  ]);
  assert.equal(result.rows.find((row) => row.faction_name === "Atreides").reputation_in_sync, true);
  assert.equal(result.rows.find((row) => row.faction_name === "Harkonnen").reputation_in_sync, false);
  assert.equal(result.rows.find((row) => row.faction_name === "Smuggler").reputation_in_sync, undefined);
});

test("player factions coalesces an untouched faction's reputation to 0 and excludes 'None'", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      if (text.includes("from dune.factions f")) {
        assert.deepEqual(values, [301]);
        return { rows: [
          { faction_id: 1, faction_name: "Atreides", reputation_amount: "500" },
          { faction_id: 2, faction_name: "Harkonnen", reputation_amount: "0" },
          { faction_id: 4, faction_name: "Smuggler", reputation_amount: "0" }
        ] };
      }
      return { rows: [] };
    }
  };
  const result = await playerFactions(db, "91");
  assert.deepEqual(result.rows.map((row) => row.faction_name), ["Atreides", "Harkonnen", "Smuggler"]);
  assert.equal(result.rows.find((row) => row.faction_name === "Harkonnen").reputation_amount, "0");
  assert.equal(result.rows.some((row) => row.faction_name === "None"), false);
});

test("player factions reports reputation-estimated rank and an unfinished-story limit", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        const columns = values[1] === "journey_story_node"
          ? ["character_id", "story_node_id", "complete_condition_state"]
          : values[1] === "player_tags" ? ["character_id", "tag"] : [];
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 44, online_status: "Offline" }] };
      }
      if (text.includes("from dune.factions f")) {
        return { rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: "5200" }] };
      }
      if (text.includes("from dune.player_tags")) {
        assert.deepEqual(values, [44]);
        return { rows: [
          { tag: "Faction.Atreides.Tier0" },
          { tag: "Faction.Atreides.Tier4" }
        ] };
      }
      if (text.includes("from dune.journey_story_node")) return { rows: [] };
      return { rows: [] };
    }
  };
  const result = await playerFactions(db, "91");
  assert.equal(result.rows[0].estimated_rank, 12);
  assert.equal(result.rows[0].current_rank_limit, 4);
  assert.equal(result.rows[0].rank_limited_by_progression, true);
});

test("player factions offers repair when completed onboarding earned missing Tier 5 progression", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        const columns = values[1] === "journey_story_node"
          ? ["character_id", "story_node_id", "complete_condition_state"]
          : values[1] === "player_tags" ? ["character_id", "tag"] : [];
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 44, online_status: "Offline" }] };
      }
      if (text.includes("FactionPlayerComponent") && text.includes("from dune.actors")) {
        return { rows: [{ faction_data: [{ Faction: { Name: "Atreides" }, ReputationAmount: 12474 }] }] };
      }
      if (text.includes("from dune.factions f")) {
        return { rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: "12474" }] };
      }
      if (/from\s+dune\.player_faction\b/.test(text)) return { rows: [{ faction_id: 1 }] };
      if (text.includes("from dune.player_tags")) return { rows: [{ tag: "Faction.Atreides.Tier2" }] };
      if (text.includes("from dune.journey_story_node")) return { rows: [
        { story_node_id: "DA_FQ_ClimbTheRanks.Rank5To20.CompleteLandsraadMission.CompleteOnboardingJourney1" },
        { story_node_id: "DA_FQ_ClimbTheRanks.Rank5To20.CraftAugmentation.CompleteOnboardingJourney2" }
      ] };
      return { rows: [] };
    }
  };
  const result = await playerFactions(db, "91");
  assert.equal(result.rows[0].reputation_in_sync, true);
  assert.equal(result.rows[0].current_rank_limit, 2);
  assert.equal(result.rows[0].progression_repair_available, true);
  assert.equal(result.rows[0].progression_repair_target, 5);
});

test("player progression computes level from XP and reports skill points", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      if (text.includes("from dune.fgl_entities fe") && text.includes("join dune.actor_fgl_entities afe")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ xp: "4790", total_skill_points: "12", unspent_skill_points: "3" }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerProgression(db, "91");
  assert.equal(result.capabilities.progression, true);
  assert.equal(result.xp, 4790);
  assert.equal(result.level, 11);
  assert.equal(result.totalSkillPoints, 12);
  assert.equal(result.unspentSkillPoints, 3);
});

test("player progression reports unsupported when required addon tables are missing", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: false }] };
      return { rows: [] };
    }
  };
  const result = await playerProgression(db, "91");
  assert.equal(result.capabilities.progression, false);
});

test("player progression reports unavailable when the player has no matching DuneCharacter entity", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      if (text.includes("from dune.fgl_entities fe") && text.includes("join dune.actor_fgl_entities afe")) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  const result = await playerProgression(db, "91");
  assert.equal(result.capabilities.progression, false);
  assert.equal(result.xp, undefined);
});

test("player intel reads TechKnowledge points for the player's actor", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "properties" }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      if (text.includes("TechKnowledgePlayerComponent")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ intel: "1500" }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerIntel(db, "91");
  assert.equal(result.capabilities.intel, true);
  assert.equal(result.intel, 1500);
  assert.equal(result.maxIntel, 2779);
});

test("player intel reports unsupported when actors table lacks a properties column", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [] };
      return { rows: [] };
    }
  };
  const result = await playerIntel(db, "91");
  assert.equal(result.capabilities.intel, false);
});

test("player intel reports unavailable when the actor has no TechKnowledgePlayerComponent", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "properties" }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      if (text.includes("TechKnowledgePlayerComponent")) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  const result = await playerIntel(db, "91");
  assert.equal(result.capabilities.intel, false);
  assert.equal(result.intel, undefined);
});

test("player intel reports unavailable when the component key exists but carries no point value", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "properties" }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      if (text.includes("TechKnowledgePlayerComponent")) {
        return { rows: [{ intel: null }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerIntel(db, "91");
  assert.equal(result.capabilities.intel, false);
  assert.equal(result.intel, undefined);
});

test("player vitals reports health, hydration, and spice addiction with derived max health from Combat level", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "gas_attributes" }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      if (text.includes("from dune.fgl_entities fe") && text.includes("join dune.actor_fgl_entities afe")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ current_health: "175.5" }] };
      }
      if (text.includes("gas_attributes->'DuneHydrationAttributeSet'")) {
        assert.deepEqual(values, [91]);
        return { rows: [{ hydration: "83.958465", spice_addiction_level: "8.2" }] };
      }
      if (text.includes("from dune.specialization_tracks where player_id")) {
        assert.deepEqual(values, [301]);
        return { rows: [{ level: "77" }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerVitals(db, "91");
  assert.equal(result.capabilities.vitals, true);
  assert.equal(result.currentHealth, 175.5);
  assert.equal(result.maxHealth, 200);
  assert.equal(result.maxHealthEstimated, true);
  assert.equal(result.hydration, 83.958465);
  assert.equal(result.maxHydration, 100);
  assert.equal(result.spiceAddictionLevel, 8.2);
  assert.equal(result.maxSpiceAddictionLevel, 10);
});

test("player vitals reports unsupported when required addon tables/columns are missing", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: false }] };
      return { rows: [] };
    }
  };
  const result = await playerVitals(db, "91");
  assert.equal(result.capabilities.vitals, false);
});

test("player vitals reports null (not zero) health/hydration/spice when no matching data exists", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "gas_attributes" }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerVitals(db, "91");
  assert.equal(result.capabilities.vitals, true);
  assert.equal(result.currentHealth, null);
  assert.equal(result.hydration, null);
  assert.equal(result.spiceAddictionLevel, null);
  assert.equal(result.maxHealth, 150);
  assert.equal(result.maxHealthEstimated, true);
});

test("player vitals treats Combat level as 0 (base max health only) when specialization_tracks doesn't exist", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: values[0] !== "dune.specialization_tracks" }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "gas_attributes" }] };
      if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
        return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
      }
      if (text.includes("from dune.fgl_entities fe") && text.includes("join dune.actor_fgl_entities afe")) {
        return { rows: [{ current_health: "150" }] };
      }
      if (text.includes("gas_attributes->'DuneHydrationAttributeSet'")) {
        return { rows: [{ hydration: "50", spice_addiction_level: "2" }] };
      }
      if (text.includes("from dune.specialization_tracks where player_id")) {
        throw new Error("should not query specialization_tracks when the table doesn't exist");
      }
      return { rows: [] };
    }
  };
  const result = await playerVitals(db, "91");
  assert.equal(result.maxHealth, 150);
  assert.equal(result.maxHealthEstimated, true);
});

test("player vitals derives max health from every Vitality passive tier boundary", async () => {
  const tierCases = [
    { combatLevel: 0, maxHealth: 150 },
    { combatLevel: 5, maxHealth: 150 },
    { combatLevel: 6, maxHealth: 165 },
    { combatLevel: 25, maxHealth: 165 },
    { combatLevel: 26, maxHealth: 170 },
    { combatLevel: 55, maxHealth: 170 },
    { combatLevel: 56, maxHealth: 175 },
    { combatLevel: 76, maxHealth: 175 },
    { combatLevel: 77, maxHealth: 200 },
    { combatLevel: 90, maxHealth: 200 },
    { combatLevel: 91, maxHealth: 205 },
    { combatLevel: 150, maxHealth: 205 }
  ];
  for (const { combatLevel, maxHealth } of tierCases) {
    const db = {
      query: async (text) => {
        if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
        if (text.includes("information_schema.columns")) return { rows: [{ column_name: "gas_attributes" }] };
        if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
          return { rows: [{ actor_id: 91, account_id: 201, controller_id: 301, player_state_id: 1, online_status: "Offline" }] };
        }
        if (text.includes("from dune.specialization_tracks where player_id")) {
          return { rows: [{ level: combatLevel }] };
        }
        return { rows: [] };
      }
    };
    const result = await playerVitals(db, "91");
    assert.equal(result.maxHealth, maxHealth, `combat level ${combatLevel} should yield max health ${maxHealth}`);
    assert.equal(result.maxHealthEstimated, true);
  }
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
      return { rows: [{ actor_id: 82, player_pawn_id: 82, account_id: 276, funcom_id: "RedBlink#75570", fls_id: "RedBlink#75570", action_player_id: "RedBlink#75570", total_count: 1 }] };
    }
  };
  const result = await listPlayers(db, { q: "RedBlink'; drop table dune.actors; --" });
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors"));
  assert.ok(playerQuery);
  assert.match(playerQuery.text, /as player_pawn_id/);
  assert.match(playerQuery.text, /as funcom_id/);
  assert.match(playerQuery.text, /as action_player_id/);
  assert.match(playerQuery.text, /left join dune\.console_player_playtime/);
  assert.match(playerQuery.text, /as total_playtime_seconds/);
  assert.match(playerQuery.text, /A5C0DE5E12A00001/);
  assert.match(playerQuery.text, /Server#0001/);
  assert.match(playerQuery.text, /a\.id <> 900000103::bigint/);
  assert.match(playerQuery.text, /\$2/);
  assert.match(playerQuery.text, /\$3/);
  assert.deepEqual(playerQuery.values[0], []);
  assert.equal(playerQuery.values[1], "%RedBlink'; drop table dune.actors; --%");
  assert.equal(playerQuery.values[2], "RedBlink'; drop table dune.actors; --");
  assert.equal(result.rows[0].actor_id, 82);
  assert.equal(result.rows[0].player_pawn_id, 82);
  assert.equal(result.rows[0].account_id, 276);
  assert.equal(result.rows[0].funcom_id, "RedBlink#75570");
  assert.equal(result.rows[0].fls_id, "RedBlink#75570");
  assert.equal(result.rows[0].action_player_id, "RedBlink#75570");
});

test("players sorted by last online rank current players ahead of stored timestamps", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "online_status" }] };
      if (text.includes("count(distinct dedupe_key)")) return { rows: [{ total_players: 2 }] };
      return { rows: [{ actor_id: 82, total_count: 2 }] };
    }
  };

  await listPlayers(db, { sortColumn: "last_seen", sortDirection: "desc" });
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors") && !call.text.includes("count(distinct dedupe_key)"));

  assert.match(playerQuery.text, /order by case when actual_online_status = 'Online' then 0 else 1 end asc, last_seen desc, actor_id desc/);
});

test("players query resolves the game map partition used by configured Sietch names", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.actors", "dune.player_state", "dune.world_partition"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "online_status" }] };
      if (text.includes("count(distinct dedupe_key)")) return { rows: [{ total_players: 1 }] };
      return { rows: [{
        actor_id: 82,
        map: "HaggaBasin",
        partition_id: "1",
        partition_map: "Survival_1",
        dimension_index: "0",
        total_count: 1
      }] };
    }
  };

  const result = await listPlayers(db);
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors") && !call.text.includes("count(distinct dedupe_key)"));

  assert.match(playerQuery.text, /left join dune\.world_partition wp on wp\.partition_id = a\.partition_id/);
  assert.deepEqual(result.rows[0], {
    actor_id: 82,
    map: "HaggaBasin",
    partition_id: 1,
    partitionMap: "Survival_1",
    dimensionIndex: 0
  });
});

test("players query keeps its map fallback when world_partition is unavailable", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.actors", "dune.player_state"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) return { rows: [] };
      if (text.includes("count(distinct dedupe_key)")) return { rows: [{ total_players: 1 }] };
      return { rows: [{ actor_id: 82, map: "HaggaBasin", partition_id: "1", total_count: 1 }] };
    }
  };

  const result = await listPlayers(db);
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors") && !call.text.includes("count(distinct dedupe_key)"));

  assert.doesNotMatch(playerQuery.text, /join dune\.world_partition/);
  assert.match(playerQuery.text, /'' as partition_map/);
  assert.equal(result.rows[0].map, "HaggaBasin");
  assert.equal(result.rows[0].partitionMap, "");
});

test("playtime tracker persists active sessions and closes players no longer online", async () => {
  const calls = [];
  const run = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
    if (text.includes("information_schema.columns")) {
      return { rows: ["account_id", "online_status", "last_login_time"].map((column_name) => ({ column_name })) };
    }
    return { rows: [] };
  };
  const db = { query: run, transaction: async (fn) => fn({ query: run }) };

  await trackPlayerPlaytime(db);

  assert.ok(calls.some((call) => call.text.includes("create table if not exists dune.console_player_playtime")));
  const tick = calls.find((call) => call.text.includes("with currently_online as"));
  assert.ok(tick);
  assert.match(tick.text, /closed_sessions as/);
  assert.match(tick.text, /not exists \(select 1 from currently_online/);
  assert.match(tick.text, /on conflict \(account_id\) do update/);
  assert.match(tick.text, /ps\.last_login_time as session_login_at/);
});

test("playtime tracker remains compatible without a session login timestamp", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        return { rows: ["account_id", "online_status"].map((column_name) => ({ column_name })) };
      }
      return { rows: [] };
    }
  };

  await trackPlayerPlaytime(db);
  const tick = calls.find((call) => call.text.includes("with currently_online as"));
  assert.match(tick.text, /null::timestamp with time zone as session_login_at/);
});

test("storage discovery includes verified developer storage containers", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: false }] };
      if (text.includes("information_schema.columns")) return { rows: [] };
      return { rows: [] };
    }
  };

  await listStorage(db);
  await liveMapStorage(db);

  const storageQueries = calls.filter((call) => call.text.includes("p.building_type in"));
  assert.equal(storageQueries.length, 2);
  for (const query of storageQueries) {
    assert.match(query.text, /Developer_StorageContainer_Placeable/);
  }
});

test("players query excludes the reserved fresh-install GM identity from rows and totals", async () => {
  const calls = [];
  const db = {
    query: async (text) => {
      calls.push(text);
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "online_status" }] };
      if (text.includes("count(distinct dedupe_key)")) return { rows: [{ total_players: 0 }] };
      return { rows: [{ actor_id: null, total_count: 0 }] };
    }
  };

  const result = await listPlayers(db);
  const playerQueries = calls.filter((text) => text.includes("from dune.actors"));
  assert.equal(playerQueries.length, 2);
  for (const query of playerQueries) {
    assert.match(query, /a\.id <> 900000103::bigint/);
  }
  assert.deepEqual(result.rows, []);
  assert.equal(result.totalCount, 0);
  assert.equal(result.totalPlayers, 0);
});

test("players query falls back to validated encrypted account identities", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        if (values[1] === "player_state") return { rows: [{ column_name: "online_status" }] };
        if (values[1] === "encrypted_accounts") {
          return { rows: ["id", "user", "encrypted_funcom_id"].map((column_name) => ({ column_name })) };
        }
        return { rows: [] };
      }
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("count(distinct dedupe_key)")) return { rows: [{ total_players: 1 }] };
      return { rows: [{
        actor_id: 82,
        player_pawn_id: 82,
        account_id: 276,
        character_name: "Vixen",
        funcom_id: "Vixen#1234",
        fls_id: "254A06043E9F0B16",
        action_player_id: "254A06043E9F0B16",
        total_count: 1
      }] };
    }
  };

  const result = await listPlayers(db);
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors") && !call.text.includes("count(distinct dedupe_key)"));
  assert.match(playerQuery.text, /left join dune\.encrypted_accounts ea/);
  assert.match(playerQuery.text, /dune\.decrypt_user_data\(ea\.encrypted_funcom_id\)/);
  assert.match(playerQuery.text, /\^\[A-Fa-f0-9\]\{15,64\}\$/);
  assert.match(playerQuery.text, /\[\[:cntrl:\]\]/);
  assert.equal(result.rows[0].funcom_id, "Vixen#1234");
  assert.equal(result.rows[0].fls_id, "254A06043E9F0B16");
});

test("players query remains compatible when encrypted accounts are unavailable", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: values[0] !== "dune.encrypted_accounts" }] };
      }
      if (text.includes("information_schema.columns")) return { rows: [] };
      if (text.includes("count(distinct dedupe_key)")) return { rows: [{ total_players: 1 }] };
      return { rows: [{ actor_id: 82, funcom_id: "Vixen#1234", fls_id: "254A06043E9F0B16", total_count: 1 }] };
    }
  };

  await listPlayers(db);
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors") && !call.text.includes("count(distinct dedupe_key)"));
  assert.doesNotMatch(playerQuery.text, /encrypted_accounts/);
  assert.doesNotMatch(playerQuery.text, /decrypt_user_data/);
});

test("players query filters stale actor rows when player_state has current pawn id", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: ["player_pawn_id", "last_login_time", "online_status"].map((column_name) => ({ column_name })) };
      return { rows: [{ actor_id: 78, player_pawn_id: 78, account_id: 2, character_name: "RedBlink", map: "HaggaBasin", online_status: "Online", total_count: 1 }] };
    }
  };

  const result = await listPlayers(db, { status: "online" });
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors"));
  assert.ok(playerQuery);
  assert.match(playerQuery.text, /ps\.player_pawn_id = a\.id/);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].actor_id, 78);
});

test("listPlayers with includeTotals false skips the unfiltered totals query and omits totalPlayers", async () => {
  const calls = [];
  const db = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "online_status" }] };
      return { rows: [{ actor_id: 1, total_count: 1 }] };
    }
  };
  const result = await listPlayers(db, { includeTotals: false });
  assert.equal(calls.find((call) => call.text.includes("count(distinct dedupe_key)")), undefined,
    "unfiltered totals query must not run when includeTotals is false");
  assert.equal(result.totalPlayers, undefined);
  assert.equal(result.totalCount, 1);
});

test("listPlayers preserves the filtered total when the requested page is empty", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "online_status" }] };
      if (text.includes("count(distinct dedupe_key)")) return { rows: [{ total_players: 12 }] };
      return { rows: [{ actor_id: null, total_count: 12 }] };
    }
  };

  const result = await listPlayers(db, { page: 3, pageSize: 5 });
  assert.equal(result.totalCount, 12);
  assert.equal(result.totalPlayers, 12);
  assert.deepEqual(result.rows, []);
});

test("listVehicles returns vehicles with mapped modules and shared_with", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("total_vehicles")) return { rows: [{ total_vehicles: 3 }] };
      if (text.includes("module_durability")) return { rows: [{
        id: "5001",
        name: "Sihaya",
        type: "Sandbike",
        owner: "Duncan_Idaho",
        condition_percent: 92,
        current_fuel: "61",
        max_fuel: "100",
        fuel_percent: 61,
        map: "HaggaBasin",
        partition_id: 1,
        x: "1", y: "2", z: "3",
        total_count: 3,
        modules: [{ templateId: "GeneratorModule", condition: "440", maxCondition: "500", conditionPercent: 88 }],
        shared_with: [{ name: "Gurney_H", rank: 2 }]
      }] };
      return { rows: [] };
    }
  };
  const result = await listVehicles(db, { page: 0, pageSize: 50 });
  assert.equal(result.capabilities.vehicles, true);
  assert.equal(result.totalCount, 3);
  assert.equal(result.totalVehicles, 3);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, "Sihaya");
  assert.equal(result.rows[0].type, "Sandbike");
  assert.equal(result.rows[0].owner, "Duncan_Idaho");
  assert.equal(result.rows[0].partition_id, 1);
  assert.deepEqual(result.rows[0].shared_with, [{ name: "Gurney_H", rank: 2, label: "Co-Owner" }]);
  assert.equal(result.rows[0].modules.length, 1);
  assert.equal(typeof result.rows[0].modules[0].name, "string");
  assert.equal(result.rows[0].total_count, undefined);
});

test("listVehicles filters a player's owned and shared vehicles and labels access", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("coalesce(ps.player_controller_id")) return { rows: [{ actor_id: 42, account_id: 77, controller_id: 88, player_state_id: 99, online_status: "Offline" }] };
      if (text.includes("total_vehicles")) return { rows: [{ total_vehicles: 12 }] };
      if (text.includes("module_durability")) return { rows: [{
        id: "5001", name: "Sihaya", type: "Sandbike", owner: "Duncan_Idaho", relationship: "Co-Owner",
        condition_percent: 92, current_fuel: null, max_fuel: null, fuel_percent: null,
        map: "HaggaBasin", partition_id: 1, x: null, y: null, z: null,
        total_count: 1, modules: [], shared_with: []
      }] };
      return { rows: [] };
    }
  };

  const result = await listVehicles(db, { playerId: "42", pageSize: 200 });
  const mainQuery = calls.find((call) => call.text.includes("module_durability"));
  assert.equal(result.totalCount, 1);
  assert.equal(result.rows[0].relationship, "Co-Owner");
  assert.deepEqual(mainQuery.values.slice(0, 2), [77, 88]);
  assert.match(mainQuery.text, /vc\.owner_account_id=\$1 or viewer\.rank is not null/);
  assert.match(mainQuery.text, /par\.player_id=\$2/);
});

test("listVehicles resolves positional locomotion module names from the catalog", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("total_vehicles")) return { rows: [{ total_vehicles: 1 }] };
      if (text.includes("module_durability")) return { rows: [{
        id: "1", name: "Buggy", type: "Buggy", owner: "", condition_percent: 100,
        current_fuel: null, max_fuel: null, fuel_percent: null,
        map: "HaggaBasin", partition_id: 1, x: null, y: null, z: null,
        total_count: 1, shared_with: [],
        modules: [
          { templateId: "BuggyLocomotionBackLeft_5", condition: 100, maxCondition: 100, conditionPercent: 100 },
          { templateId: "SandbikeLocomotionBackCenter_2", condition: 50, maxCondition: 100, conditionPercent: 50 },
          { templateId: "OrnithopterMediumLocomotionCenterRight_5", condition: 90, maxCondition: 100, conditionPercent: 90 }
        ]
      }] };
      return { rows: [] };
    }
  };
  const result = await listVehicles(db, {});
  const names = result.rows[0].modules.map((module) => module.name);
  // Positional ids have no direct catalog entry; the base vehicle+tier name is
  // resolved and the mounting position appended — no raw template ids leak through.
  assert.deepEqual(names, [
    "Buggy Tread Mk5 (Back Left)",
    "Sandbike Tread Mk2 (Back Center)",
    "Assault Ornithopter Wing Mk5 (Center Right)"
  ]);
});

test("listVehicles labels a vehicle with its nearest-marker sub-region", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("total_vehicles")) return { rows: [{ total_vehicles: 1 }] };
      if (text.includes("from dune.map_names where map_name")) return { rows: [{ map_name_id: 11 }] };
      if (text.includes("cross join lateral") && text.includes("dune.markers")) {
        return { rows: [{ id: "5001", area_id: 3 }] };
      }
      if (text.includes("module_durability")) return { rows: [{
        id: "5001", name: "Sihaya", type: "Sandbike", owner: "", condition_percent: 90,
        current_fuel: null, max_fuel: null, fuel_percent: null,
        map: "HaggaBasin", partition_id: 1, x: "323137", y: "-24360", z: "0",
        total_count: 1, shared_with: [], modules: []
      }] };
      return { rows: [] };
    }
  };
  const result = await listVehicles(db, {});
  // area_id 3 resolves to "Hagga Rift" via runtime/data/hagga-regions.json.
  assert.equal(result.rows[0].region, "Hagga Rift");
});

test("listVehicles returns unsupported when a required table is missing", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: !String(values[0] || "").includes("vehicle_modules") }] };
      }
      return { rows: [] };
    }
  };
  const result = await listVehicles(db, {});
  assert.equal(result.capabilities.vehicles, false);
  assert.equal(result.totalCount, 0);
  assert.equal(result.totalVehicles, 0);
  assert.deepEqual(result.rows, []);
  assert.match(result.reason, /vehicle_modules/);
});

test("listVehicles preserves the filtered total when the requested page is empty", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("total_vehicles")) return { rows: [{ total_vehicles: 9 }] };
      // Out-of-range page: the LATERAL yields an all-NULL placeholder row, but
      // total_count still comes from the separate totals CTE.
      if (text.includes("module_durability")) return { rows: [{ id: null, total_count: 9, shared_with: null, modules: null }] };
      return { rows: [] };
    }
  };
  const result = await listVehicles(db, { page: 5, pageSize: 5 });
  assert.equal(result.totalCount, 9);
  assert.equal(result.totalVehicles, 9);
  assert.deepEqual(result.rows, []);
});

test("listVehicles parameterizes the search term", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("total_vehicles")) return { rows: [{ total_vehicles: 0 }] };
      if (text.includes("module_durability")) return { rows: [] };
      return { rows: [] };
    }
  };
  const injection = "Sihaya'; drop table dune.vehicles; --";
  await listVehicles(db, { q: injection });
  const mainQuery = calls.find((call) => call.text.includes("module_durability"));
  assert.ok(mainQuery.values.includes(`%${injection}%`));
  assert.ok(mainQuery.values.includes(injection));
  assert.ok(!mainQuery.text.includes(injection));
  assert.match(mainQuery.text, /ilike \$\d/);
});

test("vehicle pages and player portal share conservative health calculations", async () => {
  const listCalls = [];
  const listDb = {
    query: async (text, values = []) => {
      listCalls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("total_vehicles")) return { rows: [{ total_vehicles: 0 }] };
      return { rows: [] };
    }
  };
  await listVehicles(listDb, {});
  const listQuery = listCalls.find((call) => call.text.includes("module_observed"));

  const portalCalls = [];
  await portalVehicles({ query: async (text, values = []) => { portalCalls.push({ text, values }); return { rows: [] }; } }, [42]);
  const portalQuery = portalCalls[0];

  for (const query of [listQuery, portalQuery]) {
    assert.match(query.text, /count\(own_current\) over\(partition by template_id\)/);
    assert.match(query.text, /case when current_samples >= 2 then observed_max else null end/);
    assert.match(query.text, /own_current current_durability/);
    assert.doesNotMatch(query.text, /coalesce\([^\n]*own_current[^\n]*,\s*0\)/);
    assert.match(query.text, /count\(current_fuel\)::int fuel_samples/);
  }
  assert.match(portalQuery.text, /min\(case when vm\.current_durability is not null/);
  assert.match(listQuery.text, /min\(case when md\.current_durability is not null/);
  assert.match(listQuery.text, /'conditionPercent', case when md\.current_durability is not null/);
});

test("portalVehicleDisplayName maps known classes and passes unmapped ones through", () => {
  // Real class strings carry a path/prefix; the substring match still resolves.
  assert.equal(portalVehicleDisplayName("DA_Vehicle_LightOrnithopter_C"), "Scout Ornithopter");
  assert.equal(portalVehicleDisplayName("MediumOrnithopter"), "Assault Ornithopter");
  assert.equal(portalVehicleDisplayName("TransportOrnithopter"), "Carrier Ornithopter");
  assert.equal(portalVehicleDisplayName("SandCrawler"), "Sandcrawler");
  assert.equal(portalVehicleDisplayName("Sandbike_T3"), "Sandbike");
  assert.equal(portalVehicleDisplayName("AssaultBuggy"), "Buggy");
  assert.equal(portalVehicleDisplayName("AssaultTank"), "Battle Tank");
  // First substring match wins: "transportornithopter" contains "ornithopter"
  // but must resolve to Carrier, not fall through.
  assert.equal(portalVehicleDisplayName("TransportOrnithopterHeavy"), "Carrier Ornithopter");
  // Unmapped class passes through unchanged; empty resolves to the generic label.
  assert.equal(portalVehicleDisplayName("Skiff"), "Skiff");
  assert.equal(portalVehicleDisplayName(""), "Vehicle");
  assert.equal(portalVehicleDisplayName(null), "Vehicle");
});

test("listPlayers reports statusFilterApplied based on online_status column presence", async () => {
  const mockDb = (columns) => ({
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: columns.map((column_name) => ({ column_name })) };
      return { rows: [{ actor_id: 1, total_count: 1, total_players: 1 }] };
    }
  });
  const withColumn = await listPlayers(mockDb(["online_status"]), {});
  assert.equal(withColumn.capabilities.statusFilterApplied, true);
  const withoutColumn = await listPlayers(mockDb([]), {});
  assert.equal(withoutColumn.capabilities.statusFilterApplied, false);
});

test("players query marks and filters persistent bans by parameterized FLS ID", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) return { rows: [{ column_name: "online_status" }] };
      return { rows: [{ actor_id: 82, fls_id: "254A06043E9F0B16", actual_online_status: "Online", online_status: "Banned", is_banned: true, total_count: 1 }] };
    }
  };
  const bannedId = "254A06043E9F0B16";
  const result = await listPlayers(db, { status: "banned", bannedFlsIds: [bannedId, "not-an-id"] });
  const playerQuery = calls.find((call) => call.text.includes("from dune.actors"));
  assert.deepEqual(playerQuery.values[0], [bannedId.toLowerCase()]);
  assert.match(playerQuery.text, /lower\(.+\) = any\(\$1::text\[\]\)/s);
  assert.match(playerQuery.text, /then 'Banned'/);
  assert.equal(result.rows[0].online_status, "Banned");
  assert.equal(result.rows[0].actual_online_status, "Online");
  assert.equal(result.capabilities.banFilterApplied, true);
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

test("addon player identities expose the narrow identity shape in one platform lookup", async () => {
  let platformLookups = 0;
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.actors", "dune.player_state", "dune.accounts"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "player_state") return { rows: ["player_pawn_id", "online_status"].map((column_name) => ({ column_name })) };
        if (table === "accounts") return { rows: ["id", "platform_id", "platform_name"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      if (text.includes("from dune.actors a")) {
        return { rows: [
          { actor_id: 101, player_pawn_id: 101, account_id: 201, character_name: "Test One", player_controller_id: 301, funcom_id: "TestOne#1234", fls_id: "72BBAAAC39232A68", map: "Survival_1", online_status: "Online", last_seen: "" },
          { actor_id: 102, player_pawn_id: 102, account_id: 202, character_name: "Test Two", player_controller_id: 302, funcom_id: "TestTwo#5678", fls_id: "72BBAAAC39232A69", map: "Overmap", online_status: "Offline", last_seen: "" }
        ] };
      }
      if (text.includes("from dune.accounts") && text.includes("where id = any")) {
        platformLookups += 1;
        assert.deepEqual(values, [["201", "202"]]);
        return { rows: [
          { account_id: "201", platform_id: "76561198000000001", platform_name: "Steam" },
          { account_id: "202", platform_id: "76561198000000002", platform_name: "Steam" }
        ] };
      }
      return { rows: [] };
    }
  };

  const result = await addonPlayerIdentities(db);
  assert.deepEqual(result.capabilities, { players: true, identities: true });
  assert.equal(platformLookups, 1);
  assert.deepEqual(result.rows, [
    {
      actorId: "101", controllerId: "301", accountId: "201", name: "Test One",
      funcomId: "TestOne#1234", flsId: "72BBAAAC39232A68",
      platformId: "76561198000000001", platformName: "Steam", status: "Online", map: "Survival_1"
    },
    {
      actorId: "102", controllerId: "302", accountId: "202", name: "Test Two",
      funcomId: "TestTwo#5678", flsId: "72BBAAAC39232A69",
      platformId: "76561198000000002", platformName: "Steam", status: "Offline", map: "Overmap"
    }
  ]);
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

test("listGuilds preserves the filtered total when the requested page is empty", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: String(values[0] || "") === "dune.guilds" }] };
      }
      if (text.includes("information_schema.columns")) {
        return { rows: ["guild_id", "guild_name"].map((column_name) => ({ column_name })) };
      }
      if (text.includes("total_guilds")) return { rows: [{ total_guilds: 12 }] };
      return { rows: [{ guild_id: null, total_count: 12 }] };
    }
  };

  const result = await listGuilds(db, { page: 3, pageSize: 5 });
  assert.equal(result.totalCount, 12);
  assert.equal(result.totalGuilds, 12);
  assert.deepEqual(result.rows, []);
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
  assert.equal(guildQuery.values[0], "%Water%");
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

function okRows(rows) {
  return { rows, rowCount: rows.length };
}

function guildMutationDb(calls, fixtures = {}) {
  const db = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return okRows([{ exists: true }]);
      if (text.includes("to_regprocedure")) return okRows([{ exists: true }]);
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        if (table === "guilds") return okRows((fixtures.guildColumns || ["guild_id", "guild_name"]).map((column_name) => ({ column_name })));
        if (table === "guild_members") return okRows((fixtures.memberColumns || ["guild_id", "player_id", "role_id"]).map((column_name) => ({ column_name })));
        return okRows([]);
      }
      if (text.includes("from dune.guilds where guild_id = $1 for update")) {
        return fixtures.guildRows === null ? okRows([]) : okRows(fixtures.guildRows || [{ guild_id: 1, guild_name: "Spicy Girls" }]);
      }
      if (text.includes("from dune.guild_members where guild_id = $1 and player_id = $2 for update")) {
        return fixtures.memberRows === null ? okRows([]) : okRows(fixtures.memberRows || [{ role_id: "1" }]);
      }
      if (text.includes("select player_id from dune.guild_members where guild_id = $1 and role_id = $2")) {
        return okRows(fixtures.previousLeaderRows || [{ player_id: "10" }]);
      }
      if (text.includes("dune.promote_guild_member(")) {
        if (fixtures.promoteError) throw new Error(fixtures.promoteError);
        return okRows([]);
      }
      if (text.includes("dune.demote_guild_member(")) {
        if (fixtures.demoteError) throw new Error(fixtures.demoteError);
        return okRows([]);
      }
      if (text.includes("from dune.actors a")) {
        return okRows(fixtures.playerRows || [{ actor_id: 40, account_id: 44, controller_id: 41, player_state_id: 5, online_status: "Offline" }]);
      }
      if (text.includes("dune.add_guild_member(")) {
        if (fixtures.addError) throw new Error(fixtures.addError);
        return okRows([]);
      }
      if (text.includes("dune.remove_guild_members(")) {
        if (fixtures.removeError) throw new Error(fixtures.removeError);
        return okRows([]);
      }
      if (text.includes("select count(*)::int as count from dune.guild_members where guild_id = $1")) {
        return okRows([{ count: fixtures.memberCount ?? 3 }]);
      }
      if (text.includes("dune.disband_guild(")) {
        if (fixtures.disbandError) throw new Error(fixtures.disbandError);
        return okRows([]);
      }
      return okRows([]);
    },
    async transaction(fn) {
      return fn(db);
    }
  };
  return db;
}

test("guild promotion bumps a member to officer without touching the leader", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberRows: [{ role_id: "1" }] });
  const result = await promoteGuildMember(db, 1, 20);
  assert.equal(result.ok, true);
  assert.equal(result.newRoleId, 50);
  assert.equal(result.previousLeaderId, null);
  const promote = calls.find((call) => call.text.includes("dune.promote_guild_member("));
  assert.ok(promote);
  assert.deepEqual(promote.values, [1, 20, 50]);
  // A plain member-to-officer bump never needs to know who the current leader is.
  assert.ok(!calls.some((call) => call.text.includes("select player_id from dune.guild_members where guild_id = $1 and role_id = $2")));
});

test("guild promotion bumps an officer to leader and demotes the previous leader", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberRows: [{ role_id: "50" }], previousLeaderRows: [{ player_id: "10" }] });
  const result = await promoteGuildMember(db, 1, 20);
  assert.equal(result.ok, true);
  assert.equal(result.newRoleId, 100);
  assert.equal(result.previousLeaderId, "10");
  const promote = calls.find((call) => call.text.includes("dune.promote_guild_member("));
  assert.ok(promote);
  assert.deepEqual(promote.values, [1, 20, 100]);
});

test("guild promotion is a no-op when the target is already the leader", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberRows: [{ role_id: "100" }] });
  const result = await promoteGuildMember(db, 1, 20);
  assert.equal(result.alreadyLeader, true);
  assert.ok(!calls.some((call) => call.text.includes("dune.promote_guild_member(")));
});

test("guild promotion rejects when the guild does not exist", async () => {
  const db = guildMutationDb([], { guildRows: [] });
  await assert.rejects(() => promoteGuildMember(db, 1, 20), /was not found/);
});

test("guild promotion rejects when the player is not a guild member", async () => {
  const db = guildMutationDb([], { memberRows: [] });
  await assert.rejects(() => promoteGuildMember(db, 1, 20), /is not a member/);
});

test("guild promotion reports unsupported capability when schema functions are absent", async () => {
  const db = { query: async (text) => text.includes("to_regclass") ? okRows([{ exists: false }]) : okRows([]) };
  await assert.rejects(() => promoteGuildMember(db, 1, 20), UnsupportedCapabilityError);
});

test("guild promotion reports unsupported capability when guild_members lacks the expected columns", async () => {
  const db = guildMutationDb([], { memberColumns: ["guild_id", "role_id"] }); // missing player_id
  await assert.rejects(() => promoteGuildMember(db, 1, 20), UnsupportedCapabilityError);
});

test("guild demotion downgrades an officer to member", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberRows: [{ role_id: "50" }] });
  const result = await demoteGuildMember(db, 1, 20);
  assert.equal(result.ok, true);
  const demote = calls.find((call) => call.text.includes("dune.demote_guild_member("));
  assert.ok(demote);
  assert.deepEqual(demote.values, [1, 20, 1]);
});

test("guild demotion rejects the guild leader without calling the database function", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberRows: [{ role_id: "100" }] });
  await assert.rejects(() => demoteGuildMember(db, 1, 20), /is the guild leader/);
  assert.ok(!calls.some((call) => call.text.includes("dune.demote_guild_member(")));
});

test("guild demotion rejects a plain member who cannot be demoted further", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberRows: [{ role_id: "1" }] });
  await assert.rejects(() => demoteGuildMember(db, 1, 20), /already a Member/);
  assert.ok(!calls.some((call) => call.text.includes("dune.demote_guild_member(")));
});

test("guild demotion rejects when the guild does not exist", async () => {
  const db = guildMutationDb([], { guildRows: [] });
  await assert.rejects(() => demoteGuildMember(db, 1, 20), /was not found/);
});

test("guild demotion rejects when the player is not a member", async () => {
  const db = guildMutationDb([], { memberRows: [] });
  await assert.rejects(() => demoteGuildMember(db, 1, 20), /is not a member/);
});

test("guild demotion reports unsupported capability when schema functions are absent", async () => {
  const db = { query: async (text) => text.includes("to_regclass") ? okRows([{ exists: false }]) : okRows([]) };
  await assert.rejects(() => demoteGuildMember(db, 1, 20), UnsupportedCapabilityError);
});

test("guild add member resolves the player and passes a one-guild-per-player cap", async () => {
  const calls = [];
  const db = guildMutationDb(calls);
  const result = await addGuildMember(db, 1, 40, 50);
  assert.equal(result.ok, true);
  const add = calls.find((call) => call.text.includes("dune.add_guild_member("));
  assert.ok(add);
  const advisoryLockIndex = calls.findIndex((call) => call.text.includes("guilds_get_exclusive_operation_lock"));
  const guildRowLockIndex = calls.findIndex((call) => call.text.includes("from dune.guilds where guild_id = $1 for update"));
  assert.ok(advisoryLockIndex >= 0 && advisoryLockIndex < guildRowLockIndex);
  // dune.add_guild_member(in_player_id, in_guild_id, ...) -- player id first, then guild id.
  assert.deepEqual(add.values, [41, 1, 50, 1, 32, 3]);
});

test("guild add member enforces the configured capacity before invoking the game function", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberCount: 48 });
  await assert.rejects(() => addGuildMember(db, 1, 40, 1, 48), /configured maximum of 48 members/);
  assert.ok(!calls.some((call) => call.text.includes("dune.add_guild_member(")));
});

test("guild add member passes a custom configured capacity to the game function", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberCount: 47 });
  await addGuildMember(db, 1, 40, 1, 48);
  const add = calls.find((call) => call.text.includes("dune.add_guild_member("));
  assert.deepEqual(add.values, [41, 1, 1, 1, 48, 3]);
});

test("guild add member surfaces a friendly error when the player is already in a guild", async () => {
  const db = guildMutationDb([], { addError: "Cannot insert more than 1 guild entries for each user." });
  await assert.rejects(() => addGuildMember(db, 1, 40, 1), /already in a guild/);
});

test("guild add member surfaces a friendly error when the guild does not exist", async () => {
  const db = guildMutationDb([], { addError: "Trying to add user to non existing guild 1." });
  await assert.rejects(() => addGuildMember(db, 1, 40, 1), /was not found/);
});

test("guild add member surfaces a friendly error when factions are incompatible", async () => {
  const db = guildMutationDb([], { addError: "Trying to add user to with non compatible. player faction: 1, guild faction: 2" });
  await assert.rejects(() => addGuildMember(db, 1, 40, 1), /faction is not compatible/);
});

test("guild add member reports unsupported capability when schema functions are absent", async () => {
  const db = { query: async (text) => text.includes("to_regclass") ? okRows([{ exists: false }]) : okRows([]) };
  await assert.rejects(() => addGuildMember(db, 1, 40, 1), UnsupportedCapabilityError);
});

test("guild remove member deletes a non-leader", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberRows: [{ role_id: "50" }] });
  const result = await removeGuildMember(db, 1, 20);
  assert.equal(result.ok, true);
  const remove = calls.find((call) => call.text.includes("dune.remove_guild_members("));
  assert.ok(remove);
  assert.deepEqual(remove.values, [[20], 1, 0]);
});

test("guild remove member rejects removing the leader without calling the database function", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberRows: [{ role_id: "100" }] });
  await assert.rejects(() => removeGuildMember(db, 1, 20), /is the guild leader/);
  assert.ok(!calls.some((call) => call.text.includes("dune.remove_guild_members(")));
});

test("guild remove member rejects when the guild does not exist", async () => {
  const db = guildMutationDb([], { guildRows: [] });
  await assert.rejects(() => removeGuildMember(db, 1, 20), /was not found/);
});

test("guild remove member rejects when the player is not a member", async () => {
  const db = guildMutationDb([], { memberRows: [] });
  await assert.rejects(() => removeGuildMember(db, 1, 20), /is not a member/);
});

test("guild remove member reports unsupported capability when schema functions are absent", async () => {
  const db = { query: async (text) => text.includes("to_regclass") ? okRows([{ exists: false }]) : okRows([]) };
  await assert.rejects(() => removeGuildMember(db, 1, 20), UnsupportedCapabilityError);
});

test("guild disband delegates to the game function and reports the member count it removed", async () => {
  const calls = [];
  const db = guildMutationDb(calls, { memberCount: 5 });
  const result = await disbandGuild(db, 1);
  assert.equal(result.ok, true);
  assert.equal(result.guildName, "Spicy Girls");
  assert.equal(result.memberCount, 5);
  const disband = calls.find((call) => call.text.includes("dune.disband_guild("));
  assert.ok(disband);
  assert.deepEqual(disband.values, [1]);
  // guild_members rows cascade away with the guilds row via guild_members_guild_id_fkey
  // (ON DELETE CASCADE), so we must not issue a redundant delete of our own.
  assert.ok(
    !calls.some((call) => call.text.includes("delete from dune.guild_members")),
    "expected no manual guild_members delete -- the FK cascade already removes those rows"
  );
  // The member count is read before the disband, so the reported total isn't always zero.
  const count = calls.find((call) => call.text.includes("count(*)::int as count from dune.guild_members"));
  assert.ok(count);
  assert.ok(calls.indexOf(count) < calls.indexOf(disband));
});

test("guild disband rejects when the guild does not exist", async () => {
  const db = guildMutationDb([], { guildRows: [] });
  await assert.rejects(() => disbandGuild(db, 1), /was not found/);
});

test("guild disband reports unsupported capability when schema functions are absent", async () => {
  const db = { query: async (text) => text.includes("to_regclass") ? okRows([{ exists: false }]) : okRows([]) };
  await assert.rejects(() => disbandGuild(db, 1), UnsupportedCapabilityError);
});

test("guild disband reports unsupported capability when dune.guilds lacks the expected columns", async () => {
  const db = guildMutationDb([], { guildColumns: ["guild_id"] }); // missing guild_name
  await assert.rejects(() => disbandGuild(db, 1), UnsupportedCapabilityError);
});

const BASE_REQUIRED_TABLES = ["dune.buildings", "dune.building_instances", "dune.actor_fgl_entities", "dune.actors"];

test("list bases returns capability response when required tables are missing", async () => {
  const db = {
    query: async () => ({ rows: [{ exists: false }] })
  };
  const result = await listBases(db, {});
  assert.equal(result.capabilities.bases, false);
  assert.match(result.reason, /dune\.buildings/);
});

test("list bases returns rows with piece and placeable counts and a total count", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "5", total_pieces: "700", total_placeables: "140" }] };
      }
      if (text.includes("from paged p")) {
        return { rows: [
          { base_id: "1006", name: "Sietch One", base_type: "Sub-Fief", owner_name: "Leader One", map: "TheDeepDesert", partition_id: "8", x: "100", y: "200", z: "30", total_count: "1", piece_count: "589", placeable_count: "126", shared_with: [{ name: "Ally Two", rank: 2 }] }
        ] };
      }
      return { rows: [] };
    }
  };
  const result = await listBases(db, {});
  assert.equal(result.capabilities.bases, true);
  assert.equal(result.totalCount, 1);
  assert.equal(result.totalBases, 5);
  assert.equal(result.totalPieces, 700);
  assert.equal(result.totalPlaceables, 140);
  assert.deepEqual(result.rows, [
    // partitionMap/dimensionIndex are empty here because this fake db reports
    // no dune.world_partition -- the guarded branch, not a missing value.
    { base_id: "1006", name: "Sietch One", base_type: "Sub-Fief", owner_name: "Leader One", map: "TheDeepDesert", partition_id: 8, partitionMap: "", dimensionIndex: 0, x: 100, y: 200, z: 30, piece_count: 589, placeable_count: 126, shared_with: [{ name: "Ally Two", rank: 2, label: "Co-Owner" }], generatorDataAvailable: true, generatorCount: 0, fuelCells: 0, generatorRuntimeSeconds: 0, generatorUptimeMultiplier: 1, generatorUptimeEventLabel: "", generatorUptimeEventEndsAt: "", generatorUnstockedCount: 0, generatorAllUnstocked: false, generators: [] }
  ]);
});

test("list bases reports the baseChildAccess capability from the required tables and function", async () => {
  const childAccessTables = new Set([...BASE_REQUIRED_TABLES, "dune.placeables", "dune.permission_actor"]);
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: childAccessTables.has(String(values[0] || "")) }] };
      if (text.includes("to_regprocedure")) {
        return { rows: [{ exists: values[0] === "dune.permission_set_access_level(bigint,smallint)" }] };
      }
      if (text.includes("total_bases")) return { rows: [{ total_bases: "0", total_pieces: "0", total_placeables: "0" }] };
      return { rows: [] };
    }
  };
  const result = await listBases(db, {});
  assert.equal(result.capabilities.baseChildAccess, true);
});

test("list bases reports baseChildAccess false when the game function is missing", async () => {
  const childAccessTables = new Set([...BASE_REQUIRED_TABLES, "dune.placeables", "dune.permission_actor"]);
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: childAccessTables.has(String(values[0] || "")) }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: false }] };
      if (text.includes("total_bases")) return { rows: [{ total_bases: "0", total_pieces: "0", total_placeables: "0" }] };
      return { rows: [] };
    }
  };
  const result = await listBases(db, {});
  assert.equal(result.capabilities.baseChildAccess, false);
});

test("list bases scopes player results to owned and shared permission actors", async () => {
  const calls = [];
  const scopedTables = new Set([
    ...BASE_REQUIRED_TABLES,
    "dune.permission_actor",
    "dune.permission_actor_rank",
    "dune.player_state"
  ]);
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: scopedTables.has(String(values[0] || "")) }] };
      if (text.includes("ps.player_controller_id") && text.includes("a.class ilike '%PlayerCharacter%'")) {
        return { rows: [{ actor_id: 42, account_id: 600, controller_id: 777, player_state_id: 800, online_status: "Offline" }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "2", total_owned: "1", total_shared: "1", total_pieces: "20", total_placeables: "8" }] };
      }
      if (text.includes("from paged p")) {
        return { rows: [{
          base_id: "4102", name: "Shared Workshop", base_type: "Sub-Fief", owner_name: "Stilgar",
          viewer_rank: 3, map: "HaggaBasin", partition_id: "1", x: "10", y: "20", z: "30",
          total_count: "2", piece_count: "10", placeable_count: "4", shared_with: [{ name: "Chani", rank: 3 }]
        }] };
      }
      if (text.includes("to_regprocedure")) return { rows: [{ exists: false }] };
      return { rows: [] };
    }
  };

  const result = await listBases(db, { playerId: "42", pageSize: 5000, includeGenerators: false });

  assert.equal(result.totalBases, 2);
  assert.equal(result.totalOwned, 1);
  assert.equal(result.totalShared, 1);
  assert.equal(result.rows[0].relationship, "Associate");
  const paged = calls.find((call) => call.text.includes("from paged p"));
  const totals = calls.find((call) => call.text.includes("total_bases"));
  assert.match(paged.text, /viewer_par\.permission_actor_id = a\.id and viewer_par\.player_id = \$1/);
  assert.deepEqual(paged.values.slice(0, 1), [777]);
  assert.deepEqual(totals.values, [777]);
});

test("list bases resolves each base's partition to its map instance", async () => {
  // Two bases on one game map but different partitions -- the case a.map alone
  // cannot distinguish, and the reason partitionMap/dimensionIndex exist.
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) || name === "dune.world_partition" }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "2", total_pieces: "20", total_placeables: "8" }] };
      }
      if (text.includes("from paged p")) {
        return { rows: [
          { base_id: "5001", name: "PvP Outpost", base_type: "Sub-Fief", owner_name: "A", map: "DeepDesert", partition_id: "8", partition_map: "DeepDesert_1", dimension_index: "0", x: "1", y: "2", z: "3", total_count: "2", piece_count: "10", placeable_count: "4", shared_with: [] },
          { base_id: "5002", name: "PvE Outpost", base_type: "Sub-Fief", owner_name: "B", map: "DeepDesert", partition_id: "59", partition_map: "DeepDesert_1", dimension_index: "1", x: "4", y: "5", z: "6", total_count: "2", piece_count: "10", placeable_count: "4", shared_with: [] }
        ] };
      }
      return { rows: [] };
    }
  };

  const result = await listBases(db, { includeGenerators: false });

  assert.deepEqual(result.rows.map((row) => [row.base_id, row.map, row.partition_id, row.partitionMap, row.dimensionIndex]), [
    ["5001", "DeepDesert", 8, "DeepDesert_1", 0],
    ["5002", "DeepDesert", 59, "DeepDesert_1", 1]
  ]);
  // The join is only emitted when the optional table is present.
  const paged = calls.find((call) => call.text.includes("from paged p"));
  assert.match(paged.text, /left join dune\.world_partition wp on wp\.partition_id = p\.partition_id/);
});

test("list bases omits the partition join when world_partition is absent", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(String(values[0] || "")) }] };
      }
      if (text.includes("total_bases")) return { rows: [{ total_bases: "0", total_pieces: "0", total_placeables: "0" }] };
      return { rows: [] };
    }
  };

  await listBases(db, { includeGenerators: false });

  const paged = calls.find((call) => call.text.includes("from paged p"));
  assert.ok(!paged.text.includes("dune.world_partition"), "must not join a table this schema does not have");
  assert.match(paged.text, /'' as partition_map/);
});

// The base-backup tool ("pick up base") only deletes permission_actor/
// permission_actor_rank and registers the base's actor ids in
// dune.base_backup_linked_actors -- it leaves buildings/building_instances/
// placeables fully intact, so without this exclusion a picked-up base would
// keep showing up as an ordinary, ownerless base.
//
// Both query strings are asserted because the paged rows and the totals are
// two separate round trips that must describe the same candidate set. They
// are emitted from one baseCandidateSource() helper in duneDb.js, so this is
// now a regression test on that helper reaching both call sites rather than a
// guard against hand-copied clauses drifting apart.
test("list bases excludes unclaimed, backup-linked bases when base_backup_linked_actors exists", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) || name === "dune.base_backup_linked_actors" }] };
      }
      if (text.includes("total_bases")) return { rows: [{ total_bases: "0", total_pieces: "0", total_placeables: "0" }] };
      return { rows: [] };
    }
  };

  await listBases(db, { includeGenerators: false });

  const paged = calls.find((call) => call.text.includes("from matched"));
  assert.match(
    paged.text,
    /not \(pa\.actor_id is null and exists \(select 1 from dune\.base_backup_linked_actors bbla where bbla\.actor_id = a\.id\)\)/
  );
  const totals = calls.find((call) => call.text.includes("valid_claims"));
  assert.match(
    totals.text,
    /not \(pa\.actor_id is null and exists \(select 1 from dune\.base_backup_linked_actors bbla where bbla\.actor_id = a\.id\)\)/,
    "totals must apply the same exclusion so total_bases/total_pieces/total_placeables agree with the paged rows"
  );
});

test("list bases omits the backup exclusion when base_backup_linked_actors is absent", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(String(values[0] || "")) }] };
      }
      if (text.includes("total_bases")) return { rows: [{ total_bases: "0", total_pieces: "0", total_placeables: "0" }] };
      return { rows: [] };
    }
  };

  await listBases(db, { includeGenerators: false });

  const paged = calls.find((call) => call.text.includes("from matched"));
  assert.ok(!paged.text.includes("base_backup_linked_actors"), "must not reference a table this schema does not have");
  const totals = calls.find((call) => call.text.includes("valid_claims"));
  assert.ok(!totals.text.includes("base_backup_linked_actors"));
});

// The SQL path itself (unclaimed AND backup-linked) is proven against real
// PostgreSQL in baseBackup.integration.test.js. This covers only the fast
// path a mocked db can prove cheaply: a schema without the optional table
// skips the query entirely rather than referencing a table that isn't there.
test("baseIsBackedUp short-circuits to false without querying when base_backup_linked_actors is absent", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: false }] };
      throw new Error("must not query further once the capability check reports absent");
    }
  };
  assert.equal(await baseIsBackedUp(db, 3452), false);
  assert.equal(calls.length, 1, "only the to_regclass capability probe should run");
});

test("list bases groups multiple internal building records under one claim actor", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "1", total_pieces: "1265", total_placeables: "133" }] };
      }
      if (text.includes("from paged p")) {
        return { rows: [{
          base_id: "75", name: "Khatovar", base_type: "Advanced Sub-Fief", owner_name: "Drew",
          map: "HaggaBasin", partition_id: "0", x: "-383258", y: "-350339", z: "27278",
          total_count: "1", piece_count: "1265", placeable_count: "133", shared_with: null
        }] };
      }
      return { rows: [] };
    }
  };

  const result = await listBases(db, { includeGenerators: false });
  const listQuery = calls.find((call) => call.text.includes("with matched as"));
  const totalsQuery = calls.find((call) => call.text.includes("with valid_claims as"));
  assert.ok(listQuery.text.includes("select min(b.id) as id"), "the oldest member building id remains the stable public base id");
  assert.match(listQuery.text, /group by a\.id,/);
  assert.doesNotMatch(listQuery.text, /group by b\.id,/);
  assert.match(listQuery.text, /piece_afe\.actor_id = p\.actor_id/);
  assert.match(listQuery.text, /placeable_afe\.actor_id = p\.actor_id/);
  assert.match(totalsQuery.text, /select distinct a\.id as actor_id/);
  assert.equal(result.totalBases, 1);
  assert.equal(result.totalPieces, 1265);
  assert.equal(result.totalPlaceables, 133);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].base_id, "75");
  assert.equal(result.rows[0].piece_count, 1265);
  assert.equal(result.rows[0].placeable_count, 133);
});

test("list bases enriches rows with generator fuel and runtime data", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "1", total_pieces: "589", total_placeables: "126" }] };
      }
      if (text.includes("from paged p")) {
        return { rows: [
          { base_id: "1006", name: "Sietch One", base_type: "Sub-Fief", owner_name: "Leader One", map: "TheDeepDesert", partition_id: "8", x: "100", y: "200", z: "30", total_count: "1", piece_count: "589", placeable_count: "126", shared_with: null }
        ] };
      }
      if (text.includes("from generator_runtime group by")) {
        return { rows: [
          { base_id: "1006", generator_type: "fuel", generator_count: 2, fuel_cells: 10, runtime_seconds: 36000, unstocked_count: 0 }
        ] };
      }
      return { rows: [] };
    }
  };
  const result = await listBases(db, {});
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].generatorDataAvailable, true);
  assert.equal(result.rows[0].generatorCount, 2);
  assert.equal(result.rows[0].fuelCells, 10);
  assert.equal(result.rows[0].generatorRuntimeSeconds, 36000);
  assert.equal(result.rows[0].generatorUnstockedCount, 0);
  assert.equal(result.rows[0].generatorAllUnstocked, false);
  assert.deepEqual(result.rows[0].generators, [
    { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 10, generatorCount: 2, runtimeSeconds: 36000, unstockedCount: 0 }
  ]);
});

test("list bases still returns rows when the generator query fails", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "1", total_pieces: "589", total_placeables: "126" }] };
      }
      if (text.includes("from paged p")) {
        return { rows: [
          { base_id: "1006", name: "Sietch One", base_type: "Sub-Fief", owner_name: "Leader One", map: "TheDeepDesert", partition_id: "8", x: "100", y: "200", z: "30", total_count: "1", piece_count: "589", placeable_count: "126", shared_with: null }
        ] };
      }
      // A schema drift or timeout in the generator CTE must preserve the base
      // list and mark generator data unavailable.
      if (text.includes("from generator_runtime group by")) throw new Error("relation \"dune.farm_variables\" does not exist");
      return { rows: [] };
    }
  };
  const result = await listBases(db, {});
  assert.equal(result.capabilities.bases, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].base_id, "1006");
  assert.equal(result.rows[0].piece_count, 589);
  assert.equal(result.rows[0].generatorDataAvailable, false);
  assert.equal(result.rows[0].generatorCount, 0);
  assert.equal(result.rows[0].fuelCells, 0);
  assert.equal(result.rows[0].generatorRuntimeSeconds, 0);
  assert.equal(result.rows[0].generatorUnstockedCount, 0);
  assert.deepEqual(result.rows[0].generators, []);
});

test("list bases skips the generator query when includeGenerators is false", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push(text);
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "1", total_pieces: "589", total_placeables: "126" }] };
      }
      if (text.includes("from paged p")) {
        return { rows: [
          { base_id: "1006", name: "Sietch One", base_type: "Sub-Fief", owner_name: "Leader One", map: "TheDeepDesert", partition_id: "8", x: "100", y: "200", z: "30", total_count: "1", piece_count: "589", placeable_count: "126", shared_with: null }
        ] };
      }
      return { rows: [] };
    }
  };
  // The Discord player portal resolves generator fuel itself for just the
  // player's bases, so listBases must not run the same CTE for all 200.
  const result = await listBases(db, { includeGenerators: false });
  assert.ok(!calls.some((text) => text.includes("from generator_runtime group by")), "generator query must not run when opted out");
  assert.equal(result.rows[0].generatorDataAvailable, false);
  assert.equal(result.rows[0].generatorCount, 0);
  assert.deepEqual(result.rows[0].generators, []);
});

test("list bases excludes the owner from shared_with, coalesces missing entries, and labels unmapped ranks", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "2", total_pieces: "601", total_placeables: "126" }] };
      }
      if (text.includes("from paged p")) {
        return { rows: [
          { base_id: "1006", name: "Sietch One", base_type: "Sub-Fief", owner_name: "Leader One", map: "TheDeepDesert", x: "100", y: "200", z: "30", total_count: "2", piece_count: "589", placeable_count: "126", shared_with: [{ name: "Ally Two", rank: 2 }, { name: "Ally Three", rank: 7 }] },
          { base_id: "1007", name: "Sietch Two", base_type: "Advanced Sub-Fief", owner_name: "Leader Two", map: "TheDeepDesert", x: "10", y: "20", z: "3", total_count: "2", piece_count: "12", placeable_count: "0", shared_with: null }
        ] };
      }
      return { rows: [] };
    }
  };
  const result = await listBases(db, {});
  assert.equal(result.totalCount, 2);
  assert.equal(result.totalBases, 2);
  assert.deepEqual(result.rows[0].shared_with, [
    { name: "Ally Two", rank: 2, label: "Co-Owner" },
    { name: "Ally Three", rank: 7, label: "Rank 7" }
  ]);
  assert.ok(!result.rows[0].shared_with.some((entry) => entry.name === "Leader One"), "owner_name must not appear in shared_with");
  assert.deepEqual(result.rows[1].shared_with, [], "null shared_with from the mock must coalesce to an empty array");
  assert.ok(!("total_count" in result.rows[0]), "total_count must not leak onto individual rows");
});

test("list bases filters by name, type, or owner via a having clause and paginates with limit/offset", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      return { rows: [] };
    }
  };
  await listBases(db, { q: "Sietch", page: 2, pageSize: 25 });
  const baseQuery = calls.find((call) => call.text.includes("from dune.buildings b"));
  assert.ok(baseQuery);
  assert.match(baseQuery.text, /like '%totemsmall%' then 'Sub-Fief'/);
  assert.match(baseQuery.text, /then 'Totem_Small_Patent'/);
  assert.match(baseQuery.text, /then 'Totem_Patent'/);
  assert.match(baseQuery.text, /having \(case[\s\S]+end\) ilike \$1 or coalesce\(owner\.character_name, ''\) ilike \$1/);
  assert.match(baseQuery.text, /limit \$2 offset \$3/);
  assert.deepEqual(baseQuery.values, ["%Sietch%", 25, 50]);
  assert.ok(baseQuery.text.includes("order by lower(coalesce(name, '')) asc, id asc"), "paged CTE must sort the resolved base name before pagination");
});

test("list bases can find an exact base id for cross-panel navigation", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      return { rows: [] };
    }
  };
  await listBases(db, { q: "31573", pageSize: 50 });
  const baseQuery = calls.find((call) => call.text.includes("from dune.buildings b"));
  assert.match(baseQuery.text, /or min\(b\.id\) = \$2/);
  assert.match(baseQuery.text, /limit \$3 offset \$4/);
  assert.deepEqual(baseQuery.values, ["%31573%", 31573, 50, 0]);
});

test("list bases applies requested sorting before pagination", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      return { rows: [] };
    }
  };
  await listBases(db, { page: 1, pageSize: 25, sortColumn: "piece_count", sortDirection: "desc" });
  const baseQuery = calls.find((call) => call.text.includes("from dune.buildings b"));
  assert.ok(baseQuery);
  assert.match(baseQuery.text, /as piece_count/);
  assert.match(baseQuery.text, /row_number\(\) over \(order by piece_count desc, id desc\)/);
  assert.match(baseQuery.text, /limit \$1 offset \$2/);
  assert.deepEqual(baseQuery.values, [25, 25]);
});

test("list bases falls back to safe sorting for unsupported input", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      return { rows: [] };
    }
  };
  await listBases(db, { sortColumn: "name desc; drop table dune.buildings", sortDirection: "sideways" });
  const baseQuery = calls.find((call) => call.text.includes("from dune.buildings b"));
  assert.ok(baseQuery);
  assert.match(baseQuery.text, /row_number\(\) over \(order by lower\(coalesce\(name, ''\)\) asc, id asc\)/);
  assert.doesNotMatch(baseQuery.text, /drop table/i);
});

test("list bases resolves shared_with via the base's actor id, not its building id", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "1", total_pieces: "1", total_placeables: "0" }] };
      }
      return { rows: [] };
    }
  };
  await listBases(db, {});
  const baseQuery = calls.find((call) => call.text.includes("from dune.buildings b"));
  assert.ok(baseQuery);
  // matched CTE must carry the actor id through and collapse every internal building row
  // for that claim to the oldest stable building id.
  assert.ok(baseQuery.text.includes("a.id as actor_id"), "matched CTE must select the actor id");
  assert.ok(baseQuery.text.includes("select min(b.id) as id"), "matched CTE must expose one stable id for the logical claim");
  assert.ok(baseQuery.text.includes("group by a.id, a.class, pa.actor_name"), "actor id and stable base class must be in matched's GROUP BY");
  assert.ok(!baseQuery.text.includes("group by b.id"), "internal building ids must not split one logical claim into multiple bases");
  // ...and the shared-with LATERAL must filter on that actor id, never the building id.
  assert.ok(baseQuery.text.includes("par.permission_actor_id = p.actor_id"), "shared LATERAL must join on the actor id");
  assert.ok(!baseQuery.text.includes("par.permission_actor_id = p.id"), "shared LATERAL must not regress to the building id");
});

test("list bases resolves the owner via the base's actor id, not its building id (no search)", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "1", total_pieces: "1", total_placeables: "0" }] };
      }
      return { rows: [] };
    }
  };
  // Without a search term, owner resolution is deferred to the final SELECT (only run for
  // the displayed page) instead of the matched CTE (run for every base) — see the fan-out/
  // scaling fix in listBases. The final SELECT's owner LATERAL references p.actor_id, since
  // `a` isn't in scope there.
  await listBases(db, {});
  const baseQuery = calls.find((call) => call.text.includes("from dune.buildings b"));
  assert.ok(baseQuery);
  assert.match(baseQuery.text, /\) owner on true/);
  const ownerLateral = baseQuery.text.slice(baseQuery.text.indexOf("left join lateral"), baseQuery.text.indexOf(") owner on true"));
  assert.ok(ownerLateral.includes("where par.permission_actor_id = p.actor_id"), "owner LATERAL must resolve via the base's actor id");
  assert.ok(ownerLateral.includes("order by par.rank asc"), "owner must be the lowest-rank (rank 1) member, not an arbitrary one");
  assert.ok(!ownerLateral.includes("par.permission_actor_id = p.id"), "owner LATERAL must not regress to the building id");
});

test("list bases resolves the owner via the base's actor id, not its building id (searching)", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      if (text.includes("total_bases")) {
        return { rows: [{ total_bases: "1", total_pieces: "1", total_placeables: "0" }] };
      }
      return { rows: [] };
    }
  };
  // With a search term, the `having` clause needs the resolved owner name, so the owner
  // LATERAL must still run inside the matched CTE (before pagination), referencing a.id.
  await listBases(db, { q: "Sietch" });
  const baseQuery = calls.find((call) => call.text.includes("from dune.buildings b"));
  assert.ok(baseQuery);
  assert.match(baseQuery.text, /\) owner on true/);
  const ownerLateral = baseQuery.text.slice(baseQuery.text.indexOf("left join lateral"), baseQuery.text.indexOf(") owner on true"));
  assert.ok(ownerLateral.includes("where par.permission_actor_id = a.id"), "owner LATERAL must resolve via the base's actor id");
  assert.ok(ownerLateral.includes("order by par.rank asc"), "owner must be the lowest-rank (rank 1) member, not an arbitrary one");
  assert.ok(!ownerLateral.includes("par.permission_actor_id = b.id"), "owner LATERAL must not regress to the building id");
});

test("list bases totals query uses the same base-inclusion criterion and placeable join as the main query", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      return { rows: [] };
    }
  };
  await listBases(db, {});
  const totalsQuery = calls.find((call) => call.text.includes("total_bases"));
  assert.ok(totalsQuery);
  assert.ok(totalsQuery.text.includes("where a.transform is not null"), "totals must use the same base-inclusion criterion as the paginated query");
  assert.ok(totalsQuery.text.includes("with valid_claims as"), "totals must dedup logical claim actors before counting to avoid fan-out");
  assert.ok(!totalsQuery.text.includes("left join dune.placeables pl on pl.owner_entity_id = bi.owner_entity_id"), "totals must not directly cross-join building_instances to placeables (causes fan-out)");
  assert.ok(totalsQuery.text.includes("join valid_claims vc on vc.actor_id = afe.actor_id"), "placeable totals must count via the dedup'd claim actor join, not a direct bi-to-pl join");
  assert.ok(totalsQuery.text.includes("count(distinct pl.id)"), "placeable totals must stay deduped in case two bases ever share an owner entity");
});

test("list bases rejects invalid page or pageSize values", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: BASE_REQUIRED_TABLES.includes(name) }] };
      }
      return { rows: [] };
    }
  };
  // Matches the tablePreview convention: intParam validation throws before the query runs,
  // so it's caught by the HTTP layer's dbJson wrapper (server.js), not swallowed into a
  // capabilities-false response here.
  await assert.rejects(() => listBases(db, { pageSize: 0 }), /Invalid pageSize/);
  await assert.rejects(() => listBases(db, { page: -1 }), /Invalid page/);
});

test("export base throws an unsupported error when required tables are missing", async () => {
  const db = {
    query: async () => ({ rows: [{ exists: false }] })
  };
  await assert.rejects(() => exportBaseAsBlueprint(db, 1006), UnsupportedCapabilityError);
});

test("export base reports a genuinely missing base id as not found", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.buildings b")) return { rows: [] };
      // The follow-up existence check: no buildings row at all.
      if (text.includes("select 1 from dune.buildings where id")) return { rows: [] };
      return { rows: [] };
    }
  };
  await assert.rejects(() => exportBaseAsBlueprint(db, 999999), /was not found/);
});

test("export base distinguishes a broken owner-entity link from a missing base id", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.buildings b")) return { rows: [] };
      // The follow-up existence check: the buildings row exists, so the empty
      // result above must be from a broken owner-entity link, not a missing id.
      if (text.includes("select 1 from dune.buildings where id")) return { rows: [{ "?column?": 1 }] };
      return { rows: [] };
    }
  };
  await assert.rejects(() => exportBaseAsBlueprint(db, 1006), /no resolvable owner entity/);
});

test("export base resolves the owner via the base's actor id", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: [...BASE_REQUIRED_TABLES, "dune.placeables"].includes(name) }] };
      }
      return { rows: [] };
    }
  };
  // No matching base row in this mock, so exportBaseAsBlueprint throws after issuing the identity
  // query below — that's fine, we only need to inspect the query text it sent.
  await assert.rejects(() => exportBaseAsBlueprint(db, 1006), UnsupportedCapabilityError);
  const baseQuery = calls.find((call) => call.text.includes("from dune.buildings b"));
  assert.ok(baseQuery);
  assert.ok(baseQuery.text.includes("where par.permission_actor_id = a.id"), "exportBaseAsBlueprint owner LATERAL must resolve via the base's actor id");
});

test("export base returns instances and placeables in blueprint-importable relative coordinates", async () => {
  const anchor = { x: -165708.2808275, y: -220414.81625525, z: 23473.653477859374 };
  const pieceTransform = [-167075.33, -217459.17, 22768.473, 0, 0, 0.81915206, 0.57357645];
  const placeablePos = { x: -168670.68727685622, y: -218687.5419278533, z: 23154.388368606567, qz: 0.17364818, qw: 0.9848077 };
  const ownerEntityId = "918273645";
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: [...BASE_REQUIRED_TABLES, "dune.placeables"].includes(name) }] };
      }
      if (text.includes("from dune.buildings b")) {
        return { rows: [
          { base_id: "1006", name: "Sietch One", base_type: "Sub-Fief", owner_name: "Leader One", map: "HaggaBasin", x: String(anchor.x), y: String(anchor.y), z: String(anchor.z), owner_entity_id: ownerEntityId, actor_id: "7001" }
        ] };
      }
      if (text.includes("select bi.building_id, bi.instance_id")) {
        return { rows: [{ building_id: 1006, instance_id: 2486, building_type: "Harkonnen_Outpost_Foundation", transform: pieceTransform }] };
      }
      if (text.includes("select p.id as placeable_id")) {
        return { rows: [{ placeable_id: 2582, building_type: "Hark_Deco_Plate_02_Placeable", x: placeablePos.x, y: placeablePos.y, z: placeablePos.z, qz: placeablePos.qz, qw: placeablePos.qw }] };
      }
      return { rows: [] };
    }
  };
  const result = await exportBaseAsBlueprint(db, 1006);
  const placeableQuery = calls.find((call) => call.text.includes("select p.id as placeable_id"));
  assert.deepEqual(placeableQuery.values, ["7001"]);
  assert.ok(placeableQuery.text.includes("join dune.actors a on a.id = p.id"), "placeables share the actors id space directly, not via owner_entity_id");
  assert.equal(result.base_id, "1006");
  assert.equal(result.name, "Sietch One");
  assert.equal(result.base_type, "Sub-Fief");
  assert.equal(result.owner_name, "Leader One");
  assert.equal(result.map, "HaggaBasin");
  assert.equal(result.piece_count, 1);
  assert.equal(result.placeable_count, 1);
  assert.equal(result.pentashields, undefined);

  const instance = result.instances[0];
  assert.equal(instance.instance_id, 2486);
  assert.equal(instance.building_type, "Harkonnen_Outpost_Foundation");
  assert.equal(instance.provides_stability, undefined);
  assert.ok(Math.abs(instance.x - (pieceTransform[0] - anchor.x)) < 1e-6);
  assert.ok(Math.abs(instance.y - (pieceTransform[1] - anchor.y)) < 1e-6);
  assert.ok(Math.abs(instance.z - (pieceTransform[2] - anchor.z)) < 1e-6);
  const expectedInstanceRotation = 2 * Math.atan2(pieceTransform[5], pieceTransform[6]) * (180 / Math.PI);
  assert.equal(instance.rotation, expectedInstanceRotation);
  assert.ok(Math.abs(instance.rotation - 110) < 1);

  const placeable = result.placeables[0];
  assert.equal(placeable.placeable_id, 2582);
  assert.equal(placeable.building_type, "Hark_Deco_Plate_02_Placeable");
  assert.equal(placeable.rx, 0);
  assert.equal(placeable.rz, 0);
  assert.ok(Math.abs(placeable.x - (placeablePos.x - anchor.x)) < 1e-6);
  const expectedPlaceableRotation = 2 * Math.atan2(placeablePos.qz, placeablePos.qw) * (180 / Math.PI);
  assert.equal(placeable.ry, expectedPlaceableRotation);
  assert.ok(Math.abs(placeable.ry - 20) < 1);
});

test("export base combines claim partitions, remaps colliding instance IDs, and excludes the claim console", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: [...BASE_REQUIRED_TABLES, "dune.placeables"].includes(name) }] };
      }
      if (text.includes("from dune.buildings b")) {
        assert.deepEqual(values, [77], "any member building id must resolve the full logical claim");
        return { rows: [{
          base_id: "75", name: "Khatovar", base_type: "Advanced Sub-Fief", owner_name: "Drew",
          map: "HaggaBasin", x: "1000", y: "2000", z: "3000", owner_entity_id: "9001", actor_id: "7001"
        }] };
      }
      if (text.includes("select bi.building_id, bi.instance_id")) {
        assert.deepEqual(values, ["7001"]);
        return { rows: [
          { building_id: 75, instance_id: 0, building_type: "Atreides_Outpost_Foundation", transform: [1000, 2000, 3000, 0, 0, 0, 1] },
          { building_id: 76, instance_id: 0, building_type: "Atreides_Outpost_Wall_01", transform: [1500, 2000, 3000, 0, 0, 0, 1] },
          { building_id: 77, instance_id: 4, building_type: "Atreides_Outpost_Floor", transform: [2000, 2000, 3000, 0, 0, 0, 1] }
        ] };
      }
      if (text.includes("select p.id as placeable_id")) {
        assert.deepEqual(values, ["7001"]);
        return { rows: [{ placeable_id: 146, building_type: "Totem_Placeable", x: 1000, y: 2000, z: 3000, qz: 0, qw: 1 }] };
      }
      return { rows: [] };
    }
  };

  const result = await exportBaseAsBlueprint(db, 77);
  assert.equal(result.base_id, "75");
  assert.equal(result.piece_count, 3);
  assert.equal(result.placeable_count, 0);
  assert.deepEqual(result.instances.map((instance) => instance.instance_id), [0, 1, 2]);
  assert.deepEqual(result.instances.map((instance) => instance.x), [0, 500, 1000]);
  assert.deepEqual(result.placeables, []);
  const pieceQuery = calls.find((call) => call.text.includes("select bi.building_id, bi.instance_id"));
  assert.match(pieceQuery.text, /where afe\.actor_id = \$1/);
  const placeableQuery = calls.find((call) => call.text.includes("select p.id as placeable_id"));
  assert.match(placeableQuery.text, /join dune\.actor_fgl_entities afe on afe\.entity_id = p\.owner_entity_id/);
  assert.match(placeableQuery.text, /not in \('totem_small_placeable', 'totem_placeable'\)/);
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
        return { rows: [{ actor_id: 101, player_pawn_id: 101, account_id: 201, character_name: "Test One", player_controller_id: 301, player_state_id: 102, funcom_id: "FN1", fls_id: "user1", platform_id: "76561197986776594", platform_name: "Steam", action_player_id: "user1", class: "Foo", map: "Survival_1", online_status: "Online" }] };
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
  assert.equal(result.player.faction_assigned, true);
  assert.equal(result.player.guild, "Water Sellers");
  assert.equal(result.player.player_state_id, 102);
  assert.equal(result.player.platform_id, "76561197986776594");
  assert.equal(result.player.platform_name, "Steam");
});

test("player profile ignores guild allegiance and stays Neutral when personal faction is unassigned", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.actors", "dune.player_state", "dune.accounts", "dune.player_faction", "dune.player_faction_reputation", "dune.factions", "dune.guild_members", "dune.guilds"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        if (table === "guild_members") return { rows: ["player_id", "guild_id", "role_id"].map((column_name) => ({ column_name })) };
        if (table === "guilds") return { rows: ["guild_id", "guild_name", "guild_faction"].map((column_name) => ({ column_name })) };
        return { rows: [] };
      }
      if (text.includes("as fls_id") && text.includes("where a.id = $1")) {
        return { rows: [{ actor_id: 131, player_pawn_id: 131, account_id: 427, character_name: "Player4", player_controller_id: 129, funcom_id: "FN4", fls_id: "user4", action_player_id: "user4", class: "Foo", map: "SH_Arrakeen", online_status: "Offline" }] };
      }
      if (text.includes("from dune.player_faction pf")) return { rows: [] };
      if (text.includes("from dune.player_faction_reputation pfr")) {
        return { rows: [{ actor_id: "131", faction_id: "2", faction_name: "Harkonnen", reputation_amount: 100 }] };
      }
      if (text.includes("as faction_id") && text.includes("join dune.guilds g") && text.includes("left join dune.factions f")) {
        return { rows: [{ player_id: "129", faction_id: "1", faction_name: "Atreides" }] };
      }
      if (text.includes("from dune.guild_members gm")) {
        return { rows: [{ player_id: "129", guild_name: "Codex Atreides Test Guild" }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerProfile(db, "131");
  assert.equal(result.player.faction, "Neutral");
  assert.equal(result.player.faction_assigned, false);
  assert.equal(result.player.guild, "Codex Atreides Test Guild");
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
  assert.equal(result.player.faction, "Neutral");
  assert.equal(result.player.faction_assigned, false);
  assert.equal(result.player.guild, "—");
});

test("player profile ignores reputation entirely and stays Neutral when only reputation data exists", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) {
        const name = String(values[0] || "");
        return { rows: [{ exists: ["dune.actors", "dune.player_state", "dune.accounts", "dune.player_faction_reputation", "dune.factions"].includes(name) }] };
      }
      if (text.includes("information_schema.columns")) return { rows: [] };
      if (text.includes("as fls_id") && text.includes("where a.id = $1")) {
        return { rows: [{ actor_id: 101, player_pawn_id: 101, account_id: 201, character_name: "Test One", player_controller_id: 301, funcom_id: "FN1", fls_id: "user1", action_player_id: "user1", class: "Foo", map: "Survival_1", online_status: "Offline" }] };
      }
      if (text.includes("from dune.player_faction_reputation pfr")) {
        return { rows: [{ actor_id: "101", faction_id: "2", faction_name: "Harkonnen", reputation_amount: 100 }] };
      }
      return { rows: [] };
    }
  };
  const result = await playerProfile(db, "101");
  assert.equal(result.player.faction, "Neutral");
  assert.equal(result.player.faction_assigned, false);
});

test("player profile rejects an existing non-player actor id", async () => {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("as fls_id") && text.includes("where a.id = $1")) {
        assert.deepEqual(values, [2]);
        assert.match(text, /join dune\.player_state ps on ps\.player_pawn_id = a\.id/);
        assert.match(text, /a\.class ilike '%PlayerCharacter%'/);
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  await assert.rejects(playerProfile(db, "2"), (error) => error.statusCode === 404 && error.message === "Player not found");
});

test("player identity boundary rejects world actors without a current player pawn relationship", async () => {
  const db = {
    query: async (text, values = []) => {
      assert.deepEqual(values, [2]);
      assert.match(text, /left join dune\.player_state ps on ps\.player_pawn_id = a\.id/);
      assert.match(text, /a\.class ilike '%PlayerCharacter%'/);
      assert.match(text, /ps\.id is not null/);
      return { rows: [] };
    }
  };
  await assert.rejects(resolvePlayerTarget(db, "2"), (error) => error.statusCode === 404 && error.message === "Player not found");
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

test("live map vehicle markers resolve owner_name the same way base markers do, including unclaimed vehicles", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      return {
        rows: [
          { id: 20, type: "vehicle", name: "BP_Sandbike_CHOAM_C", map: "Survival_1", partition_id: 1, class: "BP_Sandbike_CHOAM_C", owner_name: "Chani", x: "1", y: "2", z: "3" },
          { id: 21, type: "vehicle", name: "BP_Buggy_C", map: "Survival_1", partition_id: 1, class: "BP_Buggy_C", owner_name: "", x: "4", y: "5", z: "6" }
        ]
      };
    }
  };
  const result = await liveMapVehicles(db, "Survival_1");
  assert.equal(result.rows[0].owner_name, "Chani");
  assert.equal(result.rows[1].owner_name, "", "an unclaimed vehicle has no permission_actor_rank row, so owner_name stays empty");

  const markerQuery = calls.find((call) => call.text.includes("from dune.vehicles v"));
  assert.ok(markerQuery);
  assert.match(markerQuery.text, /left join lateral/);
  assert.match(markerQuery.text, /where par\.permission_actor_id = a\.id and par\.rank = 1/);
  assert.match(markerQuery.text, /coalesce\(owner\.character_name, ''\) as owner_name/);
});

test("live map hides stored base and storage markers while preserving redeployed bases", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      return { rows: [] };
    }
  };

  await liveMapBases(db, "DeepDesert");
  await liveMapStorage(db, "DeepDesert");

  const bases = calls.find((call) => call.text.includes("from dune.buildings b"));
  assert.ok(bases);
  assert.match(
    bases.text,
    /not \(pa\.actor_id is null and exists \(select 1 from dune\.base_backup_linked_actors backup_link where backup_link\.actor_id = a\.id\)\)/,
    "a base marker must be hidden only while it is both unclaimed and backup-linked"
  );
  assert.match(bases.text, /select min\(b\.id\) as id/);
  assert.match(bases.text, /where par\.permission_actor_id = a\.id/);
  assert.match(bases.text, /then 'Totem_Small_Patent'/);
  assert.match(bases.text, /then 'Sub-Fief'/);
  assert.match(bases.text, /coalesce\(owner\.character_name, ''\) as owner_name/);
  assert.doesNotMatch(bases.text, /group by b\.id/);

  const storage = calls.find((call) => call.text.includes("from dune.placeables p"));
  assert.ok(storage);
  assert.match(storage.text, /storage_link\.actor_id = p\.id/);
  assert.match(storage.text, /claim_link\.id = storage_link\.id/);
  assert.match(storage.text, /claim_permission\.actor_id is null/);
  assert.match(
    storage.text,
    /left join dune\.permission_actor claim_permission/,
    "a stale backup link must not hide storage after the base is claimed again"
  );
});

test("live map omits stored-base filters when the optional backup schema is unavailable", async () => {
  const calls = [];
  const required = new Set(["dune.actors", "dune.buildings", "dune.placeables"]);
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: required.has(String(values[0] || "")) }] };
      return { rows: [] };
    }
  };

  await liveMapBases(db);
  await liveMapStorage(db);

  const bases = calls.find((call) => call.text.includes("from dune.buildings b"));
  const storage = calls.find((call) => call.text.includes("from dune.placeables p"));
  assert.ok(!bases.text.includes("base_backup_linked_actors"));
  assert.ok(!storage.text.includes("base_backup_linked_actors"));
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

test("player inventory (all containers) queries every player-carried type and tags rows with inventory_type", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("order by id limit 1")) return { rows: [{ max_item_count: 50, max_item_volume: 300 }] };
      if (text.includes("from dune.items i")) return { rows: [
        { id: 1, template_id: "WaterBottle_1", stack_size: 1, quality_level: 0, position_index: 0, inventory_id: 7, inventory_type: 0, current_durability: null, max_durability: null, stats: {} },
        { id: 2, template_id: "Armor_Chest_T4", stack_size: 1, quality_level: 4, position_index: 0, inventory_id: 9, inventory_type: 15, current_durability: "210", max_durability: "300", stats: {} }
      ] };
      return { rows: [] };
    }
  };
  const result = await playerInventoryAll(db, 123);
  const itemsCall = calls.find((call) => call.text.includes("from dune.items i"));
  assert.ok(itemsCall);
  assert.match(itemsCall.text, /inv2\.inventory_type = any\(\$2::int\[\]\)/);
  assert.match(itemsCall.text, /order by inv2\.inventory_type, i\.template_id/);
  assert.deepEqual(itemsCall.values[1], [0, 1, 15, 30]);
  assert.equal(result.maxSlots, 50);
  assert.equal(result.maxVolume, 300);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].inventory_type, 0);
  assert.equal(result.rows[1].inventory_type, 15);
  assert.deepEqual(result.rows[1].augments, []);
});

test("player inventory (all containers) reports unsupported when inventory tables are missing", async () => {
  const db = { query: async () => ({ rows: [{ exists: false }] }) };
  const result = await playerInventoryAll(db, 123);
  assert.equal(result.capabilities.inventory, false);
  assert.match(result.reason, /dune\.items|dune\.inventories/);
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

// Container-item delete. The ownership query is the whole safety story here --
// it is what keeps a delete inside an allowlisted container at the requested
// base, and out of the generator/windtrap fuel inventories the Power and Water
// tabs own -- so most of these assert on it rather than on the happy path.
function fakeContainerDeleteDb(calls, fixtures = {}) {
  const {
    itemRows = [],
    partialResult = 1,
    remainingAfterPartial = null,
    procedures = true,
    deleteLeavesRow = false,
    itemColumns = ["id", "inventory_id", "stack_size", "position_index", "template_id", "stats", "quality_level"]
  } = fixtures;
  const run = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
    if (text.includes("to_regprocedure")) return { rows: [{ exists: procedures }] };
    if (text.includes("information_schema.columns")) {
      return { rows: itemColumns.map((column_name) => ({ column_name })) };
    }
    if (text.includes("requested_claims")) return { rows: itemRows };
    if (text.includes("dune.delete_inventory_item")) return { rows: [{ result: partialResult }] };
    if (text.includes("select stack_size from dune.items")) {
      return { rows: remainingAfterPartial === null ? [] : [{ stack_size: remainingAfterPartial }] };
    }
    if (text.includes("as exists")) return { rows: [{ exists: deleteLeavesRow }] };
    if (text.includes("as deleted")) return { rows: [{ deleted: !deleteLeavesRow }] };
    return { rows: [] };
  };
  return { query: run, transaction: async (fn) => fn({ query: run }) };
}

const CONTAINER_ITEM_ROW = {
  item_id: "99", template_id: "ScrapMetal", stack_size: 500, inventory_id: 7,
  placeable_id: "42", group_key: "storage", type_name: "Small Storage Container",
  position_index: 3, quality_level: 2, current_durability: "45", max_durability: 90
};

test("container item delete verifies base ownership before calling dune.delete_item", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW] });
  const result = await deleteBaseContainerItem(db, 16836, 42, 99);
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.removed.count, 500);
  const ownership = calls.find((call) => call.text.includes("requested_claims"));
  assert.ok(ownership, "ownership query ran");
  // The base id, the placeable and the item all constrain the lookup -- an
  // item id alone must never be enough to reach a row.
  assert.equal(ownership.values[0], 16836);
  assert.equal(ownership.values[4], 42);
  assert.equal(ownership.values[5], "99");
  assert.ok(calls.some((call) => call.text.includes("dune.delete_item($1::bigint)") && call.values[0] === "99"));
});

test("container item delete locks the item and its inventory rather than the CTE", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW] });
  await deleteBaseContainerItem(db, 16836, 42, 99);
  const ownership = calls.find((call) => call.text.includes("requested_claims"));
  // `for update of i, inv`, not a bare `for update`: Postgres cannot lock a CTE
  // reference, and locking only the item row locks nothing once it is gone.
  assert.match(ownership.text, /for update of i, inv/);
});

test("container item delete keeps the container allowlist and hologram filters in the ownership query", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW] });
  await deleteBaseContainerItem(db, 16836, 42, 99);
  const ownership = calls.find((call) => call.text.includes("requested_claims"));
  // Dropping either of these would let a delete reach a generator or windtrap
  // fuel inventory, which this route must never touch.
  assert.match(ownership.text, /join inventory_types it on it\.building_type = lower\(p\.building_type\)/);
  assert.match(ownership.text, /p\.is_hologram = false/);
  assert.match(ownership.text, /inv\.max_item_count >= 0/);
});

test("container item delete rejects an item that is not in a container at the selected base", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [] });
  await assert.rejects(() => deleteBaseContainerItem(db, 16836, 42, 99), /not found in a storage container/);
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item")), false);
  assert.equal(calls.some((call) => call.text.includes("dune.delete_inventory_item")), false);
});

test("container item delete keeps crafting and refining inventories read-only", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, {
    itemRows: [{ ...CONTAINER_ITEM_ROW, group_key: "refining", type_name: "Small Ore Refinery" }]
  });
  await assert.rejects(
    () => deleteBaseContainerItem(db, 16836, 42, 99),
    /only be deleted from Storage containers/
  );
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item")), false);
  assert.equal(calls.some((call) => call.text.includes("dune.delete_inventory_item")), false);
});

test("container item delete refuses a count larger than the stack instead of clearing the slot", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW] });
  // The dangerous case: a stack that shrank between the read and the delete.
  // Rounding 999 down to "all 500" would destroy more than was asked for.
  await assert.rejects(
    () => deleteBaseContainerItem(db, 16836, 42, 99, { count: 999 }),
    /Cannot remove 999: the stack holds 500/
  );
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item")), false);
  assert.equal(calls.some((call) => call.text.includes("dune.delete_inventory_item")), false);
});

test("container item delete routes a partial removal through dune.delete_inventory_item", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW], remainingAfterPartial: 350 });
  const result = await deleteBaseContainerItem(db, 16836, 42, 99, { count: 150 });
  assert.equal(result.partial, true);
  assert.equal(result.removed.count, 150);
  assert.equal(result.removed.remaining, 350);
  assert.ok(calls.some((call) => call.text.includes("dune.delete_inventory_item") && call.values[0] === "99" && call.values[1] === 150));
  // A partial removal must not also fire the whole-slot delete.
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item($1::bigint)")), false);
});

test("a count equal to the whole stack clears the slot rather than decrementing it", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW] });
  const result = await deleteBaseContainerItem(db, 16836, 42, 99, { count: 500 });
  assert.equal(result.partial, false);
  assert.ok(calls.some((call) => call.text.includes("dune.delete_item($1::bigint)")));
  assert.equal(calls.some((call) => call.text.includes("dune.delete_inventory_item")), false);
});

test("container item delete treats a null from dune.delete_inventory_item as a failure", async () => {
  const calls = [];
  // The shipped procedure returns NULL rather than raising when the count
  // exceeds the stack, so a null result must not read as success.
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW], partialResult: null });
  await assert.rejects(() => deleteBaseContainerItem(db, 16836, 42, 99, { count: 150 }), /rejected by the database/);
});

test("container item delete raises when the stack did not change by the requested amount", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW], remainingAfterPartial: 500 });
  await assert.rejects(() => deleteBaseContainerItem(db, 16836, 42, 99, { count: 150 }), /did not change the stack/);
});

test("container item delete raises when dune.delete_item leaves the row behind", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW], deleteLeavesRow: true });
  await assert.rejects(() => deleteBaseContainerItem(db, 16836, 42, 99), /did not remove the item/);
  // The raw fallback delete is attempted before giving up.
  assert.ok(calls.some((call) => call.text.includes("delete from dune.items where id = $1")));
});

test("container item delete refuses a partial removal when the schema lacks the procedure", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW], procedures: false });
  // Capability failure, not a silent widening to a whole-slot delete.
  await assert.rejects(() => deleteBaseContainerItem(db, 16836, 42, 99, { count: 150 }));
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item($1::bigint)")), false);
});

test("container item delete records what was destroyed in the audit result", async () => {
  const calls = [];
  const db = fakeContainerDeleteDb(calls, { itemRows: [CONTAINER_ITEM_ROW] });
  const result = await deleteBaseContainerItem(db, 16836, 42, 99);
  // Without these, a destroyed pristine legendary logs identically to a
  // broken common of the same template -- the audit trail for the console's
  // first irreversible per-item destruction needs to distinguish them.
  assert.equal(result.removed.positionIndex, 3);
  assert.equal(result.removed.qualityLevel, 2);
  assert.equal(result.removed.currentDurability, 45);
  assert.equal(result.removed.maxDurability, 90);
});

test("container item delete degrades to null state fields on a schema without them, rather than failing", async () => {
  const calls = [];
  // A schema lacking these columns cannot select them, so the row the real
  // query would return has no such keys either -- the fake db does not parse
  // SQL, so this fixture has to omit them itself to match.
  const { position_index, quality_level, current_durability, max_durability, ...bareItemRow } = CONTAINER_ITEM_ROW;
  const db = fakeContainerDeleteDb(calls, {
    itemRows: [bareItemRow],
    itemColumns: ["id", "inventory_id", "stack_size", "template_id"]
  });
  const result = await deleteBaseContainerItem(db, 16836, 42, 99);
  assert.equal(result.ok, true);
  assert.equal(result.removed.positionIndex, null);
  assert.equal(result.removed.qualityLevel, 0);
  assert.equal(result.removed.currentDurability, null);
  assert.equal(result.removed.maxDurability, null);
  const query = calls.find((call) => call.text.includes("requested_claims"));
  assert.match(query.text, /null::bigint as position_index/);
  assert.ok(!query.text.includes("i.position_index"), "must not select a column this schema lacks");
});

// Container-item add. The inverse of the delete above and, like it, mostly a
// story about the ownership query -- plus two contracts the UI states out loud
// and the backend has to actually keep: never merge into an existing stack, and
// always claim an in-range free slot.
function fakeContainerAddDb(calls, fixtures = {}) {
  const {
    containerRows = [],
    count = 0,
    maxPositionIndex = -1,
    occupiedPositions = null,
    augmentRollRows = [],
    insertedRows = null,
    itemColumns = ["id", "inventory_id", "stack_size", "position_index", "template_id", "stats", "quality_level"],
    tables = null
  } = fixtures;
  const run = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) {
      if (!tables) return { rows: [{ exists: true }] };
      const name = String(values[0] || "");
      return { rows: [{ exists: tables.some((table) => name.includes(table)) }] };
    }
    if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
    if (text.includes("information_schema.columns")) {
      // columnsFor passes [schema, table], so the table name is values[1].
      const table = String(values[1] || "");
      if (table === "items") return { rows: itemColumns.map((column_name) => ({ column_name })) };
      if (table === "inventories") {
        return { rows: ["id", "actor_id", "max_item_count", "max_item_volume"].map((column_name) => ({ column_name })) };
      }
      if (table === "placeables") {
        return { rows: (fixtures.placeableColumns
          || ["id", "owner_entity_id", "building_type", "is_hologram"]).map((column_name) => ({ column_name })) };
      }
      return { rows: itemColumns.map((column_name) => ({ column_name })) };
    }
    if (text.includes("requested_claims")) return { rows: containerRows };
    if (text.includes("count(*)::int as count")) return { rows: [{ count }] };
    if (text === "select position_index from dune.items where inventory_id = $1") {
      const positions = occupiedPositions || Array.from({ length: Math.max(0, maxPositionIndex + 1) }, (_, position_index) => position_index);
      return { rows: positions.map((position_index) => ({ position_index })) };
    }
    if (text.includes("max(position_index)")) return { rows: [{ position_index: maxPositionIndex + 1 }] };
    if (text.includes("FAugmentItemStats")) return { rows: augmentRollRows };
    if (text.includes("FAugmentedItemStats")) return { rows: [] };
    if (text.includes("insert into dune.items")) {
      return {
        rows: insertedRows || [{
          id: "9007199254740999", template_id: values[1], stack_size: values[2],
          quality_level: values[3], position_index: values[4], inventory_id: values[0]
        }]
      };
    }
    return { rows: [] };
  };
  return { query: run, transaction: async (fn) => fn({ query: run }) };
}

// deleteMultipleBaseContainerItems / deleteAllBaseContainerItems: bulk
// delete paths built for the Bases -> Inventory multi-select and "Delete
// All" actions. Both share resolveOwnedStorageContainer's claim-CTE
// ownership resolution with deleteBaseContainerItem -- NOT
// removeItemsFromStorage's actor_id-only lookup below, which has no group
// filter and could otherwise reach a Refining/Crafting inventory.
const OWNED_STORAGE_CONTAINER_ROW = {
  placeable_id: "42", inventory_id: 7, group_key: "storage", type_name: "Small Storage Container"
};

function fakeBulkContainerDeleteDb(calls, fixtures = {}) {
  const {
    containerRows = [OWNED_STORAGE_CONTAINER_ROW],
    itemRows = [],
    // Ids that survive the dune.delete_item call and must fall back to a
    // raw `delete from dune.items` -- mirrors deleteLeavesRow's old,
    // single-item meaning, now expressed as a set since the verification
    // query is set-based (finishDeletingLockedItems, duneDb.js).
    idsLeftAfterDeleteItem = [],
    // Mirrors fakeContainerDeleteDb's itemColumns fixture: which dune.items
    // columns this fake schema has, probed by auditDetailSelectFragment
    // (issue #350) the same way deleteBaseContainerItem's own stateSelect
    // is. Defaults to the full set so existing tests that don't care about
    // audit-detail fields keep getting populated values.
    itemColumns = ["id", "inventory_id", "stack_size", "position_index", "template_id", "stats", "quality_level"]
  } = fixtures;
  const run = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
    if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
    if (text.includes("information_schema.columns")) {
      return { rows: itemColumns.map((column_name) => ({ column_name })) };
    }
    // Ownership resolution: resolveOwnedStorageContainer's own query.
    // Anchored on its actual, structurally unique final SELECT column list
    // (issue #354, MEDIUM severity, found during PR #349's own Layer 3
    // audit, QA hat) rather than the bare substrings "requested_claims" and
    // "for update of inv" this matcher used previously -- both substrings
    // are shared with other queries/comments in duneDb.js (every base-
    // container query builds on the same requested_claims CTE, and a
    // hypothetical future query could easily contain both short fragments
    // together without being this one), so a future addition elsewhere in
    // the file could have silently been treated as "the ownership query" by
    // this mock, producing an incorrect-but-passing green test for an
    // unrelated code path. This exact column list
    // ("c.placeable_id::text as placeable_id, c.inventory_id") only ever
    // appears in resolveOwnedStorageContainer's own final SELECT.
    if (text.includes("select c.placeable_id::text as placeable_id, c.inventory_id") && text.includes("for update of inv")) {
      return { rows: containerRows };
    }
    // Set-based item lookup inside deleteMultipleBaseContainerItems --
    // `where id = any($1::bigint[]) and inventory_id = $2`. Distinguished
    // from the verification query below (finishDeletingLockedItems) by the
    // `for update` clause, which only the initial lookup carries.
    if (text.includes("select id::text as item_id, template_id, stack_size") && text.includes("where id = any($1::bigint[]) and inventory_id = $2") && text.includes("for update")) {
      const ids = new Set((values[0] || []).map((id) => String(id)));
      return { rows: itemRows.filter((row) => ids.has(String(row.item_id))) };
    }
    // Full-container listing inside deleteAllBaseContainerItems.
    if (text.includes("select id::text as item_id, template_id, stack_size") && text.includes("where inventory_id = $1")) {
      return { rows: itemRows };
    }
    // finishDeletingLockedItems's set-based "still present after
    // dune.delete_item" check -- `select id::text as item_id from
    // dune.items where id = any($1::bigint[]) and inventory_id = $2`, no
    // `for update` and no stack_size/template_id in the column list, which
    // is what distinguishes it from the lookup query above.
    if (text.includes("select id::text as item_id from dune.items where id = any($1::bigint[]) and inventory_id = $2")) {
      const requested = new Set((values[0] || []).map((id) => String(id)));
      const left = idsLeftAfterDeleteItem.map((id) => String(id)).filter((id) => requested.has(id));
      return { rows: left.map((item_id) => ({ item_id })) };
    }
    return { rows: [] };
  };
  return { query: run, transaction: async (fn) => fn({ query: run }) };
}

const CONTAINER_ADD_ROW = {
  placeable_id: "42", inventory_id: 7, group_key: "storage",
  type_name: "Small Storage Container", max_item_count: 45
};

const insertCalls = (calls) => calls.filter((call) => call.text.includes("insert into dune.items"));

// Per-item stack-limit adherence (issue #430) for the slot-grid Add Item
// path: unlike Give/Fill, this UX deliberately places exactly one row in one
// slot, so an oversized quantity is CLAMPED to the game's per-item stack
// limit rather than split across rows -- and reported honestly.
test("container item add clamps quantity to the item's catalog stack size for its single-slot placement", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, {
    containerRows: [CONTAINER_ADD_ROW],
    insertedRows: [{ id: 640, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 0, inventory_id: 7 }]
  });
  const result = await addBaseContainerItem(db, 16836, 42, { itemId: "MelangeSpice", quantity: 1200 });
  assert.equal(result.requested, 1200);
  assert.equal(result.clamped, true);
  const insert = insertCalls(calls)[0];
  assert.equal(insert.values[2], 500, "the single placed stack must not exceed the game's stack limit");
});

// A synthetic, never-real id -- not a real catalog item like ScrapMetal --
// because maxStackSizeForTemplate reads the REAL runtime/data/admin-items.json
// (this test's db fixture is faked, but that lookup isn't), so a real item id
// here is fragile against future curation (L2 audit QA hat L-7's predicted
// failure mode: #431's bulk curation broke this exact test when it curated
// ScrapMetal's stackSize, 2026-08-20).
test("container item add leaves items without catalog stack data unclamped", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
  const result = await addBaseContainerItem(db, 16836, 42, { itemId: "TotallyUncataloguedTestItem", quantity: 1200 });
  assert.equal(result.clamped, false);
  const insert = insertCalls(calls)[0];
  assert.equal(insert.values[2], 1200);
});

test("container item add resolves ownership through the base before inserting", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
  const result = await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 5 });
  assert.equal(result.ok, true);
  const ownership = calls.find((call) => call.text.includes("requested_claims"));
  assert.ok(ownership, "ownership query ran");
  // The base constrains the lookup; a placeable id alone must never reach a row.
  assert.equal(ownership.values[0], 16836);
  assert.equal(ownership.values[4], 42);
  const insert = insertCalls(calls)[0];
  assert.equal(insert.values[0], 7);
  assert.equal(insert.values[1], "ScrapMetal");
  assert.equal(insert.values[2], 5);
});

test("container item add locks the inventory row rather than the CTE", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
  await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 });
  const ownership = calls.find((call) => call.text.includes("requested_claims"));
  // Postgres cannot lock a CTE reference, so the outer query re-joins the real
  // relation purely to have something lockable.
  assert.match(ownership.text, /for update of inv/);
  assert.ok(!/for update\s*$/.test(ownership.text.trim().replace(/for update of inv/, "")),
    "must not also take a bare for update");
});

test("container item add takes the inventory lock before reading capacity and position", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
  await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 });
  // Ordering is the entire concurrency argument: reading capacity or max slot
  // before the lock would let two adders compute the same next index.
  const lockAt = calls.findIndex((call) => call.text.includes("for update of inv"));
  const countAt = calls.findIndex((call) => call.text.includes("count(*)::int as count"));
  const positionAt = calls.findIndex((call) => call.text === "select position_index from dune.items where inventory_id = $1");
  assert.ok(lockAt >= 0 && countAt > lockAt, "capacity read must follow the lock");
  assert.ok(positionAt > lockAt, "position read must follow the lock");
});

test("container item add refuses a container that is not at the requested base", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [] });
  await assert.rejects(
    () => addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 }),
    /not found at the selected base/
  );
  assert.equal(insertCalls(calls).length, 0);
});

test("container item add refuses a non-storage container", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, {
    containerRows: [{ ...CONTAINER_ADD_ROW, group_key: "refining", type_name: "Ore Refinery" }]
  });
  await assert.rejects(
    () => addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 }),
    /only be added to Storage containers/
  );
  assert.equal(insertCalls(calls).length, 0);
});

test("container item add refuses a full container", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW], count: 45 });
  await assert.rejects(
    () => addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 }),
    /full: 45 of 45/
  );
  assert.equal(insertCalls(calls).length, 0);
});

test("container item add treats a max_item_count of zero as uncapped", async () => {
  const calls = [];
  // Matches giveItemToStorage and giveItemToPlayer. No shipped storage type has
  // 0, but inventing a third convention for it would be worse than the edge.
  const db = fakeContainerAddDb(calls, {
    containerRows: [{ ...CONTAINER_ADD_ROW, max_item_count: 0 }],
    count: 9999
  });
  const result = await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 });
  assert.equal(result.ok, true);
  assert.equal(insertCalls(calls).length, 1);
});

test("container item add appends to the next free slot", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW], count: 8, maxPositionIndex: 7 });
  const result = await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 });
  assert.equal(insertCalls(calls)[0].values[4], 8);
  assert.equal(result.added.positionIndex, 8);
});

test("container item add stays inside the slot grid after Give occupied the highest slot", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, {
    containerRows: [CONTAINER_ADD_ROW],
    count: 3,
    occupiedPositions: [0, 1, 44]
  });
  const result = await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 });
  const insertedPosition = insertCalls(calls)[0].values[4];
  assert.equal(insertedPosition, 2, "Add must claim the lowest free in-range slot, not max(position_index)+1 = 45");
  assert.equal(result.added.positionIndex, 2);
  assert.ok(insertedPosition < 45, "Add must never write at or beyond max_item_count");
});

test("container item add starts an empty container at slot zero", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW], count: 0, maxPositionIndex: -1 });
  await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 });
  assert.equal(insertCalls(calls)[0].values[4], 0);
});

test("container item add never merges into an existing stack of the same template", async () => {
  const calls = [];
  // The container already holds ScrapMetal. Adding more must still be one new
  // row in one new slot -- this is a contract the add panel states out loud.
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW], count: 1, maxPositionIndex: 0 });
  await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 300 });
  assert.equal(insertCalls(calls).length, 1);
  assert.equal(calls.some((call) => /update\s+dune\.items/i.test(call.text)), false,
    "must not update an existing row");
  assert.equal(insertCalls(calls)[0].values[4], 1);
});

test("container item add leaves a resource stack without invented durability", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
  await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 300 });
  const stats = JSON.parse(insertCalls(calls)[0].values[5]);
  // Real ore rows carry an empty stat block. Stamping MaxDurability onto scrap
  // would invent state the game never wrote, and the read path would then
  // render a durability bar for it.
  assert.deepEqual(stats.FItemStackAndDurabilityStats, [[], {}]);
});

test("container item add gives a weapon full durability without being asked", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, {
    containerRows: [CONTAINER_ADD_ROW],
    augmentRollRows: [{ template_id: "T6_Augment_Melee1", stats: { FAugmentItemStats: [[], { StatRolls: [1], AppliedEffectIndices: [] }] } }]
  });
  await addBaseContainerItem(db, 16836, 42, {
    itemId: "UniqueSword_05", quantity: 1, quality: 0, augments: ["T6_Augment_Melee1"]
  });
  const stats = JSON.parse(insertCalls(calls)[0].values[5]);
  // Comes from buildItemStats' own fallback, not from an explicit durability
  // argument -- which is exactly why resources above stay empty.
  assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 100);
});

test("container item add rejects augments on an item that cannot take them", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
  await assert.rejects(
    () => addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1, augments: ["T6_Augment_Melee1"] }),
    /Only clothing and weapons support augments/
  );
  assert.equal(insertCalls(calls).length, 0);
});

test("container item add rejects more augments than the item allows", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
  await assert.rejects(
    () => addBaseContainerItem(db, 16836, 42, {
      itemId: "UniqueSword_05",
      quantity: 1,
      augments: ["T6_Augment_Melee1", "T6_Augment_Melee2", "T6_Augment_Melee3", "T6_Augment_Melee4"]
    }),
    /supports up to 3 augment/
  );
  assert.equal(insertCalls(calls).length, 0);
});

test("container item add rejects an out-of-range quantity", async () => {
  for (const quantity of [0, -1, 1.5, 1000001]) {
    const calls = [];
    const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
    await assert.rejects(
      () => addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity }),
      /quantity/i,
      `quantity ${quantity} must be refused`
    );
    assert.equal(insertCalls(calls).length, 0);
  }
});

test("container item add rejects a grade outside 0-5", async () => {
  const calls = [];
  // giveItemToStorage allows 0-1000000, which is an outlier -- every other path
  // and the whole UI treat grade as 0-5, and this must not widen that.
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
  await assert.rejects(
    () => addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1, quality: 6 }),
    /grade/i
  );
  assert.equal(insertCalls(calls).length, 0);
});

test("container item add is unsupported when any relation its query names is missing", async () => {
  const all = ["buildings", "building_instances", "actor_fgl_entities", "placeables", "inventories", "items"];
  for (const missing of all) {
    const calls = [];
    // Postgres resolves relations at parse time, so a missing buildings raises
    // exactly as hard as a missing items -- a partial probe would report the
    // capability present and then fail on use.
    const db = fakeContainerAddDb(calls, {
      containerRows: [CONTAINER_ADD_ROW],
      tables: all.filter((table) => table !== missing)
    });
    await assert.rejects(
      () => addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 }),
      /Container item add requires/,
      `a schema without ${missing} must report unsupported`
    );
    assert.equal(insertCalls(calls).length, 0);
  }
});

test("container item add is unsupported when placeables lacks is_hologram", async () => {
  const calls = [];
  // The ownership query filters on it, so its absence is a parse error, not a
  // null -- the delete's probe misses this, which is why this one checks.
  const db = fakeContainerAddDb(calls, {
    containerRows: [CONTAINER_ADD_ROW],
    placeableColumns: ["id", "owner_entity_id", "building_type"]
  });
  await assert.rejects(
    () => addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 }),
    /Container item add requires/
  );
  assert.equal(insertCalls(calls).length, 0);
});

test("container item add calls no shipped procedure and sets no search_path", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW] });
  await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 });
  // The delete needs `set local search_path` because dune.delete_item carries
  // none of its own. This path invokes no procedure, so the line would be
  // cargo-culted noise -- its absence is deliberate and worth pinning.
  assert.equal(calls.some((call) => /set local search_path/.test(call.text)), false);
  assert.equal(calls.some((call) => /dune\.delete_/.test(call.text)), false);
});

test("container item add returns the new item id as a string", async () => {
  const calls = [];
  // dune.items.id is bigint; a Number cast is silent precision loss above 2^53.
  const db = fakeContainerAddDb(calls, {
    containerRows: [CONTAINER_ADD_ROW],
    insertedRows: [{
      id: "9007199254741001", template_id: "ScrapMetal", stack_size: 1,
      quality_level: 0, position_index: 0, inventory_id: 7
    }]
  });
  const result = await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 });
  assert.equal(typeof result.added.itemId, "string");
  assert.equal(result.added.itemId, "9007199254741001");
});

test("container item add reports capacity after the insert", async () => {
  const calls = [];
  const db = fakeContainerAddDb(calls, { containerRows: [CONTAINER_ADD_ROW], count: 8, maxPositionIndex: 7 });
  const result = await addBaseContainerItem(db, 16836, 42, { itemId: "ScrapMetal", quantity: 1 });
  assert.deepEqual(result.capacity, { usedSlots: 9, maxSlots: 45 });
  assert.equal(result.group, "storage");
  assert.equal(result.inventoryId, "7");
});

test("delete-multiple verifies ownership once, then deletes only the requested items that exist in that container", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    itemRows: [
      { item_id: "99", template_id: "ScrapMetal", stack_size: 500 },
      { item_id: "100", template_id: "AzuriteOre", stack_size: 20 }
    ]
  });
  const result = await deleteMultipleBaseContainerItems(db, 16836, 42, [99, 100, 101]);
  assert.equal(result.ok, true);
  assert.equal(result.removed.length, 2, "item 101 does not exist in this container and is skipped, not errored");
  assert.equal(result.message, "2 of 3 requested item(s) were deleted from the database.");
  const ownershipCalls = calls.filter((call) => call.text.includes("select c.placeable_id::text as placeable_id, c.inventory_id") && call.text.includes("for update of inv"));
  assert.equal(ownershipCalls.length, 1, "ownership resolved once per batch, not once per item");
  // bigintParam returns a numeric string, not a native bigint.
  assert.ok(calls.some((call) => call.text.includes("dune.delete_item($1::bigint)") && call.values[0] === "99"));
  assert.ok(calls.some((call) => call.text.includes("dune.delete_item($1::bigint)") && call.values[0] === "100"));
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item($1::bigint)") && call.values[0] === "101"), false);
});

// Found during PR #349's own Layer 3 audit (issue #352, DBA + Security
// hats, HIGH severity): the original version of this function did 4
// sequential round-trips PER item (select-for-update, delete_item call, an
// exists check, a conditional fallback delete) -- worst case ~800
// statements for a 200-item batch, all while the container's row lock was
// held, blocking any concurrent give/fill/delete against the SAME
// container for the whole duration. Fixed to resolve/verify the whole
// batch in a small, fixed number of set-based round-trips instead of one
// pair per item. This test proves the fixed shape directly by counting
// calls, not just asserting the end result is correct.
test("delete-multiple resolves and verifies the whole batch in O(1) round-trips, not one pair per item", async () => {
  const calls = [];
  const itemRows = Array.from({ length: 50 }, (_, index) => ({
    item_id: String(100 + index), template_id: "ScrapMetal", stack_size: 1
  }));
  const db = fakeBulkContainerDeleteDb(calls, { itemRows });
  const result = await deleteMultipleBaseContainerItems(db, 16836, 42, itemRows.map((row) => Number(row.item_id)));
  assert.equal(result.removed.length, 50);

  // Exactly one ownership resolution, one set-based item lookup, one
  // set-based "still present" verification -- the only per-item cost left
  // is the irreducible dune.delete_item call itself (50, one per item).
  const ownershipCalls = calls.filter((call) => call.text.includes("select c.placeable_id::text as placeable_id, c.inventory_id") && call.text.includes("for update of inv"));
  const lookupCalls = calls.filter((call) => call.text.includes("where id = any($1::bigint[]) and inventory_id = $2") && call.text.includes("for update"));
  const verifyCalls = calls.filter((call) => call.text.includes("select id::text as item_id from dune.items where id = any($1::bigint[]) and inventory_id = $2"));
  const deleteItemCalls = calls.filter((call) => call.text.includes("dune.delete_item($1::bigint)"));
  assert.equal(ownershipCalls.length, 1);
  assert.equal(lookupCalls.length, 1);
  assert.equal(verifyCalls.length, 1);
  assert.equal(deleteItemCalls.length, 50, "one delete_item call per item is unavoidable -- it is a shipped, single-argument procedure");
  // Every call that is NOT a per-item dune.delete_item call is fixed
  // overhead (ownership resolution, the batch lookup, the batch
  // verification, plus schema-capability probes that run once regardless
  // of batch size) -- it must not scale with the number of items. The old,
  // per-item-loop shape would have made this scale linearly (4 extra calls
  // per item instead of 0).
  const nonDeleteItemCalls = calls.length - deleteItemCalls.length;
  assert.equal(nonDeleteItemCalls, calls.length - 50);
  assert.ok(nonDeleteItemCalls < 15, `fixed overhead should be small and batch-size-independent, got ${nonDeleteItemCalls} calls for a 50-item batch`);
});

// Locks in the raw-delete fallback for the SET-based verification path --
// mirrors the single-item delete's own "the shipped procedure is preferred
// for its item tracking log, but the row disappearing is what actually
// matters" behavior, now applied per-batch instead of per-item.
test("delete-multiple falls back to a raw delete for any row dune.delete_item leaves behind", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    itemRows: [
      { item_id: "99", template_id: "ScrapMetal", stack_size: 500 },
      { item_id: "100", template_id: "AzuriteOre", stack_size: 20 }
    ],
    idsLeftAfterDeleteItem: [100]
  });
  const result = await deleteMultipleBaseContainerItems(db, 16836, 42, [99, 100]);
  assert.equal(result.removed.length, 2, "both items are still reported removed -- the fallback delete is what makes that true");
  const fallbackDelete = calls.find((call) => call.text.includes("delete from dune.items where id = any($1::bigint[]) and inventory_id = $2"));
  assert.ok(fallbackDelete, "must fall back to a raw delete for item 100, which the procedure left behind");
  assert.deepEqual(fallbackDelete.values[0], ["100"], "the fallback must target only the row(s) still present, not the whole batch");
});

// Same audit-detail fields deleteBaseContainerItem's own destroyedState
// captures (issue #350, found during PR #349's Layer 3 audit): without
// these, a bulk-destroyed pristine legendary logs identically to a
// bulk-destroyed broken common of the same template.
test("delete-multiple records what was destroyed for every item in the batch, not just id/template/count", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    itemRows: [
      {
        item_id: "99", template_id: "ScrapMetal", stack_size: 500,
        position_index: 3, quality_level: 2, current_durability: "45", max_durability: 90
      },
      {
        item_id: "100", template_id: "AzuriteOre", stack_size: 20,
        position_index: 5, quality_level: 1, current_durability: "10", max_durability: 10
      }
    ]
  });
  const result = await deleteMultipleBaseContainerItems(db, 16836, 42, [99, 100]);
  assert.equal(result.removed.length, 2);
  assert.deepEqual(result.removed[0], {
    itemId: "99", templateId: "ScrapMetal", count: 500,
    positionIndex: 3, qualityLevel: 2, currentDurability: 45, maxDurability: 90
  });
  assert.deepEqual(result.removed[1], {
    itemId: "100", templateId: "AzuriteOre", count: 20,
    positionIndex: 5, qualityLevel: 1, currentDurability: 10, maxDurability: 10
  });
});

// Mirrors "container item delete degrades to null state fields on a schema
// without them" for the single-item path -- a schema missing
// position_index/quality_level/stats must degrade the batch delete's audit
// fields to null/0, not fail the whole batch.
test("delete-multiple degrades audit-detail fields to null/0 on a schema without them, rather than failing", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    itemRows: [{ item_id: "99", template_id: "ScrapMetal", stack_size: 500 }],
    itemColumns: ["id", "inventory_id", "stack_size", "template_id"]
  });
  const result = await deleteMultipleBaseContainerItems(db, 16836, 42, [99]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed[0], {
    itemId: "99", templateId: "ScrapMetal", count: 500,
    positionIndex: null, qualityLevel: 0, currentDurability: null, maxDurability: null
  });
  const lookupCall = calls.find((call) => call.text.includes("where id = any($1::bigint[]) and inventory_id = $2") && call.text.includes("for update"));
  assert.match(lookupCall.text, /null::bigint as position_index/);
  assert.match(lookupCall.text, /0::bigint as quality_level/);
});

test("delete-multiple rejects an empty item list", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls);
  await assert.rejects(() => deleteMultipleBaseContainerItems(db, 16836, 42, []), /At least one item ID is required/);
});

test("delete-multiple rejects more than 200 items in one batch", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls);
  const ids = Array.from({ length: 201 }, (_, index) => index + 1);
  await assert.rejects(() => deleteMultipleBaseContainerItems(db, 16836, 42, ids), /Cannot delete more than 200 items/);
});

test("delete-multiple keeps crafting and refining inventories read-only", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    containerRows: [{ ...OWNED_STORAGE_CONTAINER_ROW, group_key: "refining", type_name: "Small Ore Refinery" }],
    itemRows: [{ item_id: "99", template_id: "ScrapMetal", stack_size: 500 }]
  });
  await assert.rejects(
    () => deleteMultipleBaseContainerItems(db, 16836, 42, [99]),
    /only be deleted from Storage containers/
  );
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item")), false);
});

test("delete-multiple rejects a container that was not found at the selected base", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, { containerRows: [] });
  await assert.rejects(
    () => deleteMultipleBaseContainerItems(db, 16836, 42, [99]),
    /not found at the selected base/
  );
});

// Found during PR #349's own Layer 3 audit (DBA and QA hats independently):
// docs/console/base-inventory.md documents "a placeable can back more than
// one surviving inventory" as a GENERAL schema fact, not something scoped
// to Refining/Crafting's known dual-inventory case. An earlier version of
// resolveOwnedStorageContainer had no ORDER BY/LIMIT and took rows[0]
// unconditionally -- silently picking whichever inventory Postgres happened
// to return first, which could leave real items behind in a second,
// un-selected inventory while deleteAllBaseContainerItems still reported
// ok:true. Fixed to throw explicitly rather than guess; this test locks
// that fix in and must keep failing if a future change reintroduces the
// silent rows[0] pick.
test("delete-multiple refuses to guess when a container backs more than one qualifying inventory", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    containerRows: [
      { placeable_id: "42", inventory_id: 7, group_key: "storage", type_name: "Medium Storage Container" },
      { placeable_id: "42", inventory_id: 8, group_key: "storage", type_name: "Medium Storage Container" }
    ]
  });
  await assert.rejects(
    () => deleteMultipleBaseContainerItems(db, 16836, 42, [99]),
    /backs 2 separate inventories/
  );
  // Must fail before ever touching dune.items -- no partial/best-effort
  // delete against either inventory.
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item")), false);
});

test("delete-all refuses to guess when a container backs more than one qualifying inventory", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    containerRows: [
      { placeable_id: "42", inventory_id: 7, group_key: "storage", type_name: "Medium Storage Container" },
      { placeable_id: "42", inventory_id: 8, group_key: "storage", type_name: "Medium Storage Container" }
    ]
  });
  await assert.rejects(
    () => deleteAllBaseContainerItems(db, 16836, 42),
    /backs 2 separate inventories/
  );
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item")), false);
});

test("delete-all deletes every item currently in the container, read fresh inside the transaction", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    itemRows: [
      { item_id: "99", template_id: "ScrapMetal", stack_size: 500 },
      { item_id: "100", template_id: "AzuriteOre", stack_size: 20 },
      { item_id: "101", template_id: "PlantFiber", stack_size: 5 }
    ]
  });
  const result = await deleteAllBaseContainerItems(db, 16836, 42);
  assert.equal(result.ok, true);
  assert.equal(result.removed.length, 3);
  assert.equal(result.message, "3 item(s) were deleted from the database.");
  const deleteCalls = calls.filter((call) => call.text.includes("dune.delete_item($1::bigint)"));
  assert.equal(deleteCalls.length, 3);
});

// Same fix as deleteMultipleBaseContainerItems (issue #352) -- verification
// after the dune.delete_item loop is one set-based call, not one per item.
test("delete-all verifies the whole container in one set-based call after the delete_item loop, not one per item", async () => {
  const calls = [];
  const itemRows = Array.from({ length: 40 }, (_, index) => ({
    item_id: String(200 + index), template_id: "PlantFiber", stack_size: 1
  }));
  const db = fakeBulkContainerDeleteDb(calls, { itemRows });
  const result = await deleteAllBaseContainerItems(db, 16836, 42);
  assert.equal(result.removed.length, 40);
  const verifyCalls = calls.filter((call) => call.text.includes("select id::text as item_id from dune.items where id = any($1::bigint[]) and inventory_id = $2"));
  const deleteItemCalls = calls.filter((call) => call.text.includes("dune.delete_item($1::bigint)"));
  assert.equal(verifyCalls.length, 1, "one set-based verification for the whole container, not one per item");
  assert.equal(deleteItemCalls.length, 40, "one delete_item call per item is unavoidable -- it is a shipped, single-argument procedure");
});

// Same audit-detail fields as the delete-multiple path (issue #350) --
// deleteAllBaseContainerItems shares finishDeletingLockedItems with
// deleteMultipleBaseContainerItems, so this locks in that the shared
// helper's fields actually reach the caller for BOTH bulk paths, not just
// the one exercised above.
test("delete-all records what was destroyed for every item, including audit-detail fields", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    itemRows: [{
      item_id: "99", template_id: "ScrapMetal", stack_size: 500,
      position_index: 3, quality_level: 2, current_durability: "45", max_durability: 90
    }]
  });
  const result = await deleteAllBaseContainerItems(db, 16836, 42);
  assert.deepEqual(result.removed[0], {
    itemId: "99", templateId: "ScrapMetal", count: 500,
    positionIndex: 3, qualityLevel: 2, currentDurability: 45, maxDurability: 90
  });
});

test("delete-all reports an already-empty container distinctly rather than as a no-op deletion", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, { itemRows: [] });
  const result = await deleteAllBaseContainerItems(db, 16836, 42);
  assert.equal(result.ok, true);
  assert.equal(result.removed.length, 0);
  assert.equal(result.message, "Container was already empty.");
});

test("delete-all keeps crafting and refining inventories read-only", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    containerRows: [{ ...OWNED_STORAGE_CONTAINER_ROW, group_key: "crafting", type_name: "Fabricator" }],
    itemRows: [{ item_id: "99", template_id: "ScrapMetal", stack_size: 500 }]
  });
  await assert.rejects(
    () => deleteAllBaseContainerItems(db, 16836, 42),
    /only be deleted from Storage containers/
  );
  assert.equal(calls.some((call) => call.text.includes("dune.delete_item")), false);
});

test("delete-all rejects a container that was not found at the selected base", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, { containerRows: [] });
  await assert.rejects(
    () => deleteAllBaseContainerItems(db, 16836, 42),
    /not found at the selected base/
  );
});

// Explicit design-decision lock: Developer Storage Container
// (developer_storagecontainer_placeable / Developer_Storage_Container_Patent)
// is deliberately NOT special-cased anywhere in this feature, despite being
// grantable only via the "Show Experimental" toggle in the Building Sets
// tab (see adminCatalog.test.js's buildingUnlockIsExperimental coverage). It
// is already in BASE_INVENTORY_TYPES.storage alongside every other storage
// building, and capacity is read live from the placed instance's own
// dune.inventories row -- there is no missing static data blocking it. This
// test exists so a future change cannot silently carve it out (or back in)
// without a test noticing either way.
test("delete-all treats a Developer Storage Container exactly like any other storage-group container", async () => {
  const calls = [];
  const db = fakeBulkContainerDeleteDb(calls, {
    containerRows: [{ placeable_id: "77", inventory_id: 9, group_key: "storage", type_name: "Developer Storage Container" }],
    itemRows: [{ item_id: "200", template_id: "AzuriteOre", stack_size: 20 }]
  });
  const result = await deleteAllBaseContainerItems(db, 16836, 77);
  assert.equal(result.ok, true);
  assert.equal(result.group, "storage");
  assert.equal(result.typeName, "Developer Storage Container");
  assert.equal(result.removed.length, 1);
});

// baseContainerSlots: the per-slot read the contents overlay and its delete
// both rest on. Deliberately separate from baseInventory, whose items[] stays
// template-merged.
function fakeContainerSlotsDb(calls, fixtures = {}) {
  const {
    rows = [],
    itemColumns = ["id", "inventory_id", "stack_size", "position_index", "template_id", "stats", "quality_level"],
    // Defaults to no max_item_volume, matching itemColumns' own default of no
    // volume_override -- a schema without volume support until a test opts in.
    inventoryColumns = ["id", "actor_id", "max_item_count"]
  } = fixtures;
  return {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        const columns = values[1] === "inventories" ? inventoryColumns : itemColumns;
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (text.includes("requested_claims")) return { rows };
      return { rows: [] };
    }
  };
}

const SLOT_ROW = {
  inventory_id: "77", group_key: "storage", type_name: "Storage Container", max_item_count: 45,
  quality_level: 0, current_durability: null, max_durability: null
};

test("baseContainerSlots keeps two stacks of one template apart instead of merging them", async () => {
  const calls = [];
  const db = fakeContainerSlotsDb(calls, {
    rows: [
      { ...SLOT_ROW, item_id: "1", template_id: "ScrapMetal", stack_size: 500, position_index: 0 },
      { ...SLOT_ROW, item_id: "2", template_id: "MagnetiteOre", stack_size: 200, position_index: 1 },
      { ...SLOT_ROW, item_id: "3", template_id: "ScrapMetal", stack_size: 400, position_index: 2 }
    ]
  });
  const result = await baseContainerSlots(db, 16836, 40001);

  assert.equal(result.found, true);
  assert.equal(result.usedSlots, 3);
  assert.equal(result.maxSlots, 45);
  const slots = result.inventories[0].slots;
  assert.equal(slots.length, 3);
  // The whole point: the merged items[] would report one ScrapMetal of 900.
  assert.deepEqual(slots.filter((slot) => slot.templateId === "ScrapMetal").map((slot) => slot.quantity), [500, 400]);
  assert.deepEqual(slots.map((slot) => slot.positionIndex), [0, 1, 2]);
  assert.deepEqual(slots.map((slot) => slot.itemId), ["1", "2", "3"]);
});

test("baseContainerSlots groups slots per inventory rather than flat on the container", async () => {
  const calls = [];
  // A placeable can back more than one inventory. maxSlots is their sum while
  // position_index is scoped to one, so a flat array would collide two slot 0s.
  const db = fakeContainerSlotsDb(calls, {
    rows: [
      { ...SLOT_ROW, inventory_id: "77", max_item_count: 5, item_id: "1", template_id: "MagnetiteOre", stack_size: 10, position_index: 0 },
      { ...SLOT_ROW, inventory_id: "78", max_item_count: 10, item_id: "2", template_id: "AluminiumBar", stack_size: 20, position_index: 0 }
    ]
  });
  const result = await baseContainerSlots(db, 16836, 40001);

  assert.equal(result.inventories.length, 2);
  assert.equal(result.maxSlots, 15);
  assert.deepEqual(result.inventories.map((inventory) => inventory.slots.length), [1, 1]);
  // Both really are slot 0 -- of different inventories.
  assert.deepEqual(result.inventories.map((inventory) => inventory.slots[0].positionIndex), [0, 0]);
});

test("baseContainerSlots keeps an empty inventory so the grid can render its empty slots", async () => {
  const calls = [];
  // The LEFT JOIN emits one all-null item row for an empty container.
  const db = fakeContainerSlotsDb(calls, {
    rows: [{ ...SLOT_ROW, item_id: null, template_id: null, stack_size: null, position_index: null }]
  });
  const result = await baseContainerSlots(db, 16836, 40001);

  assert.equal(result.found, true);
  assert.equal(result.usedSlots, 0);
  assert.equal(result.inventories.length, 1);
  assert.equal(result.inventories[0].maxSlots, 45);
  assert.deepEqual(result.inventories[0].slots, []);
});

test("baseContainerSlots answers found:false for a container that is not at the base", async () => {
  const calls = [];
  const db = fakeContainerSlotsDb(calls, { rows: [] });
  const result = await baseContainerSlots(db, 16836, 999999);
  // An ownership answer, not an error -- and the same shape the route returns
  // 200 with.
  assert.equal(result.supported, true);
  assert.equal(result.found, false);
  assert.deepEqual(result.inventories, []);
});

test("baseContainerSlots degrades rather than failing when dune.items lacks the per-slot columns", async () => {
  const calls = [];
  // A missing column is a parse-time error, not a null, so an older schema
  // would 500 a container that used to open if these were assumed.
  const db = fakeContainerSlotsDb(calls, {
    itemColumns: ["id", "inventory_id", "stack_size", "template_id"],
    rows: [{ ...SLOT_ROW, item_id: "1", template_id: "ScrapMetal", stack_size: 500, position_index: null }]
  });
  const result = await baseContainerSlots(db, 16836, 40001);

  assert.equal(result.inventories[0].slots[0].positionIndex, null);
  const query = calls.find((call) => call.text.includes("requested_claims"));
  // The literals stand in for the absent columns; nothing references them.
  assert.match(query.text, /null::bigint as position_index/);
  assert.ok(!query.text.includes("i.position_index"), "must not select a column this schema lacks");
  assert.match(query.text, /null::numeric as max_durability/);
});

test("baseContainerSlots extracts an item's applied augments with their own per-augment grade", async () => {
  const calls = [];
  // Same jsonb shape buildAugmentedItemStats writes on the add side:
  // AppliedAugments[].Name paired positionally with AppliedAugmentQualities.
  // An id unlikely to be in the real catalog, so the assertion doesn't depend
  // on what the catalog happens to contain -- it must fall back to the id.
  const db = fakeContainerSlotsDb(calls, {
    rows: [{
      ...SLOT_ROW, item_id: "1", template_id: "UniqueSword_05", stack_size: 1, position_index: 0,
      applied_augments: [{ Name: "T6_Augment_UnitTestFixture1" }, { Name: "T6_Augment_UnitTestFixture2" }],
      applied_augment_qualities: [2, 3]
    }]
  });
  const result = await baseContainerSlots(db, 16836, 40001);
  assert.deepEqual(result.inventories[0].slots[0].augments, [
    { templateId: "T6_Augment_UnitTestFixture1", name: "T6_Augment_UnitTestFixture1", qualityLevel: 2 },
    { templateId: "T6_Augment_UnitTestFixture2", name: "T6_Augment_UnitTestFixture2", qualityLevel: 3 }
  ]);
});

test("baseContainerSlots reports an empty augments array for an item with none", async () => {
  const calls = [];
  const db = fakeContainerSlotsDb(calls, {
    rows: [{ ...SLOT_ROW, item_id: "1", template_id: "ScrapMetal", stack_size: 500, position_index: 0 }]
  });
  const result = await baseContainerSlots(db, 16836, 40001);
  // Not undefined, not null -- the frontend's `.length > 0` check needs a
  // real array on every slot, augmented or not.
  assert.deepEqual(result.inventories[0].slots[0].augments, []);
});

test("baseContainerSlots does not throw on a shorter qualities array than augments", async () => {
  const calls = [];
  // A corrupt or hand-edited row; the display path should degrade, not 500.
  const db = fakeContainerSlotsDb(calls, {
    rows: [{
      ...SLOT_ROW, item_id: "1", template_id: "UniqueSword_05", stack_size: 1, position_index: 0,
      applied_augments: [{ Name: "T6_Augment_UnitTestFixture1" }, { Name: "T6_Augment_UnitTestFixture2" }],
      applied_augment_qualities: [2]
    }]
  });
  const result = await baseContainerSlots(db, 16836, 40001);
  assert.deepEqual(
    result.inventories[0].slots[0].augments.map((augment) => augment.qualityLevel),
    [2, 0]
  );
});

test("baseContainerSlots degrades augments to an empty array on a schema without stats", async () => {
  const calls = [];
  const db = fakeContainerSlotsDb(calls, {
    itemColumns: ["id", "inventory_id", "stack_size", "template_id"],
    rows: [{ ...SLOT_ROW, item_id: "1", template_id: "ScrapMetal", stack_size: 500, position_index: null }]
  });
  const result = await baseContainerSlots(db, 16836, 40001);
  assert.deepEqual(result.inventories[0].slots[0].augments, []);
  const query = calls.find((call) => call.text.includes("requested_claims"));
  assert.match(query.text, /null::jsonb as applied_augments/);
  assert.match(query.text, /null::jsonb as applied_augment_qualities/);
});

// Issue #356 (found during PR #349's Layer 3 audit): items given before the
// volume-checking fix landed permanently carry a NULL volume_override, which
// every capacity check already treats as 0 -- so the console's own volume
// accounting silently undercounts real usage for pre-existing rows. A
// backfill was judged too risky to run against every operator's live
// dune.items data for a LOW-MEDIUM accuracy gap (Strict Requirement 0/26);
// this test locks in that the per-container slots view now surfaces the
// real, current volume total directly instead of leaving it implicit.
//
// CORRECTED 2026-08-19 (see docs/incidents/
// INC-2026-08-19-VOLUME-OVERRIDE-DOUBLE-MULTIPLIED.md): volume_override is
// a PER-UNIT value, not the stack's total -- the total contribution of a row
// is volume_override * stack_size.
test("baseContainerSlots reports current and max volume per inventory", async () => {
  const calls = [];
  const db = fakeContainerSlotsDb(calls, {
    inventoryColumns: ["id", "actor_id", "max_item_count", "max_item_volume"],
    itemColumns: ["id", "inventory_id", "stack_size", "position_index", "template_id", "stats", "quality_level", "volume_override"],
    rows: [
      { ...SLOT_ROW, max_item_volume: 500, item_id: "1", template_id: "ScrapMetal", stack_size: 500, position_index: 0, volume_override: 0.08 },
      { ...SLOT_ROW, max_item_volume: 500, item_id: "2", template_id: "MagnetiteOre", stack_size: 200, position_index: 1, volume_override: 0.075 }
    ]
  });
  const result = await baseContainerSlots(db, 16836, 40001);

  assert.equal(result.maxVolume, 500, "max volume is read once per inventory, not summed per item row");
  assert.equal(result.currentVolume, 55, "current volume sums volume_override (a per-unit value) * stack_size across every row");
  assert.equal(result.inventories[0].maxVolume, 500);
  assert.equal(result.inventories[0].currentVolume, 55);
});

test("baseContainerSlots degrades volume to 0/0 on a schema without max_item_volume/volume_override, rather than failing", async () => {
  const calls = [];
  const db = fakeContainerSlotsDb(calls, {
    rows: [{ ...SLOT_ROW, item_id: "1", template_id: "ScrapMetal", stack_size: 500, position_index: 0 }]
  });
  const result = await baseContainerSlots(db, 16836, 40001);

  assert.equal(result.currentVolume, 0);
  assert.equal(result.maxVolume, 0);
  const query = calls.find((call) => call.text.includes("requested_claims"));
  assert.match(query.text, /0::real as max_item_volume/);
  assert.match(query.text, /0::real as volume_override/);
});

test("baseContainerSlots scopes to the base and keeps the container allowlist filters", async () => {
  const calls = [];
  const db = fakeContainerSlotsDb(calls, { rows: [] });
  await baseContainerSlots(db, 16836, 40001);
  const query = calls.find((call) => call.text.includes("requested_claims"));

  // Dropping any of these would let the overlay reach a generator or windtrap
  // fuel inventory that the Power and Water tabs own.
  assert.match(query.text, /join inventory_types it on it\.building_type = lower\(p\.building_type\)/);
  assert.match(query.text, /p\.is_hologram = false/);
  assert.match(query.text, /inv\.max_item_count >= 0/);
  assert.equal(query.values[0], 16836);
  assert.equal(query.values[4], 40001);
  // Slot order, not template order -- the overlay renders a row per slot.
  assert.match(query.text, /order by c\.inventory_id, i\.position_index nulls last, i\.id/);
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

test("inventory update repairs a specialization-crafted item to its stored 200 durability maximum", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 99, stats: { FItemStackAndDurabilityStats: [[], { CurrentDurability: 100, MaxDurability: 200 }] } }] };
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) return { rows: [{ name: "id" }, { name: "stats", data_type: "jsonb" }] };
      return { rows: [], rowCount: 1 };
    },
    transaction: async (fn) => fn(db)
  };
  const result = await updateInventoryItem(db, 123, 99, { current_durability: "200" });
  assert.equal(result.updatedRows, 1);
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  const statsValue = JSON.parse(updateCall.values[0]);
  assert.deepEqual(statsValue.FItemStackAndDurabilityStats[1], { CurrentDurability: 200, MaxDurability: 200 });
});

test("inventory update uses DecayedMaxDurability when legacy MaxDurability is zero", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 99, stats: { FItemStackAndDurabilityStats: [[], { CurrentDurability: 100, MaxDurability: 0, DecayedMaxDurability: 200 }] } }] };
      if (text.includes("pg_index")) return { rows: [{ name: "id" }] };
      if (text.includes("information_schema.columns")) return { rows: [{ name: "id" }, { name: "stats", data_type: "jsonb" }] };
      return { rows: [], rowCount: 1 };
    },
    transaction: async (fn) => fn(db)
  };
  const result = await updateInventoryItem(db, 123, 99, { current_durability: "200" });
  assert.equal(result.updatedRows, 1);
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  const statsValue = JSON.parse(updateCall.values[0]);
  assert.deepEqual(statsValue.FItemStackAndDurabilityStats[1], { CurrentDurability: 200, MaxDurability: 0, DecayedMaxDurability: 200 });
});

test("inventory update rejects attempts to change the stored maximum durability", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemRows: [{ id: 99, template_id: "WaterBottle_1", stack_size: 1, quality_level: 0, position_index: 0, inventory_id: 7, actor_id: 123, stats: { FItemStackAndDurabilityStats: [[], { CurrentDurability: 50, DecayedMaxDurability: 80 }] } }]
  });
  await assert.rejects(() => updateInventoryItem(db, 123, 99, { max_durability: "200" }), /Maximum durability is read-only/);
  assert.equal(calls.some((call) => String(call.text).startsWith("update dune.items")), false);
});

test("inventory update rejects current_durability greater than max_durability", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemRows: [{ id: 99, template_id: "WaterBottle_1", stack_size: 1, quality_level: 0, position_index: 0, inventory_id: 7, actor_id: 123, stats: { FItemStackAndDurabilityStats: [[], { CurrentDurability: 50, DecayedMaxDurability: 80 }] } }]
  });
  await assert.rejects(() => updateInventoryItem(db, 123, 99, { current_durability: "95" }), /Invalid current durability/);
  assert.equal(calls.some((call) => String(call.text).startsWith("update dune.items")), false);
});

test("inventory update preserves the existing DecayedMaxDurability while changing current durability", async () => {
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
  const result = await updateInventoryItem(db, 123, 99, { current_durability: "60" });
  assert.equal(result.updatedRows, 1);
  const updateCall = calls.find((call) => String(call.text).startsWith("update"));
  assert.ok(updateCall);
  const statsValue = JSON.parse(updateCall.values[0]);
  assert.deepEqual(statsValue.FCustomizationStats, [[], { color: "sand" }]);
  assert.deepEqual(statsValue.FItemStackAndDurabilityStats[1], { CurrentDurability: 60, DecayedMaxDurability: 80 });
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

// CORRECTED 2026-08-19 (position_index collision mitigation, see
// docs/incidents/INC-2026-08-19-GIVE-FILL-POSITION-INDEX-COLLISION.md):
// give-item now picks the HIGHEST unused slot below max_item_count
// (nextHighPositionIndex), not the lowest-next-free slot -- this test's
// fixture (highPositionIndex: 29, matching max_item_count: 30) locks that
// in, replacing the old lowest-next-free assertion.
test("storage give-item validates capacity and inserts parameterized item rows", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    highPositionIndex: 29,
    insertedRows: [{ id: 501, template_id: "WaterBottle_1", stack_size: 3, quality_level: 0, position_index: 29, inventory_id: 7 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "WaterBottle_1", quantity: 3 });
  assert.equal(result.inserted.id, 501);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 5), [7, "WaterBottle_1", 3, 0, 29]);
  const positionCall = calls.find((call) => call.text === "select position_index from dune.items where inventory_id = $1");
  assert.ok(positionCall, "give-item must read the occupied-slot set once and claim the highest free in-range slot from it");
  assert.deepEqual(positionCall.values, [7]);
});

// The fallback path: an uncapped/unknown-capacity container (max_item_count
// 0, e.g. a schema without the column or a genuinely uncapped inventory)
// has no known "high end" to start from -- nextHighPositionIndex falls
// back to the pre-existing lowest-next-free convention instead.
test("storage give-item falls back to lowest-next-free position when max_item_count is 0 (unknown/uncapped)", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 0, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 501, template_id: "WaterBottle_1", stack_size: 3, quality_level: 0, position_index: 2, inventory_id: 7 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "WaterBottle_1", quantity: 3 });
  assert.equal(result.inserted.id, 501);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 5), [7, "WaterBottle_1", 3, 0, 2]);
  assert.ok(!calls.some((call) => call.text === "select position_index from dune.items where inventory_id = $1"), "must not read the occupied set when max_item_count is 0 -- the max+1 fallback applies");
});

// Found during code review (2026-08-19): nextHighPositionIndex's own
// fallback (reached when the high-end generate_series query finds no free
// slot below max_item_count) previously returned max(position_index)+1
// unconditionally, even if that value was itself at or beyond
// max_item_count -- silently inserting a row outside the container's
// stated capacity instead of failing loudly. Fixed to throw, matching this
// file's established "throw rather than guess" precedent
// (resolveOwnedStorageContainer's own multi-inventory guard). Exercised
// here via giveItemToBaseContainer, whose real single-item Give path still
// calls nextHighPositionIndex directly (giveMultipleItemsToBaseContainer's
// own in-memory equivalent, claimPositionIndex, carries the identical
// guard -- see its own test coverage above).
test("give-item throws rather than silently exceeding capacity when nextHighPositionIndex's fallback is itself out of range", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 2, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    // Every slot below max_item_count is already claimed even though the
    // count looks like there is room (corrupted position data + stale
    // count -- the one scenario that breaks the pigeonhole argument), so
    // the claimer must throw rather than exceed the range.
    existingPositionIndexRows: [0, 1]
  });
  await assert.rejects(
    () => giveItemToBaseContainer(db, 16836, 42, { templateId: "WaterBottle_1", quantity: 1 }),
    /item slot indexes appear inconsistent/
  );
  assert.equal(calls.some((call) => call.text.includes("insert into dune.items")), false);
});

test("storage give-item records PER-UNIT volume_override when itemVolume is provided", async () => {
  // Parity fix: give-item previously never checked or recorded volume at
  // all, unlike fill-item -- an operator could give an item whose declared
  // volume exceeded a container's remaining volume, and rows inserted by
  // give-item never contributed to fill-item's own sum(volume_override)
  // check on subsequent calls. Added 2026-08-18 alongside the raw-resource
  // catalog work, proactively (found during design review, not a live bug).
  //
  // CORRECTED 2026-08-19 (real live in-game bug, see
  // docs/incidents/INC-2026-08-19-VOLUME-OVERRIDE-DOUBLE-MULTIPLIED.md):
  // volume_override must be the PER-UNIT volume, not itemVolume * stackSize
  // -- storing the total made the live game engine (which multiplies
  // volume_override by stack_size itself for display) double-multiply,
  // inflating displayed volume by a factor of stack_size.
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 100 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ total_volume: 10 }],
    insertedRows: [{ id: 503, template_id: "AzuriteOre", stack_size: 20, quality_level: 0, position_index: 4, inventory_id: 7, volume_override: 0.2 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "AzuriteOre", quantity: 20, itemVolume: 0.2 });
  assert.equal(result.inserted.id, 503);
  assert.equal(result.inserted.volume_override, 0.2);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const volIdx = insert.values.length - 1;
  assert.equal(insert.values[volIdx], 0.2, "volume_override stored is the per-unit value, not per-unit * stackSize");
  const volumeCall = calls.find((call) => call.text.includes("select template_id, stack_size, volume_override"));
  assert.ok(volumeCall, "volume sum query must run when itemVolume is provided");
  assert.ok(volumeCall, "capacity reads every stack so NULL overrides can fall back to catalog volume");
});

// Never rejects on a partial volume fit (issue #347 follow-up, per explicit
// operator direction): a requested quantity that would exceed remaining
// volume is CLAMPED to whatever actually fits and inserted, rather than
// rejecting the whole give and forcing the operator to guess a smaller
// number. 15 max, 10 already used -> 5.0 remaining / 0.2 per-unit = 25 max
// fit, clamped down from the requested 50.
test("storage give-item clamps a requested quantity down to whatever volume actually fits, rather than rejecting", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 15 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ total_volume: 10 }],
    insertedRows: [{ id: 505, template_id: "AzuriteOre", stack_size: 25, quality_level: 0, position_index: 6, inventory_id: 7, volume_override: 5.0 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "AzuriteOre", quantity: 50, itemVolume: 0.2 });
  assert.equal(result.ok, true);
  assert.equal(result.requested, 50);
  assert.equal(result.given, 25);
  assert.equal(result.clamped, true);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  // The actually-inserted stack_size must be the clamped 25, not the
  // originally-requested 50 -- inserting 50 anyway would silently exceed
  // the container's real volume cap.
  assert.equal(insert.values[2], 25);
});

test("storage give-item counts game-created NULL overrides from catalog volume and permits an exact final unit", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 500 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ template_id: "AzuriteOre", stack_size: 2499, volume_override: null }],
    insertedRows: [{ id: 506, template_id: "AzuriteOre", stack_size: 1, inventory_id: 7, volume_override: 0.2 }]
  });

  const result = await giveItemToStorage(db, 222, { templateId: "AzuriteOre", quantity: 1, itemVolume: 0.2 });

  assert.equal(result.given, 1);
  assert.equal(result.clamped, false);
  assert.ok(calls.some((call) => call.text.includes("insert into dune.items")));
});

test("storage give-item refuses to guess when an existing stack has no known volume", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 500 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ template_id: "UnknownTemplate", stack_size: 1, volume_override: null }]
  });

  await assert.rejects(
    () => giveItemToStorage(db, 222, { templateId: "AzuriteOre", quantity: 1, itemVolume: 0.2 }),
    /cannot be calculated safely/
  );
  assert.equal(calls.some((call) => call.text.includes("insert into dune.items")), false);
});

// The one case that IS still a real rejection: truly zero room left, where
// clamping would mean giving 0 -- there is nothing useful to insert or
// report as given.
test("storage give-item still rejects when there is no room for even 1 unit", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 15 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ total_volume: 15 }]
  });
  await assert.rejects(
    () => giveItemToStorage(db, 222, { templateId: "AzuriteOre", quantity: 50, itemVolume: 0.2 }),
    /Storage is full by volume/
  );
});

test("storage give-item does not check volume when itemVolume is omitted (backward compatible)", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 15 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 504, template_id: "WaterBottle_1", stack_size: 100, quality_level: 0, position_index: 5, inventory_id: 7 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "WaterBottle_1", quantity: 100 });
  assert.equal(result.inserted.id, 504);
  const volumeCall = calls.find((call) => call.text.includes("select template_id, stack_size, volume_override"));
  assert.equal(volumeCall, undefined, "volume sum query must not run when itemVolume is not provided");
});

// Regression test for a real bug found during post-merge review of upstream
// PR #182 (2026-08-20): itemVolume defaults to 0 for any item with no
// catalogued volume data (see server.js's storageGiveItemRoute/
// baseContainerGiveItemRoute/baseContainerFillItemRoute, which resolve
// itemVolume via `resolved.volume || resolveItemVolume(...)`), but every
// insert site wrote that 0 straight into volume_override instead of NULL.
// NULL means "use the engine's own catalog volume" (see the 2026-08-19
// correction comment above giveItemToStorage's insert); a stored 0 makes
// the engine display the item as having zero volume instead of falling
// back to its real catalog value -- the same class of display corruption
// INC-2026-08-19-VOLUME-OVERRIDE-DOUBLE-MULTIPLIED fixed, just in the
// opposite (zero, not inflated) direction. Covers all 4 single-item Give/
// Fill entry points; giveMultipleItemsToBaseContainer's batch path shares
// the same volumeOverrideForInsert() helper, not independently re-tested
// here.
test("storage give-item stores volume_override as NULL, not 0, when itemVolume is omitted (uncatalogued item)", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 599, template_id: "SomeUncatalogedWeapon", stack_size: 1, quality_level: 0, position_index: 5, inventory_id: 7, volume_override: null }]
  });
  await giveItemToStorage(db, 222, { templateId: "SomeUncatalogedWeapon", quantity: 1 });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const volIdx = insert.values.length - 1;
  assert.equal(insert.values[volIdx], null, "volume_override must be stored as NULL for an uncatalogued item, not 0");
});

test("storage give-multiple-items inserts every item in one transaction", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [
      { id: 601, template_id: "AzuriteOre", stack_size: 20, quality_level: 0, position_index: 2, inventory_id: 7 },
      { id: 602, template_id: "PlantFiber", stack_size: 5, quality_level: 0, position_index: 3, inventory_id: 7 }
    ]
  });
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [
      { templateId: "AzuriteOre", quantity: 20 },
      { templateId: "PlantFiber", quantity: 5 }
    ]
  });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].inserted.id, 601);
  assert.equal(result.results[1].inserted.id, 602);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 2, "one insert per item");
  assert.equal(calls.filter((call) => call.text === "begin").length, 1, "single shared transaction");
});

// Batch-path coverage for the same NULL-vs-0 fix as giveItemToStorage's own
// regression test above (QA hat finding, post-merge review of PR #182:
// giveMultipleItemsToBaseContainer shares volumeOverrideForInsert() with the
// 4 single-item entry points but had no independent test of its own).
test("storage give-multiple-items stores volume_override as NULL, not 0, for an uncatalogued item", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 0 }],
    insertedRowsSequence: [
      { id: 601, template_id: "SomeUncatalogedWeapon", stack_size: 1, quality_level: 0, position_index: 2, inventory_id: 7, volume_override: null }
    ]
  });
  await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [{ templateId: "SomeUncatalogedWeapon", quantity: 1 }]
  });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const volIdx = insert.values.length - 1;
  assert.equal(insert.values[volIdx], null, "volume_override must be stored as NULL for an uncatalogued item, not 0");
});

// DBA hat finding (Layer 2 audit, 2026-08-19): every existing volume/slot
// test above stops the batch after item 1 (clamped or full), so item 2
// never actually exercises the carried-forward currentVolume/currentCount
// this function's round-trip fix relies on -- the arithmetic was correct
// by inspection, but nothing proved it end-to-end across more than one
// successful, non-terminal insert. This test's three items are chosen so
// each later item's correct clamp/no-clamp outcome is only reachable if
// the earlier items' consumption was genuinely carried forward in memory,
// not left at its initial static value.
test("storage give-multiple-items carries volume consumption forward across multiple successful inserts, not just a static initial reading", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 5, max_item_volume: 10 }],
    countRows: [{ count: 0 }],
    volumeRows: [{ total_volume: 0 }],
    insertedRowsSequence: [
      { id: 701, template_id: "AzuriteOre", stack_size: 3, quality_level: 0, position_index: 4, inventory_id: 7 },
      { id: 702, template_id: "PlantFiber", stack_size: 3, quality_level: 0, position_index: 3, inventory_id: 7 },
      { id: 703, template_id: "SteelBar", stack_size: 1, quality_level: 0, position_index: 2, inventory_id: 7 }
    ]
  });
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [
      { templateId: "AzuriteOre", quantity: 3, itemVolume: 2 }, // 3*2=6 of 10 -- fits fully
      { templateId: "PlantFiber", quantity: 3, itemVolume: 1 }, // needs 3 of the remaining 4 -- fits fully ONLY if item 1's 6 carried forward
      { templateId: "SteelBar", quantity: 2, itemVolume: 1 }    // needs 2 of the remaining 1 -- must clamp to 1 ONLY if items 1+2's combined 9 carried forward
    ]
  });
  assert.equal(result.results[0].given, 3, "item 1 fits fully: 3*2=6 of 10");
  assert.equal(result.results[0].clamped, false);
  assert.equal(result.results[1].given, 3, "item 2 must see item 1's just-consumed 6 volume (not a stale 0) to correctly find room for all 3");
  assert.equal(result.results[1].clamped, false);
  assert.equal(result.results[2].given, 1, "item 3 must see items 1+2's combined 9 volume consumed, leaving only 1 of 10 -- clamped down from the requested 2");
  assert.equal(result.results[2].clamped, true);
  // Only ONE live count(*) and ONE live volume-sum query for the whole
  // 3-item batch proves this is genuinely carried-forward in-memory state,
  // not re-queried (and only coincidentally correct) per item.
  const countCalls = calls.filter((call) => call.text.includes("count(*)::int"));
  const volumeCalls = calls.filter((call) => call.text.includes("select template_id, stack_size, volume_override"));
  assert.equal(countCalls.length, 1, "count(*) must run once for the whole batch, not once per item");
  assert.equal(volumeCalls.length, 1, "the volume sum must run once for the whole batch, not once per item");
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 3, "all three items, including the clamped-but-nonzero third, are inserted");
});

// Same high-end position mitigation as the single-item give test above --
// giveMultipleItemsToBaseContainer must pick the highest unused slot for
// every item it inserts in the batch, the same as a single Give would.
// Round-trip fix (issue #347 code-review follow-up, 2026-08-19): this no
// longer re-runs nextHighPositionIndex's own generate_series query per
// item -- it fetches every currently-occupied position_index ONCE up
// front and computes each item's slot in memory, updating that in-memory
// state as the batch claims slots, so this test seeds two pre-existing
// occupied slots (29 and 28) to prove the in-memory computation still
// starts from the real occupied set, not an empty one, and that the seed
// query itself only runs once regardless of batch size.
test("storage give-multiple-items claims the highest unused slot for every inserted item, from one seed query", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 2 }],
    existingPositionIndexRows: [29, 28],
    insertedRowsSequence: [
      { id: 601, template_id: "AzuriteOre", stack_size: 20, quality_level: 0, position_index: 27, inventory_id: 7 },
      { id: 602, template_id: "PlantFiber", stack_size: 5, quality_level: 0, position_index: 26, inventory_id: 7 }
    ]
  });
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [
      { templateId: "AzuriteOre", quantity: 20 },
      { templateId: "PlantFiber", quantity: 5 }
    ]
  });
  assert.equal(result.results[0].inserted.id, 601);
  assert.equal(result.results[1].inserted.id, 602);
  const seedCalls = calls.filter((call) => call.text === "select position_index from dune.items where inventory_id = $1");
  assert.equal(seedCalls.length, 1, "the occupied-position seed query must run once for the whole batch, not once per item");
  assert.equal(calls.filter((call) => call.text.includes("generate_series")).length, 0, "must not fall back to nextHighPositionIndex's own per-item query");
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts[0].values[4], 27, "slots 29/28 are already occupied -- item 1 must claim the next highest free slot");
  assert.equal(inserts[1].values[4], 26, "item 2 must see item 1's just-claimed slot 27 and skip it");
});

test("storage give-multiple-items rejects an empty item list", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }]
  });
  await assert.rejects(
    () => giveMultipleItemsToBaseContainer(db, 16836, 42, { items: [] }),
    /At least one item is required/
  );
});

test("storage give-multiple-items rejects more than 50 distinct items", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }]
  });
  const items = Array.from({ length: 51 }, (_, index) => ({ templateId: `Item${index}`, quantity: 1 }));
  await assert.rejects(
    () => giveMultipleItemsToBaseContainer(db, 16836, 42, { items }),
    /Cannot give more than 50 distinct items/
  );
});

// Never rejects (issue #347 follow-up): a batch stops -- rather than
// throwing -- once one item hits the slot cap, since a slot-count limit
// cannot be partially satisfied (one give always consumes exactly one
// slot). Found during PR #349's own Layer 3 QA audit that a static
// countRows fixture cannot distinguish "the batch correctly stops after
// item 1 succeeds" from "every item is rejected identically, including
// item 1" -- countRowsSequence lets count(*) reflect the just-inserted row
// on the SECOND call, the same way real Postgres would see its own
// transaction's prior write, so this test can actually prove item 1
// succeeded before item 2 was stopped.
test("storage give-multiple-items stops the batch (without throwing) when slot count is exhausted partway through", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 1, max_item_volume: 0 }],
    countRowsSequence: [{ count: 0 }, { count: 1 }],
    insertedRowsSequence: [
      { id: 701, template_id: "AzuriteOre", stack_size: 20, quality_level: 0, position_index: 2, inventory_id: 7 }
    ]
  });
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [
      { templateId: "AzuriteOre", quantity: 20 },
      { templateId: "PlantFiber", quantity: 5 }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2, "every requested item appears in the response, attempted or not");
  assert.equal(result.results[0].given, 20);
  assert.equal(result.results[0].attempted, true);
  assert.equal(result.results[1].given, 0);
  assert.equal(result.results[1].attempted, true, "item 2 WAS attempted -- it tripped the slot cap on its own check");
  assert.match(result.results[1].reason, /full by item slot count/);
  // The real proof this is "partway," not "rejects everything": exactly one
  // insert happened (item 1, AzuriteOre) before the second item's count
  // check tripped the slot cap.
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 1, "item 1 must have actually been inserted before item 2 was stopped");
});

// The tautological-test counterpart this fix guards against: if the slot
// cap trips on the FIRST item instead, zero inserts happen -- kept as its
// own test so the "partway" test above can never be satisfied by an
// implementation that stops everything from item 1.
test("storage give-multiple-items stops the whole batch when the slot cap is already full before item 1", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 1, max_item_volume: 0 }],
    countRows: [{ count: 1 }]
  });
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [
      { templateId: "AzuriteOre", quantity: 20 },
      { templateId: "PlantFiber", quantity: 5 }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].given, 0);
  assert.equal(result.results[0].attempted, true);
  assert.equal(result.results[1].given, 0);
  assert.equal(result.results[1].attempted, false, "item 2 was never even attempted -- item 1 already stopped the batch");
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 0, "no item should be inserted when the container was already full");
});

// Never rejects on volume either: an item that only partially fits is
// clamped and given, and the batch stops there (per design -- once one
// item does not fully fit, later items are not attempted).
test("storage give-multiple-items clamps an item that only partially fits by volume, and stops the batch there", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 5 }],
    countRows: [{ count: 1 }],
    // 5 max, 4 already used -> 1.0 remaining / 0.2 per-unit = 5 max fit,
    // clamped down from the requested 20.
    volumeRows: [{ total_volume: 4 }],
    insertedRows: [{ id: 702, template_id: "AzuriteOre", stack_size: 5, quality_level: 0, position_index: 2, inventory_id: 7, volume_override: 0.2 }]
  });
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [
      { templateId: "AzuriteOre", quantity: 20, itemVolume: 0.2 },
      { templateId: "PlantFiber", quantity: 5, itemVolume: 0.1 }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].requested, 20);
  assert.equal(result.results[0].given, 5);
  assert.equal(result.results[0].clamped, true);
  assert.equal(result.results[1].given, 0);
  assert.equal(result.results[1].attempted, false, "item 2 is not attempted once item 1 was clamped");
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 1, "the clamped item is still inserted, just at the smaller amount");
});

// Zero-fit within a batch: per explicit operator direction, this is
// recorded as given: 0 and the batch stops there successfully -- it is
// NOT a thrown error, even though nothing at all could be given for this
// specific item.
test("storage give-multiple-items records a zero-fit item as given: 0 and stops, without throwing", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 5 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ total_volume: 5 }]
  });
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [{ templateId: "AzuriteOre", quantity: 20, itemVolume: 0.2 }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].given, 0);
  assert.equal(result.results[0].attempted, true);
  assert.match(result.results[0].reason, /full by volume/);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 0, "a zero-fit item must not be inserted as an empty/zero-size row");
});

// Give/Fill/Give-Multiple base-container variants must refuse to guess an
// inventory the same way delete-multiple/delete-all already do (see
// "delete-multiple/delete-all refuses to guess when a container backs more
// than one qualifying inventory" above), instead of giveItemToStorage/
// fillItemToStorage/the old giveMultipleItemsToStorage's own actor_id-only
// lookup (`order by id limit 1`, no such guard). Found during code review
// (2026-08-19): giveItemToBaseContainer/fillItemToBaseContainer/
// giveMultipleItemsToBaseContainer now resolve their target inventory
// through resolveOwnedStorageContainer, the same ownership+lock+guard path,
// so they must throw the identical error rather than silently writing into
// whichever inventory row sorts first.
test("give-item refuses to guess when a container backs more than one qualifying inventory", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    containerRows: [
      { placeable_id: "42", inventory_id: 7, group_key: "storage", type_name: "Medium Storage Container" },
      { placeable_id: "42", inventory_id: 8, group_key: "storage", type_name: "Medium Storage Container" }
    ]
  });
  await assert.rejects(
    () => giveItemToBaseContainer(db, 16836, 42, { templateId: "WaterBottle_1", quantity: 1 }),
    /backs 2 separate inventories/
  );
  assert.equal(calls.some((call) => call.text.includes("insert into dune.items")), false);
});

test("give-multiple-items refuses to guess when a container backs more than one qualifying inventory", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    containerRows: [
      { placeable_id: "42", inventory_id: 7, group_key: "storage", type_name: "Medium Storage Container" },
      { placeable_id: "42", inventory_id: 8, group_key: "storage", type_name: "Medium Storage Container" }
    ]
  });
  await assert.rejects(
    () => giveMultipleItemsToBaseContainer(db, 16836, 42, { items: [{ templateId: "WaterBottle_1", quantity: 1 }] }),
    /backs 2 separate inventories/
  );
  assert.equal(calls.some((call) => call.text.includes("insert into dune.items")), false);
});

test("fill-item refuses to guess when a container backs more than one qualifying inventory", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    containerRows: [
      { placeable_id: "42", inventory_id: 7, group_key: "storage", type_name: "Medium Storage Container" },
      { placeable_id: "42", inventory_id: 8, group_key: "storage", type_name: "Medium Storage Container" }
    ]
  });
  await assert.rejects(
    () => fillItemToBaseContainer(db, "/tmp", 16836, 42, { templateId: "T6RefinedResourceA", quantity: 1, itemVolume: 1.0 }),
    /backs 2 separate inventories/
  );
  assert.equal(calls.some((call) => call.text.includes("insert into dune.items")), false);
});

// Belt-and-suspenders around the same lookup: a container from the wrong
// group (Refining/Crafting) must still be rejected the same way Delete's
// resolveOwnedStorageContainer already rejects it, now with wording that
// matches the actual verb (given to / filled into), not delete's "deleted
// from" default.
test("give-item and fill-item reject a non-storage-group container with an action-specific message", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { containerRows: [{ placeable_id: "42", inventory_id: 7, group_key: "refining", type_name: "Refinery" }] });
  await assert.rejects(
    () => giveItemToBaseContainer(db, 16836, 42, { templateId: "WaterBottle_1", quantity: 1 }),
    /Items can only be given to Storage containers/
  );
  await assert.rejects(
    () => fillItemToBaseContainer(db, "/tmp", 16836, 42, { templateId: "T6RefinedResourceA", quantity: 1, itemVolume: 1.0 }),
    /Items can only be filled into Storage containers/
  );
  assert.equal(calls.some((call) => call.text.includes("insert into dune.items")), false);
});

test("storage fill-item inserts with PER-UNIT volume_override and respects slot limit", async () => {
  // CORRECTED 2026-08-19 (real live in-game bug, see
  // docs/incidents/INC-2026-08-19-VOLUME-OVERRIDE-DOUBLE-MULTIPLIED.md):
  // volume_override must be the item's PER-UNIT volume, not itemVolume *
  // quantity. An earlier version of this function (fixed 2026-07-31)
  // stored the per-unit value alone, which undercounted current_volume for
  // quantity > 1 -- the 2026-07-31 fix over-corrected by storing the TOTAL
  // instead, which is what this test asserted until now. Storing the total
  // caused the live game engine (which multiplies volume_override by
  // stack_size itself for display) to double-multiply, inflating displayed
  // volume by a factor of stack_size (confirmed live: a 9540-unit stack
  // with volume_override wrongly stored as its 47700 total displayed
  // in-game as ~455 million). The correct fix keeps volume_override
  // per-unit and instead makes every SUM query multiply by stack_size (see
  // the "* stack_size" assertion below).
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 100 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ total_volume: 10 }],
    insertedRows: [{ id: 502, template_id: "T6RefinedResourceA", stack_size: 50, quality_level: 0, position_index: 3, inventory_id: 7, volume_override: 1.0 }]
  });
  const result = await fillItemToStorage(db, "/tmp", 222, { templateId: "T6RefinedResourceA", quantity: 50, itemVolume: 1.0 });
  assert.equal(result.inserted.id, 502);
  assert.equal(result.inserted.volume_override, 1.0);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  const volIdx = insert.values.length - 1;
  assert.equal(insert.values[volIdx], 1.0, "volume_override stored is the per-unit value, not per-unit * quantity");
  const volumeCall = calls.find((call) => call.text.includes("select template_id, stack_size, volume_override"));
  assert.ok(volumeCall, "volume sum query must run");
  assert.ok(volumeCall, "capacity reads every stack so NULL overrides can fall back to catalog volume");
});

// Never rejects on a partial volume fit, same fix as give-item (issue #347
// follow-up): 15 max, 10 already used -> 5.0 remaining / 1.0 per-unit = 5
// max fit, clamped down from the requested 50.
test("storage fill-item clamps a requested quantity down to whatever volume actually fits, rather than rejecting", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 15 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ total_volume: 10 }],
    insertedRows: [{ id: 505, template_id: "T6RefinedResourceA", stack_size: 5, quality_level: 0, position_index: 6, inventory_id: 7, volume_override: 5.0 }]
  });
  const result = await fillItemToStorage(db, "/tmp", 222, { templateId: "T6RefinedResourceA", quantity: 50, itemVolume: 1.0 });
  assert.equal(result.ok, true);
  assert.equal(result.requested, 50);
  assert.equal(result.given, 5);
  assert.equal(result.clamped, true);
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  assert.ok(insert);
  assert.equal(insert.values[2], 5);
});

// The one case that IS still a real rejection for fill-item too: truly zero
// room left.
test("storage fill-item still rejects an explicit quantity when there is no room for even 1 unit", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 15 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ total_volume: 15 }]
  });
  await assert.rejects(
    () => fillItemToStorage(db, "/tmp", 222, { templateId: "T6RefinedResourceA", quantity: 50, itemVolume: 1.0 }),
    /Storage is full by volume/
  );
});

test("storage fill-item rejects when slot limit would be exceeded", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 2, max_item_volume: 100 }],
    countRows: [{ count: 2 }]
  });
  await assert.rejects(
    () => fillItemToStorage(db, "/tmp", 222, { templateId: "T6RefinedResourceA", quantity: 50, itemVolume: 1.0 }),
    /Storage is full by item slot/
  );
});

// ---- Per-item stack-limit adherence (issue #430) ----
// The game engine enforces a per-item max stack size (MelangeSpice 500,
// Oil/SpicedFuelCell 500, lubricants 100 -- externally verified against
// dune.gaming.tools 2026-08-20; see adminCatalog's resolveItemStackSize
// comment for the full provenance, including a correction of an initial
// 499 for Oil/SpicedFuelCell). Raw give/fill inserts bypass the engine's own stack
// validation (the RCON path's "Verified inventory stack increased"), so
// these paths must split an oversized quantity across multiple rows using
// the catalog's stackSize metadata. Items without stackSize data keep the
// pre-existing single-row behavior, locked by the older tests above.

test("storage give-item splits a quantity above the item's catalog stack size into multiple stacks", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [
      { id: 601, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 29, inventory_id: 7 },
      { id: 602, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 28, inventory_id: 7 },
      { id: 603, template_id: "MelangeSpice", stack_size: 200, quality_level: 0, position_index: 27, inventory_id: 7 }
    ]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "MelangeSpice", quantity: 1200 });
  assert.equal(result.given, 1200);
  assert.equal(result.requested, 1200);
  assert.equal(result.clamped, false, "splitting alone is not a clamp -- the full requested quantity was given");
  assert.equal(result.stacks, 3);
  assert.equal(result.inserted.id, 601, "inserted stays the first row for response-shape compatibility");
  assert.equal(result.insertedStacks.length, 3);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 3);
  assert.deepEqual(inserts.map((call) => call.values[2]), [500, 500, 200]);
  assert.deepEqual(inserts.map((call) => call.values[4]), [29, 28, 27], "each stack claims its own distinct slot");
});

test("storage give-item clamps a split to the container's remaining slots and reports it honestly", async () => {
  // 30 slots, 28 used -> only 2 stacks fit; 1200 requested at 500/stack ->
  // 1000 given across 2 stacks, clamped, instead of one over-limit row.
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 28 }],
    insertedRowsSequence: [
      { id: 604, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 29, inventory_id: 7 },
      { id: 605, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 28, inventory_id: 7 }
    ]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "MelangeSpice", quantity: 1200 });
  assert.equal(result.given, 1000);
  assert.equal(result.clamped, true);
  assert.equal(result.clampReason, "slots");
  assert.equal(result.stacks, 2);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((call) => call.values[2]), [500, 500]);
});

test("storage give-item completes a realistic oversized request in one operation, full stacks plus remainder", async () => {
  // Per explicit operator direction (2026-08-20): a give/fill must compute
  // the number of full stacks plus one final remainder stack and complete
  // in ONE action bounded only by the container's real capacity -- never
  // stop partway at an artificial cap and tell the operator to rerun.
  // 100,000 at 500/stack = 200 full stacks, well under the 1,000-row
  // runaway backstop.
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 0, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [{ id: 671, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 29, inventory_id: 7 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "MelangeSpice", quantity: 100000 });
  assert.equal(result.given, 100000);
  assert.equal(result.clamped, false);
  assert.equal(result.stacks, 200);
  assert.equal(calls.filter((call) => call.text.includes("insert into dune.items")).length, 200);
});

test("storage give-item hitting the 1,000-row runaway backstop still reports it honestly", async () => {
  // Only a pathological request reaches the backstop: 1,000,000 at
  // 500/stack needs 2,000 rows. The backstop protects the database from a
  // runaway transaction; the honest stack-rows report is retained for it.
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 0, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [{ id: 672, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 29, inventory_id: 7 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "MelangeSpice", quantity: 1000000 });
  assert.equal(result.given, 500000);
  assert.equal(result.clamped, true);
  assert.equal(result.clampReason, "stack-rows");
  assert.match(String(result.message), /1,?000-stack per-operation limit/);
  assert.match(String(result.message), /repeat/i);
});

// L2 audit (Architect hat): template lookups must not be case-sensitive --
// the engine/DB treats template ids case-insensitively (refill matches with
// lower()), so "melangespice" must hit MelangeSpice's stack limit instead of
// silently bypassing it.
test("storage give-item enforces the stack limit for a case-variant of a catalogued template id", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [{ id: 681, template_id: "melangespice", stack_size: 500, quality_level: 0, position_index: 29, inventory_id: 7 }]
  });
  const result = await giveItemToStorage(db, 222, { templateId: "melangespice", quantity: 1200 });
  assert.equal(result.stacks, 3);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.deepEqual(inserts.map((call) => call.values[2]), [500, 500, 200]);
});

test("storage fill-item to capacity splits into stack-size rows bounded by the runaway backstop", async () => {
  // Uncapped container with no volume data: fill-to-capacity for a
  // stack-capped item gives full stacks up to the 1,000-row runaway
  // backstop instead of the previous single 1,000,000-unit row.
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 0, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: Array.from({ length: 1000 }, (_, index) => (
      { id: 700 + index, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 2 + index, inventory_id: 7 }
    ))
  });
  const result = await fillItemToStorage(db, "/tmp", 222, { templateId: "MelangeSpice", quantity: 0, itemVolume: 0.2 });
  assert.equal(result.given, 500000);
  assert.equal(result.requested, null);
  assert.equal(result.stacks, 1000);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 1000);
  assert.ok(inserts.every((call) => call.values[2] === 500));
  assert.equal(inserts[0].values[4], 2, "uncapped fill keeps its max+1 position convention for the first stack");
  assert.equal(inserts[999].values[4], 1001, "later stacks take consecutive positions after the first");
});

test("base container fill-item splits an explicit quantity above the stack size without reporting a clamp", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [
      { id: 611, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 2, inventory_id: 7 },
      { id: 612, template_id: "MelangeSpice", stack_size: 100, quality_level: 0, position_index: 3, inventory_id: 7 }
    ]
  });
  const result = await fillItemToBaseContainer(db, "/tmp", 16836, 42, { templateId: "MelangeSpice", quantity: 600, itemVolume: 0.2 });
  assert.equal(result.given, 600);
  assert.equal(result.requested, 600);
  assert.equal(result.clamped, false);
  assert.equal(result.stacks, 2);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.deepEqual(inserts.map((call) => call.values[2]), [500, 100]);
  // Capped container: fill claims the LOWEST free in-range slots from a
  // one-time occupied-set read (L2 audit H-1 fix), never max+1 -- which
  // could escape the slot grid after a high-end Give.
  assert.deepEqual(inserts.map((call) => call.values[4]), [0, 1]);
});

// L2 audit H-1 (DBA hat): Give parks rows at the TOP of the slot range
// (nextHighPositionIndex, the 2026-08-19 collision mitigation), so a fill
// computing max(position_index)+1 would start AT max_item_count -- out of
// the engine's slot grid -- and a split amplified that to up to 50
// out-of-range rows. Fill must claim free in-range slots instead.
test("fill-item stays inside the slot grid after a high-end give occupied the top slot", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 40, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    existingPositionIndexRows: [39],
    insertedRowsSequence: [
      { id: 651, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 0, inventory_id: 7 },
      { id: 652, template_id: "MelangeSpice", stack_size: 300, quality_level: 0, position_index: 1, inventory_id: 7 }
    ]
  });
  const result = await fillItemToStorage(db, "/tmp", 222, { templateId: "MelangeSpice", quantity: 800, itemVolume: 0.2 });
  assert.equal(result.given, 800);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.deepEqual(inserts.map((call) => call.values[4]), [0, 1], "slot 39 is occupied by the high-end give; fill must claim in-range free slots, not 40/41");
  assert.ok(inserts.every((call) => call.values[4] < 40), "no fill row may land at or beyond max_item_count");
});

test("fill-item to capacity cut by the stack-row cap reports clamped with a stack-rows reason", async () => {
  // Uncapped container: the 1,000-row runaway backstop (not capacity) stops the fill, so
  // claiming "as much as fit" would be a lie -- the response must say so.
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 0, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [{ id: 660, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 2, inventory_id: 7 }]
  });
  const result = await fillItemToStorage(db, "/tmp", 222, { templateId: "MelangeSpice", quantity: 0, itemVolume: 0.2 });
  assert.equal(result.given, 500000);
  assert.equal(result.clamped, true, "a row-cap cut is not 'as much as fit' -- it must be reported");
  assert.equal(result.clampReason, "stack-rows");
});

test("fill-item to capacity bounded by volume alone is not reported as clamped", async () => {
  // 160 volume left / 0.2 per unit = 800 fits -> 2 stacks; the container's
  // real capacity (volume) was the boundary, so this genuinely is "as much
  // as fit".
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 0, max_item_volume: 200 }],
    countRows: [{ count: 1 }],
    volumeRows: [{ total_volume: 40 }],
    insertedRowsSequence: [
      { id: 661, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 2, inventory_id: 7 },
      { id: 662, template_id: "MelangeSpice", stack_size: 300, quality_level: 0, position_index: 3, inventory_id: 7 }
    ]
  });
  const result = await fillItemToStorage(db, "/tmp", 222, { templateId: "MelangeSpice", quantity: 0, itemVolume: 0.2 });
  assert.equal(result.given, 800);
  assert.equal(result.stacks, 2);
  assert.equal(result.clamped, false);
  assert.equal(result.clampReason, null);
});

test("give-multiple-items splits an oversized entry across stacks and slots before the next entry", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [
      { id: 621, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 29, inventory_id: 7 },
      { id: 622, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 28, inventory_id: 7 },
      { id: 623, template_id: "MelangeSpice", stack_size: 200, quality_level: 0, position_index: 27, inventory_id: 7 },
      { id: 624, template_id: "AzuriteOre", stack_size: 20, quality_level: 0, position_index: 26, inventory_id: 7 }
    ]
  });
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [
      { templateId: "MelangeSpice", quantity: 1200 },
      { templateId: "AzuriteOre", quantity: 20 }
    ]
  });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].given, 1200);
  assert.equal(result.results[0].clamped, false, "a fully-satisfied split entry must not stop the batch");
  assert.equal(result.results[0].stacks, 3);
  assert.equal(result.results[0].inserted.id, 621);
  assert.equal(result.results[1].attempted, true);
  assert.equal(result.results[1].given, 20);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 4);
  assert.deepEqual(inserts.map((call) => call.values[4]), [29, 28, 27, 26], "each stack claims its own slot from the shared high-end pool");
});

test("player give-item splits a quantity above the item's catalog stack size", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [
      { id: 631, template_id: "MelangeSpice", stack_size: 500, quality_level: 1, position_index: 2, inventory_id: 7 },
      { id: 632, template_id: "MelangeSpice", stack_size: 500, quality_level: 1, position_index: 3, inventory_id: 7 },
      { id: 633, template_id: "MelangeSpice", stack_size: 200, quality_level: 1, position_index: 4, inventory_id: 7 }
    ]
  });
  const result = await giveItemToPlayer(db, 123, { templateId: "MelangeSpice", quantity: 1200 });
  assert.equal(result.given, 1200);
  assert.equal(result.requested, 1200);
  assert.equal(result.stacks, 3);
  assert.equal(result.clamped, false);
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 3);
  assert.deepEqual(inserts.map((call) => call.values[2]), [500, 500, 200]);
  // Capped player inventory: same in-range lowest-free claiming as fill
  // (L2 audit H-1 fix), never max+1.
  assert.deepEqual(inserts.map((call) => call.values[4]), [0, 1, 2]);
});

// L2 audit (Architect + UI hats): the player path previously delivered the
// full quantity in one row; a clamp here is NEW behavior and must be loud in
// the response message, because every player-give consumer (care packages,
// the Players grant route, Discord) reports success from this result.
test("player give-item clamped by free slots reports the shortfall in its own message", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 28 }],
    existingPositionIndexRows: [0, 1],
    insertedRowsSequence: [
      { id: 691, template_id: "MelangeSpice", stack_size: 500, quality_level: 1, position_index: 2, inventory_id: 7 },
      { id: 692, template_id: "MelangeSpice", stack_size: 500, quality_level: 1, position_index: 3, inventory_id: 7 }
    ]
  });
  const result = await giveItemToPlayer(db, 123, { templateId: "MelangeSpice", quantity: 1200 });
  assert.equal(result.given, 1000);
  assert.equal(result.requested, 1200);
  assert.equal(result.clamped, true);
  assert.match(String(result.message), /1[,]?000 of the requested 1[,]?200/, "the message itself must state the shortfall -- consumers display it verbatim");
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 2);
});

// L2 audit (Network/DBA/Security hats, converging finding): the 1,000-row runaway backstop
// must be per OPERATION in the batch path too -- previously it was per
// entry, letting a 50-entry batch insert up to 2,500 rows in one
// transaction under the inventory lock.
test("give-multiple-items completes realistic split entries in one batch and shares the runaway backstop", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 0, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [{ id: 701, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 2, inventory_id: 7 }]
  });
  // Realistic case first: both split entries and the plain one complete
  // fully in one batch (40 + 20 + 1 rows, far under the shared backstop).
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [
      { templateId: "MelangeSpice", quantity: 20000 },
      { templateId: "MelangeSpice", quantity: 10000 },
      { templateId: "AzuriteOre", quantity: 5 }
    ]
  });
  assert.equal(calls.filter((call) => call.text.includes("insert into dune.items")).length, 61);
  assert.equal(result.results[0].given, 20000);
  assert.equal(result.results[1].given, 10000);
  assert.equal(result.results[2].given, 5);
  assert.ok(result.results.every((entry) => entry.attempted && !entry.clamped));
});

test("give-multiple-items shares the 1,000-row runaway backstop across the whole batch", async () => {
  // Pathological batch: entry 1 needs 800 rows, entry 2 needs 400 -- only
  // 200 remain in the SHARED budget (previously each entry had its own,
  // allowing up to 50 x 1,000 rows in one transaction); entry 3 is never
  // attempted, with a reason naming the cap rather than a full container.
  const calls = [];
  const db = fakeMutationDb(calls, {
    storageRows: [{ id: 7, actor_id: 222, max_item_count: 0, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRowsSequence: [{ id: 702, template_id: "MelangeSpice", stack_size: 500, quality_level: 0, position_index: 2, inventory_id: 7 }]
  });
  const result = await giveMultipleItemsToBaseContainer(db, 16836, 42, {
    items: [
      { templateId: "MelangeSpice", quantity: 400000 },
      { templateId: "MelangeSpice", quantity: 200000 },
      { templateId: "AzuriteOre", quantity: 5 }
    ]
  });
  const inserts = calls.filter((call) => call.text.includes("insert into dune.items"));
  assert.equal(inserts.length, 1000, "800 rows for entry 1 + 200 rows for entry 2 exhausts the shared backstop");
  assert.equal(result.results[0].given, 400000);
  assert.equal(result.results[0].clamped, false);
  assert.equal(result.results[1].given, 100000, "entry 2 gets only the 200 rows left in the budget");
  assert.equal(result.results[1].clamped, true);
  assert.equal(result.results[2].attempted, false, "budget exhausted -- the batch stops");
  assert.match(String(result.results[2].reason), /per-operation stack-row limit|stack-row/i, "the stop reason must name the cap, not claim the container is full");
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
  assert.deepEqual(insert.values.slice(0, 5), [7, "WaterBottle_1", 3, 5, 0]); // position 0: lowest free in-range slot (L2 audit H-1 fix), no longer max+1
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
  assert.deepEqual(insert.values.slice(0, 5), [7, "T6_Augment_Melee4", 1, 1, 0]); // position 0: lowest free in-range slot (L2 audit H-1 fix)
  const stats = JSON.parse(insert.values[5]);
  assert.deepEqual(stats.FAugmentItemStats, [[], { StatRolls: [1, 1], AppliedEffectIndices: [] }]);
});

test("player give-item materializes standalone augment rolls at the selected grade", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    augmentRollRows: [{ template_id: "T6_Augment_Melee4", quality_level: 1, stats: { FAugmentItemStats: [[], { StatRolls: [0.42], AppliedEffectIndices: [3] }] } }],
    storageRows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }],
    countRows: [{ count: 1 }],
    insertedRows: [{ id: 501, template_id: "T6_Augment_Melee4", stack_size: 1, quality_level: 5, position_index: 2, inventory_id: 7 }]
  });
  await giveItemToPlayer(db, 123, { templateId: "T6_Augment_Melee4", quantity: 1, quality: 5 });
  const insert = calls.find((call) => call.text.includes("insert into dune.items"));
  const stats = JSON.parse(insert.values[5]);
  assert.deepEqual(stats.FAugmentItemStats, [[], { StatRolls: [1], AppliedEffectIndices: [3] }]);
  const rollLookup = calls.find((call) => call.text.includes("stats ? 'FAugmentItemStats'"));
  assert.deepEqual(rollLookup.values, [["T6_Augment_Melee4"]]);
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
  assert.deepEqual(insert.values.slice(0, 5), [7, "SMG_Unique_LargeMag_06", 1, 0, 0]); // position 0: lowest free in-range slot (L2 audit H-1 fix)
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
    vehicleModuleScanRows: [{ scanned: 4, vehicles: 2, comparable: 3, missing_maximum: 1, missing_current: 2 }],
    repairedVehicleModuleRows: [{ id: 10, vehicle_id: 900 }, { id: 11, vehicle_id: 900 }, { id: 12, vehicle_id: 901 }]
  });
  const result = await repairVehicleDecay(db, 123, { thresholdPercent: 50 });
  assert.equal(result.scanned, 4);
  assert.equal(result.vehicles, 2);
  assert.equal(result.comparable, 3);
  assert.equal(result.missingMaximum, 1);
  assert.equal(result.missingCurrent, 2);
  assert.equal(result.repaired, 3);
  assert.equal(result.repairedVehicles, 2);
  const scan = calls.find((call) => call.text.includes("count(*)::int as scanned"));
  assert.ok(scan);
  assert.match(scan.text, /durability->>'CurrentDurability'/);
  assert.match(scan.text, /missing_current/);
  const update = calls.find((call) => call.text.includes("update dune.vehicle_modules vm"));
  assert.ok(update);
  assert.match(update.text, /join dune\.actors a on a\.id = vm\.vehicle_id/);
  assert.match(update.text, /a\.owner_account_id = \$1/);
  assert.match(update.text, /permission_actor_rank par/);
  assert.match(update.text, /par\.player_id = \$2/);
  assert.match(update.text, /par\.rank = 1/);
  assert.match(update.text, /template_maxima/);
  assert.match(update.text, /DecayedMaxDurability/);
  assert.match(update.text, /CurrentDurability/);
  assert.match(update.text, /durability->>'CurrentDurability'\)::numeric </);
  assert.deepEqual(update.values, [44, 55, 0.5]);
});

test("storage give-item reports unsupported capability when schema functions are absent", async () => {
  const db = {
    query: async (text) => text.includes("to_regclass") ? { rows: [{ exists: false }] } : { rows: [] },
    transaction: async (fn) => fn(db)
  };
  await assert.rejects(() => giveItemToStorage(db, 222, { templateId: "WaterBottle_1", quantity: 1 }), UnsupportedCapabilityError);
});

test("storage give-item reports unsupported when volume_override cannot be written", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    itemColumns: ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"]
  });

  await assert.rejects(
    () => giveItemToStorage(db, 222, { templateId: "AzuriteOre", quantity: 1, itemVolume: 0.2 }),
    UnsupportedCapabilityError
  );
  assert.equal(calls.some((call) => call.text.includes("insert into dune.items")), false);
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
  assert.equal(result.estimatedRank, 20);
  assert.equal(result.currentRankLimit, 0);
  assert.match(result.message, /Estimated Rank: 20/);
  assert.match(result.message, /Current Rank Limit: 0/);
});

test("faction mutation rejects online players before changing persistent reputation", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    playerRows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Online" }]
  });
  await assert.rejects(() => addFactionReputation(db, 123, { factionId: 1, amount: 50 }), /require the player to be offline/);
  assert.equal(calls.some((call) => call.text.includes("set_player_faction_reputation")), false);
});

test("faction repair synchronizes the vendor-facing component without changing reputation", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    playerFactionRows: [{ faction_id: 1 }],
    factionRows: [{ faction_id: 1, reputation_amount: 11600 }],
    factionComponentRows: [{ Faction: { Name: "Smuggler" }, ReputationAmount: 75 }]
  });
  const result = await repairFactionReputation(db, 123);
  assert.equal(result.factionId, 1);
  assert.equal(result.reputations.Atreides, 11600);
  const componentUpdate = calls.find((call) => call.text.includes("FactionPlayerComponent,m_FactionDataArray"));
  assert.ok(componentUpdate);
  assert.match(componentUpdate.text, /jsonb_set\(coalesce\(properties/);
  assert.equal(JSON.parse(componentUpdate.values[0]).find((entry) => entry.Faction.Name === "Smuggler").ReputationAmount, 75);
  assert.equal(calls.some((call) => call.text.includes("set_player_faction_reputation")), false);
});

test("faction repair restores earned Tier 5 progression when both onboarding objectives are complete", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    journeyIdentityColumn: "character_id",
    playerFactionRows: [{ faction_id: 1 }],
    factionRows: [{ faction_id: 1, reputation_amount: 12474 }],
    playerTagRows: [{ tag: "Faction.Atreides.Tier2" }],
    journeyStateRows: [
      { story_node_id: "DA_FQ_ClimbTheRanks.Rank5To20.CompleteLandsraadMission.CompleteOnboardingJourney1" },
      { story_node_id: "DA_FQ_ClimbTheRanks.Rank5To20.CraftAugmentation.CompleteOnboardingJourney2" }
    ]
  });
  const result = await repairFactionReputation(db, 123);
  assert.deepEqual(result.progressionTagsAdded, [
    "Faction.Atreides.Tier0",
    "Faction.Atreides.Tier1",
    "Faction.Atreides.Tier3",
    "Faction.Atreides.Tier4",
    "Faction.Atreides.Tier5"
  ]);
  assert.equal(result.progressionTierBefore, 2);
  assert.equal(result.progressionTierAfter, 5);
  const tagInsert = calls.find((call) => call.text.includes("insert into dune.player_tags"));
  assert.ok(tagInsert);
  assert.deepEqual(tagInsert.values, [5, result.progressionTagsAdded]);
  assert.match(result.message, /Tier 2 through Tier 5/);
});

test("faction repair refuses neutral players", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { playerFactionRows: [] });
  await assert.rejects(() => repairFactionReputation(db, 123), /assigned to Atreides or Harkonnen/);
  assert.equal(calls.some((call) => call.text.includes("FactionPlayerComponent,m_FactionDataArray")), false);
});

function corruptedAssassinationJourneyRows() {
  const rootId = "DA_LDR_Syndicate_Assassination_1";
  return [
    rootId,
    `${rootId}.DA_LDR_Syndicate_Assassination_1_1`,
    `${rootId}.DA_LDR_Syndicate_Assassination_1_2`,
    `${rootId}.DA_LDR_Syndicate_Assassination_1_3`,
    `${rootId}.DA_LDR_Syndicate_Assassination_1_4`,
    `${rootId}.TravelTo`
  ].map((story_node_id) => ({
    story_node_id,
    complete_condition_state: true,
    reveal_condition_state: true,
    fail_condition_state: {},
    metadata_state: story_node_id === rootId
      ? { House: "DA_HouseRichese", RandSeed: 307575399, IsAvailable: 1 }
      : { RandSeed: 307575399 },
    has_pending_reward: false
  }));
}

test("Landsraad repair inspection detects the verified completed-but-available assassination pattern", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { journeyIdentityColumn: "character_id", journeyStateRows: corruptedAssassinationJourneyRows() });
  const result = await inspectLandsraadQuestRepairs(db, 123);
  assert.equal(result.repairCount, 1);
  assert.deepEqual(result.repairs.map((repair) => repair.name), ["Assassination"]);
  assert.equal(calls.some((call) => call.text.includes("update dune.journey_story_node")), false);
});

test("Landsraad repair reconstructs only the known assassination nodes and removes its cooldown", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    journeyIdentityColumn: "character_id",
    journeyStateRows: corruptedAssassinationJourneyRows(),
    journeyUpdateRows: 6,
    cooldownDeleteRows: 1,
    cooldownRows: [{
      story_node_id: "DA_LDR_Syndicate_Assassination_1",
      time_to_expire: new Date(Date.now() - 60_000)
    }]
  });
  const result = await repairLandsraadQuests(db, 123);
  assert.equal(result.repairCount, 1);
  assert.equal(result.repairedNodes, 6);
  assert.equal(result.removedCooldowns, 1);
  const update = calls.find((call) => call.text.includes("update dune.journey_story_node"));
  assert.ok(update);
  assert.equal(update.values[0], 5);
  assert.equal(update.values[1], "DA_LDR_Syndicate_Assassination_1");
  assert.deepEqual(update.values[2], [
    "DA_LDR_Syndicate_Assassination_1.DA_LDR_Syndicate_Assassination_1_1",
    "DA_LDR_Syndicate_Assassination_1.TravelTo"
  ]);
  assert.equal(update.values[3].length, 6);
  assert.match(update.text, /metadata_state - 'House'/);
  const cooldownDelete = calls.find((call) => call.text.includes("delete from dune.journey_story_node_cooldown"));
  assert.deepEqual(cooldownDelete.values, [5, "DA_LDR_Syndicate_Assassination_1"]);
});

test("Landsraad repair rechecks the locked player status and refuses a login race", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    journeyIdentityColumn: "character_id",
    journeyStateRows: corruptedAssassinationJourneyRows(),
    lockedPlayerStatus: "Online"
  });
  await assert.rejects(() => repairLandsraadQuests(db, 123), /require the player to be offline/);
  assert.equal(calls.some((call) => call.text.includes("update dune.journey_story_node")), false);
});

test("Landsraad repair leaves healthy quest state unchanged", async () => {
  const calls = [];
  const healthyRows = corruptedAssassinationJourneyRows().map((row) => ({
    ...row,
    complete_condition_state: {},
    reveal_condition_state: row.story_node_id.endsWith("_1") || row.story_node_id.endsWith("TravelTo") ? true : {}
  }));
  healthyRows[0].metadata_state = { RandSeed: 307575399, IsAvailable: 1 };
  const db = fakeMutationDb(calls, { journeyIdentityColumn: "character_id", journeyStateRows: healthyRows });
  const result = await repairLandsraadQuests(db, 123);
  assert.equal(result.repairCount, 0);
  assert.equal(calls.some((call) => call.text.includes("update dune.journey_story_node")), false);
});

test("Landsraad repair does not bypass an active assassination cooldown", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    journeyIdentityColumn: "character_id",
    journeyStateRows: corruptedAssassinationJourneyRows(),
    cooldownRows: [{
      story_node_id: "DA_LDR_Syndicate_Assassination_1",
      time_to_expire: new Date(Date.now() + 60_000)
    }]
  });
  const result = await repairLandsraadQuests(db, 123);
  assert.equal(result.repairCount, 0);
  assert.equal(calls.some((call) => call.text.includes("update dune.journey_story_node")), false);
  assert.equal(calls.some((call) => call.text.includes("delete from dune.journey_story_node_cooldown")), false);
});

function fakeCharacterRecoveryDb({ onlineStatus = "Offline" } = {}) {
  const calls = [];
  const state = {
    active: {
      id: "60", account_id: "1470", encrypted_character_name: "TempDrew", character_name: "TempDrew",
      online_status: onlineStatus, character_state: "Active", player_controller_id: "4830",
      player_pawn_id: "4832", player_state_id: "4831", transfer_count: 0,
      is_coriolis_processed: true, last_login_time: "2026-08-22T22:06:07Z"
    },
    deleted: {
      id: "57", account_id: "1470", character_name: "Drew", character_state: "Deleted",
      online_status: "Offline", player_controller_id: "3764", player_pawn_id: "3818",
      player_state_id: "3789", transfer_count: 5
    }
  };
  const candidateRow = () => ({
    character_state_id: state.deleted.id,
    character_name: state.deleted.character_name,
    last_avatar_activity: "2026-08-17T17:45:22Z",
    last_login_time: "2026-08-22T22:06:06Z",
    deleted_at: "2026-08-22T22:06:07Z",
    player_controller_id: state.deleted.player_controller_id,
    player_pawn_id: state.deleted.player_pawn_id,
    player_state_actor_id: state.deleted.player_state_id,
    transfer_count: state.deleted.transfer_count,
    map: "HaggaBasin",
    partition_id: "1",
    sietch: "Abbir",
    inventory_count: 14,
    item_count: 50,
    removal_reason: "new char in fls",
    removal_event_time: "2026-08-22T22:06:07Z",
    replacement_detected: true,
    recoverable: true
  });
  const query = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) return { rows: [{ exists: true }], rowCount: 1 };
    if (text.includes("to_regprocedure")) return { rows: [{ exists: true }], rowCount: 1 };
    if (text.includes("from dune.actors a") && text.includes("left join dune.player_state ps")) {
      return { rows: [{ actor_id: 4832, account_id: 1470, controller_id: 4830, player_state_id: Number(state.active.id), online_status: state.active.online_status }], rowCount: 1 };
    }
    if (text.includes("select eps.*") && text.includes("for update")) {
      return { rows: [{ ...state.active }], rowCount: 1 };
    }
    if (text.includes("left join dune.actors controller") && text.includes("character_state::text = 'Deleted'")) {
      return { rows: [candidateRow()], rowCount: 1 };
    }
    if (text.includes("where eps.id = $1::bigint") && text.includes("character_state::text = 'Active'")) {
      return { rows: [{ character_state_id: state.active.id, character_name: state.active.character_name, pawn_id: state.active.player_pawn_id, transfer_count: state.active.transfer_count, item_count: 26 }], rowCount: 1 };
    }
    if (text.includes("update dune.encrypted_player_state") && text.includes("character_state = 'Deleted'") && !text.includes("update dune.encrypted_player_state target")) {
      if (state.active.online_status === "Online") return { rows: [], rowCount: 0 };
      state.active.character_state = "Deleted";
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("update dune.encrypted_player_state target")) {
      state.deleted.character_state = "Active";
      state.deleted.character_name = state.active.character_name;
      state.deleted.transfer_count = state.active.transfer_count;
      return { rows: [{
        character_state_id: state.deleted.id,
        character_name: state.deleted.character_name,
        player_controller_id: state.deleted.player_controller_id,
        player_pawn_id: state.deleted.player_pawn_id,
        player_state_actor_id: state.deleted.player_state_id
      }], rowCount: 1 };
    }
    if (text.includes("min(id)::text as active_id")) {
      const active = [state.active, state.deleted].filter((row) => row.character_state === "Active");
      return { rows: [{ active_count: active.length, active_id: active[0]?.id || null }], rowCount: 1 };
    }
    throw new Error(`Unexpected character recovery query: ${text}`);
  };
  const db = {
    query,
    transaction: async (fn) => fn({ query })
  };
  return { db, calls, state };
}

test("deleted-character recovery inspection shows retained data and the safest candidate", async () => {
  const { db } = fakeCharacterRecoveryDb();
  const result = await inspectDeletedCharacterRecovery(db, 4832);
  assert.equal(result.active.characterName, "TempDrew");
  assert.equal(result.active.itemCount, 26);
  assert.equal(result.suggestedCandidateId, "57");
  assert.equal(result.canRecover, true);
  assert.deepEqual(result.candidates[0], {
    characterStateId: "57",
    characterName: "Drew",
    lastAvatarActivity: "2026-08-17T17:45:22Z",
    lastLoginTime: "2026-08-22T22:06:06Z",
    deletedAt: "2026-08-22T22:06:07Z",
    controllerId: "3764",
    pawnId: "3818",
    playerStateActorId: "3789",
    map: "HaggaBasin",
    partitionId: "1",
    sietch: "Abbir",
    inventoryCount: 14,
    itemCount: 50,
    transferCount: 5,
    removalReason: "new char in fls",
    removalEventTime: "2026-08-22T22:06:07Z",
    replacementDetected: true,
    recoverable: true
  });
});

test("deleted-character recovery preserves the current Funcom identity and reactivates the original data", async () => {
  const { db, state } = fakeCharacterRecoveryDb();
  const result = await recoverDeletedCharacter(db, 4832, "57");
  assert.equal(state.active.character_state, "Deleted");
  assert.equal(state.deleted.character_state, "Active");
  assert.equal(state.deleted.character_name, "TempDrew");
  assert.equal(state.deleted.transfer_count, 0);
  assert.equal(result.pawnId, "3818");
  assert.equal(result.itemCount, 50);
  assert.match(result.message, /Drew's saved character data was recovered with 50 items/);
  assert.match(result.message, /current Funcom character name remains TempDrew/);
});

test("deleted-character recovery refuses an online login race before changing either state", async () => {
  const { db, state, calls } = fakeCharacterRecoveryDb({ onlineStatus: "Online" });
  await assert.rejects(() => recoverDeletedCharacter(db, 4832, "57"), /require the player to be offline/);
  assert.equal(state.active.character_state, "Active");
  assert.equal(state.deleted.character_state, "Deleted");
  assert.equal(calls.some((call) => call.text.includes("update dune.encrypted_player_state")), false);
});

test("player faction assignment uses the game's faction function with the controller id", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { playerFactionRows: [] });

  const result = await setPlayerFaction(db, 123, { factionId: 1 });

  assert.equal(result.changed, true);
  assert.equal(result.oldFaction, "Neutral");
  assert.equal(result.faction, "Atreides");
  const change = calls.find((call) => call.text.includes("dune.change_player_faction"));
  assert.deepEqual(change.values, [55, 1]);
});

test("player faction assignment removes the personal assignment by selecting Neutral", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { playerFactionRows: [{ faction_id: 2 }] });

  const result = await setPlayerFaction(db, 123, { factionId: 3 });

  assert.equal(result.changed, true);
  assert.equal(result.oldFaction, "Harkonnen");
  assert.equal(result.faction, "Neutral");
  const change = calls.find((call) => call.text.includes("dune.change_player_faction"));
  assert.deepEqual(change.values, [55, 3]);
});

test("player faction assignment rejects non-playable faction ids", async () => {
  const db = fakeMutationDb([]);
  await assert.rejects(() => setPlayerFaction(db, 123, { factionId: 4 }), /invalid faction id/i);
});

test("specialization XP mutation updates fractional level from the XP curve", async () => {
  const calls = [];
  let specialization = { player_id: "55", track_type: "Combat", xp_amount: "1599", level: "12" };
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("enum_range")) return { rows: [{ track_type: "Combat" }] };
      if (text.includes("from dune.actors a")) {
        return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      }
      if (text.includes("where player_id = $1 and track_type::text = $2") && text.includes("for update")) {
        return { rows: [{ xp_amount: specialization.xp_amount, level: specialization.level }] };
      }
      if (text.includes("player_id::text as player_id") && text.includes("from dune.specialization_tracks")) {
        return { rows: [{ ...specialization }] };
      }
      if (text.includes("dune.set_specialization_xp_and_level")) {
        specialization = {
          player_id: String(values[0]),
          track_type: String(values[1]),
          xp_amount: String(values[2]),
          level: String(values[3])
        };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };

  const result = await addSpecializationXp(db, 123, { trackType: "Combat", amount: 26 });

  assert.equal(result.xp, 1625);
  assert.ok(Math.abs(result.level - 12.146067415730338) < 1e-12);
  const update = calls.find((call) => call.text.includes("dune.set_specialization_xp_and_level"));
  assert.deepEqual(update.values.slice(0, 3), [55, "Combat", 1625]);
  assert.ok(Math.abs(update.values[3] - 12.146067415730338) < 1e-12);
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

test("intel mutation reports a full spendable balance without a no-op update", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    intelRows: [{ intel: 2779 }]
  });
  const result = await addIntel(db, 123, { amount: 25 });
  assert.equal(result.oldValue, 2779);
  assert.equal(result.newValue, 2779);
  assert.equal(result.amount, 0);
  assert.equal(result.capped, true);
  assert.match(result.message, /already at the spendable cap of 2779/);
  assert.equal(calls.some((call) => call.text.includes("m_TechKnowledgePoints") && call.text.includes("update")), false);
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
    ],
    craftingListRows: [{ recipe_id: "HealthPackRecipe" }]
  });
  const result = await playerResearchItems(db, 123);
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[0].itemKey, "RCP_HealthPackRecipe");
  assert.equal(result.rows[0].type, "Recipe");
  assert.equal(result.rows[0].unlocked, true);
  assert.equal(result.rows[0].recipeUnlocked, true);
  assert.equal(result.rows[1].type, "Group");
  assert.equal(result.rows[2].category, "Vehicles");
  assert.equal(result.rows[2].productGroup, "Copper Products");
  assert.equal(result.rows[3].category, "Uniques");
  assert.equal(result.rows[3].productGroup, "Copper Products");
  assert.ok(calls.some((call) => call.text.includes("TechKnowledgePlayerComponent") && call.text.includes("all_research")));
});

test("research listing exposes purchased entries whose build recipe needs repair", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchListRows: [
      { item_key: "RCP_HealthPackRecipe", unlocked_state: "Purchased", is_new: false },
      { item_key: "DA_GRP_SandbikePack", unlocked_state: "Purchased", is_new: false }
    ],
    craftingListRows: []
  });
  const result = await playerResearchItems(db, 123);
  assert.equal(result.rows[0].unlocked, false);
  assert.equal(result.rows[0].researchPurchased, true);
  assert.equal(result.rows[0].recipeId, "HealthPackRecipe");
  assert.equal(result.rows[0].needsRecipeRepair, true);
  assert.equal(result.rows[1].unlocked, true);
  assert.equal(result.rows[1].actionable, false);
  assert.equal(result.rows[1].needsRecipeRepair, false);
});

test("research listing verifies building research against building progression", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchListRows: [
      { item_key: "BLD_LargeOreRefinery_Patent", unlocked_state: "Purchased", is_new: false },
      { item_key: "BLD_LargeSpiceRefinery_Patent", unlocked_state: "Purchased", is_new: false }
    ],
    craftingListRows: [],
    buildingProgressionRows: [{
      learned_building_sets: ["LargeOreRefinery_Patent"],
      new_buildable_pieces: []
    }]
  });
  const result = await playerResearchItems(db, 123);
  assert.equal(result.rows[0].unlockKind, "building");
  assert.equal(result.rows[0].unlockId, "LargeOreRefinery_Patent");
  assert.equal(result.rows[0].unlocked, true);
  assert.equal(result.rows[0].needsUnlockRepair, false);
  assert.equal(result.rows[1].unlocked, false);
  assert.equal(result.rows[1].unlockId, "LargeSpiceRefinery_Patent");
  assert.equal(result.rows[1].needsUnlockRepair, true);
});

test("building unlock state reads owned progression and pending patent tokens without changing either", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    buildingProgressionRows: [{
      learned_building_sets: ["BasicLighting", "MTX_Neut_StrategyTable_Patent"],
      new_buildable_pieces: ["ChoamShelterSet", "BasicLighting"]
    }],
    pendingBuildingUnlockRows: [{ template_id: "Windtrap_Patent" }]
  });
  const result = await playerBuildingUnlockState(db, 123);
  assert.equal(result.capabilities.buildingUnlockOwnership, true);
  assert.deepEqual(result.owned, ["BasicLighting", "MTX_Neut_StrategyTable_Patent", "ChoamShelterSet"]);
  assert.deepEqual(result.pending, ["Windtrap_Patent"]);
  assert.equal(calls.some((call) => /^\s*(update|insert|delete)\b/i.test(call.text)), false);
});

test("customization grant state reports pending tokens without pretending consumed ownership is available", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    pendingBuildingUnlockRows: [{ template_id: "B1C3_Atre_Maula_Pistol" }]
  });
  const result = await playerCustomizationGrantState(db, 123);
  assert.equal(result.capabilities.customizationOwnership, false);
  assert.equal(result.capabilities.customizationPending, true);
  assert.deepEqual(result.pending, ["B1C3_Atre_Maula_Pistol"]);
  assert.equal(calls.some((call) => /^\s*(update|insert|delete)\b/i.test(call.text)), false);
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

test("research unlock appends building research to authoritative building progression", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchExists: true,
    currentResearchItems: [{ ItemKey: "DA_GRP_SandbikePack", bIsNewEntry: true, UnlockedState: "NotPurchased" }],
    buildingProgressionRows: [{ learned_building_sets: [], new_buildable_pieces: [] }]
  });
  const result = await unlockResearchItem(db, 123, { itemKey: "BLD_LargeOreRefinery_Patent" });
  assert.equal(result.unlockKind, "building");
  assert.equal(result.buildingUnlockId, "LargeOreRefinery_Patent");
  assert.equal(result.buildingPieceId, "LargeOreRefinery_Placeable");
  assert.equal(result.buildingProgressionUpdated, true);
  const researchUpdate = calls.find((call) => call.text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && call.text.includes("update dune.actors"));
  assert.ok(researchUpdate);
  const items = JSON.parse(researchUpdate.values[1]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], { ItemKey: "BLD_LargeOreRefinery_Patent", bIsNewEntry: false, UnlockedState: "Purchased" });
  const progressionUpdate = calls.find((call) => call.text.includes("update dune.building_progression"));
  assert.ok(progressionUpdate);
  assert.deepEqual(progressionUpdate.values, [5, ["LargeOreRefinery_Patent"], ["LargeOreRefinery_Placeable"]]);
  assert.equal(calls.some((call) => call.text.includes("CraftingRecipesLibraryActorComponent,m_KnownItemRecipes") && call.text.includes("update dune.actors")), false);
});

test("research unlock repairs an already-purchased entry with a missing recipe", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchExists: true,
    currentResearchItems: [{ ItemKey: "RCP_HealthPackRecipe", bIsNewEntry: false, UnlockedState: "Purchased" }],
    currentCraftingRecipes: []
  });
  const result = await unlockResearchItem(db, 123, { itemKey: "RCP_HealthPackRecipe" });
  assert.equal(result.alreadyUnlocked, true);
  assert.equal(result.recipeMaterialized, true);
  assert.equal(result.recipeAdded, true);
  assert.equal(result.repairedRecipe, true);
  const recipeUpdate = calls.find((call) => call.text.includes("CraftingRecipesLibraryActorComponent,m_KnownItemRecipes") && call.text.includes("update dune.actors"));
  assert.equal(JSON.parse(recipeUpdate.values[1])[0].BaseRecipeId.Name, "HealthPackRecipe");
});

test("research unlock uses exact catalog building IDs when the research key is not a patent", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchExists: true,
    currentResearchItems: [],
    buildingProgressionRows: [{ learned_building_sets: [], new_buildable_pieces: [] }]
  });
  const result = await unlockResearchItem(db, 123, { itemKey: "BLD_SmallSpiceRefinery" });
  assert.equal(result.unlockKind, "building");
  assert.equal(result.buildingUnlockId, "SmallSpiceRefinery");
  const progressionUpdate = calls.find((call) => call.text.includes("update dune.building_progression"));
  assert.deepEqual(progressionUpdate.values, [5, ["SmallSpiceRefinery"], ["SmallSpiceRefinery_Placeable"]]);
});

test("research unlock does not change research when the recipe component is unavailable", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchExists: true,
    currentResearchItems: [{ ItemKey: "RCP_HealthPackRecipe", bIsNewEntry: true, UnlockedState: "NotPurchased" }],
    currentCraftingRecipes: null
  });
  await assert.rejects(
    () => unlockResearchItem(db, 123, { itemKey: "RCP_HealthPackRecipe" }),
    /research was not changed/
  );
  assert.equal(calls.some((call) => call.text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && call.text.includes("update dune.actors")), false);
});

test("building research does not change research when building progression is unavailable", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchExists: true,
    currentResearchItems: [{ ItemKey: "BLD_LargeSpiceRefinery_Patent", bIsNewEntry: true, UnlockedState: "NotPurchased" }],
    buildingProgressionRows: []
  });
  await assert.rejects(
    () => unlockResearchItem(db, 123, { itemKey: "BLD_LargeSpiceRefinery_Patent" }),
    /Building progression was not found/
  );
  assert.equal(calls.some((call) => call.text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && call.text.includes("update dune.actors")), false);
});

test("research unlock rejects group markers instead of recording a false successful unlock", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, {
    researchExists: true,
    currentResearchItems: [{ ItemKey: "DA_GRP_SandbikePack", bIsNewEntry: true, UnlockedState: "NotPurchased" }],
    currentCraftingRecipes: []
  });
  await assert.rejects(
    () => unlockResearchItem(db, 123, { itemKey: "DA_GRP_SandbikePack" }),
    /cannot be unlocked directly/
  );
  assert.equal(calls.some((call) => call.text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && call.text.includes("update dune.actors")), false);
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

test("journey completion requires the player to be offline", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { playerRows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Online" }] });
  await assert.rejects(
    () => completeJourneyNode(db, 123, { nodeId: "DA_Story.Root" }, {}),
    /require the player to be offline/
  );
  assert.ok(!calls.some((call) => call.text.includes("update dune.journey_story_node")));
});

test("journey completion updates the selected subtree without completing ancestor containers", async () => {
  const calls = [];
  const db = fakeMutationDb(calls);
  const result = await completeJourneyNode(db, 123, { nodeId: "DA_Story.Root.Child" }, {
    journey_node_tags: { "DA_Story.Root": ["Story.Root"], "DA_Story.Root.Child": ["Story.Child"] }
  });
  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call.text.includes("update dune.journey_story_node") && call.values[1] === "DA_Story.Root.Child"));
  assert.ok(!calls.some((call) => Array.isArray(call.values[1]) && call.values[1].includes("DA_Story.Root")));
  assert.ok(calls.some((call) => call.text.includes("insert into dune.player_tags") && call.values[1].includes("Story.Child")));
});

test("Find the Fremen completion grants its extra tag, TechKnowledge rewards, and Spice Vision", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { currentResearchItems: [] });
  const result = await completeJourneyNode(db, 123, { nodeId: "DA_MQ_FindTheFremen" }, {
    journey_node_tags: { "DA_MQ_FindTheFremen.FirstTest.FirstQuestion.CompleteFirstTest": ["JourneySets.Fremkit.First"] }
  });
  assert.equal(result.recipesGranted, 5);
  assert.ok(calls.some((call) => call.text.includes("insert into dune.player_tags") && call.values[1].includes("Journey.RewardsUnblocked")));
  assert.equal(calls.filter((call) => call.text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && call.text.includes("update dune.actors")).length, 5);
  assert.ok(calls.some((call) => call.text.includes("FSpiceAddictionComponent,1,SystemStatus")));
});

test("contract completion applies skills, removes superseded tags, and dismisses its active item", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { contractSkillRows: 1, dismissedContractRows: 1, trackedContractRows: 1 });
  const nodeId = "DA_CT_Trainer_Trooper2_03";
  const result = await completeJourneyNode(db, 123, { nodeId }, {
    contract_aliases: { Trainer_Trooper2_03: nodeId },
    contract_tags: { [nodeId]: ["Contract.Trainer.Done"] },
    contract_remove_tags: { [nodeId]: ["Contract.Trainer.Active"] },
    contract_skill_grants: { [nodeId]: ["Skills.Key.Trooper3"] }
  });
  assert.equal(result.skillsGranted, 1);
  assert.equal(result.dismissedContracts, 1);
  assert.equal(result.trackedContractCleared, true);
  assert.ok(calls.some((call) => call.text.includes("delete from dune.player_tags") && call.values[1].includes("Contract.Trainer.Active")));
  assert.ok(calls.some((call) => call.text.includes("FContractItemStats") && call.values[1].includes("Trainer_Trooper2_03")));
});

test("journey reset clears subtree state and mapped tags but does not revoke rewards", async () => {
  const calls = [];
  const db = fakeMutationDb(calls, { journeyUpdateRows: 2 });
  const result = await resetJourneyNode(db, 123, { nodeId: "DA_Story.Root" }, {
    journey_node_tags: { "DA_Story.Root.Child": ["Story.Child"] }
  });
  assert.equal(result.updatedRows, 2);
  assert.ok(calls.some((call) => call.text.includes("delete from dune.player_tags") && call.values[1].includes("Story.Child")));
  assert.ok(!calls.some((call) => call.text.includes("TechKnowledgePlayerComponent") || call.text.includes("FSpiceAddictionComponent")));
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

test("player live teleport refuses an offline source", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("from dune.actors a") && text.includes("player_state ps")) return { rows: [{ actor_id: 42, account_id: 7, controller_id: 8, player_state_id: 9, online_status: "Offline" }] };
      if (text.includes("from dune.accounts ac")) return { rows: [{ fls_id: "FLS42", character_name: "Offline Player", map: "HaggaBasin", partition_id: 1 }] };
      throw new Error(`unexpected query: ${text}`);
    }
  };
  await assert.rejects(() => teleportPlayer(db, 42, { mode: "coordinates", x: 1, y: 2, z: 3 }), /must be online/i);
});

test("player live teleport builds a command with the actual FLS id", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("from dune.actors a") && text.includes("player_state ps")) return { rows: [{ actor_id: 42, account_id: 7, controller_id: 8, player_state_id: 9, online_status: "Online" }] };
      if (text.includes("from dune.accounts ac")) return { rows: [{ fls_id: "FLS42", character_name: "Online Player", map: "HaggaBasin", partition_id: 4 }] };
      throw new Error(`unexpected query: ${text}`);
    }
  };
  const result = await teleportPlayer(db, 42, { mode: "coordinates", x: 11.5, y: -22.5, z: 33.5 });
  assert.equal(result.playerId, "FLS42");
  assert.deepEqual([result.x, result.y, result.z, result.yaw], [11.5, -22.5, 33.5, 0]);
  assert.match(result.message, /will be teleported/i);
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
          : table === "building_progression"
            ? ["character_id", "learned_building_sets", "new_buildable_pieces"]
          : table === "actors"
            ? ["id", "class", "owner_account_id", "properties"]
            : table === "vehicle_modules"
              ? ["id", "vehicle_id", "template_id", "stats"]
            : table === "journey_story_node"
              ? [fixtures.journeyIdentityColumn || "account_id", "story_node_id", "has_pending_reward", "complete_condition_state", "reveal_condition_state", "fail_condition_state", "metadata_state", "reset_group"]
              : table === "journey_story_node_cooldown"
                ? ["character_id", "story_node_id", "time_to_expire"]
              : table === "player_tags"
                ? [fixtures.journeyIdentityColumn || "account_id", "tag"]
                : fixtures.itemColumns || ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats", "volume_override"];
        return { rows: names.map((column_name) => ({ column_name })) };
      }
      if (text.includes("TechKnowledgePlayerComponent") && text.includes("all_research")) return { rows: fixtures.researchListRows || [] };
      if (text.includes("from dune.building_progression") && text.includes("learned_building_sets")) return { rows: fixtures.buildingProgressionRows || [] };
      if (text.includes("join dune.items") && text.includes("distinct i.template_id")) return { rows: fixtures.pendingBuildingUnlockRows || [] };
      if (text.includes("TechKnowledgePlayerComponent") && text.includes("select exists")) return { rows: [{ exists: Boolean(fixtures.researchExists) }] };
      if (text.includes("TechKnowledgePlayerComponent") && text.includes("m_TechKnowledgeData") && text.includes("for update")) return { rows: fixtures.currentResearchItems === null ? [] : [{ items: fixtures.currentResearchItems || [] }] };
      if (text.includes("TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData") && text.includes("update dune.actors")) return { rows: [{ ok: true }] };
      if (text.includes("CraftingRecipesLibraryActorComponent") && text.includes("player_recipes")) return { rows: fixtures.craftingListRows || [] };
      if (text.includes("CraftingRecipesLibraryActorComponent") && text.includes("select exists")) return { rows: [{ exists: Boolean(fixtures.recipeExists) }] };
      if (text.includes("CraftingRecipesLibraryActorComponent") && text.includes("for update")) return { rows: fixtures.currentCraftingRecipes === null ? [] : [{ recipes: fixtures.currentCraftingRecipes || [] }] };
      if (text.includes("CraftingRecipesLibraryActorComponent,m_KnownItemRecipes") && text.includes("update dune.actors")) return { rows: [{ ok: true }] };
      if (text.includes("story_node_id not like 'DA_Dunipedia_%'")) return { rows: fixtures.discoveredJourneyRows || [] };
      if (text.includes("story_node_id like 'DA_Dunipedia_%'")) return { rows: fixtures.codexRows || [] };
      if (text.includes("delete from dune.journey_story_node_cooldown")) return { rows: [], rowCount: fixtures.cooldownDeleteRows ?? 0 };
      if (text.includes("from dune.journey_story_node_cooldown")) return { rows: fixtures.cooldownRows || [] };
      if (text.includes("from dune.journey_story_node") && (text.includes("where account_id = $1") || text.includes('where "account_id" = $1') || text.includes("where character_id = $1") || text.includes('where "character_id" = $1'))) return { rows: fixtures.journeyStateRows || [] };
      if (text.includes("from dune.player_state") && text.includes("online_status") && text.includes("for update")) {
        const rows = [{ online_status: fixtures.lockedPlayerStatus || "Offline" }];
        return { rows, rowCount: rows.length };
      }
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
      if (/from\s+dune\.player_faction\b/.test(text)) return { rows: fixtures.playerFactionRows ?? [{ faction_id: 1 }] };
      if (text.includes("dune.get_solaris_id")) return { rows: [{ currency_id: 0 }] };
      if (text.includes("adjust_player_virtual_currency_balance")) return { rows: [{ ok: true }] };
      if (text.includes("player_virtual_currency_balances")) return { rows: fixtures.balanceRows || [] };
      if (text.includes("select reputation_amount")) return { rows: fixtures.reputationRows || [] };
      if (text.includes("set_player_faction_reputation")) return { rows: [{ ok: true }] };
      if (text.includes("where actor_id = $1 and faction_id in")) return { rows: fixtures.factionRows || [] };
      if (text.includes("FactionPlayerComponent") && text.includes("from dune.actors") && text.includes("for update")) return { rows: [{ faction_data: fixtures.factionComponentRows || [] }] };
      if (text.includes("jsonb_set") && text.includes("FactionPlayerComponent")) return { rows: [{ id: 55 }], rowCount: 1 };
      if (text.includes("insert into dune.player_tags")) return { rows: (values[1] || []).map((tag) => ({ tag })), rowCount: (values[1] || []).length };
      if (text.includes("m_TechKnowledgePoints") && text.includes("select")) return { rows: fixtures.intelRows || [] };
      if (text.includes("m_TechKnowledgePoints") && text.includes("update")) return { rows: [{ ok: true }] };
      if (text.includes("not (i.id = any($3::bigint[]))")) return { rows: fixtures.newItemRows || [] };
      if (text.includes("from dune.items i") && text.includes("where i.id = $1")) return { rows: fixtures.itemRows || [] };
      if (text.includes("not exists(select 1 from dune.items where id = $1")) return { rows: [{ deleted: true }] };
      if (text.includes("exists(select 1 from dune.items where id = $1")) return { rows: [{ exists: Boolean(fixtures.itemStillExists) }] };
      if (text.includes("delete from dune.items where id = $1")) return { rows: [], rowCount: 1 };
      if (text.includes("FContractItemStats") && text.includes("delete from dune.items")) return { rows: [], rowCount: fixtures.dismissedContractRows ?? 0 };
      if (text.includes("FLevelComponent") && text.includes("ModuleData") && text.includes("update dune.fgl_entities")) return { rows: [], rowCount: fixtures.contractSkillRows ?? 0 };
      if (text.includes("ContractsCoordinatorComponent,m_TrackedContractItemUid") && text.includes("update dune.actors")) return { rows: [], rowCount: fixtures.trackedContractRows ?? 0 };
      if (text.includes("FSpiceAddictionComponent") && text.includes("update dune.fgl_entities")) return { rows: [], rowCount: fixtures.spiceVisionRows ?? 1 };
      if (text.includes("dune.delete_item")) return { rows: [{ ok: true }] };
      // resolveOwnedStorageContainer's own ownership-CTE query, now also
      // used by giveItemToBaseContainer/fillItemToBaseContainer/
      // giveMultipleItemsToBaseContainer (issue #347 code-review follow-up,
      // 2026-08-19), not just the bulk-delete paths fakeBulkContainerDeleteDb
      // above already mocks it for. Derives its single container/inventory
      // row from the existing storageRows fixture by default, so every
      // existing give/fill test keeps its storageRows fixture unchanged and
      // only needs its call site updated to pass (baseId, placeableId)
      // instead of a bare storageId. containerRows overrides this entirely,
      // the same way fakeBulkContainerDeleteDb's own fixture does, for tests
      // that need to exercise the not-found/multi-inventory/wrong-group
      // paths.
      if (text.includes("select c.placeable_id::text as placeable_id, c.inventory_id") && text.includes("for update of inv")) {
        if (fixtures.containerRows) return { rows: fixtures.containerRows };
        const storageRow = (fixtures.storageRows && fixtures.storageRows[0]) || {};
        return {
          rows: [{
            placeable_id: String(values[4] ?? ""),
            inventory_id: storageRow.id ?? 7,
            group_key: fixtures.containerGroup || "storage",
            type_name: fixtures.containerTypeName || "Small Storage Container",
            actor_id: storageRow.actor_id,
            max_item_count: storageRow.max_item_count ?? 0,
            max_item_volume: storageRow.max_item_volume ?? 0
          }]
        };
      }
      if (text.includes("from dune.inventories") && text.includes("where actor_id")) return { rows: fixtures.storageRows || [] };
      if (text.includes("from dune.vehicle_modules vm") && text.includes("count(*)::int as scanned")) return { rows: fixtures.vehicleModuleScanRows || [{ scanned: 0, vehicles: 0 }] };
      if (text.includes("update dune.vehicle_modules vm")) return { rows: fixtures.repairedVehicleModuleRows || [] };
      if (text.includes("select template_id, stack_size, volume_override from dune.items where inventory_id")) {
        // volumeRowsSequence mirrors countRowsSequence below. Both predate
        // the issue #347 code-review round-trip fix that made
        // giveMultipleItemsToBaseContainer query count/volume ONCE per
        // batch and track them in memory afterward, rather than
        // re-querying per item -- for that function specifically, only
        // index 0 of either sequence is ever consumed now. The sequence
        // mechanism itself is left in place (harmless, and still real
        // infrastructure a future per-item-requerying caller could use),
        // it just no longer reflects how giveMultipleItemsToBaseContainer
        // proves a batch stops partway through -- that is proven via the
        // in-memory counters advancing correctly instead, not via this
        // mock seeing multiple live queries.
        if (fixtures.volumeRowsSequence) {
          const index = volumeCallCount++;
          const rows = fixtures.volumeRowsSequence[index] || fixtures.volumeRowsSequence[fixtures.volumeRowsSequence.length - 1];
          return { rows: rows.flatMap((row) => "total_volume" in row
            ? [{ template_id: "__fixture__", stack_size: 1, volume_override: row.total_volume }]
            : [row]) };
        }
        return { rows: (fixtures.volumeRows || []).flatMap((row) => "total_volume" in row
          ? [{ template_id: "__fixture__", stack_size: 1, volume_override: row.total_volume }]
          : [row]) };
      }
      if (text.includes("count(*)::int")) {
        // countRowsSequence: see volumeRowsSequence's comment above for why
        // this sequence mechanism now only ever consumes index 0 for
        // giveMultipleItemsToBaseContainer specifically. Falls back to the
        // original static behavior for every existing test that only needs
        // one fixed count.
        if (fixtures.countRowsSequence) {
          const index = countCallCount++;
          return { rows: [fixtures.countRowsSequence[index] || fixtures.countRowsSequence[fixtures.countRowsSequence.length - 1]] };
        }
        return { rows: fixtures.countRows || [{ count: 0 }] };
      }
      // giveMultipleItemsToBaseContainer's own occupied-position-index seed
      // query -- fetched once up front, not per item (issue #347
      // code-review round-trip fix), then tracked in memory for the rest of
      // the batch. Matched on its exact, distinct literal (no "max(" or
      // "generate_series", so it can never collide with either of the
      // single-item queries below). existingPositionIndexRows lets a test
      // seed pre-existing occupied slots; defaults to none.
      if (text === "select position_index from dune.items where inventory_id = $1") {
        return { rows: (fixtures.existingPositionIndexRows || []).map((position_index) => ({ position_index })) };
      }
      // nextHighPositionIndex's high-end query (Give/Give Multiple only --
      // see its own comment in duneDb.js). Distinguished from the plain
      // lowest-next-free query below by "generate_series". Defaults to a
      // fixed high slot so existing tests that don't care about the exact
      // index keep passing; highPositionRowsSequence supports tests that
      // need it to reflect a just-inserted row on the next call, the same
      // pattern countRowsSequence/volumeRowsSequence already use.
      if (text.includes("generate_series")) {
        if (fixtures.highPositionRowsSequence) {
          const index = highPositionCallCount++;
          const row = fixtures.highPositionRowsSequence[index] ?? fixtures.highPositionRowsSequence[fixtures.highPositionRowsSequence.length - 1];
          return { rows: row === null ? [] : [{ position_index: row }] };
        }
        return { rows: [{ position_index: fixtures.highPositionIndex ?? 29 }] };
      }
      if (text.includes("max(position_index)")) return { rows: [{ position_index: 2 }] };
      if (text.includes("insert into dune.items")) {
        // insertedRowsSequence supports tests that insert more than one row
        // per call (e.g. giveMultipleItemsToStorage) -- each insert call
        // consumes the next entry, rather than every insert seeing the same
        // fixed row. Falls back to the original single-row behavior
        // (insertedRows) for every existing test that only inserts once.
        if (fixtures.insertedRowsSequence) {
          const index = insertCallCount++;
          return { rows: [fixtures.insertedRowsSequence[index] || fixtures.insertedRowsSequence[fixtures.insertedRowsSequence.length - 1]] };
        }
        return { rows: fixtures.insertedRows || [] };
      }
      return { rows: [] };
    },
    async transaction(fn) {
      calls.push({ text: "begin", values: [] });
      const result = await fn(db);
      calls.push({ text: "commit", values: [] });
      return result;
    }
  };
  let insertCallCount = 0;
  let countCallCount = 0;
  let volumeCallCount = 0;
  let highPositionCallCount = 0;
  return db;
}

// --- Generator refill -------------------------------------------------------

// lockDelayMs, when set, holds a newly-acquired FOR UPDATE lock open for that
// long before the caller proceeds -- forcing two Promise.all'd callers to
// genuinely overlap in real time rather than happening to interleave only by
// microtask ordering, matching the idiom in addonItemGrants.test.js's
// "serializes concurrent duplicate grants".
function fakeRefillDb(calls, { devices = [], items = {}, hasPlaceables = true, lockDelayMs = 0 } = {}) {
  const state = { items: JSON.parse(JSON.stringify(items)), inserts: [], nextId: 9000, locks: new Map() };
  const rawQuery = async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("to_regclass")) {
      return { rows: [{ exists: String(values[0]) === "dune.placeables" ? hasPlaceables : true }] };
    }
    if (text.includes("information_schema.columns")) {
      const columns = {
        inventories: ["id", "actor_id", "max_item_count", "max_item_volume"],
        items: ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"],
        placeables: ["id", "owner_entity_id", "building_type"]
      }[values[1]] || [];
      return { rows: columns.map((column_name) => ({ column_name })) };
    }
    if (text.includes("from base_entities be")) return { rows: devices };
    // The inventory row itself always exists once inventory_id is set, so its
    // FOR UPDATE lock query always returns a row -- unlike the fuel-items
    // query below, which returns nothing for a device with no fuel yet.
    if (text.includes("from dune.inventories") && /for update/i.test(text)) {
      return { rows: [{ id: values[0] }] };
    }
    if (text.includes("lower(template_id) = lower($2)")) {
      const rows = (state.items[values[0]] || []).filter((row) =>
        String(row.template_id).toLowerCase() === String(values[1]).toLowerCase());
      return { rows };
    }
    if (text.startsWith("update dune.items set stack_size")) {
      for (const rows of Object.values(state.items)) {
        const row = rows.find((entry) => entry.id === values[1]);
        if (row) row.stack_size += values[0];
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("count(*)::int as count from dune.items")) {
      return { rows: [{ count: (state.items[values[0]] || []).length }] };
    }
    // baseGeneratorFuelLevels reads every device's fuel in one grouped query
    // rather than one query per device.
    if (text.includes("sum(stack_size)::int as units")) {
      const rows = [];
      for (const inventoryId of (Array.isArray(values[0]) ? values[0] : []).map(String)) {
        const totals = new Map();
        for (const row of state.items[inventoryId] || []) {
          const key = String(row.template_id).toLowerCase();
          totals.set(key, (totals.get(key) || 0) + (Number(row.stack_size) || 0));
        }
        for (const [template_id, units] of totals) rows.push({ inventory_id: inventoryId, template_id, units });
      }
      return { rows };
    }
    if (text.includes("max(position_index)")) {
      const rows = state.items[values[0]] || [];
      return { rows: [{ position_index: rows.reduce((max, row) => Math.max(max, row.position_index), -1) + 1 }] };
    }
    if (text.includes("insert into dune.items")) {
      const [inventoryId, templateId, stackSize, , positionIndex] = values;
      state.inserts.push({ inventoryId, templateId, stackSize, positionIndex });
      (state.items[inventoryId] ||= []).push({ id: ++state.nextId, template_id: templateId, stack_size: stackSize, position_index: positionIndex });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  };

  // A key is locked once a FOR UPDATE query returns rows for it, and stays
  // locked until the transaction that acquired it settles -- mirroring
  // Postgres releasing row locks on commit/rollback, not on the statement
  // that acquired them.
  async function acquireLock(heldByMe, key) {
    if (heldByMe.has(key)) return;
    while (state.locks.has(key)) await state.locks.get(key);
    let release;
    state.locks.set(key, new Promise((resolve) => { release = resolve; }));
    heldByMe.set(key, release);
    if (lockDelayMs) await new Promise((resolve) => setTimeout(resolve, lockDelayMs));
  }

  async function transaction(fn) {
    const heldByMe = new Map();
    const query = async (text, values = []) => {
      const result = await rawQuery(text, values);
      if (/for update/i.test(text) && result.rows.length > 0 && values.length) {
        await acquireLock(heldByMe, values[0]);
      }
      return result;
    };
    try {
      return await fn({ query });
    } finally {
      for (const [key, release] of heldByMe) {
        state.locks.delete(key);
        release();
      }
    }
  }

  return { state, db: { query: rawQuery, transaction } };
}

const FUEL_DEVICE = { placeable_id: "5001", generator_type: "fuel", inventory_id: "701", max_item_count: 10 };
const OMNI_DEVICE = { placeable_id: "5002", generator_type: "windTurbineOmni", inventory_id: "702", max_item_count: 10 };

test("generator refill enumerates only allowlisted placeable building types", async () => {
  const calls = [];
  const db = { query: async (text, values) => { calls.push({ text, values }); return { rows: [] }; } };

  await baseGenerators(db, 482);

  const [baseId, types, buildingTypes] = calls[0].values;
  assert.equal(baseId, 482);
  assert.deepEqual(types, ["fuel", "spice", "windTurbineOmni", "windTurbineDirectional"]);
  assert.deepEqual(buildingTypes, [
    "generator_placeable",
    "spicegenerator_placeable",
    "windturbineomnidirectional_placeable",
    "windturbinedirectional_placeable"
  ]);
  // Claim resolution must match portalGeneratorFuel so both agree on which
  // placeables belong to a base.
  assert.match(calls[0].text, /requested_claims as/);
  assert.match(calls[0].text, /claim_afe\.actor_id = rc\.actor_id/);
});

test("generator refill fills an empty fuel generator with one full stack of Oil", async () => {
  const calls = [];
  const { state, db } = fakeRefillDb(calls, { devices: [FUEL_DEVICE] });

  const result = await refillBaseGenerators(db, "", 482);

  assert.deepEqual(state.inserts, [{ inventoryId: "701", templateId: "Oil", stackSize: 499, positionIndex: 0 }]);
  assert.deepEqual(result.devices, [{
    placeableId: "5001", type: "fuel", label: "Fuel-Powered Generator", fuelName: "Fuel Cell",
    before: 0, after: 499, added: 499, capped: false
  }]);
  assert.equal(result.totalAdded, 499);
});

test("generator refill tops up a partial stack instead of adding another row", async () => {
  const calls = [];
  const { state, db } = fakeRefillDb(calls, {
    devices: [FUEL_DEVICE],
    items: { 701: [{ id: 11, template_id: "Oil", stack_size: 42, position_index: 0 }] }
  });

  const result = await refillBaseGenerators(db, "", 482);

  assert.deepEqual(state.inserts, []);
  assert.equal(state.items[701][0].stack_size, 499);
  assert.equal(result.devices[0].before, 42);
  assert.equal(result.devices[0].added, 457);
});

test("generator refill splits an omnidirectional turbine into five lubricant stacks", async () => {
  const calls = [];
  const { state, db } = fakeRefillDb(calls, { devices: [OMNI_DEVICE] });

  const result = await refillBaseGenerators(db, "", 482);

  // Five stacks of 100 would be 500; the total cap holds the device at 499.
  assert.deepEqual(state.inserts.map((entry) => entry.stackSize), [100, 100, 100, 100, 99]);
  assert.ok(state.inserts.every((entry) => entry.templateId === "WindTurbineLubricant1"));
  assert.deepEqual(state.inserts.map((entry) => entry.positionIndex), [0, 1, 2, 3, 4]);
  assert.equal(result.devices[0].after, 499);
  assert.equal(result.devices[0].capped, false);
});

test("generator refill leaves an already-full device untouched", async () => {
  const calls = [];
  const { state, db } = fakeRefillDb(calls, {
    devices: [FUEL_DEVICE],
    items: { 701: [{ id: 11, template_id: "Oil", stack_size: 499, position_index: 0 }] }
  });

  const result = await refillBaseGenerators(db, "", 482);

  assert.deepEqual(state.inserts, []);
  assert.equal(calls.some((call) => String(call.text).startsWith("update dune.items")), false);
  assert.equal(result.devices[0].added, 0);
  assert.equal(result.totalAdded, 0);
});

test("concurrent refills of an empty-inventory device do not both insert a full stack", async () => {
  const calls = [];
  const { state, db } = fakeRefillDb(calls, { devices: [FUEL_DEVICE], lockDelayMs: 5 });

  const [first, second] = await Promise.all([
    refillBaseGenerators(db, "", 482),
    refillBaseGenerators(db, "", 482)
  ]);

  // Without the inventory-row lock, both callers would read `before: 0` and
  // each insert a full 499-unit stack. With it, the second caller blocks
  // until the first commits, then sees the first's fuel and adds nothing.
  assert.equal(state.inserts.length, 1);
  const totalUnits = (state.items["701"] || []).reduce((sum, row) => sum + row.stack_size, 0);
  assert.equal(totalUnits, 499);
  assert.equal(first.totalAdded + second.totalAdded, 499);
});

test("generator refill stops at the inventory slot limit and reports it as capped", async () => {
  const calls = [];
  const { state, db } = fakeRefillDb(calls, { devices: [{ ...OMNI_DEVICE, max_item_count: 2 }] });

  const result = await refillBaseGenerators(db, "", 482);

  assert.equal(state.inserts.length, 2);
  assert.equal(result.devices[0].after, 200);
  assert.equal(result.devices[0].capped, true);
});

test("generator refill skips a device with no inventory rather than failing the whole base", async () => {
  const calls = [];
  const { state, db } = fakeRefillDb(calls, {
    devices: [{ ...FUEL_DEVICE, inventory_id: null }, OMNI_DEVICE]
  });

  const result = await refillBaseGenerators(db, "", 482);

  assert.equal(result.devices[0].skipped, "no-inventory");
  assert.equal(result.devices[0].added, 0);
  assert.equal(result.devices[1].added, 499);
  assert.ok(state.inserts.every((entry) => entry.inventoryId === "702"));
});

test("generator refill reports a base with no power devices instead of silently succeeding", async () => {
  const calls = [];
  const { db } = fakeRefillDb(calls, { devices: [] });
  await assert.rejects(() => refillBaseGenerators(db, "", 482), /No generators or wind turbines were found/);
});

test("generator refill is unsupported when the schema has no placeables table", async () => {
  const calls = [];
  const { db } = fakeRefillDb(calls, { devices: [FUEL_DEVICE], hasPlaceables: false });

  assert.equal(await supportsGeneratorRefill(db), false);
  await assert.rejects(() => refillBaseGenerators(db, "", 482), UnsupportedCapabilityError);
});

test("generator refill rejects an invalid base id before writing anything", async () => {
  const calls = [];
  const { db } = fakeRefillDb(calls, { devices: [FUEL_DEVICE] });
  await assert.rejects(() => refillBaseGenerators(db, "", 0), /Invalid base id/);
  assert.equal(calls.some((call) => String(call.text).includes("insert into dune.items")), false);
});

// --- Pending refill queue ---------------------------------------------------

// Must await fn: without it the finally deletes the directory at the callback's
// first await, and everything after that reads an empty queue.
async function withTempRepoRoot(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-refill-queue-"));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// Extends fakeRefillDb with the partition observation the queue needs. Each
// entry of `partitions` is { partitionId, connected, unassigned } -- "unassigned"
// meaning world_partition.server_id was released, as despawn does.
function fakeQueueDb(calls, { devices = [], items = {}, partitions = [], basePartition = null, hasWorldPartition = true } = {}) {
  const { state, db } = fakeRefillDb(calls, { devices, items });
  const inner = db.query;
  const query = async (text, values = []) => {
    // Record here too: the branches below return without reaching fakeRefillDb,
    // which is where calls are normally pushed.
    if (text.includes("to_regclass") || text.includes("from dune.world_partition")) calls.push({ text, values });
    if (text.includes("to_regclass")) {
      const target = String(values[0]);
      if (target === "dune.world_partition") return { rows: [{ exists: hasWorldPartition }] };
    }
    if (text.includes("from dune.world_partition")) {
      return { rows: partitions.map((partition) => ({
        partition_id: partition.partitionId,
        unassigned: Boolean(partition.unassigned),
        connected: Boolean(partition.connected)
      })) };
    }
    if (text.includes("coalesce(a.partition_id, 0)::int as partition_id")) {
      // baseMapLocation now also selects actor_id to distinguish a genuinely
      // missing base from one with a broken owner-entity link; default it to
      // a resolved id here so existing callers testing write-safety don't
      // have to know about that distinction unless they explicitly opt in.
      return { rows: basePartition ? [{ actor_id: "1", ...basePartition }] : [] };
    }
    return inner(text, values);
  };
  return { state, db: { query, transaction: async (fn) => fn({ query }) } };
}

// Every partition the queue tests reference, with a live server attached.
const LIVE_PARTITIONS = [{ partitionId: 3, connected: true }, { partitionId: 9, connected: true }];
// The same partitions after a despawn released their server_id.
const DESPAWNED_PARTITIONS = [{ partitionId: 3, unassigned: true }, { partitionId: 9, unassigned: true }];

test("refill queue stores one entry per base and survives a re-read", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot), []);

    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    queueGeneratorRefill(repoRoot, { baseId: 517, map: "Overmap", partitionId: 9 });
    // Re-queueing the same base must replace its entry, not add a second one.
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });

    const pending = listQueuedGeneratorRefills(repoRoot);
    assert.deepEqual(pending.map((entry) => entry.baseId), [517, 482]);
    assert.equal(pending.find((entry) => entry.baseId === 482).map, "Survival_1");
    assert.equal(pending.find((entry) => entry.baseId === 482).partitionId, 3);
  });
});

test("refill queue cancel removes only the requested base and reports a missing one", async () => {
  await withTempRepoRoot((repoRoot) => {
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    queueGeneratorRefill(repoRoot, { baseId: 517, map: "Overmap", partitionId: 9 });

    const result = cancelQueuedGeneratorRefill(repoRoot, 482);

    assert.equal(result.pending, 1);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot).map((entry) => entry.baseId), [517]);
    assert.throws(() => cancelQueuedGeneratorRefill(repoRoot, 482), /no queued generator refill/);
  });
});

test("refill queue ignores a corrupt file rather than blocking the panel", async () => {
  await withTempRepoRoot((repoRoot) => {
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    writeFileSync(join(repoRoot, "runtime/generated/pending-generator-refills.json"), "{not json");
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot), []);
  });
});

test("a released server_id is safe at once, so a despawn/spawn pair gets its window", async () => {
  _resetRefillPartitionDwellForTests();
  const calls = [];
  const { db } = fakeQueueDb(calls, { partitions: [{ partitionId: 3, unassigned: true }, { partitionId: 9, connected: true }] });

  const observed = await observeRefillPartitions(db);

  assert.equal(observed.safe.has(3), true);
  assert.equal(observed.safe.has(9), false);
  // Connection state must come from pg_stat_activity, not from a server_id that
  // restartService leaves behind on an always-on map.
  assert.ok(calls.some((call) => String(call.text).includes("pg_stat_activity")));
  assert.equal(calls.some((call) => String(call.text).includes("nullif(server_id, '') is not null")), false);
});

// The regression guard for the Postgres-restart hazard: losing every game
// server's connection at once must not read as "every map is down".
test("a still-assigned partition needs the full dwell before it is safe to write", async () => {
  _resetRefillPartitionDwellForTests();
  // server_id is still assigned; only the connection is gone.
  const { db } = fakeQueueDb([], { partitions: [{ partitionId: 3, connected: false }] });

  const first = await observeRefillPartitions(db, { now: () => 1_000_000 });
  assert.equal(first.safe.has(3), false);

  const justUnder = await observeRefillPartitions(db, { now: () => 1_000_000 + 29_999 });
  assert.equal(justUnder.safe.has(3), false);

  const elapsed = await observeRefillPartitions(db, { now: () => 1_000_000 + 30_000 });
  assert.equal(elapsed.safe.has(3), true);
});

test("a reconnecting game server resets the dwell instead of ageing into safety", async () => {
  _resetRefillPartitionDwellForTests();
  const disconnected = fakeQueueDb([], { partitions: [{ partitionId: 3, connected: false }] });
  const reconnected = fakeQueueDb([], { partitions: [{ partitionId: 3, connected: true }] });

  // Postgres restarted: the connection vanishes, then returns seconds later.
  await observeRefillPartitions(disconnected.db, { now: () => 1_000_000 });
  await observeRefillPartitions(reconnected.db, { now: () => 1_000_005 });
  await observeRefillPartitions(disconnected.db, { now: () => 1_000_010 });

  // The clock restarted at the reconnect, so the original timestamp cannot
  // carry a still-running map across the dwell threshold.
  const afterOriginalDwell = await observeRefillPartitions(disconnected.db, { now: () => 1_000_000 + 30_000 });
  assert.equal(afterOriginalDwell.safe.has(3), false);
});

test("queueing is unsupported without world_partition, so refills stay immediate", async () => {
  _resetRefillPartitionDwellForTests();
  const calls = [];
  const { db } = fakeQueueDb(calls, { devices: [FUEL_DEVICE], hasWorldPartition: false });

  assert.equal(await supportsGeneratorRefillQueue(db), false);
  assert.equal(await observeRefillPartitions(db), null);

  const target = await baseRefillTarget(db, 482);
  assert.equal(target.queueSupported, false);
  assert.equal(target.writeSafeNow, true);
});

test("a base on a running map is not write-safe, one on a despawned map is", async () => {
  _resetRefillPartitionDwellForTests();
  const running = fakeQueueDb([], {
    partitions: LIVE_PARTITIONS,
    basePartition: { map: "Survival_1", partition_id: 3 }
  });
  const runningTarget = await baseRefillTarget(running.db, 482);
  assert.deepEqual(runningTarget, { map: "Survival_1", partitionId: 3, queueSupported: true, writeSafeNow: false });

  _resetRefillPartitionDwellForTests();
  const stopped = fakeQueueDb([], {
    partitions: DESPAWNED_PARTITIONS,
    basePartition: { map: "Survival_1", partition_id: 3 }
  });
  const stoppedTarget = await baseRefillTarget(stopped.db, 482);
  assert.equal(stoppedTarget.writeSafeNow, true);
  assert.equal(stoppedTarget.queueSupported, true);
});

// dune.actors.map is not the name the restart machinery uses: on a live server
// partition 1 reports "HaggaBasin" against world_partition's "Survival_1", and
// partition 8 reports "DeepDesert" against "DeepDesert_1". Choosing a restart
// target from the base's own map name picks the wrong container, or none.
test("restart targets resolve from world_partition, not from the base's map name", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      return { rows: [
        { partition_id: 1, map: "Survival_1", dimension_index: 0 },
        { partition_id: 8, map: "DeepDesert_1", dimension_index: 0 },
        { partition_id: 0, map: "Ignored", dimension_index: 0 }
      ] };
    }
  };

  const targets = await partitionRestartTargets(db);

  assert.deepEqual(targets.get(1), { map: "Survival_1", dimensionIndex: 0 });
  assert.deepEqual(targets.get(8), { map: "DeepDesert_1", dimensionIndex: 0 });
  assert.equal(targets.has(0), false);
});

test("restart targets are empty rather than throwing without world_partition", async () => {
  const db = { query: async () => ({ rows: [{ exists: false }] }) };
  assert.equal((await partitionRestartTargets(db)).size, 0);
});

test("a base in a partition that no longer exists is write-safe rather than stuck", async () => {
  _resetRefillPartitionDwellForTests();
  const { db } = fakeQueueDb([], {
    partitions: LIVE_PARTITIONS,
    basePartition: { map: "Survival_1", partition_id: 4242 }
  });

  const target = await baseRefillTarget(db, 482);

  assert.equal(target.writeSafeNow, true);
});

// The regression guard for the lost-write hazard: the flush awaits a database
// transaction per base, and anything queued during one of those awaits must
// survive the queue file being rewritten.
test("flush preserves a refill queued while it was awaiting the database", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    _resetRefillPartitionDwellForTests();
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });

    const { db } = fakeQueueDb([], { devices: [FUEL_DEVICE], partitions: DESPAWNED_PARTITIONS });
    const inner = db.transaction;
    db.transaction = async (fn) => {
      // Stands in for an operator clicking Refill on another base mid-flush.
      queueGeneratorRefill(repoRoot, { baseId: 517, map: "Overmap", partitionId: 9 });
      return inner(fn);
    };

    const result = await flushGeneratorRefills(db, repoRoot);

    assert.deepEqual(result.flushed.map((entry) => entry.baseId), [482]);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot).map((entry) => entry.baseId), [517]);
  });
});

// Partitions are re-observed per entry, not once at pass start. A pass is
// several round-trips per entry and can outlive the window it began in -- a map
// server reconnecting partway through, or a pass the restart timeout abandoned
// but could not cancel. Writing to a live map is what these queues exist to
// avoid, since the game never picks those writes up.
test("a map that comes back up mid-pass stops the entries that follow", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    _resetRefillPartitionDwellForTests();
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    queueGeneratorRefill(repoRoot, { baseId: 517, map: "Overmap", partitionId: 9 });

    const partitions = [{ partitionId: 3, unassigned: true }, { partitionId: 9, unassigned: true }];
    const { db } = fakeQueueDb([], { devices: [FUEL_DEVICE], partitions });
    const inner = db.transaction;
    db.transaction = async (fn) => {
      // The map servers reconnect while the first entry is being written.
      partitions[0] = { partitionId: 3, connected: true };
      partitions[1] = { partitionId: 9, connected: true };
      return inner(fn);
    };

    const result = await flushGeneratorRefills(db, repoRoot);

    assert.deepEqual(result.flushed.map((entry) => entry.baseId), [482], "only the entry begun while the map was down");
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot).map((entry) => entry.baseId), [517],
      "the rest stay queued for a window that is genuinely safe");
  });
});

test("flush does not resurrect an entry canceled while it was awaiting the database", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    _resetRefillPartitionDwellForTests();
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    queueGeneratorRefill(repoRoot, { baseId: 517, map: "Overmap", partitionId: 9 });

    const { db } = fakeQueueDb([], { devices: [FUEL_DEVICE], partitions: DESPAWNED_PARTITIONS });
    const inner = db.transaction;
    let cancelled = false;
    db.transaction = async (fn) => {
      if (!cancelled) {
        cancelled = true;
        cancelQueuedGeneratorRefill(repoRoot, 517);
      }
      return inner(fn);
    };

    await flushGeneratorRefills(db, repoRoot);

    assert.deepEqual(listQueuedGeneratorRefills(repoRoot), []);
  });
});

test("flush applies refills for stopped partitions and leaves running ones queued", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    _resetRefillPartitionDwellForTests();
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    queueGeneratorRefill(repoRoot, { baseId: 517, map: "Overmap", partitionId: 9 });

    const calls = [];
    // Partition 9 still has a live server, so only base 482 may be written.
    const { state, db } = fakeQueueDb(calls, {
      devices: [FUEL_DEVICE],
      partitions: [{ partitionId: 3, unassigned: true }, { partitionId: 9, connected: true }]
    });

    const result = await flushGeneratorRefills(db, repoRoot);

    assert.deepEqual(result.flushed.map((entry) => ({ baseId: entry.baseId, ok: entry.ok })), [{ baseId: 482, ok: true }]);
    assert.equal(result.pending, 1);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot).map((entry) => entry.baseId), [517]);
    assert.deepEqual(state.inserts, [{ inventoryId: "701", templateId: "Oil", stackSize: 499, positionIndex: 0 }]);
  });
});

test("flush is a no-op with an empty queue and never queries the database", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const calls = [];
    const { db } = fakeQueueDb(calls, { devices: [FUEL_DEVICE] });

    const result = await flushGeneratorRefills(db, repoRoot);

    assert.deepEqual(result, { flushed: [], pending: 0 });
    assert.equal(calls.length, 0);
  });
});

test("flush keeps retrying through a restarting database without burning attempts", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    _resetRefillPartitionDwellForTests();
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });

    // start-all.sh runs update-db.sh inside the very window the flush targets,
    // so a mid-migration error must not count toward the drop limit. Liveness
    // still resolves; only the write fails.
    const live = fakeQueueDb([], { devices: [FUEL_DEVICE], partitions: DESPAWNED_PARTITIONS });
    const db = {
      query: live.db.query,
      transaction: async () => { throw new Error('relation "dune.items" does not exist'); }
    };

    // Step past the retry delay each round, otherwise the backoff below skips it.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const at = 1_000_000 + attempt * 120_000;
      const result = await flushGeneratorRefills(db, repoRoot, { now: () => at });
      assert.equal(result.flushed[0].attempts, 0);
      assert.equal(result.flushed[0].dropped, false);
    }
    assert.equal(listQueuedGeneratorRefills(repoRoot).length, 1);
  });
});

// The regression guard for unbounded retries: an entry whose permanent fault
// reads as transient must still leave the queue eventually.
test("flush expires an entry that has outlived the maximum queue age", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    _resetRefillPartitionDwellForTests();
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    const queuedAt = Date.parse(listQueuedGeneratorRefills(repoRoot)[0].queuedAt);

    const live = fakeQueueDb([], { devices: [FUEL_DEVICE], partitions: DESPAWNED_PARTITIONS });
    const db = {
      query: live.db.query,
      // A dropped table reads as transient forever, so only the age limit can
      // clear this entry.
      transaction: async () => { throw new Error('relation "dune.items" does not exist'); }
    };

    const beforeLimit = await flushGeneratorRefills(db, repoRoot, { now: () => queuedAt + 7 * 24 * 3600_000 - 1000 });
    assert.equal(beforeLimit.flushed[0].expired, undefined);
    assert.equal(listQueuedGeneratorRefills(repoRoot).length, 1);

    const atLimit = await flushGeneratorRefills(db, repoRoot, { now: () => queuedAt + 7 * 24 * 3600_000 });
    assert.equal(atLimit.flushed[0].expired, true);
    assert.equal(atLimit.flushed[0].dropped, true);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot), []);
  });
});

test("flush backs off a failed entry instead of retrying it every tick", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    _resetRefillPartitionDwellForTests();
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });

    let transactions = 0;
    const live = fakeQueueDb([], { devices: [FUEL_DEVICE], partitions: DESPAWNED_PARTITIONS });
    const db = {
      query: live.db.query,
      transaction: async () => { transactions += 1; throw new Error("connection terminated"); }
    };

    await flushGeneratorRefills(db, repoRoot, { now: () => 1_000_000 });
    assert.equal(transactions, 1);

    // Inside the 60s delay: skipped entirely, so nothing is reported for it.
    const skipped = await flushGeneratorRefills(db, repoRoot, { now: () => 1_000_000 + 30_000 });
    assert.deepEqual(skipped.flushed, []);
    assert.equal(transactions, 1);

    await flushGeneratorRefills(db, repoRoot, { now: () => 1_000_000 + 60_000 });
    assert.equal(transactions, 2);
  });
});

test("generator flush immediately clears a refill whose target no longer exists", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });

    // No devices: the base was released or its generators were removed while
    // the refill sat queued. There is nothing left that a retry could apply to.
    const result = await flushGeneratorRefills(
      fakeQueueDb([], { devices: [], partitions: DESPAWNED_PARTITIONS }).db,
      repoRoot,
      { now: () => 1_000_000 }
    );

    assert.equal(result.flushed[0].ok, true);
    assert.equal(result.flushed[0].cleared, true);
    assert.equal(result.flushed[0].noLongerApplicable, true);
    assert.deepEqual(listQueuedGeneratorRefills(repoRoot), []);
  });
});

test("water flush immediately clears a refill whose base or storage no longer exists", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    queueWaterRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });

    const result = await flushWaterRefills(
      fakeQueueDb([], { devices: [], partitions: DESPAWNED_PARTITIONS }).db,
      repoRoot,
      { now: () => 1_000_000 }
    );

    assert.equal(result.flushed[0].ok, true);
    assert.equal(result.flushed[0].cleared, true);
    assert.equal(result.flushed[0].noLongerApplicable, true);
    assert.deepEqual(listQueuedWaterRefills(repoRoot), []);
  });
});

// --- Per-device generator fuel levels ---------------------------------------

const SECOND_FUEL_DEVICE = { placeable_id: "5003", generator_type: "fuel", inventory_id: "703", max_item_count: 10 };
const NO_INVENTORY_DEVICE = { placeable_id: "5004", generator_type: "fuel", inventory_id: null, max_item_count: 0 };
const UNKNOWN_DEVICE = { placeable_id: "5005", generator_type: "somethingElse", inventory_id: "705", max_item_count: 10 };

test("baseGeneratorFuelLevels finds one starved device among full siblings of the same type", async () => {
  const calls = [];
  const { db } = fakeRefillDb(calls, {
    devices: [FUEL_DEVICE, SECOND_FUEL_DEVICE],
    items: {
      701: [{ id: 1, template_id: "Oil", stack_size: 499, position_index: 0 }],
      703: [{ id: 2, template_id: "Oil", stack_size: 100, position_index: 0 }]
    }
  });

  const levels = await baseGeneratorFuelLevels(db, "", 482);

  // The aggregate portalGeneratorFuel path groups by generator_type and would
  // report these two as one healthy row; the per-device read is the whole point.
  assert.equal(levels.deviceCount, 2);
  assert.equal(levels.devices.find((entry) => entry.placeableId === "5001").percent, 100);
  assert.equal(levels.devices.find((entry) => entry.placeableId === "5003").percent, 20);
  assert.equal(levels.lowestPercent, 20);
  // One grouped read for the whole base, not one query per device.
  assert.equal(calls.filter((call) => call.text.includes("sum(stack_size)::int as units")).length, 1);
});

test("baseGeneratorFuelLevels counts a device with no inventory as empty", async () => {
  const { db } = fakeRefillDb([], {
    devices: [FUEL_DEVICE, NO_INVENTORY_DEVICE],
    items: { 701: [{ id: 1, template_id: "Oil", stack_size: 499, position_index: 0 }] }
  });

  const levels = await baseGeneratorFuelLevels(db, "", 482);

  assert.equal(levels.devices.find((entry) => entry.placeableId === "5004").units, 0);
  assert.equal(levels.lowestPercent, 0);
});

test("baseGeneratorFuelLevels ignores fuel that is not the type's accepted fuel", async () => {
  const { db } = fakeRefillDb([], {
    devices: [FUEL_DEVICE],
    // A full stack of turbine lubricant does not fuel an oil generator.
    items: { 701: [{ id: 1, template_id: "WindTurbineLubricant1", stack_size: 499, position_index: 0 }] }
  });

  const levels = await baseGeneratorFuelLevels(db, "", 482);

  assert.equal(levels.devices[0].units, 0);
  assert.equal(levels.lowestPercent, 0);
});

test("baseGeneratorFuelLevels honours a cap override and excludes unknown placeables", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    mkdirSync(join(repoRoot, "runtime/data"), { recursive: true });
    writeFileSync(join(repoRoot, "runtime/data/generator-refill-caps.json"),
      JSON.stringify({ fuel: { totalCap: 200 } }));
    const { db } = fakeRefillDb([], {
      devices: [FUEL_DEVICE, UNKNOWN_DEVICE],
      items: {
        701: [{ id: 1, template_id: "Oil", stack_size: 100, position_index: 0 }],
        705: [{ id: 2, template_id: "Oil", stack_size: 0, position_index: 0 }]
      }
    });

    const levels = await baseGeneratorFuelLevels(db, repoRoot, 482);

    // Against the overridden cap of 200, 100 units is exactly half.
    assert.equal(levels.devices[0].cap, 200);
    assert.equal(levels.devices[0].percent, 50);
    // An unrecognised placeable is left out rather than assumed to burn oil.
    assert.equal(levels.deviceCount, 1);
  });
});

test("baseGeneratorFuelLevels reports null rather than zero for a base with no generators", async () => {
  const { db } = fakeRefillDb([], { devices: [] });

  const levels = await baseGeneratorFuelLevels(db, "", 482);

  // null must not read as "empty" to a caller deciding whether to refill.
  assert.equal(levels.lowestPercent, null);
  assert.equal(levels.deviceCount, 0);
});

// ---------------------------------------------------------------------------
// vehicleStorage: the per-slot read behind Vehicles -> Components -> View
// Contents. A vehicle has exactly one cargo hold, reached through
// dune.inventories.actor_id (== the vehicle's actor id) with
// inventory_type = 0 -- NOT through vehicle_module_id, which is empty in
// production. These tests pin both halves of that.
// ---------------------------------------------------------------------------

function fakeVehicleStorageDb(calls, fixtures = {}) {
  const {
    rows = [],
    missingTables = [],
    itemColumns = ["id", "inventory_id", "stack_size", "position_index", "template_id", "stats", "quality_level"],
    // Defaults to no max_item_volume, matching itemColumns' own default of no
    // volume_override -- a schema without volume support until a test opts in.
    inventoryColumns = ["id", "actor_id", "inventory_type", "max_item_count"]
  } = fixtures;
  return {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const table = String(values[0] || "");
        return { rows: [{ exists: !missingTables.some((name) => table.includes(name)) }] };
      }
      if (text.includes("information_schema.columns")) {
        const columns = values[1] === "inventories" ? inventoryColumns : itemColumns;
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (text.includes("with hold as")) return { rows };
      return { rows: [] };
    }
  };
}

const HOLD_ROW = {
  inventory_id: "2001", max_item_count: 20, max_item_volume: 2000,
  quality_level: 0, current_durability: null, max_durability: null
};

test("vehicleStorage reads the cargo hold off the vehicle actor, not a module", async () => {
  const calls = [];
  const db = fakeVehicleStorageDb(calls, {
    rows: [{ ...HOLD_ROW, item_id: "9", template_id: "JasmiumCrystal", stack_size: 162, position_index: 5 }]
  });
  const result = await vehicleStorage(db, 2008);

  assert.equal(result.supported, true);
  assert.equal(result.found, true);
  assert.equal(result.vehicleId, "2008");
  assert.equal(result.inventoryId, "2001");
  assert.equal(result.maxSlots, 20);
  assert.equal(result.usedSlots, 1);
  assert.deepEqual(result.slots.map((slot) => slot.templateId), ["JasmiumCrystal"]);
  assert.equal(result.slots[0].positionIndex, 5);
  assert.equal(result.slots[0].quantity, 162);

  const query = calls.find((call) => call.text.includes("with hold as"));
  assert.deepEqual(query.values, [2008]);
  // The three load-bearing clauses. inv.actor_id = v.id is what scopes the
  // hold to a real vehicle; inventory_type = 0 is what separates the cargo
  // hold from the per-component inventories on the same actor.
  assert.match(query.text, /join dune\.inventories inv on inv\.actor_id = v\.id/);
  assert.match(query.text, /inv\.inventory_type = 0/);
  assert.match(query.text, /from dune\.vehicles v/);
  // The empty links, explicitly: joining either would return nothing at all.
  assert.doesNotMatch(query.text, /vehicle_module_id/);
  assert.doesNotMatch(query.text, /vehicle_module_inventories/);
});

test("vehicleStorage keeps two stacks of one template apart", async () => {
  const calls = [];
  const db = fakeVehicleStorageDb(calls, {
    rows: [
      { ...HOLD_ROW, item_id: "1", template_id: "ScrapMetal", stack_size: 500, position_index: 0 },
      { ...HOLD_ROW, item_id: "2", template_id: "MagnetiteOre", stack_size: 200, position_index: 1 },
      { ...HOLD_ROW, item_id: "3", template_id: "ScrapMetal", stack_size: 400, position_index: 2 }
    ]
  });
  const result = await vehicleStorage(db, 2008);

  assert.equal(result.usedSlots, 3);
  // A template-merged rollup would report one ScrapMetal of 900.
  assert.deepEqual(result.slots.filter((slot) => slot.templateId === "ScrapMetal").map((slot) => slot.quantity), [500, 400]);
  assert.deepEqual(result.slots.map((slot) => slot.itemId), ["1", "2", "3"]);
});

test("vehicleStorage keeps an empty hold so the grid can render its empty slots", async () => {
  const calls = [];
  // The LEFT JOIN emits one all-null item row for an empty hold.
  const db = fakeVehicleStorageDb(calls, {
    rows: [{ ...HOLD_ROW, item_id: null, template_id: null, stack_size: null, position_index: null }]
  });
  const result = await vehicleStorage(db, 2008);

  assert.equal(result.found, true);
  assert.equal(result.usedSlots, 0);
  assert.equal(result.maxSlots, 20);
  assert.deepEqual(result.slots, []);
});

test("vehicleStorage answers found:false for an id that is not a vehicle", async () => {
  const calls = [];
  const db = fakeVehicleStorageDb(calls, { rows: [] });
  const result = await vehicleStorage(db, 999999);
  // An answer, not an error -- and the shape the route returns 200 with. The
  // join through dune.vehicles is what makes a player's or a placeable's
  // actor id land here instead of returning their inventory.
  assert.equal(result.supported, true);
  assert.equal(result.found, false);
  assert.equal(result.vehicleId, "999999");
  assert.deepEqual(result.slots, []);
  assert.match(result.reason, /no cargo hold/i);
});

test("vehicleStorage reports unsupported when any relation it reads is absent", async () => {
  for (const table of ["vehicles", "inventories", "items"]) {
    const db = fakeVehicleStorageDb([], { missingTables: [table] });
    const result = await vehicleStorage(db, 2008);
    // Probing only dune.vehicles would have passed two of these three.
    assert.equal(result.supported, false, `${table} should be required`);
    assert.match(result.reason, new RegExp(`dune\\.${table}`));
    assert.deepEqual(result.slots, []);
  }
});

test("vehicleStorage degrades a schema without position_index instead of failing", async () => {
  const calls = [];
  const db = fakeVehicleStorageDb(calls, {
    itemColumns: ["id", "inventory_id", "stack_size", "template_id"],
    rows: [{ ...HOLD_ROW, item_id: "1", template_id: "ScrapMetal", stack_size: 500, position_index: null }]
  });
  const result = await vehicleStorage(db, 2008);

  assert.equal(result.found, true);
  assert.equal(result.slots[0].positionIndex, null);
  assert.deepEqual(result.slots[0].augments, []);
  const query = calls.find((call) => call.text.includes("with hold as"));
  assert.match(query.text, /null::bigint as position_index/);
  assert.match(query.text, /null::jsonb as applied_augments/);
});

test("vehicleStorage falls back to the capacity-carrying inventory without inventory_type", async () => {
  const calls = [];
  const db = fakeVehicleStorageDb(calls, {
    inventoryColumns: ["id", "actor_id", "max_item_count"],
    rows: [{ ...HOLD_ROW, item_id: "1", template_id: "ScrapMetal", stack_size: 10, position_index: 0 }]
  });
  const result = await vehicleStorage(db, 2008);

  assert.equal(result.found, true);
  const query = calls.find((call) => call.text.includes("with hold as"));
  // The per-component inventories carry no capacity, so this still lands on
  // the cargo hold rather than guessing.
  assert.doesNotMatch(query.text, /inventory_type/);
  assert.match(query.text, /inv\.max_item_count > 0/);
});

test("vehicleStorage pairs augments positionally and stops at the shorter array", async () => {
  const calls = [];
  const db = fakeVehicleStorageDb(calls, {
    rows: [{
      ...HOLD_ROW, item_id: "1", template_id: "UniqueSword_05", stack_size: 1, position_index: 0,
      applied_augments: [{ Name: "T6_Augment_UnitTestFixture1" }, { Name: "T6_Augment_UnitTestFixture2" }],
      applied_augment_qualities: [2]
    }]
  });
  const result = await vehicleStorage(db, 2008);
  // A corrupt or hand-edited row degrades rather than 500ing a display path.
  assert.deepEqual(result.slots[0].augments.map((augment) => augment.qualityLevel), [2, 0]);
});

test("vehicleStorage multiplies per-unit volume_override by the stack size", async () => {
  const calls = [];
  const db = fakeVehicleStorageDb(calls, {
    itemColumns: ["id", "inventory_id", "stack_size", "position_index", "template_id", "stats", "quality_level", "volume_override"],
    inventoryColumns: ["id", "actor_id", "inventory_type", "max_item_count", "max_item_volume"],
    rows: [{ ...HOLD_ROW, item_id: "1", template_id: "ScrapMetal", stack_size: 100, position_index: 0, volume_override: 1.5 }]
  });
  const result = await vehicleStorage(db, 2008);

  assert.equal(result.maxVolume, 2000);
  assert.equal(result.currentVolume, 150);
  assert.equal(result.volumeComplete, true);
});

test("vehicleStorage reports volumeComplete:false on a schema without volume tracking", async () => {
  const calls = [];
  const db = fakeVehicleStorageDb(calls, {
    rows: [{ ...HOLD_ROW, max_item_volume: 0, item_id: "1", template_id: "ScrapMetal", stack_size: 100, position_index: 0 }]
  });
  const result = await vehicleStorage(db, 2008);

  assert.equal(result.volumeComplete, false);
  assert.equal(result.currentVolume, 0);
});

test("isVehicleStorageModule matches every shipped storage module and nothing else", async () => {
  for (const id of [
    "BuggyInventory_3", "BuggyInventory_6", "SandbikeInventory_1", "SandbikeInventory_2",
    "OrnithopterLightInventory_4", "OrnithopterMediumInventory_5", "TreadwheelInventory_2",
    "BuggyInventory_Unique_Capacity_03", "BuggyInventory_Unique_Capacity_06"
  ]) {
    assert.equal(isVehicleStorageModule(id), true, id);
  }
  for (const id of [
    "BuggyEngine_5", "BuggyLocomotionBackLeft_5", "OrnithopterMediumWings_5",
    "GeneratorModule", "", null, undefined
  ]) {
    assert.equal(isVehicleStorageModule(id), false, String(id));
  }
});

test("listVehicles flags which fitted modules are storage", async () => {
  const db = {
    query: async (text) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("total_vehicles")) return { rows: [{ total_vehicles: 1 }] };
      if (text.includes("module_durability")) return { rows: [{
        id: "2008", name: "Sandcrawler", type: "Buggy", owner: "Duncan_Idaho",
        condition_percent: 92, current_fuel: "61", max_fuel: "100", fuel_percent: 61,
        map: "HaggaBasin", partition_id: 1, x: "1", y: "2", z: "3", total_count: 1,
        modules: [
          { templateId: "BuggyEngine_5", condition: "440", maxCondition: "500", conditionPercent: 88 },
          { templateId: "BuggyInventory_4", condition: null, maxCondition: null, conditionPercent: null }
        ],
        shared_with: []
      }] };
      return { rows: [] };
    }
  };
  const result = await listVehicles(db, { page: 0, pageSize: 50 });
  // What the Components tab gates its View Contents button on.
  assert.deepEqual(result.rows[0].modules.map((module) => module.isStorage), [false, true]);
  assert.equal(result.capabilities.vehicleStorage, true);
});

// ---------------------------------------------------------------------------
// Vehicle cargo deletion. Mirrors the base container delete family, minus the
// claim-CTE chain and the storage/crafting group check, plus one guard bases
// have no analogue for: a vehicle in Travel/VehicleBackup/VehicleRecovery
// refuses.
// ---------------------------------------------------------------------------

function fakeVehicleDeleteDb(calls, fixtures = {}) {
  const {
    hold = [{ inventory_id: "2001", actor_id: "2008", max_item_count: 20, max_item_volume: 2000 }],
    items = [],
    actorState = null,
    procedures = ["dune.delete_item(bigint)", "dune.delete_inventory_item(bigint,bigint)"],
    itemColumns = ["id", "inventory_id", "stack_size", "position_index", "template_id", "stats", "quality_level"],
    partialResult = undefined,
    stackAfter = undefined,
    stillPresent = []
  } = fixtures;
  const state = { deleted: new Set() };
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) {
        const signature = String(values[0] || "");
        return { rows: [{ exists: procedures.includes(signature) }] };
      }
      if (text.includes("information_schema.columns")) {
        return { rows: itemColumns.map((column_name) => ({ column_name })) };
      }
      if (text.includes("set local search_path")) return { rows: [] };
      if (text.includes("with candidates as")) return { rows: hold };
      if (text.includes("from dune.actor_state")) return { rows: actorState ? [{ state: actorState }] : [] };
      if (text.includes("for update of i, inv")) return { rows: items };
      if (text.includes("delete_inventory_item")) return { rows: [{ result: partialResult }] };
      if (text.includes("select stack_size from dune.items")) {
        return { rows: stackAfter === undefined ? [] : [{ stack_size: stackAfter }] };
      }
      if (text.includes("select dune.delete_item")) { state.deleted.add(String(values[0])); return { rows: [] }; }
      if (text.includes("exists(select 1 from dune.items")) {
        const present = stillPresent.includes(String(values[0]));
        return { rows: [{ exists: present, deleted: !present }] };
      }
      // The bulk set-based select-for-update.
      if (text.includes("for update") && text.includes("from dune.items")) return { rows: items };
      if (text.includes("select id::text as item_id from dune.items")) {
        return { rows: stillPresent.map((item_id) => ({ item_id })) };
      }
      if (text.startsWith("delete from dune.items")) return { rows: [] };
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };
  return db;
}

const CARGO_ITEM = {
  item_id: "501", template_id: "JasmiumCrystal", stack_size: 162, inventory_id: "2001",
  position_index: 5, quality_level: 0, current_durability: null, max_durability: null
};

test("deleteVehicleStorageItem resolves the hold, locks it, and deletes through the shipped procedure", async () => {
  const calls = [];
  const db = fakeVehicleDeleteDb(calls, { items: [CARGO_ITEM] });
  const result = await deleteVehicleStorageItem(db, 2008, "501");

  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.vehicleId, "2008");
  assert.equal(result.inventoryId, "2001");
  assert.equal(result.removed.count, 162);
  assert.equal(result.removed.remaining, 0);
  // Audit detail, captured before the row went away.
  assert.equal(result.removed.positionIndex, 5);

  // search_path is set before anything touches the hold, or the shipped
  // procedures resolve nothing and the transaction aborts before the
  // raw-delete fallback can run.
  const searchPathAt = calls.findIndex((call) => call.text.includes("set local search_path to dune, public"));
  const resolveAt = calls.findIndex((call) => call.text.includes("with candidates as"));
  assert.ok(searchPathAt !== -1, "search_path was never set");
  assert.ok(searchPathAt < resolveAt, "search_path must be set before the hold is resolved");
  const resolve = calls[resolveAt];
  // Postgres rejects SELECT DISTINCT combined with FOR UPDATE outright, which
  // is why the DISTINCT lives in the CTE and the lock is taken on the join
  // back. Asserted on the OUTER select specifically: both keywords appear in
  // this query, and the bug is having them in the SAME one.
  assert.match(resolve.text, /for update of inv/);
  const outerSelect = resolve.text.slice(resolve.text.indexOf(")", resolve.text.indexOf("with candidates as")));
  assert.doesNotMatch(outerSelect, /distinct/i, "the locking select must not be DISTINCT");
  assert.match(resolve.text.slice(0, resolve.text.indexOf(")")), /select distinct/i, "the candidate CTE is where DISTINCT belongs");
  assert.match(resolve.text, /inv\.inventory_type = 0/);
  const lookup = calls.find((call) => call.text.includes("for update of i, inv"));
  // Scoped on the resolved hold, so another vehicle's item returns no rows.
  assert.match(lookup.text, /where i\.id = \$1 and i\.inventory_id = \$2/);
  assert.deepEqual(lookup.values, ["501", "2001"]);
});

test("deleteVehicleStorageItem keeps a bigint item id exact instead of Number()-ing it", async () => {
  const calls = [];
  const big = "9223372036854775806";
  const db = fakeVehicleDeleteDb(calls, { items: [{ ...CARGO_ITEM, item_id: big }] });
  await deleteVehicleStorageItem(db, 2008, big);
  const lookup = calls.find((call) => call.text.includes("for update of i, inv"));
  // Number(big) rounds to 9223372036854775808 -- a different row.
  assert.equal(lookup.values[0], big);
});

test("deleteVehicleStorageItem rejects an item that is not in this vehicle's hold", async () => {
  const db = fakeVehicleDeleteDb([], { items: [] });
  await assert.rejects(() => deleteVehicleStorageItem(db, 2008, "999"), /not found in this vehicle's cargo hold/);
});

test("deleteVehicleStorageItem reports a vehicle with no cargo hold rather than guessing", async () => {
  const db = fakeVehicleDeleteDb([], { hold: [] });
  await assert.rejects(() => deleteVehicleStorageItem(db, 2008, "501"), /no cargo hold/);
});

test("deleteVehicleStorageItem refuses to pick when a vehicle backs more than one hold", async () => {
  const db = fakeVehicleDeleteDb([], {
    hold: [
      { inventory_id: "2001", actor_id: "2008", max_item_count: 20, max_item_volume: 2000 },
      { inventory_id: "2002", actor_id: "2008", max_item_count: 20, max_item_volume: 2000 }
    ]
  });
  // A silent "success" that leaves items behind in a second hold is worse than
  // a loud failure.
  await assert.rejects(() => deleteVehicleStorageItem(db, 2008, "501"), /2 separate cargo holds/);
});

test("deleteVehicleStorageItem refuses every blocked vehicle state", async () => {
  for (const state of ["Travel", "VehicleBackup", "VehicleRecovery"]) {
    const db = fakeVehicleDeleteDb([], { items: [CARGO_ITEM], actorState: state });
    await assert.rejects(
      () => deleteVehicleStorageItem(db, 2008, "501"),
      new RegExp(`currently ${state} and its cargo cannot be changed`),
      `${state} should refuse`
    );
  }
});

test("deleteVehicleStorageItem allows an ordinary vehicle with no actor_state row", async () => {
  const db = fakeVehicleDeleteDb([], { items: [CARGO_ITEM], actorState: null });
  const result = await deleteVehicleStorageItem(db, 2008, "501");
  assert.equal(result.ok, true);
});

test("deleteVehicleStorageItem refuses a count larger than the stack instead of clearing the slot", async () => {
  const db = fakeVehicleDeleteDb([], { items: [CARGO_ITEM] });
  // The caller saw 500, asked for 400, and the stack has since dropped --
  // widening that into destroying everything removes more than was agreed to.
  await assert.rejects(
    () => deleteVehicleStorageItem(db, 2008, "501", { count: 500 }),
    /Cannot remove 500: the stack holds 162/
  );
});

test("deleteVehicleStorageItem routes a partial removal through dune.delete_inventory_item", async () => {
  const calls = [];
  const db = fakeVehicleDeleteDb(calls, { items: [CARGO_ITEM], partialResult: 62, stackAfter: 62 });
  const result = await deleteVehicleStorageItem(db, 2008, "501", { count: 100 });

  assert.equal(result.partial, true);
  assert.equal(result.removed.count, 100);
  assert.equal(result.removed.remaining, 62);
  const partial = calls.find((call) => call.text.includes("delete_inventory_item"));
  assert.deepEqual(partial.values, ["501", 100]);
  // The whole-slot procedure must not also have run.
  assert.equal(calls.some((call) => call.text.includes("select dune.delete_item")), false);
});

test("deleteVehicleStorageItem treats a count equal to the whole stack as a whole-slot delete", async () => {
  const calls = [];
  const db = fakeVehicleDeleteDb(calls, { items: [CARGO_ITEM] });
  const result = await deleteVehicleStorageItem(db, 2008, "501", { count: 162 });
  assert.equal(result.partial, false);
  assert.equal(calls.some((call) => call.text.includes("delete_inventory_item")), false);
});

test("deleteVehicleStorageItem treats a null from the partial procedure as a failure", async () => {
  const db = fakeVehicleDeleteDb([], { items: [CARGO_ITEM], partialResult: null });
  // The shipped procedure returns NULL rather than raising when the count
  // exceeds the stack, so a null is a failure, not a no-op success.
  await assert.rejects(
    () => deleteVehicleStorageItem(db, 2008, "501", { count: 100 }),
    /rejected by the database/
  );
});

test("deleteVehicleStorageItem distinguishes a rejected partial from a small remainder", async () => {
  // The guard is `result === null || result === undefined`, not a truthy
  // check. A remainder of 0 cannot arise on this path -- count === stackSize
  // routes to the whole-slot delete instead -- but a remainder of 1 is the
  // smallest real success, and a truthy check would still be wrong the moment
  // that changes.
  const db = fakeVehicleDeleteDb([], {
    items: [{ ...CARGO_ITEM, stack_size: 100 }], partialResult: 1, stackAfter: 1
  });
  const result = await deleteVehicleStorageItem(db, 2008, "501", { count: 99 });
  assert.equal(result.partial, true);
  assert.equal(result.removed.remaining, 1);
  assert.match(result.message, /leaving 1/);
});

test("deleteVehicleStorageItem raises when the stack did not change by the requested amount", async () => {
  const db = fakeVehicleDeleteDb([], { items: [CARGO_ITEM], partialResult: 62, stackAfter: 150 });
  await assert.rejects(
    () => deleteVehicleStorageItem(db, 2008, "501", { count: 100 }),
    /did not change the stack by the requested amount/
  );
});

test("deleteVehicleStorageItem refuses a partial removal when the schema lacks the procedure", async () => {
  const db = fakeVehicleDeleteDb([], {
    items: [CARGO_ITEM], procedures: ["dune.delete_item(bigint)"]
  });
  // Refused rather than widened into a whole-stack delete.
  await assert.rejects(
    () => deleteVehicleStorageItem(db, 2008, "501", { count: 100 }),
    /requires dune\.delete_inventory_item/
  );
});

test("deleteVehicleStorageItem falls back to a raw delete scoped on the hold", async () => {
  const calls = [];
  // dune.delete_item left the row behind; the fallback must still not escape
  // the verified inventory.
  const db = fakeVehicleDeleteDb(calls, { items: [CARGO_ITEM], stillPresent: [] });
  await deleteVehicleStorageItem(db, 2008, "501");
  const raw = calls.find((call) => call.text.startsWith("delete from dune.items"));
  if (raw) assert.match(raw.text, /and inventory_id = \$2/);
  const verify = calls.filter((call) => call.text.includes("exists(select 1 from dune.items"));
  assert.ok(verify.length >= 1);
  assert.match(verify[0].text, /and inventory_id = \$2/);
});

test("deleteVehicleStorageItem raises when the row is still there after both attempts", async () => {
  const db = fakeVehicleDeleteDb([], { items: [CARGO_ITEM], stillPresent: ["501"] });
  await assert.rejects(() => deleteVehicleStorageItem(db, 2008, "501"), /did not remove the item/);
});

test("deleteVehicleStorageItem degrades audit detail on a schema without those columns", async () => {
  const calls = [];
  const db = fakeVehicleDeleteDb(calls, {
    itemColumns: ["id", "inventory_id", "stack_size", "template_id"],
    items: [{ item_id: "501", template_id: "ScrapMetal", stack_size: 5, inventory_id: "2001" }]
  });
  const result = await deleteVehicleStorageItem(db, 2008, "501");
  assert.equal(result.removed.positionIndex, null);
  assert.equal(result.removed.qualityLevel, 0);
  assert.equal(result.removed.currentDurability, null);
  const lookup = calls.find((call) => call.text.includes("for update of i, inv"));
  assert.match(lookup.text, /null::bigint as position_index/);
});

test("deleteVehicleStorageItem reports unsupported when the delete procedure is absent", async () => {
  const db = fakeVehicleDeleteDb([], { procedures: [] });
  await assert.rejects(() => deleteVehicleStorageItem(db, 2008, "501"), /dune\.delete_item\(bigint\)/);
});

test("deleteMultipleVehicleStorageItems deletes only the requested ids that exist in the hold", async () => {
  const calls = [];
  const db = fakeVehicleDeleteDb(calls, {
    items: [
      { item_id: "501", template_id: "JasmiumCrystal", stack_size: 162, position_index: 0, quality_level: 0, current_durability: null, max_durability: null },
      { item_id: "503", template_id: "Mk5Cutteray", stack_size: 1, position_index: 5, quality_level: 4, current_durability: 300, max_durability: 600 }
    ]
  });
  // 999 is not in the hold -- skipped, not an error.
  const result = await deleteMultipleVehicleStorageItems(db, 2008, ["501", "503", "999"]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.removed.map((row) => row.itemId), ["501", "503"]);
  assert.match(result.message, /2 of 3 requested item\(s\)/);
  // Full audit detail, not just the template.
  assert.equal(result.removed[1].qualityLevel, 4);
  assert.equal(result.removed[1].maxDurability, 600);
  const select = calls.find((call) => call.text.includes("= any($1::bigint[]) and inventory_id = $2"));
  assert.equal(select.values[1], "2001");
});

test("deleteMultipleVehicleStorageItems dedupes ids after normalizing them", async () => {
  const calls = [];
  const db = fakeVehicleDeleteDb(calls, { items: [{ item_id: "501", template_id: "X", stack_size: 1 }] });
  await deleteMultipleVehicleStorageItems(db, 2008, ["501", 501, "501"]);
  const select = calls.find((call) => call.text.includes("= any($1::bigint[])"));
  assert.deepEqual(select.values[0], ["501"]);
});

test("deleteMultipleVehicleStorageItems rejects an empty list and an oversized batch", async () => {
  const db = fakeVehicleDeleteDb([], {});
  await assert.rejects(() => deleteMultipleVehicleStorageItems(db, 2008, []), /At least one item ID/);
  const tooMany = Array.from({ length: 201 }, (_, index) => String(index + 1));
  await assert.rejects(() => deleteMultipleVehicleStorageItems(db, 2008, tooMany), /more than 200 items/);
});

test("deleteMultipleVehicleStorageItems refuses a blocked vehicle state", async () => {
  const db = fakeVehicleDeleteDb([], { items: [{ item_id: "501", template_id: "X", stack_size: 1 }], actorState: "Travel" });
  await assert.rejects(() => deleteMultipleVehicleStorageItems(db, 2008, ["501"]), /currently Travel/);
});

test("deleteAllVehicleStorageItems reads the list fresh inside the deleting transaction", async () => {
  const calls = [];
  const db = fakeVehicleDeleteDb(calls, {
    items: [
      { item_id: "501", template_id: "JasmiumCrystal", stack_size: 162 },
      { item_id: "502", template_id: "JasmiumCrystal", stack_size: 40 }
    ]
  });
  const result = await deleteAllVehicleStorageItems(db, 2008);

  assert.equal(result.removed.length, 2);
  assert.match(result.message, /2 item\(s\) were deleted/);
  // Scoped by inventory only -- no caller-supplied id list to go stale.
  const select = calls.find((call) => call.text.includes("where inventory_id = $1"));
  assert.deepEqual(select.values, ["2001"]);
});

test("deleteAllVehicleStorageItems reports an already-empty hold distinctly", async () => {
  const db = fakeVehicleDeleteDb([], { items: [] });
  const result = await deleteAllVehicleStorageItems(db, 2008);
  assert.equal(result.removed.length, 0);
  assert.match(result.message, /already empty/);
});

test("deleteAllVehicleStorageItems refuses a blocked vehicle state", async () => {
  const db = fakeVehicleDeleteDb([], { items: [{ item_id: "501", template_id: "X", stack_size: 1 }], actorState: "VehicleBackup" });
  await assert.rejects(() => deleteAllVehicleStorageItems(db, 2008), /currently VehicleBackup/);
});

test("vehicleStorageDeleteSafety reports the blocking state and withholds deletion", async () => {
  const blocked = await vehicleStorageDeleteSafety(fakeVehicleDeleteDb([], { actorState: "VehicleRecovery" }), 2008);
  assert.equal(blocked.safe, false);
  assert.equal(blocked.known, true);
  assert.equal(blocked.state, "VehicleRecovery");
  assert.match(blocked.reason, /currently VehicleRecovery/);

  const ok = await vehicleStorageDeleteSafety(fakeVehicleDeleteDb([], { actorState: null }), 2008);
  assert.equal(ok.safe, true);
  assert.equal(ok.state, "");
  assert.equal(ok.reason, "");
});

test("vehicleStorageDeleteSafety withholds deletion when the schema cannot support it", async () => {
  const safety = await vehicleStorageDeleteSafety(fakeVehicleDeleteDb([], { procedures: [] }), 2008);
  assert.equal(safety.safe, false);
  assert.equal(safety.known, true);
  assert.match(safety.reason, /dune\.delete_item\(bigint\)/);
});

// The map-down hook passes ignoreRetryBackoff so a restart's brief write window
// is not wasted on entries the 5s poller happens to have backed off. Measured on
// a live server: the poller stamps nextRetryAt 60s out on every failed attempt
// and runs every 5s, so a persistently-blocked entry sits inside a backoff
// window for roughly 55 of every 60 seconds -- the hook lands in one about 92%
// of the time and would silently apply nothing.
//
// These cover the three queues the delete queues' own tests do not reach. Each
// asserts both directions, because only the pair is meaningful: honouring the
// window without the flag, and overriding it with the flag. A skipped entry
// produces no flushed record at all, which is what distinguishes it from one
// that was attempted and failed.
const BACKOFF_AT = 5_000_000;

function alwaysFailingDb(partitions) {
  const { db } = fakeQueueDb([], { devices: [FUEL_DEVICE], partitions });
  db.transaction = async () => { throw new Error("simulated write failure"); };
  return db;
}

for (const queue of [
  {
    label: "generator refill",
    queueEntry: (repoRoot) => queueGeneratorRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 }),
    flush: (db, repoRoot, options) => flushGeneratorRefills(db, repoRoot, options),
    list: listQueuedGeneratorRefills
  },
  {
    label: "water refill",
    queueEntry: (repoRoot) => queueWaterRefill(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 }),
    flush: (db, repoRoot, options) => flushWaterRefills(db, repoRoot, options),
    list: listQueuedWaterRefills
  }
]) {
  test(`the map-down pass applies a ${queue.label} the poller just backed off`, async () => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      queue.queueEntry(repoRoot);
      const db = alwaysFailingDb(DESPAWNED_PARTITIONS);

      // Poller attempt fails and stamps a retry window on the entry.
      const first = await queue.flush(db, repoRoot, { now: () => BACKOFF_AT });
      assert.equal(first.flushed.length, 1, "the first pass must actually attempt the entry");
      assert.ok(queue.list(repoRoot)[0].nextRetryAt > BACKOFF_AT, "a retry window must be stamped");

      // Background tick inside that window: skipped entirely, nothing reported.
      _resetRefillPartitionDwellForTests();
      const skipped = await queue.flush(db, repoRoot, { now: () => BACKOFF_AT + 1 });
      assert.deepEqual(skipped.flushed, [], "the poller must still honour its own backoff");

      // Map-down hook in the same window: attempted despite the backoff.
      _resetRefillPartitionDwellForTests();
      const forced = await queue.flush(db, repoRoot, { now: () => BACKOFF_AT + 1, ignoreRetryBackoff: true });
      assert.equal(forced.flushed.length, 1, "ignoreRetryBackoff must override the window");
      assert.equal(forced.flushed[0].baseId, 482);
    });
  });
}

// supportsBaseDelete must probe every relation the delete path reads. The
// in-transaction backed-up guard LEFT JOINs dune.permission_actor, so a schema
// without it has to fail as a clean capability message -- not as an aborted
// transaction after the claim actor is already locked FOR UPDATE.
function baseDeleteCapabilityDb({ missingTable = null } = {}) {
  const query = async (text, values = []) => {
    if (text.includes("to_regclass")) {
      const target = String(values[0]);
      return okRows([{ exists: missingTable ? target !== `dune.${missingTable}` : true }]);
    }
    if (text.includes("to_regprocedure")) return okRows([{ exists: true }]);
    return okRows([]);
  };
  return { query, transaction: async (fn) => fn({ query }) };
}

test("base delete reports unsupported capability when permission_actor is absent", async () => {
  const db = baseDeleteCapabilityDb({ missingTable: "permission_actor" });
  await assert.rejects(() => deleteBaseCompletely(db, 1), UnsupportedCapabilityError);
});

// Control: with the same mock and nothing missing, the capability gate passes
// and the call gets far enough to fail on the base lookup instead. Without this
// the test above would still pass if the probe rejected for any other reason.
test("base delete passes the capability gate once permission_actor is present", async () => {
  const db = baseDeleteCapabilityDb();
  await assert.rejects(() => deleteBaseCompletely(db, 1), /was not found/);
});
