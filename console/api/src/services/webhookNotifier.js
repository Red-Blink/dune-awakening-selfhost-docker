// Outgoing webhook notifications (Discord or generic JSON).
//
// Three events:
//   serverRestart  -- every row appended to restart-history.jsonl. That journal
//                     is already written by every restart path (Console tasks,
//                     restart-schedule.sh, update.sh, restart-game-farm.sh), so
//                     following it covers manual and automatic restarts alike.
//   gameUpdate     -- the Steam update check reports a new build.
//   consoleUpdate  -- the stack self-update check reports a new release.
//
// Webhook URLs carry their own credential (a Discord webhook token), so they
// are stored 0600 and never returned to the browser; the view exposes a hint.
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { redact } from "../redact.js";
import { clampInt, writeJsonAtomic } from "../jsonStore.js";
import { readRestartRowsSince } from "./restartHistory.js";

const SETTINGS_PATH = "runtime/generated/webhook-settings.json";
const STATE_PATH = "runtime/generated/webhook-state.json";

const WEBHOOK_EVENTS = ["serverRestart", "gameUpdate", "consoleUpdate"];
const UPDATE_EVENTS = ["gameUpdate", "consoleUpdate"];
const WEBHOOK_TYPES = ["discord", "generic"];
const MAX_WEBHOOKS = 5;
const UPDATE_CHECK_MINUTES_DEFAULT = 60;
// The game update check result is cached for 30 minutes (config
// updateCheckCacheMs); a shorter interval would only re-read that cache.
const UPDATE_CHECK_MINUTES_MIN = 30;
const UPDATE_CHECK_MINUTES_MAX = 1440;
const FIRST_UPDATE_CHECK_DELAY_MS = 2 * 60_000;

const MAX_URL_LENGTH = 2048;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 30_000;
const COLORS = { ok: 0x2e9d5b, fail: 0xd64545, update: 0xe0a526, info: 0x4f7fd9 };

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function fileMtime(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

function readJsonObject(file) {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    console.warn(`Ignoring unreadable webhook file: ${redact(error?.message || "Unexpected error.")}`);
    return {};
  }
}

// ---- URL validation ----

function isPrivateAddress(host) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(bare);
  if (version === 4) {
    const [a, b] = bare.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) {
    return bare === "::" || bare === "::1" || /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare) || bare.startsWith("::ffff:");
  }
  return bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".local") || bare.endsWith(".internal");
}

// Settings are admin-only (settings:write); that, HTTPS and never following a
// redirect (see deliverWebhook) are the actual guard. The private-host check
// only rejects obvious literal mistakes: the name is not resolved here, so a
// public name pointing at a private address still passes.
export function validateWebhookUrl(value, type) {
  const text = String(value || "").trim();
  if (!text) throw badRequest("Webhook URL is required.");
  if (text.length > MAX_URL_LENGTH) throw badRequest("Webhook URL is too long.");
  let url;
  try { url = new URL(text); } catch { throw badRequest("Webhook URL is not a valid URL."); }
  if (url.protocol !== "https:") throw badRequest("Webhook URL must start with https://.");
  if (url.username || url.password) throw badRequest("Webhook URL must not contain a user name or password.");
  if (isPrivateAddress(url.hostname)) throw badRequest("Webhook URL must point to a public host.");
  if (type === "discord") {
    const discordHost = /(^|\.)(discord\.com|discordapp\.com)$/i.test(url.hostname);
    if (!discordHost || !/^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)) {
      throw badRequest("Discord webhook URL must look like https://discord.com/api/webhooks/<id>/<token>.");
    }
  }
  return url.toString();
}

