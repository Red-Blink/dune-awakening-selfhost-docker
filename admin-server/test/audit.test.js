import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAdminHistory } from "../src/audit.js";

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
