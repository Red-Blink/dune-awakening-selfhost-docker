import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Wiring test for  / gate  prerequisite 3: the login rate limiter's
// key must resolve through resolveClientIp(), not a bare req.socket read.
// rateLimit.test.js unit-tests resolveClientIp() itself; this test proves it
// is actually connected to the real HTTP server and its config, over real
// sockets and headers, not just called correctly in isolation.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PASSWORD = "correct-horse-battery";
const WRONG_PASSWORD = "not-the-password";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function startConsole(port, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: { ...process.env, DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(port), ADMIN_PASSWORD: PASSWORD, ADMIN_SECURE_COOKIES: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("console did not become healthy in time");
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
}

function failLogin(port, forwardedFor) {
  const headers = { "content-type": "application/json" };
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;
  return fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ password: WRONG_PASSWORD }),
  });
}

async function failNTimes(port, forwardedFor, n) {
  let last;
  for (let i = 0; i < n; i++) last = await failLogin(port, forwardedFor);
  return last;
}

// createLoginRateLimiter's default maxAttempts is 8: check() runs BEFORE
// recordFailure() on each request, so the block only takes effect starting
// with the (maxAttempts + 1)th request -- the 8th failure itself still
// returns 401 (wrong password), and the 9th is what returns 429.
const ATTEMPTS_TO_TRIP = 9;

test("login rate limiter: CONSOLE_TRUSTED_PROXY_IPS unset -- different X-Forwarded-For values still share one bucket (no behavior change from before this fix)", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "rl-proxy-off-"));
  const consoleProc = startConsole(port, tempDir);
  try {
    await waitForHealth(port);

    // Trip the bucket declaring one forwarded IP -- keys on the real
    // 127.0.0.1 socket address regardless, since no proxy is trusted.
    const tripped = await failNTimes(port, "198.51.100.1", ATTEMPTS_TO_TRIP);
    assert.equal(tripped.status, 429, "bucket trips after enough failures from the real socket address");

    // A further attempt claiming a DIFFERENT forwarded IP is still blocked,
    // because the header is never honored -- both requests key on the same
    // 127.0.0.1 socket address. This is the pre-fix shared-bucket behavior,
    // preserved exactly for every operator who never sets the new env var.
    const next = await failLogin(port, "203.0.113.9");
    assert.equal(next.status, 429, "unconfigured: forwarded header is ignored, bucket stays shared");
  } finally {
    await stopProcess(consoleProc.child);
  }
});

test("login rate limiter: CONSOLE_TRUSTED_PROXY_IPS=127.0.0.1 -- distinct X-Forwarded-For values get independently tracked buckets", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "rl-proxy-on-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TRUSTED_PROXY_IPS: "127.0.0.1" });
  try {
    await waitForHealth(port);

    // Enough failures for forwarded client A trips A's bucket.
    const trippedA = await failNTimes(port, "198.51.100.1", ATTEMPTS_TO_TRIP);
    assert.equal(trippedA.status, 429, "forwarded client A's bucket trips on its own");

    // A single failure for a DIFFERENT forwarded client B is NOT blocked --
    // it has its own bucket now that the trusted proxy's header is honored.
    // (The shared global limiter, 32 across all keys, is nowhere near tripped
    // by 10 total failures, so this isolates the per-key behavior cleanly.)
    const firstB = await failLogin(port, "203.0.113.9");
    assert.equal(firstB.status, 401, "a different forwarded client is not penalized for client A's failures");

    // An untrusted, non-proxy peer's claim (there isn't one here -- the real
    // peer IS 127.0.0.1, the configured trusted proxy) still resolves via the
    // header once trusted; re-confirm client A is still blocked under its own
    // key rather than the fix having merged everyone into one bucket.
    const stillA = await failLogin(port, "198.51.100.1");
    assert.equal(stillA.status, 429, "client A's own bucket remains blocked independently");
  } finally {
    await stopProcess(consoleProc.child);
  }
});

test("login rate limiter: CONSOLE_TRUSTED_PROXY_IPS=127.0.0.1 -- a request with no X-Forwarded-For falls back to the socket address safely", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "rl-proxy-nohdr-"));
  const consoleProc = startConsole(port, tempDir, { CONSOLE_TRUSTED_PROXY_IPS: "127.0.0.1" });
  try {
    await waitForHealth(port);
    const tripped = await failNTimes(port, undefined, ATTEMPTS_TO_TRIP);
    assert.equal(tripped.status, 429, "no forwarded header: still blocks, keyed on the real socket address");
  } finally {
    await stopProcess(consoleProc.child);
  }
});