function urlHint(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}/…${url.pathname.replace(/\/$/, "").slice(-4)}`;
  } catch {
    return "";
  }
}

// ---- Settings ----

function normalizeWebhook(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: typeof raw.id === "string" && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : randomUUID(),
    name: String(raw.name || "").replace(/[\r\n\t]/g, " ").trim().slice(0, 60) || "Webhook",
    type: WEBHOOK_TYPES.includes(raw.type) ? raw.type : "discord",
    url: typeof raw.url === "string" ? raw.url : "",
    enabled: raw.enabled !== false,
    events: Array.isArray(raw.events) ? WEBHOOK_EVENTS.filter((event) => raw.events.includes(event)) : [...WEBHOOK_EVENTS],
    includeMapRestarts: raw.includeMapRestarts === true
  };
}

function normalizeSettings(stored) {
  return {
    updateCheckMinutes: clampInt(stored.updateCheckMinutes, UPDATE_CHECK_MINUTES_DEFAULT, UPDATE_CHECK_MINUTES_MIN, UPDATE_CHECK_MINUTES_MAX),
    webhooks: Array.isArray(stored.webhooks) ? stored.webhooks.map(normalizeWebhook).filter(Boolean).slice(0, MAX_WEBHOOKS) : []
  };
}

function settingsView(settings, deliveries) {
  return {
    updateCheckMinutes: settings.updateCheckMinutes,
    webhooks: settings.webhooks.map(({ url, ...hook }) => ({
      ...hook,
      hasUrl: Boolean(url),
      urlHint: urlHint(url),
      lastDelivery: deliveries[hook.id] || null
    })),
    limits: {
      maxWebhooks: MAX_WEBHOOKS,
      updateCheckMinutes: { min: UPDATE_CHECK_MINUTES_MIN, max: UPDATE_CHECK_MINUTES_MAX }
    }
  };
}

// The browser never sees stored URLs, so an existing webhook saved without a
// `url` keeps the current one. A non-empty `url` replaces it.
function validateSettings(payload, current) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw badRequest("Webhook settings must be an object.");
  if (!Array.isArray(payload.webhooks)) throw badRequest("webhooks must be a list.");
  if (payload.webhooks.length > MAX_WEBHOOKS) throw badRequest(`At most ${MAX_WEBHOOKS} webhooks can be configured.`);
  const minutes = Number(payload.updateCheckMinutes ?? UPDATE_CHECK_MINUTES_DEFAULT);
  if (!Number.isInteger(minutes) || minutes < UPDATE_CHECK_MINUTES_MIN || minutes > UPDATE_CHECK_MINUTES_MAX) {
    throw badRequest(`updateCheckMinutes must be a whole number between ${UPDATE_CHECK_MINUTES_MIN} and ${UPDATE_CHECK_MINUTES_MAX}.`);
  }
  const existing = new Map(current.webhooks.map((hook) => [hook.id, hook]));
  const seen = new Set();
  const webhooks = payload.webhooks.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Each webhook must be an object.");
    if (raw.type !== undefined && !WEBHOOK_TYPES.includes(raw.type)) throw badRequest("Webhook type must be discord or generic.");
    if (raw.events !== undefined && (!Array.isArray(raw.events) || raw.events.some((event) => !WEBHOOK_EVENTS.includes(event)))) {
      throw badRequest(`Webhook events must be any of: ${WEBHOOK_EVENTS.join(", ")}.`);
    }
    const previous = typeof raw.id === "string" ? existing.get(raw.id) : undefined;
    const hook = normalizeWebhook({ ...raw, id: previous?.id });
    if (seen.has(hook.id)) throw badRequest("Webhook ids must be unique.");
    seen.add(hook.id);
    const newUrl = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!newUrl && !previous?.url) throw badRequest(`Webhook "${hook.name}" needs a URL.`);
    // Re-validated even when kept: a type change must satisfy the Discord check.
    hook.url = validateWebhookUrl(newUrl || previous.url, hook.type);
    return hook;
  });
  return { updateCheckMinutes: minutes, webhooks };
}

// ---- Event messages ----

const RESTART_TRIGGERS = {
  Console: "Manual (Console)",
  Scheduled: "Automatic (scheduled restart)",
  Automatic: "Automatic (recovery)",
  "Game Update": "Game update",
  Runtime: "Runtime (CLI or script)"
};

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
}

export function restartEvent(row) {
  const ok = row.result === "Succeeded";
  return {
    type: "serverRestart",
    title: ok ? "Server restarted" : "Server restart failed",
    message: `${row.target}: ${row.reason}`,
    color: ok ? COLORS.ok : COLORS.fail,
    fields: [
      { name: "Trigger", value: RESTART_TRIGGERS[row.source] || row.source || "Unknown" },
      { name: "Scope", value: row.scope === "battlegroup" ? "Battlegroup" : row.scope === "map" ? "Map" : "Service" },
      { name: "Result", value: row.result },
      { name: "Duration", value: formatDuration(row.durationSeconds) }
    ],
    timestamp: row.finishedAt || new Date().toISOString(),
    data: { ...row }
  };
}

function lineValue(text, pattern) {
  return String(text || "").match(pattern)?.[1]?.trim() || "";
}

// These read the version lines printed by `update.sh check` and
// `self-update.sh check` (print_versions); test/webhookNotifier.test.js pins
// those echo lines so a wording change there fails a test instead of silently
// announcing "Unknown".
export function parseGameUpdate(stdout) {
  return {
    installed: lineValue(stdout, /^Local build:\s*(\S+)/m),
    latest: lineValue(stdout, /^Remote build:\s*(\S+)/m)
  };
}

export function parseConsoleUpdate(stdout) {
  return {
    installed: lineValue(stdout, /^Current stack version:\s*(\S+)/m),
    latest: lineValue(stdout, /^Latest release:\s*(\S+)/m),
    repository: lineValue(stdout, /^GitHub repo:\s*([\w.-]+\/[\w.-]+)/m)
  };
}

function gameUpdateEvent({ installed, latest }) {
  return {
    type: "gameUpdate",
    title: "Game update available",
    message: "A new Dune: Awakening server build is available on Steam.",
    color: COLORS.update,
    fields: [
      { name: "Installed build", value: installed || "Unknown" },
      { name: "New build", value: latest || "Unknown" }
    ],
    timestamp: new Date().toISOString(),
    data: { installed, latest }
  };
}

function consoleUpdateEvent({ installed, latest, repository }) {
  const releaseUrl = repository && latest ? `https://github.com/${repository}/releases/tag/${encodeURIComponent(latest)}` : "";
  return {
    type: "consoleUpdate",
    title: "Console update available",
    message: "A new Dune Docker release is available.",
    color: COLORS.update,
    url: releaseUrl,
    fields: [
      { name: "Installed version", value: installed || "Unknown" },
      { name: "New version", value: latest || "Unknown" }
    ],
    timestamp: new Date().toISOString(),
    data: { installed, latest, releaseUrl }
  };
}

