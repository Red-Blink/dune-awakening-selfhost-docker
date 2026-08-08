import assert from "node:assert/strict";
import test from "node:test";
import {
  actorSignatureRequired,
  actorSignatureSecret,
  canonicalActorSignaturePayload,
  signActorPayload,
  verifyActorSignature,
  ACTOR_SIGNATURE_HEADER,
  ACTOR_TIMESTAMP_HEADER
} from "../src/integrations/discord/actorSignature.js";

const OLD_ENV = { ...process.env };

test.beforeEach(() => {
  delete process.env.DUNE_DISCORD_ACTOR_SECRET;
  delete process.env.DUNE_DISCORD_ACTOR_SECRET_FILE;
  delete process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS;
});

test.after(() => {
  process.env = OLD_ENV;
});

function actor(overrides = {}) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    username: "tester",
    roleIds: ["role-observer"],
    interactionId: "interaction-1",
    commandName: "/dune status",
    ...overrides
  };
}

function headersFor(actorPayload, secret, { timestamp = Math.floor(Date.now() / 1000), signature, route = "" } = {}) {
  const signed = signature ?? signActorPayload(actorPayload, secret, timestamp, route).signature;
  return {
    [ACTOR_SIGNATURE_HEADER]: signed,
    [ACTOR_TIMESTAMP_HEADER]: String(timestamp)
  };
}

test("actorSignatureRequired is false when no secret is configured (backward compatibility)", () => {
  assert.equal(actorSignatureRequired({}), false);
});

test("actorSignatureSecret reads DUNE_DISCORD_ACTOR_SECRET from the environment", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "  test-secret  ";
  assert.equal(actorSignatureSecret({}), "test-secret");
});

test("verifyActorSignature no-ops when no secret is configured", () => {
  const result = verifyActorSignature({ actorPayload: actor(), headers: {}, config: {} });
  assert.deepEqual(result, { verified: false, required: false });
});

test("verifyActorSignature accepts a correctly signed, fresh actor payload", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  const now = Math.floor(Date.now() / 1000);
  const a = actor();
  const headers = headersFor(a, "shared-secret", { timestamp: now });
  const result = verifyActorSignature({ actorPayload: a, headers, config: {}, now });
  assert.deepEqual(result, { verified: true, required: true });
});

test("verifyActorSignature rejects a missing signature header when a secret is configured", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  assert.throws(
    () => verifyActorSignature({ actorPayload: actor(), headers: {}, config: {} }),
    (error) => error.code === "missing_actor_signature" && error.statusCode === 403
  );
});

test("verifyActorSignature rejects a missing timestamp header", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  const a = actor();
  const { signature } = signActorPayload(a, "shared-secret", Math.floor(Date.now() / 1000));
  assert.throws(
    () => verifyActorSignature({ actorPayload: a, headers: { [ACTOR_SIGNATURE_HEADER]: signature }, config: {} }),
    (error) => error.code === "missing_actor_signature"
  );
});

test("verifyActorSignature rejects a tampered userId (spoofed actor identity)", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  const now = Math.floor(Date.now() / 1000);
  const signed = actor({ userId: "victim-user" });
  const headers = headersFor(signed, "shared-secret", { timestamp: now });
  // Attacker changes userId after the signature was computed for a
  // different actor, attempting to impersonate "victim-user" using a
  // signature that was never produced for this payload.
  const tampered = { ...signed, userId: "attacker-user" };
  assert.throws(
    () => verifyActorSignature({ actorPayload: tampered, headers, config: {}, now }),
    (error) => error.code === "invalid_actor_signature"
  );
});

test("verifyActorSignature rejects a tampered roleIds (privilege escalation attempt)", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  const now = Math.floor(Date.now() / 1000);
  const signed = actor({ roleIds: ["role-observer"] });
  const headers = headersFor(signed, "shared-secret", { timestamp: now });
  const tampered = { ...signed, roleIds: ["role-owner"] };
  assert.throws(
    () => verifyActorSignature({ actorPayload: tampered, headers, config: {}, now }),
    (error) => error.code === "invalid_actor_signature"
  );
});

test("verifyActorSignature rejects a signature produced with the wrong secret", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "correct-secret";
  const now = Math.floor(Date.now() / 1000);
  const a = actor();
  const headers = headersFor(a, "wrong-secret", { timestamp: now });
  assert.throws(
    () => verifyActorSignature({ actorPayload: a, headers, config: {}, now }),
    (error) => error.code === "invalid_actor_signature"
  );
});

test("verifyActorSignature rejects a stale timestamp beyond the max skew window", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  const now = Math.floor(Date.now() / 1000);
  const staleTimestamp = now - 120; // default max skew is 30s
  const a = actor();
  const headers = headersFor(a, "shared-secret", { timestamp: staleTimestamp });
  assert.throws(
    () => verifyActorSignature({ actorPayload: a, headers, config: {}, now }),
    (error) => error.code === "stale_actor_signature"
  );
});

