import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createInFlightShare } from "../src/inFlightShare.js";
import { bridgeActionStartsNewGeneration } from "../src/bridgeReadActions.js";

const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const routeSource = source.slice(source.indexOf("async function addonBridgeRoute("), source.indexOf("// Typed scheduler actions:"));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Exercise the actual route and dispatch, with controlled database calls.
// No database, player data, or live Console is used.
function bridgeFixture() {
  const reads = createInFlightShare();
  const pendingReads = [];
  const pendingWrites = [];
  const audits = [];
  const permissions = [];
  let rateChecks = 0;
  const duneDb = {
    addonLeadershipPlayers: () => {
      const gate = deferred();
      pendingReads.push(gate);
      return gate.promise;
    },
    runSql: () => {
      const gate = deferred();
      pendingWrites.push(gate);
      return gate.promise;
    }
  };
  const dependencies = {
    bridgeReads: reads,
    shareInFlight: (key, load) => reads.share(key, load),
    bridgeActionStartsNewGeneration,
    config: { mockMode: true },
    EDA_EXCHANGE_BOT_ADDON_ID: "retired",
    edaRetirement: { retired: false },
    bridgeRateLimiter: { check: () => { rateChecks++; return { allowed: true }; }, record: () => {} },
    readJson: async (req) => req.body,
    assertInstalledAddonPermission: (_config, id, permission) => {
      permissions.push({ id, permission });
      if (id === "denied") throw new Error("Permission denied");
      return { id, permission };
    },
    duneDb,
    db: {},
    audit: (_config, _req, _action, detail) => audits.push(detail),
    json: (_res, status, body) => ({ status, body }),
    hasExecutableStatement: () => true,
    isReadOnlySql: () => false,
    applyMutationRateLimit: () => true,
    resolveClientIp: () => "127.0.0.1"
  };
  const route = new Function(...Object.keys(dependencies), `${routeSource}\nreturn addonBridgeRoute;`)(...Object.values(dependencies));
  function request(action, id = "allowed") {
    const res = new EventEmitter();
    const req = { socket: { remoteAddress: "127.0.0.1" }, body: { action, query: "update dune.test set value = 1" } };
    const result = route(req, res, `/api/addons/installed/${id}/bridge`);
    return { res, result };
  }
  return { request, pendingReads, pendingWrites, audits, permissions, rateChecks: () => rateChecks };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("identical bridge reads share their query but retain individual authorization, rate limits and audit rows", async () => {
  const f = bridgeFixture();
  const a = f.request("players.summary.list", "one");
  const b = f.request("players.summary.list", "two");
  await tick();
  assert.equal(f.pendingReads.length, 1);
  f.pendingReads[0].resolve({ rows: ["current"] });
  const responses = await Promise.all([a.result, b.result]);
  assert.deepEqual(responses.map((r) => r.body.result), [{ rows: ["current"] }, { rows: ["current"] }]);
  assert.equal(f.rateChecks(), 2);
  assert.equal(f.permissions.length, 2);
  assert.deepEqual(f.audits.map((a) => a.id), ["one", "two"]);
  await assert.rejects(f.request("players.summary.list", "denied").result, /Permission denied/);
  assert.equal(f.pendingReads.length, 1);
});

test("a disconnected write invalidates reads when the database operation finishes", async () => {
  const f = bridgeFixture();
  const write = f.request("database.execute");
  await tick();
  assert.equal(f.pendingWrites.length, 1);
  write.res.emit("close");
  const during = f.request("players.summary.list");
  await tick();
  assert.equal(f.pendingReads.length, 1);
  f.pendingWrites[0].resolve({ rowCount: 1 });
  await write.result;
  const after = f.request("players.summary.list");
  await tick();
  assert.equal(f.pendingReads.length, 2, "a post-write request must not join a pre-commit read");
  f.pendingReads[0].resolve({ rows: ["before"] });
  f.pendingReads[1].resolve({ rows: ["after"] });
  assert.deepEqual((await during.result).body.result, { rows: ["before"] });
  assert.deepEqual((await after.result).body.result, { rows: ["after"] });
});

test("failed writes also end their generation without requiring a response close event", async () => {
  const f = bridgeFixture();
  const write = f.request("database.execute");
  await tick();
  // Model a failed operation after it has started, independently of transport.
  const rejection = assert.rejects(write.result, /Write failed/);
  const during = f.request("players.summary.list");
  await tick();
  f.pendingWrites[0].reject(new Error("Write failed"));
  await rejection;
  const after = f.request("players.summary.list");
  await tick();
  assert.equal(f.pendingReads.length, 2);
  for (const read of f.pendingReads) read.resolve({ rows: [] });
  await Promise.all([during.result, after.result]);
});
