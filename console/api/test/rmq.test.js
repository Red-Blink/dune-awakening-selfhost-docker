import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBroadcastCommand, buildCarePackageWhisperPayload, buildMapChatPayload, buildShutdownBroadcastCommand, commandAuthToken, publishCarePackageWhisper, publishMapChat, validateBroadcastMessage, validateLocalizedTexts, validatePublishLabel } from "../src/rmq.js";

test("builds verified ServiceBroadcast generic command payload", () => {
  const command = buildBroadcastCommand({ message: "Server event starts soon", durationSec: 45, title: "Event" });
  assert.equal(command.ServerCommand, "ServiceBroadcast");
  assert.equal(command.BroadcastType, "Generic");
  assert.equal(command.BroadcastPayload.BroadcastDuration, 45);
  assert.deepEqual(command.BroadcastPayload.LocalizedText, [
    { Key: "en", Title: "Event", Body: "Server event starts soon" },
    { Key: "en-US", Title: "Event", Body: "Server event starts soon" }
  ]);
});

test("builds locale-keyed multi-text ServiceBroadcast generic payload", () => {
  const command = buildBroadcastCommand({
    durationSec: 30,
    texts: [
      { Key: "en", Title: "Event", Body: "Server event starts soon" },
      { Key: "en-US", Title: "Event", Body: "Travel safely" }
    ]
  });
  assert.deepEqual(command.BroadcastPayload.LocalizedText, [
    { Key: "en", Title: "Event", Body: "Server event starts soon" },
    { Key: "en-US", Title: "Event", Body: "Travel safely" }
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
  assert.throws(() => validateLocalizedTexts([{ Key: "AdminBroadcast", Title: "Event", Body: "hello" }]));
  assert.throws(() => validateLocalizedTexts([{ Key: "en", Title: "Event", Body: "" }]));
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
  assert.deepEqual(inner.m_SpoofedUserNameFrom, { m_Id: "", m_DisplayName: "" });
  assert.equal(inner.m_FuncomIdFrom, "Server#00000");
  assert.equal(inner.m_UserNameTo, "RedBlink");
  assert.equal(inner.m_Message.m_UnlocalizedMessage, "Welcome");
  assert.equal(inner.m_Message.m_LocalizedMessage.m_TableId, "");
  assert.equal(inner.m_Message.m_LocalizedMessage.m_Key, "");
  assert.deepEqual(inner.m_Message.m_LocalizedMessage.m_FormatArgs, []);
  assert.equal(inner.m_TimeStamp, "2026-06-08T12:00:00.000Z");
  assert.deepEqual(inner.m_OriginLocation, { X: 0, Y: 0, Z: 0 });
  assert.equal(inner.m_HasSeenMessage, false);
});

test("builds map chat courier payload", () => {
  const payload = buildMapChatPayload({
    senderFuncomId: "Server#00000",
    message: "Event starts soon",
    now: "2026-06-08T12:34:56.000Z",
    messageId: "map-chat-test"
  });
  assert.equal(payload.outer.Type, "TextChat");
  const inner = JSON.parse(payload.outer.content);
  assert.equal(inner.m_Id, "map-chat-test");
  assert.equal(inner.m_ChannelType, "Map");
  assert.equal(inner.m_bUseSpoofedUserName, false);
  assert.deepEqual(inner.m_SpoofedUserNameFrom, { m_TableId: "", m_Key: "", m_UnlocalizedName: "" });
  assert.equal(inner.m_FuncomIdFrom, "Server#00000");
  assert.equal(inner.m_UserNameTo, "");
  assert.equal(inner.m_Message.m_UnlocalizedMessage, "Event starts soon");
  assert.deepEqual(inner.m_Message.m_LocalizedMessage.m_FormatArgs, []);
  assert.equal(inner.m_Timestamp, "2026.06.08-12.34.56");
  assert.deepEqual(inner.m_OriginLocation, { X: 0, Y: 0, Z: 0 });
  assert.equal(inner.m_HasSeenMessage, false);
});

test("validates RabbitMQ publish labels before eval construction", () => {
  assert.equal(validatePublishLabel("web-broadcast"), "web-broadcast");
  assert.equal(validatePublishLabel("web_shutdown_1"), "web_shutdown_1");
  assert.throws(() => validatePublishLabel("bad label"));
  assert.throws(() => validatePublishLabel("bad\"), halt(). %"));
});

test("command auth token generates and reuses a local secret file", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-rmq-token-"));
  const previous = process.env.DUNE_COMMAND_AUTH_TOKEN;
  delete process.env.DUNE_COMMAND_AUTH_TOKEN;
  try {
    const tokenFile = resolve(repoRoot, "runtime/secrets/command-auth-token.txt");
    const token = commandAuthToken(repoRoot);
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(existsSync(tokenFile), true);
    assert.equal(readFileSync(tokenFile, "utf8").trim(), token);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal(commandAuthToken(repoRoot), token);
  } finally {
    if (previous === undefined) {
      delete process.env.DUNE_COMMAND_AUTH_TOKEN;
    } else {
      process.env.DUNE_COMMAND_AUTH_TOKEN = previous;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("command auth token honors explicit environment override", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-rmq-token-env-"));
  const previous = process.env.DUNE_COMMAND_AUTH_TOKEN;
  process.env.DUNE_COMMAND_AUTH_TOKEN = "explicit-token";
  try {
    const tokenFile = resolve(repoRoot, "runtime/secrets/command-auth-token.txt");
    assert.equal(commandAuthToken(repoRoot), "explicit-token");
    assert.equal(existsSync(tokenFile), false);
  } finally {
    if (previous === undefined) {
      delete process.env.DUNE_COMMAND_AUTH_TOKEN;
    } else {
      process.env.DUNE_COMMAND_AUTH_TOKEN = previous;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("publishes map chat to chat.map routing key", async () => {
  const originalSpawn = globalThis.__testSpawn;
  try {
    const calls = [];
    globalThis.__testSpawn = (command, args) => {
      calls.push({ command, args });
      return fakeSpawn("publish=ok exchange=chat.map routing=HaggaBasin.0 type=text_chat user_id=A5C0DE5E12A00001 app_id=fls_backend\n");
    };
    const result = await publishMapChat({ commandTimeoutMs: 1000 }, {
      mapName: "HaggaBasin",
      dimension: 0,
      senderFuncomId: "Server#0001",
      senderHexFlsId: "A5C0DE5E12A00001",
      message: "Event starts soon"
    });
    assert.equal(result.amqp.exchange, "chat.map");
    assert.equal(result.amqp.routingKey, "HaggaBasin.0");
    assert.equal(result.amqp.userId, "A5C0DE5E12A00001");
    assert.match(calls[0].args.join(" "), /rabbitmqctl eval/);
  } finally {
    globalThis.__testSpawn = originalSpawn;
  }
});

test("publishes map chat directly to a player queue", async () => {
  const originalSpawn = globalThis.__testSpawn;
  try {
    globalThis.__testSpawn = () => fakeSpawn("publish=ok exchange=default routing=254A06043E9F0B16_queue type=text_chat user_id=A5C0DE5E12A00001 app_id=fls_backend\n");
    const result = await publishMapChat({ commandTimeoutMs: 1000 }, {
      mapName: "HaggaBasin",
      dimension: 0,
      recipientQueue: "254A06043E9F0B16_queue",
      senderFuncomId: "Server#0001",
      senderHexFlsId: "A5C0DE5E12A00001",
      message: "Event starts soon"
    });
    assert.equal(result.amqp.exchange, "default");
    assert.equal(result.amqp.routingKey, "254A06043E9F0B16_queue");
    assert.equal(result.amqp.userId, "A5C0DE5E12A00001");
  } finally {
    globalThis.__testSpawn = originalSpawn;
  }
});

test("publishes Care Package whisper to direct player queue when available", async () => {
  const originalSpawn = globalThis.__testSpawn;
  try {
    const calls = [];
    globalThis.__testSpawn = (command, args) => {
      calls.push({ command, args });
      return fakeSpawn("publish=ok exchange=default routing=254A06043E9F0B16_queue type=text_chat user_id=53657276657200000000000000000000 app_id=fls_backend\n");
    };
    const result = await publishCarePackageWhisper({ commandTimeoutMs: 1000 }, {
      recipientFuncomId: "RedBlink#75570",
      recipientCharacterName: "RedBlink",
      recipientQueue: "254A06043E9F0B16_queue",
      senderFuncomId: "Server#0001",
      senderHexFlsId: "A5C0DE5E12A00001",
      message: "Welcome"
    });
    assert.equal(result.amqp.exchange, "default");
    assert.equal(result.amqp.routingKey, "254A06043E9F0B16_queue");
    assert.equal(result.amqp.userId, "A5C0DE5E12A00001");
    assert.equal(result.amqp.senderHexFlsId, "A5C0DE5E12A00001");
    assert.match(calls[0].args.join(" "), /rabbitmqctl eval/);
  } finally {
    globalThis.__testSpawn = originalSpawn;
  }
});

function fakeSpawn(stdout) {
  const listeners = {};
  const child = {
    stdout: { on(event, fn) { if (event === "data") setImmediate(() => fn(Buffer.from(stdout))); } },
    stderr: { on() {} },
    on(event, fn) {
      listeners[event] = fn;
      if (event === "close") setImmediate(() => fn(0));
    },
    kill() {}
  };
  return child;
}
