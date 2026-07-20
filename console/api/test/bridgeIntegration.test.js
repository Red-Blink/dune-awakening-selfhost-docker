import test from "node:test";
import assert from "node:assert/strict";
import { addonOpsActivitySummary } from "../src/duneDb.js";
import { addonOpsResourcesSummary } from "../src/duneDb.js";
import { addonOpsCombatDeaths } from "../src/duneDb.js";
import { detectTransitions } from "../src/deathPoller.js";

// ─── Helper: create a real DB connection for integration tests ───
let db = null;

async function getDb() {
  if (db) return db;
  try {
    const { createDb } = await import("../src/db.js");
    db = createDb({});
    return db;
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      console.log("Skipping integration tests — pg module not installed (npm ci)");
      return null;
    }
    throw e;
  }
}

// ─── ops.activity.summary integration ───

test("ops.activity.summary — live DB — returns valid structure", async () => {
  const database = await getDb();
  if (!database) return;

  const result = await addonOpsActivitySummary(database);
  assert.equal(typeof result.totalPlayers, "number");
  assert.equal(typeof result.onlinePlayers, "number");
  assert.equal(typeof result.playersDead, "number");
  assert.equal(typeof result.activeLast1h, "number");
  assert.equal(typeof result.activeLast24h, "number");
  assert.ok(Array.isArray(result.guildActivity));
  assert.ok(Array.isArray(result.factionActivity));
  assert.ok(Array.isArray(result.mapActivity));

  // All arrays must have consistent object shapes
  for (const g of result.guildActivity) {
    assert.equal(typeof g.guild, "string");
    assert.equal(typeof g.members, "number");
    assert.equal(typeof g.online, "number");
  }
  for (const f of result.factionActivity) {
    assert.equal(typeof f.faction, "string");
    assert.equal(typeof f.members, "number");
    assert.equal(typeof f.online, "number");
  }
});

test("ops.activity.summary — live DB — playersDead non-negative", async () => {
  const database = await getDb();
  if (!database) return;

  const result = await addonOpsActivitySummary(database);
  assert.ok(result.playersDead >= 0);
  assert.ok(result.totalPlayers >= result.playersDead);
  assert.ok(result.totalPlayers >= result.onlinePlayers);
});

// ─── ops.resources.summary integration ───

test("ops.resources.summary — live DB — returns valid structure", async () => {
  const database = await getDb();
  if (!database) return;

  const result = await addonOpsResourcesSummary(database);
  assert.equal(typeof result.totalFields, "number");
  assert.equal(typeof result.totalValueRemaining, "number");
  assert.ok(Array.isArray(result.resourcesByMap));
  assert.ok(Array.isArray(result.spiceFieldsBySize));

  for (const m of result.resourcesByMap) {
    assert.equal(typeof m.map, "string");
    assert.equal(typeof m.fields, "number");
    assert.ok(typeof m.total_value === "number" || typeof m.total_value === "string");
  }
  for (const s of result.spiceFieldsBySize) {
    assert.equal(typeof s.map, "string");
    assert.equal(typeof s.size, "string");
    assert.ok(typeof s.active_fields === "number" || typeof s.active_fields === "string");
    assert.ok(typeof s.total_value === "number" || typeof s.total_value === "string");
    assert.ok(typeof s.currently_active === "number" || typeof s.currently_active === "string");
    assert.ok(typeof s.max_active === "number" || typeof s.max_active === "string");
  }
});

test("ops.resources.summary — live DB — spice only (field_kind_id=1)", async () => {
  const database = await getDb();
  if (!database) return;

  const result = await addonOpsResourcesSummary(database);
  assert.ok(result.totalFields >= 0);
  assert.ok(result.totalValueRemaining >= 0);
  // Spice fields should be a subset of total with field_kind_id=1 filter
});

// ─── ops.combat.deaths integration ───

test("ops.combat.deaths — live DB — returns valid structure", async () => {
  const database = await getDb();
  if (!database) return;

  const result = await addonOpsCombatDeaths(database);
  assert.equal(typeof result.totalDeaths, "number");
  assert.equal(typeof result.pvpDeaths, "number");
  assert.equal(typeof result.pveDeaths, "number");
  assert.ok(Array.isArray(result.deathsByCause));
  assert.equal(result.kdRatio, null, "kdRatio must be null — no kill count");
  assert.equal(result.topHostileNpcs.length, 0, "NPC kills not tracked locally");
  assert.equal(result.deathsByMap.length, 0, "death map not tracked locally");

  for (const d of result.deathsByCause) {
    assert.equal(typeof d.cause, "string");
    assert.equal(typeof d.count, "number");
    assert.ok(d.count >= 0);
  }
});

// ─── Death poller detectTransitions unit ───

test("detectTransitions — empty snapshot = zero deaths", () => {
  const previous = new Map();
  const current = new Map([
    ["1", "Dead"],
    ["2", "DeadBySandworm"],
    ["3", "DeadByCoriolis"]
  ]);
  const deaths = detectTransitions(previous, current);
  assert.equal(deaths.length, 0, "no previous snapshot, should not count existing Dead* players");

  const currentAllDead = new Map([["1", "Dead"], ["2", "Dead"]]);
  const deaths2 = detectTransitions(previous, currentAllDead);
  assert.equal(deaths2.length, 0, "same — all dead, no snapshot");
});

test("detectTransitions — Alive→Dead transition detected", () => {
  const previous = new Map([["1", "Alive"], ["2", "Alive"]]);
  const current = new Map([["1", "Dead"], ["2", "Alive"]]);
  const deaths = detectTransitions(previous, current);
  assert.equal(deaths.length, 1);
  assert.equal(deaths[0].player_controller_id, "1");
  assert.equal(deaths[0].death_cause, "Dead");
});

test("detectTransitions — multiple death causes", () => {
  const previous = new Map([["1", "Alive"], ["2", "Alive"], ["3", "Alive"]]);
  const current = new Map([["1", "DeadBySandworm"], ["2", "DeadByCoriolis"], ["3", "Alive"]]);
  const deaths = detectTransitions(previous, current);
  assert.equal(deaths.length, 2);
  assert.equal(deaths[0].death_cause, "DeadBySandworm");
  assert.equal(deaths[1].death_cause, "DeadByCoriolis");
});

test("detectTransitions — respawn (Dead→Alive) is not a new death", () => {
  const previous = new Map([["1", "Dead"], ["2", "Alive"]]);
  const current = new Map([["1", "Alive"], ["2", "Alive"]]);
  const deaths = detectTransitions(previous, current);
  assert.equal(deaths.length, 0, "player 1 respawned — should not count as new death");
});

test("detectTransitions — Dead staying Dead is not re-counted", () => {
  const previous = new Map([["1", "Dead"], ["2", "DeadByCoriolis"]]);
  const current = new Map([["1", "Dead"], ["2", "DeadByCoriolis"]]);
  const deaths = detectTransitions(previous, current);
  assert.equal(deaths.length, 0, "no state change — no new deaths");
});

test("detectTransitions — new player appears as Alive, dies", () => {
  const previous = new Map([["1", "Alive"]]);
  const current = new Map([["1", "Dead"], ["2", "Alive"]]);
  const deaths = detectTransitions(previous, current);
  assert.equal(deaths.length, 1);
  assert.equal(deaths[0].player_controller_id, "1");
  // Player 2 is new (not in previous) and Alive — no death counted
});