test("verifyActorSignature rejects a future-dated timestamp beyond the max skew window", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  const now = Math.floor(Date.now() / 1000);
  const futureTimestamp = now + 120;
  const a = actor();
  const headers = headersFor(a, "shared-secret", { timestamp: futureTimestamp });
  assert.throws(
    () => verifyActorSignature({ actorPayload: a, headers, config: {}, now }),
    (error) => error.code === "stale_actor_signature"
  );
});

test("verifyActorSignature respects DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS override", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS = "5";
  const now = Math.floor(Date.now() / 1000);
  const a = actor();
  const headers = headersFor(a, "shared-secret", { timestamp: now - 10 });
  assert.throws(
    () => verifyActorSignature({ actorPayload: a, headers, config: {}, now }),
    (error) => error.code === "stale_actor_signature"
  );
});

test("verifyActorSignature rejects a non-numeric timestamp", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  assert.throws(
    () => verifyActorSignature({
      actorPayload: actor(),
      headers: { [ACTOR_SIGNATURE_HEADER]: "deadbeef", [ACTOR_TIMESTAMP_HEADER]: "not-a-number" },
      config: {}
    }),
    (error) => error.code === "invalid_actor_signature"
  );
});

test("canonicalActorSignaturePayload sorts roleIds so array order does not affect the signature", () => {
  const a1 = canonicalActorSignaturePayload(actor({ roleIds: ["role-b", "role-a"] }), 1000);
  const a2 = canonicalActorSignaturePayload(actor({ roleIds: ["role-a", "role-b"] }), 1000);
  assert.equal(a1, a2);
});

test("canonicalActorSignaturePayload excludes unsigned fields like username and commandName", () => {
  const withExtra = canonicalActorSignaturePayload(actor({ username: "alice" }), 1000);
  const withoutExtra = canonicalActorSignaturePayload(actor({ username: "bob" }), 1000);
  assert.equal(withExtra, withoutExtra);
});

// Route binding hardens FINDING-LINK-1 further: without it, a signature
// covering only actor identity fields can be captured from one legitimate
// request (e.g. a routine, low-privilege "status" call) and replayed
// verbatim — with an attacker-chosen request body — against ANY OTHER
// route within the freshness window, including write routes like
// players/link or broadcast, as long as the actor still qualifies for that
// route's capability.
test("canonicalActorSignaturePayload differs for the same actor/timestamp when the route differs", () => {
  const a = actor();
  const statusPayload = canonicalActorSignaturePayload(a, 1000, "/api/integrations/discord/status");
  const readinessPayload = canonicalActorSignaturePayload(a, 1000, "/api/integrations/discord/readiness");
  assert.notEqual(statusPayload, readinessPayload);
});

test("verifyActorSignature rejects a signature valid for one route when checked against a different route", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  const now = Math.floor(Date.now() / 1000);
  const a = actor();
  const headers = headersFor(a, "shared-secret", { timestamp: now, route: "/api/integrations/discord/status" });

  // Same actor, same signature, same timestamp, still within the skew
  // window — but verified against a different route than it was signed for.
  assert.throws(
    () => verifyActorSignature({ actorPayload: a, headers, config: {}, now, route: "/api/integrations/discord/players/link" }),
    (error) => error.code === "invalid_actor_signature"
  );

  // The same signature must still succeed against the route it was
  // actually issued for.
  assert.doesNotThrow(
    () => verifyActorSignature({ actorPayload: a, headers, config: {}, now, route: "/api/integrations/discord/status" })
  );
});

test("verifyActorSignature defaults to an empty route when none is passed, on both sign and verify sides", () => {
  process.env.DUNE_DISCORD_ACTOR_SECRET = "shared-secret";
  const now = Math.floor(Date.now() / 1000);
  const a = actor();
  const { signature } = signActorPayload(a, "shared-secret", now);
  const headers = { [ACTOR_SIGNATURE_HEADER]: signature, [ACTOR_TIMESTAMP_HEADER]: String(now) };
  assert.doesNotThrow(() => verifyActorSignature({ actorPayload: a, headers, config: {}, now }));
});

test("signActorPayload defaults to the current time when no timestamp is supplied", () => {
  const before = Math.floor(Date.now() / 1000);
  const { timestamp } = signActorPayload(actor(), "secret");
  const after = Math.floor(Date.now() / 1000);
  assert.ok(timestamp >= before && timestamp <= after);
});

test("actorSignatureSecret reads from a secret file when the direct env var is unset", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dune-actor-secret-"));
  const file = join(dir, "secret.txt");
  writeFileSync(file, "file-secret\n");
  process.env.DUNE_DISCORD_ACTOR_SECRET_FILE = file;
  assert.equal(actorSignatureSecret({}), "file-secret");
});
