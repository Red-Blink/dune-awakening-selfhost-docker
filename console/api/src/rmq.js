import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { redact } from "./redact.js";

const RMQ_CONTAINER = "dune-rmq-game";
const COMMAND_AUTH_TOKEN_BYTES = 32;

export function validateBroadcastMessage(message) {
  const raw = String(message || "").trim();
  if (raw.length < 1 || raw.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) {
    throw new Error("Message must be 1-500 printable characters");
  }
  return raw;
}

export function buildBroadcastCommand({ message, title = "Admin Broadcast", durationSec = 30, texts } = {}) {
  const localizedText = validateLocalizedTexts(texts, message, title);
  const duration = validateInteger(durationSec, 1, 3600, "durationSec");
  return {
    ServerCommand: "ServiceBroadcast",
    BroadcastType: "Generic",
    BroadcastPayload: {
      BroadcastDuration: duration,
      LocalizedText: localizedText
    }
  };
}

export function validateLocalizedTexts(texts, message, title = "Admin Broadcast") {
  if (Array.isArray(texts) && texts.length > 0) {
    if (texts.length > 10) throw new Error("texts must contain 1-10 entries");
    return texts.map((entry) => ({
      Key: validateLocaleKey(entry?.Key || "en"),
      Title: validateLocalizedTextField(entry?.Title || title || "Admin Broadcast", "Title", 80),
      Body: validateBroadcastMessage(entry?.Body)
    }));
  }
  const validatedTitle = validateLocalizedTextField(title || "Admin Broadcast", "Title", 80);
  const validatedBody = validateBroadcastMessage(message);
  return ["en", "en-US"].map((key) => ({
    Key: key,
    Title: validatedTitle,
    Body: validatedBody
  }));
}

export function buildShutdownBroadcastCommand({ shutdownType = "Restart", delayMinutes = 15, frequency = 60, duration = 30, cancel = false }) {
  const type = validateShutdownType(shutdownType);
  const delay = validateInteger(delayMinutes, 0, 1440, "delayMinutes");
  const freq = validateInteger(frequency, 1, 3600, "frequency");
  const dur = validateInteger(duration, 1, 3600, "duration");
  const timestamp = Math.floor(Date.now() / 1000) + delay * 60;
  return {
    ServerCommand: "ServiceBroadcast",
    BroadcastType: "ServerShutdown",
    BroadcastPayload: {
      ShutdownType: type,
      ShouldCancel: Boolean(cancel),
      ShutdownTimestamp: timestamp,
      BroadcastFrequency: freq,
      ShutdownDuration: dur,
      DateTimestamp: timestamp
    }
  };
}

export function buildCarePackageWhisperPayload({ recipientFuncomId, recipientCharacterName, senderFuncomId, message, now = new Date(), messageId } = {}) {
  const recipientId = validateWhisperIdentity(recipientFuncomId, "recipient Funcom ID");
  const recipientName = validateWhisperName(recipientCharacterName, "recipient character name");
  const senderId = validateWhisperIdentity(senderFuncomId, "sender Funcom ID");
  const text = validateBroadcastMessage(message);
  const id = validateMessageId(messageId || randomUUID());
  const timestamp = new Date(now).toISOString();
  const inner = {
    m_Id: id,
    m_ChannelType: "ETextChatChannelType::Whispers",
    m_SubChannelId: recipientId,
    m_bUseSpoofedUserName: false,
    m_SpoofedUserNameFrom: {
      m_Id: "",
      m_DisplayName: ""
    },
    m_FuncomIdFrom: senderId,
    m_UserNameTo: recipientName,
    m_Message: {
      m_UnlocalizedMessage: text,
      m_LocalizedMessage: {
        m_TableId: "",
        m_Key: "",
        m_FormatArgs: []
      }
    },
    m_TimeStamp: timestamp,
    m_OriginLocation: { X: 0, Y: 0, Z: 0 },
    m_HasSeenMessage: false
  };
  return {
    inner,
    outer: {
      Content: JSON.stringify(inner),
      Type: "ECourierMessageType::TextChat"
    }
  };
}

