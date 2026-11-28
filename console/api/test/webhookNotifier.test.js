import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { appendRestartHistory, readRestartRowsSince } from "../src/services/restartHistory.js";
import {
  buildPayload,
  createWebhookNotifier,
  deliverWebhook,
  parseConsoleUpdate,
  parseGameUpdate,
  restartEvent,
  validateWebhookUrl
} from "../src/services/webhookNotifier.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const DISCORD_URL = "https://discord.com/api/webhooks/123456/abcDEF-token_xyz";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "webhooks-"));
  mkdirSync(join(root, "runtime/generated"), { recursive: true });
  writeFileSync(join(root, "VERSION"), "v9.9.9\n");
  return { root, history: join(root, "runtime/generated/restart-history.jsonl") };
}

function restartRow(id, over = {}) {
  return { id, startedAt: "2026-11-01T00:00:00Z", finishedAt: `2026-11-01T00:01:${String(id).padStart(2, "0").slice(-2)}Z`, durationSeconds: 75, scope: "battlegroup", target: "Battlegroup", source: "Scheduled", reason: "Scheduled restart", result: "Succeeded", ...over };
}

function notifierFor(root, history, over = {}) {
  return createWebhookNotifier({
    repoRoot: root,
    restartHistoryFile: history,
    version: "v9.9.9",
    readGameUpdate: async () => ({ code: 0, stdout: "" }),
    readConsoleUpdate: async () => ({ code: 0, stdout: "" }),
    firstUpdateCheckDelayMs: 0,
    ...over
  });
}

function recordingFetch(status = 204) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), init }); return { status, headers: new Map() }; };
  return { calls, fetchImpl };
}

test("webhook URLs must be public HTTPS, and Discord URLs must be real webhook paths", () => {
  assert.equal(validateWebhookUrl(DISCORD_URL, "discord"), DISCORD_URL);
  assert.equal(validateWebhookUrl("https://hooks.example.com/x", "generic"), "https://hooks.example.com/x");
  for (const bad of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://10.1.2.3/x", "https://[::1]/x", "https://localhost/x", "https://user:pw@example.com/x", "not a url", ""]) {
    assert.throws(() => validateWebhookUrl(bad, "generic"), /Webhook URL/, bad);
  }
  assert.throws(() => validateWebhookUrl("https://evil.example.com/api/webhooks/1/abc", "discord"), /Discord webhook URL/);
});

test("settings never expose stored URLs and keep the URL when saved without one", () => {
  const { root, history } = repo();
  const notifier = notifierFor(root, history);
  const view = notifier.save({ updateCheckMinutes: 30, webhooks: [{ name: "Ops", type: "discord", url: DISCORD_URL, events: ["serverRestart"] }] });
  const hook = view.webhooks[0];
  assert.equal(hook.hasUrl, true);
  assert.equal(hook.url, undefined);
  assert.match(hook.urlHint, /^discord\.com\/…/);
  assert.ok(!JSON.stringify(view).includes("abcDEF-token_xyz"));
  assert.equal(statSync(join(root, "runtime/generated/webhook-settings.json")).mode & 0o777, 0o600);

  const resaved = notifier.save({ updateCheckMinutes: 30, webhooks: [{ id: hook.id, name: "Renamed", type: "discord", events: ["gameUpdate"] }] });
  assert.equal(resaved.webhooks[0].name, "Renamed");
  const stored = JSON.parse(readFileSync(join(root, "runtime/generated/webhook-settings.json"), "utf8"));
  assert.equal(stored.webhooks[0].url, DISCORD_URL);

  assert.throws(() => notifier.save({ webhooks: [{ name: "No URL", type: "generic" }] }), /needs a URL/);
  assert.throws(() => notifier.save({ webhooks: [{ name: "x", url: DISCORD_URL, events: ["bogus"] }] }), /events/);
  assert.throws(() => notifier.save({ updateCheckMinutes: 15, webhooks: [] }), /updateCheckMinutes/);
  assert.deepEqual(notifier.view().webhooks.map((entry) => entry.name), ["Renamed"]);
  // A restarted Console reads the same settings back from disk.
  assert.deepEqual(notifierFor(root, history).view().webhooks.map((entry) => entry.name), ["Renamed"]);
});

