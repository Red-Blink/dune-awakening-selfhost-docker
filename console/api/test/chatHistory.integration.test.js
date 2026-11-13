import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_POLICIES } from "../src/policy.js";

test("real HTTP routes exclude whisper data/counts and enforce backend IAM and CSRF", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dune-chat-http-"));
  const generated = join(root, "runtime/generated");
  await mkdir(generated, { recursive: true });
  const policies = structuredClone(DEFAULT_POLICIES);
  await writeFile(join(generated, "iam-policies.json"), JSON.stringify(policies));
  const row = { capturedAt: new Date().toISOString(), sender: "FixtureSender", senderName: "", recipient: "", context: "HaggaBasin.1" };
  await writeFile(join(generated, "chat-history.json"), JSON.stringify({ settings: { enabled: false, whispers: true, retentionDays: 7 }, rows: [
    { ...row, id: "1".repeat(64), channel: "Map", text: "PublicFixture" },
    { ...row, id: "2".repeat(64), channel: "Whispers", recipient: "PrivateRecipientFixture", text: "PrivateMessageFixture" }
  ] }));
  const probe = createServer();
  await new Promise(resolveListen => probe.listen(0, "127.0.0.1", resolveListen));
  const port = probe.address().port;
  await new Promise(resolveClose => probe.close(resolveClose));
  const child = spawn(process.execPath, ["src/server.js"], { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", DUNE_DOCKER_DIR: root, ADMIN_MOCK_MODE: "1", ADMIN_PASSWORD: "Fixture-Chat-Password-123",
      DUNE_DISCORD_ADAPTER_ENABLED: "false", ADMIN_AUTH_DISABLED: "0", ADMIN_ALLOWED_IPS: "", DUNE_CONFIGURED_ADMIN_ALLOWED_IPS: "",
      ADMIN_BIND_HOST: "127.0.0.1", ADMIN_BIND_PORT: String(port), ADMIN_SECURE_COOKIES: "0" } });
  let logs = "";
  child.stdout.on("data", data => { logs += data; }); child.stderr.resume();
  const exited = once(child, "exit");
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
      if (ready || child.exitCode !== null) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.ok(ready, "fixture API starts");
    assert.equal((await fetch(`${base}/api/chat/history`)).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "Fixture-Chat-Password-123" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const auth = await login.json();
    const history = await fetch(`${base}/api/chat/history`, { headers: { cookie } }).then(r => r.json());
    assert.equal(history.total, 1);
    assert.equal(history.canReadWhispers, undefined);
    assert.doesNotMatch(JSON.stringify(history), /PrivateMessageFixture|PrivateRecipientFixture/);
    const search = await fetch(`${base}/api/chat/history?q=PrivateMessageFixture`, { headers: { cookie } }).then(r => r.json());
    assert.equal(search.total, 0);
    assert.equal((await fetch(`${base}/api/chat/whispers`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/chat/history?channel=Whispers`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${base}/api/chat/history`, { method: "DELETE", headers: { cookie } })).status, 403);
    const cleared = await fetch(`${base}/api/chat/history`, { method: "DELETE", headers: { cookie, "x-csrf-token": auth.csrfToken } });
    assert.equal(cleared.status, 200);
    assert.equal((await fetch(`${base}/api/chat/history`, { headers: { cookie } }).then(r => r.json())).total, 0);
    assert.doesNotMatch(logs, /PrivateMessageFixture|PrivateRecipientFixture|PublicFixture/);
  } finally { child.kill("SIGTERM"); await exited; await rm(root, { recursive: true, force: true }); }
});