function testEvent() {
  return {
    type: "test",
    title: "Webhook test",
    message: "Dune Docker can reach this webhook.",
    color: COLORS.info,
    fields: [],
    timestamp: new Date().toISOString(),
    data: {}
  };
}

export function buildPayload(type, event, footer) {
  if (type === "discord") {
    const embed = {
      title: event.title.slice(0, 256),
      description: event.message.slice(0, 2000),
      color: event.color,
      fields: event.fields.map((field) => ({ name: field.name.slice(0, 256), value: String(field.value).slice(0, 1024) || "-", inline: true })),
      timestamp: event.timestamp,
      footer: { text: footer.slice(0, 2048) }
    };
    if (event.url) embed.url = event.url;
    // Mentions are disabled: a map name or reason must never ping @everyone.
    return { username: "Dune Docker", embeds: [embed], allowed_mentions: { parse: [] } };
  }
  return {
    source: "dune-docker",
    event: event.type,
    title: event.title,
    message: event.message,
    timestamp: event.timestamp,
    fields: Object.fromEntries(event.fields.map((field) => [field.name, field.value])),
    data: event.data,
    footer
  };
}

// ---- Delivery ----

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function deliverWebhook(hook, event, { fetchImpl = fetch, footer = "Dune Docker" } = {}) {
  const body = JSON.stringify(buildPayload(hook.type, event, footer));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "DuneDocker-Webhook" },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
      });
    } catch (error) {
      return { ok: false, status: 0, error: redact(error?.name === "TimeoutError" ? "Request timed out." : error?.message || "Request failed.") };
    }
    // Only the status is used; release the body so the connection returns
    // to the pool instead of waiting for garbage collection.
    try { await response.body?.cancel(); } catch {}
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000;
      if (waitMs <= MAX_RETRY_AFTER_MS) { await sleep(waitMs); continue; }
    }
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, error: "" };
    return { ok: false, status: response.status, error: `Webhook answered with HTTP ${response.status}.` };
  }
  return { ok: false, status: 429, error: "Webhook is rate limited." };
}