export function buildMapChatPayload({ senderFuncomId, message, now = new Date(), messageId } = {}) {
  const senderId = validateWhisperIdentity(senderFuncomId, "sender Funcom ID");
  const text = validateBroadcastMessage(message);
  const id = validateMessageId(messageId || randomUUID());
  const timestamp = formatMapChatTimestamp(now);
  const inner = {
    m_Id: id,
    m_ChannelType: "Map",
    m_bUseSpoofedUserName: false,
    m_SpoofedUserNameFrom: {
      m_TableId: "",
      m_Key: "",
      m_UnlocalizedName: ""
    },
    m_FuncomIdFrom: senderId,
    m_UserNameTo: "",
    m_Message: {
      m_UnlocalizedMessage: text,
      m_LocalizedMessage: {
        m_TableId: "",
        m_Key: "",
        m_FormatArgs: []
      }
    },
    m_Timestamp: timestamp,
    m_OriginLocation: { X: 0, Y: 0, Z: 0 },
    m_HasSeenMessage: false
  };
  return {
    inner,
    outer: {
      content: JSON.stringify(inner),
      Type: "TextChat"
    }
  };
}

export async function publishCarePackageWhisper(config, fields) {
  const senderHexFlsId = validateHexFlsId(fields?.senderHexFlsId);
  const amqpUserId = validateHexFlsId(fields?.amqpUserId || senderHexFlsId);
  const directQueue = fields?.recipientQueue ? validateQueueName(fields.recipientQueue, "recipient queue") : "";
  const routingKey = directQueue || validateWhisperIdentity(fields?.recipientFuncomId, "recipient Funcom ID");
  const exchange = directQueue ? "" : "chat.whispers";
  const exchangeLabel = directQueue ? "default" : "chat.whispers";
  const payload = buildCarePackageWhisperPayload(fields);
  const outerB64 = Buffer.from(JSON.stringify(payload.outer), "utf8").toString("base64");
  const routingB64 = Buffer.from(routingKey, "utf8").toString("base64");
  const senderB64 = Buffer.from(amqpUserId, "utf8").toString("base64");
  const exchangeB64 = Buffer.from(exchange, "utf8").toString("base64");
  const exchangeLabelB64 = Buffer.from(exchangeLabel, "utf8").toString("base64");
  const evalCode = `Outer = base64:decode(<<"${outerB64}">>), Routing = base64:decode(<<"${routingB64}">>), Sender = base64:decode(<<"${senderB64}">>), Exchange = base64:decode(<<"${exchangeB64}">>), ExchangeLabel = base64:decode(<<"${exchangeLabelB64}">>), XName = rabbit_misc:r(<<"/">>, exchange, Exchange), X = rabbit_exchange:lookup_or_die(XName), MsgId = list_to_binary("web-care-package-whisper-" ++ integer_to_list(erlang:system_time(millisecond))), P = {list_to_atom("P_basic"), <<"Content">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, <<"text_chat">>, Sender, <<"fls_backend">>, undefined}, Content = rabbit_basic:build_content(P, Outer), {ok, Msg} = rabbit_basic:message(XName, Routing, Content), Result = rabbit_queue_type:publish_at_most_once(X, Msg), io:format("publish=~p exchange=~s routing=~s type=text_chat user_id=~s app_id=fls_backend~n", [Result, ExchangeLabel, Routing, Sender]).`;
  const output = await dockerExec(["exec", RMQ_CONTAINER, "rabbitmqctl", "eval", evalCode], config.commandTimeoutMs);
  if (!/publish=ok/.test(output.stdout)) throw new Error("RabbitMQ whisper publish did not report publish=ok");
  return {
    ...output,
    stdout: `${output.stdout}outer=${JSON.stringify(payload.outer)}\ninner=${payload.outer.Content}\n`,
    payload,
    amqp: {
      exchange: exchangeLabel,
      routingKey,
      type: "text_chat",
      userId: amqpUserId,
      senderHexFlsId,
      appId: "fls_backend"
    }
  };
}

