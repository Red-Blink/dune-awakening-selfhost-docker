import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { READ_ONLY_BRIDGE_ACTIONS } from "./bridgeReadActions.js";
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

// Who performed the action, in a form that is safe to write to a durable log.
//
// Deliberately NOT the browser session id: that id is half of the asc_session
// cookie value, so writing it here would put a credential component into a file
// kept for security review. The API key id is safe -- it is the public half of
// the key and is already shown in the console's key list.
//
// Returns null for the pre-auth routes (login, logout, the Discord adapter),
// which run before req.authSession is set. That is the honest answer for them.
export function principalOf(session) {
  if (!session) return null;
  if (session.apiKeyId) return { type: "api-key", id: session.apiKeyId };
  const principal = { type: "session", tier: session.tier || "" };
  if (session.userId) principal.userId = session.userId;
  return principal;
}

// High-volume, read-only bridge polls are batched and written every
// AUDIT_FLUSH_MS (and on shutdown, see installAuditShutdownHooks). Everything
// else -- every non-bridge action, every failed or denied bridge call, and every
// bridge action that can change state (database.execute, rewards.deliver,
// admin.items.grant, ...) -- is written synchronously, because the audit log is
// the durable record for incident investigation and must not lose a mutation to
// a crash. A synchronous write first flushes the pending batch so the file keeps
// the order the requests happened in. While the file is unwritable (see the
// backoff in flushAuditLog) queued polls stay behind and are appended after
// later synchronous rows; every row carries its own timestamp.
const AUDIT_FLUSH_MS = 200;
const AUDIT_FLUSH_MAX_BACKOFF_MS = 10000;
const AUDIT_MAX_PENDING_LINES = 5000;
const pendingAuditLines = new Map();
const verifiedAuditDirs = new Set();
let pendingAuditCount = 0;
let auditFlushTimer = null;
let auditFlushDelay = AUDIT_FLUSH_MS;
let auditRetryNotBefore = 0;
let auditFailureReported = false;
let auditDroppedRows = 0;

function ensureAuditDir(dir) {
  if (!dir || verifiedAuditDirs.has(dir)) return;
  mkdirSync(dir, { recursive: true });
  verifiedAuditDirs.add(dir);
}

function appendFileEnsureDir(file, content, options = { mode: 0o600 }) {
  const dir = dirname(file);
  ensureAuditDir(dir);
  try {
    appendFileSync(file, content, options);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      verifiedAuditDirs.delete(dir);
      ensureAuditDir(dir);
      appendFileSync(file, content, options);
      return;
    }
    throw error;
  }
}

function bufferableBridgeRow(action, detail) {
  if (action !== "addons.bridge" || detail?.ok !== true) return false;
  return READ_ONLY_BRIDGE_ACTIONS.has(String(detail.action || ""));
}

export function pendingAuditRowCount() {
  return pendingAuditCount;
}

// A file's lines leave the queue only after they were appended, so a failed
// flush keeps them for the next attempt. The first error is rethrown after
// every file was tried. After a failure the next attempt is not due for a
// growing delay (up to AUDIT_FLUSH_MAX_BACKOFF_MS); a caller on a request path
// passes respectBackoff so an unwritable file is not retried on every request.
// Shutdown and explicit calls always try.
export function flushAuditLog({ respectBackoff = false } = {}) {
  if (respectBackoff && Date.now() < auditRetryNotBefore) return;
  if (auditFlushTimer) {
    clearTimeout(auditFlushTimer);
    auditFlushTimer = null;
  }
  let failure = null;
  for (const [file, lines] of [...pendingAuditLines]) {
    try {
      appendFileEnsureDir(file, lines.join(""), { mode: 0o600 });
      pendingAuditLines.delete(file);
      pendingAuditCount -= lines.length;
    } catch (error) {
      failure ||= error;
    }
  }
  if (failure) {
    auditRetryNotBefore = Date.now() + auditFlushDelay;
    auditFlushDelay = Math.min(auditFlushDelay * 2, AUDIT_FLUSH_MAX_BACKOFF_MS);
    if (pendingAuditCount > 0) armAuditFlush();
    throw failure;
  }
  auditFlushDelay = AUDIT_FLUSH_MS;
  auditRetryNotBefore = 0;
  auditFailureReported = false;
  if (auditDroppedRows > 0) {
    console.warn(`Audit log recovered; ${auditDroppedRows} queued bridge poll row(s) were dropped while it was unwritable.`);
    auditDroppedRows = 0;
  }
  if (pendingAuditCount > 0) armAuditFlush();
}

