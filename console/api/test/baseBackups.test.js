import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_BACKUP_NAME_MAX, BaseBackupError, BaseBackupTimeoutError, baseBackupHttpError, classifyTimeout, importBaseBackup,
  listBaseBackups, parseBaseBackupFile, updateBaseBackup, validateBaseBackupFile, validateBaseBackupName, versionComparison,
  checkBaseBackupDeletable, deleteBaseBackup, exportLiveBase, clientQueryTimeoutMs
} from "../src/baseBackups.js";
import { scopeAllowsAction } from "../src/apiKeyScopes.js";
import { parseAppManifestBuildId, readSteamBuildId, steamAppId } from "../src/services/steamBuild.js";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

function minimalFile(overrides = {}) {
  return {
    format: "dune-base-backup",
    version: 1,
    ownerPlaceholderTransferId: 1,
    game: { build: "2036754", patchesChecksum: "abc" },
    entries: [
      { id: 1, kind: "act", data: {} },
      { id: 2, kind: "act", data: { class: "BP_Totem_C" } },
      { id: 3, kind: "BaseBackup", data: { player_id: 1 } },
      { id: 4, kind: "BaseBackupLinkedActor", data: { id: 3, actor_id: 2 } },
      { id: 5, kind: "Totem", data: { id: 2 } }
    ],
    ...overrides
  };
}

function withEntries(mutate) {
  const file = minimalFile();
  mutate(file.entries);
  return file;
}

test("validateBaseBackupFile accepts a minimal well-formed export", () => {
  const result = validateBaseBackupFile(minimalFile());
  assert.equal(result.placeholderTransferId, 1);
  assert.equal(result.counts.act, 2);
});

test("validateBaseBackupFile rejects malformed or unsafe files", () => {
  const cases = [
    [null, /not a base backup export/],
    [[], /not a base backup export/],
    [minimalFile({ format: "blueprint" }), /unknown format/],
    [minimalFile({ version: 2 }), /Unsupported base backup file version 2/],
    [minimalFile({ entries: [] }), /has no entries/],
    [minimalFile({ ownerPlaceholderTransferId: undefined }), /owner placeholder/],
    [minimalFile({ ownerPlaceholderTransferId: 99 }), /owner placeholder/],
    [withEntries((e) => e.push({ id: 5, kind: "Totem", data: {} })), /repeats entry id 5/],
    [withEntries((e) => e.push({ id: 6, kind: "Character", data: {} })), /unsupported entry kind: Character/],
    [withEntries((e) => e.push({ id: 6, kind: "BaseBackup", data: {} })), /exactly one backup record/],
    [withEntries((e) => e.splice(4, 1)), /has no totem/],
    [withEntries((e) => { e[3].data.id = 99; }), /BaseBackupLinkedActor 4 id outside the base/],
    [withEntries((e) => { e[3].data.actor_id = 42; }), /BaseBackupLinkedActor 4 actor_id outside the base/],
    [withEntries((e) => e.push({ id: 6, kind: "act", data: {} })), /not part of the backup/],
    [withEntries((e) => { e[1].data = "x"; }), /has no data/],
    [withEntries((e) => { e[0].data = { class: "x" }; }), /owner placeholder carries data/],
    // References must stay inside the base: nothing may hang off the receiving player.
    [withEntries((e) => e.push({ id: 6, kind: "inv", data: { actor_id: 1 } })), /inv 6 actor_id at the receiving player/],
    [withEntries((e) => e.push({ id: 6, kind: "PermissionActorRank", data: { permission_actor_id: 1, player_id: 1 } })), /permission_actor_id at the receiving player/],
    [withEntries((e) => { e[4].data.id = 1; }), /Totem 5 id at the receiving player/],
    [withEntries((e) => { e[2].data.player_id = 2; }), /BaseBackup 3 player_id outside the base/],
    [withEntries((e) => e.push({ id: 6, kind: "itm", data: { inventory_id: 99 } })), /itm 6 inventory_id outside the base/],
    [withEntries((e) => e.push({ id: 6, kind: "Placeable", data: { id: 2, owner_entity_id: 77 } })), /Placeable 6 owner_entity_id outside the base/],
    [withEntries((e) => e.push({ id: 6, kind: "Totem", data: {} })), /missing Totem 6 id/],
    [withEntries((e) => e.push({ id: 6, kind: "inv", data: { actor_id: 2 } }, { id: 7, kind: "itm", data: { inventory_id: 6 } },
      { id: 8, kind: "bbp", data: { item_id: 7, player_id: 1 } })), /sets bbp 8 player_id/]
  ];
  for (const [file, pattern] of cases) {
    assert.throws(() => validateBaseBackupFile(file), (error) => {
      assert.ok(error instanceof BaseBackupError, `expected BaseBackupError for ${pattern}`);
      assert.match(error.message, pattern);
      return true;
    });
  }
  assert.throws(() => parseBaseBackupFile("{not json"), /could not be read as JSON/);
});

