import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setBasePermissions, listBasePermissions, permissionSystemCustodian, transferBaseToSystemCustodian, listBaseChildAccess, setBaseChildAccessLevels, queueBaseChildAccess, listQueuedBaseChildAccess, cancelQueuedBaseChildAccess, flushBaseChildAccess, hasQueuedBaseChildAccess } from "../src/duneDb.js";

const SUPPORTED_TABLES = ["dune.permission_actor_rank", "dune.permission_actor", "dune.actors", "dune.player_state", "dune.encrypted_player_state", "dune.map_names"];
const SUPPORTED_FUNCTIONS = [
  "dune.permission_set_player_rank(bigint,bigint,smallint,text)",
  "dune.permission_remove_player_rank(bigint,bigint)"
];

// The displayed base_id and the permission actor id are deliberately different
// here, mirroring production where they differ for every base.
const BASE_ID = 1006;
const ACTOR_ID = "1004";

function createDb({
  existing = [],
  canonicalPlayers = ["4", "23", "29", "437", "900000201"],
  mapNameId = 7,
  // Whether dune.permission_actor holds a row for this base's claim actor.
  // False mirrors an unclaimed base: every structural row intact, nothing for
  // permission_actor_rank's foreign key to point at.
  claimed = true,
  buildings = "found",
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
      if (text.includes("from dune.buildings b")) {
        // "missing" mirrors a base id that does not exist at all; "orphaned"
        // mirrors building_instances.owner_entity_id being null (it is
        // nullable, ON DELETE SET NULL against fgl_entities) so the left-join
        // chain resolves the buildings row but not down to an actor.
        if (buildings === "missing") return { rows: [] };
        // Matches the real query's coalesce(...) wrapping: a genuine orphaned
        // row never comes back with literal nulls for these three fields.
        if (buildings === "orphaned") return { rows: [{ actor_id: null, map: "", map_name_id: 0, partition_id: 0 }] };
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

test("setBasePermissions rejects a roster without exactly one owner", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 2 }]),
    /exactly one Owner/);
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 1 }]),
    /only have one Owner/);
});

test("setBasePermissions rejects invalid ranks and duplicate players", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 4 }]),
    /not a valid base permission rank/);
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "4", rank: 3 }]),
    /listed twice/);
});

// The cap comes from live server config, so it arrives as an argument rather
// than a constant. Passing a small one proves it is actually enforced.
test("setBasePermissions enforces the configured cap", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb(), BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }], 1),
    /above the configured maximum of 1/);
});

// A rank row written against a non-canonical actor id is accepted by the shipped
// procedure and then ignored by the game -- confirmed live. Catching it here is
// the difference between a no-op that looks successful and a clear error.
test("setBasePermissions refuses a player id that is not a player_controller_id", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb({ canonicalPlayers: ["4"] }), BASE_ID, [
      { playerId: "4", rank: 1 },
      { playerId: "5", rank: 3 }
    ]),
    /not a known player character/);
});

test("setBasePermissions refuses a base whose map has no map_names entry", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb({ mapNameId: 0 }), BASE_ID, [{ playerId: "4", rank: 1 }]),
    /no dune.map_names entry/);
});

test("listBasePermissions rejects a base id that does not exist", async () => {
  await assert.rejects(
    () => listBasePermissions(createDb({ buildings: "missing" }), 999999),
    /That base was not found/);
});

test("listBasePermissions surfaces a clear error when the base's owner-entity link is broken", async () => {
  await assert.rejects(
    () => listBasePermissions(createDb({ buildings: "orphaned" }), BASE_ID),
    /no resolvable owner entity/);
});

test("setBasePermissions surfaces a clear error when the base's owner-entity link is broken", async () => {
  await assert.rejects(
    () => setBasePermissions(createDb({ buildings: "orphaned" }), BASE_ID, [{ playerId: "4", rank: 1 }]),
    /no resolvable owner entity/);
});

