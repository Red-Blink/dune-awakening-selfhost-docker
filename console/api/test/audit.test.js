import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, principalOf, recordAdminHistory } from "../src/audit.js";

test("records safe web admin history rows for RMQ attempts", () => {
  const generatedDir = mkdtempSync(join(tmpdir(), "arrakis-history-"));
  try {
    recordAdminHistory({ generatedDir }, {
      command: "web-broadcast",
      target: "all",
      friendly: "Broadcast publish test",
      path: "rmq:heartbeats/notifications",
      result: "published",
      message: "Hello World password=secret\nsecond line"
    });
    const text = readFileSync(join(generatedDir, "admin-command-history.tsv"), "utf8");
    assert.match(text, /web-broadcast/);
    assert.match(text, /published/);
    assert.match(text, /Hello World/);
    assert.doesNotMatch(text, /secret/);
    assert.doesNotMatch(text, /\nsecond line/);
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
});

test("redacts password fields in audit details without corrupting JSON", () => {
  const generatedDir = mkdtempSync(join(tmpdir(), "arrakis-audit-"));
  const auditLog = join(generatedDir, "audit.jsonl");
  try {
    audit({ auditLog }, { method: "POST", url: "/api/maps/sietches", socket: { remoteAddress: "127.0.0.1" } }, "task.sietchesSetPassword", {
      action: "set-password",
      partitionId: "33",
      password: "secret"
    });
    const row = JSON.parse(readFileSync(auditLog, "utf8").trim());
    assert.equal(row.detail.password, "<redacted>");
    assert.equal(row.detail.partitionId, "33");
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
});

test("audit rows attribute the acting principal without leaking a session id", () => {
  // Before API keys there was only one principal type, so every row was
  // implicitly the local owner. A key-performed mutation must not be
  // indistinguishable from one the operator made in the browser.
  const dir = mkdtempSync(join(tmpdir(), "audit-principal-"));
  const config = { auditLog: join(dir, "audit.jsonl") };
  try {
    const keyReq = { method: "DELETE", url: "/api/bases/5", socket: { remoteAddress: "10.0.0.4" },
      authSession: { id: "apikey:7f3c1a9b", tier: "owner", apiKeyId: "7f3c1a9b" } };
    const browserReq = { method: "DELETE", url: "/api/bases/5", socket: { remoteAddress: "10.0.0.4" },
      authSession: { id: "SESSION_SECRET_HALF", tier: "owner" } };

    audit(config, keyReq, "bases.delete", { baseId: 5 });
    audit(config, browserReq, "bases.delete", { baseId: 5 });
    audit(config, { method: "POST", url: "/api/auth/login" }, "auth.login");

    const rows = readFileSync(config.auditLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows[0].principal, { type: "api-key", id: "7f3c1a9b" });
    assert.deepEqual(rows[1].principal, { type: "session", tier: "owner" });
    // Pre-auth routes run before req.authSession exists; null is the honest answer.
    assert.equal(rows[2].principal, null);

    // The browser session id is half of the asc_session cookie value and must
    // never reach a durable log.
    assert.ok(!readFileSync(config.auditLog, "utf8").includes("SESSION_SECRET_HALF"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("principalOf carries a Discord identity but never a session id", () => {
  assert.deepEqual(principalOf({ id: "secret", tier: "moderator", userId: "557" }),
    { type: "session", tier: "moderator", userId: "557" });
  assert.deepEqual(principalOf(null), null);
  assert.deepEqual(principalOf(undefined), null);
});

function readRows(file) {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("read-only bridge rows are batched, flushed by timer, and keep order with other rows", async () => {
  const { flushAuditLog } = await import("../src/audit.js");
  const dir = mkdtempSync(join(tmpdir(), "audit-batch-"));
  const config = { auditLog: join(dir, "audit.jsonl") };
  const req = { method: "POST", url: "/x", socket: { remoteAddress: "127.0.0.1" } };
  try {
    audit(config, req, "addons.bridge", { action: "ops.health.summary", ok: true, n: 1 });
    audit(config, req, "addons.bridge", { action: "players.summary.list", ok: true, n: 2 });
    assert.equal(existsSync(config.auditLog), false);
    audit(config, req, "bases.delete", { n: 3 });
    audit(config, req, "addons.bridge", { action: "addon.storage.get", ok: true, n: 4 });
    assert.deepEqual(readRows(config.auditLog).map((row) => row.detail.n), [1, 2, 3]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(readRows(config.auditLog).map((row) => row.detail.n), [1, 2, 3, 4]);
    flushAuditLog();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state-changing and failed bridge rows are written synchronously", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-sync-"));
  const config = { auditLog: join(dir, "audit.jsonl") };
  const req = { method: "POST", url: "/x", socket: { remoteAddress: "127.0.0.1" } };
  try {
    audit(config, req, "addons.bridge", { action: "database.execute", ok: true, n: 1 });
    audit(config, req, "addons.bridge", { action: "rewards.deliver", ok: true, n: 2 });
    audit(config, req, "addons.bridge", { action: "ops.health.summary", ok: false, n: 3 });
    assert.deepEqual(readRows(config.auditLog).map((row) => row.detail.n), [1, 2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing flush keeps the queued rows and does not block a synchronous row", async () => {
  const { flushAuditLog } = await import("../src/audit.js");
  const dir = mkdtempSync(join(tmpdir(), "audit-fail-"));
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "not a directory");
  const badConfig = { auditLog: join(blocked, "audit.jsonl") };
  const goodConfig = { auditLog: join(dir, "good.jsonl") };
  const req = { method: "POST", url: "/x", socket: { remoteAddress: "127.0.0.1" } };
  try {
    audit(badConfig, req, "addons.bridge", { action: "ops.health.summary", ok: true, n: 1 });
    audit(goodConfig, req, "bases.delete", { n: 2 });
    assert.deepEqual(readRows(goodConfig.auditLog).map((row) => row.detail.n), [2]);
    rmSync(blocked);
    flushAuditLog();
    assert.deepEqual(readRows(badConfig.auditLog).map((row) => row.detail.n), [1]);
  } finally {
    // Leave no unflushable row in the module-level queue for later tests.
    rmSync(blocked, { recursive: true, force: true });
    try { flushAuditLog(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installAuditShutdownHooks flushes pending rows on exit and signals", async () => {
  const { installAuditShutdownHooks } = await import("../src/audit.js");
  const dir = mkdtempSync(join(tmpdir(), "audit-hooks-"));
  const config = { auditLog: join(dir, "audit.jsonl") };
  const req = { method: "POST", url: "/x", socket: { remoteAddress: "127.0.0.1" } };
  const handlers = new Map();
  const exits = [];
  const fakeProcess = { once: (event, fn) => handlers.set(event, fn), exit: (code) => exits.push(code) };
  try {
    installAuditShutdownHooks(fakeProcess);
    audit(config, req, "addons.bridge", { action: "ops.health.summary", ok: true, n: 1 });
    handlers.get("SIGTERM")();
    assert.deepEqual(readRows(config.auditLog).map((row) => row.detail.n), [1]);
    assert.deepEqual(exits, [143]);
    assert.ok(handlers.has("exit") && handlers.has("SIGINT"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after a failed flush the request path does not retry until the backoff passed", async () => {
  const { flushAuditLog, pendingAuditRowCount } = await import("../src/audit.js");
  const dir = mkdtempSync(join(tmpdir(), "audit-backoff-"));
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "not a directory");
  const config = { auditLog: join(blocked, "audit.jsonl") };
  const other = { auditLog: join(dir, "other.jsonl") };
  const req = { method: "POST", url: "/x", socket: { remoteAddress: "127.0.0.1" } };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    audit(config, req, "addons.bridge", { action: "ops.health.summary", ok: true, n: 1 });
    assert.throws(() => flushAuditLog());
    // Request-path flushes now skip the retry; rows stay queued, nothing is lost.
    audit(other, req, "bases.delete", { n: 2 });
    audit(other, req, "bases.delete", { n: 3 });
    assert.equal(pendingAuditRowCount(), 1);
    assert.equal(readRows(other.auditLog).length, 2);
    // A forced flush (shutdown) always tries.
    assert.throws(() => flushAuditLog());
    rmSync(blocked);
    flushAuditLog();
    assert.deepEqual(readRows(config.auditLog).map((row) => row.detail.n), [1]);
    assert.equal(pendingAuditRowCount(), 0);
  } finally {
    console.warn = originalWarn;
    rmSync(blocked, { recursive: true, force: true });
    try { flushAuditLog(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown ops.* bridge action is written synchronously", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-ops-"));
  const config = { auditLog: join(dir, "audit.jsonl") };
  const req = { method: "POST", url: "/x", socket: { remoteAddress: "127.0.0.1" } };
  try {
    audit(config, req, "addons.bridge", { action: "ops.maintenance.reset", ok: true, n: 1 });
    assert.deepEqual(readRows(config.auditLog).map((row) => row.detail.n), [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown hooks flush once even when the signal handler is followed by exit", async () => {
  const { installAuditShutdownHooks } = await import("../src/audit.js");
  const handlers = new Map();
  const fakeProcess = { once: (event, fn) => handlers.set(event, fn), exit: () => handlers.get("exit")() };
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  const dir = mkdtempSync(join(tmpdir(), "audit-once-"));
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "not a directory");
  const config = { auditLog: join(blocked, "audit.jsonl") };
  const req = { method: "POST", url: "/x", socket: { remoteAddress: "127.0.0.1" } };
  try {
    installAuditShutdownHooks(fakeProcess);
    audit(config, req, "addons.bridge", { action: "ops.health.summary", ok: true, n: 1 });
    handlers.get("SIGTERM")();
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
    rmSync(blocked, { recursive: true, force: true });
    try { (await import("../src/audit.js")).flushAuditLog(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
