import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { redact, redactValue } from "./redact.js";

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
  secureAuditFile(config.auditLog);
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
  const historyFile = join(config.generatedDir, "admin-command-history.tsv");
  appendFileSync(historyFile, `${columns.join("\t")}\n`, { mode: 0o600 });
  secureAuditFile(historyFile);
}

function safeColumn(value) {
  return redact(String(value || "-")).replace(/[\r\n\t]/g, " ").slice(0, 160);
}

function secureAuditFile(path) {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX development hosts.
  }
}