// permission_actor_rank.permission_actor_id has a foreign key against
// permission_actor(actor_id). An unclaimed base keeps every structural row the
// actor resolution walks -- buildings, building_instances, actor_fgl_entities,
// actors -- and has no permission_actor row, so the shipped procedure's insert
// used to fail the constraint and surface the raw PostgreSQL text to the
// operator. The write must never reach the procedure at all.
test("setBasePermissions refuses an unclaimed base instead of failing the permission_actor foreign key", async () => {
  const db = createDb({ claimed: false });
  await assert.rejects(
    () => setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }]),
    /not claimed/);
  assert.equal(procCalls(db, "permission_set_player_rank").length, 0);
  assert.equal(procCalls(db, "permission_remove_player_rank").length, 0);
});

// The Transfer button is the shortest path into this: an unclaimed base renders
// "No Owner set", which is exactly the state the transfer exists to resolve.
test("transferBaseToSystemCustodian refuses an unclaimed base", async () => {
  const db = createDb({ claimed: false });
  await assert.rejects(
    () => transferBaseToSystemCustodian(db, BASE_ID),
    /not claimed/);
  assert.equal(procCalls(db, "permission_set_player_rank").length, 0);
});

// Reading stays allowed -- an empty roster plus the flag is how an operator
// diagnoses the base, and the editor uses the flag to disable its controls.
test("listBasePermissions reports an unclaimed base rather than rejecting it", async () => {
  const claimedResult = await listBasePermissions(createDb(), BASE_ID);
  assert.equal(claimedResult.claimed, true);
  assert.equal(claimedResult.unclaimedReason, "");

  const result = await listBasePermissions(createDb({ claimed: false }), BASE_ID);
  assert.equal(result.claimed, false);
  assert.match(result.unclaimedReason, /not claimed/);
});

test("setBasePermissions writes through the shipped procedures, never raw DML", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }]);
  const written = db.calls.filter((call) => /insert into|update .*permission_actor_rank|delete from/i.test(call.text));
  assert.deepEqual(written, [], "permission rows must only be written by the game's own procedures");
  assert.equal(procCalls(db, "permission_set_player_rank").length, 1);
});

test("setBasePermissions passes the numeric map_name_id to the notify payload", async () => {
  const db = createDb({ existing: [] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }]);
  const [values] = procCalls(db, "permission_set_player_rank");
  // Not "DeepDesert": the procedure interpolates this unquoted into JSON.
  assert.equal(values[3], "7");
});

test("setBasePermissions skips unchanged rows", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "29", rank: 2 }] });
  const result = await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }, { playerId: "29", rank: 2 }]);
  assert.equal(procCalls(db, "permission_set_player_rank").length, 0);
  assert.equal(procCalls(db, "permission_remove_player_rank").length, 0);
  assert.equal(result.added, 0);
  assert.equal(result.reranked, 0);
  assert.equal(result.removed, 0);
});

// The marker refresh inside permission_set_player_rank resolves the owner with a
// LIMIT 1 over rank-1 rows, so a moment with two owners could stamp the wrong
// name onto the base marker. The outgoing owner must be demoted first.
test("setBasePermissions demotes the outgoing owner before promoting the new one", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "23", rank: 1 }, { playerId: "4", rank: 2 }]);
  const ranks = procCalls(db, "permission_set_player_rank").map((values) => ({ playerId: String(values[1]), rank: values[2] }));
  assert.deepEqual(ranks, [{ playerId: "4", rank: 2 }, { playerId: "23", rank: 1 }]);
});

test("setBasePermissions removes dropped players before writing the owner", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "23", rank: 3 }] });
  const result = await setBasePermissions(db, BASE_ID, [{ playerId: "29", rank: 1 }]);
  const order = db.calls
    .filter((call) => /permission_remove_player_rank|permission_set_player_rank/.test(call.text))
    .map((call) => call.text.includes("remove") ? "remove" : "set");
  assert.deepEqual(order, ["remove", "remove", "set"]);
  assert.equal(result.removed, 2);
  assert.equal(result.added, 1);
});

