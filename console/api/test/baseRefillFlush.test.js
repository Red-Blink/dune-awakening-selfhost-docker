import test from "node:test";
import assert from "node:assert/strict";
import { flushBaseRefillQueues } from "../src/services/baseRefillFlush.js";

test("map-down refill flush waits for both queues and labels their results", async () => {
  const completed = [];
  let releaseWater;
  const waterBlocked = new Promise((resolve) => { releaseWater = resolve; });

  const pending = flushBaseRefillQueues({
    flushGenerators: async () => {
      completed.push("generator");
      return { flushed: [{ baseId: 11, ok: true }] };
    },
    flushWater: async () => {
      await waterBlocked;
      completed.push("water");
      return { flushed: [{ baseId: 22, ok: true }] };
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, ["generator"]);
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the map-down hook must remain pending while either queue is flushing");

  releaseWater();
  const result = await pending;
  assert.deepEqual(completed, ["generator", "water"]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.flushed, [
    { baseId: 11, ok: true, refillType: "generator" },
    { baseId: 22, ok: true, refillType: "water" }
  ]);
});

test("a failed queue does not stop the hook waiting for the other queue", async () => {
  let waterFinished = false;
  const result = await flushBaseRefillQueues({
    flushGenerators: async () => { throw new Error("generator database unavailable"); },
    flushWater: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      waterFinished = true;
      return { flushed: [{ baseId: 33, ok: true }] };
    }
  });

  assert.equal(waterFinished, true);
  assert.deepEqual(result.flushed, [{ baseId: 33, ok: true, refillType: "water" }]);
  assert.deepEqual(result.failures, [{ refillType: "generator", error: "generator database unavailable" }]);
});

test("flushDeletes is optional and additive alongside the two refill queues", async () => {
  const result = await flushBaseRefillQueues({
    flushGenerators: async () => ({ flushed: [{ baseId: 1, ok: true }] }),
    flushWater: async () => ({ flushed: [{ baseId: 2, ok: true }] }),
    flushDeletes: async () => ({ flushed: [{ baseId: 3, ok: true }] })
  });
  assert.deepEqual(result.flushed, [
    { baseId: 1, ok: true, refillType: "generator" },
    { baseId: 2, ok: true, refillType: "water" },
    { baseId: 3, ok: true, refillType: "delete" }
  ]);
  assert.deepEqual(result.failures, []);
});

test("omitting flushDeletes behaves exactly as before this leg existed", async () => {
  const result = await flushBaseRefillQueues({
    flushGenerators: async () => ({ flushed: [{ baseId: 1, ok: true }] }),
    flushWater: async () => ({ flushed: [{ baseId: 2, ok: true }] })
  });
  assert.deepEqual(result.flushed, [
    { baseId: 1, ok: true, refillType: "generator" },
    { baseId: 2, ok: true, refillType: "water" }
  ]);
  assert.deepEqual(result.failures, []);
});

test("a failed delete flush does not stop the hook waiting for the other queues", async () => {
  const result = await flushBaseRefillQueues({
    flushGenerators: async () => ({ flushed: [{ baseId: 1, ok: true }] }),
    flushWater: async () => ({ flushed: [{ baseId: 2, ok: true }] }),
    flushDeletes: async () => { throw new Error("delete queue database unavailable"); }
  });
  assert.deepEqual(result.flushed, [
    { baseId: 1, ok: true, refillType: "generator" },
    { baseId: 2, ok: true, refillType: "water" }
  ]);
  assert.deepEqual(result.failures, [{ refillType: "delete", error: "delete queue database unavailable" }]);
});

test("base permission and vehicle delete queues both flush during the same map-down window", async () => {
  const result = await flushBaseRefillQueues({
    flushGenerators: async () => ({ flushed: [] }),
    flushWater: async () => ({ flushed: [] }),
    flushChildAccess: async () => ({ flushed: [{ baseId: 4, updated: 2, ok: true }] }),
    flushVehicleDeletes: async () => ({ flushed: [{ vehicleId: 5, ok: true }] })
  });
  assert.deepEqual(result.flushed, [
    { baseId: 4, updated: 2, ok: true, refillType: "childAccess" },
    { vehicleId: 5, ok: true, refillType: "vehicle-delete" }
  ]);
  assert.deepEqual(result.failures, []);
});
