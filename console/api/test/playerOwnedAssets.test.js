import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { redactSharedWith, ownedListOptions, ownPawnId, playerMayCall, effectiveAccess, ownedViewForSession, statusBodyForSession } from "../src/playerScope.js";
import { listOwnedStorage } from "../src/duneDb.js";

// #1276: a player sees only the bases/vehicles/storage they OWN (rank 1), and
// never another player's name on them.

const linked = { player_controller_id: "55", player_pawn_id: "1001" };

test("ownedListOptions pins the caller's pawn id and owner access", () => {
  const o = ownedListOptions(linked, { playerId: "2002", access: "all", q: "base", pageSize: "20" });
  assert.equal(o.playerId, 1001);
  assert.equal(o.access, "owner");
  assert.equal(o.q, "base");
  assert.equal(o.pageSize, 20);
});

test("ownedListOptions ignores every client attempt to widen scope", () => {
  for (const q of [{ playerId: "9", access: "all" }, { playerId: ["9"], access: ["coowner"] }, { access: "owner,all" }]) {
    const o = ownedListOptions(linked, q);
    assert.equal(o.playerId, 1001);
    assert.equal(o.access, "owner");
  }
});

test("ownedListOptions caps page size and rejects unlinked or zero pawn ids", () => {
  assert.equal(ownedListOptions(linked, { pageSize: "100000" }).pageSize, 50);
  assert.equal(ownedListOptions(linked, { pageSize: "0" }).pageSize, 50);
  assert.equal(ownedListOptions(linked, { pageSize: "201" }).pageSize, 50);
  assert.equal(ownedListOptions(linked, { pageSize: "200" }).pageSize, 200);
  assert.equal(ownedListOptions(linked, { pageSize: "1" }).pageSize, 1);
  for (const bad of [null, undefined, {}, { player_pawn_id: "0" }, { player_pawn_id: "abc" }, { player_pawn_id: "-4" }, { player_pawn_id: "1.5" }]) {
    assert.equal(ownedListOptions(bad, {}), null, JSON.stringify(bad));
    assert.equal(ownPawnId(bad), null);
  }
});

test("redactSharedWith removes other players from every row and keeps the rest", () => {
  const result = { totalCount: 2, rows: [
    { base_id: "1", name: "A", shared_with: [{ name: "Bob", rank: 2 }] },
    { base_id: "2", name: "B", shared_with: [{ name: "Carol", rank: 3 }] },
  ] };
  const out = redactSharedWith(result);
  assert.ok(!JSON.stringify(out).includes("Bob"));
  assert.ok(!JSON.stringify(out).includes("Carol"));
  assert.equal(out.totalCount, 2);
  assert.deepEqual(out.rows.map((r) => r.name), ["A", "B"]);
  assert.ok(JSON.stringify(result).includes("Bob"), "input must not be mutated");
});

test("redactSharedWith passes non-list results through", () => {
  assert.equal(redactSharedWith(null), null);
  assert.deepEqual(redactSharedWith({ unsupported: true }), { unsupported: true });
});

test("only the list routes are open; detail, export, items and permissions stay closed", () => {
  for (const p of ["/api/bases", "/api/vehicles", "/api/storage"]) assert.equal(playerMayCall("GET", p), true, p);
  for (const p of ["/api/bases/1", "/api/bases/1/permissions", "/api/bases/1/export", "/api/bases/1/export-backup", "/api/bases/permission-candidates",
    "/api/bases/pending-deletes", "/api/vehicles/1/permissions", "/api/vehicles/permission-candidates", "/api/storage/1", "/api/storage/1/items",
    "/api/storage/1/export", "/api/base-backups", "/api/admin/vehicles"]) assert.equal(playerMayCall("GET", p), false, p);
});

