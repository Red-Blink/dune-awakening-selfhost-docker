import { buildDuneArgs, runDune } from "../../runner.js";
import { sanitizeDiscordPublicStatus, sanitizeDiscordValue } from "./sanitize.js";

const PUBLIC_STATUS_FIELDS = new Set([
  "overall",
  "title",
  "region",
  "mode",
  "population",
  "maps",
  "issues"
]);

export async function discordStatusProvider(config, { diagnostic = false } = {}) {
  const result = await runDune(config, buildDuneArgs("status"), {
    timeoutMs: 15000,
    allowedExitCodes: [0]
  });
  const parsed = parseStatusOutput(result.stdout);
  if (diagnostic) return detailedStatusSummary(parsed, result.stdout);
  return sanitizeDiscordPublicStatus(publicStatusSummary(parsed));
}

export function parseStatusOutput(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return {};

  const json = parseStatusJson(text);
  if (Object.keys(json).length > 0) return json;

  return parseTextStatus(text);
}

export function parseStatusJson(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return {};

  // Prefer the last JSON object in case the underlying script prints a banner first.
  const candidates = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") candidates.push(text.slice(i));
  }
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate);
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      // Try the next opening brace.
    }
  }
  return {};
}

export function parseTextStatus(stdout = "") {
  const status = { maps: [], services: [], listeners: [], issues: [] };
  let section = "";

  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const sectionMatch = line.match(/^===\s+(.+?)\s+===$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }

    const keyValue = line.match(/^([A-Za-z][A-Za-z _-]+):\s+(.+)$/);
    if (keyValue && section === "dune status") {
      const key = normalizeStatusKey(keyValue[1]);
      if (["overall", "title", "region", "mode", "population"].includes(key)) {
        status[key] = keyValue[2].trim();
      }
      continue;
    }

    if (section === "containers") {
      if (/^SERVICE\s+STATUS$/i.test(line)) continue;
      const serviceMatch = line.match(/^(dune-[a-z0-9-]+)\s+(.+)$/i);
      if (serviceMatch) {
        const entry = { name: serviceMatch[1], status: normalizeRuntimeStatus(serviceMatch[2]) };
        status.services.push(entry);
        if (entry.status !== "up") status.issues.push(`${entry.name} is ${entry.status}`);
      }
      continue;
    }

    if (section === "listeners") {
      if (/^CHECK\s+PORT\s+STATUS$/i.test(line)) continue;
      const listenerMatch = line.match(/^(.+?)\s+\d{1,5}\/(tcp|udp)\s+([A-Z]+)$/i);
      if (listenerMatch) {
        const entry = { check: listenerMatch[1].trim(), status: listenerMatch[3].toUpperCase() };
        status.listeners.push(entry);
        if (entry.status !== "OK") status.issues.push(`${entry.check} is ${entry.status}`);
      }
      continue;
    }

    if (section === "game servers") {
      if (/^MAP\s+STATE\s+UPTIME$/i.test(line)) continue;
      const mapMatch = line.match(/^([A-Za-z0-9_-]+)\s+([A-Z_]+)\s+(.+)$/);
      if (mapMatch) {
        status.maps.push({
          name: mapMatch[1],
          state: mapMatch[2],
          uptime: mapMatch[3]
        });
        if (mapMatch[2] !== "READY") status.issues.push(`${mapMatch[1]} is ${mapMatch[2]}`);
      }
      continue;
    }
  }

  if (status.overall && status.overall !== "OK") status.issues.unshift(`Overall status is ${status.overall}`);
  return status;
}

export function publicStatusSummary(status = {}) {
  const summary = {};
  for (const [key, value] of Object.entries(status || {})) {
    if (PUBLIC_STATUS_FIELDS.has(key)) summary[key] = value;
  }
  if (!Array.isArray(summary.maps)) delete summary.maps;
  if (!Array.isArray(summary.issues)) delete summary.issues;
  return summary;
}

export function detailedStatusSummary(status = {}, rawOutput = "") {
  return sanitizeDiscordValue({
    ...status,
    redactedOutput: sanitizeDiscordValue(String(rawOutput || "")).slice(0, 3000)
  });
}

function normalizeStatusKey(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeRuntimeStatus(value = "") {
  const text = String(value || "").trim();
  if (/^up\b/i.test(text)) return "up";
  if (/missing/i.test(text)) return "missing";
  if (/exited|stopped|down/i.test(text)) return "down";
  if (/starting|created|restarting/i.test(text)) return "starting";
  return text ? "unknown" : "unknown";
}
