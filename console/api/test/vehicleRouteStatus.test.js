import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { intParam } from "../src/db.js";

// Same technique as baseRouteStatus.test.js: server.js is an entrypoint, so
// its route handlers cannot be called directly, and this reads it as source
// instead. Kept as its own file rather than folded into baseRouteStatus.test.js
// because the guard's literal error text ("Invalid vehicle ID") differs from
// the base routes' ("Invalid base ID"), which that file's assertions hardcode.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverSource = readFileSync(resolve(repoRoot, "console/api/src/server.js"), "utf8");

function routeBody(name) {
  const start = serverSource.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in server.js`);
  const end = serverSource.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return serverSource.slice(start, end);
}

test("the vehicle permissions route guard rejects everything intParam would", () => {
  const guard = (vehicleId) => Number.isInteger(vehicleId) && vehicleId >= 1 && vehicleId <= Number.MAX_SAFE_INTEGER;

  const cases = [4.5, 1e20, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 2, NaN, Infinity, 1, 5, 2048, Number.MAX_SAFE_INTEGER];
  for (const vehicleId of cases) {
    let intParamAccepts = true;
    try { intParam(vehicleId, "vehicle id", 1); } catch { intParamAccepts = false; }
    assert.equal(guard(vehicleId), intParamAccepts,
      `guard and intParam disagree on ${vehicleId}: guard=${guard(vehicleId)} intParam=${intParamAccepts}`);
  }
});

test("vehiclePermissionsRoute uses that guard, not a bare isFinite check", () => {
  const body = routeBody("vehiclePermissionsRoute");
  assert.match(body, /!Number\.isInteger\(vehicleId\)[\s\S]*?vehicleId > Number\.MAX_SAFE_INTEGER/,
    "vehiclePermissionsRoute must match intParam's contract before the try block");
  assert.doesNotMatch(body, /Number\.isFinite\(vehicleId\) \|\| vehicleId < 1/,
    "vehiclePermissionsRoute still uses the looser isFinite guard, so bad input can reach the catch");
});

// An unsupported schema returns 200 with supported:false, and bad input is
// rejected above -- so a throw here is a query or connection failure, which is
// ours, not the caller's.
test("vehiclePermissionsRoute answers a genuine failure with 500, not 400", () => {
  const body = routeBody("vehiclePermissionsRoute");
  const catchBlock = body.slice(body.indexOf("} catch (error) {"));
  assert.match(catchBlock, /json\(res, 500,/, "vehiclePermissionsRoute must report a real failure as 500");
  assert.doesNotMatch(catchBlock, /json\(res, 400,/, "vehiclePermissionsRoute must not report a real failure as 400");
  assert.match(catchBlock, /supported: false/);
  assert.match(catchBlock, /error: redact\(/);
  assert.match(catchBlock, /reason: redact\(/);
});

// The id check has to stay outside the try, or a rejected id would be counted
// as a server fault by the block above.
test("vehiclePermissionsRoute keeps id validation on 400, before the try", () => {
  const body = routeBody("vehiclePermissionsRoute");
  const guardAt = body.indexOf("Invalid vehicle ID");
  const tryAt = body.indexOf("try {");
  assert.notEqual(guardAt, -1, "vehiclePermissionsRoute lost its invalid-id response");
  assert.ok(guardAt < tryAt, "vehiclePermissionsRoute must reject a bad id before the try block");
  assert.match(body.slice(0, tryAt), /json\(res, 400, \{ error: "Invalid vehicle ID" \}\)/);
});

test("vehicleSetPermissionsRoute uses the same strict guard before its directDbMutation call", () => {
  const body = routeBody("vehicleSetPermissionsRoute");
  assert.match(body, /!Number\.isInteger\(vehicleId\)[\s\S]*?vehicleId > Number\.MAX_SAFE_INTEGER/);
  const guardAt = body.indexOf("Invalid vehicle ID");
  const mutationAt = body.indexOf("directDbMutation");
  assert.ok(guardAt !== -1 && guardAt < mutationAt, "vehicleSetPermissionsRoute must reject a bad id before mutating");
});
