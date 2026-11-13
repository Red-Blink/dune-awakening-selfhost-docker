import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonAtomic } from "../jsonStore.js";
import { requestRmqGameHttp } from "../rmq.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const CHANNELS = ["Map", "Guild", "Proximity"];
const DEFAULTS = Object.freeze({ enabled: false, retentionDays: 7 });
const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });
const clean = (value, limit) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit) : "";

export function chatSettings(value) {
  if (!value || typeof value.enabled !== "boolean" ||
      !Number.isInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 30) {
    throw fail("Choose collection settings and a retention period from 1 to 30 days.");
  }
  return { enabled: value.enabled, retentionDays: value.retentionDays };
}

// Only explicit fields leave this parser. Raw bodies, coordinates, localized
// arguments, unknown channels and unknown envelopes are never persisted.
export function parseChatMessage(message, now = Date.now()) {
  try {
    if (message?.properties?.type !== "text_chat" || message.payload_bytes > 16384) return null;
    const raw = message.payload_encoding === "base64" ? Buffer.from(message.payload, "base64").toString("utf8") : message.payload;
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 16384) return null;
    const outer = JSON.parse(raw);
    if (outer.Type !== "TextChat") return null;
    const content = outer.content ?? outer.Content;
    const inner = typeof content === "string" ? JSON.parse(content) : null;
    if (!inner || !CHANNELS.includes(inner.m_ChannelType)) return null;
    const channel = inner.m_ChannelType;
    const exchange = message.properties.headers?.redirect_exchange;
    if (!(channel === "Map" && exchange === "chat.map") &&
        !(channel === "Guild" && typeof exchange === "string" && /^chat\.guild\.[A-Za-z0-9_-]{1,128}$/.test(exchange)) &&
        !(channel === "Proximity" && exchange === "chat.proximity")) return null;
    const nativeId = clean(inner.m_Id, 128);
    const sender = clean(message.properties.user_id, 180);
    const text = clean(inner.m_Message?.m_UnlocalizedMessage, 2000);
    if (!nativeId || !sender || !text.trim()) return null;
    // Native display names are supplied by the publisher and are not identity
    // or permission evidence. Retain the broker-authenticated sender separately.
    const senderName = clean(inner.m_SpoofedUserNameFrom?.m_UnlocalizedName || inner.m_FuncomIdFrom, 180);
    const routing = clean(message.routing_key, 180);
    const context = channel === "Map" && /^[A-Za-z0-9_-]+\.[0-9]+$/.test(routing) ? routing :
      channel === "Guild" ? exchange.slice(11) : "";
    const id = createHash("sha256").update(JSON.stringify([sender, nativeId, channel, context])).digest("hex");
    return { id, capturedAt: new Date(now).toISOString(), channel, sender, senderName, context, text };
  } catch { return null; }
}

