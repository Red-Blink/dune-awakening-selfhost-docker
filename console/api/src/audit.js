import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { redact, redactValue } from "./redact.js";

// In-memory rolling window of addon-bridge request outcomes, used by
// addonOpsSocSummary() (duneDb.js) to compute a live bridgeRequests/
// bridgeErrors/bridgeSuccessRate for the OPS observability addon's SOC
// tab, without re-parsing the (potentially large, and growing) audit log
// file on every request. Deliberately in-memory rather than file-based:
// this project's audit log is a durable record intended for security
// review and incident investigation, not a metrics store, and re-reading
// a multi-thousand-line file on every SOC-tab refresh would not scale.
//
// Trade-off, stated explicitly: this resets to empty on every process
// restart. A brand-new process reporting "0 requests, 0 errors" for the
// first few minutes after a restart is the correct, honest answer to
// "how many bridge requests happened in the last hour" — it is not a bug
// to work around by persisting this across restarts.
const BRIDGE_REQUEST_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const bridgeRequestLog = [];

function pruneBridgeRequestLog(now = Date.now()) {
  const cutoff = now - BRIDGE_REQUEST_WINDOW_MS;
  while (bridgeRequestLog.length && bridgeRequestLog[0].at < cutoff) {
    bridgeRequestLog.shift();
  }
}

export function getBridgeRequestSummary(now = Date.now()) {
  pruneBridgeRequestLog(now);
  const requests = bridgeRequestLog.length;
  const errors = bridgeRequestLog.reduce((count, entry) => count + (entry.ok === false ? 1 : 0), 0);
  return { requests, errors };
}

export function audit(config, req, action, detail = {}) {
  mkdirSync(dirname(config.auditLog), { recursive: true });
  const row = {
    timestamp: new Date().toISOString(),
    action,
    method: req?.method,
    path: req?.url,
    remote: req?.socket?.remoteAddress,
    detail: redactValue(detail)
  };
  appendFileSync(config.auditLog, `${JSON.stringify(row)}\n`, { mode: 0o600 });

  if (action === "addons.bridge") {
    const now = Date.now();
    bridgeRequestLog.push({ at: now, ok: detail?.ok !== false });
    pruneBridgeRequestLog(now);
  }
}

export function recordAdminHistory(config, { command, target = "-", friendly = "", path = "web", result = "ok", message = "" }) {
  mkdirSync(config.generatedDir, { recursive: true });
  const safeMessage = redact(String(message || "")).replace(/[\r\n\t]/g, " ").slice(0, 160);
  const columns = [
    new Date().toISOString(),
    safeColumn(command),
    safeColumn(target),
    safeColumn(friendly),
    safeColumn(path),
    safeColumn(result),
    safeMessage ? JSON.stringify({ messagePreview: safeMessage }) : "{}"
  ];
  appendFileSync(join(config.generatedDir, "admin-command-history.tsv"), `${columns.join("\t")}\n`, { mode: 0o600 });
}

function safeColumn(value) {
  return redact(String(value || "-")).replace(/[\r\n\t]/g, " ").slice(0, 160);
}