test("restart journal tail starts at the end, returns new rows, and survives trimming", () => {
  const { history } = repo();
  appendRestartHistory(history, restartRow("old"));
  let { rows, cursor } = readRestartRowsSince(history, {});
  assert.deepEqual(rows, []);
  appendRestartHistory(history, restartRow("a"));
  appendRestartHistory(history, restartRow("b"));
  ({ rows, cursor } = readRestartRowsSince(history, cursor));
  assert.deepEqual(rows.map((row) => row.id), ["a", "b"]);
  ({ rows, cursor } = readRestartRowsSince(history, cursor));
  assert.deepEqual(rows, []);

  // Simulate the in-place trim: file shrinks, keeps "b", then gains "c".
  writeFileSync(history, `${JSON.stringify(restartRow("b"))}\n${JSON.stringify(restartRow("c"))}\n`);
  ({ rows, cursor } = readRestartRowsSince(history, cursor));
  assert.deepEqual(rows.map((row) => row.id), ["c"]);
});

test("restart events label manual and automatic triggers", () => {
  const manual = restartEvent({ ...restartRow("m"), source: "Console", reason: "Manual restart" });
  assert.equal(manual.title, "Server restarted");
  assert.equal(manual.fields.find((field) => field.name === "Trigger").value, "Manual (Console)");
  const failed = restartEvent({ ...restartRow("f"), result: "Failed" });
  assert.equal(failed.title, "Server restart failed");
  assert.equal(failed.fields.find((field) => field.name === "Trigger").value, "Automatic (scheduled restart)");
  assert.equal(failed.fields.find((field) => field.name === "Duration").value, "1m 15s");
});

test("the update scripts still print the version lines the parsers read", () => {
  const update = readFileSync(join(REPO_ROOT, "runtime/scripts/update.sh"), "utf8");
  const selfUpdate = readFileSync(join(REPO_ROOT, "runtime/scripts/self-update.sh"), "utf8");
  assert.match(update, /echo "Local build:  \$local_build"/);
  assert.match(update, /echo "Remote build: \$remote_build"/);
  assert.match(selfUpdate, /echo "Current stack version: \$CURRENT_VERSION"/);
  assert.match(selfUpdate, /echo "Latest release:        \$latest"/);
  assert.match(selfUpdate, /echo "GitHub repo:           \$GITHUB_REPO"/);
});

test("update check output is parsed into installed and latest versions", () => {
  assert.deepEqual(parseGameUpdate("Local build:  2162777\nRemote build: 2173753\nUpdate available.\n"), { installed: "2162777", latest: "2173753" });
  assert.deepEqual(parseConsoleUpdate("Current stack version: v1.4.52\nLatest release:        v1.4.69\nGitHub repo:           Red-Blink/dune-awakening-selfhost-docker\n"),
    { installed: "v1.4.52", latest: "v1.4.69", repository: "Red-Blink/dune-awakening-selfhost-docker" });
});

test("Discord payloads disable mentions and generic payloads carry structured data", () => {
  const event = restartEvent({ ...restartRow("p"), target: "@everyone" });
  const discord = buildPayload("discord", event, "Dune Docker v1");
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
  assert.equal(discord.embeds[0].footer.text, "Dune Docker v1");
  const generic = buildPayload("generic", event, "Dune Docker v1");
  assert.equal(generic.event, "serverRestart");
  assert.equal(generic.fields.Trigger, "Automatic (scheduled restart)");
  assert.equal(generic.data.id, "p");
});