// The procedures resolve their own unqualified table names through search_path,
// which works only because the console connects as the `dune` role. Setting it
// explicitly keeps the feature working if that ever changes.
test("setBasePermissions pins search_path for the transaction", async () => {
  const db = createDb({ existing: [] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }]);
  assert.ok(db.calls.some((call) => /set local search_path to dune/.test(call.text)));
});

// The lock has to be on a row guaranteed to exist. A base whose roster is being
// fully replaced may have no rank rows, and `for update` over zero rows
// serializes nothing at all.
test("setBasePermissions locks the claim actor row, not the rank rows", async () => {
  const db = createDb({ existing: [] });
  await setBasePermissions(db, BASE_ID, [{ playerId: "4", rank: 1 }]);
  const lock = db.calls.find((call) => call.text.includes("for update"));
  assert.match(lock.text, /from dune\.actors/);
  assert.deepEqual(lock.values, [ACTOR_ID]);
});

test("system custodian detection prefers the reserved Server identity", async () => {
  assert.deepEqual(await permissionSystemCustodian(createDb()), {
    available: true,
    playerId: "900000201",
    name: "Server"
  });
  assert.deepEqual(await permissionSystemCustodian(createDb({ custodians: [], systemIdentities: [] })), {
    available: false,
    canCreate: true,
    playerId: "900000201",
    name: "Server",
    reason: "The reserved Server identity will be created when ownership is transferred."
  });
  assert.match((await permissionSystemCustodian(createDb({
    systemIdentities: [
      { table: "player_state", accountId: "9000002", playerId: "900000201" },
      { table: "player_state", accountId: "9000002", playerId: "900000201" }
    ]
  }))).reason, /More than one/);
});

test("system custodian detection falls back to Funcom GM in encrypted_player_state", async () => {
  const result = await permissionSystemCustodian(createDb({
    canonicalPlayers: ["4", "900000101"],
    custodians: [],
    systemIdentities: [{ table: "encrypted_player_state", accountId: "9000001", playerId: "900000101" }]
  }));
  assert.deepEqual(result, { available: true, playerId: "900000101", name: "GM" });
});

