import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Route-level coverage for addonSchedulerBridgeAction in server.js: boots the
// real API in mock mode (auth disabled, no Postgres needed for the branches
// exercised here) against a temp repo root with the addon installed.

const API_ROOT = resolve(import.meta.dirname, "..");
const PORT = 20000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;

const SEED_PLAN = {
  panel_version: "test",
  price_multiplier: 5,
  rows: [{ template_id: "WaterBottle", kind: "resource", stack_size: 10, price: 1000, category_mask: 1, category_depth: 1, quality_level: 0, listings: 4 }]
};

function writeAddonState(repoRoot, approvedPermissions) {
  writeFileSync(join(repoRoot, "runtime/addons/state.json"), JSON.stringify({
    "eda-exchange-bot": { enabled: true, approvedPermissions }
  }));
}

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-scheduler-http-"));
  const addonDir = join(repoRoot, "runtime/addons/installed/eda-exchange-bot");
  mkdirSync(join(addonDir, "web"), { recursive: true });
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  writeFileSync(join(addonDir, "addon.json"), JSON.stringify({
    schemaVersion: 1,
    id: "eda-exchange-bot",
    name: "EDA Exchange Bot",
    version: "0.9.9",
    type: "ui",
    entry: { path: "web/index.html" },
    permissions: ["database:read", "database:write", "scheduler:server"]
  }));
  writeFileSync(join(addonDir, "web/market-seed-plan.json"), JSON.stringify(SEED_PLAN));
  writeAddonState(repoRoot, ["database:read", "database:write", "scheduler:server"]);
  return repoRoot;
}

function startServer(repoRoot) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: API_ROOT,
    shell: false,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: repoRoot,
      ADMIN_AUTH_DISABLED: "1",
      ADMIN_MOCK_MODE: "1",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(PORT),
      ADMIN_STATIC_DIR: join(repoRoot, "console/web/dist")
    }
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`API did not start listening.\n${output}`)), 20000);
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`${BASE}/api/health`);
        if (response.ok) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolveReady();
        }
      } catch {
        // Not listening yet.
      }
    }, 150);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      rejectReady(new Error(`API exited with code ${code} before listening.\n${output}`));
    });
  });
  return { child, ready };
}

async function bridge(addonId, body) {
  const response = await fetch(`${BASE}/api/addons/installed/${addonId}/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test("scheduler bridge actions over HTTP", async (t) => {
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;

    await t.test("rejects scheduler actions for other addon ids", async () => {
      const { status, body } = await bridge("some-other-addon", { action: "scheduler.schedule.get" });
      assert.equal(status, 400);
      assert.match(body.error, /not supported for this addon/);
    });

    await t.test("rejects unknown scheduler actions", async () => {
      const { status, body } = await bridge("eda-exchange-bot", { action: "scheduler.everything" });
      assert.equal(status, 400);
      assert.match(body.error, /Unsupported addon action/);
    });

    await t.test("schedule.get returns validated defaults", async () => {
      const { status, body } = await bridge("eda-exchange-bot", { action: "scheduler.schedule.get" });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.deepEqual(
        [body.result.enabled, body.result.intervalMinutes, body.result.exchangeId, body.result.buybackPercent, body.result.maxBuys],
        [false, 30, "", 60, 500]
      );
    });

    await t.test("schedule.set validates fields", async () => {
      const { status, body } = await bridge("eda-exchange-bot", {
        action: "scheduler.schedule.set",
        schedule: { exchangeId: "9223372036854775808" }
      });
      assert.equal(status, 400);
      assert.equal(body.ok, false);
      assert.match(body.error, /exchangeId must be a positive whole number/);
    });

    await t.test("enabling requires the scheduler:server approval", async () => {
      writeAddonState(repoRoot, ["database:read", "database:write"]);
      const denied = await bridge("eda-exchange-bot", {
        action: "scheduler.schedule.set",
        schedule: { enabled: true, exchangeId: "42" }
      });
      assert.notEqual(denied.status, 200);
      assert.match(denied.body.error, /not approved for scheduler:server/);

      writeAddonState(repoRoot, ["database:read", "database:write", "scheduler:server"]);
      const approved = await bridge("eda-exchange-bot", {
        action: "scheduler.schedule.set",
        schedule: { enabled: true, exchangeId: "42", intervalMinutes: 15 }
      });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.result.enabled, true);
      assert.equal(approved.body.result.exchangeId, "42");
      assert.ok(approved.body.result.nextRunAt, "enabling arms nextRunAt");
    });

    await t.test("saves that leave the schedule enabled re-check scheduler:server after revocation", async () => {
      writeAddonState(repoRoot, ["database:read", "database:write"]);
      const revoked = await bridge("eda-exchange-bot", {
        action: "scheduler.schedule.set",
        schedule: { intervalMinutes: 60 }
      });
      assert.notEqual(revoked.status, 200, "field update omitting `enabled` on an enabled schedule still needs scheduler:server");
      assert.match(revoked.body.error, /not approved for scheduler:server/);

      const disabled = await bridge("eda-exchange-bot", {
        action: "scheduler.schedule.set",
        schedule: { enabled: false }
      });
      assert.equal(disabled.status, 200, "explicitly disabling only needs database:write");
      assert.equal(disabled.body.result.enabled, false);
      assert.equal(disabled.body.result.nextRunAt, "");
      writeAddonState(repoRoot, ["database:read", "database:write", "scheduler:server"]);
    });

    await t.test("scheduler.run reports a missing exchangeId without touching the database", async () => {
      rmSync(join(repoRoot, "runtime/addons/jobs/eda-exchange-bot/buyback.json"), { force: true });
      const { status, body } = await bridge("eda-exchange-bot", { action: "scheduler.run" });
      assert.equal(status, 400);
      assert.equal(body.ok, false);
      assert.match(body.error, /Save a schedule with an exchangeId/);
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      child.on("exit", resolveExit);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit();
      }, 3000).unref?.();
    });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
