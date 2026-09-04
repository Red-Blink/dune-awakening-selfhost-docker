import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSecondFactorStore, SecondFactorCorruptError, SecondFactorVersionError, SECOND_FACTOR_VERSION } from "../src/auth/secondFactorStore.js";
import { totpCode, counterForTime, TOTP_PERIOD_SECONDS } from "../src/auth/totp.js";

const SECRET = Buffer.from("12345678901234567890", "utf8"); // 20 bytes
const T = 1700000000;

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "sfs-"));
  const filePath = join(dir, "console-second-factor.json");
  return { store: createSecondFactorStore({ filePath }), filePath, dir };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ---- rollback protection: commit() must not swallow a newer-version store (review finding) ----

test("commit fails closed on a newer-version store instead of clobbering it with a fresh v1", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET); // valid v1 store on disk
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    onDisk.version = SECOND_FACTOR_VERSION + 1; // a newer console wrote it, then the binary was rolled back
    writeFileSync(filePath, JSON.stringify(onDisk), { mode: 0o600 });

    await assert.rejects(
      () => store.commit(SECRET),
      SecondFactorVersionError,
      "commit must propagate the version error (fail closed), not swallow it and overwrite"
    );

    // The newer store is left intact -- the destruction the watermark guard exists to prevent.
    const after = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(after.version, SECOND_FACTOR_VERSION + 1);
  } finally { cleanup(dir); }
});

// ---- basic lifecycle ----

test("a fresh install is not configured and no file exists", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    assert.equal(await store.isConfigured(), false);
    assert.equal(existsSync(filePath), false);
    assert.equal(await store.remainingRecoveryCodes(), 0);
  } finally { cleanup(dir); }
});

test("commit persists TOTP + recovery codes at mode 0600 and returns one-time codes", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    const { codes } = await store.commit(SECRET);
    assert.equal(codes.length, 10);
    assert.equal(await store.isConfigured(), true);
    assert.equal(await store.remainingRecoveryCodes(), 10);

    // file mode is 0600
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    // secret stored as base64 of RAW bytes (not base32), round-trips
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(onDisk.version, SECOND_FACTOR_VERSION);
    assert.deepEqual(Buffer.from(onDisk.totp.secret, "base64"), SECRET);
    assert.equal(onDisk.totp.lastUsedCounter, -1);
    // plaintext codes are NOT on disk (only digests)
    for (const c of codes) assert.equal(readFileSync(filePath, "utf8").includes(c.replace(/-/g, "")), false);
  } finally { cleanup(dir); }
});

// ---- TOTP verify + replay prevention ----

test("verifyTotpToken accepts a valid code once, then rejects the SAME code as replay", async () => {
  const { store, dir } = freshStore();
  try {
    await store.commit(SECRET);
    const token = totpCode(SECRET, T);
    assert.deepEqual(await store.verifyTotpToken(token, T), { ok: true });
    // same code, same step -> replay (matched counter <= lastUsedCounter)
    assert.deepEqual(await store.verifyTotpToken(token, T), { ok: false, reason: "replay" });
    // a code from a later step is accepted (counter advances)
    const later = totpCode(SECRET, T + TOTP_PERIOD_SECONDS);
    assert.deepEqual(await store.verifyTotpToken(later, T + TOTP_PERIOD_SECONDS), { ok: true });
    // and re-presenting the earlier step's code is now also replay (counter went backward)
    assert.deepEqual(await store.verifyTotpToken(token, T), { ok: false, reason: "replay" });
  } finally { cleanup(dir); }
});

test("verifyTotpToken rejects an invalid code and reports not_configured before commit", async () => {
  const { store, dir } = freshStore();
  try {
    assert.deepEqual(await store.verifyTotpToken("000000", T), { ok: false, reason: "not_configured" });
    await store.commit(SECRET);
    assert.deepEqual(await store.verifyTotpToken("000000", T), { ok: false, reason: "invalid" });
  } finally { cleanup(dir); }
});

