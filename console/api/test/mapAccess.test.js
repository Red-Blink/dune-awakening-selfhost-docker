import test from "node:test";
import assert from "node:assert/strict";
import { filterMapAccess } from "../src/services/mapAccess.js";
import { actionForRoute } from "../src/actions.js";

const payload = {
  capabilities: { players: true, bases: true, vehicles: true, storage: true, services: true, poi: true },
  overlays: { players: "private-player-diagnostic", vehicles: "private-vehicle-diagnostic", bases: "private-base-diagnostic", storage: "private-storage-diagnostic" },
  rows: ["player", "base", "vehicle", "storage", "service", "poi", "spice"].map((type, index) => ({ type, id: String(index), name: `synthetic-${type}` }))
};

test("map-only access never serializes private resource layers or their diagnostics", () => {
  const filtered = filterMapAccess(payload, () => false);
  assert.deepEqual(filtered.rows.map(row => row.type), ["poi", "spice"]);
  assert.deepEqual(filtered.overlays, {});
  for (const key of ["players", "bases", "vehicles", "storage", "services"]) assert.equal(filtered.capabilities[key], false);
  assert.equal(filtered.capabilities.poi, true);
  assert.doesNotMatch(JSON.stringify(filtered), /private-|synthetic-(player|base|vehicle|storage|service)/);
});

test("partial access includes only the granted component and preserves cached input", () => {
  const original = structuredClone(payload);
  const filtered = filterMapAccess(payload, action => action === "vehicles:read");
  assert.deepEqual(filtered.rows.map(row => row.type), ["vehicle", "poi", "spice"]);
  assert.equal(filtered.capabilities.vehicles, true);
  assert.deepEqual(payload, original);
  const broad = filterMapAccess(payload, () => true);
  assert.deepEqual(broad, original);
  assert.deepEqual(filterMapAccess(payload, () => false).rows.map(row => row.type), ["poi", "spice"]);
});

test("map subresources require their own resource permissions rather than the map-page permission", () => {
  for (const [path, action] of Object.entries({ players: "players:read", bases: "bases:read", storage: "storage:read", services: "server:read" })) {
    assert.equal(actionForRoute(`/api/map/${path}`, "GET"), action);
  }
  assert.equal(actionForRoute("/api/map/markers", "GET"), "maps:read");
  assert.equal(actionForRoute("/api/map/overlays", "GET"), "maps:read");
});
