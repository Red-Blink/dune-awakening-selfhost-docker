import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  RECOVERY_CODE_COUNT,
  RECOVERY_TOKEN_BYTES,
  RECOVERY_DOMAIN_SEPARATOR,
  formatRecoveryCode,
  parseRecoveryCode,
  isChecksumValid,
  hashRecoveryToken,
  digestFromInput,
  generateRecoveryCodes,
  digestInSet,
  consumeRecoveryCode,
} from "../src/auth/recoveryCodes.js";

// A deterministic byte source so tests don't depend on real randomness.
function seqRandom() {
  let n = 0;
  return (len) => Buffer.alloc(len, (n++ % 251) + 1); // avoid 0 for visibility
}

const TOKEN = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"); // 16 bytes

// ---- generation ----

test("generateRecoveryCodes returns COUNT codes and matching digests", () => {
  const { codes, digests } = generateRecoveryCodes(RECOVERY_CODE_COUNT, seqRandom());
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(digests.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT, "codes are distinct");
  assert.equal(new Set(digests).size, RECOVERY_CODE_COUNT, "digests are distinct");
  for (const d of digests) assert.match(d, /^[0-9a-f]{64}$/);
});

test("generated code round-trips: format -> parse -> digest equals stored digest", () => {
  const { codes, digests } = generateRecoveryCodes(3, seqRandom());
  for (let i = 0; i < codes.length; i++) {
    assert.equal(isChecksumValid(codes[i]), true, `code ${i} has a valid checksum`);
    assert.equal(digestFromInput(codes[i]), digests[i], `code ${i} digests to its stored form`);
  }
});

test("stored digest is one-way and domain-separated (not derivable from the code without the separator)", () => {
  // The real property is "the store holds only an irreversible, domain-separated
  // hash." Verify the digest is NOT any transform an attacker could compute
  // straight from the visible code: not the token hex, not a bare SHA-256 of
  // the token, not a SHA-256 of the full displayed string.
  const { codes, digests } = generateRecoveryCodes(3, seqRandom());
  for (let i = 0; i < codes.length; i++) {
    const tokenHex = codes[i].replace(/[-\s]/g, "").slice(0, 32);
    const tokenBytes = Buffer.from(tokenHex, "hex");
    assert.notEqual(digests[i], tokenHex, "digest is not the plaintext token");
    assert.notEqual(digests[i], createHash("sha256").update(tokenBytes).digest("hex"), "digest is not a bare SHA-256");
    assert.notEqual(digests[i], createHash("sha256").update(codes[i]).digest("hex"), "digest is not a hash of the displayed string");
    assert.equal(digests[i].length, 64, "digest is a 32-byte hash");
  }
});

// ---- encoding / checksum ----

test("formatRecoveryCode produces 8 groups of 4 hex + a 2-char checksum", () => {
  const s = formatRecoveryCode(TOKEN);
  const parts = s.split("-");
  assert.equal(parts.length, 9, "8 token groups + 1 checksum group");
  for (let i = 0; i < 8; i++) assert.match(parts[i], /^[0-9a-f]{4}$/);
  assert.match(parts[8], /^[0-9a-f]{2}$/);
  // checksum = first byte of SHA-256(tokenBytes)
  const expected = createHash("sha256").update(TOKEN).digest("hex").slice(0, 2);
  assert.equal(parts[8], expected);
});

test("parseRecoveryCode is case-insensitive and strips dashes/whitespace", () => {
  const s = formatRecoveryCode(TOKEN);
  const messy = `  ${s.toUpperCase().replace(/-/g, " ")}  `;
  assert.deepEqual(parseRecoveryCode(messy), parseRecoveryCode(s));
});

test("parseRecoveryCode rejects wrong length and non-hex", () => {
  assert.equal(parseRecoveryCode(""), null);
  assert.equal(parseRecoveryCode("xyz"), null);
  assert.equal(parseRecoveryCode(formatRecoveryCode(TOKEN) + "ff"), null, "too long");
  assert.equal(parseRecoveryCode(null), null);
  assert.equal(parseRecoveryCode(123), null);
});

test("isChecksumValid rejects a corrupted checksum", () => {
  const s = formatRecoveryCode(TOKEN);
  assert.equal(isChecksumValid(s), true);
  // Corrupt the 2-char checksum itself -> guaranteed mismatch against the token
  // (no dependency on a 1/256 body-flip checksum collision).
  const cleaned = s.replace(/[-\s]/g, "");
  const token = cleaned.slice(0, 32);
  const goodCk = cleaned.slice(32, 34);
  const badCk = (goodCk[0] === "a" ? "b" : "a") + goodCk[1];
  assert.notEqual(badCk, goodCk);
  const corrupted = token.match(/.{1,4}/g).join("-") + "-" + badCk;
  assert.equal(isChecksumValid(corrupted), false, "a wrong checksum is rejected");
});

test("isChecksumValid rejects a body transcription error (verified non-colliding for this vector)", () => {
  const s = formatRecoveryCode(TOKEN);
  const cleaned = s.replace(/[-\s]/g, "");
  const flippedToken = (cleaned[0] === "a" ? "b" : "a") + cleaned.slice(1, 32);
  // Keep the ORIGINAL checksum; this catches the error unless the flipped token
  // collides on the 1-byte checksum. Assert the precondition so a future TOKEN
  // change can't silently make this a false-pass.
  const flippedBytes = Buffer.from(flippedToken, "hex");
  const flippedCk = createHash("sha256").update(flippedBytes).digest("hex").slice(0, 2);
  assert.notEqual(flippedCk, cleaned.slice(32, 34), "precondition: flip must change the checksum");
  const regrouped = flippedToken.match(/.{1,4}/g).join("-") + "-" + cleaned.slice(32, 34);
  assert.equal(isChecksumValid(regrouped), false, "a flipped body digit fails the checksum");
});