test("validateBaseBackupFile accepts the references a real export carries", () => {
  const file = withEntries((e) => e.push(
    { id: 6, kind: "fgl", data: { actor_id: 2 } },
    { id: 7, kind: "Placeable", data: { id: 2, owner_entity_id: 6 } },
    { id: 8, kind: "Placeable", data: { id: 2, owner_entity_id: null } },
    { id: 9, kind: "PermissionActor", data: { actor_id: 2 } },
    { id: 10, kind: "PermissionActorRank", data: { permission_actor_id: 2, player_id: 1 } },
    { id: 11, kind: "inv", data: { actor_id: 2 } },
    { id: 12, kind: "itm", data: { inventory_id: 11, stats: { Ref: "!!act@1" } } },
    { id: 13, kind: "bbp", data: { item_id: 12 } },
    { id: 14, kind: "BuildingBlueprintInstance", data: { building_blueprint_id: 13 } }
  ));
  assert.equal(validateBaseBackupFile(file).counts.Placeable, 2);
});

test("versionComparison caps what it copies from the file", () => {
  const detail = versionComparison({ patchesChecksum: "x".repeat(5000), build: "y".repeat(5000), steamBuildId: { nested: true } }, { patchesChecksum: "a" }, "1");
  assert.ok(detail.file.patchesChecksum.length <= 67);
  assert.ok(detail.file.build.length <= 67);
  assert.equal(typeof detail.file.steamBuildId, "string");
});

test("versionComparison flags a patches-checksum difference, not a build label alone", () => {
  assert.equal(versionComparison({ patchesChecksum: "a", build: "1" }, { patchesChecksum: "a" }, "2").mismatch, false);
  assert.equal(versionComparison({ patchesChecksum: "a" }, { patchesChecksum: "b" }, "1").mismatch, true);
  assert.equal(versionComparison({}, { patchesChecksum: "b" }, "1").mismatch, true);
  const detail = versionComparison({ patchesChecksum: "a", build: "1", appliedPatchesCount: 5 }, { patchesChecksum: "b", appliedPatchesCount: 6 }, "2");
  assert.deepEqual(detail.file, { build: "1", steamBuildId: null, patchesChecksum: "a", appliedPatchesCount: 5 });
  assert.deepEqual(detail.server, { build: "2", patchesChecksum: "b", appliedPatchesCount: 6 });
});

test("classifyTimeout tells server and client timeouts apart", () => {
  assert.equal(classifyTimeout({ code: "57014" }), "server_timeout");
  assert.equal(classifyTimeout(new Error("canceling statement due to statement timeout")), "server_timeout");
  assert.equal(classifyTimeout(new Error("Query read timeout")), "client_timeout");
  assert.equal(classifyTimeout(new Error("duplicate key value")), null);
});

test("BaseBackupTimeoutError names the step, the elapsed time and the limit", () => {
  const slow = new BaseBackupTimeoutError({ operation: "import", step: "inserting building pieces", kind: "server_timeout", elapsedMs: 15230, limitMs: 15000 });
  assert.equal(slow.message, "Base backup import timed out after 15.2s while inserting building pieces (limit 15s). Nothing was changed: the import was rolled back.");
  const fast = new BaseBackupTimeoutError({ operation: "export", step: "exporting stored items", kind: "client_timeout", elapsedMs: 61, limitMs: 60 });
  assert.equal(fast.message, "Base backup export timed out after 61ms while exporting stored items (limit 60ms). No file was produced.");
  assert.equal(fast.statusCode, 503);
  assert.equal(fast.code, "timeout");
});

test("baseBackupHttpError maps failures to the statuses and bodies the UI reads", () => {
  const timeout = baseBackupHttpError(new BaseBackupTimeoutError({ operation: "import", step: "loading the file", kind: "server_timeout", elapsedMs: 2000, limitMs: 1000 }));
  assert.equal(timeout.status, 503);
  assert.equal(timeout.body.code, "timeout");
  assert.equal(timeout.body.step, "loading the file");
  assert.equal(timeout.body.operation, "import");
  assert.equal(timeout.body.limitMs, 1000);
  assert.match(timeout.body.error, /Nothing was changed/);

  const mismatch = baseBackupHttpError(new BaseBackupError("different version", {
    statusCode: 409, code: "version_mismatch", details: { file: { build: "1" }, server: { build: "2" } }
  }));
  assert.deepEqual(mismatch, { status: 409, body: { ok: false, code: "version_mismatch", error: "different version", file: { build: "1" }, server: { build: "2" } } });

  assert.equal(baseBackupHttpError(Object.assign(new Error("nope"), { unsupported: true })).status, 501);
  assert.equal(baseBackupHttpError(Object.assign(new Error("Player not found"), { statusCode: 404 })).status, 404);
  assert.equal(baseBackupHttpError(new Error("Invalid player id")).status, 400);
  assert.equal(baseBackupHttpError(new Error("boom")).status, 500);
  assert.ok(baseBackupHttpError(new Error("x".repeat(50000))).body.error.length <= 1003);
});

