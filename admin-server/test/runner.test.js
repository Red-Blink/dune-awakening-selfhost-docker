import test from "node:test";
import assert from "node:assert/strict";
import { buildDuneArgs, dockerContainerForLogService, isReadOnlySql, parseVehicleList, validateServiceName } from "../src/runner.js";
import { redact } from "../src/redact.js";
import { taskOperations } from "../src/tasks.js";

test("validates known service names and aliases", () => {
  assert.equal(validateServiceName("gateway"), "gateway");
  assert.equal(validateServiceName("sgw"), "gateway");
  assert.equal(validateServiceName("dune-server-survival-1-43"), "dune-server-survival-1-43");
  assert.throws(() => validateServiceName("gateway; rm -rf /"));
});

test("allows dynamic map containers as log targets", () => {
  assert.equal(dockerContainerForLogService("survival-1"), "dune-server-survival-1");
  assert.equal(dockerContainerForLogService("dune-server-survival-1-43"), "dune-server-survival-1-43");
  assert.equal(dockerContainerForLogService("dune-server-sh-arrakeen-3"), "dune-server-sh-arrakeen-3");
});

test("builds allowlisted command arguments without shell interpolation", () => {
  assert.deepEqual(buildDuneArgs("status"), ["status"]);
  assert.deepEqual(buildDuneArgs("doctor"), ["doctor"]);
  assert.deepEqual(buildDuneArgs("restartService", { service: "director" }), ["restart", "director"]);
  assert.deepEqual(buildDuneArgs("logs", { service: "gateway" }), ["logs", "gateway"]);
  assert.deepEqual(buildDuneArgs("backupDelete", { backup: "dune-db-test.backup" }), ["db", "delete", "dune-db-test.backup"]);
  assert.deepEqual(buildDuneArgs("backupDeleteAll"), ["db", "delete", "--all"]);
  assert.deepEqual(buildDuneArgs("adminAddXp", { playerId: "FLS_TEST", amount: 1000 }), ["admin", "award-xp", "FLS_TEST", "1000"]);
  assert.deepEqual(buildDuneArgs("updateApply"), ["update", "--yes"]);
  assert.deepEqual(buildDuneArgs("updateAutoStatus"), ["update", "auto", "status"]);
  assert.deepEqual(buildDuneArgs("updateAutoEnable", { time: "05:00" }), ["update", "auto", "enable", "05:00"]);
  assert.deepEqual(buildDuneArgs("updateAutoDisable"), ["update", "auto", "disable"]);
  assert.deepEqual(buildDuneArgs("selfUpdateApply"), ["self-update", "install", "latest"]);
  assert.deepEqual(buildDuneArgs("selfUpdateList"), ["self-update", "list"]);
  assert.deepEqual(buildDuneArgs("selfUpdatePrevious"), ["self-update", "install", "previous"]);
  assert.deepEqual(buildDuneArgs("backupAutoStatus"), ["db", "auto", "status"]);
  assert.deepEqual(buildDuneArgs("backupAutoEnable", { time: "05:30", retentionDays: 14 }), ["db", "auto", "enable", "05:30", "14"]);
  assert.deepEqual(buildDuneArgs("backupAutoEnable", { time: "05:30", retentionDays: 0 }), ["db", "auto", "enable", "05:30"]);
  assert.deepEqual(buildDuneArgs("backupAutoDisable"), ["db", "auto", "disable"]);
  assert.deepEqual(buildDuneArgs("restartScheduleStatus"), ["restart-schedule", "status"]);
  assert.deepEqual(buildDuneArgs("restartScheduleEnable", { time: "04:30" }), ["restart-schedule", "enable", "04:30", "15"]);
  assert.deepEqual(buildDuneArgs("restartScheduleEnable", { time: "04:30", notifyMinutes: 30 }), ["restart-schedule", "enable", "04:30", "30"]);
  assert.deepEqual(buildDuneArgs("restartScheduleDisable"), ["restart-schedule", "disable"]);
  assert.deepEqual(buildDuneArgs("adminTeleport", { playerId: "FLS_TEST", x: 1, y: 2, z: 3, yaw: 90 }), ["admin", "teleport", "FLS_TEST", "1", "2", "3", "90"]);
  assert.deepEqual(buildDuneArgs("adminGiveItem", { playerId: "FLS_TEST", itemName: "Water", quantity: 2 }), ["admin", "grant-item", "FLS_TEST", "Water", "2", "1", "0"]);
  assert.deepEqual(buildDuneArgs("adminGiveItem", { playerId: "FLS_TEST", itemName: "Water", quantity: 2, quality: 3 }), ["admin", "grant-item", "FLS_TEST", "Water", "2", "1", "3"]);
  assert.deepEqual(buildDuneArgs("adminGiveItemId", { playerId: "FLS_TEST", itemId: "WaterBottle_1", quantity: 2, quality: 0 }), ["admin", "grant-item-id", "FLS_TEST", "WaterBottle_1", "2", "1", "0"]);
  assert.deepEqual(buildDuneArgs("adminGiveItemId", { playerId: "FLS_TEST", itemId: "WaterBottle_1", quantity: 2, durability: 0.5, quality: 5 }), ["admin", "grant-item-id", "FLS_TEST", "WaterBottle_1", "2", "1", "5"]);
  assert.deepEqual(buildDuneArgs("adminGiveItems", { playerId: "FLS_TEST", template: "scout-ornithopter-mk6" }), ["admin", "grant-template", "FLS_TEST", "scout-ornithopter-mk6"]);
  assert.deepEqual(buildDuneArgs("adminSetSkillPoints", { playerId: "FLS_TEST", points: 12 }), ["admin", "skill-points", "FLS_TEST", "12"]);
  assert.deepEqual(buildDuneArgs("adminSetSkillModule", { playerId: "FLS_TEST", module: "Training_Test", level: 2 }), ["admin", "skill-module", "FLS_TEST", "Training_Test", "2"]);
  assert.deepEqual(buildDuneArgs("adminKickAllOnline"), ["admin", "kick", "--all-online", "--yes"]);
  assert.deepEqual(buildDuneArgs("adminSpawnVehicle", { playerId: "FLS_TEST", vehicleId: "Sandbike", template: "T6", offset: 400 }), ["admin", "spawn-vehicle", "FLS_TEST", "Sandbike", "T6", "400"]);
  assert.deepEqual(buildDuneArgs("adminCleanInventory", { playerId: "FLS_TEST" }), ["admin", "clean-inventory", "FLS_TEST"]);
  assert.deepEqual(buildDuneArgs("adminResetProgression", { playerId: "FLS_TEST" }), ["admin", "reset-progression", "FLS_TEST"]);
  assert.deepEqual(buildDuneArgs("mapsMode", { map: "DeepDesert_1" }), ["maps", "mode", "DeepDesert_1"]);
  assert.deepEqual(buildDuneArgs("mapsSetMode", { map: "DeepDesert_1", mode: "always-on" }), ["maps", "set", "DeepDesert_1", "always-on"]);
  assert.deepEqual(buildDuneArgs("mapsSpawn", { target: "30" }), ["spawn", "30"]);
  assert.deepEqual(buildDuneArgs("mapsDespawn", { target: "DeepDesert_1" }), ["despawn", "DeepDesert_1", "--force"]);
  assert.deepEqual(buildDuneArgs("autoscalerAction", { action: "restart" }), ["autoscaler", "restart"]);
  assert.deepEqual(buildDuneArgs("memorySet", { map: "DeepDesert_1", memory: "8g" }), ["memory", "set", "DeepDesert_1", "8g"]);
  assert.deepEqual(buildDuneArgs("memorySetNoRestart", { map: "DeepDesert_1", partitionId: "8", memory: "10g" }), ["memory", "set-no-restart", "partition:8", "10g"]);
  assert.deepEqual(buildDuneArgs("sietchesSetActive", { map: "Survival_1", count: 2 }), ["sietches", "set-active", "Survival_1", "2"]);
  assert.deepEqual(buildDuneArgs("sietchesSetDisplay", { partitionId: 38, displayName: "Sietch Alpha" }), ["sietches", "set-display", "38", "Sietch Alpha"]);
  assert.deepEqual(buildDuneArgs("sietchesSetDisplay", { partitionId: 38, displayName: "" }), ["sietches", "set-display", "38", ""]);
  assert.deepEqual(buildDuneArgs("deepdesertAction", { action: "disable" }), ["deepdesert", "dual", "disable", "--yes", "--force"]);
  assert.deepEqual(buildDuneArgs("userSettingsEngineValues"), ["usersettings", "engine-values"]);
  assert.deepEqual(buildDuneArgs("userSettingsGlobalValues"), ["usersettings", "global-values"]);
  assert.deepEqual(buildDuneArgs("userSettingsMapValues", { map: "Survival_1" }), ["usersettings", "map-values", "Survival_1"]);
  assert.deepEqual(buildDuneArgs("userSettingsPartitionValues", { map: "Survival_1", partitionId: 1 }), ["usersettings", "partition-values", "Survival_1", "1"]);
  assert.deepEqual(buildDuneArgs("userSettingsResetAndRestart", { scope: "global" }), ["usersettings", "reset-global-game"]);
  assert.throws(() => buildDuneArgs("adminAddXp", { playerId: "bad;id", amount: 1000 }));
  assert.throws(() => buildDuneArgs("backupRestore", { backup: "../dump.backup" }));
  assert.throws(() => buildDuneArgs("adminGiveItem", { playerId: "FLS_TEST", itemName: "", quantity: 1 }));
  assert.throws(() => buildDuneArgs("adminGiveItemId", { playerId: "FLS_TEST", itemId: "bad;id", quantity: 1 }));
  assert.throws(() => buildDuneArgs("adminGiveItem", { playerId: "FLS_TEST", itemName: "Water", quantity: 0 }));
  assert.throws(() => buildDuneArgs("adminGiveItem", { playerId: "FLS_TEST", itemName: "Water", quantity: 1, quality: -1 }));
  assert.throws(() => buildDuneArgs("adminGiveItem", { playerId: "FLS_TEST", itemName: "Water", quantity: 1, quality: 6 }));
  assert.throws(() => buildDuneArgs("adminSetSkillPoints", { playerId: "FLS_TEST", points: -1 }));
  assert.throws(() => buildDuneArgs("adminSpawnVehicle", { playerId: "FLS_TEST", vehicleId: "Sandbike;bad", template: "T6" }));
  assert.throws(() => buildDuneArgs("mapsSetMode", { map: "DeepDesert_1;bad", mode: "dynamic" }));
  assert.throws(() => buildDuneArgs("mapsSetMode", { map: "DeepDesert_1", mode: "bad" }));
  assert.throws(() => buildDuneArgs("mapsSpawn", { target: "../bad" }));
  assert.throws(() => buildDuneArgs("autoscalerAction", { action: "run" }));
  assert.throws(() => buildDuneArgs("memorySet", { map: "DeepDesert_1", memory: "8gb" }));
  assert.throws(() => buildDuneArgs("sietchesSetPassword", { partitionId: 1, password: "bad\npw" }));
  assert.throws(() => buildDuneArgs("deepdesertAction", { action: "reset" }));
  assert.throws(() => buildDuneArgs("restartScheduleEnable", { time: "24:00" }));
  assert.throws(() => buildDuneArgs("restartScheduleEnable", { time: "04:30", notifyMinutes: 0 }));
  assert.throws(() => buildDuneArgs("backupAutoEnable", { time: "99:00" }));
  assert.throws(() => buildDuneArgs("backupAutoRetention", { retentionDays: -1 }));
  assert.throws(() => buildDuneArgs("updateAutoEnable", { time: "bad" }));
  assert.throws(() => buildDuneArgs("unknown"));
});

