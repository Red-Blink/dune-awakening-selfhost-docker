// Tier 3 recovery codes (console layered auth, RFC docs/rfc-console-auth.md
// §2.3). Ten single-use, server-generated 128-bit random bearer tokens that
// substitute for the TOTP factor when an operator has lost their authenticator.
//
// These are high-entropy tokens, NOT user-chosen passwords, so the store keeps
// SHA-256(domain-separator || token-bytes) rather than a password KDF: a stolen
// digest still requires an infeasible 2^128 preimage search, while verification
// is one cheap hash instead of a memory-hard KDF. The digest is compared with
// timingSafeEqual over the unused set (never a plain Set lookup, which is not
// constant-time and must not be described as one).
//
// Display encoding (so two implementations produce interchangeable codes and an
// operator can transcribe one by hand):
//   - 16 random bytes, lowercase hex (32 chars), shown in 8 dash-separated
//     groups of 4, followed by a 2-char checksum.
//   - Checksum = first byte of SHA-256(token-bytes), lowercase hex. It catches
//     transcription errors and is verifiable offline (client-side, before an
//     attempt is spent); it is NEVER part of the stored/compared digest.
//   - Input parsing is case-insensitive and strips dashes/whitespace.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_TOKEN_BYTES = 16; // 128-bit
export const RECOVERY_DOMAIN_SEPARATOR = "dune-console-recovery-v1:";

const DIGEST_HEX_RE = /^[0-9a-f]{64}$/; // SHA-256 hex

// ---- Encoding / checksum ----

function checksumHex(tokenBytes) {
  return createHash("sha256").update(tokenBytes).digest("hex").slice(0, 2);
}

function groupHex(hex32) {
  return hex32.match(/.{1,4}/g).join("-");
}

// Format a raw 16-byte token as the operator-facing string (grouped hex + "-" +
// 2-char checksum), e.g. "3f9a-1c04-...-b2e1-a7".
export function formatRecoveryCode(tokenBytes) {
  const hex = Buffer.from(tokenBytes).toString("hex");
  return `${groupHex(hex)}-${checksumHex(tokenBytes)}`;
}

// Normalize operator input to { hex, checksum } or null if it is not shaped
// like a recovery code at all (wrong length, non-hex). Case-insensitive;
// dashes and whitespace are ignored.
export function parseRecoveryCode(input) {
  if (typeof input !== "string") return null;
  // A real code is 34 hex chars; even with generous dash/space padding it is
  // never long. Cap before the O(n) replace so a multi-megabyte body can't
  // burn scan/alloc time on this path (bounded anyway by the HTTP body limit
  // and login limiter, but the primitive shouldn't rely on that).
  if (input.length > 256) return null;
  const cleaned = input.replace(/[\s-]/g, "").toLowerCase();
  // 32 hex token chars + 2 hex checksum chars.
  if (!/^[0-9a-f]{34}$/.test(cleaned)) return null;
  return { hex: cleaned.slice(0, 32), checksum: cleaned.slice(32, 34) };
}

// True if the input parses AND its checksum matches its token bytes. This is the
// offline transcription-error check; it is deliberately usable client-side so a
// mistyped code can be rejected before it costs a rate-limited attempt. It says
// nothing about whether the code is a real, unused recovery code.
export function isChecksumValid(input) {
  const parsed = parseRecoveryCode(input);
  if (!parsed) return false;
  const tokenBytes = Buffer.from(parsed.hex, "hex");
  return checksumHex(tokenBytes) === parsed.checksum;
}

// ---- Hashing ----

// Domain-separated SHA-256 digest of the raw token bytes. The stored form.
export function hashRecoveryToken(tokenBytes) {
  return createHash("sha256")
    .update(RECOVERY_DOMAIN_SEPARATOR)
    .update(Buffer.from(tokenBytes))
    .digest("hex");
}

// Digest of an operator-entered code string, or null if it is not a
// checksum-valid recovery code. The checksum is validated first (and is not part
// of the digest input) so malformed input never reaches the hash/compare path.
export function digestFromInput(input) {
  if (!isChecksumValid(input)) return null;
  const { hex } = parseRecoveryCode(input);
  return hashRecoveryToken(Buffer.from(hex, "hex"));
}

// ---- Generation ----

// Generate a fresh set: the operator-facing code strings (shown once) and the
// digests to persist. The plaintext codes are never stored.
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT, random = randomBytes) {
  // count is server-fixed in real use; guard so a bad caller can't request an
  // absurd allocation (DoS) or a non-integer.
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new RangeError(`recovery-code count must be an integer in [1,100], got ${count}`);
  }
  const codes = [];
  const digests = [];
  for (let i = 0; i < count; i++) {
    const tokenBytes = random(RECOVERY_TOKEN_BYTES);
    // Defend the entropy contract: an injected source must return exactly the
    // requested CSPRNG bytes. A short/weak source would silently produce
    // guessable recovery credentials, so fail loudly instead.
    if (!Buffer.isBuffer(tokenBytes) && !(tokenBytes instanceof Uint8Array)) {
      throw new TypeError("random source must return a Buffer/Uint8Array");
    }
    if (tokenBytes.length !== RECOVERY_TOKEN_BYTES) {
      throw new RangeError(`random source returned ${tokenBytes.length} bytes, expected ${RECOVERY_TOKEN_BYTES}`);
    }
    codes.push(formatRecoveryCode(tokenBytes));
    digests.push(hashRecoveryToken(tokenBytes));
  }
  return { codes, digests };
}

// ---- Constant-time membership ----

// True if `digest` (a 32-byte lowercase hex string) is present in `digests`.
// Compares every entry with timingSafeEqual and does not short-circuit on the
// first match, so the lookup does not leak which entry (or how many) matched via
// timing. `digest` shape is validated first; a malformed digest can never match.
export function digestInSet(digest, digests) {
  if (typeof digest !== "string" || !DIGEST_HEX_RE.test(digest)) return false;
  const needle = Buffer.from(digest, "hex");
  let found = false;
  for (const entry of digests) {
    if (typeof entry !== "string" || !DIGEST_HEX_RE.test(entry)) continue;
    const hay = Buffer.from(entry, "hex");
    if (hay.length === needle.length && timingSafeEqual(hay, needle)) {
      found = true; // no break: keep timing independent of match position
    }
  }
  return found;
}

// ---- Single-use consumption ----

// Attempt to consume an operator-entered code against the current unused-digest
// list. Pure: returns the outcome and the next digest list, never mutates input.
//   { ok: true, remaining: string[] }  -- code was valid and unused; caller
//                                          persists `remaining` (this digest
//                                          removed) under its atomic write.
//   { ok: false, reason }               -- "malformed" (bad checksum/shape) or
//                                          "unknown" (not an unused code).
// Removal is constant-time-safe: the returned list drops exactly the matched
// digest, compared with timingSafeEqual.
export function consumeRecoveryCode(input, unusedDigests) {
  const digest = digestFromInput(input);
  if (!digest) return { ok: false, reason: "malformed" };
  if (!digestInSet(digest, unusedDigests)) return { ok: false, reason: "unknown" };
  const needle = Buffer.from(digest, "hex");
  const remaining = unusedDigests.filter((entry) => {
    if (typeof entry !== "string" || !DIGEST_HEX_RE.test(entry)) return true;
    const hay = Buffer.from(entry, "hex");
    return !(hay.length === needle.length && timingSafeEqual(hay, needle));
  });
  return { ok: true, remaining };
}
