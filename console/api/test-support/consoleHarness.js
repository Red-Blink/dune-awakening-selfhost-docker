import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { base32Decode, totpCode, TOTP_PERIOD_SECONDS, TOTP_DEFAULT_WINDOW } from "../src/auth/totp.js";

// Shared console-boot harness for the auth integration tests.
//
// Extracted rather than copied again. Before this, the same ~100
// lines lived in up to nine files: getFreePort in 9, waitForHealth in 9,
// stopProcess in 9, startConsole in 8, cookieFrom/api/codeFor in 6 each. That
// is not merely repetitive -- it had ALREADY drifted, in the PR whose own
// comment argued the copies were equivalent enough to defer: passwordRotation's
// `login(port, password)` takes a bare string while recoveryCodesRegenerate's
// `login(port, body)` takes an object. Same name, same directory, incompatible
// signature, and neither importable, so a reader moving between them gets a
// confusing 401 rather than a type error.
//
// `node --test` does not collect this directory (it is not named `test` and
// these are not `*.test.js`), matching the precedent set by
// baseContainerFixture.js and pgIntegrationDb.js.
//
// The exported `login` takes an OBJECT, which is the superset form -- callers
// that used to pass a bare password pass `{ password }`.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// Spawns a console against an isolated DUNE_DOCKER_DIR. `logs()` returns
// everything the child wrote -- surface it in assertion messages when a boot or
// a request fails, otherwise the child's real error (EADDRINUSE, a config stack
// trace) is deleted along with the temp dir and the failure is undiagnosable.
export function startConsole(port, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: { ...process.env, DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(port), ADMIN_SECURE_COOKIES: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

export async function waitForHealth(port, timeoutMs = 20000, logs = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Include the child's own output: without it this throw says only that the
  // console did not start, never why.
  throw new Error(`console did not become healthy within ${timeoutMs}ms. Console output:\n${logs()}`);
}

export async function stopProcess(child) {
  // exitCode stays null when a child is reaped by a signal, so signalCode has to
  // be checked too -- otherwise the `once("exit")` below never fires again and
  // every such teardown pays the full timeout.
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  let timer;
  const exited = new Promise((r) => child.once("exit", r));
  const timedOut = new Promise((r) => { timer = setTimeout(() => r("timeout"), 5000); });
  const result = await Promise.race([exited, timedOut]);
  clearTimeout(timer); // Promise.race does not cancel the loser; an uncleared
                       // timer keeps the event loop alive after the suite ends.
  if (result === "timeout") {
    // Resolving while the child still runs lets the caller's rmSync delete the
    // live server's data directory out from under it. Escalate instead.
    child.kill("SIGKILL");
    await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 2000))]);
  }
}

