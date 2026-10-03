import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSelfUpdateStatus, readSelfUpdateStatus } from "../src/services/selfUpdateStatus.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

test("failed detached updates expose provider limits only from the matching run", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-limit-"));
  try {
    const path = initializeSelfUpdateStatus(root, RUN_ID);
    writeFileSync(path, readFileSync(path, "utf8").replace("state=running", "state=failed"));
    const log = join(root, "runtime/generated/web-self-update.log");
    writeFileSync(log, `Console update run: ${RUN_ID}\n${"build output\n".repeat(10000)}docker: Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit.\n`);
    assert.equal(readSelfUpdateStatus(root, RUN_ID).message, "Docker Hub request limit reached. Try again later; no retry time was provided.");
    writeFileSync(log, "Console update run: another-run\ndocker: Error response from daemon: toomanyrequests\n");
    assert.equal(readSelfUpdateStatus(root, RUN_ID).message, "Starting the update helper.");
    writeFileSync(log, `Console update run: ${RUN_ID}\nregistry.funcom.com HTTP response 403 Forbidden\n`);
    assert.equal(readSelfUpdateStatus(root, RUN_ID).message, "Starting the update helper.");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-update status returns a bounded pending result before the helper writes", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  try {
    assert.deepEqual(readSelfUpdateStatus(root, RUN_ID), {
      runId: RUN_ID,
      state: "pending",
      stage: "launching",
      percent: 1,
      message: "Waiting for the update helper to start."
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-update status is initialized durably before the detached helper starts", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  const now = Date.parse("2026-08-24T21:04:18Z");
  try {
    const path = initializeSelfUpdateStatus(root, RUN_ID, now);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(readFileSync(path, "utf8"), /^state=running$/m);
    assert.deepEqual(readSelfUpdateStatus(root, RUN_ID, { now: now + 1000 }), {
      runId: RUN_ID,
      state: "running",
      stage: "launching",
      percent: 1,
      message: "Starting the update helper.",
      startedAt: "2026-08-24T21:04:18.000Z",
      updatedAt: "2026-08-24T21:04:18.000Z",
      finishedAt: null
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing legacy progress recovers after the replacement Console starts", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  try {
    const result = readSelfUpdateStatus(root, RUN_ID, {
      taskStartedAt: "2026-08-24T21:04:18Z",
      consoleStartedAt: Date.parse("2026-08-24T21:05:21Z"),
      now: Date.parse("2026-08-24T21:05:30Z")
    });
    assert.equal(result.state, "succeeded");
    assert.equal(result.recovered, true);
    assert.equal(result.percent, 100);
    assert.match(result.message, /updated Console is running/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialized launch progress recovers if the replacement Console starts before the helper finalizes it", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  const startedAt = Date.parse("2026-08-24T21:04:18Z");
  try {
    initializeSelfUpdateStatus(root, RUN_ID, startedAt);
    const result = readSelfUpdateStatus(root, RUN_ID, {
      consoleStartedAt: startedAt + 63_000,
      now: startedAt + 70_000
    });
    assert.equal(result.state, "succeeded");
    assert.equal(result.recovered, true);
    assert.match(result.message, /did not finish its progress record/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or untouched launch progress fails instead of waiting forever", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  const startedAt = Date.parse("2026-08-24T21:04:18Z");
  try {
    const missing = readSelfUpdateStatus(root, RUN_ID, {
      taskStartedAt: new Date(startedAt).toISOString(),
      consoleStartedAt: startedAt - 60_000,
      now: startedAt + 120_000
    });
    assert.equal(missing.state, "failed");
    assert.match(missing.message, /did not report progress within two minutes/i);

    initializeSelfUpdateStatus(root, RUN_ID, startedAt);
    const untouched = readSelfUpdateStatus(root, RUN_ID, { now: startedAt + 120_000 });
    assert.equal(untouched.state, "failed");
    assert.match(untouched.message, /did not begin within two minutes/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-update status validates and normalizes a durable helper result", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  const directory = join(root, "runtime", "generated", "self-update-status");
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${RUN_ID}.env`), [
      `run_id=${RUN_ID}`,
      "state=failed",
      "stage=building",
      "percent=124",
      "message=npm ci timed out\u0000",
      "started_at=2026-08-18T07:00:00+00:00",
      "updated_at=not-a-date",
      "finished_at=2026-08-18T07:30:00+00:00"
    ].join("\n"));

    assert.deepEqual(readSelfUpdateStatus(root, RUN_ID), {
      runId: RUN_ID,
      state: "failed",
      stage: "building",
      percent: 100,
      message: "npm ci timed out",
      startedAt: "2026-08-18T07:00:00+00:00",
      updatedAt: null,
      finishedAt: "2026-08-18T07:30:00+00:00"
    });
    assert.throws(() => readSelfUpdateStatus(root, "../../etc/passwd"), /Invalid console update run ID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-update status rejects mismatched or corrupt helper state", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-self-update-status-"));
  const directory = join(root, "runtime", "generated", "self-update-status");
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${RUN_ID}.env`), `run_id=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa\nstate=running\n`);
    assert.throws(() => readSelfUpdateStatus(root, RUN_ID), /does not match/);
    writeFileSync(join(directory, `${RUN_ID}.env`), `run_id=${RUN_ID}\nstate=unknown\n`);
    assert.throws(() => readSelfUpdateStatus(root, RUN_ID), /invalid state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
