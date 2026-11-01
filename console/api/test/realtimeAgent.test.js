import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeAgent, RealtimeAgentError, REALTIME_AGENT_CONTAINER } from "../src/services/realtimeAgent.js";
import { actionForRoute } from "../src/actions.js";
import { DEFAULT_POLICIES, evaluate } from "../src/policy.js";
import { RealtimeError } from "../src/services/realtime.js";
import { selectableNamespaces, actionsByNamespace } from "../src/apiKeyScopes.js";

const ROOT = "/repo";

// A fake `run`: records every call and answers docker inspect / the script.
function fakeRun({ container = null, scriptFails = false } = {}) {
  const calls = [];
  let current = container;
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "docker") {
      if (!current) throw new Error("No such object");
      return `${current}\n`;
    }
    if (scriptFails) throw new Error("build failed with secret-looking detail");
    current = args[0] === "enable" ? "running" : null;
    return "";
  };
  return { run, calls };
}

const present = () => true;

test("status: files missing means the feature is not available and Docker is not asked", async () => {
  const { run, calls } = fakeRun();
  const agent = createRealtimeAgent({ repoRoot: ROOT, run, exists: () => false, health: async () => { throw new RealtimeError("x", 503); } });
  const status = await agent.status();
  assert.equal(status.available, false);
  assert.equal(status.installed, false);
  assert.equal(calls.length, 0);
});

test("status: not installed and not reachable", async () => {
  const { run } = fakeRun();
  const agent = createRealtimeAgent({ repoRoot: ROOT, run, exists: present, health: async () => { throw new RealtimeError("down", 503); } });
  assert.deepEqual(await agent.status(), { available: true, installed: false, running: false, state: "", reachable: false, reason: "not-running", busy: null });
});

test("status: a bad DUNE_REALTIME_AGENT_URL is reported as misconfigured", async () => {
  const { run } = fakeRun({ container: "running" });
  const agent = createRealtimeAgent({ repoRoot: ROOT, run, exists: present, health: async () => { throw new RealtimeError("bad url", 500); } });
  const status = await agent.status();
  assert.equal(status.running, true);
  assert.equal(status.reachable, false);
  assert.equal(status.reason, "misconfigured");
});

test("status: running and reachable", async () => {
  const { run } = fakeRun({ container: "running" });
  const agent = createRealtimeAgent({ repoRoot: ROOT, run, exists: present, health: async () => ({ available: true }) });
  const status = await agent.status();
  assert.equal(status.reachable, true);
  assert.equal(status.reason, "");
});

test("install needs an explicit confirmation and runs only the shipped script", async () => {
  const { run, calls } = fakeRun();
  const agent = createRealtimeAgent({ repoRoot: ROOT, run, exists: present, health: async () => ({ available: true }) });
  for (const confirmed of [undefined, false, "true", 1]) {
    await assert.rejects(agent.setEnabled(true, { confirmed }), (error) => error instanceof RealtimeAgentError && error.status === 400);
  }
  assert.equal(calls.length, 0, "nothing ran without confirmation");

  const status = await agent.setEnabled(true, { confirmed: true });
  const scriptCall = calls.find(([file]) => file !== "docker");
  assert.equal(scriptCall[0], "/repo/runtime/scripts/realtime-agent.sh");
  assert.deepEqual(scriptCall.slice(1), ["enable"]);
  assert.equal(status.running, true);
  assert.equal(status.busy, null);
  assert.equal(calls.filter(([file]) => file === "docker").every((call) => call.includes(REALTIME_AGENT_CONTAINER)), true);
});

test("remove needs no confirmation and runs disable", async () => {
  const { run, calls } = fakeRun({ container: "running" });
  const agent = createRealtimeAgent({ repoRoot: ROOT, run, exists: present, health: async () => ({ available: true }) });
  const status = await agent.setEnabled(false);
  assert.deepEqual(calls.find(([file]) => file !== "docker").slice(1), ["disable"]);
  assert.equal(status.installed, false);
});

