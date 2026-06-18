import { buildDuneArgs, runDune } from "../../runner.js";
import { sanitizeDiscordValue } from "./sanitize.js";

const SERVICE_LABELS = new Map([
  ["dune-postgres", "Database"],
  ["dune-rmq-admin", "RabbitMQ Admin"],
  ["dune-rmq-game", "RabbitMQ Game"],
  ["dune-text-router", "Text Router"],
  ["dune-director", "Director"],
  ["dune-server-gateway", "Gateway"],
  ["dune-server-survival-1", "Survival"],
  ["dune-server-overmap", "Overmap"],
  ["dune-orchestrator", "Orchestrator"],
  ["dune-autoscaler", "Autoscaler"]
]);

export async function discordReadinessProvider(config) {
  const result = await runDune(config, buildDuneArgs("readiness"), {
    timeoutMs: 30000,
    allowedExitCodes: [0, 1, 2]
  });
  return parseReadinessOutput(result.stdout || result.stderr || "", result.code);
}

export async function discordServicesProvider(config) {
  const result = await runDune(config, buildDuneArgs("services"), {
    timeoutMs: 30000,
    allowedExitCodes: [0]
  });
  return parseServicesOutput(result.stdout || result.stderr || "");
}

export function parseReadinessOutput(stdout = "", exitCode = 0) {
  const json = parseJsonObject(stdout);
  if (Object.keys(json).length > 0) return publicReadinessSummary(json, exitCode);

  const text = sanitizeDiscordValue(String(stdout || ""));
  const issueLines = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\b(FAIL|FAILED|MISSING|ERROR|ISSUE|NOT READY|WARN|WARNING)\b/i.test(line))
    .map(compactOperationalLine)
    .filter(Boolean)
    .slice(0, 10);

  const ready = exitCode === 0 && issueLines.length === 0 && !/\b(FAIL|FAILED|MISSING|ERROR|ISSUE|NOT READY)\b/i.test(text);
  return {
    ready,
    overall: ready ? "READY" : "ISSUE",
    issues: issueLines
  };
}

export function parseServicesOutput(stdout = "") {
  const services = [];
  const issues = [];

  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^SERVICE\s+STATUS$/i.test(line) || /^===/.test(line)) continue;

    const serviceName = [...SERVICE_LABELS.keys()].find((name) => line.startsWith(name));
    if (!serviceName) continue;

    const statusText = line.slice(serviceName.length).trim();
    const status = normalizeServiceStatus(statusText);
    const service = {
      name: SERVICE_LABELS.get(serviceName),
      status
    };
    services.push(service);
    if (status !== "up") issues.push(`${service.name} is ${status}`);
  }

  return {
    overall: issues.length === 0 ? "OK" : "ISSUE",
    services,
    issues
  };
}

export function publicReadinessSummary(value = {}, exitCode = 0) {
  const readyValue = value.ready ?? value.ok ?? value.readiness ?? value.status;
  const ready = typeof readyValue === "boolean"
    ? readyValue
    : !/issue|fail|missing|error|not ready/i.test(String(readyValue || "")) && exitCode === 0;
  return {
    ready,
    overall: ready ? "READY" : "ISSUE",
    issues: Array.isArray(value.issues)
      ? value.issues.map((issue) => compactOperationalLine(sanitizeDiscordValue(String(issue)))).filter(Boolean).slice(0, 10)
      : []
  };
}

function parseJsonObject(stdout = "") {
  const text = String(stdout || "").trim();
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

function normalizeServiceStatus(value = "") {
  const text = String(value || "").trim();
  if (/^up\b/i.test(text)) return "up";
  if (/missing/i.test(text)) return "missing";
  if (/exited|stopped|down/i.test(text)) return "down";
  if (/starting|created|restarting/i.test(text)) return "starting";
  return text ? "unknown" : "unknown";
}

function compactOperationalLine(line = "") {
  return String(line || "")
    .replace(/\b\d{1,5}\/(tcp|udp)\b/gi, "<port>")
    .replace(/\bdune-[a-z0-9-]+\b/gi, (match) => SERVICE_LABELS.get(match) || "service")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
