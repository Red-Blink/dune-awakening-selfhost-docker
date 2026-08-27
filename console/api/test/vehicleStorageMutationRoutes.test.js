import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Same technique as baseContainerMutationRoutes.test.js and
// vehicleRouteStatus.test.js: server.js is an entrypoint, so its handlers
// cannot be imported and called. These read it as source and assert the
// invariants that are easy to drop in a later edit and expensive to notice.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverSource = readFileSync(resolve(repoRoot, "console/api/src/server.js"), "utf8");

const DELETE_ROUTES = [
  "vehicleStorageItemDeleteRoute",
  "vehicleStorageItemsDeleteRoute",
  "vehicleStorageAllItemsDeleteRoute"
];

function routeBody(name) {
  const start = serverSource.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in server.js`);
  const end = serverSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return serverSource.slice(start, end);
}

test("every vehicle cargo delete route is dispatched from handleApi", () => {
  for (const name of DELETE_ROUTES) {
    assert.ok(
      serverSource.includes(`return ${name}(req, res, path)`),
      `${name} is defined but never dispatched -- the route would 404`
    );
  }
});

test("every vehicle cargo delete route requires a confirmation phrase", () => {
  const phrases = {
    vehicleStorageItemDeleteRoute: "DELETE ITEM",
    vehicleStorageItemsDeleteRoute: "DELETE ITEMS",
    vehicleStorageAllItemsDeleteRoute: "DELETE ALL ITEMS"
  };
  for (const [name, phrase] of Object.entries(phrases)) {
    const body = routeBody(name);
    assert.match(body, /directDbMutation\(req, res,/, `${name} must go through directDbMutation`);
    assert.ok(body.includes(`"${phrase}"`), `${name} must require the ${phrase} phrase`);
  }
});

test("every vehicle cargo delete route audits under its own action", () => {
  const actions = {
    vehicleStorageItemDeleteRoute: "vehicles.storage-item-delete",
    vehicleStorageItemsDeleteRoute: "vehicles.storage-items-delete",
    vehicleStorageAllItemsDeleteRoute: "vehicles.storage-all-items-delete"
  };
  for (const [name, action] of Object.entries(actions)) {
    // Distinct action strings are also distinct rate-limit scopes, so one
    // route's budget cannot exhaust another's.
    assert.ok(routeBody(name).includes(`"${action}"`), `${name} must audit as ${action}`);
  }
});

test("every vehicle cargo delete route refuses a vehicle with a queued delete", () => {
  for (const name of DELETE_ROUTES) {
    const body = routeBody(name);
    assert.match(body, /vehicleDeletePending\(vehicleId\)/, `${name} must check vehicleDeletePending`);
    assert.match(body, /VEHICLE_DELETE_PENDING_MESSAGE/);
    // The guard has to precede the mutation, or it is decoration.
    assert.ok(body.indexOf("vehicleDeletePending") < body.indexOf("directDbMutation"),
      `${name} must reject a pending-delete vehicle before mutating`);
  }
});

test("every vehicle cargo delete route validates its path segments before mutating", () => {
  for (const name of DELETE_ROUTES) {
    const body = routeBody(name);
    const guardAt = body.indexOf("Invalid vehicle");
    const mutationAt = body.indexOf("directDbMutation");
    assert.notEqual(guardAt, -1, `${name} lost its invalid-id response`);
    assert.ok(guardAt < mutationAt, `${name} must reject a bad id before mutating`);
    assert.match(body, /parseVehicleStoragePath\(path\)/);
  }
});

// The single-item route is the only one carrying an item id, and it is a
// bigint. Number()-ing it rounds anything past Number.MAX_SAFE_INTEGER, which
// on a destructive route means silently retargeting a different row.
test("the single-item route validates the item id as a string, never Number()", () => {
  const body = routeBody("vehicleStorageItemDeleteRoute");
  assert.match(body, /validVehicleStorageItemId\(itemId\)/);
  assert.doesNotMatch(body, /Number\(decodeURIComponent\(path\.split\("\/"\)\[6\]\)\)/,
    "the item id must not be Number()'d");

  // A plain function, not an async route, so routeBody's `async function`
  // anchor does not apply -- slice it directly.
  const guardAt = serverSource.indexOf("function validVehicleStorageItemId");
  assert.notEqual(guardAt, -1, "validVehicleStorageItemId is missing");
  const guard = serverSource.slice(guardAt, serverSource.indexOf("\n}\n", guardAt));
  assert.match(guard, /\^\[1-9\]\[0-9\]\*\$/, "the item id guard must be the decimal-string regex");
  assert.match(guard, /9223372036854775807n/, "the item id guard must bound at bigint max");
});

// No safety backup here, unlike vehicleDeleteRoute: these are item rows, not a
// whole vehicle, and taking a full database dump per stack deleted would make
// the feature unusable.
test("vehicle cargo deletes take no database backup and never queue", () => {
  for (const name of DELETE_ROUTES) {
    const body = routeBody(name);
    assert.doesNotMatch(body, /backupCreate/, `${name} must not take a full database backup`);
    assert.doesNotMatch(body, /queueVehicleDelete/, `${name} must not touch the vehicle delete queue`);
  }
});

// The authoritative blocked-state refusal is atomic, inside the delete
// transaction, where the lock is held. A route-level pre-check would be a
// TOCTOU gap dressed as a safety feature -- the base version's equivalent is
// documented dead code for exactly that reason.
test("the blocked-state guard lives in the transaction, not the route", () => {
  const duneDbSource = readFileSync(resolve(repoRoot, "console/api/src/duneDb.js"), "utf8");
  const resolver = duneDbSource.slice(
    duneDbSource.indexOf("async function resolveVehicleCargoHold"),
    duneDbSource.indexOf("const VEHICLE_STORAGE_DELETE_CAPABILITY")
  );
  assert.match(resolver, /vehicleBlockedDeleteState\(tx, vehicleId\)/);
  // After the lock, not before it: the state could otherwise change between
  // the check and the delete.
  assert.ok(resolver.indexOf("for update of inv") < resolver.indexOf("vehicleBlockedDeleteState"),
    "the state check must come after the FOR UPDATE lock");
  for (const name of DELETE_ROUTES) {
    assert.doesNotMatch(routeBody(name), /vehicleBlockedDeleteState/,
      `${name} must not re-check the state outside the transaction`);
  }
});

test("the storage read carries deleteSafety so the overlay can gate ahead of a click", () => {
  const body = routeBody("vehicleStorageRoute");
  assert.match(body, /duneDb\.vehicleStorageDeleteSafety\(db, vehicleId\)/);
  assert.match(body, /deleteSafety:/);
});