test("only booleans are accepted and nothing else reaches the script", async () => {
  const { run, calls } = fakeRun();
  const agent = createRealtimeAgent({ repoRoot: ROOT, run, exists: present, health: async () => ({ available: true }) });
  for (const bad of [undefined, null, "enable", 1, {}, ["enable"]]) {
    await assert.rejects(agent.setEnabled(bad, { confirmed: true }), (error) => error.status === 400, String(bad));
  }
  assert.equal(calls.length, 0);
});

test("a failed build gives a generic message without the script output", async () => {
  const { run } = fakeRun({ scriptFails: true });
  const agent = createRealtimeAgent({ repoRoot: ROOT, run, exists: present, health: async () => ({ available: true }) });
  await assert.rejects(agent.setEnabled(true, { confirmed: true }), (error) => {
    assert.equal(error.status, 502);
    assert.doesNotMatch(error.message, /secret-looking/);
    return true;
  });
  // the lock is released after a failure
  const status = await agent.status();
  assert.equal(status.busy, null);
});

test("a second change while one runs is refused", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = async (file) => {
    if (file === "docker") throw new Error("none");
    await gate;
    return "";
  };
  const agent = createRealtimeAgent({ repoRoot: ROOT, run, exists: present, health: async () => ({ available: true }) });
  const first = agent.setEnabled(true, { confirmed: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(agent.setEnabled(true, { confirmed: true }), (error) => error.status === 409);
  await assert.rejects(agent.setEnabled(false), (error) => error.status === 409);
  assert.equal((await agent.status()).busy, "install");
  release();
  await first;
});

test("the setup is owner-only and not part of any API key scope", () => {
  assert.equal(actionForRoute("/api/settings/realtime-agent", "GET"), "settings:read");
  assert.equal(actionForRoute("/api/settings/realtime-agent", "POST"), "settings:write");
  const docs = DEFAULT_POLICIES;
  assert.equal(evaluate({ tier: "owner" }, "settings:write", docs), true);
  for (const tier of ["admin", "moderator", "player", "observer"]) {
    assert.equal(evaluate({ tier }, "settings:write", docs), false, `${tier} must not install the agent`);
  }
  // "settings" is not a selectable API key namespace, so no key can be granted it
  assert.equal(selectableNamespaces().includes("settings"), false);
  assert.equal(actionsByNamespace().has("settings"), false);
});

// ---- HTTP routes against a real server (mock mode, no Docker) ----
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

test("routes: status answers, install without confirmation is refused, nothing runs", async () => {
  const apiRoot = resolvePath(import.meta.dirname, "..");
  const port = 27000 + (process.pid % 10000);
  const base = `http://127.0.0.1:${port}`;
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-realtime-agent-http-"));
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: apiRoot,
    shell: false,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: repoRoot,
      DUNE_REALTIME_AGENT_URL: "http://127.0.0.1:9",
      ADMIN_AUTH_DISABLED: "1",
      ADMIN_MOCK_MODE: "1",
      ADMIN_AUTO_START_STACK_ON_BOOT: "0",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(port),
      ADMIN_STATIC_DIR: join(repoRoot, "console/web/dist")
    }
  });
  try {
    for (let i = 0; i < 200; i += 1) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const get = await fetch(`${base}/api/settings/realtime-agent`);
    assert.equal(get.status, 200);
    const status = await get.json();
    assert.equal(status.available, false); // this temp repo ships no setup files
    assert.equal(status.reachable, false);

    const post = (body) => fetch(`${base}/api/settings/realtime-agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ enabled: true })).status, 400);
    assert.equal((await post({ enabled: "yes", confirmed: true })).status, 400);
    assert.equal((await post({ enabled: true, confirmed: true })).status, 404); // setup files absent
    assert.equal((await post({ enabled: false })).status, 404);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => { child.on("exit", resolve); setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000).unref?.(); });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
