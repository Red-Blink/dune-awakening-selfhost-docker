import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAddonDeliveryService, deferAddonDelivery, normalizeAddonReward } from "../src/addonDeliveries.js";

function fixture(options = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-deliveries-"));
  const calls = [];
  const service = createAddonDeliveryService({ repoRoot }, {
    canRun: options.canRun || (() => true),
    deliver: options.deliver || (async (payload) => { calls.push(payload); return { ok: true }; }),
    now: options.now
  });
  return { repoRoot, service, calls, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

test("normalizes supported rewards and rejects ambiguous blueprint quantities", () => {
  assert.deepEqual(normalizeAddonReward({ type: "item", playerId: "FLS_1", itemId: "WaterBottle_1", quantity: 2 }), { type: "item", playerId: "FLS_1", amount: 2, itemId: "WaterBottle_1", quality: 0 });
  assert.deepEqual(normalizeAddonReward({ type: "currency", playerId: "FLS_1", currencyId: 1, amount: 20 }), { type: "currency", playerId: "FLS_1", amount: 20, currencyId: 1 });
  assert.throws(() => normalizeAddonReward({ type: "building-unlock", playerId: "FLS_1", itemId: "Set_1", amount: 2 }), /amount of 1/);
});

test("delivers once and returns the durable receipt on retries", async () => {
  const f = fixture();
  try {
    const payload = { requestId: "season:s1:p1:t1", type: "item", playerId: "FLS_1", itemId: "WaterBottle_1", quantity: 2 };
    const first = await f.service.request("battle-pass", payload);
    const retry = await f.service.request("battle-pass", payload);
    assert.equal(first.status, "delivered");
    assert.equal(retry.duplicate, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.service.get("battle-pass", payload.requestId).status, "delivered");
  } finally {
    f.cleanup();
  }
});

test("persists offline deliveries and completes them during a later tick", async () => {
  let available = false;
  let currentTime = new Date("2026-09-11T10:00:00Z");
  const calls = [];
  const f = fixture({ now: () => currentTime, deliver: async (payload) => {
    calls.push(payload);
    if (!available) deferAddonDelivery("Player is offline; waiting for them to connect.");
    return { ok: true };
  } });
  try {
    const queued = await f.service.request("battle-pass", { requestId: "offline-1", type: "xp", playerId: "FLS_1", amount: 100 });
    assert.equal(queued.status, "pending");
    available = true;
    currentTime = new Date("2026-09-11T10:00:31Z");
    assert.deepEqual(await f.service.tick(), { attempted: 1 });
    assert.equal(f.service.get("battle-pass", "offline-1").status, "delivered");
    assert.equal(calls.length, 2);
  } finally {
    f.cleanup();
  }
});

test("does not bypass the offline retry delay when an addon repeats a pending request", async () => {
  let currentTime = new Date("2026-09-11T10:00:00Z");
  const f = fixture({
    now: () => currentTime,
    deliver: async () => deferAddonDelivery("Player is offline; waiting for them to connect.")
  });
  try {
    const payload = { requestId: "offline-repeat", type: "xp", playerId: "FLS_1", amount: 100 };
    const queued = await f.service.request("battle-pass", payload);
    currentTime = new Date("2026-09-11T10:00:01Z");
    const repeated = await f.service.request("battle-pass", payload);
    assert.equal(queued.attempts, 1);
    assert.equal(repeated.attempts, 1);
    assert.equal(repeated.duplicate, true);
  } finally {
    f.cleanup();
  }
});

test("does not retry an interrupted in-flight delivery", async () => {
  const f = fixture();
  try {
    await f.service.request("battle-pass", { requestId: "done", type: "xp", playerId: "FLS_1", amount: 10 });
    const path = join(f.repoRoot, "runtime/addons/deliveries/battle-pass/done.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.status = "processing";
    writeFileSync(path, JSON.stringify(record));
    assert.deepEqual(await f.service.tick(), { attempted: 0 });
    assert.equal(f.service.get("battle-pass", "done").status, "uncertain");
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("rejects request ID reuse with changed reward details", async () => {
  const f = fixture();
  try {
    await f.service.request("battle-pass", { requestId: "same", type: "xp", playerId: "FLS_1", amount: 10 });
    await assert.rejects(() => f.service.request("battle-pass", { requestId: "same", type: "xp", playerId: "FLS_1", amount: 11 }), /different/);
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("fails closed when a delivery receipt is modified outside the service", async () => {
  const f = fixture();
  try {
    await f.service.request("battle-pass", { requestId: "tamper", type: "xp", playerId: "FLS_1", amount: 10 });
    const path = join(f.repoRoot, "runtime/addons/deliveries/battle-pass/tamper.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.payload.amount = 999;
    writeFileSync(path, JSON.stringify(record));
    assert.throws(() => f.service.get("battle-pass", "tamper"), /invalid/);
  } finally {
    f.cleanup();
  }
});

test("keeps reward and message listings separated before applying the limit", async () => {
  const f = fixture();
  try {
    await f.service.request("battle-pass", { requestId: "reward", type: "xp", playerId: "FLS_1", amount: 10 });
    await f.service.request("battle-pass", { requestId: "message", playerId: "FLS_1", message: "Tier unlocked" }, { permission: "players:message", kind: "message" });
    assert.deepEqual(f.service.list("battle-pass", { limit: 1 }, { kind: "reward" }).map((entry) => entry.requestId), ["reward"]);
    assert.deepEqual(f.service.list("battle-pass", { limit: 1 }, { kind: "message" }).map((entry) => entry.requestId), ["message"]);
  } finally {
    f.cleanup();
  }
});
