import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
