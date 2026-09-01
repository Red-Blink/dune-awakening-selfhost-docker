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
      "LogCoriolis: Display: This Coriolis Cycle start date UTC: 2099.08.18-05.00.00",
      "LogCoriolis: Display: Next Coriolis Cycle start date UTC: 2099.08.25-05.00.00"
    ].join("\n"),
    stderr: ""
  });
  const result = await resolveCoriolisCycle({ runLogs });
  assert.equal(result.seed, "cor-2");
  assert.equal(result.nextCycleAt, "2099-08-25T05:00:00.000Z");
});

test("resolveCoriolisCycle returns nulls when the container isn't running", async () => {
  const runLogs = async () => { throw new Error("docker logs failed with exit 1"); };
  const result = await resolveCoriolisCycle({ runLogs });
  assert.deepEqual(result, { seed: null, nextCycleAt: null, layout: null, staleSince: null });
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
    return { stdout: "Current Coriolis World Seed: 6\nNext Coriolis Cycle start date UTC: 2099.08.25-05.00.00\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ runLogs });
  assert.deepEqual(seenServices, ["overmap", "survival-1"]);
  assert.equal(result.seed, "cor-6");
  assert.equal(result.nextCycleAt, "2099-08-25T05:00:00.000Z");
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
  assert.deepEqual(result, { seed: null, nextCycleAt: null, layout: null, staleSince: null });
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
  // The seed came from the selected partition's own container first. The bare
  // container is still asked because this fixture logs no layout line and it is
  // the only remaining candidate that could carry one.
  assert.deepEqual(seenServices, ["dune-server-deepdesert-1-59", "dune-server-deepdesert-1"]);
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
  // Without known partition ids there is only the bare container to try, and it
  // answers here, so the farm-wide fallbacks are never reached.
  assert.deepEqual(seenServices, ["dune-server-deepdesert-1"]);
});

test("resolveCoriolisCycle ignores malformed partition IDs instead of constructing Docker service names from them", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "Current Coriolis World Seed: 2\n", stderr: "" };
  };
  await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "../../59", runLogs });
  // The malformed id is never interpolated into a service name -- only the
  // fixed bare container is tried.
  assert.deepEqual(seenServices, ["dune-server-deepdesert-1"]);
  assert.ok(!seenServices.some((service) => service.includes("..")));
});

const LAYOUT_LOG = [
  "[2026.08.31-01.30.38:547][  0][936]LogCoriolis: Display: Current Coriolis World Seed: 3",
  "[2026.08.31-01.30.38:547][  0][936]LogCoriolis: Display: Next Coriolis Cycle start date UTC: 2099.08.25-05.00.00",
  "[2026.08.31-01.31.18:238][102][936][8]LogWorldLayout: Display: BP_DuneGameState_C_2147481382: 'DA_DeepDesert_1_Layout_03' layout selected with 678 content blocks."
].join("\n");

test("resolveCoriolisCycle parses the Deep Desert cartography layout the cycle selected", async () => {
  const runLogs = async () => ({ stdout: LAYOUT_LOG, stderr: "" });
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.equal(result.layout, 3);
  assert.equal(result.seed, "cor-3");
});

// Layout 0 is a real layout and 0 is falsy: a `||` anywhere on this path throws
// it away, and the map would silently fall back to the flat image one week in
// twelve. Worth its own test because it reads as correct either way.
test("resolveCoriolisCycle keeps layout 0 rather than treating it as absent", async () => {
  const runLogs = async () => ({
    stdout: "Current Coriolis World Seed: 0\nNext Coriolis Cycle start date UTC: 2099.08.25-05.00.00\n'DA_DeepDesert_1_Layout_00' layout selected with 512 content blocks.\n",
    stderr: ""
  });
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.equal(result.layout, 0);
});

test("resolveCoriolisCycle returns a null layout when the line isn't in the tailed window", async () => {
  const runLogs = async () => ({ stdout: "Current Coriolis World Seed: 3\n", stderr: "" });
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.equal(result.layout, null);
  assert.equal(result.seed, "cor-3");
});