test("delivery reports HTTP failures, never follows redirects, and retries one 429", async () => {
  const hook = { type: "generic", url: "https://hooks.example.com/x" };
  const { calls, fetchImpl } = recordingFetch(500);
  const failed = await deliverWebhook(hook, restartEvent(restartRow("x")), { fetchImpl });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /HTTP 500/);
  assert.equal(calls[0].init.redirect, "manual");

  let attempts = 0;
  const retried = await deliverWebhook(hook, restartEvent(restartRow("y")), {
    fetchImpl: async () => (++attempts === 1 ? { status: 429, headers: new Map([["retry-after", "0"]]) } : { status: 204, headers: new Map() })
  });
  assert.equal(retried.ok, true);
  assert.equal(attempts, 2);

  const thrown = await deliverWebhook(hook, restartEvent(restartRow("z")), { fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /ENOTFOUND/);
});

test("notifier announces new restarts and each new update once", async () => {
  const { root, history } = repo();
  notifierFor(root, history).save({ updateCheckMinutes: 30, webhooks: [
    { name: "All", type: "generic", url: "https://hooks.example.com/all", events: ["serverRestart", "gameUpdate", "consoleUpdate"], includeMapRestarts: true },
    { name: "Battlegroup only", type: "discord", url: DISCORD_URL, events: ["serverRestart"] },
    { name: "Off", type: "generic", url: "https://hooks.example.com/off", enabled: false }
  ] });
  appendRestartHistory(history, restartRow("before-start"));
  const { calls, fetchImpl } = recordingFetch();
  let clock = 1_000_000;
  let game = { code: 100, stdout: "Local build:  1\nRemote build: 2\n" };
  const notifier = notifierFor(root, history, { readGameUpdate: async () => game, fetchImpl, now: () => clock });

  await notifier.tick();
  // No replay of history; one game-update announcement to the subscribed hook.
  assert.deepEqual(calls.map((call) => [call.url, call.body.event]), [["https://hooks.example.com/all", "gameUpdate"]]);
  assert.equal(calls[0].body.fields["New build"], "2");

  calls.length = 0;
  appendRestartHistory(history, restartRow("bg", { source: "Console" }));
  appendRestartHistory(history, restartRow("map", { scope: "map", target: "Hagga Basin" }));
  clock += 31 * 60_000;
  await notifier.tick();
  const restartCalls = calls.filter((call) => call.url !== "https://hooks.example.com/all" || call.body.event === "serverRestart");
  assert.equal(restartCalls.filter((call) => call.url === DISCORD_URL).length, 1, "battlegroup-only hook skips map restarts");
  assert.equal(restartCalls.filter((call) => call.url === "https://hooks.example.com/all").length, 2);
  assert.ok(!calls.some((call) => call.url.endsWith("/off")));
  assert.ok(!calls.some((call) => call.body.event === "gameUpdate"), "same build is not announced twice");

  calls.length = 0;
  game = { code: 100, stdout: "Local build:  1\nRemote build: 3\n" };
  clock += 31 * 60_000;
  await notifier.tick();
  assert.deepEqual(calls.map((call) => call.body.event), ["gameUpdate"]);
  assert.equal(notifier.view().webhooks[0].lastDelivery.ok, true);
  assert.match(calls[0].body.footer, /v9\.9\.9/);

  // State survives a Console restart: a fresh notifier does not re-announce.
  calls.length = 0;
  const restarted = notifierFor(root, history, { readGameUpdate: async () => game, fetchImpl, now: () => clock });
  await restarted.tick();
  assert.deepEqual(calls, []);
});

test("test messages go only to a saved webhook", async () => {
  const { root, history } = repo();
  const { calls, fetchImpl } = recordingFetch();
  const notifier = notifierFor(root, history, { fetchImpl });
  const view = notifier.save({ webhooks: [{ name: "Ops", type: "discord", url: DISCORD_URL }] });
  const result = await notifier.sendTest(view.webhooks[0].id);
  assert.equal(result.ok, true);
  assert.equal(calls[0].body.embeds[0].title, "Webhook test");
  await assert.rejects(notifier.sendTest("missing"), /Save it before/);
});

