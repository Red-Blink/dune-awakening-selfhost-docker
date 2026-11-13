import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHostIdentity } from "../src/services/hostIdentity.js";
import { TaskManager } from "../src/tasks.js";

const cases = [
  ["helper namespace", ["0", "0"], [], [1000, 1001], ["1000", "1001"]],
  ["persisted owner after root extraction", ["0", "0"], ["1000", "1001"], [0, 0], ["1000", "1001"]],
  ["persisted group", ["0", "0"], ["1000", "1001"], [1000, 1000], ["1000", "1001"]],
  ["bad root settings", ["0", "0"], ["0", "0"], [1000, 1001], ["1000", "1001"]],
  ["explicit nonroot", ["12345", "12346"], ["1000", "1001"], [1000, 1001], ["12345", "12346"]],
  ["explicit root group", ["12345", "0"], ["1000", "1001"], [1000, 1001], ["12345", "0"]],
  ["saved root group", ["0", "0"], ["1000", "0"], [0, 0], ["1000", "0"]],
  ["true root", ["0", "0"], ["0", "0"], [0, 0], ["0", "0"]],
  ["unset", [], [], [1000, 1001], ["1000", "1001"]]
];
for (const [name, incoming, saved, owner, expected] of cases) {
  test("helper identity: " + name, () => {
    const result = resolveHostIdentity({ repoRoot: "/repo", hostRepoRoot: "/host-only/missing-checkout" }, {
      env: { DUNE_HOST_UID: incoming[0], DUNE_HOST_GID: incoming[1] }, callerUid: 0, callerGid: 0,
      stat: path => { assert.equal(path, "/repo"); return { uid: owner[0], gid: owner[1] }; },
      readFile: path => { assert.equal(path, "/repo/.env"); return ["DUNE_HOST_UID=" + (saved[0] || ""), "DUNE_HOST_GID=" + (saved[1] || "")].join("\n"); }
    });
    assert.deepEqual(result, { uid: expected[0], gid: expected[1] });
  });
}

test("invalid explicit identity fails before creating a helper", () => {
  assert.throws(() => resolveHostIdentity({ repoRoot: "/absent" }, { env: { DUNE_HOST_UID: "invalid" } }), /numeric/);
});

test("update and reload launch helpers with persisted identity despite inherited root", async () => {
  const root = mkdtempSync(join(tmpdir(), "dune-owner-helper-"));
  const overrides = { DUNE_HOST_UID: "0", DUNE_HOST_GID: "0", DUNE_COMPOSE_PROJECT_NAME: "owner-fixture", DOCKER_SOCKET_GID: "988" };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    writeFileSync(join(root, ".env"), "DUNE_HOST_UID=12345\nDUNE_HOST_GID=12346\n");
    const calls = [];
    const manager = new TaskManager({ repoRoot: root, hostRepoRoot: "/host-only/missing-checkout", commandTimeoutMs: 1000 }, {
      runDockerCommand: async args => { calls.push(args); return { stdout: "", stderr: "", code: 0 }; }
    });
    for (const operation of ["selfUpdateApply", "consoleReload"]) {
      const task = { id: "123e4567-e89b-42d3-a456-426614174000", operation, logLines: [], subscribers: new Set() };
      if (operation === "selfUpdateApply") await manager.runSelfUpdateHelperTask(task, {});
      else await manager.runConsoleReloadTask(task);
    }
    const helpers = calls.filter(args => args[0] === "run");
    assert.equal(helpers.length, 2);
    for (const args of helpers) {
      assert.equal(args[args.indexOf("--user") + 1], "12345:12346");
      assert.ok(args.includes("DUNE_HOST_UID=12345"));
      assert.ok(args.includes("DUNE_HOST_GID=12346"));
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
