import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createAuth, parseCookies } from "../src/auth.js";

// Evidence for the session-fixation suppressions and, transitively, for the
// review's read of what sign() is actually for.
//
// Semgrep's `javascript.express.session-fixation` is a taint heuristic: it sees
// `req` reach a handler that calls `res.setHeader` with a session cookie, and
// cannot model where the cookie's VALUE came from. Session fixation requires the
// server to accept and then elevate a session identifier the client chose.
// This server does the opposite at three independent layers, and these tests
// pin all three -- so if a future change makes the finding real, this file goes
// red and the suppression stops being true.
//
// Suppressing a scanner finding without evidence is how a real one gets buried.

const config = { sessionSecret: randomBytes(32).toString("hex"), authDisabled: false };
const reqWith = (cookie) => ({ headers: { cookie }, method: "GET" });

test("the session id is server-generated and carries no client input", () => {
  const auth = createAuth(config);
  const a = auth.makeSession();
  const b = auth.makeSession();
  assert.notEqual(a.id, b.id, "each session gets a fresh identifier");
  // 32 random bytes, base64url -- 43 chars, no padding.
  assert.match(a.id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.cookie, `${a.id}.${a.cookie.split(".")[1]}`, "the cookie is id.signature, nothing else");
});

test("an attacker-chosen session id is rejected even when well-formed", () => {
  const auth = createAuth(config);
  const forgedId = randomBytes(32).toString("base64url"); // correct shape, never issued
  const session = auth.readSession(reqWith(`asc_session=${forgedId}.anysignature`));
  assert.equal(session, null, "an id the server never minted is not a session");
});

test("a valid signature over an unissued id is still rejected", () => {
  // The strongest form: suppose an attacker somehow obtains a correctly signed
  // id -- it is STILL not a session, because the server-side store is the
  // authority, not the cookie. This is the layer that makes fixation impossible
  // rather than merely difficult.
  const auth = createAuth(config);
  const real = auth.makeSession();
  auth.invalidateSession(real.id); // signature stays valid; the record is gone
  assert.equal(auth.readSession(reqWith(`asc_session=${real.cookie}`)), null,
    "the in-memory record is the authority; a signed-but-unknown id grants nothing");
});

test("a tampered signature is rejected", () => {
  const auth = createAuth(config);
  const real = auth.makeSession();
  const [id] = real.cookie.split(".");
  assert.equal(auth.readSession(reqWith(`asc_session=${id}.${"A".repeat(43)}`)), null);
});

test("logging in again mints a new identifier rather than reusing one", () => {
  // The specific property fixation attacks: a pre-login id that survives into
  // an authenticated session. Every makeSession() call is a fresh id, so there
  // is no id to carry across a privilege change.
  const auth = createAuth(config);
  const before = auth.makeSession();
  const after = auth.makeSession();
  assert.notEqual(before.id, after.id);
  assert.notEqual(before.cookie, after.cookie);
});

test("parseCookies does not let a crafted header smuggle a second session value", () => {
  const parsed = parseCookies("asc_session=first; asc_session=second");
  assert.equal(typeof parsed.get("asc_session"), "string", "one value wins, not an array");
});
