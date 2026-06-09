import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redact } from "./redact.js";

const BUILTIN_COMMAND_AUTH_TOKEN = "Nu6VmPWUMvdPMeB7qErr";
const RMQ_CONTAINER = "dune-rmq-game";

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
      Key: validateLocalizedTextField(entry?.Key || "AdminBroadcast", "Key", 120),
      Title: validateLocalizedTextField(entry?.Title || title || "Admin Broadcast", "Title", 80),
      Body: validateBroadcastMessage(entry?.Body)
    }));
  }
  return [{
    Key: "AdminBroadcast",
    Title: validateLocalizedTextField(title || "Admin Broadcast", "Title", 80),
    Body: validateBroadcastMessage(message)
  }];
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
  const id = validateMessageId(messageId || `care-package-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const timestamp = new Date(now).toISOString();
  const inner = {
    m_Id: id,
    m_ChannelType: "ETextChatChannelType::Whispers",
    m_SubChannelId: recipientId,
    m_bUseSpoofedUserName: false,
    m_FuncomIdFrom: senderId,
    m_UserNameTo: recipientName,
    m_Message: {
      CultureInvariantString: text
    },
    m_TimeStamp: timestamp,
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

export async function publishCarePackageWhisper(config, fields) {
  const senderHexFlsId = validateHexFlsId(fields?.senderHexFlsId);
  const routingKey = validateWhisperIdentity(fields?.recipientFuncomId, "recipient Funcom ID");
  const payload = buildCarePackageWhisperPayload(fields);
  const outerB64 = Buffer.from(JSON.stringify(payload.outer), "utf8").toString("base64");
  const routingB64 = Buffer.from(routingKey, "utf8").toString("base64");
  const senderB64 = Buffer.from(senderHexFlsId, "utf8").toString("base64");
  const evalCode = `Outer = base64:decode(<<"${outerB64}">>), Routing = base64:decode(<<"${routingB64}">>), Sender = base64:decode(<<"${senderB64}">>), XName = rabbit_misc:r(<<"/">>, exchange, <<"chat.whispers">>), X = rabbit_exchange:lookup_or_die(XName), MsgId = list_to_binary("web-care-package-whisper-" ++ integer_to_list(erlang:system_time(millisecond))), P = {list_to_atom("P_basic"), <<"Content">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, <<"text_chat">>, Sender, <<"arrakis-server-console">>, undefined}, Content = rabbit_basic:build_content(P, Outer), {ok, Msg} = rabbit_basic:message(XName, Routing, Content), Result = rabbit_queue_type:publish_at_most_once(X, Msg), io:format("publish=~p exchange=chat.whispers routing=~s type=text_chat user_id=~s~n", [Result, Routing, Sender]).`;
  const output = await dockerExec(["exec", RMQ_CONTAINER, "rabbitmqctl", "eval", evalCode], config.commandTimeoutMs);
  if (!/publish=ok/.test(output.stdout)) throw new Error("RabbitMQ whisper publish did not report publish=ok");
  return { ...output, payload };
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

function commandAuthToken(repoRoot) {
  const file = resolve(repoRoot, "runtime/secrets/command-auth-token.txt");
  if (process.env.DUNE_COMMAND_AUTH_TOKEN) return process.env.DUNE_COMMAND_AUTH_TOKEN;
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw) return raw;
  }
  return BUILTIN_COMMAND_AUTH_TOKEN;
}

function dockerExec(args, timeoutMs = 30000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { shell: false, env: { ...process.env } });
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

function validateShutdownType(value) {
  const raw = String(value || "").trim();
  if (["Restart", "Maintenance", "Update"].includes(raw)) return raw;
  throw new Error("shutdownType must be Restart, Maintenance, or Update");
}

function validateWhisperIdentity(value, label) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_#.@:+/-]{1,180}$/.test(raw)) return raw;
  throw new Error(`Care Package welcome whisper cannot be sent: ${label} is unavailable or invalid`);
}

function validateWhisperName(value, label) {
  const raw = String(value || "").trim();
  if (raw.length >= 1 && raw.length <= 80 && !/[\u0000-\u001f]/.test(raw)) return raw;
  throw new Error(`Care Package welcome whisper cannot be sent: ${label} is unavailable or invalid`);
}

function validateHexFlsId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Fa-f0-9]{16,64}$/.test(raw)) return raw;
  throw new Error("Care Package welcome whisper cannot be sent: sender hex FLS ID is unavailable or invalid");
}

function validateMessageId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_.:-]{1,120}$/.test(raw)) return raw;
  throw new Error("Invalid whisper message id");
}
