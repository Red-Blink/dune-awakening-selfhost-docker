import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the real API logs completed and denied requests with static routes, and discovers Console logs", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dune-request-timing-"));
  const probe = createServer();
  await new Promise(resolveListen => probe.listen(0, "127.0.0.1", resolveListen));
  const port = probe.address().port;
  await new Promise(resolveClose => probe.close(resolveClose));
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", DUNE_DOCKER_DIR: root,
      ADMIN_MOCK_MODE: "1", ADMIN_PASSWORD: "Fixture-Request-Password-123",
      DUNE_DISCORD_ADAPTER_ENABLED: "false",
      ADMIN_AUTH_DISABLED: "0", ADMIN_ALLOWED_IPS: "", DUNE_CONFIGURED_ADMIN_ALLOWED_IPS: "",
      ADMIN_BIND_HOST: "127.0.0.1", ADMIN_BIND_PORT: String(port), ADMIN_SECURE_COOKIES: "0" }
  });
  let stdout = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.resume();
  const exited = once(child, "exit");
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
      if (ready || child.exitCode !== null) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.equal(ready, true);
    assert.equal((await fetch(`${base}/api/players/private-player-id/inventory?token=private-query`, {
      headers: { authorization: "Bearer private-bearer", "user-agent": "curl/8 private-agent" }
    })).status, 401);
    assert.equal((await fetch(`${base}/api/integrations/discord/status?token=private-query`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: { id: "private-player-id" } })
    })).status, 404);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "Fixture-Request-Password-123" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const services = await fetch(`${base}/api/logs/services`, { headers: { cookie } }).then(res => res.json());
    assert.ok(services.services.includes("console"));
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    const rows = stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
      .filter(row => row.event === "console.request");
    assert.ok(rows.some(row => row.status === 401 && row.client === "cli"));
    assert.ok(rows.some(row => row.route === "/api/auth/login" && row.status === 200));
    assert.ok(rows.some(row => row.route === "/api/integrations/discord/status" && row.method === "POST" && row.status === 404));
    assert.ok(rows.some(row => row.route === "/api/logs/services" && row.authentication === "session"));
    assert.ok(rows.every(row => row.durationMs >= 0 && Number.isFinite(Date.parse(row.startedAt))));
    assert.doesNotMatch(JSON.stringify(rows), /private-|Fixture-Request|Bearer/);
  } finally {
    child.kill("SIGTERM"); await exited; await rm(root, { recursive: true, force: true });
  }
});