export function createChatHistory(config, { request = (method, path, body) => requestRmqGameHttp(config, method, path, body), now = Date.now } = {}) {
  const file = resolve(config.generatedDir, "chat-history.json");
  const queue = `dune-console-chat-${randomUUID()}`;
  const queuePath = `/api/queues/%2F/${queue}`;
  const filterExchange = `${queue}-filter`;
  const filterPath = `/api/exchanges/%2F/${filterExchange}`;
  let settings = { ...DEFAULTS }, rows = [], loaded = false, broken = false;
  let pending = null, generation = 0, ready = false, state = "disabled", paused = false;
  let mutations = Promise.resolve();
  let bindingSignature = "";
  let lastCheckedAt = null;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (!existsSync(file)) return;
      if (statSync(file).size > MAX_BYTES) throw new Error();
      const saved = JSON.parse(readFileSync(file, "utf8"));
      settings = chatSettings(saved.settings);
      if (!Array.isArray(saved.rows) || saved.rows.length > MAX_ROWS) throw new Error();
      // Rebuild a strict allowlist when reading disk, too. Never return unknown
      // fields from an old/edited history file through the API.
      rows = saved.rows.filter(row => CHANNELS.includes(row?.channel) && /^[a-f0-9]{64}$/.test(row.id) && Number.isFinite(Date.parse(row.capturedAt)))
        .map(row => ({ id: row.id, capturedAt: row.capturedAt, channel: row.channel,
          sender: clean(row.sender, 180), senderName: clean(row.senderName, 180),
          context: clean(row.context, 180), text: clean(row.text, 2000) }));
      chmodSync(file, 0o600);
      state = settings.enabled ? "starting" : "disabled";
      // Local previews may have stored whispers. Remove them and their setting
      // before serving any history, preserving the operator's other choices.
      if (Object.hasOwn(saved.settings, "whispers") || saved.rows.some(row => row?.channel === "Whispers")) persist();
    } catch { broken = true; settings = { ...DEFAULTS }; rows = []; state = "storage-error"; }
  }

  function prune() {
    const cutoff = now() - settings.retentionDays * 86400000;
    const before = rows.length;
    rows = rows.filter(row => Date.parse(row.capturedAt) >= cutoff && Date.parse(row.capturedAt) <= now()).slice(-MAX_ROWS);
    // Cap encoded bytes, not character count. Leave headroom for settings/JSON.
    let bytes = 1024;
    let start = rows.length;
    while (start > 0) {
      const size = Buffer.byteLength(JSON.stringify(rows[start - 1])) + 1;
      if (bytes + size > MAX_BYTES - 1024) break;
      bytes += size; start--;
    }
    rows = rows.slice(start);
    return before !== rows.length;
  }
  function persist() {
    if (broken) throw new Error("Chat history storage needs attention. Existing data was left intact.");
    prune();
    try { writeJsonAtomic(file, { version: 1, settings, rows }, 0o600, { pretty: false }); chmodSync(file, 0o600); }
    catch { broken = true; state = "storage-error"; throw new Error("Chat history could not be saved."); }
  }
  async function removeQueue() {
    ready = false;
    try { await request("DELETE", queuePath); } catch { /* Expiry cleans up after disconnects. */ }
    try { await request("DELETE", filterPath); } catch { /* Auto-delete removes the filter with its last queue binding. */ }
  }
  function status() {
    load();
    return { settings: { ...settings }, state: broken ? "storage-error" : !settings.enabled ? "disabled" : state,
      lastCheckedAt, maxRows: MAX_ROWS, maxBytes: MAX_BYTES, channels: CHANNELS };
  }
  function mutate(operation) {
    const task = mutations.then(async () => {
      paused = true; generation++;
      try { if (pending) await pending; return await operation(); }
      finally { paused = false; }
    });
    mutations = task.catch(() => {});
    return task;
  }
  function save(value) {
    load();
    if (broken) throw new Error("Chat history storage needs attention. Existing data was left intact.");
    const next = chatSettings(value);
    return mutate(async () => {
      settings = next;
      persist();
      state = settings.enabled ? "starting" : "disabled";
      await removeQueue();
      return status();
    });
  }
  function clear() {
    load();
    return mutate(async () => {
      await removeQueue();
      rows = []; persist();
      return { ok: true };
    });
  }
  async function capture() {
    load();
    if (broken) return;
    if (prune()) persist();
    if (!settings.enabled || config.mockMode) { state = config.mockMode && settings.enabled ? "unavailable" : "disabled"; return; }
    const version = generation;
    try {
      const topology = await request("GET", "/api/exchanges/%2F?columns=name,type");
      if (!Array.isArray(topology)) throw new Error();
      const allowed = ["chat.map", "chat.proximity", ...topology.map(row => row.name)
        .filter(name => typeof name === "string" && /^chat\.guild\.[A-Za-z0-9_-]{1,128}$/.test(name)).sort()];
      const signature = JSON.stringify(allowed);
      if (ready && signature !== bindingSignature) await removeQueue();
      if (!ready) {
        await request("PUT", queuePath, { durable: false, auto_delete: false, arguments: {
          "x-expires": 60000, "x-message-ttl": 60000, "x-max-length": 500, "x-max-length-bytes": 2 * 1024 * 1024, "x-overflow": "drop-head"
        } });
        await request("PUT", filterPath, { type: "headers", durable: false, auto_delete: true, internal: true, arguments: {} });
        // Filtering happens INSIDE RabbitMQ before messages reach our queue.
        // A topic '#' tap would also receive whispers; never attach it directly
        // to the recorder queue. Header matches allow only reviewed channels.
        for (const name of allowed) {
          await request("POST", `/api/bindings/%2F/e/${filterExchange}/q/${queue}`, {
            routing_key: "", arguments: { "x-match": "all", redirect_exchange: name }
          });
        }
        await request("POST", `/api/bindings/%2F/e/chat.intercept/e/${filterExchange}`, { routing_key: "#", arguments: {} });
        bindingSignature = signature;
        ready = true;
      }
      const messages = await request("POST", `${queuePath}/get`, { count: 50, ackmode: "ack_requeue_false", encoding: "base64", truncate: 16384 });
      if (!Array.isArray(messages)) throw new Error();
      if (version !== generation) return;
      const ids = new Set(rows.map(row => row.id));
      let added = false;
      for (const message of messages.slice(0, 50)) {
        const row = parseChatMessage(message, now());
        if (!row || ids.has(row.id)) continue;
        rows.push(row); ids.add(row.id); added = true;
      }
      if (added) persist();
      state = "recording";
    } catch { ready = false; state = "unavailable"; }
    finally { lastCheckedAt = new Date(now()).toISOString(); }
  }
  function tick() {
    if (paused) return Promise.resolve();
    if (!pending) pending = capture().catch(() => { state = "storage-error"; }).finally(() => { pending = null; });
    return pending;
  }
  function read(query = {}) {
    load();
    if (prune()) persist();
    const q = String(query.q || "").slice(0, 200).toLocaleLowerCase();
    const channel = String(query.channel || "");
    const context = String(query.context || "").slice(0, 180).toLocaleLowerCase();
    const page = Number(query.page || 0), limit = Number(query.limit || 50);
    if (!Number.isInteger(page) || page < 0 || page > 10000 || ![25, 50, 100, 200].includes(limit) ||
        (channel && !CHANNELS.includes(channel))) throw fail("Choose valid chat filters and pagination.");
    const selected = rows.filter(row => (!channel || row.channel === channel) && (!context || row.context.toLocaleLowerCase().includes(context)) &&
        (!q || [row.text, row.sender, row.senderName].some(value => value.toLocaleLowerCase().includes(q)))).reverse();
    return { ...status(), rows: selected.slice(page * limit, (page + 1) * limit), total: selected.length, page, limit };
  }
  return { tick, read, save, clear, status, close: async () => { generation++; if (pending) await pending; await removeQueue(); } };
}