test("CONCURRENCY: N simultaneous verifications of the same code -> exactly one succeeds (no replay)", async () => {
  const { store, dir } = freshStore();
  try {
    await store.commit(SECRET);
    const token = totpCode(SECRET, T);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.verifyTotpToken(token, T)));
    const ok = results.filter((r) => r.ok).length;
    const replay = results.filter((r) => r.reason === "replay").length;
    assert.equal(ok, 1, "exactly one concurrent verification of one code may succeed");
    assert.equal(replay, 7, "the rest are rejected as replay");
  } finally { cleanup(dir); }
});

// ---- recovery-code single use ----

test("consumeRecoveryCode accepts a code once and rejects its reuse", async () => {
  const { store, dir } = freshStore();
  try {
    const { codes } = await store.commit(SECRET);
    const r1 = await store.consumeRecoveryCode(codes[3]);
    assert.equal(r1.ok, true);
    assert.equal(r1.remaining, 9);
    assert.equal(await store.remainingRecoveryCodes(), 9);
    const r2 = await store.consumeRecoveryCode(codes[3]);
    assert.deepEqual(r2, { ok: false, reason: "unknown" });
  } finally { cleanup(dir); }
});

test("consumeRecoveryCode distinguishes malformed / unknown / not_configured", async () => {
  const { store, dir } = freshStore();
  try {
    assert.deepEqual(await store.consumeRecoveryCode("whatever"), { ok: false, reason: "not_configured" });
    const { codes } = await store.commit(SECRET);
    assert.deepEqual(await store.consumeRecoveryCode("not-a-code"), { ok: false, reason: "malformed" });
    // a well-formed but not-issued code
    const { store: other, dir: d2 } = freshStore();
    const foreign = (await other.commit(SECRET)).codes[0];
    cleanup(d2);
    assert.deepEqual(await store.consumeRecoveryCode(foreign), { ok: false, reason: "unknown" });
    assert.equal(codes.length, 10);
  } finally { cleanup(dir); }
});

test("CONCURRENCY: N simultaneous consumptions of the same recovery code -> exactly one succeeds (no double-spend)", async () => {
  const { store, dir } = freshStore();
  try {
    const { codes } = await store.commit(SECRET);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consumeRecoveryCode(codes[0])));
    const ok = results.filter((r) => r.ok).length;
    assert.equal(ok, 1, "a single-use code cannot be spent twice under concurrency");
    assert.equal(await store.remainingRecoveryCodes(), 9, "exactly one code consumed");
  } finally { cleanup(dir); }
});

test("CONCURRENCY: consuming all distinct codes at once removes exactly all of them", async () => {
  const { store, dir } = freshStore();
  try {
    const { codes } = await store.commit(SECRET);
    const results = await Promise.all(codes.map((c) => store.consumeRecoveryCode(c)));
    assert.equal(results.filter((r) => r.ok).length, 10);
    assert.equal(await store.remainingRecoveryCodes(), 0);
  } finally { cleanup(dir); }
});

// ---- regenerate ----

test("regenerateRecoveryCodes issues a new set and invalidates the old", async () => {
  const { store, dir } = freshStore();
  try {
    const { codes: oldCodes } = await store.commit(SECRET);
    const { codes: newCodes, ok } = await store.regenerateRecoveryCodes();
    assert.equal(ok, true);
    assert.equal(newCodes.length, 10);
    // an old code no longer works
    assert.deepEqual(await store.consumeRecoveryCode(oldCodes[0]), { ok: false, reason: "unknown" });
    // a new one does
    assert.equal((await store.consumeRecoveryCode(newCodes[0])).ok, true);
  } finally { cleanup(dir); }
});

// ---- corruption fails closed ----

test("a corrupt store file throws SecondFactorCorruptError -- never silently 'not configured'", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET);
    writeFileSync(filePath, "{ this is not json", { mode: 0o600 });
    await assert.rejects(() => store.isConfigured(), SecondFactorCorruptError);
    await assert.rejects(() => store.verifyTotpToken(totpCode(SECRET, T), T), SecondFactorCorruptError);
    await assert.rejects(() => store.consumeRecoveryCode("x"), SecondFactorCorruptError);
    // critically: a corrupt file must NOT read as an unconfigured (bypassable) install
  } finally { cleanup(dir); }
});

