import test from "node:test";
import assert from "node:assert/strict";
import { resolveCurrentSeed, resolveCoriolisCycle } from "../src/services/coriolisSeed.js";

test("resolveCurrentSeed parses the Coriolis world seed from log output", async () => {
  const runLogs = async () => ({ stdout: "LogCoriolis: Current Coriolis World Seed: 2\n", stderr: "" });
  assert.equal(await resolveCurrentSeed({ runLogs }), "cor-2");
});

test("resolveCurrentSeed uses the last matching line when several are present", async () => {
  const runLogs = async () => ({
    stdout: "Current Coriolis World Seed: 1\nsome other log line\nCurrent Coriolis World Seed: 5\n",
    stderr: ""
  });
  assert.equal(await resolveCurrentSeed({ runLogs }), "cor-5");
});

test("resolveCurrentSeed returns null when the container isn't running", async () => {
  const runLogs = async () => { throw new Error("docker logs failed with exit 1"); };
  assert.equal(await resolveCurrentSeed({ runLogs }), null);
});

test("resolveCurrentSeed returns null when the line isn't in the tailed window", async () => {
  const runLogs = async () => ({ stdout: "some unrelated log line\n", stderr: "" });
  assert.equal(await resolveCurrentSeed({ runLogs }), null);
});

test("resolveCurrentSeed passes a wide tail and a short timeout so a hung docker call can't stall the request", async () => {
  let seenOptions = null;
  const runLogs = async (service, options) => {
    seenOptions = options;
    return { stdout: "Current Coriolis World Seed: 3\n", stderr: "" };
  };
  await resolveCurrentSeed({ runLogs });
  assert.equal(seenOptions.tail, 10000);
  assert.equal(seenOptions.timeoutMs, 5000);
});

test("resolveCoriolisCycle parses both the seed and the next cycle's UTC start", async () => {
  const runLogs = async () => ({
    stdout: [
      "LogCoriolis: Display: Current Coriolis World Seed: 2",
      "LogCoriolis: Display: This Coriolis Cycle start date UTC: 2026.08.18-05.00.00",
      "LogCoriolis: Display: Next Coriolis Cycle start date UTC: 2026.08.25-05.00.00"
    ].join("\n"),
    stderr: ""
  });
  const result = await resolveCoriolisCycle({ runLogs });
  assert.equal(result.seed, "cor-2");
  assert.equal(result.nextCycleAt, "2026-08-25T05:00:00.000Z");
});

test("resolveCoriolisCycle returns nulls when the container isn't running", async () => {
  const runLogs = async () => { throw new Error("docker logs failed with exit 1"); };
  const result = await resolveCoriolisCycle({ runLogs });
  assert.deepEqual(result, { seed: null, nextCycleAt: null });
});

test("resolveCoriolisCycle returns a null nextCycleAt when only the seed line is present", async () => {
  const runLogs = async () => ({ stdout: "Current Coriolis World Seed: 4\n", stderr: "" });
  const result = await resolveCoriolisCycle({ runLogs });
  assert.equal(result.seed, "cor-4");
  assert.equal(result.nextCycleAt, null);
});

test("resolveCoriolisCycle falls back to survival-1 when overmap is running but hasn't logged the block (e.g. map mode disabled)", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    if (service === "overmap") return { stdout: "some unrelated log line\n", stderr: "" };
    return { stdout: "Current Coriolis World Seed: 6\nNext Coriolis Cycle start date UTC: 2026.08.25-05.00.00\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ runLogs });
  assert.deepEqual(seenServices, ["overmap", "survival-1"]);
  assert.equal(result.seed, "cor-6");
  assert.equal(result.nextCycleAt, "2026-08-25T05:00:00.000Z");
});

test("resolveCoriolisCycle falls back to survival-1 when the overmap container isn't running at all", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    if (service === "overmap") throw new Error("docker logs failed with exit 1");
    return { stdout: "Current Coriolis World Seed: 6\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ runLogs });
  assert.deepEqual(seenServices, ["overmap", "survival-1"]);
  assert.equal(result.seed, "cor-6");
});

test("resolveCoriolisCycle does not query past the fixed fallback list", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ runLogs });
  assert.deepEqual(seenServices, ["overmap", "survival-1"]);
  assert.deepEqual(result, { seed: null, nextCycleAt: null });
});

test("resolveCoriolisCycle stops at overmap and never queries survival-1 when overmap already answers", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "Current Coriolis World Seed: 2\n", stderr: "" };
  };
  await resolveCoriolisCycle({ runLogs });
  assert.deepEqual(seenServices, ["overmap"]);
});

test("resolveCoriolisCycle asks the selected Deep Desert partition's own container first", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    if (service === "dune-server-deepdesert-1-59") return { stdout: "Current Coriolis World Seed: 2\n", stderr: "" };
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "59", runLogs });
  assert.deepEqual(seenServices, ["dune-server-deepdesert-1-59"]);
  assert.equal(result.seed, "cor-2");
});

test("resolveCoriolisCycle falls back from a Deep Desert partition's suffixed container to the bare one, then the farm-wide default", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    if (service === "dune-server-deepdesert-1") return { stdout: "Current Coriolis World Seed: 2\n", stderr: "" };
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.deepEqual(seenServices, ["dune-server-deepdesert-1-8", "dune-server-deepdesert-1"]);
  assert.equal(result.seed, "cor-2");
});

test("resolveCoriolisCycle falls all the way through to overmap/survival-1 when no Deep Desert partition container answers", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    if (service === "overmap") return { stdout: "Current Coriolis World Seed: 2\n", stderr: "" };
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.deepEqual(seenServices, ["dune-server-deepdesert-1-8", "dune-server-deepdesert-1", "overmap"]);
  assert.equal(result.seed, "cor-2");
});

test("resolveCoriolisCycle asks Hagga Basin partition 1 via the bare survival-1 container, not a suffixed one", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "Current Coriolis World Seed: 2\n", stderr: "" };
  };
  await resolveCoriolisCycle({ map: "HaggaBasin", partitionId: "1", runLogs });
  assert.deepEqual(seenServices, ["dune-server-survival-1"]);
});

test("resolveCoriolisCycle asks Hagga Basin's other partitions via their own suffixed container", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "Current Coriolis World Seed: 2\n", stderr: "" };
  };
  await resolveCoriolisCycle({ map: "HaggaBasin", partitionId: "60", runLogs });
  assert.deepEqual(seenServices, ["dune-server-survival-1-60"]);
});

test("resolveCoriolisCycle ignores map/partitionId when no partitionId is selected (All Partitions)", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "Current Coriolis World Seed: 2\n", stderr: "" };
  };
  await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "", runLogs });
  assert.deepEqual(seenServices, ["overmap"]);
});

test("resolveCoriolisCycle ignores malformed partition IDs instead of constructing Docker service names from them", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "Current Coriolis World Seed: 2\n", stderr: "" };
  };
  await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "../../59", runLogs });
  assert.deepEqual(seenServices, ["overmap"]);
});
