// Tier 3 TOTP (console layered auth, RFC docs/rfc-console-auth.md §2.3). Mandatory
// second factor on the password tier. Interoperable RFC 6238 parameters so every
// mainstream authenticator app works: HMAC-SHA1, 6 digits, 30-second period,
// ±1-step verification window, 160-bit server-generated secret.
//
// Pure module: secret generation, base32 (RFC 4648) for the provisioning URI,
// RFC 4226 HOTP, RFC 6238 TOTP, a windowed constant-time verify, and local QR
// rendering of the provisioning URI. No network I/O, no persistence (later
// phase), no clock of its own — the caller passes the time so tests are
// deterministic and the module never reads a wall clock implicitly.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";

export const TOTP_ALGORITHM = "SHA1"; // interoperable default; authenticator apps assume it
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_SECRET_BYTES = 20; // 160-bit
export const TOTP_DEFAULT_WINDOW = 1; // ±1 step tolerates ordinary clock drift

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648, no padding on output

// ---- base32 (RFC 4648) ----

export function base32Encode(bytes) {
  const buf = Buffer.from(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(input) {
  // Non-string input returns null rather than coercing to a garbage buffer:
  // the later store-read path feeds a persisted secret through here, and a
  // null/undefined/corrupt stored value must fail cleanly, not silently
  // decode to a short wrong buffer.
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[\s=-]/g, "").toUpperCase();
  if (cleaned.length === 0 || /[^A-Z2-7]/.test(cleaned)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of cleaned) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- secret ----

// Generate a fresh 160-bit secret. Returns the raw bytes and the base32 form
// (what an authenticator app / the provisioning URI needs).
export function generateTotpSecret(random = randomBytes) {
  const secret = random(TOTP_SECRET_BYTES);
  if (!Buffer.isBuffer(secret) && !(secret instanceof Uint8Array)) {
    throw new TypeError("random source must return a Buffer/Uint8Array");
  }
  if (secret.length !== TOTP_SECRET_BYTES) {
    throw new RangeError(`random source returned ${secret.length} bytes, expected ${TOTP_SECRET_BYTES}`);
  }
  const bytes = Buffer.from(secret);
  return { secretBytes: bytes, base32: base32Encode(bytes) };
}

// ---- HOTP / TOTP ----

// RFC 4226 HOTP: HMAC-SHA1(secret, counter) → dynamic truncation → zero-padded
// `digits`-length decimal string.
function assertSecretBytes(secretBytes) {
  // A caller mistake -- passing the base32 *string* where raw bytes are
  // expected -- must fail loudly, not silently reinterpret the string as
  // UTF-8 bytes and produce wrong codes. This is a programming error, not
  // untrusted input, so throwing is correct.
  if (!Buffer.isBuffer(secretBytes) && !(secretBytes instanceof Uint8Array)) {
    throw new TypeError("secretBytes must be a Buffer/Uint8Array of raw secret bytes (not base32)");
  }
}

export function hotp(secretBytes, counter, digits = TOTP_DIGITS) {
  assertSecretBytes(secretBytes);
  if (!Number.isInteger(counter) || counter < 0) {
    throw new RangeError(`counter must be a non-negative integer, got ${counter}`);
  }
  const counterBuf = Buffer.alloc(8);
  // 64-bit big-endian counter; JS bitops are 32-bit so split hi/lo.
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", Buffer.from(secretBytes)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function counterForTime(timeSeconds, period = TOTP_PERIOD_SECONDS) {
  return Math.floor(timeSeconds / period);
}

// Current TOTP code for a given time (seconds since epoch). The caller supplies
// the time — the module never reads the clock itself.
export function totpCode(secretBytes, timeSeconds, { period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS } = {}) {
  return hotp(secretBytes, counterForTime(timeSeconds, period), digits);
}

// Verify a submitted token against the ±window steps around `timeSeconds`.
// Compares with timingSafeEqual and checks every step in the window without
// short-circuiting, so a valid token is accepted regardless of which step it
// landed on and the check does not leak the matching offset via timing.
// Verify and return the matched step counter: { valid, counter }. `counter` is
// the specific step (center+offset) the token matched, or null. The login phase
// MUST persist this per principal and reject any counter <= the last consumed
// one, so a code is not replayable across two logins within the same 30s step
// (the ±1 window means the matched step, not the center, is what must be
// recorded). Iterates the full window without short-circuiting so total work
// (and thus timing) is independent of which step, or whether any, matched.
export function verifyTotpMatch(secretBytes, token, timeSeconds, {
  period = TOTP_PERIOD_SECONDS,
  digits = TOTP_DIGITS,
  window = TOTP_DEFAULT_WINDOW,
} = {}) {
  if (typeof token !== "string") return { valid: false, counter: null };
  const candidate = token.replace(/\s/g, "");
  // Length check + a hardcoded digits-only regex, rather than building
  // `^\\d{${digits}}$` at call time. Identical semantics, and it keeps a
  // caller-supplied value out of a RegExp constructor entirely -- no caller
  // passes `digits` today, but a dynamic regex on this path is a standing
  // invitation for one to start.
  if (candidate.length !== digits || !/^\d+$/.test(candidate)) return { valid: false, counter: null };
  const candidateBuf = Buffer.from(candidate, "utf8");
  const center = counterForTime(timeSeconds, period);
  let matchedCounter = null;
  for (let offset = -window; offset <= window; offset++) {
    const step = center + offset;
    if (step < 0) continue; // pre-epoch step (only reachable for tiny timeSeconds)
    const expectedBuf = Buffer.from(hotp(secretBytes, step, digits), "utf8");
    if (expectedBuf.length === candidateBuf.length && timingSafeEqual(expectedBuf, candidateBuf)) {
      matchedCounter = step; // no break: timing independent of the matching step
    }
  }
  return { valid: matchedCounter !== null, counter: matchedCounter };
}

// Boolean convenience wrapper for callers that only need yes/no (e.g. the
// enrollment-confirm step, which has no prior counter to compare against).
export function verifyTotp(secretBytes, token, timeSeconds, options = {}) {
  return verifyTotpMatch(secretBytes, token, timeSeconds, options).valid;
}

// ---- provisioning URI ----

// otpauth:// URI an authenticator app imports (rendered as a QR by the caller).
// label = "Issuer:account"; issuer is also a query param (apps expect both).
export function provisioningUri({
  secretBase32,
  accountName,
  issuer,
  algorithm = TOTP_ALGORITHM,
  digits = TOTP_DIGITS,
  period = TOTP_PERIOD_SECONDS,
}) {
  if (!secretBase32 || !accountName || !issuer) {
    throw new Error("provisioningUri requires secretBase32, accountName, and issuer");
  }
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm,
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Render an otpauth:// URI as a QR code the setup screen can show inline (an
// <img src="data:..."> needs no client-side QR library). `qrcode` performs
// pure local image encoding -- no network access -- consistent with this
// module's zero-egress requirement (RFC §3.2).
export async function provisioningQrDataUri(otpauthUri) {
  if (!otpauthUri) throw new Error("provisioningQrDataUri requires an otpauthUri");
  return QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: "M" });
}