// ---- hashing / domain separation ----

test("hashRecoveryToken is domain-separated (not a bare SHA-256 of the token)", () => {
  const withSep = hashRecoveryToken(TOKEN);
  const bare = createHash("sha256").update(TOKEN).digest("hex");
  const manual = createHash("sha256").update(RECOVERY_DOMAIN_SEPARATOR).update(TOKEN).digest("hex");
  assert.equal(withSep, manual);
  assert.notEqual(withSep, bare, "domain separator must change the digest");
});

test("digestFromInput returns null for a checksum-invalid string (never hashes garbage)", () => {
  assert.equal(digestFromInput("not-a-code"), null);
  const s = formatRecoveryCode(TOKEN);
  const badChecksum = s.slice(0, -2) + "zz"; // non-hex checksum
  assert.equal(digestFromInput(badChecksum), null);
});

// ---- membership ----

test("digestInSet finds a present digest and rejects an absent or malformed one", () => {
  const { digests } = generateRecoveryCodes(4, seqRandom());
  assert.equal(digestInSet(digests[2], digests), true);
  assert.equal(digestInSet("f".repeat(64), digests), false);
  assert.equal(digestInSet("abc", digests), false, "malformed digest never matches");
  assert.equal(digestInSet(digests[0].toUpperCase(), digests), false, "case-sensitive hex");
});

// ---- single-use consumption ----

test("consumeRecoveryCode accepts a valid unused code once and removes exactly it", () => {
  const random = seqRandom();
  const { codes, digests } = generateRecoveryCodes(RECOVERY_CODE_COUNT, random);
  const first = consumeRecoveryCode(codes[3], digests);
  assert.equal(first.ok, true);
  assert.equal(first.remaining.length, RECOVERY_CODE_COUNT - 1);
  assert.equal(first.remaining.includes(digests[3]), false, "the used digest is gone");
  for (let i = 0; i < digests.length; i++) {
    if (i !== 3) assert.equal(first.remaining.includes(digests[i]), true, `digest ${i} retained`);
  }

  // second use of the same code against the updated list fails (single-use)
  const second = consumeRecoveryCode(codes[3], first.remaining);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "unknown");
});

test("consumeRecoveryCode distinguishes malformed from unknown", () => {
  const { digests } = generateRecoveryCodes(3, seqRandom());
  assert.deepEqual(consumeRecoveryCode("clearly-not-valid", digests), { ok: false, reason: "malformed" });
  // a well-formed code that simply isn't in the set
  const other = formatRecoveryCode(Buffer.alloc(16, 0xab));
  assert.equal(isChecksumValid(other), true);
  assert.deepEqual(consumeRecoveryCode(other, digests), { ok: false, reason: "unknown" });
});

test("consumeRecoveryCode does not mutate the input list", () => {
  const { codes, digests } = generateRecoveryCodes(5, seqRandom());
  const snapshot = [...digests];
  consumeRecoveryCode(codes[0], digests);
  assert.deepEqual(digests, snapshot, "input digests array is untouched");
});

test("token size is 128-bit", () => {
  assert.equal(RECOVERY_TOKEN_BYTES, 16);
});

// ---- defensive branches / guards ----

test("digestInSet and consumeRecoveryCode tolerate a corrupt (non-string / non-hex) store entry", () => {
  const { codes, digests } = generateRecoveryCodes(3, seqRandom());
  const corrupt = [null, "not-hex", 42, ...digests];
  // present digest still found despite corrupt neighbors
  assert.equal(digestInSet(digests[1], corrupt), true);
  // a valid code still consumes, dropping only its digest; corrupt rows preserved
  const res = consumeRecoveryCode(codes[1], corrupt);
  assert.equal(res.ok, true);
  assert.equal(res.remaining.includes(digests[1]), false, "used digest removed");
  assert.equal(res.remaining.includes("not-hex"), true, "corrupt row preserved, not silently dropped");
  assert.equal(res.remaining.length, corrupt.length - 1);
});

test("digestInSet / consumeRecoveryCode handle an empty unused-digest list", () => {
  assert.equal(digestInSet("a".repeat(64), []), false);
  const other = formatRecoveryCode(Buffer.alloc(16, 0xcd));
  assert.deepEqual(consumeRecoveryCode(other, []), { ok: false, reason: "unknown" });
});

test("generateRecoveryCodes rejects an out-of-range or non-integer count", () => {
  assert.throws(() => generateRecoveryCodes(0), /count must be an integer/);
  assert.throws(() => generateRecoveryCodes(101), /count must be an integer/);
  assert.throws(() => generateRecoveryCodes(2.5), /count must be an integer/);
});

test("generateRecoveryCodes rejects a random source of the wrong length or type", () => {
  assert.throws(() => generateRecoveryCodes(1, () => Buffer.alloc(4)), /expected 16/, "short source rejected");
  assert.throws(() => generateRecoveryCodes(1, () => "notbytes"), /Buffer\/Uint8Array/, "non-buffer source rejected");
});
