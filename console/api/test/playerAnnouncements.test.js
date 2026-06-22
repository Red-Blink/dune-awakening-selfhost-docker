import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeSettings,
  previewPlayerAnnouncement,
  primePlayerAnnouncementOnlineState,
  readPlayerAnnouncements,
  restorePlayerAnnouncements,
  runPlayerAnnouncementScan,
  savePlayerAnnouncements
} from "../src/services/playerAnnouncements.js";

function config() {
  const root = mkdtempSync(join(tmpdir(), "dune-announcements-test-"));
  return {
    repoRoot: root,
    generatedDir: join(root, "runtime", "generated"),
    mockMode: true
  };
}

function player(name = "John", id = "ABCDEF1234567890") {
  return {
    actor_id: 6,
    action_player_id: id,
    fls_id: id,
    character_name: name,
    online_status: "Online"
  };
}

test("player announcements default to disabled with official text", () => {
  const result = readPlayerAnnouncements(config());
  assert.equal(result.settings.joinEnabled, false);
  assert.equal(result.settings.leaveEnabled, false);
  assert.equal(result.settings.joinMessage, "{playerName} has entered the sands of Arrakis.");
});

test("player announcements validate booleans and templates", () => {
  assert.equal(normalizeSettings({ joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: false, leaveMessage: "{playerName} left" }).joinEnabled, true);
  assert.throws(() => normalizeSettings({ joinEnabled: "true", joinMessage: "joined", leaveEnabled: false, leaveMessage: "left" }), /joinEnabled must be true or false/);
  assert.throws(() => normalizeSettings({ joinEnabled: true, joinMessage: "", leaveEnabled: false, leaveMessage: "left" }), /Join message is required/);
});

test("player announcements save and restore persisted settings", () => {
  const cfg = config();
  const saved = savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} arrived", leaveEnabled: true, leaveMessage: "{playerName} left" });
  assert.equal(saved.settings.joinEnabled, true);
  assert.equal(JSON.parse(readFileSync(join(cfg.generatedDir, "player-announcements.json"), "utf8")).leaveEnabled, true);

  const restored = restorePlayerAnnouncements(cfg);
  assert.equal(restored.settings.joinEnabled, false);
  assert.equal(restored.settings.leaveMessage, "{playerName} has vanished beyond the dunes.");
});

test("player announcements publish join and leave events from online state changes", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: true, leaveMessage: "{playerName} left" });

  const joined = await runPlayerAnnouncementScan(cfg, [player("John")], { mockMode: true });
  assert.equal(joined.joined, 1);
  assert.equal(joined.sent, 1);

  const unchanged = await runPlayerAnnouncementScan(cfg, [player("John")], { mockMode: true });
  assert.equal(unchanged.sent, 0);

  const secondJoined = await runPlayerAnnouncementScan(cfg, [player("John"), player("Jane", "1234567890ABCDEF")], { mockMode: true });
  assert.equal(secondJoined.joined, 1);
  assert.equal(secondJoined.sent, 2);

  const left = await runPlayerAnnouncementScan(cfg, [player("Jane", "1234567890ABCDEF")], { mockMode: true });
  assert.equal(left.left, 1);
  assert.equal(left.sent, 1);
});

test("player announcements report leave events even when nobody remains online", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: false, joinMessage: "{playerName} joined", leaveEnabled: true, leaveMessage: "{playerName} left" });
  primePlayerAnnouncementOnlineState(cfg, [player("John")]);

  const left = await runPlayerAnnouncementScan(cfg, [], { mockMode: true });
  assert.equal(left.left, 1);
  assert.equal(left.sent, 0);
  assert.equal(left.skippedNoRecipients, 1);
  assert.equal(left.results[0].reason, "no_online_recipients");
});

test("player announcements can prime current online players after save", async () => {
  const cfg = config();
  savePlayerAnnouncements(cfg, { joinEnabled: true, joinMessage: "{playerName} joined", leaveEnabled: false, leaveMessage: "{playerName} left" });
  const primed = primePlayerAnnouncementOnlineState(cfg, [player("John")]);
  assert.equal(primed.online, 1);

  const currentSession = await runPlayerAnnouncementScan(cfg, [player("John")], { mockMode: true });
  assert.equal(currentSession.sent, 0);

  await runPlayerAnnouncementScan(cfg, [], { mockMode: true });
  const nextSession = await runPlayerAnnouncementScan(cfg, [player("John")], { mockMode: true });
  assert.equal(nextSession.sent, 1);
});

test("player announcement preview renders the join template", () => {
  assert.equal(previewPlayerAnnouncement({ joinEnabled: true, joinMessage: "{playerName} arrived", leaveEnabled: false, leaveMessage: "{playerName} left" }, "John"), "John arrived");
});
