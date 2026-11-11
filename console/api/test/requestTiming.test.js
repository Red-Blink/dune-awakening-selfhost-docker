import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequestTimingLogger, requestRouteLabel } from "../src/services/requestTiming.js";
import { createDiagnosticWriter } from "../src/services/diagnosticLog.js";

test("request diagnostics retain static routes and timing without request secrets or player IDs", () => {
  let wall = 100000, mono = 10;
  const rows = [];
  const observe = createRequestTimingLogger({ write: (row) => rows.push(row), now: () => wall, monotonic: () => mono });
  const request = { url: "/api/players/private-player-id/inventory?token=private-query&x=123", method: "GET",
    headers: { authorization: "Bearer private-credential", cookie: "private-cookie", "user-agent": "curl/8 private-agent" },
    authSession: { apiKeyId: "private-key-id", id: "private-session" }, body: { password: "private-body" } };
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
  observe(request, response);
  wall += 5000;
  mono += 3400;
  response.writableFinished = true;
  response.emit("finish");
  response.emit("close");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "console.request");
  assert.equal(rows[0].durationMs, 3400);
  assert.equal(rows[0].authentication, "api-key");
  assert.equal(rows[0].client, "cli");
  assert.notEqual(rows[0].at, rows[0].startedAt);
  assert.doesNotMatch(JSON.stringify(rows), /private-|Bearer|password|cookie/);
});

test("aborted responses are measured once and unknown paths never become log values", () => {
  const rows = [];
  const request = { url: "/api/secret-in-the-path?password=secret-query", method: "POST", headers: {} };
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
  createRequestTimingLogger({ write: row => rows.push(row) })(request, response);
  response.emit("close"); response.emit("finish");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 499);
  assert.equal(rows[0].route, "/api/*");
  assert.doesNotMatch(JSON.stringify(rows), /secret-in|secret-query/);
  assert.equal(requestRouteLabel("/api/maps/memory/live", "GET"), "/api/maps/memory/live");
  assert.doesNotMatch(requestRouteLabel("/api/backups/system/private-backup/download", "GET"), /private-backup/);
});

test("a broken diagnostic sink cannot break completion handlers", () => {
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
  createRequestTimingLogger({ write() { throw new Error("sink failure"); } })({ url: "/api/health", method: "GET" }, response);
  assert.doesNotThrow(() => response.emit("finish"));
});

test("diagnostics stop queueing on backpressure and report lost events after drain", () => {
  const stream = new EventEmitter();
  const rows = [];
  let accepts = false;
  stream.write = line => { rows.push(JSON.parse(line)); return accepts; };
  const write = createDiagnosticWriter({ stream });
  write({ event: "first" });
  for (let i = 0; i < 1000; i++) write({ event: "blocked" });
  assert.equal(rows.length, 1);
  assert.equal(stream.listenerCount("drain"), 1);
  accepts = true;
  stream.emit("drain");
  write({ event: "resumed" });
  assert.equal(rows[1].event, "diagnostics.dropped");
  assert.equal(rows[1].count, 1000);
  assert.equal(rows[2].event, "resumed");
});

test("request floods cannot create an unbounded diagnostic stream", () => {
  let clock = 1000;
  const rows = [];
  const stream = new EventEmitter();
  stream.write = line => { rows.push(JSON.parse(line)); return true; };
  const write = createDiagnosticWriter({ stream, now: () => clock, maxPerSecond: 3 });
  for (let i = 0; i < 1000; i++) write({ event: "poll" });
  assert.equal(rows.length, 3);
  clock += 1000;
  write({ event: "next" });
  assert.equal(rows[3].event, "diagnostics.dropped");
  assert.equal(rows[3].count, 997);
  assert.equal(rows[4].event, "next");
});
