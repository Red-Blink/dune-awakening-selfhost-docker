import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("real Console upgrade preserves login and activates restrictions only after a safe authenticated review", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dune-console-access-"));
  const port = 32000 + process.pid % 10000;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", DUNE_DOCKER_DIR: root,
      ADMIN_MOCK_MODE: "1", ADMIN_PASSWORD: "Dummy-Console-Password-123",
      ADMIN_AUTH_DISABLED: "0", ADMIN_ALLOWED_IPS: "", DUNE_CONFIGURED_ADMIN_ALLOWED_IPS: "127.0.0.1",
      ADMIN_BIND_HOST: "127.0.0.1", ADMIN_BIND_PORT: String(port), ADMIN_SECURE_COOKIES: "0" }
  });
  child.stdout.resume(); child.stderr.resume();
  const exited = once(child, "exit");
  async function otherClientStatus() {
    return await new Promise((resolveStatus, reject) => {
      get(`${base}/api/health`, { localAddress: "127.0.0.2" }, (res) => {
        res.resume(); res.on("end", () => resolveStatus(res.statusCode));
      }).on("error", reject);
    });
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
      if (ready || child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ready, true);
    assert.equal(await otherClientStatus(), 200); // old effective access preserved
    assert.equal((await fetch(`${base}/api/auth/state`).then((r) => r.json())).config.consoleAccessReviewRequired, true);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "Dummy-Console-Password-123" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const state = await fetch(`${base}/api/auth/state`, { headers: { cookie } }).then((r) => r.json());
    const settings = await fetch(`${base}/api/settings`, { headers: { cookie } }).then((r) => r.json());
    assert.equal(settings.consoleAccess.canConfirm, true);
    const endpoint = `${base}/api/settings/console-access/confirm`;
    const body = { confirmed: true, fingerprint: settings.consoleAccess.fingerprint };
    assert.equal((await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, 401);
    const confirmed = await fetch(endpoint, { method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": state.csrfToken }, body: JSON.stringify(body) });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).pending, false);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal(await otherClientStatus(), 403);
  } finally {
    child.kill("SIGTERM"); await exited; await rm(root, { recursive: true, force: true });
  }
});
