import test from "node:test";
import assert from "node:assert/strict";
import { setVehiclePermissions, listVehiclePermissions, transferVehicleToSystemCustodian, permissionSystemCustodian } from "../src/duneDb.js";

const SUPPORTED_TABLES = ["dune.permission_actor_rank", "dune.permission_actor", "dune.actors", "dune.player_state", "dune.encrypted_player_state", "dune.map_names"];
const SUPPORTED_FUNCTIONS = [
  "dune.permission_set_player_rank(bigint,bigint,smallint,text)",
  "dune.permission_remove_player_rank(bigint,bigint)"
];

// Unlike a base, a vehicle IS its own permission actor: dune.vehicles.id =
// dune.actors.id. So the id shown and the actor id are the same here, not two
// different numbers the way BASE_ID/ACTOR_ID differ in basePermissions.test.js.
const VEHICLE_ID = 2048;
const ACTOR_ID = "2048";

function createDb({
  existing = [],
  canonicalPlayers = ["4", "23", "29", "437", "900000201"],
  mapNameId = 7,
  // Whether dune.permission_actor holds a row for this vehicle's actor.
  // False mirrors an unclaimed vehicle: the vehicle and actor rows are intact,
  // nothing for permission_actor_rank's foreign key to point at.
  claimed = true,
  // "missing" mirrors a vehicle id that does not exist at all -- including a
  // base's actor id passed to this route by mistake, since dune.vehicles has
  // no row for it either.
  vehicles = "found",
  custodians = [{ player_id: "900000201", character_name: "Server" }],
  systemIdentities = [{ table: "player_state", accountId: "9000002", playerId: "900000201" }]
} = {}) {
  const calls = [];
  const db = {
    calls,
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: SUPPORTED_TABLES.includes(String(values[0] || "")) }] };
      }
      if (text.includes("to_regprocedure")) {
        return { rows: [{ exists: SUPPORTED_FUNCTIONS.includes(String(values[0] || "")) }] };
      }
      if (text.includes("information_schema.columns")) {
        const table = String(values[1] || "");
        const columns = table === "player_state" || table === "encrypted_player_state"
          ? ["account_id", "player_controller_id", "player_state_id", "player_pawn_id", table === "player_state" ? "character_name" : "encrypted_character_name"]
          : [];
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (text.includes("from dune.vehicles v")) {
        if (vehicles === "missing") return { rows: [] };
        return { rows: [{ actor_id: ACTOR_ID, map: "DeepDesert", map_name_id: mapNameId, partition_id: 59 }] };
      }
      if (text.includes("for update")) return { rows: [{ id: ACTOR_ID }], rowCount: 1 };
      if (text.includes("from dune.permission_actor where actor_id")) return { rows: [{ claimed }] };
      if (text.includes("from dune.permission_actor_rank")) {
        return { rows: existing.map((entry) => ({ player_id: entry.playerId, rank: entry.rank })) };
      }
      if (text.includes("player_controller_id = any")) {
        const requested = values[0] || [];
        return { rows: requested.filter((id) => canonicalPlayers.includes(String(id))).map((id) => ({ player_id: String(id) })) };
      }
      if (text.includes("account_id = $1::bigint") && text.includes("player_controller_id = $2::bigint")) {
        const table = text.includes("dune.encrypted_player_state") ? "encrypted_player_state" : "player_state";
        return {
          rows: systemIdentities
            .filter((identity) => identity.table === table && identity.accountId === String(values[0]) && identity.playerId === String(values[1]))
            .map((identity) => ({ player_id: identity.playerId }))
        };
      }
      if (text.includes("lower(btrim(coalesce(ps.character_name")) return { rows: custodians };
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };
  return db;
}

function procCalls(db, name) {
  return db.calls.filter((call) => call.text.includes(name)).map((call) => call.values);
}

test("setVehiclePermissions rejects a roster without exactly one owner", async () => {
  await assert.rejects(
    () => setVehiclePermissions(createDb(), VEHICLE_ID, [{ playerId: "4", rank: 2 }]),
    /exactly one Owner/);
  await assert.rejects(
    () => setVehiclePermissions(createDb(), VEHICLE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 1 }]),
    /only have one Owner/);
});

test("setVehiclePermissions rejects invalid ranks and duplicate players", async () => {
  await assert.rejects(
    () => setVehiclePermissions(createDb(), VEHICLE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 4 }]),
    /not a valid vehicle permission rank/);
  await assert.rejects(
    () => setVehiclePermissions(createDb(), VEHICLE_ID, [{ playerId: "4", rank: 1 }, { playerId: "4", rank: 3 }]),
    /listed twice/);
});

// The cap comes from live server config, so it arrives as an argument rather
// than a constant. Passing a small one proves it is actually enforced.
test("setVehiclePermissions enforces the configured cap", async () => {
  await assert.rejects(
    () => setVehiclePermissions(createDb(), VEHICLE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }], 1),
    /above the configured maximum of 1/);
});

