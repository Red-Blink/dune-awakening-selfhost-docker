import test from "node:test";
import assert from "node:assert/strict";

import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  base32Encode,
  base32Decode,
  generateTotpSecret,
  hotp,
  counterForTime,
  totpCode,
  verifyTotp,
  verifyTotpMatch,
  provisioningUri,
  provisioningQrDataUri,
} from "../src/auth/totp.js";

// RFC 6238 Appendix B reference secret (ASCII "12345678901234567890", 20 bytes).
const RFC_SECRET = Buffer.from("12345678901234567890", "utf8");

// ---- base32 (RFC 4648 test vectors) ----

test("base32Encode matches RFC 4648 vectors (no padding)", () => {
  const cases = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];
  for (const [plain, encoded] of cases) {
    assert.equal(base32Encode(Buffer.from(plain, "utf8")), encoded, `encode ${JSON.stringify(plain)}`);
  }
});

test("base32Decode reverses encode, tolerating case / spaces / padding", () => {
  assert.equal(base32Decode("MZXW6YTBOI").toString("utf8"), "foobar");
  assert.equal(base32Decode("mzxw6ytboi").toString("utf8"), "foobar");
  assert.equal(base32Decode("MZXW 6YTB OI==").toString("utf8"), "foobar");
  // Non-empty round-trips (empty input is intentionally rejected as null by
  // base32Decode — an empty secret is never usable; see the reject test below).
  for (const s of ["hello world", "\x00\x01\x02\x03\x04", "z"]) {
    const b = Buffer.from(s, "utf8");
    assert.deepEqual(base32Decode(base32Encode(b)), b, `round-trip ${JSON.stringify(s)}`);
  }
});

test("base32Decode rejects non-alphabet input", () => {
  assert.equal(base32Decode("!!!!"), null);
  assert.equal(base32Decode("0189"), null); // 0,1,8,9 are not in the base32 alphabet
  assert.equal(base32Decode(""), null);
});

// ---- HOTP / TOTP against RFC 6238 Appendix B (SHA1 column) ----

test("hotp/totpCode reproduce the RFC 6238 SHA1 8-digit test vectors", () => {
  // [unix time T, expected 8-digit SHA1 TOTP]
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, expected] of vectors) {
    assert.equal(totpCode(RFC_SECRET, t, { digits: 8 }), expected, `T=${t}`);
    // and directly via hotp on the derived counter
    assert.equal(hotp(RFC_SECRET, counterForTime(t), 8), expected, `hotp T=${t}`);
  }
});

test("6-digit code is the low 6 digits of the 8-digit RFC vector", () => {
  assert.equal(totpCode(RFC_SECRET, 59, { digits: 6 }), "287082");
  assert.equal(totpCode(RFC_SECRET, 1111111109), "081804"); // default digits = 6
  assert.equal(totpCode(RFC_SECRET, 1234567890), "005924");
});

test("64-bit counter high word is written correctly (counters > 2^32)", () => {
  // No RFC vector reaches a nonzero high word, so pin it directly: counters
  // that differ ONLY in the high 32 bits must produce different codes, and a
  // counter's low/high words must not be interchangeable. Guards against a
  // hi/lo swap or a 32-bit-truncated counter encoding.
  const HI = 0x100000000; // 2^32
  assert.notEqual(hotp(RFC_SECRET, HI, 8), hotp(RFC_SECRET, 0, 8), "hi-word bit changes the code");
  assert.notEqual(hotp(RFC_SECRET, HI + 1, 8), hotp(RFC_SECRET, 1, 8), "same lo word, different hi word -> different code");
  assert.notEqual(hotp(RFC_SECRET, HI, 8), hotp(RFC_SECRET, 1, 8), "swapping hi<->lo would collide these; they must differ");
  // sanity: still deterministic
  assert.equal(hotp(RFC_SECRET, HI, 8), hotp(RFC_SECRET, HI, 8));
});

test("counterForTime floors to the period", () => {
  assert.equal(counterForTime(0), 0);
  assert.equal(counterForTime(29), 0);
  assert.equal(counterForTime(30), 1);
  assert.equal(counterForTime(59), 1);
  assert.equal(counterForTime(60), 2);
});