// ---- Notifier ----

function isActive(hook) {
  return hook.enabled && Boolean(hook.url);
}

// What decides whether an update check is due: a change here (new interval,
// an update event switched on) runs the next check right away.
function updateScheduleKey(settings) {
  const subscriptions = settings.webhooks.filter(isActive)
    .map((hook) => `${hook.id}:${hook.events.filter((event) => UPDATE_EVENTS.includes(event)).join(",")}`);
  return `${settings.updateCheckMinutes}|${subscriptions.join(";")}`;
}

export function createWebhookNotifier(options) {
  const settingsFile = resolve(options.repoRoot || "", SETTINGS_PATH);
  const stateFile = resolve(options.repoRoot || "", STATE_PATH);
  const restartHistoryFile = options.restartHistoryFile;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const footer = options.version ? `Dune Docker ${options.version}` : "Dune Docker";
  const updateKinds = {
    gameUpdate: { read: options.readGameUpdate, parse: parseGameUpdate, event: gameUpdateEvent },
    consoleUpdate: { read: options.readConsoleUpdate, parse: parseConsoleUpdate, event: consoleUpdateEvent }
  };
  const deliveries = {};
  // Both files are normally written only by this notifier, so they are kept
  // in memory. Their mtimes are remembered after each own write: a different
  // mtime means something else replaced them (a system backup restore), and
  // the next tick reloads them.
  let settings;
  let settingsMtime;
  let state;
  let persistedState;
  let stateMtime;
  let nextUpdateCheckAt = now() + (options.firstUpdateCheckDelayMs ?? FIRST_UPDATE_CHECK_DELAY_MS);
  let restartPassRunning = false;
  let updatePass = null;

  function loadSettings() {
    settings = normalizeSettings(readJsonObject(settingsFile));
    settingsMtime = fileMtime(settingsFile);
  }

  function loadState() {
    state = readJsonObject(stateFile);
    persistedState = JSON.stringify(state);
    stateMtime = fileMtime(stateFile);
  }

  function reloadChangedFiles() {
    if (fileMtime(settingsFile) !== settingsMtime) loadSettings();
    if (fileMtime(stateFile) !== stateMtime) loadState();
  }

  loadSettings();
  loadState();

  function persistState() {
    const text = JSON.stringify(state);
    if (text === persistedState) return;
    try {
      writeJsonAtomic(stateFile, state, 0o600);
      persistedState = text;
      stateMtime = fileMtime(stateFile);
    } catch (error) {
      console.warn(`Webhook state could not be saved: ${redact(error?.message || "Unexpected error.")}`);
    }
  }

  async function send(hook, event) {
    const result = await deliverWebhook(hook, event, { fetchImpl, footer });
    deliveries[hook.id] = { at: new Date(now()).toISOString(), event: event.type, ...result };
    if (!result.ok) console.warn(`Webhook "${hook.name}" (${event.type}) failed: ${result.error}`);
    return result;
  }

  // Hooks run in parallel so one slow endpoint cannot hold up the others;
  // each hook still receives its events in journal order.
  async function deliverRestarts(hooks, rows) {
    await Promise.all(hooks.map(async (hook) => {
      if (!hook.events.includes("serverRestart")) return;
      for (const row of rows) {
        if (row.scope === "battlegroup" || hook.includeMapRestarts) await send(hook, restartEvent(row));
      }
    }));
  }

  // Deduplicated per webhook: a webhook added while an update is pending
  // still hears about it, and one whose delivery failed is retried on the
  // next check. state[kind].notified maps webhook id -> announced version.
  async function checkUpdate(kind, hooks) {
    const subscribed = hooks.filter((hook) => hook.events.includes(kind));
    if (!subscribed.length) return;
    const spec = updateKinds[kind];
    let result;
    try { result = await spec.read(); } catch (error) {
      console.warn(`Webhook ${kind} check failed: ${redact(error?.message || "Unexpected error.")}`);
      return;
    }
    if (result?.code !== 100) {
      state[kind] = { notified: {} };
      return;
    }
    const details = spec.parse(result.stdout);
    const key = details.latest || "unknown";
    const notified = { ...(state[kind]?.notified || {}) };
    const targets = subscribed.filter((hook) => notified[hook.id] !== key);
    if (!targets.length) return;
    const event = spec.event(details);
    const results = await Promise.all(targets.map((hook) => send(hook, event)));
    targets.forEach((hook, index) => { if (results[index].ok) notified[hook.id] = key; });
    // Drop webhooks that no longer exist so the state cannot grow unbounded.
    const known = new Set(settings.webhooks.map((hook) => hook.id));
    state[kind] = { notified: Object.fromEntries(Object.entries(notified).filter(([id]) => known.has(id))) };
  }

  async function restartPass(hooks) {
    if (restartPassRunning) return;
    restartPassRunning = true;
    try {
      // The cursor advances even with no webhook configured, so enabling one
      // later announces only restarts that happen from then on.
      const { rows, cursor } = readRestartRowsSince(restartHistoryFile, state.restart);
      state.restart = cursor;
      if (rows.length && hooks.length) await deliverRestarts(hooks, rows);
      persistState();
    } finally {
      restartPassRunning = false;
    }
  }

  // Update checks can take minutes (steamcmd, GitHub). They run beside the
  // restart pass, with their own in-flight guard, so a slow check never
  // delays restart announcements on the following ticks.
  function startUpdatePass(hooks) {
    if (updatePass || now() < nextUpdateCheckAt) return null;
    if (!hooks.some((hook) => hook.events.some((event) => UPDATE_EVENTS.includes(event)))) return null;
    nextUpdateCheckAt = now() + settings.updateCheckMinutes * 60_000;
    updatePass = Promise.all(UPDATE_EVENTS.map((kind) => checkUpdate(kind, hooks)))
      .then(() => persistState())
      .finally(() => { updatePass = null; });
    return updatePass;
  }

  async function tick() {
    reloadChangedFiles();
    const hooks = settings.webhooks.filter(isActive);
    await Promise.all([restartPass(hooks), startUpdatePass(hooks)]);
  }

  function view() {
    return settingsView(settings, deliveries);
  }

  function save(payload) {
    reloadChangedFiles();
    const next = validateSettings(payload, settings);
    writeJsonAtomic(settingsFile, next, 0o600);
    if (updateScheduleKey(next) !== updateScheduleKey(settings)) nextUpdateCheckAt = 0;
    settings = next;
    settingsMtime = fileMtime(settingsFile);
    return view();
  }

  async function sendTest(id) {
    const hook = settings.webhooks.find((entry) => entry.id === id);
    if (!hook) throw Object.assign(new Error("Webhook not found. Save it before sending a test."), { statusCode: 404 });
    return send(hook, testEvent());
  }

  return { tick, view, save, sendTest };
}