test("a wrong-shape or unsupported-old-version store file fails closed as corrupt", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    writeFileSync(filePath, JSON.stringify({ notWhatWeExpect: true }), { mode: 0o600 });
    await assert.rejects(() => store.isConfigured(), SecondFactorCorruptError);
    // an older/unknown version (0) is corrupt (no migration path defined)
    writeFileSync(filePath, JSON.stringify({ version: 0, totp: { secret: "x", lastUsedCounter: 0 }, recoveryCodes: [] }), { mode: 0o600 });
    await assert.rejects(() => store.isConfigured(), SecondFactorCorruptError);
  } finally { cleanup(dir); }
});

test("a NEWER-version file throws SecondFactorVersionError, NOT corrupt (do not delete on downgrade)", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    writeFileSync(filePath, JSON.stringify({ version: SECOND_FACTOR_VERSION + 1, totp: {}, recoveryCodes: [] }), { mode: 0o600 });
    await assert.rejects(() => store.isConfigured(), SecondFactorVersionError);
    // distinct from corruption so §3.4's "delete a corrupt file" guidance can't
    // destroy live-but-newer state on a binary rollback.
    await assert.rejects(() => store.isConfigured(), (e) => !(e instanceof SecondFactorCorruptError));
  } finally { cleanup(dir); }
});

test("a corrupt-but-string TOTP secret (not valid base64 of a key) fails closed as corrupt", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    // valid shape, but the secret string is not base64 of a 10-64 byte key
    writeFileSync(filePath, JSON.stringify({ version: 1, totp: { secret: "!!!not-base64!!!", lastUsedCounter: -1 }, recoveryCodes: [] }), { mode: 0o600 });
    await assert.rejects(() => store.isConfigured(), SecondFactorCorruptError);
  } finally { cleanup(dir); }
});

// ---- clear (total-loss host reset / pre-rotation) ----

test("clear removes all state and returns the install to unconfigured", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET);
    assert.equal(await store.isConfigured(), true);
    await store.clear();
    assert.equal(existsSync(filePath), false);
    assert.equal(await store.isConfigured(), false);
    await store.clear(); // idempotent
  } finally { cleanup(dir); }
});

// ---- queue keeps ordering / survives a thrown op ----

test("the serialized queue survives a throwing op and keeps serving later ops", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET);
    writeFileSync(filePath, "corrupt", { mode: 0o600 });
    await assert.rejects(() => store.isConfigured(), SecondFactorCorruptError);
    // repair and confirm the queue still works
    await store.clear();
    await store.commit(SECRET);
    assert.equal(await store.isConfigured(), true);
  } finally { cleanup(dir); }
});

// ---- enroll (atomic, if-absent) ----

test("enroll creates state only when absent; a second enroll reports already_configured", async () => {
  const { store, dir } = freshStore();
  try {
    const first = await store.enroll(SECRET);
    assert.equal(first.ok, true);
    assert.equal(first.codes.length, 10);
    const second = await store.enroll(Buffer.alloc(20, 9));
    assert.deepEqual(second, { ok: false, reason: "already_configured" });
    // the original codes still work -> the second enroll did NOT overwrite
    const t = totpCode(SECRET, T);
    assert.deepEqual(await store.verifyTotpToken(t, T), { ok: true });
    // after clear, enroll works again
    await store.clear();
    assert.equal((await store.enroll(SECRET)).ok, true);
  } finally { cleanup(dir); }
});

// ---- commit as deliberate rotation (overwrite) ----