// A fake db shaped like db.js: its transaction() rethrows a plain Error with
// only the message, exactly as db.js does, so the timeout classification is
// tested through the same information loss production has.
const SUMMARY_ROW = {
  id: 3, owner_controller_id: 10, owner_pawn_id: 11, owner_name: "Owner One", name: "Old Name",
  map: "DeepDesert", totem_type: "Totem_Small_Placeable", pieces: 24, placeables: 8, items: 13
};

const ALL_KINDS = ["act", "fgl", "inv", "itm", "bbp", "PermissionActor", "PermissionActorRank", "ActorInventory", "Building",
  "BuildingInstance", "Placeable", "Totem", "BaseBackup", "BaseBackupLinkedActor", "LandclaimSegment", "TaxInvoice", "Sinkchart",
  "BuildingBlueprintInstance", "BuildingBlueprintPlaceable", "BuildingBlueprintPentashield"];

function fakeDb({
  online = false, failOn = null, failWith = null, missingFunction = null, kinds = ALL_KINDS,
  // The row the edit transaction locks; null means the backup is gone.
  lockRow = { player_id: 10, name: "Old Name", owner_name: "Owner One", owner_status: "Offline", map: "DeepDesert" },
  maps = ["DeepDesert", "HaggaBasin"],
  leftAfterDelete = { backups: 0, links: 0 },
  // The live base a Bases row resolves to; null means none.
  liveBase = { totem_id: 200, entity_id: 6001, owner_id: 10, name: "Live Base", state: "Default", map: "HaggaBasin", totem_type: "Totem_Small_Placeable", owner_name: "Owner One" },
  // The same base as seen inside the export's snapshot, if it changed since.
  liveBaseInSnapshot = liveBase,
  columnRows = [
    { table_name: "building_instances", column_name: "transform", column_type: "real[]", is_array: true },
    { table_name: "building_instances", column_name: "last_placed_by_player_id", column_type: "bigint", is_array: false },
    { table_name: "actors", column_name: "partition_id", column_type: "bigint", is_array: false },
    { table_name: "actors", column_name: "state", column_type: "text", is_array: false }
  ]
} = {}) {
  const calls = { transaction: 0, txSql: [], txParams: [], txOptions: [] };
  const db = {
    calls,
    async query(sql, params = []) {
      if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ exists: params[0] !== missingFunction }] };
      if (sql.includes("to_regtype")) return { rows: [{ kinds }] };
      if (sql.includes("from dune.actors a") && sql.includes("player_state")) {
        return { rows: [{ actor_id: 21, account_id: 2, controller_id: 20, player_state_id: 1, online_status: online ? "Online" : "Offline" }] };
      }
      if (sql.includes("_get_patches_checksum")) return { rows: [{ checksum: "abc", patch_count: 3, latest: ["P3"] }] };
      if (sql.includes("from pg_attribute")) return { rows: columnRows };
      if (sql.includes("select distinct a.map")) return { rows: maps.map((map) => ({ map })) };
      if (sql.includes("coalesce(ps.online_status::text, 'Offline') as owner_status") && !sql.includes("for update")) {
        return { rows: lockRow ? [lockRow] : [] };
      }
      if (sql.includes("totem on true")) return { rows: [SUMMARY_ROW] };
      if (sql.includes("with base as")) return { rows: liveBase ? [liveBase] : [] };
      return { rows: [] };
    },
    async transaction(fn, options = {}) {
      calls.transaction++;
      calls.txOptions.push(options);
      const tx = {
        async query(sql, params = []) {
          calls.txSql.push(sql);
          calls.txParams.push(params);
          if (failOn && failOn(sql)) throw failWith;
          if (sql.includes("where kind = 'BaseBackup'")) return { rows: [{ id: 77 }] };
          if (sql.includes("for update of bb")) return { rows: lockRow ? [lockRow] : [] };
          if (sql.includes("update dune.actors a set map")) return { rows: [], rowCount: 9 };
          if (sql.includes("totem on true")) return { rows: [SUMMARY_ROW] };
          if (sql.includes("as links")) return { rows: [leftAfterDelete] };
          if (sql.includes("returning transfer_id")) return { rows: [{ transfer_id: 1 }] };
          if (sql.includes("select totem_id, owner_id, state from pg_temp.live_base")) return { rows: liveBaseInSnapshot ? [liveBaseInSnapshot] : [] };
          if (sql.includes("counting") || sql.includes("filter (where kind = 'BuildingInstance')")) return { rows: [{ pieces: 2, placeables: 3, items: 1 }] };
          if (sql.includes("jsonb_pretty")) return { rows: [{ text: "{}" }] };
          return { rows: [] };
        }
      };
      try {
        return await fn(tx);
      } catch (error) {
        throw new Error(error.message);
      }
    }
  };
  return db;
}

