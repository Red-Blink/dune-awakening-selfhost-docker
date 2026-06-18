import assert from "node:assert/strict";
import test from "node:test";
import { discordAuditEvent, discordBlockedAuditEvent } from "../src/integrations/discord/audit.js";

const actor = {
  guildId: "guild-1",
  channelId: "channel-1",
  userId: "user-1",
  username: "tester",
  commandName: "/dune backup restore"
};

test("builds structured Discord audit event", () => {
  const event = discordAuditEvent({
    actor,
    action: "backup.restore",
    capability: "backups:destructive",
    risk: "critical",
    targetType: "backup",
    targetId: "backup-1",
    confirmationRequired: true,
    confirmationPassed: true,
    result: "success"
  });

  assert.equal(event.source, "discord");
  assert.equal(event.discordUserId, "user-1");
  assert.equal(event.action, "backup.restore");
  assert.equal(event.confirmationRequired, true);
  assert.equal(event.confirmationPassed, true);
  assert.equal(event.result, "success");
});

test("redacts sensitive audit details", () => {
  const event = discordBlockedAuditEvent({
    actor,
    action: "settings.save-token",
    capability: "settings:admin",
    reason: "invalid token",
    detail: {
      discordBotToken: "Bot abcdefghijklmnopqrstuvwxyz1234567890",
      password: "clear-text"
    }
  });

  assert.equal(event.source, "discord");
  assert.equal(event.result, "blocked");
  assert.equal(event.detail.discordBotToken, "<redacted>");
  assert.equal(event.detail.password, "<redacted>");
});
