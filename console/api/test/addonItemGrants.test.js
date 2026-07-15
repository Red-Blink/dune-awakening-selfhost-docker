import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantAddonItem, normalizeAddonItemGrant } from "../src/addonItemGrants.js";

test("normalizes a narrowly scoped addon item grant", () => {
  assert.deepEqual(normalizeAddonItemGrant({
    requestId: "airdrop:42",
    playerId: "FLS_TEST",
    itemId: "WaterBottle_1",
    quantity: 2,
    quality: 3
  }), {
    requestId: "airdrop:42",
    playerId: "FLS_TEST",
    itemId: "WaterBottle_1",
    quantity: 2,
    quality: 3,
    command: ["admin", "grant-item-id", "FLS_TEST", "WaterBottle_1", "2", "1", "3"]
  });
});

test("rejects wildcard, injection-shaped, excessive, and malformed grants", () => {
  assert.throws(() => normalizeAddonItemGrant({ requestId: "a", playerId: "*", itemId: "WaterBottle_1" }), /target one player/);
  assert.throws(() => normalizeAddonItemGrant({ requestId: "a", playerId: "FLS_TEST;id", itemId: "WaterBottle_1" }), /Invalid player id/);
  assert.throws(() => normalizeAddonItemGrant({ requestId: "a", playerId: "FLS_TEST", itemId: "WaterBottle_1;id" }), /Invalid item id/);
  assert.throws(() => normalizeAddonItemGrant({ requestId: "a", playerId: "FLS_TEST", itemId: "WaterBottle_1", quantity: 1001 }), /1 to 1000/);
  assert.throws(() => normalizeAddonItemGrant({ requestId: "bad request", playerId: "FLS_TEST", itemId: "WaterBottle_1" }), /requestId/);
});

test("persists successful grants and makes retries idempotent", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-grants-"));
  const calls = [];
  try {
    const payload = { requestId: "reward-100", playerId: "FLS_TEST", itemId: "WaterBottle_1", quantity: 2 };
    const options = {
      runDuneImpl: async (_config, args) => {
        calls.push(args);
        return { code: 0, stdout: "ok", stderr: "" };
      },
      now: () => new Date("2026-07-15T12:00:00.000Z")
    };
    const first = await grantAddonItem({ repoRoot, mockMode: false }, "airdrop-addon", payload, options);
    const retry = await grantAddonItem({ repoRoot, mockMode: false }, "airdrop-addon", payload, options);

    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    assert.equal(calls.length, 1);
    const receipts = JSON.parse(readFileSync(join(repoRoot, "runtime/addons/grant-receipts/airdrop-addon.json"), "utf8"));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].requestId, "reward-100");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("serializes concurrent duplicate grants", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-grants-"));
  let calls = 0;
  try {
    const payload = { requestId: "reward-concurrent", playerId: "FLS_TEST", itemId: "WaterBottle_1" };
    const options = {
      runDuneImpl: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { code: 0, stdout: "ok", stderr: "" };
      }
    };
    const results = await Promise.all([
      grantAddonItem({ repoRoot, mockMode: false }, "airdrop-addon", payload, options),
      grantAddonItem({ repoRoot, mockMode: false }, "airdrop-addon", payload, options)
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(results.map((result) => result.duplicate), [false, true]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("does not record failed grants and rejects requestId reuse with changed details", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-grants-"));
  try {
    const config = { repoRoot, mockMode: false };
    const failedOptions = { runDuneImpl: async () => { throw new Error("delivery failed"); } };
    await assert.rejects(() => grantAddonItem(config, "airdrop-addon", { requestId: "retryable", playerId: "FLS_TEST", itemId: "WaterBottle_1" }, failedOptions), /delivery failed/);

    let calls = 0;
    const successOptions = { runDuneImpl: async () => { calls += 1; return { code: 0, stdout: "ok", stderr: "" }; } };
    await grantAddonItem(config, "airdrop-addon", { requestId: "retryable", playerId: "FLS_TEST", itemId: "WaterBottle_1" }, successOptions);
    assert.equal(calls, 1);
    await assert.rejects(() => grantAddonItem(config, "airdrop-addon", { requestId: "retryable", playerId: "FLS_TEST", itemId: "WaterBottle_2" }, successOptions), /different grant details/);
    assert.equal(calls, 1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("does not record grants that fail live inventory verification", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-grants-"));
  try {
    const payload = { requestId: "unverified", playerId: "FLS_TEST", itemId: "WaterBottle_1" };
    const options = { runDuneImpl: async () => ({ code: 0, stdout: "", stderr: "Inventory stack did not increase" }) };
    await assert.rejects(() => grantAddonItem({ repoRoot, mockMode: false }, "airdrop-addon", payload, options), /inventory did not change/);
    assert.throws(() => readFileSync(join(repoRoot, "runtime/addons/grant-receipts/airdrop-addon.json")), /ENOENT/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("refuses grants when receipt state is corrupt", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-grants-"));
  try {
    const config = { repoRoot, mockMode: true };
    await grantAddonItem(config, "airdrop-addon", { requestId: "first", playerId: "FLS_TEST", itemId: "WaterBottle_1" });
    const receiptPath = join(repoRoot, "runtime/addons/grant-receipts/airdrop-addon.json");
    writeFileSync(receiptPath, "not json");
    await assert.rejects(() => grantAddonItem(config, "airdrop-addon", { requestId: "second", playerId: "FLS_TEST", itemId: "WaterBottle_1" }), /refusing to risk a duplicate/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