test("transferBaseToSystemCustodian preserves access, demotes the owner, and promotes Server last", async () => {
  const db = createDb({ existing: [{ playerId: "4", rank: 1 }, { playerId: "29", rank: 2 }] });
  const result = await transferBaseToSystemCustodian(db, BASE_ID);
  const ranks = procCalls(db, "permission_set_player_rank").map((values) => ({ playerId: String(values[1]), rank: values[2] }));
  assert.deepEqual(ranks, [
    { playerId: "4", rank: 2 },
    { playerId: "900000201", rank: 1 }
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.systemCustodian.playerId, "900000201");
  assert.match(result.message, /Server system custodian/);
});

test("transferBaseToSystemCustodian requires provisioning for a missing Server and refuses ambiguity", async () => {
  await assert.rejects(
    () => transferBaseToSystemCustodian(createDb({ custodians: [], systemIdentities: [] }), BASE_ID),
    /will be created when ownership is transferred/);
  await assert.rejects(
    () => transferBaseToSystemCustodian(createDb({ systemIdentities: [
      { table: "player_state", accountId: "9000002", playerId: "900000201" },
      { table: "player_state", accountId: "9000002", playerId: "900000201" }
    ] }), BASE_ID),
    /More than one/);
});

test("transferBaseToSystemCustodian accepts GM from encrypted_player_state", async () => {
  const db = createDb({
    existing: [{ playerId: "4", rank: 1 }],
    canonicalPlayers: ["4", "900000101"],
    custodians: [],
    systemIdentities: [{ table: "encrypted_player_state", accountId: "9000001", playerId: "900000101" }]
  });
  const result = await transferBaseToSystemCustodian(db, BASE_ID);
  assert.equal(result.systemCustodian.name, "GM");
  assert.match(result.message, /GM system custodian/);
  assert.deepEqual(procCalls(db, "permission_set_player_rank").map((values) => [String(values[1]), values[2]]), [
    ["4", 2],
    ["900000101", 1]
  ]);
});

test("listBasePermissions labels ranks and flags rows the game ignores", async () => {
  const db = createDb();
  db.query = async (text, values = []) => {
    if (text.includes("to_regclass")) return { rows: [{ exists: SUPPORTED_TABLES.includes(String(values[0] || "")) }] };
    if (text.includes("to_regprocedure")) return { rows: [{ exists: SUPPORTED_FUNCTIONS.includes(String(values[0] || "")) }] };
    if (text.includes("from dune.buildings b")) {
      return { rows: [{ actor_id: ACTOR_ID, map: "DeepDesert", map_name_id: 7, partition_id: 59 }] };
    }
    if (text.includes("from dune.permission_actor where actor_id")) return { rows: [{ claimed: true }] };
    return { rows: [
      { player_id: "4", character_name: "DarkShark", rank: 1, canonical: true },
      { player_id: "29", character_name: "Yaida", rank: 2, canonical: true },
      { player_id: "5", character_name: "DarkShark", rank: 3, canonical: false }
    ] };
  };
  const result = await listBasePermissions(db, BASE_ID);
  assert.equal(result.actorId, ACTOR_ID);
  assert.deepEqual(result.entries.map((entry) => entry.label), ["Owner", "Co-Owner", "Associate"]);
  assert.deepEqual(result.entries.map((entry) => entry.canonical), [true, true, false]);
});

// One of the three rows already matches Sub-Fief (Associate/3) -- the list
// covers every child piece on the base, not just the ones that deviate.
function childAccessDb() {
  const calls = [];
  const db = {
    calls,
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("with base_entities")) return { rows: [
        { actor_id: "44186", actor_name: "##MTX_Neut_DesertMechanic_Prudence_Door_Placeable", access_level: 5, building_type: "MTX_Neut_DesertMechanic_Prudence_Door_Placeable", is_child: true },
        { actor_id: "44187", actor_name: "##Neut_Desert_Mechanic_Garage_Door_Placeable", access_level: 2, building_type: "Neut_Desert_Mechanic_Garage_Door_Placeable", is_child: true },
        { actor_id: "44188", actor_name: "##Neut_Desert_Mechanic_Front_Door_Placeable", access_level: 3, building_type: "Neut_Desert_Mechanic_Front_Door_Placeable", is_child: true },
        { actor_id: "459", actor_name: "Kovalt Main", access_level: 3, building_type: "Totem_Placeable", is_child: false }
      ] };
      if (text.includes("select a.id::text as actor_id")) return { rows: [{ actor_id: ACTOR_ID, map: "HaggaBasin", map_name_id: 1, partition_id: 67 }] };
      if (text.includes("for update")) return { rows: [{ id: ACTOR_ID }], rowCount: 1 };
      if (text.includes("permission_set_access_level")) return { rows: [{}] };
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };
  return db;
}

test("listBaseChildAccess lists every child piece plus the base's own root object, flagging which ones match Sub-Fief", async () => {
  const result = await listBaseChildAccess(childAccessDb(), BASE_ID);
  assert.equal(result.inspected, 4);
  assert.deepEqual(result.rows, [
    { actorId: "44186", name: "DesertMechanic Prudence Door", buildingType: "MTX_Neut_DesertMechanic_Prudence_Door_Placeable", group: "door", currentAccess: 5, currentAccessLabel: "Owner", isSubFief: false },
    { actorId: "44187", name: "Desert Mechanic Garage Door", buildingType: "Neut_Desert_Mechanic_Garage_Door_Placeable", group: "door", currentAccess: 2, currentAccessLabel: "Guild", isSubFief: false },
    { actorId: "44188", name: "Desert Mechanic Front Door", buildingType: "Neut_Desert_Mechanic_Front_Door_Placeable", group: "door", currentAccess: 3, currentAccessLabel: "Associate", isSubFief: true },
    // is_child = false: the base's own totem, not a door/device -- grouped
    // as Sub-Fief regardless of its building_type.
    { actorId: "459", name: "Kovalt Main", buildingType: "Totem_Placeable", group: "subfief", currentAccess: 3, currentAccessLabel: "Associate", isSubFief: true }
  ]);
});