// Waits for a pattern to appear in a console's captured output.
//
// Asserting on logs() immediately after waitForHealth is a race: /api/health
// answering does not mean every startup line has been written and delivered to
// the parent's stdout `data` handler. It passes on an idle machine and fails
// under load, which is exactly the intermittent failure this replaces -- one
// full-suite run in three, once the auth tests started running concurrently.
export async function waitForLog(logs, pattern, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(logs())) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export function cookieFrom(res, name = "asc_session") {
  const entry = (res.headers.getSetCookie() || []).find((v) => v.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

export function api(port, path, { method = "POST", cookie, csrf, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = `asc_session=${cookie}`;
  if (csrf) headers["x-csrf-token"] = csrf;
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
}

export async function login(port, body) {
  const res = await api(port, "/api/auth/login", { body });
  const parsed = await res.json();
  return { status: res.status, cookie: cookieFrom(res), csrf: parsed.csrfToken, body: parsed };
}

// ---- runtime paths (single source, so a relocation breaks one file not five) ----

export const generatedPath = (tempDir, name) => join(tempDir, "runtime", "generated", name);
export const secondFactorPath = (tempDir) => generatedPath(tempDir, "console-second-factor.json");
export const watermarkPath = (tempDir) => generatedPath(tempDir, "console-second-factor.json.watermark");
export const auditLogPath = (tempDir) => generatedPath(tempDir, "web-admin-audit.jsonl");
export const readGeneratedPassword = (tempDir) =>
  readFileSync(join(tempDir, "runtime", "secrets", "admin-web-password.txt"), "utf8").trim();

// ---- TOTP timing ----

export function codeFor(secretBase32, offsetSteps = 0) {
  return totpCode(base32Decode(secretBase32), Math.floor(Date.now() / 1000) + offsetSteps * TOTP_PERIOD_SECONDS);
}

export function currentTotpStep(period = TOTP_PERIOD_SECONDS) {
  return Math.floor(Date.now() / 1000 / period);
}

// A code for an ABSOLUTE step, rather than an offset from "now". The offset form
// is racy for look-ahead: `codeFor(secret, 1)` reads the clock at call time, so
// if a boundary falls between computing and sending, it lands two steps out and
// is rejected.
export function codeForStep(secretBase32, step, period = TOTP_PERIOD_SECONDS) {
  return totpCode(base32Decode(secretBase32), step * period);
}

// The next TOTP code the server will accept after `consumedStep`, waiting only
// when it genuinely must.
//
// This is where the suite's wall clock went. Every test used to pair a
// full `waitForStepAfter` with `codeFor(secret, 0)` -- a real 30s sleep before
// each TOTP action -- when one step of look-ahead is free: verifyTotpMatch scans
// centre-1..centre+1 (TOTP_DEFAULT_WINDOW), so a code for step S+1 is accepted
// while the clock is still in S and advances lastUsedCounter to S+1.
//
// Target = max(consumedStep + 1, now), which is always strictly after the
// consumed step AND always inside the window (it is either `now` or `now + 1`).
// A wait is needed only when the consumed step is already at the top of the
// window, i.e. the look-ahead was spent on the previous action.
//
// Returns the step it consumes so callers can chain without re-reading the
// clock -- reading it back is the bug that produced the original flake.
export async function nextTotpCode(secretBase32, consumedStep) {
  let target = Math.max(consumedStep + 1, currentTotpStep());
  if (target > currentTotpStep() + TOTP_DEFAULT_WINDOW) {
    await waitForStepAfter(consumedStep);
    target = currentTotpStep();
  }
  return { code: codeForStep(secretBase32, target), step: target };
}

// Waits until wall-clock time has genuinely passed `step`. A fixed sleep is racy
// under CPU contention: a delayed wake-up can land a freshly-computed code on an
// already-consumed step (this was a real, intermittent CI failure).
//
// Bounded, unlike the version this replaces: an unbounded `while` spins forever
// if the host clock steps backwards (an NTP correction or a VM resume, both
// realistic on this project's Proxmox guests), and `node --test` applies no
// default per-test timeout -- so the run hangs with no failing test name, which
// is exactly the "the name was lost" symptom reported for an earlier flake.
export async function waitForStepAfter(step, { timeoutMs = 5 * TOTP_PERIOD_SECONDS * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (currentTotpStep() <= step) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitForStepAfter(${step}) exceeded ${timeoutMs}ms (now at step ${currentTotpStep()}). ` +
        "The host clock most likely moved backwards."
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Enrol a second factor. Returns the step the CONFIRM actually consumed --
// captured from the code that was sent, not from a separate Date.now() read.
//
// That distinction is the fix for a real flake: the old helper did
// `const step = currentTotpStep()` and then computed the code on the next line.
// If a 30s boundary fell between those two reads, the confirm consumed step+1
// while the helper returned step, so the caller's waitForStepAfter(step)
// returned instantly and handed back a code for a step the server had already
// spent -- surfacing as `AssertionError: undefined !== true` with no hint that
// a clock boundary was involved.
export async function enroll(port, tempDir, { assert }) {
  const password = readGeneratedPassword(tempDir);
  // TOTP is opt-in (issue #665): a plain login with no factor configured is now
  // a normal, fully-authenticated session, never a forced enrollment one.
  // Enrollment is owner-initiated via POST /api/auth/2fa/enable, which mints
  // the same enroll-scope session the old forced path used to mint automatically.
  const normal = await login(port, { password });
  assert.equal(normal.body.authenticated, true, "plain password login succeeds with no factor configured");
  const enableRes = await api(port, "/api/auth/2fa/enable", { cookie: normal.cookie, csrf: normal.csrf, body: { currentPassword: password } });
  const enableBody = await enableRes.json();
  assert.equal(enableBody.enrollmentRequired, true, "POST /api/auth/2fa/enable yields an enrollment session");
  const first = { cookie: cookieFrom(enableRes), csrf: enableBody.csrfToken, body: enableBody };
  const setup = await (await api(port, "/api/auth/2fa/setup", { cookie: first.cookie, csrf: first.csrf })).json();

  const code = codeFor(setup.secret, 0);
  // Read AFTER the code, never before. The server consumes the step the CODE
  // encodes (verifyTotpMatch returns the matched counter, not its own centre),
  // so reading the clock later can only yield a step >= that one -- at worst an
  // over-wait, never an under-wait. The old order could yield a step BELOW the
  // consumed one, which is what let a caller replay an already-spent code.
  const step = currentTotpStep();
  const confirmRes = await api(port, "/api/auth/2fa/confirm", { cookie: first.cookie, csrf: first.csrf, body: { code } });
  assert.equal(confirmRes.status, 200);
  const confirmed = await confirmRes.json();
  assert.equal(confirmed.recoveryCodes.length, 10);
  return { password, secret: setup.secret, enrollmentCodes: confirmed.recoveryCodes, enrollSession: first, step };
}