test("commit overwrites live state: new secret + codes, counter reset, old codes invalid", async () => {
  const { store, dir } = freshStore();
  try {
    const { codes: oldCodes } = await store.commit(SECRET);
    // advance the TOTP counter
    await store.verifyTotpToken(totpCode(SECRET, T), T);
    // rotate to a different secret
    const NEW = Buffer.alloc(20, 0x5a);
    const { codes: newCodes } = await store.commit(NEW);
    // old recovery codes no longer work; new ones do
    assert.deepEqual(await store.consumeRecoveryCode(oldCodes[0]), { ok: false, reason: "unknown" });
    assert.equal((await store.consumeRecoveryCode(newCodes[0])).ok, true);
    // counter was reset: a code for the NEW secret at the same step T is accepted
    assert.deepEqual(await store.verifyTotpToken(totpCode(NEW, T), T), { ok: true });
    // a code for the OLD secret is now invalid
    assert.deepEqual(await store.verifyTotpToken(totpCode(SECRET, T + TOTP_PERIOD_SECONDS), T + TOTP_PERIOD_SECONDS), { ok: false, reason: "invalid" });
  } finally { cleanup(dir); }
});

// ---- input guards ----

test("enroll/commit reject a non-Buffer or wrong-length secret", async () => {
  const { store, dir } = freshStore();
  try {
    await assert.rejects(() => store.commit("GEZDGNBVGY"), TypeError, "base32 string rejected");
    await assert.rejects(() => store.enroll(Buffer.alloc(8)), RangeError, "short secret rejected");
    await assert.rejects(() => store.commit(Buffer.alloc(32)), RangeError, "long secret rejected");
    assert.equal(await store.isConfigured(), false, "no state written by a rejected input");
  } finally { cleanup(dir); }
});

// ---- error paths on the read-side ops ----

test("regenerate and remaining report not_configured / throw before commit and on corruption", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    assert.deepEqual(await store.regenerateRecoveryCodes(), { ok: false, reason: "not_configured" });
    assert.equal(await store.remainingRecoveryCodes(), 0);
    await store.commit(SECRET);
    writeFileSync(filePath, "corrupt", { mode: 0o600 });
    await assert.rejects(() => store.regenerateRecoveryCodes(), SecondFactorCorruptError);
    await assert.rejects(() => store.remainingRecoveryCodes(), SecondFactorCorruptError);
  } finally { cleanup(dir); }
});

// ---- singleton-per-file guard (Architect H1: split-brain prevention) ----

test("a second store for the SAME file throws; close() releases the path", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    assert.throws(() => createSecondFactorStore({ filePath }), /already open/);
    // a store for a DIFFERENT file is fine
    const other = join(dir, "other.json");
    const s2 = createSecondFactorStore({ filePath: other });
    s2.close();
    // after close, the original path can be re-opened
    store.close();
    const reopened = createSecondFactorStore({ filePath });
    assert.equal(await reopened.isConfigured(), false);
    reopened.close();
    // a closed store rejects further ops
    await assert.rejects(() => store.isConfigured(), /closed/);
  } finally { cleanup(dir); }
});

// ---- backup/restore rollback detection ----

test("epoch starts at 0 on enroll and advances on every mutating op", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.enroll(SECRET);
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).epoch, 0);

    const { codes } = await store.enroll(SECRET); // already_configured, no-op
    assert.equal(codes, undefined);
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).epoch, 0, "a no-op enroll attempt does not advance the epoch");

    await store.regenerateRecoveryCodes();
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).epoch, 1);

    await store.regenerateRecoveryCodes();
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).epoch, 2);
  } finally { cleanup(dir); }
});

test("commit() carries the prior epoch forward across a legitimate rotation, not back to 0", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET); // epoch 0
    await store.regenerateRecoveryCodes(); // epoch 1
    await store.commit(SECRET); // a real rotation -- must NOT reset to 0
    const state = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(state.epoch, 2, "rotation continues the epoch sequence, so a legitimate rotation is never mistaken for a rollback");
  } finally { cleanup(dir); }
});

test("checkForRollback reports false for a normal install with no watermark yet", async () => {
  const { store, dir } = freshStore();
  try {
    await store.commit(SECRET);
    assert.deepEqual(await store.checkForRollback(), { detected: false });
  } finally { cleanup(dir); }
});