test("listBaseChildAccess categorizes a piece into the right Type filter group", async (t) => {
  const cases = [
    ["StorageContainer_Placeable", "storage"],
    ["SmallOreRefinery_Placeable", "refining"],
    ["Fabricator_Placeable", "crafting"],
    // Substring rules, not exact curated keys: anything with "generator" or
    // "water" in its name, matching how the user asked for these two --
    // "Generators" and "Water Storage" for anything with water in its name.
    ["Generator_Placeable", "generators"],
    // Wind turbines are generators too -- "turbine", not "wind", so a
    // moisture-collecting Windtrap (below) is not swept in alongside them.
    ["WindTurbineDirectional_Placeable", "generators"],
    ["WindTurbineOmnidirectional_Placeable", "generators"],
    ["WaterCistern_Placeable", "water"],
    ["MediumWaterCistern_Placeable", "water"],
    ["BloodWaterExtractionAdvanced_Placeable", "water"],
    // Moisture collector, not a generator -- no "turbine" substring.
    ["Windtrap_Placeable", "other"],
    ["Choam_PentashieldSurfaceHorizontal_Placeable", "pentashield"],
    ["Choam_PentashieldSurfaceVertical_Placeable", "pentashield"],
    ["Atreides_DoorTall_Placeable", "door"],
    ["Choam_Shelter_DoorWide_Placeable", "door"],
    // Not in the curated map and no other substring rule applies.
    ["Wall_Placeable", "other"],
    // is_child = false always wins Sub-Fief, regardless of building_type --
    // even one that would otherwise match a substring rule.
    ["Totem_Placeable", "subfief", false],
    ["Generator_Placeable", "subfief", false]
  ];
  for (const [buildingType, expectedGroup, isChild = true] of cases) {
    await t.test(`${buildingType} (is_child=${isChild}) -> ${expectedGroup}`, async () => {
      const db = {
        query: async (text) => {
          if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
          if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
          if (text.includes("with base_entities")) return { rows: [
            { actor_id: "44190", actor_name: `##${buildingType}`, access_level: 2, building_type: buildingType, is_child: isChild }
          ] };
          return { rows: [] };
        }
      };
      const result = await listBaseChildAccess(db, BASE_ID);
      assert.equal(result.rows[0].group, expectedGroup);
    });
  }
});

test("setBaseChildAccessLevels writes each requested level, including a piece that already matched Sub-Fief, and refuses an actor that isn't a child of this base", async () => {
  const db = childAccessDb();
  const result = await setBaseChildAccessLevels(db, BASE_ID, [
    { actorId: "44186", accessLevel: 3 },
    { actorId: "44188", accessLevel: 1 }
  ]);
  assert.equal(result.updated, 2);
  assert.deepEqual(procCalls(db, "permission_set_access_level"), [["44186", 3], ["44188", 1]]);
  await assert.rejects(
    () => setBaseChildAccessLevels(childAccessDb(), BASE_ID, [{ actorId: "99999", accessLevel: 3 }]),
    /no longer children/i);
});

test("setBaseChildAccessLevels rejects an access level outside the 1-5 scale", async () => {
  await assert.rejects(
    () => setBaseChildAccessLevels(childAccessDb(), BASE_ID, [{ actorId: "44186", accessLevel: 0 }]),
    /access level/i);
  await assert.rejects(
    () => setBaseChildAccessLevels(childAccessDb(), BASE_ID, [{ actorId: "44186", accessLevel: 6 }]),
    /access level/i);
});

