import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  messageOfTheDayDeliveryPlan,
  normalizeSettings,
  primeMessageOfTheDayOnlineState,
  readMessageOfTheDay,
  restoreMessageOfTheDay,
  runMessageOfTheDayScan,
  saveMessageOfTheDay
} from "../src/services/messageOfTheDay.js";

function config() {
  const root = mkdtempSync(join(tmpdir(), "dune-motd-test-"));
  return {
    repoRoot: root,
    generatedDir: join(root, "runtime", "generated"),
    mockMode: true
  };
}

function onlinePlayer(overrides = {}) {
  return {
    actor_id: 6,
    action_player_id: "ABCDEF1234567890",
    fls_id: "ABCDEF1234567890",
    funcom_id: "RedBlink#75570",
    character_name: "JaneDoe",
    online_status: "Online",
    ...overrides
  };
}

test("message of the day defaults are disabled with an empty draft", () => {
  const result = readMessageOfTheDay(config());
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.title, "");
  assert.equal(result.settings.message, "");
});

test("message of the day validates booleans and message text", () => {
  assert.deepEqual(normalizeSettings({ enabled: true, title: "Daily", message: "Hello" }), { enabled: true, title: "", message: "Hello" });
  assert.throws(() => normalizeSettings({ enabled: "true", title: "Daily", message: "Hello" }), /enabled must be true or false/);
  assert.throws(() => normalizeSettings({ enabled: true, title: "Daily", message: "x".repeat(501) }), /Message must be 1-500/);
});

test("message of the day saves and restores persisted settings", () => {
  const cfg = config();
  const saved = saveMessageOfTheDay(cfg, { enabled: true, title: "News", message: "Welcome" });
  assert.equal(saved.settings.enabled, true);
  assert.equal(JSON.parse(readFileSync(join(cfg.generatedDir, "message-of-the-day.json"), "utf8")).message, "Welcome");

  const restored = restoreMessageOfTheDay(cfg);
  assert.equal(restored.settings.enabled, false);
  assert.equal(restored.settings.message, "");
});

test("message of the day sends once per online session", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });

  const first = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(first.sent, 1);

  const second = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(second.sent, 0);

  const logout = await runMessageOfTheDayScan(cfg, [], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(logout.sent, 0);

  const loginAgain = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(loginAgain.sent, 1);
});

test("message of the day can prime currently online players after save", async () => {
  const cfg = config();
  saveMessageOfTheDay(cfg, { enabled: true, title: "Daily", message: "Welcome back" });
  const primed = primeMessageOfTheDayOnlineState(cfg, [onlinePlayer()]);
  assert.equal(primed.delivered, 1);

  const currentSession = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(currentSession.sent, 0);

  await runMessageOfTheDayScan(cfg, [], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  const nextSession = await runMessageOfTheDayScan(cfg, [onlinePlayer()], { mockMode: true, persona: { funcomId: "Server#0001", hexFlsId: "A5C0DE5E12A00001" } });
  assert.equal(nextSession.sent, 1);
});

test("message of the day delivery plan preserves only current online players", () => {
  const plan = messageOfTheDayDeliveryPlan(
    { enabled: true, title: "Daily", message: "Welcome" },
    [onlinePlayer()],
    { delivered: { ABCDEF1234567890: { deliveredAt: "now" }, stale: { deliveredAt: "old" } } }
  );
  assert.equal(plan.pending.length, 0);
  assert.deepEqual(Object.keys(plan.delivered), ["ABCDEF1234567890"]);
});
