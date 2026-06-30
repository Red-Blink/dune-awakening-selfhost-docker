import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, recordAdminHistory } from "../src/audit.js";

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

test("tightens existing audit and admin history file permissions", () => {
  const generatedDir = mkdtempSync(join(tmpdir(), "arrakis-audit-mode-"));
  const auditLog = join(generatedDir, "audit.jsonl");
  const historyFile = join(generatedDir, "admin-command-history.tsv");
  try {
    writeFileSync(auditLog, "", { mode: 0o666 });
    writeFileSync(historyFile, "", { mode: 0o666 });
    chmodSync(auditLog, 0o666);
    chmodSync(historyFile, 0o666);

    audit({ auditLog }, { method: "POST", url: "/api/test", socket: { remoteAddress: "127.0.0.1" } }, "test.audit", {});
    recordAdminHistory({ generatedDir }, { command: "web-test", target: "all", result: "ok" });

    assert.equal(statSync(auditLog).mode & 0o777, 0o600);
    assert.equal(statSync(historyFile).mode & 0o777, 0o600);
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
});