test("setVehiclePermissions refuses a player id that is not a player_controller_id", async () => {
  await assert.rejects(
    () => setVehiclePermissions(createDb({ canonicalPlayers: ["4"] }), VEHICLE_ID, [
      { playerId: "4", rank: 1 },
      { playerId: "5", rank: 3 }
    ]),
    /not a known player character/);
});

test("setVehiclePermissions refuses a vehicle whose map has no map_names entry", async () => {
  await assert.rejects(
    () => setVehiclePermissions(createDb({ mapNameId: 0 }), VEHICLE_ID, [{ playerId: "4", rank: 1 }]),
    /no dune.map_names entry/);
});

test("listVehiclePermissions rejects a vehicle id that does not exist", async () => {
  await assert.rejects(
    () => listVehiclePermissions(createDb({ vehicles: "missing" }), 999999),
    /That vehicle was not found/);
});

// A base's actor id has no row in dune.vehicles, so the join that resolves
// vehiclePermissionActor finds nothing for it -- the same "not found" path a
// genuinely nonexistent id takes. This is the regression guard for the class
// of id-confusion bug fixed in 25818bb7.
test("setVehiclePermissions rejects a base's actor id passed as a vehicle id", async () => {
  const db = createDb({ vehicles: "missing" });
  await assert.rejects(
    () => setVehiclePermissions(db, 1004, [{ playerId: "4", rank: 1 }]),
    /That vehicle was not found/);
  assert.equal(procCalls(db, "permission_set_player_rank").length, 0);
});

test("setVehiclePermissions refuses an unclaimed vehicle instead of failing the permission_actor foreign key", async () => {
  const db = createDb({ claimed: false });
  await assert.rejects(
    () => setVehiclePermissions(db, VEHICLE_ID, [{ playerId: "4", rank: 1 }]),
    /not claimed/);
  assert.equal(procCalls(db, "permission_set_player_rank").length, 0);
  assert.equal(procCalls(db, "permission_remove_player_rank").length, 0);
});

// Reading stays allowed -- an empty roster plus the flag is how an operator
// diagnoses the vehicle, and the editor uses the flag to disable its controls.
test("listVehiclePermissions reports an unclaimed vehicle rather than rejecting it", async () => {
  const claimedResult = await listVehiclePermissions(createDb(), VEHICLE_ID);
  assert.equal(claimedResult.claimed, true);
  assert.equal(claimedResult.unclaimedReason, "");

  const result = await listVehiclePermissions(createDb({ claimed: false }), VEHICLE_ID);
  assert.equal(result.claimed, false);
  assert.match(result.unclaimedReason, /not claimed/);
});

test("setVehiclePermissions writes through the shipped procedures, never raw DML", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }] });
  await setVehiclePermissions(db, VEHICLE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }]);
  const written = db.calls.filter((call) => /insert into|update .*permission_actor_rank|delete from/i.test(call.text));
  assert.deepEqual(written, [], "permission rows must only be written by the game's own procedures");
  assert.equal(procCalls(db, "permission_set_player_rank").length, 1);
});

test("setVehiclePermissions passes the numeric map_name_id to the notify payload", async () => {
  const db = createDb({ existing: [] });
  await setVehiclePermissions(db, VEHICLE_ID, [{ playerId: "4", rank: 1 }]);
  const [values] = procCalls(db, "permission_set_player_rank");
  // Not "DeepDesert": the procedure interpolates this unquoted into JSON.
  assert.equal(values[3], "7");
});

test("setVehiclePermissions skips unchanged rows", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "29", rank: 2 }] });
  const result = await setVehiclePermissions(db, VEHICLE_ID, [{ playerId: "4", rank: 1 }, { playerId: "29", rank: 2 }]);
  assert.equal(procCalls(db, "permission_set_player_rank").length, 0);
  assert.equal(procCalls(db, "permission_remove_player_rank").length, 0);
  assert.equal(result.added, 0);
  assert.equal(result.reranked, 0);
  assert.equal(result.removed, 0);
});

test("setVehiclePermissions demotes the outgoing owner before promoting the new one", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }] });
  await setVehiclePermissions(db, VEHICLE_ID, [{ playerId: "23", rank: 1 }, { playerId: "4", rank: 2 }]);
  const ranks = procCalls(db, "permission_set_player_rank").map((values) => ({ playerId: String(values[1]), rank: values[2] }));
  assert.deepEqual(ranks, [{ playerId: "4", rank: 2 }, { playerId: "23", rank: 1 }]);
});

test("setVehiclePermissions removes dropped players before writing the owner", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }] });
  const result = await setVehiclePermissions(db, VEHICLE_ID, [{ playerId: "29", rank: 1 }]);
  const order = db.calls
    .filter((call) => /permission_remove_player_rank|permission_set_player_rank/.test(call.text))
    .map((call) => call.text.includes("remove") ? "remove" : "set");
  assert.deepEqual(order, ["remove", "remove", "set"]);
  assert.equal(result.removed, 2);
  assert.equal(result.added, 1);
});