test("Discord URLs with a versioned API path are accepted", () => {
  assert.equal(validateWebhookUrl("https://discord.com/api/v10/webhooks/1/abc", "discord"), "https://discord.com/api/v10/webhooks/1/abc");
});

test("delivery releases the response body", async () => {
  let cancelled = 0;
  const result = await deliverWebhook({ type: "generic", url: "https://hooks.example.com/x" }, restartEvent(restartRow("b")), {
    fetchImpl: async () => ({ status: 204, headers: new Map(), body: { cancel: async () => { cancelled += 1; } } })
  });
  assert.equal(result.ok, true);
  assert.equal(cancelled, 1);
});

test("a pending update reaches webhooks added later and is retried after a failed delivery", async () => {
  const { root, history } = repo();
  let failGeneric = true;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: url.includes("hooks.example.com") && failGeneric ? 500 : 204, headers: new Map() };
  };
  let clock = 1_000_000;
  const notifier = notifierFor(root, history, { readGameUpdate: async () => ({ code: 100, stdout: "Local build:  1\nRemote build: 2\n" }), fetchImpl, now: () => clock });
  const first = notifier.save({ updateCheckMinutes: 30, webhooks: [{ name: "Generic", type: "generic", url: "https://hooks.example.com/a", events: ["gameUpdate"] }] });
  await notifier.tick();
  assert.equal(calls.length, 1, "first attempt fails");

  // Adding a second webhook runs a check right away: B is new, A is retried.
  failGeneric = false;
  calls.length = 0;
  notifier.save({ updateCheckMinutes: 30, webhooks: [
    { id: first.webhooks[0].id, name: "Generic", type: "generic", events: ["gameUpdate"] },
    { name: "Discord", type: "discord", url: DISCORD_URL, events: ["gameUpdate"] }
  ] });
  await notifier.tick();
  assert.deepEqual(calls.map((call) => call.url).sort(), [DISCORD_URL, "https://hooks.example.com/a"]);

  // Both succeeded, so the next check stays quiet.
  calls.length = 0;
  clock += 31 * 60_000;
  await notifier.tick();
  assert.deepEqual(calls, []);
});

test("a slow update check does not hold back restart announcements", async () => {
  const { root, history } = repo();
  let releaseCheck;
  const { calls, fetchImpl } = recordingFetch();
  const notifier = notifierFor(root, history, {
    readGameUpdate: () => new Promise((done) => { releaseCheck = () => done({ code: 0, stdout: "" }); }),
    fetchImpl
  });
  notifier.save({ webhooks: [{ name: "All", type: "generic", url: "https://hooks.example.com/all" }] });
  const pending = notifier.tick();
  await new Promise((done) => setImmediate(done));
  appendRestartHistory(history, restartRow("during-check"));
  await notifier.tick();
  assert.deepEqual(calls.map((call) => call.body.data.id), ["during-check"]);
  releaseCheck();
  await pending;
});

test("settings replaced on disk (backup restore) are picked up on the next tick", async () => {
  const { root, history } = repo();
  const { calls, fetchImpl } = recordingFetch();
  const notifier = notifierFor(root, history, { fetchImpl });
  notifier.save({ webhooks: [{ name: "Old", type: "generic", url: "https://old.example.com/x", events: ["serverRestart"] }] });
  await notifier.tick();
  await new Promise((done) => setTimeout(done, 20));
  const settingsFile = join(root, "runtime/generated/webhook-settings.json");
  writeFileSync(settingsFile, JSON.stringify({ webhooks: [{ id: "restored", name: "Restored", type: "generic", url: "https://new.example.com/x", events: ["serverRestart"] }] }));
  appendRestartHistory(history, restartRow("after-restore"));
  await notifier.tick();
  assert.deepEqual(calls.map((call) => call.url), ["https://new.example.com/x"]);
  assert.deepEqual(notifier.view().webhooks.map((hook) => hook.name), ["Restored"]);
});