test("importBaseBackup refuses a version mismatch before touching the database", async () => {
  const db = fakeDb();
  const text = JSON.stringify(minimalFile({ game: { patchesChecksum: "other", build: "1" } }));
  await assert.rejects(importBaseBackup(db, 21, text, { serverBuild: "2" }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "version_mismatch");
    assert.equal(error.details.file.patchesChecksum, "other");
    assert.equal(error.details.server.patchesChecksum, "abc");
    return true;
  });
  assert.equal(db.calls.transaction, 0);

  const allowed = await importBaseBackup(db, 21, text, { allowVersionMismatch: true, serverBuild: "2" });
  assert.equal(allowed.backupId, 77);
  assert.match(allowed.warning, /version mismatch/);
});

test("importBaseBackup warns, but does not refuse, when the receiving player is online", async () => {
  const result = await importBaseBackup(fakeDb({ online: true }), 21, JSON.stringify(minimalFile()));
  assert.equal(result.ok, true);
  assert.equal(result.online, true);
  assert.match(result.warning, /online/);
});

test("importBaseBackup restores per-row array bounds, cast to the column's own type", async () => {
  const db = fakeDb();
  await importBaseBackup(db, 21, JSON.stringify(minimalFile()));
  const rebase = db.calls.txSql.find((sql) => sql.includes('set r."transform"') && sql.includes("::real[]"));
  assert.ok(rebase, "staged building pieces get their recorded bounds back, cast to real[]");
  assert.match(rebase, /where lb \? \$1 and \(lb ->> \$1\) in \('0', '1'\)/, "only a 0 or 1 bound from the file is applied");
  await assert.rejects(
    importBaseBackup(fakeDb({ columnRows: [{ table_name: "building_instances", column_name: "transform", column_type: "real[]; drop table x", is_array: true }] }), 21, JSON.stringify(minimalFile())),
    /Unexpected array column type/);
});

test("importBaseBackup forces imported actors out of any partition and remaps player ids", async () => {
  const db = fakeDb();
  await importBaseBackup(db, 21, JSON.stringify(minimalFile()));
  assert.ok(db.calls.txSql.some((sql) => sql.includes("r.partition_id = null") && sql.includes("r.state = 'BaseBackup'")));
  assert.ok(db.calls.txSql.some((sql) => sql.includes('r."last_placed_by_player_id" = case when')));
});

test("importBaseBackup reports a server-side statement timeout with the step that ran out", async () => {
  const db = fakeDb({
    failOn: (sql) => sql.includes("insert into dune.building_instances"),
    failWith: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
  });
  await assert.rejects(importBaseBackup(db, 21, JSON.stringify(minimalFile())), (error) => {
    assert.ok(error instanceof BaseBackupTimeoutError);
    assert.equal(error.details.step, "inserting building pieces");
    assert.equal(error.details.timeoutKind, "server_timeout");
    assert.equal(error.details.limitMs, 120000);
    assert.equal(baseBackupHttpError(error).status, 503);
    return true;
  });
});

test("importBaseBackup reports a client-side query timeout too", async () => {
  const db = fakeDb({ failOn: (sql) => sql.includes("_data_table_load"), failWith: new Error("Query read timeout") });
  await assert.rejects(importBaseBackup(db, 21, JSON.stringify(minimalFile())), (error) => {
    assert.ok(error instanceof BaseBackupTimeoutError);
    assert.equal(error.details.step, "loading the file");
    assert.equal(error.details.timeoutKind, "client_timeout");
    // The effective client bound for the transaction: statement timeout + margin.
    assert.equal(error.details.limitMs, clientQueryTimeoutMs());
    return true;
  });
});

