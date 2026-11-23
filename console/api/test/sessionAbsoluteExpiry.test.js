import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../src/auth.js";

// #1355: a Discord-derived session has an ABSOLUTE expiry that activity cannot extend,
// so a removed role / departed guild member loses access within the cap.

function harness(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "abs-expiry-"));
  let clock = 1_000_000;
  const config = { now: () => clock, sessionSecret: "s".repeat(32), adminPassword: "pw", sessionStoreFile: join(dir, "sessions.json"), discordSessionMaxAgeMs: 60 * 60 * 1000, ...extra };
  const auth = createAuth(config);
  const req = (s) => ({ headers: { cookie: `asc_session=${s.cookie}` } });
  return { auth, req, advance: (ms) => { clock += ms; }, dir, config, now: () => clock };
}

test("a Discord session is cut off at the absolute cap even while continuously active", () => {
  const h = harness();
  try {
    const s = h.auth.makeSession({ tier: "admin", userId: "u1", username: "n", guildId: "g" });
    for (let i = 0; i < 5; i += 1) { h.advance(10 * 60 * 1000); assert.ok(h.auth.readSession(h.req(s)), `still valid at +${(i + 1) * 10}m`); }
    h.advance(11 * 60 * 1000); // 61 minutes after sign-in, with activity every 10 minutes
    assert.equal(h.auth.readSession(h.req(s)), null, "activity must not extend past the absolute cap");
    assert.equal(h.auth.readSessionById(s.id), null);
    assert.equal(h.auth.peekSession(h.req(s)), null);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("a console-password session (no Discord user) keeps the sliding idle expiry only", () => {
  const h = harness();
  try {
    const s = h.auth.makeSession({});
    for (let i = 0; i < 10; i += 1) { h.advance(30 * 60 * 1000); assert.ok(h.auth.readSession(h.req(s)), "owner password session must be unaffected"); }
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("the cap can be disabled with 0", () => {
  const h = harness({ discordSessionMaxAgeMs: 0 });
  try {
    const s = h.auth.makeSession({ tier: "admin", userId: "u1" });
    for (let i = 0; i < 6; i += 1) { h.advance(30 * 60 * 1000); assert.ok(h.auth.readSession(h.req(s))); }
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("the absolute expiry survives a restart and cannot be stripped from the store", async () => {
  const h = harness();
  try {
    const s = h.auth.makeSession({ tier: "admin", userId: "u1", username: "n", guildId: "g" });
    const { readFileSync, writeFileSync } = await import("node:fs");
    const stored = JSON.parse(readFileSync(h.config.sessionStoreFile, "utf8"));
    assert.ok(stored.sessions[0].absoluteExpiresAt, "persisted with its cap");
    const restarted = createAuth(h.config);
    assert.ok(restarted.readSession(h.req(s)), "valid after restart within the cap");
    h.advance(61 * 60 * 1000);
    assert.equal(createAuth(h.config).readSession(h.req(s)), null, "expired by the cap after restart");
    // tamper: remove the cap from the file -- the MAC (and the missing-cap rule) must reject it
    const fresh = harness();
    try {
      const t = fresh.auth.makeSession({ tier: "admin", userId: "u2" });
      const doc = JSON.parse(readFileSync(fresh.config.sessionStoreFile, "utf8"));
      delete doc.sessions[0].absoluteExpiresAt;
      writeFileSync(fresh.config.sessionStoreFile, JSON.stringify(doc));
      assert.equal(createAuth(fresh.config).readSession(fresh.req(t)), null, "a Discord session stripped of its cap must be dropped");
    } finally { rmSync(fresh.dir, { recursive: true, force: true }); }
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});
