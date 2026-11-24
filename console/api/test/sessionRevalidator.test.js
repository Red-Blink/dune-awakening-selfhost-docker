import test from "node:test";
import assert from "node:assert/strict";
import { createSessionRevalidator } from "../src/integrations/discord/sessionRevalidator.js";

function rig({ identity = async () => ({ userId: "u1" }), tier = async () => ({ tier: "admin", source: "roles" }) } = {}) {
  let clock = 1_000_000;
  const sessions = new Map([["s1", { id: "s1", userId: "u1", tier: "admin", scope: null }]]);
  const events = [];
  const auth = {
    listSessions: () => [...sessions.values()],
    invalidateSession: (id) => sessions.delete(id),
    setSessionTier: (id, t) => { const s = sessions.get(id); if (!s || s.tier === t) return false; s.tier = t; return true; }
  };
  const r = { fetchIdentity: identity, resolveTier: tier };
  const rev = createSessionRevalidator({
    auth, fetchIdentity: (t) => r.fetchIdentity(t), resolveTier: (i) => r.resolveTier(i), intervalMs: 30000,
    now: () => clock, audit: (e, d) => events.push([e, d.reason || d.to])
  });
  rev.remember("s1", "tok");
  return { rev, sessions, events, r, advance: (ms) => { clock += ms; } };
}

test("an unchanged session survives sweeps", async () => {
  const { rev, sessions } = rig();
  await rev.sweep(); await rev.sweep();
  assert.ok(sessions.has("s1"));
});

test("a removed role (no tier) revokes on the second consecutive sweep, not the first", async () => {
  const { rev, sessions, r, events } = rig();
  r.resolveTier = async () => ({ tier: "", source: "roles", reason: "not_authorized" });
  await rev.sweep();
  assert.ok(sessions.has("s1"), "one denial can be a Discord blip");
  await rev.sweep();
  assert.ok(!sessions.has("s1"));
  assert.deepEqual(events.at(-1), ["auth.session.revoked", "not_authorized"]);
});

test("a single blip followed by recovery resets the strike", async () => {
  const { rev, sessions, r } = rig();
  r.resolveTier = async () => ({ tier: "", reason: "x" });
  await rev.sweep();
  r.resolveTier = async () => ({ tier: "admin" });
  await rev.sweep();
  r.resolveTier = async () => ({ tier: "", reason: "x" });
  await rev.sweep();
  assert.ok(sessions.has("s1"));
});

test("a demotion applies immediately", async () => {
  const { rev, sessions, r } = rig();
  r.resolveTier = async () => ({ tier: "player" });
  await rev.sweep();
  assert.equal(sessions.get("s1").tier, "player");
});

test("a revoked Discord token (401/403/404) revokes at once", async () => {
  for (const code of [401, 403, 404]) {
    const { rev, sessions, r } = rig();
    r.fetchIdentity = async () => { throw Object.assign(new Error("x"), { upstreamStatus: code }); };
    await rev.sweep();
    assert.ok(!sessions.has("s1"), String(code));
  }
});

test("Discord down keeps the session within the grace window, then revokes", async () => {
  const { rev, sessions, r, advance } = rig();
  r.fetchIdentity = async () => { throw Object.assign(new Error("net"), { upstreamStatus: 503 }); };
  await rev.sweep();
  assert.ok(sessions.has("s1"));
  advance(4 * 60 * 1000); await rev.sweep();
  assert.ok(sessions.has("s1"));
  advance(2 * 60 * 1000); await rev.sweep();
  assert.ok(!sessions.has("s1"), "an outage must not let a removed user ride it out forever");
});

test("handoff 'unreachable' is transient; an explicit handoff deny is not", async () => {
  const a = rig();
  a.r.resolveTier = async () => ({ tier: "", source: "handoff", reason: "unreachable" });
  await a.rev.sweep(); await a.rev.sweep(); await a.rev.sweep();
  assert.ok(a.sessions.has("s1"));
  const b = rig();
  b.r.resolveTier = async () => ({ tier: "", source: "handoff", reason: "denied" });
  await b.rev.sweep(); await b.rev.sweep();
  assert.ok(!b.sessions.has("s1"));
});

test("a session with no token held (e.g. persisted across a restart) is revoked: fail closed", async () => {
  const { rev, sessions } = rig();
  rev._tokens.clear();
  await rev.sweep();
  assert.ok(!sessions.has("s1"));
});

test("password/enrollment sessions (no userId or a scope) are never touched", async () => {
  const { rev, sessions } = rig();
  sessions.set("pw", { id: "pw", userId: "", tier: "owner", scope: null });
  sessions.set("en", { id: "en", userId: "u2", tier: "enroll", scope: "enroll" });
  await rev.sweep();
  assert.ok(sessions.has("pw") && sessions.has("en"));
});

test("tokens for ended sessions are dropped", async () => {
  const { rev, sessions } = rig();
  sessions.delete("s1");
  await rev.sweep();
  assert.equal(rev._tokens.size, 0);
});