test("importBaseBackup passes other database errors through unchanged", async () => {
  const db = fakeDb({ failOn: (sql) => sql.includes("insert into dune.totems"), failWith: new Error("duplicate key value") });
  await assert.rejects(importBaseBackup(db, 21, JSON.stringify(minimalFile())), (error) => {
    assert.equal(error instanceof BaseBackupTimeoutError, false);
    assert.match(error.message, /duplicate key value/);
    return true;
  });
});

test("an older game build without every entry kind reads as unsupported", async () => {
  const result = await listBaseBackups(fakeDb({ kinds: ALL_KINDS.filter((kind) => kind !== "Sinkchart") }));
  assert.equal(result.supported, false);
  assert.ok(result.missing.includes("dune._charactertransferentrykind 'Sinkchart'"));
});

test("listBaseBackups reports unsupported when any helper function is missing", async () => {
  const signature = "dune._character_transfer_data_table_save()";
  const result = await listBaseBackups(fakeDb({ missingFunction: signature }));
  assert.equal(result.supported, false);
  assert.deepEqual(result.rows, []);
  assert.ok(result.missing.includes(signature));
});

test("steam build id is read from the appmanifest and fails soft to null", async () => {
  assert.equal(parseAppManifestBuildId('"AppState"\n{\n\t"appid"\t\t"4754530"\n\t"buildid"\t\t"2036754"\n}'), "2036754");
  assert.equal(parseAppManifestBuildId("garbage"), null);
  assert.equal(steamAppId("/nonexistent", { STEAM_APP_ID: "123" }), "123");
  assert.equal(steamAppId("/nonexistent", {}), "4754530");

  const fakeSpawn = (code, output) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (output) child.stdout.emit("data", Buffer.from(output));
      child.emit("close", code);
    });
    return child;
  };
  assert.equal(await readSteamBuildId({ spawnImpl: fakeSpawn(0, '"buildid"  "999"'), useCache: false }), "999");
  assert.equal(await readSteamBuildId({ spawnImpl: fakeSpawn(1, ""), useCache: false }), null);
  assert.equal(await readSteamBuildId({ spawnImpl: () => { throw new Error("no docker"); }, useCache: false }), null);
});

test("base backup routes resolve to their own actions, and import is owner-only by default", () => {
  assert.equal(actionForRoute("/api/base-backups", "GET"), "bases:read");
  assert.equal(actionForRoute("/api/base-backups/7/export", "GET"), "bases:export-backup");
  assert.equal(actionForRoute("/api/base-backups/import", "POST"), "bases:import-backup");
  // Nothing else under the path resolves, so it fails closed.
  assert.equal(actionForRoute("/api/base-backups/7/items", "DELETE"), null);
  assert.equal(actionForRoute("/api/base-backups/7/export", "POST"), null);
  assert.equal(evaluate({ tier: "owner" }, "bases:import-backup"), true);
  for (const tier of ["admin", "moderator", "player", "observer"]) {
    assert.equal(evaluate({ tier }, "bases:import-backup"), false);
  }
  for (const tier of ["admin", "moderator"]) assert.equal(evaluate({ tier }, "bases:read"), true);
  for (const tier of ["player", "observer"]) assert.equal(evaluate({ tier }, "bases:read"), false);
  // A hand-authored policy granting bases:mutate must not gain import.
  const policies = { moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["bases:read", "bases:mutate"] }] } };
  assert.equal(evaluate({ tier: "moderator" }, "bases:import-backup", policies), false);
});

// Documented but not forwarded is the same as not configurable: the console
// container only sees what docker-compose.web.yml passes through.
test("the documented base backup statement timeout reaches the console container", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const compose = readFileSync(resolve(repoRoot, "docker-compose.web.yml"), "utf8");
  const envExample = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
  assert.match(compose, /^\s+ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS:\s+"\$\{ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS:-120000\}"$/m);
  assert.match(envExample, /^ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS=120000$/m);
});