test("listOwnedStorage binds only the caller's controller id and joins only the caller's rank-1 row", async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return sql.includes("to_regclass") || sql.includes("information_schema") ? { rows: [{ exists: true, to_regclass: "x" }], rowCount: 1 } : { rows: [], rowCount: 0 }; } };
  await listOwnedStorage(db, "55");
  const q = calls.find((c) => c.sql.includes("from dune.placeables p"));
  assert.ok(q, "storage query not issued");
  assert.deepEqual(q.values, [55]);
  assert.match(q.sql, /join dune\.permission_actor_rank par on par\.permission_actor_id = afe\.actor_id\s+and par\.player_id = \$1 and par\.rank = 1/);
  assert.doesNotMatch(q.sql, /left join dune\.permission_actor_rank par/);
});

test("listOwnedStorage rejects a missing or non-numeric controller id", async () => {
  const db = { query: async () => ({ rows: [{ exists: true }], rowCount: 1 }) };
  for (const bad of ["", null, undefined, "abc", 0, -1]) await assert.rejects(() => listOwnedStorage(db, bad), undefined, String(bad));
});

test("server wiring: the handlers call the tested helpers (behaviour is covered by the helper tests)", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /session\.tier === "player" && \(path === "\/api\/bases" \|\| path === "\/api\/vehicles" \|\| path === "\/api\/storage"\)\) return playerOwnedAssetsRoute\(/);
  assert.match(src, /playerOwnedAssetsBody\(\{ duneDb, db, session, path/);
  assert.equal((src.match(/access: effectiveAccess\(session, playerAccessParam\(url\)\)/g) || []).length, 2);
  assert.equal((src.match(/ownedViewForSession\(session, await duneDb\.list(Bases|Vehicles)\(/g) || []).length, 2);
});

test("effectiveAccess and ownedViewForSession only change what a player gets", () => {
  const player = { tier: "player" };
  for (const requested of ["all", "coowner", "owner", undefined]) {
    assert.equal(effectiveAccess(player, requested), "owner");
    assert.equal(effectiveAccess({ tier: "admin" }, requested), requested);
    assert.equal(effectiveAccess(null, requested), requested);
  }
  const result = { rows: [{ shared_with: [{ name: "Bob" }] }] };
  assert.equal(ownedViewForSession({ tier: "admin" }, result), result);
  assert.deepEqual(ownedViewForSession(player, result).rows[0].shared_with, []);
});

test("the player view drops fleet-wide totals and raw database error text", () => {
  const out = redactSharedWith({ totalCount: 2, totalVehicles: 4812, reason: "Vehicles query failed: relation dune.secret_table does not exist", rows: [] });
  assert.equal(out.totalVehicles, 2);
  assert.ok(!JSON.stringify(out).includes("secret_table"));
  assert.deepEqual(redactSharedWith({ rows: [] }), { rows: [] }, "no reason or totals invented");
});

test("a player cannot sort by who else has access", () => {
  assert.equal(ownedListOptions(linked, { sortColumn: "shared_with" }).sortColumn, "name");
  assert.equal(ownedListOptions(linked, { sortColumn: "owner_name" }).sortColumn, "owner_name");
});

test("Layer 3: owner names, storage reasons and roster ids are not shown to a player", async () => {
  const { redactSharedWith, guildRosterForSession, ownedListOptions } = await import("../src/playerScope.js");
  const vehicles = redactSharedWith({ rows: [{ id: 1, owner: "Someone Else", shared_with: [{ name: "X" }] }], totalCount: 1, totalVehicles: 900 });
  assert.equal(vehicles.rows[0].owner, "You");
  assert.deepEqual(vehicles.rows[0].shared_with, []);
  assert.equal(vehicles.totalVehicles, 1);
  const storage = redactSharedWith({ capabilities: {}, rows: undefined, reason: "Unsupported by detected schema. Missing required table(s): dune.placeables" });
  assert.ok(!JSON.stringify(storage).includes("dune.placeables"));
  assert.equal(ownedListOptions({ player_pawn_id: "5" }, {}).includeGenerators, false);
  const roster = { rows: [{ player_id: "controller-9", role_id: "100", character_name: "Mate" }] };
  assert.deepEqual(guildRosterForSession({ tier: "player" }, roster).rows, [{ character_name: "Mate", role_id: "100" }]);
  assert.equal(guildRosterForSession({ tier: "admin" }, roster), roster);
});
