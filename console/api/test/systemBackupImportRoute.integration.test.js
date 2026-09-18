// Real HTTP integration coverage for POST /api/backups/system/import.
//
// A ReferenceError shipped in this route (sanitizeUploadFilename was used in
// server.js but never imported from services/systemBackupImport.js) and
// nothing caught it: systemBackupImport.test.js imports and calls
// sanitizeUploadFilename directly from the service module, which exercises
// the function but never server.js's own import statement, so a route that
// throws the moment it runs looked identical, from every existing test's
// point of view, to one that works. Found live, by an operator uploading a
// real file. Following the precedent bridgeActionDispatch.test.js and
// baseContainerMutationRoutes.integration.test.js already established:
// spawn the real src/server.js and hit it over real HTTP, because that is
// the only way to prove the module's own wiring, not just that the
// functions it calls behave correctly in isolation.
//
// No real Postgres: this route never touches the database (it is pure
// filesystem work), and db.js's pool connects lazily, so the server starts
// and serves this route fine with no reachable Postgres at all.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Mirrors system_backup_encryption_available()'s own preflight in db.sh: an
// AEAD archive needs gpg 2.3+, and test-api.sh deliberately mirrors CI's
// runner (Ubuntu 22.04), whose stock gpg predates that -- a graceful skip
// here matches this repo's own established answer to that gap, rather than
// failing a real-gpg test in an environment that was never going to have one.
function aeadCapableGpgAvailable() {
  try {
    return execFileSync("gpg", ["--dump-options"]).toString().split("\n").includes("--aead-algo");
  } catch {
    return false;
  }
}
const SKIP_REASON = aeadCapableGpgAvailable() ? false : "this environment's gpg cannot do authenticated (AEAD/OCB) encryption -- needs GnuPG 2.3+";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 21000 + ((process.pid + 3) % 20000);
const BASE = `http://127.0.0.1:${PORT}`;

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-system-import-http-"));
  mkdirSync(join(repoRoot, "runtime/backups/system"), { recursive: true });
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  writeFileSync(join(repoRoot, "VERSION"), "test\n");
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

// A real, small AEAD-encrypted archive -- the format check inspects the
// leading OpenPGP packet, so a fake/garbage file would be legitimately
// refused and the test would prove nothing about the success path.
function makeRealArchive(dir, passphrase) {
  const plain = join(dir, "plain.bin");
  writeFileSync(plain, Buffer.from("test payload"));
  const archive = join(dir, "upload.tar.gz.enc");
  execFileSync("gpg", [
    "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase", passphrase,
    "--s2k-digest-algo", "SHA256", "--symmetric", "--cipher-algo", "AES256",
    "--aead-algo", "OCB", "--force-aead", "-o", archive, plain
  ]);
  return archive;
}

test("POST /api/backups/system/import stores a real upload instead of throwing", { timeout: 30000, skip: SKIP_REASON }, async () => {
  const repoRoot = makeRepoRoot();
  const workDir = mkdtempSync(join(tmpdir(), "dune-system-import-fixture-"));
  const { child, ready, getOutput } = startServer(repoRoot);
  try {
    await ready;

    const archivePath = makeRealArchive(workDir, "test-passphrase-1234");
    const body = readFileSync(archivePath);
    const response = await fetch(
      `${BASE}/api/backups/system/import?filename=${encodeURIComponent("dune-system-20260830-120000-4711-9931.tar.gz.enc")}`,
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body }
    );
    const text = await response.text();

    // The bug this test exists for: a route that throws ReferenceError on
    // every call still returns *a* response (apiErrorPayload's catch-all),
    // so status alone would not distinguish it from a legitimate 4xx. The
    // decisive check is that the message names a real, expected failure --
    // never an internal reference to a missing symbol.
    assert.doesNotMatch(text, /is not defined/i, `route threw instead of running: ${text}\n--- server output ---\n${getOutput()}`);
    assert.equal(response.status, 200, `expected success, got ${response.status}: ${text}`);

    const parsed = JSON.parse(text);
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.backup, "string");
    assert.ok(existsSync(join(repoRoot, "runtime/backups/system", parsed.backup)), "the uploaded archive was not stored on disk");
    assert.ok(existsSync(join(repoRoot, "runtime/backups/system", `${parsed.backup}.yaml`)), "no sidecar was written for the upload");
  } finally {
    await stopServer(child);
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("POST /api/backups/system/import refuses a non-archive without a ReferenceError", { timeout: 30000, skip: SKIP_REASON }, async () => {
  const repoRoot = makeRepoRoot();
  const { child, ready, getOutput } = startServer(repoRoot);
  try {
    await ready;
    const response = await fetch(
      `${BASE}/api/backups/system/import?filename=${encodeURIComponent("notes.zip")}`,
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from("PKnot-an-archive") }
    );
    const text = await response.text();
    assert.doesNotMatch(text, /is not defined/i, `route threw instead of running: ${text}\n--- server output ---\n${getOutput()}`);
    assert.equal(response.status, 400);
    assert.match(text, /OpenPGP/i);
  } finally {
    await stopServer(child);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