// ---- verifyTotp windowing ----

test("verifyTotp accepts the current code and rejects a wrong one", () => {
  const t = 1234567890;
  assert.equal(verifyTotp(RFC_SECRET, "005924", t), true);
  assert.equal(verifyTotp(RFC_SECRET, "000000", t), false);
});

test("verifyTotp accepts ±1 step (clock drift) but not ±2 on either side", () => {
  const t = 1234567890;
  const prev = totpCode(RFC_SECRET, t - TOTP_PERIOD_SECONDS);
  const next = totpCode(RFC_SECRET, t + TOTP_PERIOD_SECONDS);
  const twoBack = totpCode(RFC_SECRET, t - 2 * TOTP_PERIOD_SECONDS);
  const twoFwd = totpCode(RFC_SECRET, t + 2 * TOTP_PERIOD_SECONDS);
  assert.equal(verifyTotp(RFC_SECRET, prev, t), true, "previous step within ±1");
  assert.equal(verifyTotp(RFC_SECRET, next, t), true, "next step within ±1");
  assert.equal(verifyTotp(RFC_SECRET, twoBack, t), false, "two steps back is outside the window");
  assert.equal(verifyTotp(RFC_SECRET, twoFwd, t), false, "two steps forward is outside the window");
  // window: 0 rejects even the adjacent step
  assert.equal(verifyTotp(RFC_SECRET, prev, t, { window: 0 }), false);
});

test("verifyTotpMatch returns the matched step counter (for replay prevention)", () => {
  const t = 1234567890;
  const center = counterForTime(t);
  // current-step code matches at the center counter
  assert.deepEqual(verifyTotpMatch(RFC_SECRET, totpCode(RFC_SECRET, t), t), { valid: true, counter: center });
  // a code from the previous step matches at center-1, NOT center -- the login
  // phase must record this matched counter, not the center, to prevent replay.
  assert.deepEqual(
    verifyTotpMatch(RFC_SECRET, totpCode(RFC_SECRET, t - TOTP_PERIOD_SECONDS), t),
    { valid: true, counter: center - 1 }
  );
  assert.deepEqual(verifyTotpMatch(RFC_SECRET, "000000", t), { valid: false, counter: null });
  assert.deepEqual(verifyTotpMatch(RFC_SECRET, "bad", t), { valid: false, counter: null });
});

test("hotp/verifyTotp throw on a base32 string mistakenly passed as the secret", () => {
  const { base32 } = generateTotpSecret((len) => Buffer.alloc(len, 0x2a));
  assert.throws(() => hotp(base32, 1), /Buffer\/Uint8Array/, "hotp rejects a string secret");
  assert.throws(() => verifyTotp(base32, "123456", 1700000000), /Buffer\/Uint8Array/, "verify rejects a string secret");
});

test("hotp rejects a negative or non-integer counter", () => {
  assert.throws(() => hotp(RFC_SECRET, -1), /non-negative integer/);
  assert.throws(() => hotp(RFC_SECRET, 1.5), /non-negative integer/);
});

test("verifyTotpMatch does not throw for a pre-epoch time (small timeSeconds)", () => {
  // center-window can go below 0; those steps are skipped, not thrown on.
  assert.doesNotThrow(() => verifyTotpMatch(RFC_SECRET, "123456", 0, { window: 1 }));
  assert.equal(verifyTotpMatch(RFC_SECRET, "123456", 0, { window: 1 }).valid, false);
});

test("verifyTotp rejects malformed tokens (wrong length, non-digit, non-string)", () => {
  const t = 1234567890;
  assert.equal(verifyTotp(RFC_SECRET, "5924", t), false, "too short");
  assert.equal(verifyTotp(RFC_SECRET, "00592412", t), false, "too long");
  assert.equal(verifyTotp(RFC_SECRET, "abcdef", t), false, "non-digit");
  assert.equal(verifyTotp(RFC_SECRET, 5924, t), false, "non-string");
  assert.equal(verifyTotp(RFC_SECRET, null, t), false);
});