test("setVehiclePermissions pins search_path for the transaction", async () => {
  const db = createDb({ existing: [] });
  await setVehiclePermissions(db, VEHICLE_ID, [{ playerId: "4", rank: 1 }]);
  assert.ok(db.calls.some((call) => /set local search_path to dune/.test(call.text)));
});

// The lock has to be on a row guaranteed to exist. A vehicle whose roster is
// being fully replaced may have no rank rows, and `for update` over zero rows
// serializes nothing at all.
test("setVehiclePermissions locks the actor row, not the rank rows", async () => {
  const db = createDb({ existing: [] });
  await setVehiclePermissions(db, VEHICLE_ID, [{ playerId: "4", rank: 1 }]);
  const lock = db.calls.find((call) => call.text.includes("for update"));
  assert.match(lock.text, /from dune\.actors/);
  assert.deepEqual(lock.values, [ACTOR_ID]);
});

test("transferVehicleToSystemCustodian preserves access, demotes the owner, and promotes Server last", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "29", rank: 2 }] });
  const result = await transferVehicleToSystemCustodian(db, VEHICLE_ID);
  const ranks = procCalls(db, "permission_set_player_rank").map((values) => ({ playerId: String(values[1]), rank: values[2] }));
  assert.deepEqual(ranks, [
    { playerId: "4", rank: 2 },
    { playerId: "900000201", rank: 1 }
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.systemCustodian.playerId, "900000201");
  assert.match(result.message, /Server system custodian/);
});

test("transferVehicleToSystemCustodian requires provisioning for a missing Server and refuses ambiguity", async () => {
  await assert.rejects(
    () => transferVehicleToSystemCustodian(createDb({ custodians: [], systemIdentities: [] }), VEHICLE_ID),
    /will be created when ownership is transferred/);
  await assert.rejects(
    () => transferVehicleToSystemCustodian(createDb({ systemIdentities: [
      { table: "player_state", accountId: "9000002", playerId: "900000201" },
      { table: "player_state", accountId: "9000002", playerId: "900000201" }
    ] }), VEHICLE_ID),
    /More than one/);
});

test("transferVehicleToSystemCustodian accepts GM from encrypted_player_state", async () => {
  const db = createDb({
    existing: [{ playerId: "4", rank: 1 }],
    canonicalPlayers: ["4", "900000101"],
    custodians: [],
    systemIdentities: [{ table: "encrypted_player_state", accountId: "9000001", playerId: "900000101" }]
  });
  const result = await transferVehicleToSystemCustodian(db, VEHICLE_ID);
  assert.equal(result.systemCustodian.name, "GM");
  assert.match(result.message, /GM system custodian/);
  assert.deepEqual(procCalls(db, "permission_set_player_rank").map((values) => [String(values[1]), values[2]]), [
    ["4", 2],
    ["900000101", 1]
  ]);
});

test("transferVehicleToSystemCustodian refuses an unclaimed vehicle", async () => {
  const db = createDb({ claimed: false });
  await assert.rejects(() => transferVehicleToSystemCustodian(db, VEHICLE_ID), /not claimed/);
  assert.equal(procCalls(db, "permission_set_player_rank").length, 0);
});

test("transferVehicleToSystemCustodian rejects a base's actor id passed as a vehicle id", async () => {
  const db = createDb({ vehicles: "missing" });
  await assert.rejects(() => transferVehicleToSystemCustodian(db, 1004), /That vehicle was not found/);
  assert.equal(procCalls(db, "permission_set_player_rank").length, 0);
});

test("listVehiclePermissions returns systemCustodian", async () => {
  const result = await listVehiclePermissions(createDb(), VEHICLE_ID);
  assert.deepEqual(result.systemCustodian, { available: true, playerId: "900000201", name: "Server" });
});

test("listVehiclePermissions labels ranks and flags rows the game ignores", async () => {
  const db = createDb();
  db.query = async (text, values = []) => {
    if (text.includes("to_regclass")) return { rows: [{ exists: SUPPORTED_TABLES.includes(String(values[0] || "")) }] };
    if (text.includes("to_regprocedure")) return { rows: [{ exists: SUPPORTED_FUNCTIONS.includes(String(values[0] || "")) }] };
    if (text.includes("from dune.vehicles v")) {
      return { rows: [{ actor_id: ACTOR_ID, map: "DeepDesert", map_name_id: 7, partition_id: 59 }] };
    }
    if (text.includes("from dune.permission_actor where actor_id")) return { rows: [{ claimed: true }] };
    return { rows: [
      { player_id: "4", character_name: "DarkShark", rank: 1, canonical: true },
      { player_id: "29", character_name: "Yaida", rank: 2, canonical: true },
      { player_id: "5", character_name: "DarkShark", rank: 3, canonical: false }
    ] };
  };
  const result = await listVehiclePermissions(db, VEHICLE_ID);
  assert.equal(result.actorId, ACTOR_ID);
  assert.deepEqual(result.entries.map((entry) => entry.label), ["Owner", "Co-Owner", "Associate"]);
  assert.deepEqual(result.entries.map((entry) => entry.canonical), [true, true, false]);
});
