import test from "node:test";
import assert from "node:assert/strict";
import { buildBroadcastCommand, buildCarePackageWhisperPayload, buildShutdownBroadcastCommand, validateBroadcastMessage, validateLocalizedTexts, validatePublishLabel } from "../src/rmq.js";

test("builds verified ServiceBroadcast generic command payload", () => {
  const command = buildBroadcastCommand({ message: "Server event starts soon", durationSec: 45, title: "Event" });
  assert.equal(command.ServerCommand, "ServiceBroadcast");
  assert.equal(command.BroadcastType, "Generic");
  assert.equal(command.BroadcastPayload.BroadcastDuration, 45);
  assert.equal(command.BroadcastPayload.LocalizedText[0].Key, "AdminBroadcast");
  assert.equal(command.BroadcastPayload.LocalizedText[0].Title, "Event");
  assert.equal(command.BroadcastPayload.LocalizedText[0].Body, "Server event starts soon");
});

test("builds reference multi-text ServiceBroadcast generic payload", () => {
  const command = buildBroadcastCommand({
    durationSec: 30,
    texts: [
      { Key: "AdminBroadcast", Title: "Event", Body: "Server event starts soon" },
      { Key: "AdminBroadcastShort", Title: "Event", Body: "Travel safely" }
    ]
  });
  assert.deepEqual(command.BroadcastPayload.LocalizedText, [
    { Key: "AdminBroadcast", Title: "Event", Body: "Server event starts soon" },
    { Key: "AdminBroadcastShort", Title: "Event", Body: "Travel safely" }
  ]);
});

test("validates broadcast and whisper-style message bounds", () => {
  assert.equal(validateBroadcastMessage("hello"), "hello");
  assert.throws(() => validateBroadcastMessage(""));
  assert.throws(() => validateBroadcastMessage("x".repeat(501)));
  assert.throws(() => validateBroadcastMessage("bad\u0001message"));
  assert.throws(() => buildBroadcastCommand({ message: "hello", durationSec: 0 }));
  assert.throws(() => buildBroadcastCommand({ message: "hello", durationSec: 3601 }));
  assert.throws(() => validateLocalizedTexts([{ Key: "bad\u0001key", Title: "Event", Body: "hello" }]));
  assert.throws(() => validateLocalizedTexts([{ Key: "AdminBroadcast", Title: "Event", Body: "" }]));
});

test("builds shutdown ServiceBroadcast with strict shutdown type", () => {
  const before = Math.floor(Date.now() / 1000) + 10 * 60;
  const command = buildShutdownBroadcastCommand({ shutdownType: "Restart", delayMinutes: 10, frequency: 30, duration: 15 });
  assert.equal(command.ServerCommand, "ServiceBroadcast");
  assert.equal(command.BroadcastType, "ServerShutdown");
  assert.equal(command.BroadcastPayload.ShutdownType, "Restart");
  assert.equal(command.BroadcastPayload.BroadcastFrequency, 30);
  assert.equal(command.BroadcastPayload.ShutdownDuration, 15);
  assert.ok(command.BroadcastPayload.ShutdownTimestamp >= before);
  assert.throws(() => buildShutdownBroadcastCommand({ shutdownType: "RebootEverything" }));
});

test("builds Care Package private whisper courier payload", () => {
  const payload = buildCarePackageWhisperPayload({
    recipientFuncomId: "RedBlink#75570",
    recipientCharacterName: "RedBlink",
    senderFuncomId: "Server#00000",
    message: "Welcome",
    now: "2026-06-08T12:00:00.000Z",
    messageId: "care-package-test"
  });
  assert.equal(payload.outer.Type, "ECourierMessageType::TextChat");
  const inner = JSON.parse(payload.outer.Content);
  assert.equal(inner.m_Id, "care-package-test");
  assert.equal(inner.m_ChannelType, "ETextChatChannelType::Whispers");
  assert.equal(inner.m_SubChannelId, "RedBlink#75570");
  assert.equal(inner.m_bUseSpoofedUserName, false);
  assert.equal(inner.m_FuncomIdFrom, "Server#00000");
  assert.equal(inner.m_UserNameTo, "RedBlink");
  assert.equal(inner.m_Message.CultureInvariantString, "Welcome");
  assert.equal(inner.m_TimeStamp, "2026-06-08T12:00:00.000Z");
  assert.equal(inner.m_HasSeenMessage, false);
});

test("validates RabbitMQ publish labels before eval construction", () => {
  assert.equal(validatePublishLabel("web-broadcast"), "web-broadcast");
  assert.equal(validatePublishLabel("web_shutdown_1"), "web_shutdown_1");
  assert.throws(() => validatePublishLabel("bad label"));
  assert.throws(() => validatePublishLabel("bad\"), halt(). %"));
});
