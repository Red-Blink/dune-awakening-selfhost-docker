import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tlsClientAddress } from "../src/services/tlsClientAddress.js";

test("the stock Console deployment passes its configured IP allowlist", () => {
  const compose = readFileSync(new URL("../../../docker-compose.web.yml", import.meta.url), "utf8");
  assert.match(compose, /^\s+ADMIN_ALLOWED_IPS: "\$\{ADMIN_ALLOWED_IPS:-\}"$/m);
});

test("only signed local TLS forwarding identities can affect the IP allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "tls-client-address-"));
  const key = randomBytes(32);
  const now = Date.parse("2026-10-02T12:00:00Z");
  const timestamp = String(now / 1000);
  mkdirSync(join(root, "runtime/generated/tls-front"), { recursive: true });
  writeFileSync(join(root, "runtime/generated/tls-front/proxy-key"), key, { mode: 0o600 });
  const req = { method: "GET", url: "/api/server/status?view=1",
    socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }, headers: {} };
  try {
    assert.equal(tlsClientAddress(req, root, now), "127.0.0.1");
    req.headers["x-forwarded-for"] = "203.0.113.9";
    assert.equal(tlsClientAddress(req, root, now), "127.0.0.1");
    req.headers["x-dune-tls-client"] = "203.0.113.9";
    req.headers["x-dune-tls-time"] = timestamp;
    req.headers["x-dune-tls-signature"] = createHmac("sha256", key)
      .update(`${timestamp}\n203.0.113.9\nGET\n${req.url}`).digest("hex");
    assert.equal(tlsClientAddress(req, root, now), "203.0.113.9");
    assert.equal(tlsClientAddress(req, root, now + 61000), null);
    assert.equal(tlsClientAddress({ ...req, url: "/api/other" }, root, now), null);
    assert.equal(tlsClientAddress({ ...req, method: "POST" }, root, now), null);
    assert.equal(tlsClientAddress({ ...req, socket: { remoteAddress: "203.0.113.8", localAddress: "127.0.0.1" } }, root, now), null);
    req.socket = { remoteAddress: "192.168.1.20", localAddress: "192.168.1.20" };
    assert.equal(tlsClientAddress(req, root, now), "203.0.113.9");
    req.headers["x-dune-tls-client"] = "203.0.113.8";
    assert.equal(tlsClientAddress(req, root, now), null);
    assert.equal(tlsClientAddress(req, join(root, "missing"), now), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Console port changes and deployment paths reconcile the optional TLS front", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const restart = server.slice(server.indexOf("function scheduleConsoleRestart"), server.indexOf("function scheduleConsoleRestart") + 4000);
  assert.match(restart, /tls-front\.sh reconcile/);
  for (const script of ["console.sh", "self-update.sh"]) {
    assert.match(readFileSync(new URL(`../../../runtime/scripts/${script}`, import.meta.url), "utf8"), /tls-front\.sh reconcile/);
  }
});