test("validateBaseBackupName trims and enforces the game-safe rules", () => {
  assert.equal(validateBaseBackupName("  North Wall  "), "North Wall");
  assert.equal(validateBaseBackupName("x".repeat(BASE_BACKUP_NAME_MAX)).length, BASE_BACKUP_NAME_MAX);
  for (const [value, pattern] of [
    ["", /cannot be empty/],
    ["   ", /cannot be empty/],
    ["x".repeat(BASE_BACKUP_NAME_MAX + 1), /at most 23/],
    ["##Totem_Placeable", /cannot start with ##/],
    ["bad\nname", /control characters/]
  ]) {
    assert.throws(() => validateBaseBackupName(value), (error) => {
      assert.equal(error.code, "invalid_name");
      assert.equal(error.statusCode, 400);
      assert.match(error.message, pattern);
      return true;
    });
  }
});

test("updateBaseBackup renames and reassigns in one locked statement", async () => {
  const db = fakeDb();
  const result = await updateBaseBackup(db, 3, { ownerPlayerId: 21, name: "New Name" });
  assert.deepEqual(result.owner, { from: 10, fromName: "Owner One", to: 20 });
  assert.deepEqual(result.name, { from: "Old Name", to: "New Name" });
  assert.deepEqual(result.warnings, []);
  assert.ok(db.calls.txSql.some((sql) => sql.includes("for update of bb")), "the backup row is locked first");
  assert.ok(db.calls.txSql.some((sql) => sql.includes("update dune.base_backups")));
});

test("updateBaseBackup warns that an online new owner must relog", async () => {
  const result = await updateBaseBackup(fakeDb({ online: true }), 3, { ownerPlayerId: 21 });
  assert.match(result.warning, /new owner is online.*log out and back in/);
});

test("updateBaseBackup refuses while the current owner is online, and writes nothing", async () => {
  const db = fakeDb({ lockRow: { player_id: 10, name: "Old Name", owner_name: "Owner One", owner_status: "Online" } });
  await assert.rejects(updateBaseBackup(db, 3, { name: "New Name" }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "owner_online");
    assert.match(error.message, /Owner One is online\. They must log out/);
    return true;
  });
  assert.equal(db.calls.txSql.some((sql) => sql.includes("update dune.base_backups")), false);
});

test("updateBaseBackup reports a backup that was redeployed meanwhile as 404", async () => {
  await assert.rejects(updateBaseBackup(fakeDb({ lockRow: null }), 3, { name: "New Name" }), (error) => {
    assert.equal(error.statusCode, 404);
    assert.match(error.message, /no longer exists.*redeployed or recycled/);
    return true;
  });
});

test("updateBaseBackup needs a real change", async () => {
  await assert.rejects(updateBaseBackup(fakeDb(), 3, {}), (error) => error.code === "no_change");
  await assert.rejects(updateBaseBackup(fakeDb(), 3, { name: "Old Name" }), (error) => {
    assert.equal(error.code, "no_change");
    assert.equal(error.statusCode, 400);
    return true;
  });
});

test("base backup editing is owner-only and not carried by a bases write key", () => {
  assert.equal(actionForRoute("/api/base-backups/7", "PUT"), "bases:edit-backup");
  assert.equal(actionForRoute("/api/base-backups/import", "PUT"), null);
  assert.equal(evaluate({ tier: "owner" }, "bases:edit-backup"), true);
  for (const tier of ["admin", "moderator", "player", "observer"]) assert.equal(evaluate({ tier }, "bases:edit-backup"), false);
  assert.equal(scopeAllowsAction("bases", "write", "bases:edit-backup"), false);
  assert.equal(scopeAllowsAction("bases", ["bases:edit-backup"], "bases:edit-backup"), true);
});

test("updateBaseBackup moves a backup to another buildable map, clearing its partition", async () => {
  const db = fakeDb();
  const result = await updateBaseBackup(db, 3, { map: "HaggaBasin" });
  assert.deepEqual(result.map, { from: "DeepDesert", to: "HaggaBasin", actors: 9 });
  const move = db.calls.txSql.find((sql) => sql.includes("update dune.actors a set map"));
  assert.ok(move, "every linked actor is moved");
  assert.match(move, /partition_id = null/);
  assert.match(move, /base_backup_linked_actors where id = \$1/);
});

test("updateBaseBackup refuses a map no base can be built on, before any write", async () => {
  const db = fakeDb();
  await assert.rejects(updateBaseBackup(db, 3, { map: "Arrakeen" }), (error) => {
    assert.equal(error.code, "invalid_map");
    assert.equal(error.statusCode, 400);
    assert.deepEqual(error.details.maps, ["DeepDesert", "HaggaBasin"]);
    return true;
  });
  assert.equal(db.calls.transaction, 0);
  // The same map is not a change.
  await assert.rejects(updateBaseBackup(fakeDb(), 3, { map: "DeepDesert" }), (error) => error.code === "no_change");
});

test("deleteBaseBackup deletes through the game's own function and reports what went", async () => {
  const db = fakeDb();
  const result = await deleteBaseBackup(db, 3);
  assert.deepEqual(result, {
    ok: true, backupId: 3, name: "Old Name", ownerName: "Owner One", map: "DeepDesert",
    counts: { pieces: 24, placeables: 8, items: 13 }
  });
  const order = db.calls.txSql.map((sql) => (sql.includes("for update of bb") ? "lock"
    : sql.includes("base_backup_delete") ? "delete" : sql.includes("as links") ? "verify" : null)).filter(Boolean);
  assert.deepEqual(order, ["lock", "delete", "verify"]);
});