test("checkForRollback reports false with no state at all", async () => {
  const { store, dir } = freshStore();
  try {
    assert.deepEqual(await store.checkForRollback(), { detected: false });
  } finally { cleanup(dir); }
});

test("break-glass re-enroll seeds strictly above the surviving watermark, so a same-epoch old-file restore is still detected", async () => {
  // Regression for the seed-AT-watermark rollback-evasion finding. A used factor
  // reaches epoch W with watermark W; the operator break-glass deletes the store
  // (watermark survives) and re-enrolls. Seeding the fresh factor AT W left it at
  // the SAME epoch as a retained copy of the old store file, so restoring that
  // copy passed `epoch < watermark` (W < W = false) and resurrected its spent
  // recovery codes. The fresh factor must land at W+1.
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET);                       // epoch 0, watermark 0
    const { codes: oldCodes } = await store.regenerateRecoveryCodes(); // epoch 1, watermark 1
    const oldFileAtEpoch1 = readFileSync(filePath, "utf8");            // retained "backup"

    unlinkSync(filePath);                             // break-glass: delete the store; watermark survives
    await store.enroll(SECRET);                        // re-enroll on the absent store -> must seed 2, not 1
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).epoch, 2, "fresh factor seeds above the surviving watermark, not at it");

    writeFileSync(filePath, oldFileAtEpoch1, { mode: 0o600 }); // restore the old epoch-1 file
    assert.deepEqual(await store.checkForRollback(), { detected: true });
    const result = await store.consumeRecoveryCode(oldCodes[0]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "reset_detected", "the resurrected old recovery set is rejected, not honored");
  } finally { cleanup(dir); }
});

test("a file restored to an older epoch is detected on the next recovery-code consumption: whole set wiped, code rejected", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    const { codes } = await store.commit(SECRET); // epoch 0
    await store.regenerateRecoveryCodes(); // epoch 1, watermark now 1
    const stateAtEpoch1 = readFileSync(filePath, "utf8");
    const { codes: freshCodes } = await store.regenerateRecoveryCodes(); // epoch 2, watermark now 2

    // Simulate a restored backup: the file goes back to its epoch-1 content,
    // but the watermark file (a separate file) is untouched and still says 2.
    writeFileSync(filePath, stateAtEpoch1, { mode: 0o600 });

    assert.deepEqual(await store.checkForRollback(), { detected: true }, "the read-only check sees it too");

    // Even a code that WAS valid in the restored epoch-1 file is rejected --
    // the whole set is poisoned, not just the specific submitted code.
    const result = await store.consumeRecoveryCode(freshCodes[0]);
    assert.deepEqual(result, { ok: false, reason: "reset_detected", remaining: 0 });
    assert.equal(await store.remainingRecoveryCodes(), 0, "the entire set was wiped, not just the one code");

    // The pre-restore codes (from the original commit, long since superseded)
    // are equally rejected -- this isn't "only new codes are protected".
    const secondAttempt = await store.consumeRecoveryCode(codes[0]);
    assert.equal(secondAttempt.ok, false);
    assert.notEqual(secondAttempt.reason, "reset_detected", "the poisoning is one-shot -- the epoch is already past the watermark now");
    assert.equal(secondAttempt.reason, "unknown");
  } finally { cleanup(dir); }
});

test("after a detected rollback, TOTP login is unaffected (self-heals, no special handling)", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET); // epoch 0
    await store.regenerateRecoveryCodes(); // epoch 1
    const stateAtEpoch0 = JSON.parse(readFileSync(filePath, "utf8"));
    stateAtEpoch0.epoch = 0;
    // Directly craft an epoch-0 file with a valid TOTP secret (simulating a
    // restore that also rolled back the TOTP counter -- the documented
    // self-healing case, not this issue's concern).
    writeFileSync(filePath, JSON.stringify(stateAtEpoch0), { mode: 0o600 });

    const step = counterForTime(T, TOTP_PERIOD_SECONDS);
    const code = totpCode(SECRET, T);
    const result = await store.verifyTotpToken(code, T);
    assert.equal(result.ok, true, "TOTP verification does not consult the watermark at all");
    void step;
  } finally { cleanup(dir); }
});