// The queue exists because a running map never picks up an access_level
// change (see docs/console/base-child-permissions.md), so a save aimed at a
// live map is recorded and written in the map-down window instead.
async function withTempRepoRoot(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-child-access-queue-"));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("queueBaseChildAccess records a base's pending pieces and cancel clears them", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.deepEqual(listQueuedBaseChildAccess(repoRoot), []);
    const entry = queueBaseChildAccess(repoRoot, {
      baseId: BASE_ID,
      map: "DeepDesert",
      partitionId: 59,
      updates: [{ actorId: "44186", accessLevel: 3 }, { actorId: "44187", accessLevel: 5 }]
    });
    assert.equal(entry.baseId, BASE_ID);
    assert.equal(entry.partitionId, 59);
    assert.deepEqual(entry.updates, [{ actorId: "44186", accessLevel: 3 }, { actorId: "44187", accessLevel: 5 }]);

    const queued = listQueuedBaseChildAccess(repoRoot);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].updates.length, 2);

    cancelQueuedBaseChildAccess(repoRoot, BASE_ID);
    assert.deepEqual(listQueuedBaseChildAccess(repoRoot), []);
    assert.throws(() => cancelQueuedBaseChildAccess(repoRoot, BASE_ID), /no queued permission changes/i);
  });
});

// Unlike the refill/delete queues, whose entries are pure intent and can be
// replaced wholesale, this entry carries a payload: a second save touching
// different pieces must not discard the first one's.
test("queueBaseChildAccess merges a second save into the existing entry, last write winning per piece", async () => {
  await withTempRepoRoot((repoRoot) => {
    const first = queueBaseChildAccess(repoRoot, {
      baseId: BASE_ID,
      map: "DeepDesert",
      partitionId: 59,
      updates: [{ actorId: "44186", accessLevel: 3 }, { actorId: "44187", accessLevel: 5 }]
    });
    queueBaseChildAccess(repoRoot, {
      baseId: BASE_ID,
      map: "DeepDesert",
      partitionId: 59,
      updates: [{ actorId: "44187", accessLevel: 1 }, { actorId: "44188", accessLevel: 2 }]
    });

    const queued = listQueuedBaseChildAccess(repoRoot);
    assert.equal(queued.length, 1, "still one entry for the base");
    assert.deepEqual(queued[0].updates, [
      { actorId: "44186", accessLevel: 3 },
      { actorId: "44187", accessLevel: 1 },
      { actorId: "44188", accessLevel: 2 }
    ]);
    // queuedAt is preserved so re-saving cannot reset the entry's age limit.
    assert.equal(queued[0].queuedAt, first.queuedAt);
  });
});

test("queueBaseChildAccess rejects an empty or fully invalid update set", async () => {
  await withTempRepoRoot((repoRoot) => {
    // An empty array is caught by the 1-100 length check that mirrors the
    // immediate path; a non-empty array of unusable entries falls through to
    // the post-normalize check.
    assert.throws(() => queueBaseChildAccess(repoRoot, { baseId: BASE_ID, updates: [] }), /between 1 and 100 pieces/i);
    assert.throws(
      () => queueBaseChildAccess(repoRoot, { baseId: BASE_ID, updates: [{ actorId: "44186", accessLevel: 9 }] }),
      /at least one piece/i);
    assert.deepEqual(listQueuedBaseChildAccess(repoRoot), []);
  });
});

// A request-time save must refuse a stale actorId, but an entry drained days
// later would otherwise be permanently failed by one demolished door.
test("setBaseChildAccessLevels skips stale pieces only under skipStale, and refuses when none remain", async () => {
  await assert.rejects(
    () => setBaseChildAccessLevels(childAccessDb(), BASE_ID, [
      { actorId: "44186", accessLevel: 3 },
      { actorId: "999999", accessLevel: 3 }
    ]),
    /no longer children of this base/i);

  const result = await setBaseChildAccessLevels(childAccessDb(), BASE_ID, [
    { actorId: "44186", accessLevel: 3 },
    { actorId: "999999", accessLevel: 3 }
  ], { skipStale: true });
  assert.equal(result.updated, 1);
  assert.deepEqual(result.skipped, ["999999"]);

  await assert.rejects(
    () => setBaseChildAccessLevels(childAccessDb(), BASE_ID, [{ actorId: "999999", accessLevel: 3 }], { skipStale: true }),
    /none of the queued pieces/i);
});

