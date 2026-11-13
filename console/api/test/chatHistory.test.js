import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createChatHistory, parseChatMessage } from "../src/services/chatHistory.js";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";
import { scopeAllowsAction } from "../src/apiKeyScopes.js";
import { readDirectorRmqCredentials, requestRmqGameHttp } from "../src/rmq.js";

function message(channel = "Map", id = "fixture-1", extra = {}) {
  const exchange = { Map: "chat.map", Guild: "chat.guild.fixture", Proximity: "chat.proximity", Whispers: "chat.whispers", Party: "chat.party" }[channel];
  return { payload_encoding: "string", routing_key: channel === "Whispers" ? "RecipientFixture" : "HaggaBasin.1", properties: {
    type: "text_chat", user_id: "SenderFixture", headers: { redirect_exchange: exchange }
  }, payload: JSON.stringify({ Type: "TextChat", Content: JSON.stringify({ m_Id: id, m_ChannelType: channel,
    m_Message: { m_UnlocalizedMessage: "Hello fixture", m_LocalizedMessage: { private: "MUST_DROP" } },
    m_OriginLocation: { synthetic: "MUST_DROP" }, m_SpoofedUserNameFrom: { m_UnlocalizedName: "Fixture Name" }, ...extra }) }) };
}
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "dune-chat-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let batch = [], clock = Date.parse("2026-11-13T00:00:00Z");
  const request = async (method, path, body) => { calls.push({ method, path, body }); return path.endsWith("/get") ? batch.splice(0, 50) : method === "GET" ? [] : null; };
  const config = { generatedDir: root, repoRoot: root };
  const service = createChatHistory(config, { request, now: () => clock, ...options });
  return { service, calls, root, config, request, send: (...values) => { batch.push(...values); }, advance: ms => { clock += ms; } };
}
const enabled = { enabled: true, retentionDays: 7 };

test("strict parser accepts observed envelopes and drops coordinates/unknown payloads", () => {
  for (const channel of ["Map", "Guild", "Proximity"]) {
    const input = message(channel);
    const row = parseChatMessage(input);
    assert.equal(row.channel, channel);
    assert.equal(row.sender, "SenderFixture");
    assert.doesNotMatch(JSON.stringify(row), /MUST_DROP|OriginLocation|LocalizedMessage/);
    input.payload_encoding = "base64"; input.payload = Buffer.from(input.payload).toString("base64");
    assert.equal(parseChatMessage(input).id, row.id);
  }
  assert.equal(parseChatMessage(message("Party")), null);
  assert.equal(parseChatMessage(message("Whispers")), null);
  assert.equal(parseChatMessage({ ...message(), payload: "bad-json" }), null);
  assert.equal(parseChatMessage({ ...message(), payload_bytes: 20000 }), null);
  assert.equal(parseChatMessage({ ...message(), properties: { ...message().properties, user_id: "" } }), null);
  assert.equal(parseChatMessage(message("Map", "fixture", { m_Message: { m_LocalizedMessage: { m_Key: "unverified" } } })), null);
  const mismatch = message(); mismatch.properties.headers.redirect_exchange = "chat.whispers";
  assert.equal(parseChatMessage(mismatch), null);
  const nativeName = message("Map", "native-name", { m_SpoofedUserNameFrom: {}, m_FuncomIdFrom: "NativeFixture#1234" });
  assert.equal(parseChatMessage(nativeName).senderName, "NativeFixture#1234");
  assert.equal(parseChatMessage(nativeName).sender, "SenderFixture");
});

test("collection defaults off and never touches the game/router queue", async t => {
  const f = fixture(t);
  await f.service.tick();
  assert.equal(f.service.status().settings.enabled, false);
  assert.deepEqual(f.calls, []);
  await f.service.save(enabled);
  f.send(message()); await f.service.tick();
  assert.equal(f.service.read().total, 1);
  assert.ok(f.calls.every(c => !c.path.includes("queue.intercept")));
  const declared = f.calls.find(c => c.method === "PUT");
  assert.match(declared.path, /dune-console-chat-[a-f0-9-]+$/);
  assert.deepEqual(declared.body.arguments, { "x-expires": 60000, "x-message-ttl": 60000, "x-max-length": 500, "x-max-length-bytes": 2097152, "x-overflow": "drop-head" });
  assert.ok(f.calls.some(c => c.path.includes("/e/chat.intercept/e/dune-console-chat-")));
  assert.ok(!f.calls.some(c => c.path.includes("/e/chat.intercept/q/")), "no unfiltered topic binding to the recorder queue");
  assert.ok(f.calls.some(c => c.method === "PUT" && c.body?.type === "headers" && c.body.internal && c.body.auto_delete));
  const allowedHeaders = f.calls.filter(c => c.body?.arguments?.redirect_exchange).map(c => c.body.arguments.redirect_exchange);
  assert.deepEqual(allowedHeaders, ["chat.map", "chat.proximity"]);
  assert.equal(statSync(join(f.root, "chat-history.json")).mode & 0o777, 0o600);
});