test("clear() removes the watermark too, so re-enrollment after a host reset starts genuinely fresh", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    await store.commit(SECRET); // epoch 0
    await store.regenerateRecoveryCodes(); // epoch 1, watermark 1
    await store.clear();
    assert.equal(existsSync(filePath), false);
    assert.equal(existsSync(`${filePath}.watermark`), false, "the watermark must not survive a deliberate reset");

    const { codes } = await store.commit(SECRET); // fresh epoch 0
    assert.deepEqual(await store.checkForRollback(), { detected: false }, "a genuinely fresh enrollment is never flagged as a rollback");
    const consumed = await store.consumeRecoveryCode(codes[0]);
    assert.equal(consumed.ok, true, "recovery-code login works normally post-reset");
  } finally { cleanup(dir); }
});

test("a pre- file with no epoch field loads as epoch 0 and behaves normally (Requirement 0)", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    const { generateRecoveryCodes } = await import("../src/auth/recoveryCodes.js");
    const { codes, digests } = generateRecoveryCodes();
    // No `epoch` key at all -- exactly what every install's file looked like
    // before this feature existed.
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      totp: { secret: SECRET.toString("base64"), lastUsedCounter: -1 },
      recoveryCodes: digests,
    }), { mode: 0o600 });

    assert.deepEqual(await store.checkForRollback(), { detected: false });
    const result = await store.consumeRecoveryCode(codes[0]);
    assert.equal(result.ok, true, "an old-format file with no watermark file present consumes normally");
    const state = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(state.epoch, 1, "the epoch field is added on the first mutating write after upgrade");
  } finally { cleanup(dir); }
});

// ---- break-glass: recovery after BOTH the authenticator and every recovery
// code are lost ----
//
// The documented last resort for that operator is to delete this store and
// re-enroll on the next password sign-in. The watermark is a separate sibling
// file and survives that deletion, so the re-enrolled state must not be left
// behind it -- otherwise the fresh codes are wiped, unused, the first time they
// are needed.

test("break-glass: codes issued by a re-enroll after the store was deleted are usable", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    const first = await store.enroll(SECRET);
    await store.consumeRecoveryCode(first.codes[0]); // normal use advances the epoch
    assert.ok(JSON.parse(readFileSync(`${filePath}.watermark`, "utf8")).epoch > 0);

    rmSync(filePath, { force: true }); // operator deletes the store; watermark remains
    const second = await store.enroll(SECRET);
    assert.equal(second.ok, true);
    assert.equal(second.codes.length, 10);

    const rescue = await store.consumeRecoveryCode(second.codes[0]);
    assert.equal(rescue.ok, true, `fresh break-glass code rejected: ${rescue.reason}`);
    assert.equal(rescue.remaining, 9);
  } finally { cleanup(dir); }
});

test("break-glass: commit() re-key after a store deletion also clears the surviving watermark", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    const first = await store.enroll(SECRET);
    await store.consumeRecoveryCode(first.codes[0]);

    rmSync(filePath, { force: true });
    const second = await store.commit(SECRET); // resetup scope re-keys via commit()

    const rescue = await store.consumeRecoveryCode(second.codes[0]);
    assert.equal(rescue.ok, true, `fresh code after re-key rejected: ${rescue.reason}`);
  } finally { cleanup(dir); }
});

test("break-glass healing does NOT weaken a restored old backup is still caught", async () => {
  const { store, filePath, dir } = freshStore();
  try {
    const { codes } = await store.enroll(SECRET);
    const backup = readFileSync(filePath, "utf8"); // taken while all 10 were unused
    for (const code of codes.slice(0, 3)) await store.consumeRecoveryCode(code);

    writeFileSync(filePath, backup, { mode: 0o600 }); // resurrects the 3 spent codes
    const replay = await store.consumeRecoveryCode(codes[0]);
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, "reset_detected");
    assert.equal(await store.remainingRecoveryCodes(), 0, "poisoned set must be wiped");
  } finally { cleanup(dir); }
});