// A queue-backed db double: world_partition exists, partition 59 is
// unassigned (so partitionWriteSafe treats it as down), and the child-access
// query returns the pieces the flush is allowed to touch.
function flushDb({ childActorIds = ["44186", "44187"], onApply = () => {} } = {}) {
  const db = {
    query: async (text, values = []) => {
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("from dune.world_partition")) {
        return { rows: [{ partition_id: 59, unassigned: true, connected: false }] };
      }
      if (text.includes("with base_entities")) {
        return { rows: childActorIds.map((actorId) => ({
          actor_id: actorId, actor_name: `##Piece_${actorId}`, access_level: 3,
          building_type: "Generator_Placeable", is_child: true
        })) };
      }
      if (text.includes("select a.id::text as actor_id")) {
        return { rows: [{ actor_id: ACTOR_ID, map: "DeepDesert", map_name_id: 7, partition_id: 59 }] };
      }
      if (text.includes("for update")) return { rows: [{ id: ACTOR_ID }], rowCount: 1 };
      if (text.includes("permission_set_access_level")) {
        await onApply(values);
        return { rows: [{}] };
      }
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };
  return db;
}

test("flushBaseChildAccess applies a queued entry and clears it", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    queueBaseChildAccess(repoRoot, {
      baseId: BASE_ID, map: "DeepDesert", partitionId: 59,
      updates: [{ actorId: "44186", accessLevel: 5 }]
    });
    const result = await flushBaseChildAccess(flushDb(), repoRoot);
    assert.equal(result.flushed.length, 1);
    assert.equal(result.flushed[0].ok, true);
    assert.equal(result.flushed[0].updated, 1);
    assert.deepEqual(listQueuedBaseChildAccess(repoRoot), []);
  });
});

// Regression: queuedAt deliberately survives a merge, so it cannot also be the
// "is this the payload I flushed?" check. Without the revision guard the save
// that lands mid-flush is dropped unapplied while the flush reports ok.
test("flushBaseChildAccess keeps a save that merges in while the entry is being flushed", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    queueBaseChildAccess(repoRoot, {
      baseId: BASE_ID, map: "DeepDesert", partitionId: 59,
      updates: [{ actorId: "44186", accessLevel: 5 }]
    });
    let injected = false;
    const db = flushDb({
      onApply: async () => {
        if (injected) return;
        injected = true;
        // The operator saves a different piece while the flush is mid-apply.
        queueBaseChildAccess(repoRoot, {
          baseId: BASE_ID, map: "DeepDesert", partitionId: 59,
          updates: [{ actorId: "44187", accessLevel: 1 }]
        });
      }
    });

    const result = await flushBaseChildAccess(db, repoRoot);
    assert.equal(result.flushed[0].ok, true);

    const remaining = listQueuedBaseChildAccess(repoRoot);
    assert.equal(remaining.length, 1, "the merged-in save must survive the flush");
    assert.ok(
      remaining[0].updates.some((update) => update.actorId === "44187" && update.accessLevel === 1),
      "the piece queued mid-flush must still be pending");
  });
});

test("queueBaseChildAccess bumps revision on merge but keeps queuedAt", async () => {
  await withTempRepoRoot((repoRoot) => {
    const first = queueBaseChildAccess(repoRoot, {
      baseId: BASE_ID, updates: [{ actorId: "44186", accessLevel: 3 }]
    });
    const second = queueBaseChildAccess(repoRoot, {
      baseId: BASE_ID, updates: [{ actorId: "44187", accessLevel: 3 }]
    });
    assert.equal(second.queuedAt, first.queuedAt, "age limit must not reset on re-save");
    assert.equal(second.revision, first.revision + 1);
  });
});