test("whispers are rejected and legacy preview records/settings are permanently purged", async t => {
  const f = fixture(t);
  const publicRow = parseChatMessage(message(), Date.parse("2026-11-13T00:00:00Z"));
  const privateRow = { ...publicRow, id: "f".repeat(64), channel: "Whispers", text: "PrivateMessageFixture", recipient: "PrivateRecipientFixture" };
  const file = join(f.root, "chat-history.json");
  writeFileSync(file, JSON.stringify({ settings: { ...enabled, whispers: true }, rows: [publicRow, privateRow] }));
  assert.equal(f.service.read().total, 1);
  assert.deepEqual(f.service.status().settings, enabled);
  assert.equal(f.service.read({ q: "Private" }).total, 0);
  assert.throws(() => f.service.read({ channel: "Whispers" }), /filters/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /[Ww]hispers|PrivateMessageFixture|PrivateRecipientFixture/);
  f.send(message("Whispers")); await f.service.tick();
  assert.equal(f.service.read().total, 1);
});

test("history survives restart, deduplicates and expires even when collection is off", async t => {
  const f = fixture(t);
  await f.service.save(enabled); f.send(message(), message()); await f.service.tick();
  assert.equal(f.service.read().total, 1);
  const restarted = createChatHistory(f.config, { request: f.request, now: () => Date.parse("2026-11-13T00:00:00Z") });
  assert.equal(restarted.read().total, 1);
  assert.equal(restarted.status().state, "starting");
  await f.service.save({ ...enabled, enabled: false });
  f.advance(8 * 86400000); await f.service.tick();
  assert.equal(f.service.read().total, 0);
  assert.equal(JSON.parse(readFileSync(join(f.root, "chat-history.json"))).rows.length, 0);
});

test("filtering, pagination and bounded retention keep newest rows", async t => {
  const f = fixture(t);
  await f.service.save(enabled);
  for (let i = 0; i < 3; i++) { f.send(...Array.from({ length: 50 }, (_, j) => message("Map", `message-${i * 50 + j}`))); await f.service.tick(); }
  assert.equal(f.service.read({ limit: 25, page: 1 }).rows.length, 25);
  assert.equal(f.service.read({ q: "HELLO", context: "HaggaBasin.1" }).total, 150);
  assert.equal(f.service.read({ channel: "Guild" }).total, 0);
  for (const query of [{ page: -1 }, { page: "NaN" }, { limit: 50000 }, { channel: "Party" }]) assert.throws(() => f.service.read(query));
  // Seed a full allowed history near the byte limit; a new capture must evict
  // oldest entries rather than exceed either storage bound.
  const row = parseChatMessage(message(), Date.parse("2026-11-13T00:00:00Z"));
  const file = join(f.root, "chat-history.json");
  writeFileSync(file, JSON.stringify({ settings: enabled, rows: Array.from({ length: 5000 }, (_, i) => ({ ...row, id: i.toString(16).padStart(64, "0"), text: "x".repeat(1500) })) }));
  const restarted = createChatHistory(f.config, { request: f.request, now: () => Date.parse("2026-11-13T00:00:01Z") });
  f.send(message("Map", "newest")); await restarted.tick();
  assert.equal(restarted.read().total, 5000);
  assert.equal(restarted.read().rows[0].text, "Hello fixture");
  assert.ok(statSync(file).size < 10 * 1024 * 1024);
  for (let i = 0; i < 12; i++) {
    f.send(...Array.from({ length: 50 }, (_, j) => message("Map", `unicode-${i}-${j}`, { m_Message: { m_UnlocalizedMessage: "界".repeat(2000) } })));
    await restarted.tick();
  }
  assert.ok(restarted.read().total < 5000, "encoded byte cap evicts rows before the count cap");
  assert.ok(statSync(file).size < 10 * 1024 * 1024);
});