test("resolveCoriolisCycle uses the last layout line when a container logged several", async () => {
  const runLogs = async () => ({
    stdout: "Next Coriolis Cycle start date UTC: 2099.08.25-05.00.00\n'DA_DeepDesert_1_Layout_02' layout selected with 1 content blocks.\nnoise\n'DA_DeepDesert_1_Layout_07' layout selected with 2 content blocks.\n",
    stderr: ""
  });
  assert.equal((await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs })).layout, 7);
});

test("resolveCoriolisCycle ignores an implausible layout number instead of reporting it", async () => {
  const runLogs = async () => ({
    stdout: "Current Coriolis World Seed: 3\nNext Coriolis Cycle start date UTC: 2099.08.25-05.00.00\n'DA_DeepDesert_1_Layout_999' layout selected with 3 content blocks.\n",
    stderr: ""
  });
  assert.equal((await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs })).layout, null);
});

// overmap and survival-1 log the seed and the countdown but never the layout,
// so stopping at whichever answers first would blank the layout for the cycle.
test("resolveCoriolisCycle keeps looking for the layout after a container answers with only the seed", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    if (service === "dune-server-deepdesert-1-8") return { stdout: "Current Coriolis World Seed: 3\n", stderr: "" };
    if (service === "dune-server-deepdesert-1") return { stdout: "Next Coriolis Cycle start date UTC: 2099.08.25-05.00.00\n'DA_DeepDesert_1_Layout_05' layout selected with 4 content blocks.\n", stderr: "" };
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.deepEqual(seenServices, ["dune-server-deepdesert-1-8", "dune-server-deepdesert-1"]);
  assert.equal(result.seed, "cor-3");
  assert.equal(result.layout, 5);
});

test("resolveCoriolisCycle never asks overmap or survival-1 for a layout they cannot log", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    if (service === "overmap") return { stdout: "Current Coriolis World Seed: 3\n", stderr: "" };
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.deepEqual(seenServices, ["dune-server-deepdesert-1-8", "dune-server-deepdesert-1", "overmap"]);
  assert.equal(result.layout, null);
});

test("resolveCoriolisCycle stops at the first answer for Hagga Basin, which has no layout to find", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "Current Coriolis World Seed: 3\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ map: "HaggaBasin", partitionId: "60", runLogs });
  assert.deepEqual(seenServices, ["dune-server-survival-1-60"]);
  assert.equal(result.layout, null);
});

// "All Partitions" leaves partitionId empty, and on a real deploy there is no
// bare dune-server-deepdesert-1 (dune2 runs only -8 and -59), so without the
// known partition ids the layout would never be readable in that state.
test("resolveCoriolisCycle fans out over known Deep Desert partitions when no partition is selected", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    if (service === "dune-server-deepdesert-1-59") return { stdout: LAYOUT_LOG, stderr: "" };
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "", deepDesertPartitionIds: [8, 59], runLogs });
  assert.deepEqual(seenServices, ["dune-server-deepdesert-1-8", "dune-server-deepdesert-1-59"]);
  assert.equal(result.layout, 3);
});

test("resolveCoriolisCycle caps the Deep Desert fan-out and ignores malformed partition ids", async () => {
  const seenServices = [];
  const runLogs = async (service) => {
    seenServices.push(service);
    return { stdout: "some unrelated log line\n", stderr: "" };
  };
  await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "", deepDesertPartitionIds: [8, 59, 60, 61, 62, "../../x", "", null], runLogs });
  assert.deepEqual(seenServices, [
    "dune-server-deepdesert-1-8", "dune-server-deepdesert-1-59", "dune-server-deepdesert-1-60",
    "dune-server-deepdesert-1", "overmap", "survival-1"
  ]);
  assert.ok(!seenServices.some((service) => service.includes("..")));
});

