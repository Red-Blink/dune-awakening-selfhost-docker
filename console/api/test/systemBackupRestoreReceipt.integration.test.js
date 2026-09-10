// Real HTTP coverage for the preview-then-apply gate on
// POST /api/backups/system/{name}/restore.
//
// Reported by the repo owner on PR #208: the rule was enforced only by the
// React flow, so a caller holding the restore grant could POST apply: true and
// replace .env, runtime/secrets/, runtime/generated/ and the database without
// ever previewing. runner.js sets DUNE_DB_ASSUME_YES, so db.sh's interactive
// "Type RESTORE to confirm" prompt did not gate the API path either.
//
// Unit tests for the store live in restorePreviewReceipts.test.js. These exist
// because that store proves nothing about server.js's own wiring -- the route
// could fail to call it at all and every unit test would still pass. Same
// reasoning as systemBackupImportRoute.integration.test.js, which was written
// after exactly that class of bug shipped.
//
// No gpg and no Postgres: a stub `dune` stands in for the shell, because what
// is under test is whether the ROUTE refuses, which it decides before any task
// exists.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 21000 + ((process.pid + 11) % 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const ARCHIVE = "dune-system-20260907-004052-6506-28750.tar.gz.enc";
const PASSPHRASE = "test-passphrase-1234";

// Exits 0 normally so a dry run succeeds and records a receipt; exits 1 when
// the marker exists, which is how the "a failed preview authorizes nothing"
// case makes the preview fail without changing anything else.
const STUB_DUNE = `#!/bin/sh
# Records the digest the console passed, so a test can prove the console sends
# it -- db.sh's own verification is unreachable otherwise.
echo "\${DUNE_SYSTEM_RESTORE_EXPECTED_SHA256}" > "$(dirname "$0")/../generated/last-expected-sha"
if [ -f "$(dirname "$0")/../generated/fail-preview" ]; then
  echo "stub: refusing" >&2
  exit 1
fi
echo "stub dune: $*"
exit 0
`;

function makeRepoRoot(archiveBytes = "archive-one") {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-restore-receipt-"));
  mkdirSync(join(repoRoot, "runtime/backups/system"), { recursive: true });
  mkdirSync(join(repoRoot, "runtime/generated"), { recursive: true });
  mkdirSync(join(repoRoot, "runtime/scripts"), { recursive: true });
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  writeFileSync(join(repoRoot, "VERSION"), "test\n");
  writeFileSync(join(repoRoot, "runtime/backups/system", ARCHIVE), archiveBytes);
  const dune = join(repoRoot, "runtime/scripts/dune");
  writeFileSync(dune, STUB_DUNE);
  chmodSync(dune, 0o755);
  return repoRoot;
}

function startServer(repoRoot) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: repoRoot,
      ADMIN_AUTH_DISABLED: "1",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(PORT),
      ADMIN_STATIC_DIR: join(repoRoot, "console/web/dist")
    },
    stdio: ["ignore", "pipe", "pipe"]
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
  return { child, ready, getOutput: () => output };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