test("validates admin catalog wrapper arguments", () => {
  assert.deepEqual(buildDuneArgs("adminItemSearch", { q: "water" }), ["admin", "item-search", "water"]);
  assert.deepEqual(buildDuneArgs("adminItemList"), ["admin", "item-list"]);
  assert.deepEqual(buildDuneArgs("adminItemListCategory", { category: "materials" }), ["admin", "item-list", "materials"]);
  assert.deepEqual(buildDuneArgs("adminVehicleSearch", { q: "bike" }), ["admin", "vehicle-list", "bike"]);
  assert.deepEqual(buildDuneArgs("adminSkillModulesSearch", { q: "blade" }), ["admin", "skill-modules", "blade"]);
  assert.throws(() => buildDuneArgs("adminItemSearch", { q: "x" }));
  assert.throws(() => buildDuneArgs("adminItemSearch", { q: "water\nbad" }));
  assert.throws(() => buildDuneArgs("adminVehicleSearch", { q: "bike\nbad" }));
});

test("uses the global UserGame reset operation in restart tasks", () => {
  assert.deepEqual(taskOperations("userSettingsResetAndRestart", { scope: "global", restartMode: "none" }), [
    "userSettingsResetGlobalGame",
    "userSettingsMaterializeCurrent"
  ]);
});