// One console line per failure streak, so an unwritable file does not flood the log.
function reportAuditFlushFailure(error) {
  if (auditFailureReported) return;
  auditFailureReported = true;
  console.warn(`Audit log flush failed: ${redact(String(error?.message || "Unexpected error."))}`);
}

function armAuditFlush() {
  if (auditFlushTimer) return;
  const wait = Math.max(AUDIT_FLUSH_MS, auditRetryNotBefore - Date.now());
  auditFlushTimer = setTimeout(() => {
    auditFlushTimer = null;
    try {
      flushAuditLog();
    } catch (error) {
      reportAuditFlushFailure(error);
    }
  }, wait);
  auditFlushTimer.unref?.();
}

function queueAuditLine(file, line) {
  const lines = pendingAuditLines.get(file);
  if (lines) lines.push(line);
  else pendingAuditLines.set(file, [line]);
  pendingAuditCount += 1;
  if (pendingAuditCount > AUDIT_MAX_PENDING_LINES) {
    // The file stays unwritable; bound memory by dropping the oldest polls.
    const [firstFile, firstLines] = pendingAuditLines.entries().next().value;
    firstLines.shift();
    pendingAuditCount -= 1;
    auditDroppedRows += 1;
    if (auditDroppedRows === 1) {
      console.warn(`Audit log queue is full (${AUDIT_MAX_PENDING_LINES} rows); dropping the oldest bridge poll rows until it is writable again.`);
    }
    if (!firstLines.length) pendingAuditLines.delete(firstFile);
  }
  armAuditFlush();
}

// Called once from the server entry point. The default SIGTERM/SIGINT action
// ends the process before "exit" fires, which would lose the pending batch.
export function installAuditShutdownHooks(proc = process) {
  let flushed = false;
  const flushQuietly = () => {
    if (flushed) return;
    flushed = true;
    try { flushAuditLog(); } catch {}
    if (pendingAuditCount > 0) console.error(`${pendingAuditCount} audit log row(s) could not be written before shutdown.`);
  };
  proc.once("exit", flushQuietly);
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    proc.once(signal, () => {
      flushQuietly();
      proc.exit(code);
    });
  }
}

export function audit(config, req, action, detail = {}) {
  const row = {
    timestamp: new Date().toISOString(),
    action,
    method: req?.method,
    path: req?.url,
    remote: req?.socket?.remoteAddress,
    // Added with API keys: until there were two principal types, every row was
    // implicitly the local owner. A key-performed mutation would otherwise be
    // indistinguishable from one the operator made in the browser.
    principal: principalOf(req?.authSession),
    detail: redactValue(detail)
  };
  const line = `${JSON.stringify(row)}\n`;
  if (bufferableBridgeRow(action, detail)) {
    queueAuditLine(config.auditLog, line);
  } else {
    // A failure flushing earlier polls must not stop this row from being written.
    try { flushAuditLog({ respectBackoff: true }); } catch (error) { reportAuditFlushFailure(error); }
    appendFileEnsureDir(config.auditLog, line, { mode: 0o600 });
  }

  if (action === "addons.bridge") {
    const now = Date.now();
    bridgeRequestLog.push({ at: now, ok: detail?.ok !== false });
    pruneBridgeRequestLog(now);
  }
}

export function recordAdminHistory(config, { command, target = "-", friendly = "", path = "web", result = "ok", message = "" }) {
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
  appendFileEnsureDir(join(config.generatedDir, "admin-command-history.tsv"), `${columns.join("\t")}\n`, { mode: 0o600 });
}

function safeColumn(value) {
  return redact(String(value || "-")).replace(/[\r\n\t]/g, " ").slice(0, 160);
}