// The precedence rule is "the first container that has a value wins", matching
// how the seed and countdown are merged. Layout 0 is the case that breaks it:
// with `||` instead of `??` a later container's non-zero layout silently
// overwrites a valid 0, and the map draws the wrong terrain for that cycle.
// The single-container layout-0 test above does NOT catch this -- `null || 0`
// and `null ?? 0` agree -- so the earlier container here deliberately logs the
// layout without a seed, which keeps the loop going.
test("resolveCoriolisCycle does not let a later container overwrite layout 0", async () => {
  const runLogs = async (service) => {
    if (service === "dune-server-deepdesert-1-8") {
      return { stdout: "Next Coriolis Cycle start date UTC: 2099.08.25-05.00.00\n'DA_DeepDesert_1_Layout_00' layout selected with 512 content blocks.\n", stderr: "" };
    }
    return {
      stdout: "Current Coriolis World Seed: 7\nNext Coriolis Cycle start date UTC: 2099.08.25-05.00.00\n'DA_DeepDesert_1_Layout_07' layout selected with 678 content blocks.\n",
      stderr: ""
    };
  };
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.equal(result.layout, 0);
  assert.equal(result.seed, "cor-7");
});

// Regression: dune2 kept serving cor-2 after the 2026-08-25 boundary because
// no container had restarted to print seed 3, putting the previous cycle's
// static pool on the map and filing new-cycle fields under the old seed.
test("resolveCoriolisCycle drops a seed whose own cycle boundary has already passed", async () => {
  const runLogs = async () => ({
    stdout: [
      "LogCoriolis: Display: Current Coriolis World Seed: 2",
      "LogCoriolis: Display: Next Coriolis Cycle start date UTC: 2020.01.01-05.00.00"
    ].join("\n"),
    stderr: ""
  });
  const result = await resolveCoriolisCycle({ runLogs });
  assert.equal(result.seed, null);
  assert.equal(result.nextCycleAt, null);
  assert.equal(result.staleSince, "2020-01-01T05:00:00.000Z");
});

test("resolveCoriolisCycle keeps a seed whose cycle boundary is still ahead", async () => {
  const runLogs = async () => ({
    stdout: [
      "LogCoriolis: Display: Current Coriolis World Seed: 7",
      "LogCoriolis: Display: Next Coriolis Cycle start date UTC: 2999.01.01-05.00.00"
    ].join("\n"),
    stderr: ""
  });
  const result = await resolveCoriolisCycle({ runLogs });
  assert.equal(result.seed, "cor-7");
  assert.equal(result.nextCycleAt, "2999-01-01T05:00:00.000Z");
  assert.equal(result.staleSince, null);
});

// Nothing to check the seed against, so it has to be passed through -- a
// self-hoster on a build that doesn't log the boundary line still gets a pool.
test("resolveCoriolisCycle passes through a seed logged without a cycle boundary", async () => {
  const runLogs = async () => ({ stdout: "Current Coriolis World Seed: 4\n", stderr: "" });
  const result = await resolveCoriolisCycle({ runLogs });
  assert.equal(result.seed, "cor-4");
  assert.equal(result.staleSince, null);
});

test("resolveCurrentSeed reports no seed once the logged cycle has expired", async () => {
  const runLogs = async () => ({
    stdout: [
      "Current Coriolis World Seed: 2",
      "Next Coriolis Cycle start date UTC: 2020.01.01-05.00.00"
    ].join("\n"),
    stderr: ""
  });
  assert.equal(await resolveCurrentSeed({ runLogs }), null);
});