test("deleteBaseBackup rolls back if anything of the backup is left behind", async () => {
  await assert.rejects(deleteBaseBackup(fakeDb({ leftAfterDelete: { backups: 0, links: 2 } }), 3), /was not fully deleted; nothing was changed/);
});

test("deleteBaseBackup refuses while the owner is online, and for a backup that is gone", async () => {
  const online = fakeDb({ lockRow: { owner_name: "Owner One", owner_status: "Online" } });
  await assert.rejects(deleteBaseBackup(online, 3), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "owner_online");
    assert.match(error.message, /must log out before this backup can be deleted/);
    return true;
  });
  assert.equal(online.calls.txSql.some((sql) => sql.includes("base_backup_delete")), false);
  await assert.rejects(deleteBaseBackup(fakeDb({ lockRow: null }), 3), (error) => error.statusCode === 404);
  // The route's fast pre-check, run before the safety backup, says the same
  // without opening a transaction.
  const precheck = fakeDb({ lockRow: { owner_name: "Owner One", owner_status: "Online" } });
  await assert.rejects(checkBaseBackupDeletable(precheck, 3), (error) => error.code === "owner_online");
  assert.equal(precheck.calls.transaction, 0);
});

test("backup changes wait for every non-offline owner state", async () => {
  for (const owner_status of ["LoggingIn", "LoggingOut"]) {
    const edit = fakeDb({ lockRow: { owner_name: "Owner One", owner_status } });
    await assert.rejects(updateBaseBackup(edit, 3, { name: "New Name" }), (error) => {
      assert.equal(error.code, "owner_online");
      return true;
    });

    const deletion = fakeDb({ lockRow: { owner_name: "Owner One", owner_status } });
    await assert.rejects(deleteBaseBackup(deletion, 3), (error) => {
      assert.equal(error.code, "owner_online");
      return true;
    });
    assert.equal(deletion.calls.txSql.some((sql) => sql.includes("base_backup_delete")), false);
  }
});

test("deleting needs the game's base_backup_delete function", async () => {
  await assert.rejects(deleteBaseBackup(fakeDb({ missingFunction: "dune.base_backup_delete(bigint)" }), 3), (error) => {
    assert.equal(error.unsupported, true);
    assert.equal(baseBackupHttpError(error).status, 501);
    return true;
  });
});

test("deleting a backup is its own owner-only action", () => {
  assert.equal(actionForRoute("/api/base-backups/7", "DELETE"), "bases:delete-backup");
  assert.equal(actionForRoute("/api/base-backups/import", "DELETE"), null);
  assert.equal(evaluate({ tier: "owner" }, "bases:delete-backup"), true);
  for (const tier of ["admin", "moderator", "player", "observer"]) assert.equal(evaluate({ tier }, "bases:delete-backup"), false);
  assert.equal(scopeAllowsAction("bases", "write", "bases:delete-backup"), false);
  assert.equal(scopeAllowsAction("bases", ["bases:delete-backup"], "bases:delete-backup"), true);
});

test("exportLiveBase only reads: every write goes to its own temp tables", async () => {
  const db = fakeDb();
  const { summary } = await exportLiveBase(db, 201, { gameBuild: "1" });
  assert.equal(summary.name, "Live Base");
  const writes = db.calls.txSql.filter((sql) => /\b(insert\s+into|update|delete\s+from|truncate)\s+(?!pg_temp\.)/i.test(sql));
  assert.deepEqual(writes, []);
  assert.equal(db.calls.txSql.some((sql) => /for\s+(update|share)/i.test(sql)), false);
  assert.match(db.calls.txSql[0], /repeatable read/);
});

test("an export transaction's client query timeout sits above the statement timeout, not at the pool's 15 s", async () => {
  const saved = process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS;
  try {
    delete process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS;
    const db = fakeDb();
    await exportLiveBase(db, 201, { gameBuild: "1" });
    // The server cancels first (120 s) so the failure is classified as a server
    // timeout; the client bound must never be the pool's 15 s default.
    assert.equal(db.calls.txOptions.length, 1);
    assert.equal(db.calls.txOptions[0].queryTimeoutMs, 130000);
    assert.equal(clientQueryTimeoutMs(), 130000);
    process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS = "600000";
    assert.equal(clientQueryTimeoutMs(), 610000);
  } finally {
    if (saved === undefined) delete process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS;
    else process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS = saved;
  }
});