export async function publishMapChat(config, fields) {
  const senderHexFlsId = validateHexFlsId(fields?.senderHexFlsId);
  const mapName = validateMapChatMap(fields?.mapName || fields?.region || "HaggaBasin");
  const dimension = validateInteger(fields?.dimension ?? 0, 0, 9999, "dimension");
  const directQueue = fields?.recipientQueue ? validateQueueName(fields.recipientQueue, "recipient queue") : "";
  const routingKey = directQueue || `${mapName}.${dimension}`;
  const exchange = directQueue ? "" : "chat.map";
  const exchangeLabel = directQueue ? "default" : "chat.map";
  const payload = buildMapChatPayload(fields);
  const outerB64 = Buffer.from(JSON.stringify(payload.outer), "utf8").toString("base64");
  const routingB64 = Buffer.from(routingKey, "utf8").toString("base64");
  const senderB64 = Buffer.from(senderHexFlsId, "utf8").toString("base64");
  const exchangeB64 = Buffer.from(exchange, "utf8").toString("base64");
  const exchangeLabelB64 = Buffer.from(exchangeLabel, "utf8").toString("base64");
  const evalCode = `Outer = base64:decode(<<"${outerB64}">>), Routing = base64:decode(<<"${routingB64}">>), Sender = base64:decode(<<"${senderB64}">>), Exchange = base64:decode(<<"${exchangeB64}">>), ExchangeLabel = base64:decode(<<"${exchangeLabelB64}">>), XName = rabbit_misc:r(<<"/">>, exchange, Exchange), X = rabbit_exchange:lookup_or_die(XName), MsgId = list_to_binary("web-map-chat-" ++ integer_to_list(erlang:system_time(millisecond))), P = {list_to_atom("P_basic"), <<"Content">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, <<"text_chat">>, Sender, <<"fls_backend">>, undefined}, Content = rabbit_basic:build_content(P, Outer), {ok, Msg} = rabbit_basic:message(XName, Routing, Content), Result = rabbit_queue_type:publish_at_most_once(X, Msg), io:format("publish=~p exchange=~s routing=~s type=text_chat user_id=~s app_id=fls_backend~n", [Result, ExchangeLabel, Routing, Sender]).`;
  const output = await dockerExec(["exec", RMQ_CONTAINER, "rabbitmqctl", "eval", evalCode], config.commandTimeoutMs);
  if (!/publish=ok/.test(output.stdout)) throw new Error("RabbitMQ map chat publish did not report publish=ok");
  return {
    ...output,
    stdout: `${output.stdout}outer=${JSON.stringify(payload.outer)}\ninner=${payload.outer.content}\n`,
    payload,
    amqp: {
      exchange: exchangeLabel,
      routingKey,
      type: "text_chat",
      userId: senderHexFlsId,
      senderHexFlsId,
      appId: "fls_backend"
    }
  };
}

export async function publishServerCommand(config, fields, label = "web-admin") {
  const safeLabel = validatePublishLabel(label);
  const inner = JSON.stringify(fields);
  const outer = JSON.stringify({
    Version: 2,
    AuthToken: commandAuthToken(config.repoRoot),
    MessageContent: inner
  });
  const outerB64 = Buffer.from(outer, "utf8").toString("base64");
  const evalCode = `Outer = base64:decode(<<"${outerB64}">>), XName = rabbit_misc:r(<<"/">>, exchange, <<"heartbeats">>), X = rabbit_exchange:lookup_or_die(XName), MsgId = list_to_binary("web-${safeLabel}-" ++ integer_to_list(erlang:system_time(millisecond))), P = {list_to_atom("P_basic"), <<"Content">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, undefined, <<"fls">>, <<"fls_backend">>, undefined}, Content = rabbit_basic:build_content(P, Outer), {ok, Msg} = rabbit_basic:message(XName, <<"notifications">>, Content), Result = rabbit_queue_type:publish_at_most_once(X, Msg), io:format("publish=~p exchange=heartbeats routing=notifications app_id=fls_backend user_id=fls label=${safeLabel}~n", [Result]).`;
  const output = await dockerExec(["exec", RMQ_CONTAINER, "rabbitmqctl", "eval", evalCode], config.commandTimeoutMs);
  if (!/publish=ok/.test(output.stdout)) throw new Error("RabbitMQ publish did not report publish=ok");
  return output;
}

