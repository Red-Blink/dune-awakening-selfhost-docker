import assert from "node:assert/strict";
import test from "node:test";
import { discordSafeError, sanitizeDiscordPublicStatus, sanitizeDiscordValue } from "../src/integrations/discord/sanitize.js";

test("removes internal SSH host and sensitive keys from public status", () => {
  const result = sanitizeDiscordPublicStatus({
    admin_reason_required: false,
    db_connected: true,
    ssh_connected: true,
    ssh_host: "172.19.240.122:22",
    runtime: "docker",
    databaseUrl: "postgresql://dune:secret@127.0.0.1:15432/dune"
  });

  assert.equal(result.db_connected, true);
  assert.equal(result.ssh_connected, true);
  assert.equal(result.runtime, "docker");
  assert.equal(Object.hasOwn(result, "ssh_host"), false);
  assert.equal(Object.hasOwn(result, "databaseUrl"), false);
});

test("redacts internal addresses from string values", () => {
  assert.equal(sanitizeDiscordValue("ssh 172.19.240.122:22 ok"), "ssh <internal-address> ok");
  assert.equal(sanitizeDiscordValue("host 127.0.0.1"), "host <internal-address>");
});

test("safe error response strips internal details", () => {
  const error = new Error("Failed to reach postgresql://dune:secret@127.0.0.1:15432/dune via 172.19.240.122:22");
  error.code = "db_failed";
  const result = discordSafeError(error);
  assert.equal(result.ok, false);
  assert.equal(result.code, "db_failed");
  assert.match(result.error, /<redacted>|<internal-address>/);
  assert.doesNotMatch(result.error, /secret/);
  assert.doesNotMatch(result.error, /172\.19\.240\.122/);
});