// The immediate path rejects >100; the queue path must not quietly accept more
// just because the base's map happened to be up.
test("queueBaseChildAccess enforces the same 1-100 cap as the immediate path", async () => {
  await withTempRepoRoot((repoRoot) => {
    const tooMany = Array.from({ length: 101 }, (_, index) => ({ actorId: String(index + 1), accessLevel: 3 }));
    assert.throws(() => queueBaseChildAccess(repoRoot, { baseId: BASE_ID, updates: tooMany }),
      /between 1 and 100 pieces/i);
    assert.deepEqual(listQueuedBaseChildAccess(repoRoot), []);
  });
});

test("flushBaseChildAccess leaves an entry queued while its map is live", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    queueBaseChildAccess(repoRoot, {
      baseId: BASE_ID, map: "DeepDesert", partitionId: 59,
      updates: [{ actorId: "44186", accessLevel: 5 }]
    });
    const live = flushDb();
    const base = live.query;
    live.query = async (text, values) => {
      if (text.includes("from dune.world_partition")) {
        return { rows: [{ partition_id: 59, unassigned: false, connected: true }] };
      }
      return base(text, values);
    };
    const result = await flushBaseChildAccess(live, repoRoot);
    assert.deepEqual(result.flushed, []);
    assert.equal(listQueuedBaseChildAccess(repoRoot).length, 1, "must stay queued while the map is up");
  });
});

// The 5s flush tick uses this instead of listing, so it must agree with the
// list on whether anything is waiting -- an over-eager true costs one wasted
// pass, but a false negative would silently never flush.
test("hasQueuedBaseChildAccess agrees with the list without parsing the payload", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.equal(hasQueuedBaseChildAccess(repoRoot), false, "no file yet");

    queueBaseChildAccess(repoRoot, {
      baseId: BASE_ID, map: "DeepDesert", partitionId: 59,
      updates: [{ actorId: "44186", accessLevel: 5 }]
    });
    assert.equal(hasQueuedBaseChildAccess(repoRoot), true);
    assert.equal(listQueuedBaseChildAccess(repoRoot).length, 1);

    cancelQueuedBaseChildAccess(repoRoot, BASE_ID);
    assert.equal(hasQueuedBaseChildAccess(repoRoot), false, "an emptied queue must read as empty");
    assert.deepEqual(listQueuedBaseChildAccess(repoRoot), []);
  });
});

// setBaseChildAccessLevels caps each call at 100 pieces and each call is its own
// transaction, so a base with more than 100 children flushes in several commits.
// Real bases reach 315 children. If a later batch finds its pieces gone, the
// earlier commits still happened, and reporting the entry as "none of those
// pieces are still part of that base" would describe a base whose doors did in
// fact change access level.
test("a later batch finding its pieces gone still reports what earlier batches committed", async () => {
  await withTempRepoRoot(async (repoRoot) => {
    const live = Array.from({ length: 100 }, (_, i) => String(50000 + i));
    const stale = Array.from({ length: 50 }, (_, i) => String(60000 + i));
    // Queued in two saves: the 1-100 cap is per save, and merged entries are
    // exactly why the flush batches at all.
    for (const batch of [live, stale]) {
      queueBaseChildAccess(repoRoot, {
        baseId: BASE_ID, map: "DeepDesert", partitionId: 59,
        updates: batch.map((actorId) => ({ actorId, accessLevel: 5 }))
      });
    }
    assert.equal(listQueuedBaseChildAccess(repoRoot)[0].updates.length, 150);
    // Only the first 100 are still children, so batch 1 commits and batch 2
    // throws "None of the queued pieces are still children of this base."
    const applied = [];
    const db = flushDb({ childActorIds: live, onApply: (values) => { applied.push(String(values[0])); } });

    const result = await flushBaseChildAccess(db, repoRoot);

    assert.equal(applied.length, 100, "the first batch must really have been written");
    assert.equal(result.flushed.length, 1);
    assert.equal(result.flushed[0].ok, true);
    assert.equal(result.flushed[0].updated, 100, "must report the committed batch, not zero");
    assert.deepEqual(result.flushed[0].skipped, stale, "only the pieces never applied are skipped");
    assert.deepEqual(listQueuedBaseChildAccess(repoRoot), [], "and the entry is still cleared");
  });
});