test("disabling during capture and clearing do not resurrect in-flight messages", async t => {
  let release;
  const calls = [];
  const f = fixture(t, { request: async (method, path) => {
    calls.push({ method, path });
    if (method === "GET") return [];
    if (path.endsWith("/get")) return new Promise(resolve => { release = resolve; });
    return null;
  } });
  await f.service.save(enabled);
  const capturing = f.service.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const disabling = f.service.save({ ...enabled, enabled: false });
  await new Promise(resolve => setImmediate(resolve));
  release([message()]); await Promise.all([capturing, disabling]);
  assert.equal(f.service.read().total, 0);
  await f.service.clear();
  assert.ok(calls.filter(c => c.method === "DELETE").length >= 3);
});

test("broker failures reconnect by reasserting only the recorder's own queue", async t => {
  let fail = true;
  const f = fixture(t, { request: async (method, path) => {
    if (method === "GET") return [];
    if (path.endsWith("/get") && fail) { fail = false; throw new Error("fixture-disconnect"); }
    return path.endsWith("/get") ? [message()] : null;
  } });
  await f.service.save(enabled); await f.service.tick();
  assert.equal(f.service.status().state, "unavailable");
  await f.service.tick();
  assert.equal(f.service.status().state, "recording");
  assert.equal(f.service.read().total, 1);
});

test("corrupt/oversized history fails closed without overwriting operator data", t => {
  const f = fixture(t);
  const file = join(f.root, "chat-history.json");
  writeFileSync(file, "broken fixture data");
  assert.equal(f.service.status().state, "storage-error");
  assert.throws(() => f.service.save(enabled), /left intact/);
  assert.equal(readFileSync(file, "utf8"), "broken fixture data");
});

test("IAM exposes no whisper endpoint or action; ordinary admins cannot collect or erase", () => {
  assert.equal(actionForRoute("/api/chat/history", "GET"), "chat:read");
  assert.equal(actionForRoute("/api/chat/whispers", "GET"), null);
  assert.equal(actionForRoute("/api/chat/history", "DELETE"), "chat:configure");
  assert.equal(evaluate({ tier: "admin" }, "chat:read"), true);
  assert.equal(evaluate({ tier: "admin" }, "chat:configure"), false);
  assert.equal(evaluate({ tier: "observer" }, "chat:read"), false);
  assert.equal(scopeAllowsAction("chat", "read", "chat:configure"), false);
});

test("management helper reuses credentials and never propagates response secrets", async t => {
  const oldUser = process.env.DUNE_RMQ_ADMIN_USER, oldPass = process.env.DUNE_RMQ_ADMIN_PASSWORD;
  process.env.DUNE_RMQ_ADMIN_USER = "fixture-user"; process.env.DUNE_RMQ_ADMIN_PASSWORD = "fixture-secret";
  t.after(() => { if (oldUser === undefined) delete process.env.DUNE_RMQ_ADMIN_USER; else process.env.DUNE_RMQ_ADMIN_USER = oldUser;
    if (oldPass === undefined) delete process.env.DUNE_RMQ_ADMIN_PASSWORD; else process.env.DUNE_RMQ_ADMIN_PASSWORD = oldPass; });
  let observed;
  const result = await requestRmqGameHttp({}, "POST", "/api/test", { fixture: true }, { fetchImpl: async (_, options) => { observed = options; return new Response("[]"); } });
  assert.deepEqual(result, []);
  assert.equal(observed.redirect, "error");
  assert.equal(observed.headers.Authorization, `Basic ${Buffer.from("fixture-user:fixture-secret").toString("base64")}`);
  await assert.rejects(requestRmqGameHttp({}, "GET", "/api/test", undefined, { fetchImpl: async () => new Response("fixture-secret", { status: 401 }) }), error => !error.message.includes("fixture-secret"));
});

test("rotated-tail fallback reads bounded director logs privately, including split credentials", async () => {
  let killed = false;
  const creds = await readDirectorRmqCredentials({ spawnImpl: (command, args, options) => {
    assert.equal(command, "docker"); assert.deepEqual(args, ["logs", "dune-director"]);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => { killed = true; };
    process.nextTick(() => { child.stdout.write("Generated new admin credentials: bgd.fixture.admin / abc"); child.stdout.write("123=\n"); });
    return child;
  } });
  assert.deepEqual(creds, { user: "bgd.fixture.admin", pass: "abc123=" }); assert.ok(killed);
  const absent = await readDirectorRmqCredentials({ spawnImpl: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
    process.nextTick(() => child.stdout.write("x".repeat(1024 * 1024)));
    return child;
  } });
  assert.equal(absent, null);
});