test("exportLiveBase exports what a pickup would take, not the live base's extras", async () => {
  const db = fakeDb();
  await exportLiveBase(db, 201);
  const step = (kind) => db.calls.txSql.filter((sql) => sql.includes(`'${kind}', dune._character_transfer_top_level_export`));
  // The totem's own permissions and invoices are destroyed by a pickup.
  assert.equal(step("TaxInvoice").length, 0);
  assert.match(step("PermissionActor")[0], /actor_id <> \(select totem_id from pg_temp\.live_base\)/);
  assert.match(step("PermissionActorRank")[0], /permission_actor_id <> \(select totem_id from pg_temp\.live_base\)/);
  // The owner is the game's rank-1 owner, and the totem choice is stable.
  const findTotem = db.calls.txSql.find((sql) => sql.includes("create temporary table live_base on commit drop"));
  assert.match(findTotem, /par\.rank = 1/);
  assert.match(findTotem, /order by t\.id\s+limit 1/);
  // Every actor as a pickup leaves it.
  assert.match(step("act")[0], /jsonb_build_object\('state', 'BaseBackup'\)/);
  // Only the pieces the totem owns; building actors fresh, with no entity.
  assert.match(step("BuildingInstance")[0], /owner_entity_id = \(select entity_id from pg_temp\.live_base\)/);
  assert.match(step("act")[0], /'properties', '\{\}'::jsonb/);
  assert.match(step("fgl")[0], /actor_id not in \(select b\.id from dune\.buildings b\)/);
  // The backup record and links are built from the live base.
  assert.match(step("BaseBackup")[0], /'last_edited_by_player_id', 0/);
  assert.equal(step("BaseBackupLinkedActor").length, 1);
  // The owner placeholder is the owner's own id; the file says what it is.
  const placeholderIndex = db.calls.txSql.findIndex((sql) => sql.includes("returning transfer_id"));
  assert.deepEqual(db.calls.txParams[placeholderIndex], [10]);
  const envelope = JSON.parse(db.calls.txParams.at(-1)[0]);
  assert.deepEqual({ kind: envelope.source.kind, baseId: envelope.source.baseId, backupId: envelope.source.backupId, counts: envelope.source.counts },
    { kind: "live-base", baseId: 201, backupId: null, counts: { pieces: 2, placeables: 3, items: 1 } });
});

test("exportLiveBase refuses a picked-up, unknown or ownerless base before the export starts", async () => {
  const pickedUp = fakeDb({ liveBase: { totem_id: 200, owner_id: 10, state: "BaseBackup" } });
  await assert.rejects(exportLiveBase(pickedUp, 201), (error) => {
    assert.equal(baseBackupHttpError(error).status, 409);
    assert.equal(error.code, "picked_up");
    assert.match(error.message, /Export it from Base Backups instead/);
    return true;
  });
  const ownerless = fakeDb({ liveBase: { totem_id: 200, owner_id: null, state: "Default" } });
  await assert.rejects(exportLiveBase(ownerless, 201), (error) => error.code === "no_owner" && /as a blueprint instead/.test(error.message));
  const missing = fakeDb({ liveBase: null });
  await assert.rejects(exportLiveBase(missing, 201), (error) => baseBackupHttpError(error).status === 404);
  for (const db of [pickedUp, ownerless, missing]) assert.equal(db.calls.transaction, 0);
});

test("exportLiveBase refuses a base that was picked up after the pre-check, with the same 409", async () => {
  const db = fakeDb({ liveBaseInSnapshot: { totem_id: 200, owner_id: 10, state: "BaseBackup" } });
  await assert.rejects(exportLiveBase(db, 201), (error) => {
    assert.equal(baseBackupHttpError(error).status, 409);
    assert.equal(error.code, "picked_up");
    return true;
  });
  // The export stopped before collecting anything.
  assert.equal(db.calls.txSql.some((sql) => sql.includes("create temporary table live_base_actors")), false);
});

test("downloading a base backup file, live or picked up, is its own owner-only action", () => {
  assert.equal(actionForRoute("/api/bases/201/export-backup", "GET"), "bases:export-backup");
  assert.equal(actionForRoute("/api/bases/abc/export-backup", "GET"), "bases:export-backup");
  assert.equal(actionForRoute("/api/base-backups/7/export", "GET"), "bases:export-backup");
  // The blueprint download stays a read.
  assert.equal(actionForRoute("/api/bases/201/export", "GET"), "bases:read");
  assert.equal(evaluate({ tier: "owner" }, "bases:export-backup"), true);
  for (const tier of ["admin", "moderator", "player", "observer"]) {
    assert.equal(evaluate({ tier }, "bases:export-backup"), false, `${tier} must not download base backups`);
  }
  // A hand-authored policy granting bases:read is not consent to it.
  const policies = { moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["bases:read"] }] } };
  assert.equal(evaluate({ tier: "moderator" }, "bases:export-backup", policies), false);
});