function restore(body) {
  return fetch(`${BASE}/api/backups/system/${encodeURIComponent(ARCHIVE)}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASSPHRASE, ...body })
  });
}

// The receipt is recorded when the dry-run TASK succeeds, not when the route
// returns, so an apply sent before that would race the thing under test.
async function waitForTask(id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE}/api/setup/tasks/${id}`);
    if (response.ok) {
      const { task } = await response.json();
      if (task.status === "succeeded" || task.status === "failed") return task;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Task ${id} did not finish in ${timeoutMs}ms`);
}

async function preview() {
  const response = await restore({ apply: false });
  assert.equal(response.status, 202, `preview should be accepted, got ${response.status}`);
  const { task } = await response.json();
  return waitForTask(task.id);
}

test("refuses a direct apply that was never previewed", { timeout: 40000 }, async () => {
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;
    const response = await restore({ apply: true });
    // 409, not 202: the request is well-formed, it is the state that forbids it.
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /previewed successfully/i);

    // And nothing was dispatched -- a 409 that still queued the restore would
    // be no gate at all. The list must actually be readable: an unreachable
    // path here would assert nothing while looking like it passed.
    const listed = await fetch(`${BASE}/api/setup/tasks`);
    assert.equal(listed.status, 200, "could not read the task list to prove nothing was queued");
    const { tasks } = await listed.json();
    assert.ok(Array.isArray(tasks), "task list should be an array");
    assert.equal(tasks.filter((task) => task.operation === "backupSystemRestore").length, 0);
  } finally {
    await stopServer(child);
  }
});

test("allows an apply after a successful preview of the same archive", { timeout: 40000 }, async () => {
  const repoRoot = makeRepoRoot();
  const { child, ready, getOutput } = startServer(repoRoot);
  try {
    await ready;
    const previewTask = await preview();
    assert.equal(previewTask.status, "succeeded", `preview task failed: ${JSON.stringify(previewTask.logLines)}`);

    const response = await restore({ apply: true, identityMode: "adopt-backup", auditLogMode: "adopt-backup" });
    assert.equal(response.status, 202, `apply should be accepted after a preview. Server said: ${getOutput()}`);
  } finally {
    await stopServer(child);
  }
});

test("refuses an apply when the archive changed after the preview", { timeout: 40000 }, async () => {
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;
    const previewTask = await preview();
    assert.equal(previewTask.status, "succeeded");

    // The swap the hash exists to catch.
    writeFileSync(join(repoRoot, "runtime/backups/system", ARCHIVE), "archive-two-different-bytes");

    const response = await restore({ apply: true });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /changed after it was previewed/i);
  } finally {
    await stopServer(child);
  }
});

test("a preview that failed authorizes nothing", { timeout: 40000 }, async () => {
  const repoRoot = makeRepoRoot();
  writeFileSync(join(repoRoot, "runtime/generated/fail-preview"), "");
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;
    const previewTask = await preview();
    assert.equal(previewTask.status, "failed", "the stub should have made the dry run fail");

    const response = await restore({ apply: true });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /previewed successfully/i);
  } finally {
    await stopServer(child);
  }
});

test("refuses a second apply once the first has consumed the preview", { timeout: 40000 }, async () => {
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;
    assert.equal((await preview()).status, "succeeded");

    const first = await restore({ apply: true });
    assert.equal(first.status, 202);
    const { task } = await first.json();
    assert.equal((await waitForTask(task.id)).status, "succeeded");

    // Replaying the same call must not restore the host a second time without
    // a fresh preview.
    const second = await restore({ apply: true });
    assert.equal(second.status, 409);
  } finally {
    await stopServer(child);
  }
});

test("hands the shell the digest it approved, so the file cannot be swapped under it", async () => {
  // The route hashes the archive, then the restore spawns and db.sh opens the
  // file seconds later -- and an upload can rename a different archive onto
  // that name in between. db.sh re-checks against a private copy, but only if
  // the console actually sends the digest, which is what this pins.
  const bytes = "archive-one";
  const repoRoot = makeRepoRoot(bytes);
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;
    const previewTask = await preview();
    assert.equal(previewTask.status, "succeeded");

    const recorded = readFileSync(join(repoRoot, "runtime/generated/last-expected-sha"), "utf8").trim();
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(recorded, expected, "the console must pass the sha256 of the archive it hashed");
  } finally {
    await stopServer(child);
  }
});

test("refuses an apply flag it does not recognise instead of quietly previewing", async () => {
  // `apply: "true"` used to fall through to a dry run and return 202 with a
  // task, so a scripted client reported a successful restore while nothing had
  // been applied. Failing safe is right; failing safe silently is not.
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;
    const response = await restore({ apply: "true" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /must be true or false/i);

    // And it dispatched nothing at all -- not even the dry run it used to run.
    const listed = await fetch(`${BASE}/api/setup/tasks`);
    assert.equal(listed.status, 200);
    const { tasks } = await listed.json();
    assert.equal(tasks.filter((task) => task.operation === "backupSystemRestore").length, 0);
  } finally {
    await stopServer(child);
  }
});

test("still accepts the shapes a real client sends", async () => {
  // The refusal must not become a wall: the console sends booleans, and "1"/"0"
  // are the documented form for a shell client.
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;
    for (const value of [false, "0", ""]) {
      const response = await restore({ apply: value });
      assert.equal(response.status, 202, `apply: ${JSON.stringify(value)} should preview, got ${response.status}`);
      await waitForTask((await response.json()).task.id);
    }
    // Omitted entirely is a preview too.
    const bare = await fetch(`${BASE}/api/backups/system/${encodeURIComponent(ARCHIVE)}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE })
    });
    assert.equal(bare.status, 202);
  } finally {
    await stopServer(child);
  }
});

test("puts a ceiling on the route that streams every credential on the host", async () => {
  // The download hands over an encrypted copy of .env, all of runtime/secrets
  // and the IAM policies. It was the only system-backup route with no limiter,
  // so a browser session could pull the host's whole credential set as fast as
  // the disk allows. Exercised for real rather than grepped for: what matters
  // is that a 429 actually arrives.
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot);
  try {
    await ready;
    const url = `${BASE}/api/backups/system/${encodeURIComponent(ARCHIVE)}/download`;
    let limited = 0;
    let served = 0;
    for (let i = 0; i < 30; i += 1) {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (response.status === 429) limited += 1;
      else if (response.status === 200) served += 1;
    }
    assert.ok(served > 0, "the download must still work for ordinary use");
    assert.ok(limited > 0, "repeated downloads must eventually be refused");
  } finally {
    await stopServer(child);
  }
});
