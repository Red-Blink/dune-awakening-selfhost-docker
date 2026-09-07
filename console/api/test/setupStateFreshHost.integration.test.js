// Real HTTP coverage for what /api/setup/state calls a "complete" setup, which
// is what decides whether an operator sees the console or the deployment
// wizard.
//
// A host with no game files, no Funcom token and no Battlegroup identity
// reported complete: true, because isInitializedStackPresent() counted
// dune-orchestrator -- the console's own helper, which runs on a host that has
// never deployed anything -- as evidence of a deployed stack. The wizard is the
// only way to deploy such a host, so it was hidden exactly where it was needed.
//
// Spawned over real HTTP rather than unit-tested: setupState() and
// isInitializedStackPresent() are module-internal to server.js, and the thing
// worth pinning is the answer the browser actually receives.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 21000 + ((process.pid + 7) % 20000);
const BASE = `http://127.0.0.1:${PORT}`;

// A stub `docker` on PATH, so the answer depends on the container list this
// test chooses rather than on whatever happens to run on the machine.
function makeDockerStub(dir, runningContainers) {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "docker");
  writeFileSync(stub, [
    "#!/usr/bin/env bash",
    'if [ "$1" = "ps" ]; then',
    ...runningContainers.map((name) => `  printf '%s\\n' ${name}`),
    "fi",
    "exit 0"
  ].join("\n"));
  chmodSync(stub, 0o755);
  return binDir;
}

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-setup-state-"));
  mkdirSync(join(repoRoot, "runtime/generated"), { recursive: true });
  mkdirSync(join(repoRoot, "runtime/secrets"), { recursive: true });
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  writeFileSync(join(repoRoot, "VERSION"), "test\n");
  // The console configured itself, which is all a brand-new host has.
  writeFileSync(join(repoRoot, ".env"), "SERVER_TITLE=Fresh\n");
  return repoRoot;
}

async function readSetupState(repoRoot, runningContainers) {
  const binDir = makeDockerStub(repoRoot, runningContainers);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
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
  try {
    await new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`API did not start.\n${output}`)), 20000);
      const poll = setInterval(async () => {
        try {
          const response = await fetch(`${BASE}/api/health`);
          if (response.ok) { clearTimeout(timeout); clearInterval(poll); resolveReady(); }
        } catch {
          // Not listening yet.
        }
      }, 150);
      child.on("exit", (code) => {
        clearTimeout(timeout);
        clearInterval(poll);
        rejectReady(new Error(`API exited with ${code} before listening.\n${output}`));
      });
    });
    const response = await fetch(`${BASE}/api/setup/state`);
    // Read once: passing await response.text() as the assertion message would
    // consume the body before the parse below, whatever the status.
    const body = await response.text();
    assert.equal(response.status, 200, `setup state request failed: ${body}`);
    return JSON.parse(body).files;
  } finally {
    if (!child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
  }
}

test("a fresh host is not 'complete' just because the orchestrator is running", { timeout: 30000 }, async () => {
  const repoRoot = makeRepoRoot();
  try {
    const files = await readSetupState(repoRoot, ["dune-orchestrator", "redblink-dune-docker-console"]);

    assert.equal(files.token, false, "fixture should have no Funcom token");
    assert.equal(files.battlegroup, false, "fixture should have no Battlegroup identity");
    // The point of the test: the console's own helper containers are not
    // evidence that a game server was ever deployed here.
    assert.equal(files.initialized, false, "the orchestrator alone must not count as a deployed stack");
    assert.equal(files.complete, false, "a host with no token, identity or game files must see the wizard");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a running game container still counts as a deployed stack", { timeout: 30000 }, async () => {
  // The escape hatch this check exists for: a deployed host missing a
  // generated file must not be sent back through first-run setup.
  const repoRoot = makeRepoRoot();
  try {
    const files = await readSetupState(repoRoot, ["dune-orchestrator", "dune-postgres"]);
    assert.equal(files.initialized, true, "a running dune-postgres is a deployed stack");
    assert.equal(files.complete, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("installed game files count as a deployed stack with nothing running", { timeout: 30000 }, async () => {
  const repoRoot = makeRepoRoot();
  writeFileSync(join(repoRoot, "runtime/generated/image-tags.env"), "DUNE_WORLD_IMAGE_TAG=test\n");
  try {
    const files = await readSetupState(repoRoot, ["dune-orchestrator"]);
    assert.equal(files.initialized, true, "image-tags.env means the game files were installed here");
    assert.equal(files.complete, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
