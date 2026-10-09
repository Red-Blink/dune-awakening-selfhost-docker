import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRealtime, parseAgentUrl, RealtimeError } from "../src/services/realtime.js";
import { actionForRoute } from "../src/actions.js";
import { scopeCatalog, normalizeScopes } from "../src/apiKeyScopes.js";
import { DEFAULT_POLICIES, evaluate } from "../src/policy.js";

const SNAP = {
  gen: 1, t: 1,
  sources: [{ pid: 4242, map: "Survival_1", partition: 1, ready: true, n: 3, scans: 2, scanMs: 4800, ageMs: 5 }],
  objects: [
    { i: 1, k: "worm", c: "BP_Crea_SandwormArrakis_C", s: 0, x: 1, y: 2, z: 3 },
    { i: 2, k: "npc", c: "BP_Npc_SoldierBase_C", s: 0, x: 4, y: 5, z: 6 },
    { i: 3, k: "player", c: "BP_Player_C", s: 0, x: 7, y: 8, z: 9 }
  ]
};
const POS = { gen: 1, t: 2, d: [[1, 10, 20, 30], [3, 70, 80, 90]], r: [] };

// Stand-in for mvagent on loopback.
async function fakeAgent() {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") return res.end(JSON.stringify({ ok: true, ready: 1, sources: SNAP.sources }));
    if (req.url.startsWith("/api/objects")) {
      const kinds = new URL(req.url, "http://x").searchParams.get("kinds").split(",");
      return res.end(JSON.stringify({ ...SNAP, objects: SNAP.objects.filter((o) => kinds.includes(o.k)) }));
    }
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: snap\ndata: ${JSON.stringify(SNAP)}\n\n`);
      const tick = setInterval(() => res.write(`event: pos\ndata: ${JSON.stringify(POS)}\n\n: keepalive\n\n`), 20);
      req.on("close", () => clearInterval(tick));
      return undefined;
    }
    res.statusCode = 404;
    return res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// Runs realtime.stream behind a real HTTP server and collects SSE events.
async function openStream(realtime, options) {
  const front = http.createServer((req, res) => realtime.stream(req, res, options));
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  const events = [];
  const done = new Promise((resolve) => {
    http.get(`http://127.0.0.1:${front.address().port}/`, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (name) events.push({ name, data: JSON.parse(data) });
        }
      });
      res.on("end", () => resolve(res.statusCode));
      res.on("error", () => resolve(res.statusCode));
    });
  });
  return { front, events, done };
}

test("the agent address must be plain HTTP on loopback", () => {
  assert.equal(parseAgentUrl(undefined).href, "http://127.0.0.1:8796/");
  for (const ok of ["http://127.0.0.1:9000", "http://localhost:8796", "http://[::1]:8796"]) assert.doesNotThrow(() => parseAgentUrl(ok), ok);
  for (const bad of ["https://127.0.0.1:8796", "http://10.0.0.5:8796", "http://example.org:8796", "http://u:p@127.0.0.1:8796", "nope"]) {
    assert.throws(() => parseAgentUrl(bad), RealtimeError, bad);
  }
});

test("health and objects: no PIDs, players only with players:read", async () => {
  const agent = await fakeAgent();
  try {
    const realtime = createRealtime({ agentUrl: agent.url });
    const health = await realtime.health();
    assert.equal(health.available, true);
    assert.equal(health.sources[0].pid, undefined);
    assert.equal(health.sources[0].map, "Survival_1");
    const without = await realtime.objects({ allowPlayers: false });
    assert.deepEqual(without.objects.map((o) => o.k).sort(), ["npc", "worm"]);
    const withPlayers = await realtime.objects({ allowPlayers: true });
    assert.ok(withPlayers.objects.some((o) => o.k === "player"));
  } finally {
    agent.server.close();
  }
});

test("health reports unavailable when no agent runs", async () => {
  const realtime = createRealtime({ agentUrl: "http://127.0.0.1:1" });
  await assert.rejects(realtime.health(), (error) => error instanceof RealtimeError && error.status === 503);
});