// A layout is only as fresh as the cycle that produced it. The line is printed
// once at startup, so after a boundary the logs still name the previous cycle's
// layout -- and drawing that is the exact silent-wrong-terrain failure the
// rendered map exists to prevent.
test("resolveCoriolisCycle drops the layout once the cycle boundary has passed", async () => {
  const runLogs = async () => ({
    stdout: [
      "Current Coriolis World Seed: 3",
      "Next Coriolis Cycle start date UTC: 2020.01.01-05.00.00",
      "'DA_DeepDesert_1_Layout_03' layout selected with 678 content blocks."
    ].join("\n"),
    stderr: ""
  });
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.equal(result.layout, null);
  assert.equal(result.seed, null);
  assert.equal(result.staleSince, "2020-01-01T05:00:00.000Z");
});

test("resolveCoriolisCycle keeps the layout while the cycle is still current", async () => {
  const future = new Date(Date.now() + 86400000).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const stamp = `${future.slice(0, 4)}.${future.slice(4, 6)}.${future.slice(6, 8)}-${future.slice(9, 11)}.${future.slice(11, 13)}.00`;
  const runLogs = async () => ({
    stdout: [
      "Current Coriolis World Seed: 3",
      `Next Coriolis Cycle start date UTC: ${stamp}`,
      "'DA_DeepDesert_1_Layout_03' layout selected with 678 content blocks."
    ].join("\n"),
    stderr: ""
  });
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.equal(result.layout, 3);
  assert.equal(result.seed, "cor-3");
  assert.equal(result.staleSince, null);
});