test("parses RedBlink vehicle-list output into vehicles and templates", () => {
  const output = `Sandbike
actor: /Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_Sandbike_CHOAM.BP_Sandbike_CHOAM_C
templates: T1_ExtraSeat, T2_Inventory, T3_Boost, T4_Scanner, T5, T6
Buggy
actor: /Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_Buggy_CHOAM.BP_Buggy_CHOAM_C
templates: T3_Inventory, T4_Boost, T5_Mining, T6_Combat
Tank
actor: /Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_Tank_CHOAM.BP_Tank_CHOAM_C
templates: T6_CombatFire, T6_CombatDart`;
  const vehicles = parseVehicleList(output);
  assert.equal(vehicles.length, 3);
  assert.equal(vehicles[0].id, "Sandbike");
  assert.match(vehicles[0].actor, /BP_Sandbike_CHOAM/);
  assert.deepEqual(vehicles[0].templates, ["T1_ExtraSeat", "T2_Inventory", "T3_Boost", "T4_Scanner", "T5", "T6"]);
  assert.deepEqual(vehicles[1].templates, ["T3_Inventory", "T4_Boost", "T5_Mining", "T6_Combat"]);
});

test("detects read-only SQL and requires explicit destructive allowance", () => {
  assert.equal(isReadOnlySql("select * from dune.player_state"), true);
  assert.equal(isReadOnlySql("with x as (select 1) select * from x"), true);
  assert.equal(isReadOnlySql("update dune.player_state set character_name = 'x'"), false);
  assert.deepEqual(buildDuneArgs("databaseQuery", { query: "select 1" }), ["database", "sql", "select 1"]);
  assert.throws(() => buildDuneArgs("databaseQuery", { query: "delete from dune.player_state" }));
  assert.deepEqual(buildDuneArgs("databaseQuery", { query: "delete from dune.player_state", allowDestructive: true }), ["database", "sql", "delete from dune.player_state"]);
  assert.throws(() => buildDuneArgs("databaseExport", { query: "delete from dune.player_state" }));
});

test("redacts token-like sensitive values", () => {
  const jwt = "eyJaaaaaaaaaaaaaaaaaaaaaaaa.eyJbbbbbbbbbbbbbbbbbbbbbbbb.cccccccccccccc";
  const text = `ServiceAuthToken=secret ${jwt} password: hunter2 runtime/secrets/funcom-token.txt`;
  const output = redact(text);
  assert.match(output, /<redacted>/);
  assert.doesNotMatch(output, /hunter2/);
  assert.doesNotMatch(output, /eyJaaaaaaaa/);
});
