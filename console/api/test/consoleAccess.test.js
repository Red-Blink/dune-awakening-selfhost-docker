import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleAccess } from "../src/services/consoleAccess.js";

function fixture(t, options = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "console-access-test-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  return { repoRoot, access: createConsoleAccess({ repoRoot, ...options }) };
}
test("empty and previously active allowlists preserve their behavior", (t) => {
  const { access } = fixture(t);
  assert.deepEqual(access.activeIps(), []);
  assert.equal(access.status().pending, false);
  const active = fixture(t, { legacy: "203.0.113.9", configured: "203.0.113.8" }).access;
  assert.deepEqual(active.activeIps(), ["203.0.113.9"]);
  assert.equal(active.status().pending, false);
});
test("first upgrade never activates a previously ignored setting", (t) => {
  const { access } = fixture(t, { configured: "203.0.113.9" });
  assert.deepEqual(access.activeIps(), []);
  assert.equal(access.status("203.0.113.8").pending, true);
  assert.equal(access.status("203.0.113.8").canConfirm, false);
  assert.throws(() => access.confirm({ confirmed: true, fingerprint: access.status().fingerprint }, "203.0.113.8"), /block your current connection/);
  assert.deepEqual(access.activeIps(), []);
});
test("safe confirmation persists privately and survives upgrades", (t) => {
  const { repoRoot, access } = fixture(t, { configured: "203.0.113.9,::ffff:203.0.113.10" });
  const fingerprint = access.status().fingerprint;
  assert.throws(() => access.confirm({ fingerprint }, "203.0.113.9"), /fresh review/);
  assert.throws(() => access.confirm({ confirmed: true, fingerprint: "stale" }, "203.0.113.9"), /fresh review/);
  assert.equal(access.confirm({ confirmed: true, fingerprint }, "203.0.113.9").pending, false);
  assert.equal(statSync(join(repoRoot, "runtime/generated/console-access-review.json")).mode & 0o777, 0o600);
  assert.deepEqual(createConsoleAccess({ repoRoot, configured: "203.0.113.9,::ffff:203.0.113.10" }).activeIps(), ["203.0.113.9", "203.0.113.10"]);
  // An edited setting must not silently replace the last active policy.
  const changed = createConsoleAccess({ repoRoot, configured: "203.0.113.8" });
  assert.deepEqual(changed.activeIps(), ["203.0.113.9", "203.0.113.10"]);
  assert.equal(changed.status().pending, true);
  assert.deepEqual(createConsoleAccess({ repoRoot, configured: "" }).activeIps(), []);
});
test("invalid addresses cannot be confirmed even if the current address is included", (t) => {
  const { access } = fixture(t, { configured: "203.0.113.9,invalid" });
  assert.equal(access.status("203.0.113.9").canConfirm, false);
  assert.throws(() => access.confirm({ confirmed: true, fingerprint: access.status().fingerprint }, "203.0.113.9"), /invalid address/);
});

test("corrupt active security state fails closed but explicit SSH clearing still recovers access", (t) => {
  const { repoRoot } = fixture(t);
  mkdirSync(join(repoRoot, "runtime/generated"), { recursive: true });
  writeFileSync(join(repoRoot, "runtime/generated/console-access-review.json"), "invalid", { mode: 0o600 });
  assert.throws(() => createConsoleAccess({ repoRoot, configured: "203.0.113.9" }));
  assert.deepEqual(createConsoleAccess({ repoRoot, configured: "" }).activeIps(), []);
  assert.deepEqual(createConsoleAccess({ repoRoot, legacy: "203.0.113.9" }).activeIps(), ["203.0.113.9"]);
});