// The seed and boundary print together at startup, but the layout line lands
// ~130 lines later, so `--tail` cuts between them from the front: the layout
// survives and its own dating does not. Merging that layout with a boundary
// from a container that restarted more recently produces a current-looking
// cycle carrying the previous cycle's terrain -- the exact silent failure the
// rendered map exists to prevent, and one that reports itself healthy.
function futureStamp(msFromNow = 86400000) {
  const t = new Date(Date.now() + msFromNow);
  const pad = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}.${pad(t.getUTCMonth() + 1)}.${pad(t.getUTCDate())}`
    + `-${pad(t.getUTCHours())}.${pad(t.getUTCMinutes())}.${pad(t.getUTCSeconds())}`;
}

test("resolveCoriolisCycle refuses a layout it cannot date from its own container", async () => {
  const runLogs = async (service) => {
    // The Deep Desert tail reaches the layout line but not the startup block.
    if (service === "dune-server-deepdesert-1-8") {
      return { stdout: "'DA_DeepDesert_1_Layout_03' layout selected with 678 content blocks.\n", stderr: "" };
    }
    // A more recently restarted overmap supplies a perfectly current cycle.
    return {
      stdout: `Current Coriolis World Seed: 3\nNext Coriolis Cycle start date UTC: ${futureStamp()}\n`,
      stderr: ""
    };
  };
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.equal(result.seed, "cor-3");
  assert.equal(result.staleSince, null);
  // The seed and countdown are current; the layout is not known to be.
  assert.equal(result.layout, null);
});

test("resolveCoriolisCycle dates a layout by its own container, not the first boundary seen", async () => {
  const runLogs = async (service) => {
    // This container's own cycle ended long ago, though it still names a layout.
    if (service === "dune-server-deepdesert-1-8") {
      return {
        stdout: [
          "Next Coriolis Cycle start date UTC: 2020.01.01-05.00.00",
          "'DA_DeepDesert_1_Layout_03' layout selected with 678 content blocks."
        ].join("\n"),
        stderr: ""
      };
    }
    return {
      stdout: `Current Coriolis World Seed: 9\nNext Coriolis Cycle start date UTC: ${futureStamp()}\n`,
      stderr: ""
    };
  };
  const result = await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", runLogs });
  assert.equal(result.layout, null);
});

test("resolveCoriolisCycle still takes a dated layout from a later container", async () => {
  const runLogs = async (service) => {
    // The selected partition carries the cycle but its layout line has scrolled off.
    if (service === "dune-server-deepdesert-1-8") {
      return {
        stdout: `Current Coriolis World Seed: 3\nNext Coriolis Cycle start date UTC: ${futureStamp()}\n`,
        stderr: ""
      };
    }
    // A sibling Deep Desert server has both, so its layout is datable and usable.
    if (service === "dune-server-deepdesert-1-59") {
      return {
        stdout: [
          `Next Coriolis Cycle start date UTC: ${futureStamp()}`,
          "'DA_DeepDesert_1_Layout_07' layout selected with 678 content blocks."
        ].join("\n"),
        stderr: ""
      };
    }
    return { stdout: "", stderr: "" };
  };
  const result = await resolveCoriolisCycle({
    map: "DeepDesert",
    deepDesertPartitionIds: ["8", "59"],
    runLogs
  });
  assert.equal(result.seed, "cor-3");
  assert.equal(result.layout, 7);
});

// Finding 12: containers restart independently, so the partition the user has
// selected may be the one that has not restarted since the boundary. Taking its
// word for the whole farm blanked the seed and the layout while a sibling had
// the current cycle one `docker logs` away. Everything here is farm-wide for the
// map, so any Deep Desert container can answer.
test("resolveCoriolisCycle asks a sibling when the selected partition's logs are stale", async () => {
  const asked = [];
  const runLogs = async (service) => {
    asked.push(service);
    if (service === "dune-server-deepdesert-1-8") {
      return {
        stdout: [
          "Current Coriolis World Seed: 2",
          "Next Coriolis Cycle start date UTC: 2020.01.01-05.00.00",
          "'DA_DeepDesert_1_Layout_03' layout selected with 1 content blocks."
        ].join("\n"),
        stderr: ""
      };
    }
    if (service === "dune-server-deepdesert-1-59") {
      return {
        stdout: [
          "Current Coriolis World Seed: 3",
          `Next Coriolis Cycle start date UTC: ${futureStamp()}`,
          "'DA_DeepDesert_1_Layout_07' layout selected with 1 content blocks."
        ].join("\n"),
        stderr: ""
      };
    }
    return { stdout: "", stderr: "" };
  };
  const result = await resolveCoriolisCycle({
    map: "DeepDesert",
    partitionId: "8",
    deepDesertPartitionIds: ["8", "59"],
    runLogs
  });
  assert.deepEqual(asked, ["dune-server-deepdesert-1-8", "dune-server-deepdesert-1-59"]);
  // The sibling's current cycle, not the stale container's.
  assert.equal(result.seed, "cor-3");
  assert.equal(result.layout, 7);
  // Nothing is stale: a container with a current cycle answered.
  assert.equal(result.staleSince, null);
});

test("resolveCoriolisCycle still reports staleness when every container is behind", async () => {
  const runLogs = async () => ({
    stdout: [
      "Current Coriolis World Seed: 2",
      "Next Coriolis Cycle start date UTC: 2020.01.01-05.00.00",
      "'DA_DeepDesert_1_Layout_03' layout selected with 1 content blocks."
    ].join("\n"),
    stderr: ""
  });
  const result = await resolveCoriolisCycle({
    map: "DeepDesert",
    partitionId: "8",
    deepDesertPartitionIds: ["8", "59"],
    runLogs
  });
  assert.equal(result.seed, null);
  assert.equal(result.layout, null);
  assert.equal(result.staleSince, "2020-01-01T05:00:00.000Z");
});

test("resolveCoriolisCycle asks no sibling when the selected partition answers in full", async () => {
  const asked = [];
  const runLogs = async (service) => {
    asked.push(service);
    return {
      stdout: [
        "Current Coriolis World Seed: 3",
        `Next Coriolis Cycle start date UTC: ${futureStamp()}`,
        "'DA_DeepDesert_1_Layout_03' layout selected with 1 content blocks."
      ].join("\n"),
      stderr: ""
    };
  };
  await resolveCoriolisCycle({ map: "DeepDesert", partitionId: "8", deepDesertPartitionIds: ["8", "59"], runLogs });
  // The fallbacks cost nothing in the normal case.
  assert.deepEqual(asked, ["dune-server-deepdesert-1-8"]);
});