test("verifyTotp tolerates surrounding whitespace", () => {
  assert.equal(verifyTotp(RFC_SECRET, "  005924 ", 1234567890), true);
});

// ---- secret generation ----

test("generateTotpSecret returns a 160-bit secret and its base32", () => {
  const seq = (len) => Buffer.alloc(len, 7);
  const { secretBytes, base32 } = generateTotpSecret(seq);
  assert.equal(secretBytes.length, TOTP_SECRET_BYTES);
  assert.equal(TOTP_SECRET_BYTES, 20);
  // Independent checks (not base32 == base32Encode(secretBytes), which is a
  // tautology since generate produced base32 via base32Encode): the base32 is
  // well-formed RFC 4648, and it decodes back to the exact secret.
  assert.match(base32, /^[A-Z2-7]+$/, "base32 uses only the RFC 4648 alphabet");
  assert.equal(base32.length, 32, "20 bytes -> 32 base32 chars");
  assert.deepEqual(base32Decode(base32), secretBytes, "base32 round-trips the secret");
});

test("base32Decode returns null for non-string input (no garbage coercion)", () => {
  for (const bad of [null, undefined, 12345, {}, []]) {
    assert.equal(base32Decode(bad), null, `base32Decode(${JSON.stringify(bad)}) is null`);
  }
});

test("generateTotpSecret rejects a bad random source", () => {
  assert.throws(() => generateTotpSecret(() => Buffer.alloc(8)), /expected 20/);
  assert.throws(() => generateTotpSecret(() => "nope"), /Buffer\/Uint8Array/);
});

test("a freshly generated secret verifies its own current code", () => {
  const { secretBytes } = generateTotpSecret((len) => Buffer.alloc(len, 0x2a));
  const t = 1700000000;
  assert.equal(verifyTotp(secretBytes, totpCode(secretBytes, t), t), true);
});

// ---- provisioning URI ----

test("provisioningUri builds a valid otpauth URL with issuer/label/params", () => {
  // Derive the base32 from an obvious fixed byte pattern rather than hardcoding
  // a high-entropy literal (which secret scanners flag as a generic key).
  const secretBase32 = base32Encode(Buffer.alloc(TOTP_SECRET_BYTES, 0x41));
  const uri = provisioningUri({
    secretBase32,
    accountName: "operator@example.com",
    issuer: "Dune Console",
  });
  const u = new URL(uri);
  assert.equal(u.protocol, "otpauth:");
  assert.equal(u.host, "totp");
  assert.equal(decodeURIComponent(u.pathname), "/Dune Console:operator@example.com");
  assert.equal(u.searchParams.get("secret"), secretBase32);
  assert.equal(u.searchParams.get("issuer"), "Dune Console");
  assert.equal(u.searchParams.get("algorithm"), "SHA1");
  assert.equal(u.searchParams.get("digits"), String(TOTP_DIGITS));
  assert.equal(u.searchParams.get("period"), String(TOTP_PERIOD_SECONDS));
});

test("provisioningUri requires secret, account, and issuer", () => {
  assert.throws(() => provisioningUri({ accountName: "a", issuer: "b" }), /requires/);
  assert.throws(() => provisioningUri({ secretBase32: "X", issuer: "b" }), /requires/);
  assert.throws(() => provisioningUri({ secretBase32: "X", accountName: "a" }), /requires/);
});

test("provisioningQrDataUri renders the otpauth URI as a local PNG data URI", async () => {
  const secretBase32 = base32Encode(Buffer.alloc(TOTP_SECRET_BYTES, 0x41));
  const uri = provisioningUri({ secretBase32, accountName: "console-admin", issuer: "Dune Docker Console" });
  const dataUri = await provisioningQrDataUri(uri);
  assert.match(dataUri, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
});

test("provisioningQrDataUri never performs network access (zero-egress)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network access attempted"); };
  try {
    const secretBase32 = base32Encode(Buffer.alloc(TOTP_SECRET_BYTES, 0x42));
    const uri = provisioningUri({ secretBase32, accountName: "console-admin", issuer: "Dune Docker Console" });
    const dataUri = await provisioningQrDataUri(uri);
    assert.match(dataUri, /^data:image\/png;base64,/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
