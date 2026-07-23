// Actor signature verification — closes FINDING-LINK-1 from
// docs/security/discord-player-link-hardening.md.
//
// Problem: normalizeDiscordActor() (policy.js) trusts actor.userId,
// actor.roleIds, actor.guildId, etc. verbatim from the request body. The
// only prior gate on the whole adapter was a single shared bearer token
// (requireDiscordBotToken) that authenticates the bot *process*, not the
// specific Discord user or interaction — a confused-deputy trust boundary.
// Anyone holding the bearer token could claim any userId/roleIds.
//
// Fix: an HMAC-SHA256 signature over the actor object's own fields, using a
// second shared secret distinct from the transport bearer token, plus a
// short freshness window to prevent replay. This binds the actor claims to
// something only a party holding DUNE_DISCORD_ACTOR_SECRET could produce.
//
// Backward compatibility: verification is opt-in. When
// DUNE_DISCORD_ACTOR_SECRET is not configured, actor signatures are not
// required and this module is a no-op, preserving the exact pre-existing
// behavior for deployments that have not yet configured a bot capable of
// signing. This lets the console ship verification ahead of any bot-side
// signing support. A future release train should remove the fallback and
// make signing mandatory once the ecosystem has migrated (tracked in
// docs/security/discord-player-link-hardening.md, FINDING-LINK-1).

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { policyError } from "./policy.js";

const DEFAULT_MAX_SKEW_SECONDS = 30;
const SIGNATURE_HEADER = "x-dune-actor-signature";
const TIMESTAMP_HEADER = "x-dune-actor-timestamp";

// Fields covered by the signature. Order is fixed so the bot and console
// compute byte-identical canonical strings; unknown/extra actor fields are
// intentionally excluded so adding a new non-authorizing field to the actor
// payload later does not silently invalidate every existing signature.
const SIGNED_ACTOR_FIELDS = ["userId", "guildId", "channelId", "roleIds", "interactionId"];

export function actorSignatureSecret(config = {}) {
  const direct = process.env.DUNE_DISCORD_ACTOR_SECRET || config.discordActorSecret || "";
  if (direct) return String(direct).trim();
  const file = process.env.DUNE_DISCORD_ACTOR_SECRET_FILE || config.discordActorSecretFile || "";
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export function actorSignatureRequired(config = {}) {
  return Boolean(actorSignatureSecret(config));
}

// Deterministic string the bot and console must both compute identically.
// roleIds is sorted so role-array ordering differences never break a
// signature that is otherwise for the same actor.
//
// `route` binds the signature to the specific adapter route path (e.g.
// "/api/integrations/discord/players/link"). Without this, a signature
// covering only actor identity fields can be captured from one legitimate
// request (e.g. a routine "status" call, which requires no special
// privilege to observe) and replayed verbatim — with an attacker-chosen
// request body — against ANY OTHER route within the freshness window,
// including PLAYERS_LINK or BROADCAST, as long as the actor still qualifies
// for that route's capability. Binding the route closes that gap: a
// captured envelope only verifies against the exact route it was issued
// for. This does not fully eliminate replay (a captured envelope can still
// be resent verbatim to the SAME route with the SAME body within the skew
// window — see FINDING-LINK-1's Known Limitations for why a full nonce/
// one-time-use scheme was not implemented here), but it eliminates
// cross-route and cross-body-parameter forgery using a captured envelope.
export function canonicalActorSignaturePayload(actorPayload = {}, timestamp, route = "") {
  const fields = {};
  for (const key of SIGNED_ACTOR_FIELDS) {
    const value = actorPayload?.[key];
    fields[key] = Array.isArray(value) ? [...value].map(String).sort() : String(value ?? "");
  }
  return `${timestamp}.${String(route)}.${JSON.stringify(fields)}`;
}

export function signActorPayload(actorPayload, secret, timestamp = Math.floor(Date.now() / 1000), route = "") {
  const message = canonicalActorSignaturePayload(actorPayload, timestamp, route);
  const signature = createHmac("sha256", String(secret)).update(message).digest("hex");
  return { signature, timestamp };
}

function constantTimeHexEqual(a, b) {
  const bufferA = Buffer.from(String(a || ""), "hex");
  const bufferB = Buffer.from(String(b || ""), "hex");
  if (bufferA.length === 0 || bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

// Verifies actor authenticity when DUNE_DISCORD_ACTOR_SECRET is configured.
// Throws a policyError (403) on a missing/invalid/stale signature. No-ops
// when no secret is configured (see module header for the compatibility
// rationale) — callers should still log/monitor this state to track
// migration progress toward mandatory signing.
//
// `route` must be the exact adapter route path the request was made to
// (see canonicalActorSignaturePayload() for why). Passing a route lets a
// captured signed envelope be rejected when replayed against a different
// route than the one it was issued for.
export function verifyActorSignature({ actorPayload, headers, config, route = "", now = Math.floor(Date.now() / 1000) }) {
  const secret = actorSignatureSecret(config);
  if (!secret) return { verified: false, required: false };

  const signature = String(headers?.[SIGNATURE_HEADER] || "").trim();
  const timestampRaw = String(headers?.[TIMESTAMP_HEADER] || "").trim();
  if (!signature || !timestampRaw) {
    throw policyError("missing_actor_signature", "Discord actor signature is required but was not provided.", 403);
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw policyError("invalid_actor_signature", "Discord actor signature timestamp is invalid.", 403);
  }

  const maxSkewSeconds = Number(process.env.DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS) || DEFAULT_MAX_SKEW_SECONDS;
  if (Math.abs(now - timestamp) > maxSkewSeconds) {
    throw policyError("stale_actor_signature", "Discord actor signature has expired. Retry the command.", 403);
  }

  const expected = signActorPayload(actorPayload, secret, timestamp, route).signature;
  if (!constantTimeHexEqual(signature, expected)) {
    throw policyError("invalid_actor_signature", "Discord actor signature does not match the expected value.", 403);
  }

  return { verified: true, required: true };
}

export const ACTOR_SIGNATURE_HEADER = SIGNATURE_HEADER;
export const ACTOR_TIMESTAMP_HEADER = TIMESTAMP_HEADER;
