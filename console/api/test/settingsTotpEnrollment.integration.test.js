import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, codeFor, cookieFrom, getFreePort, login, startConsole, stopProcess, waitForHealth, secondFactorPath } from "../test-support/consoleHarness.js";

const password = "settings-enrollment-test-password";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "settings-totp-"));
  const port = await getFreePort();
  const proc = startConsole(port, root, { CONSOLE_TOTP_ENABLED: "1", ADMIN_PASSWORD: password });
  t.after(async () => { await stopProcess(proc.child); rmSync(root, { recursive: true, force: true }); });
  await waitForHealth(port, 20000, proc.logs);
  const parent = await login(port, { password });
  const enable = await api(port, "/api/auth/2fa/enable", { cookie: parent.cookie, csrf: parent.csrf, body: { currentPassword: password } });
  assert.equal(enable.status, 200);
  const body = await enable.json();
  return { root, port, parent, enrollment: { cookie: cookieFrom(enable), csrf: body.csrfToken } };
}

test("Settings enrollment confirms into a rotated authenticated session and revokes old sessions", async t => {
  const { port, parent, enrollment } = await fixture(t);
  const other = await login(port, { password });
  const setup = await (await api(port, "/api/auth/2fa/setup", enrollment)).json();
  const response = await api(port, "/api/auth/2fa/confirm", { ...enrollment, body: { code: codeFor(setup.secret) } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.authenticated, true);
  assert.equal(result.recoveryCodes.length, 10);
  const resumed = cookieFrom(response);
  assert.ok(resumed && resumed !== parent.cookie && resumed !== enrollment.cookie);
  assert.ok(result.csrfToken && result.csrfToken !== enrollment.csrf);
  for (const cookie of [parent.cookie, other.cookie, enrollment.cookie]) {
    const state = await (await api(port, "/api/auth/state", { method: "GET", cookie })).json();
    assert.equal(state.authenticated, false, "old cookies must not survive enrollment");
  }
  const me = await api(port, "/api/auth/me", { method: "GET", cookie: resumed });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).secondFactorEnrolled, true);
});

test("canceling Settings enrollment restores access without creating a factor or authorizing another setup", async t => {
  const { root, port, enrollment } = await fixture(t);
  const forged = await api(port, "/api/auth/2fa/cancel", { ...enrollment, csrf: "wrong" });
  assert.equal(forged.status, 403);
  const cancel = await api(port, "/api/auth/2fa/cancel", enrollment);
  assert.equal(cancel.status, 200);
  const resumed = { cookie: cookieFrom(cancel), csrf: (await cancel.json()).csrfToken };
  assert.equal((await api(port, "/api/auth/me", { method: "GET", cookie: resumed.cookie })).status, 200);
  assert.equal(existsSync(secondFactorPath(root)), false);
  assert.equal((await api(port, "/api/auth/2fa/setup", resumed)).status, 403);
  assert.equal((await api(port, "/api/auth/2fa/confirm", { ...enrollment, body: { code: "123456" } })).status, 403);
});

test("revoking the initiating owner prevents enrollment and cancellation from restoring access", async t => {
  const { root, port, parent, enrollment } = await fixture(t);
  assert.equal((await api(port, "/api/auth/logout", { cookie: parent.cookie, csrf: parent.csrf })).status, 200);
  assert.equal((await api(port, "/api/auth/2fa/setup", enrollment)).status, 403);
  assert.equal((await api(port, "/api/auth/2fa/cancel", enrollment)).status, 403);
  assert.equal(existsSync(secondFactorPath(root)), false);
});

test("duplicate confirmations cannot clear the successfully established cookie", async t => {
  const { port, enrollment } = await fixture(t);
  const setup = await (await api(port, "/api/auth/2fa/setup", enrollment)).json();
  const confirm = () => api(port, "/api/auth/2fa/confirm", { ...enrollment, body: { code: codeFor(setup.secret) } });
  const responses = await Promise.all([confirm(), confirm()]);
  const good = responses.find(r => r.status === 200), refused = responses.find(r => r.status !== 200);
  assert.ok(good && refused);
  assert.ok([403, 409].includes(refused.status));
  assert.equal(refused.headers.get("set-cookie"), null);
  assert.equal((await api(port, "/api/auth/me", { method: "GET", cookie: cookieFrom(good) })).status, 200);
});

test("cancel and confirm cannot both rotate the same enrollment session", async t => {
  const { port, enrollment } = await fixture(t);
  const setup = await (await api(port, "/api/auth/2fa/setup", enrollment)).json();
  const responses = await Promise.all([
    api(port, "/api/auth/2fa/cancel", enrollment),
    api(port, "/api/auth/2fa/confirm", { ...enrollment, body: { code: codeFor(setup.secret) } }),
  ]);
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  const refused = responses.find(response => response.status !== 200);
  assert.ok([403, 409].includes(refused.status));
  assert.equal(refused.headers.get("set-cookie"), null);
  const winner = responses.find(response => response.status === 200);
  assert.equal((await api(port, "/api/auth/me", { method: "GET", cookie: cookieFrom(winner) })).status, 200);
});