export function validatePublishLabel(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid RabbitMQ publish label");
}

export function commandAuthToken(repoRoot) {
  const file = resolve(repoRoot, "runtime/secrets/command-auth-token.txt");
  if (process.env.DUNE_COMMAND_AUTH_TOKEN) return process.env.DUNE_COMMAND_AUTH_TOKEN;
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw) return raw;
  }
  const token = randomBytes(COMMAND_AUTH_TOKEN_BYTES).toString("base64url");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on non-POSIX development hosts.
  }
  return token;
}

function dockerExec(args, timeoutMs = 30000) {
  return new Promise((resolvePromise, reject) => {
    const spawnFn = globalThis.__testSpawn || spawn;
    const child = spawnFn("docker", args, { shell: false, env: { ...process.env } });
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += redact(chunk.toString()); });
    child.stderr.on("data", (chunk) => { stderr += redact(chunk.toString()); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      const result = { code, stdout, stderr, args: ["docker", ...args] };
      if (code === 0) resolvePromise(result);
      else reject(Object.assign(new Error(`docker ${args.slice(0, 3).join(" ")} failed with exit ${code}: ${stderr || stdout}`), result));
    });
  });
}

function validateInteger(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer ${min}-${max}`);
  return n;
}

function validateLocalizedTextField(value, label, maxLength) {
  const raw = String(value || "").trim();
  if (raw.length < 1 || raw.length > maxLength || /[\u0000-\u001f]/.test(raw)) {
    throw new Error(`${label} must be 1-${maxLength} printable characters`);
  }
  return raw;
}

function validateLocaleKey(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(raw)) return raw;
  throw new Error("LocalizedText Key must be a locale key like en or en-US");
}

function validateShutdownType(value) {
  const raw = String(value || "").trim();
  if (["Restart", "Maintenance", "Update"].includes(raw)) return raw;
  throw new Error("shutdownType must be Restart, Maintenance, or Update");
}

function validateWhisperIdentity(value, label) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_#.@:+/-]{1,180}$/.test(raw)) return raw;
  throw new Error(`Care Package message whisper cannot be sent: ${label} is unavailable or invalid`);
}

function validateWhisperName(value, label) {
  const raw = String(value || "").trim();
  if (raw.length >= 1 && raw.length <= 80 && !/[\u0000-\u001f]/.test(raw)) return raw;
  throw new Error(`Care Package message whisper cannot be sent: ${label} is unavailable or invalid`);
}

function validateHexFlsId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Fa-f0-9]{16,64}$/.test(raw)) return raw;
  throw new Error("Care Package message whisper cannot be sent: sender hex FLS ID is unavailable or invalid");
}

function validateQueueName(value, label) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_.:+/-]{1,220}$/.test(raw)) return raw;
  throw new Error(`Care Package message whisper cannot be sent: ${label} is unavailable or invalid`);
}

function validateMapChatMap(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_]{1,80}$/.test(raw)) return raw;
  throw new Error("Map chat region must be a map key like HaggaBasin, Overmap, or DeepDesert");
}

function validateMessageId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_.:-]{1,120}$/.test(raw)) return raw;
  throw new Error("Invalid whisper message id");
}

function formatMapChatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid map chat timestamp");
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}-${pad(date.getUTCHours())}.${pad(date.getUTCMinutes())}.${pad(date.getUTCSeconds())}`;
}