test("stream without players:read drops player objects and their positions", async () => {
  const agent = await fakeAgent();
  const realtime = createRealtime({ agentUrl: agent.url, recheckMs: 50 });
  let allowed = true;
  const { front, events, done } = await openStream(realtime, { principal: "apikey:a", allowPlayers: () => false, stillAllowed: () => allowed });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snap = events.find((e) => e.name === "snap");
    assert.deepEqual(snap.data.objects.map((o) => o.i), [1, 2]);
    assert.equal(snap.data.sources[0].pid, undefined);
    const pos = events.filter((e) => e.name === "pos");
    assert.ok(pos.length > 0);
    assert.ok(pos.every((e) => e.data.d.every((d) => d[0] !== 3)), "a player position leaked");
    // revoking the scope (or the key) ends the open stream
    allowed = false;
    await done;
    assert.equal(realtime.openStreams(), 0);
  } finally {
    front.close();
    agent.server.close();
  }
});

test("removing only players:read ends a stream without waiting for another snapshot", async () => {
  const agent = await fakeAgent();
  const realtime = createRealtime({ agentUrl: agent.url, recheckMs: 20 });
  let players = true;
  const { front, events, done } = await openStream(realtime, {
    principal: "apikey:downgrade", allowPlayers: () => players, stillAllowed: () => true
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(events.some(e => e.name === "pos" && e.data.d.some(d => d[0] === 3)));
    players = false;
    await Promise.race([done, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("scope downgrade did not end the stream")), 1000);
      timer.unref();
    })]);
    const count = events.length;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(events.length, count);
    assert.equal(realtime.openStreams(), 0);
  } finally {
    front.closeAllConnections(); front.close(); agent.server.close();
  }
});

test("stream with players:read keeps players", async () => {
  const agent = await fakeAgent();
  const realtime = createRealtime({ agentUrl: agent.url });
  let stop = false;
  const { front, events, done } = await openStream(realtime, { principal: "apikey:b", allowPlayers: () => true, stillAllowed: () => !stop });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(events.find((e) => e.name === "snap").data.objects.some((o) => o.k === "player"));
    assert.ok(events.some((e) => e.name === "pos" && e.data.d.some((d) => d[0] === 3)));
  } finally {
    stop = true;
    front.closeAllConnections();
    front.close();
    agent.server.close();
    await done;
  }
});

test("open streams are limited per key", async () => {
  const agent = await fakeAgent();
  const realtime = createRealtime({ agentUrl: agent.url, maxStreamsPerPrincipal: 1 });
  const first = await openStream(realtime, { principal: "apikey:c", allowPlayers: () => false, stillAllowed: () => true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await openStream(realtime, { principal: "apikey:c", allowPlayers: () => false, stillAllowed: () => true });
    assert.equal(await second.done, 429);
    second.front.close();
  } finally {
    first.front.closeAllConnections();
    first.front.close();
    agent.server.close();
  }
});

test("Realtime Data is its own read-only API key scope", () => {
  for (const route of ["/api/realtime/healthz", "/api/realtime/objects", "/api/realtime/stream"]) {
    assert.equal(actionForRoute(route, "GET"), "realtime:read", route);
  }
  const entry = scopeCatalog().find((candidate) => candidate.namespace === "realtime");
  assert.ok(entry, "realtime missing from the API key scope catalog");
  assert.deepEqual(entry.readActions, ["realtime:read"]);
  assert.equal(entry.supportsWrite, false);
  assert.deepEqual(normalizeScopes({ realtime: "read" }), { realtime: "read" });
  // maps:read alone does not grant it
  assert.ok(!scopeCatalog().find((candidate) => candidate.namespace === "maps").readActions.includes("realtime:read"));
});

test("tiers: owner and admin may read Realtime Data, moderators and below may not", () => {
  const docs = DEFAULT_POLICIES;
  assert.equal(evaluate({ tier: "owner" }, "realtime:read", docs), true);
  assert.equal(evaluate({ tier: "admin" }, "realtime:read", docs), true);
  for (const tier of ["moderator", "player", "observer"]) assert.equal(evaluate({ tier }, "realtime:read", docs), false, tier);
});

test("the stream re-checks the key while it is open", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const route = source.slice(source.indexOf("function realtimeStreamRoute"), source.indexOf("async function apiKeyCreateRoute"));
  assert.match(route, /apiKeys\.authenticate\(req\)/);
  assert.match(route, /stillAllowed: \(\) => may\("realtime:read"\)/);
  assert.match(route, /allowPlayers: \(\) => may\("players:read"\)/);
});
