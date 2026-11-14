import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, getFreePort, login, startConsole, stopProcess, waitForHealth } from "../test-support/consoleHarness.js";

test("HTTPS mutations require a signed-in owner and CSRF before accepting provider input", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dune-https-auth-"));
  const port = await getFreePort();
  const proc = startConsole(port, root, { ADMIN_BIND_HOST: "127.0.0.1", ADMIN_PASSWORD: "synthetic-https-test-password", CONSOLE_MOCK_MODE: "1" });
  t.after(async () => { await stopProcess(proc.child); rmSync(root, { recursive: true, force: true }); });
  await waitForHealth(port, 15_000, proc.logs);
  const path = "/api/settings/console-https";
  assert.equal((await api(port, path, { body: { action: "start", provider: "cloudflare", confirmed: true } })).status, 401);
  const owner = await login(port, { password: "synthetic-https-test-password" });
  assert.equal(owner.status, 200);
  assert.equal((await api(port, path, { cookie: owner.cookie, body: { action: "start", provider: "cloudflare", confirmed: true } })).status, 403);
  const refused = await api(port, path, { ...owner, body: { action: "start", provider: "not-a-provider", confirmed: true } });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /Choose an HTTPS provider/);
  // Save the same listener port so this isolated regression cannot schedule
  // a real Console restart. A signed tunnel must retain its HTTPS address.
  const key = randomBytes(32);
  writeFileSync(join(root, "runtime/secrets/console-https-proxy-key.bin"), key, { mode: 0o600 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const portPath = "/api/settings/web-port";
  const headers = { "content-type": "application/json", host: "console.example.com", cookie: `asc_session=${owner.cookie}`, "x-csrf-token": owner.csrf,
    "x-dune-console-proxy": "1", "x-dune-tls-client": "203.0.113.9", "x-dune-tls-time": timestamp,
    "x-dune-tls-signature": createHmac("sha256", key).update(`${timestamp}\n203.0.113.9\nPOST\n${portPath}`).digest("hex") };
  const portResult = await new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: portPath, method: "POST", headers }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject); req.end(JSON.stringify({ port }));
  });
  assert.equal(portResult.status, 200);
  assert.equal(portResult.body.url, "https://console.example.com");
});
