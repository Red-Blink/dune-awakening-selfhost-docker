// Tier 3 second-factor store (console layered auth, RFC docs/rfc-console-auth.md
// §2.3 / §3.4). Persists the mandatory-TOTP + recovery-code state for the single
// built-in `local-owner` principal and mediates every read-modify-write through
// one serialized queue.
//
// Why the queue matters (this is the whole point of the phase): a single atomic
// *write* is not enough. Single-use recovery codes and TOTP replay-prevention are
// read-modify-write sequences -- read the current state, decide, persist the
// reduced state. The read and the write are async (non-blocking fs), so without
// serialization two concurrent logins could both read the same state before
// either writes, and both spend the same one-time recovery code (double spend) or
// both accept the same TOTP step counter (replay within one 30s step). Every
// mutating op runs inside runExclusive() so the read, the decision, and the
// persist are one uninterruptible critical section. Closes the carried-forward
// obligations from the recovery-code and TOTP module audits.
//
// SERIALIZATION IS IN-PROCESS AND PER-FILE. The queue only serializes callers of
// ONE store instance. Two instances over the same file would each have their own
// queue and could interleave -- reintroducing the exact double-spend/replay race
// this module prevents -- so construction is guarded to one live store per
// resolved path (see the registry below). The design assumes a single console
// process (RFC: sessions are in-memory); a future multi-process deployment would
// need file-level locking, not just this queue.
//
// On-disk shape (runtime/generated/console-second-factor.json, mode 0600):
//   { "version": 1,
//     "totp": { "secret": "<base64 raw bytes>", "lastUsedCounter": <int> },
//     "recoveryCodes": ["<64-hex digest>", ...],
//     "epoch": <int>, "factorVersion": <int> }
// factorVersion is distinct from epoch (below): epoch advances on every
// mutating op (including recovery-code consumption/regeneration, for
// rollback detection); factorVersion advances ONLY when the TOTP secret
// itself is replaced (enroll()/commit()), which is what lets commit() detect
// a stale concurrent recovery session -- see commit()'s own comment.
// The TOTP secret is stored as base64 of the RAW bytes and decoded to a Buffer
// at the verify boundary -- verifyTotpMatch is never handed base32.
// The secret is stored reversibly (base64 is encoding, not encryption) in a 0600
// file: acceptable for this phase because host-filesystem access already
// transcends console auth (RFC §3.4); encryption-at-rest is deferred to the
// separate KEK/DEK secrets system, a deliberate and recorded deferral.
//
// Backup/restore integrity (RFC §2.3.1): a monotonic `epoch`
// counter (bumped on every mutating op) plus an independent watermark file
// (`watermarkFilePath`, sibling to the main store, same 0600/atomic-write
// discipline) detect a restored-file rollback. On every consumeRecoveryCode()
// call the loaded state's epoch is compared against the watermark's highest
// ever seen; if the state is BEHIND the watermark, the file has moved
// backward in time relative to what this process previously observed, so the
// entire current recovery-code set is invalidated (not just the submitted
// code) and the call fails with reason "reset_detected" rather than
// consuming or silently rejecting -- an attacker replaying a resurrected,
// previously-spent code cannot succeed, and the operator must regenerate via
// Settings (already authenticated by TOTP, which self-heals on rollback and
// needs no special handling here) before recovery-code login works again.
// checkForRollback() offers the same comparison, read-only, for a startup
// informational banner (does not block boot -- TOTP is unaffected).
//
// Deliberate, honest limit: a backup/restore that replaces BOTH the store
// and its watermark consistently (the realistic outcome of restoring the
// whole runtime/generated/ directory, which is how this project's own backup
// guidance already assumes an operator restores) is NOT detectable by any
// local mechanism -- there is nothing left un-rolled-back to compare against.
// That case remains covered only by the existing documented operator
// guidance (RFC §3.4: regenerate recovery codes after ANY restore,
// unconditionally). This mechanism specifically catches the narrower, still
// real and plausible case of an operator or tool restoring the second-factor
// file alone (a single-file recovery from an old backup/tarball/object,
// distinct from a full-directory restore) while the watermark survives.

import { resolve as resolvePath } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { writeJsonAtomicAsync } from "../jsonStore.js";
import {
  generateRecoveryCodes,
  consumeRecoveryCode as consumeRecoveryCodePure,
} from "./recoveryCodes.js";
import { verifyTotpMatch, TOTP_SECRET_BYTES } from "./totp.js";

export const SECOND_FACTOR_VERSION = 1;
const NO_COUNTER = -1; // lastUsedCounter sentinel: no TOTP code consumed yet

// Thrown when the store file exists but cannot be parsed/validated. Callers on
// the auth path MUST treat this as "cannot verify the second factor" -> deny,
// NEVER as "no second factor configured" -> allow. A corrupt file must not be a
// 2FA bypass; recovery is the documented host-filesystem reset (RFC §3.4).
export class SecondFactorCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecondFactorCorruptError";
  }
}

// Thrown when the file's version is NEWER than this binary understands (e.g. a
// deploy rollback reading a version:2 file). Distinct from corruption because the
// remedy is the opposite: do NOT delete the file (it is good, live 2FA state) --
// upgrade the binary. Keeping this separate stops an operator following §3.4's
// "delete a corrupt file" guidance from destroying working state on a downgrade.
export class SecondFactorVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecondFactorVersionError";
  }
}

// One live store per resolved file path (see header). A second construction for
// the same path throws, turning the "singleton per file" contract into an
// enforced one rather than a comment a future wiring change could silently break.
const openPaths = new Set();

export function createSecondFactorStore({ filePath, watermarkFilePath }) {
  if (!filePath) throw new Error("createSecondFactorStore requires a filePath");
  const resolvedWatermarkPath = watermarkFilePath || `${filePath}.watermark`;
  const key = resolvePath(filePath);
  if (openPaths.has(key)) {
    throw new Error(
      `a second-factor store is already open for ${key}; construct one store per file at boot and share it (concurrent stores would defeat serialization)`
    );
  }
  openPaths.add(key);
  let closed = false;

  // Serializing queue (Promise chain), not a boolean lock: each op appends its
  // read-modify-write to the tail and awaits its own link, so ops run one at a
  // time in arrival order and never interleave across an await. A thrown op does
  // not break the chain for the next caller.
  let tail = Promise.resolve();
  function runExclusive(fn) {
    if (closed) return Promise.reject(new Error("second-factor store is closed"));
    const run = tail.then(fn, fn); // run regardless of the prior op's outcome
    tail = run.then(() => {}, () => {}); // keep the chain alive on rejection
    return run;
  }

  function persist(state) {
    return writeJsonAtomicAsync(filePath, state, 0o600);
  }

  // Watermark: the highest epoch this store has ever persisted, kept in an
  // independent file so a restore of the main store alone leaves something to
  // compare against (see the module header for what this does and does not
  // catch). Never throws on a missing/corrupt watermark -- a lost or
  // unreadable watermark degrades to "no rollback detectable yet", not a
  // second-factor outage; the main store's own corruption handling is what
  // must fail closed, not this side channel.
  async function loadWatermarkEpoch() {
    try {
      const raw = await readFile(resolvedWatermarkPath, "utf8");
      const parsed = JSON.parse(raw);
      return Number.isInteger(parsed?.epoch) ? parsed.epoch : 0;
    } catch {
      return 0;
    }
  }

  async function bumpWatermark(epoch) {
    const current = await loadWatermarkEpoch();
    if (epoch <= current) return;
    try {
      await writeJsonAtomicAsync(resolvedWatermarkPath, { version: 1, epoch }, 0o600);
    } catch {
      // Best-effort: a watermark write failure must never block the second
      // factor's own real write, which already succeeded by the time this runs.
    }
  }

  // Read + validate the current state. Returns null when genuinely absent
  // (enrollment should trigger); throws SecondFactorCorruptError when present but
  // unusable, or SecondFactorVersionError when present but newer than supported.
  async function loadRaw() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw new SecondFactorCorruptError(`second-factor store is unreadable (${err.code || "read error"})`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Deliberately does NOT echo the parser message (which can include file
      // content on some runtimes) -- a corrupt-file error must not leak the seed.
      throw new SecondFactorCorruptError("second-factor store is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || !Number.isInteger(parsed.version)) {
      throw new SecondFactorCorruptError("second-factor store has an unexpected shape");
    }
    if (parsed.version > SECOND_FACTOR_VERSION) {
      throw new SecondFactorVersionError(
        `second-factor store is version ${parsed.version}, newer than this console supports (${SECOND_FACTOR_VERSION}); upgrade the console -- do NOT delete this file`
      );
    }
    if (parsed.version !== SECOND_FACTOR_VERSION) {
      // Older, unknown version -- no migration path defined yet (v1 is the first).
      throw new SecondFactorCorruptError(`second-factor store has unsupported version ${parsed.version}`);
    }
    const totp = parsed.totp;
    if (!totp || typeof totp.secret !== "string" || !Number.isInteger(totp.lastUsedCounter)) {
      throw new SecondFactorCorruptError("second-factor store TOTP section is malformed");
    }
    // The secret must be valid base64 decoding to EXACTLY the length the
    // write path ever produces (assertSecretBytes/TOTP_SECRET_BYTES below) --
    // a corrupt-but-string secret would otherwise silently self-lock the
    // operator (every code invalid) instead of surfacing as corruption.
    // #616: this used to accept a permissive [10,64]-byte range instead of
    // matching the write-side constant exactly -- a secret partially
    // corrupted (or hand-edited) to some OTHER length inside that range was
    // accepted as non-corrupt, so verifyTotpToken computed codes against the
    // wrong-length secret and every code from the operator's real
    // authenticator was silently and permanently rejected, with the very
    // guard meant to explain why never firing.
    const secretBytes = Buffer.from(totp.secret, "base64");
    if (secretBytes.length !== TOTP_SECRET_BYTES || secretBytes.toString("base64") !== totp.secret) {
      throw new SecondFactorCorruptError("second-factor store TOTP secret is not valid base64 of a key");
    }
    if (!Array.isArray(parsed.recoveryCodes) || parsed.recoveryCodes.some((d) => typeof d !== "string")) {
      throw new SecondFactorCorruptError("second-factor store recoveryCodes section is malformed");
    }
    // epoch predates: a file written before this feature has no
    // field at all. Treated as 0, not corruption -- every existing install's
    // file continues to load exactly as before (Requirement 0).
    if (parsed.epoch !== undefined && !Number.isInteger(parsed.epoch)) {
      throw new SecondFactorCorruptError("second-factor store epoch is malformed");
    }
    parsed.epoch = Number.isInteger(parsed.epoch) ? parsed.epoch : 0;
    // factorVersion: bumped ONLY when the TOTP secret itself is replaced
    // (enroll()/commit()), unlike epoch above which also advances on every
    // recovery-code consumption/regeneration. This is what a resetup session
    // (recovery login) snapshots and re-checks at confirm time (review finding,
    // upstream PR #201, 2026-09-06): two outstanding recovery sessions both
    // bump epoch merely by being minted, so epoch alone can't tell "the factor
    // I'm about to replace is still the one I started from" from "someone else
    // also just logged in via recovery" -- factorVersion can, since only an
    // actual secret replacement moves it. Same missing-field-means-0 backward
    // compatibility as epoch.
    if (parsed.factorVersion !== undefined && !Number.isInteger(parsed.factorVersion)) {
      throw new SecondFactorCorruptError("second-factor store factorVersion is malformed");
    }
    parsed.factorVersion = Number.isInteger(parsed.factorVersion) ? parsed.factorVersion : 0;
    // recoveryPending (review finding, upstream PR #201, 2026-09-08): set the
    // instant a recovery code is consumed, cleared only by a successful
    // commit() (a fresh makeState() never carries it forward). Missing field
    // means false, same backward-compatibility pattern as epoch/factorVersion
    // -- a file written before this existed has no in-progress recovery.
    if (parsed.recoveryPending !== undefined && typeof parsed.recoveryPending !== "boolean") {
      throw new SecondFactorCorruptError("second-factor store recoveryPending is malformed");
    }
    parsed.recoveryPending = Boolean(parsed.recoveryPending);
    return parsed;
  }

  function assertSecretBytes(secretBytes) {
    if (!Buffer.isBuffer(secretBytes) && !(secretBytes instanceof Uint8Array)) {
      throw new TypeError("second-factor store requires raw TOTP secret bytes (not base32)");
    }
    if (secretBytes.length !== TOTP_SECRET_BYTES) {
      throw new RangeError(`TOTP secret must be ${TOTP_SECRET_BYTES} bytes, got ${secretBytes.length}`);
    }
  }

  // initialCounter seeds totp.lastUsedCounter so the enrollment-confirm code's
  // own step is already "used" -- the RFC (§4) forbids reusing the confirm code
  // at the forced first login, and seeding the matched step enforces that.
  // epoch is's rollback-detection counter (see module header) --
  // enroll() always starts a fresh install at 0; commit() carries the prior
  // state's epoch forward (or starts at 0 if none existed) so a legitimate
  // rotation is never mistaken for the backward jump it's meant to catch.
  function makeState(secretBytes, digests, initialCounter = NO_COUNTER, epoch = 0, factorVersion = 0) {
    if (!Number.isInteger(initialCounter) || initialCounter < NO_COUNTER) {
      throw new RangeError(`initialCounter must be an integer >= ${NO_COUNTER}, got ${initialCounter}`);
    }
    return {
      version: SECOND_FACTOR_VERSION,
      totp: { secret: Buffer.from(secretBytes).toString("base64"), lastUsedCounter: initialCounter },
      recoveryCodes: digests,
      epoch,
      factorVersion,
    };
  }

  async function persistAndBumpWatermark(state) {
    await persist(state);
    await bumpWatermark(state.epoch);
  }

  // ---- public API (all mutating ops serialized through runExclusive) ----

  // True iff a usable TOTP state exists. Throws on corruption/newer-version (fail
  // closed) -- callers must not treat a throw as "not configured".
  function isConfigured() {
    return runExclusive(async () => (await loadRaw()) !== null);
  }

  // Read-only rollback check for a startup informational banner.
  // Never throws, never blocks boot, never mutates anything -- a corrupt or
  // unreadable store/watermark degrades to "nothing to report" here, since
  // the store's own corruption handling (fail closed on the auth path) is
  // what actually matters; this is advisory only.
  async function checkForRollback() {
    let state;
    try {
      state = await loadRaw();
    } catch {
      return { detected: false };
    }
    if (state === null) return { detected: false };
    const watermarkEpoch = await loadWatermarkEpoch();
    return { detected: state.epoch < watermarkEpoch };
  }

  // Atomic first-time enrollment: create the second factor ONLY if none exists,
  // in one critical section (no check-then-act gap). Returns { ok:true, codes }
  // with the one-time plaintext recovery codes, or { ok:false, reason:
  // "already_configured" } without touching existing state. Use this for setup;
  // use commit() only for a deliberate rotation that overwrites.
  function enroll(secretBytes, { count, initialCounter } = {}) {
    return runExclusive(async () => {
      assertSecretBytes(secretBytes);
      if ((await loadRaw()) !== null) return { ok: false, reason: "already_configured" };
      const { codes, digests } = count ? generateRecoveryCodes(count) : generateRecoveryCodes();
      // Seed from the watermark, NOT 0. Break-glass is the case that matters:
      // an operator who has lost both authenticator and recovery codes recovers
      // by deleting this store (exactly what the login 503 text tells them to
      // do) and re-enrolling on the next password sign-in. The watermark is a
      // SEPARATE sibling file and survives that deletion, so a hardcoded 0 left
      // the fresh state permanently behind it -- consumeRecoveryCode would then
      // read epoch 0 < watermark N, treat the brand-new factor as a restored
      // backup, and wipe all ten unused codes on first use. The operator only
      // discovers it the next time they have lost their device, i.e. precisely
      // when this is their last resort. A fresh install has no watermark, so
      // this still starts at 0 there.
      // Seed STRICTLY ABOVE any surviving watermark (W+1), not AT it. A used
      // factor always advances the watermark to >= 1, so `> 0` distinguishes a
      // break-glass re-enroll (store deleted, watermark survived) from a genuine
      // fresh install (no watermark, epoch 0). Seeding at exactly W left the
      // fresh factor at the SAME epoch as a retained old store file (also W), so
      // restoring that old file passed the `epoch < watermark` check (W < W is
      // false) and resurrected its already-spent recovery codes. W+1 puts the
      // old file strictly behind, so the restore is detected.
      const seedWatermark = await loadWatermarkEpoch();
      await persistAndBumpWatermark(makeState(secretBytes, digests, initialCounter, seedWatermark > 0 ? seedWatermark + 1 : 0, 0));
      return { ok: true, codes };
    });
  }

  // Overwrite the second factor with a fresh TOTP secret + recovery-code set
  // (deliberate rotation / re-key). Unconditional UNLESS the caller passes
  // expectedFactorVersion -- callers wanting enroll-if-absent must use
  // enroll(). Returns { ok:true, codes } or, when expectedFactorVersion is
  // given and stale, { ok:false, reason:"stale_generation" } without touching
  // the current (newer) factor.
  //
  // expectedFactorVersion closes a real gap (review finding, upstream PR
  // #201, 2026-09-06): a recovery login snapshots factorVersion at the moment
  // its recovery code is consumed and carries it on the resulting resetup
  // session (see server.js). Two resetup sessions opened from two different
  // recovery codes both start from the SAME factorVersion; the first one to
  // confirm legitimately replaces the factor and bumps it. Without this
  // check, the second (now-stale) session's confirm would still unconditionally
  // overwrite via the same commit() call, silently reverting the operator's
  // just-replaced authenticator to one the operator never actually finished
  // setting up in that browser tab -- both confirms returning 200, and the
  // authenticator that "won" depending only on which HTTP request happened to
  // be handled last. Checked against factorVersion, not epoch: epoch also
  // advances on every recovery-code consumption (including the second
  // session's own), so an epoch-based check would have wrongly rejected the
  // FIRST (legitimate) confirm too, since epoch had already moved once
  // between the two sessions being minted.
  function commit(secretBytes, { count, initialCounter, expectedFactorVersion } = {}) {
    return runExclusive(async () => {
      assertSecretBytes(secretBytes);
      // loadRaw() returns null ONLY for a genuinely-absent store; it THROWS
      // SecondFactorVersionError / SecondFactorCorruptError for a
      // newer-than-supported or unreadable store. Those must propagate (fail
      // closed) -- the previous `.catch(() => null)` swallowed them, letting a
      // re-key overwrite a newer store with a fresh v1 and destroy exactly the
      // state the version guard exists to protect.
      const previous = await loadRaw();
      if (expectedFactorVersion !== undefined && (previous === null || previous.factorVersion !== expectedFactorVersion)) {
        return { ok: false, reason: "stale_generation" };
      }
      // Never land at or below the watermark -- same break-glass reasoning as
      // enroll() above. `previous` is null when the store was deleted and this
      // is a re-key rather than a rotation, which is exactly when (-1)+1 = 0
      // would put the new state behind a surviving watermark.
      // Same break-glass reasoning as enroll(): never land AT or below a
      // surviving watermark. When `previous` is null (deleted store re-key) and
      // a watermark survived at W, seed W+1 so a restored old file (<= W) is
      // detected as a rollback rather than silently accepted at the same epoch.
      const commitWatermark = await loadWatermarkEpoch();
      const epoch = Math.max((previous?.epoch ?? -1) + 1, commitWatermark > 0 ? commitWatermark + 1 : 0);
      const factorVersion = (previous?.factorVersion ?? -1) + 1;
      const { codes, digests } = count ? generateRecoveryCodes(count) : generateRecoveryCodes();
      await persistAndBumpWatermark(makeState(secretBytes, digests, initialCounter, epoch, factorVersion));
      return { ok: true, codes };
    });
  }

  // Verify a TOTP token with replay prevention: accept only if valid AND its
  // matched step counter is strictly greater than the last consumed one, then
  // persist the new counter. Returns { ok, reason }: reason is "not_configured",
  // "invalid" (no step matched), or "replay" (matched an already-used step).
  function verifyTotpToken(token, timeSeconds, options = {}) {
    return runExclusive(async () => {
      const state = await loadRaw();
      if (state === null) return { ok: false, reason: "not_configured" };
      // The old authenticator must not still log in normally once a recovery
      // has been started against it (review finding, upstream PR #201,
      // 2026-09-08) -- checked before even attempting to verify the token, so
      // a still-valid old code can never succeed during the pending window.
      if (state.recoveryPending) return { ok: false, reason: "recovery_pending" };
      const secretBytes = Buffer.from(state.totp.secret, "base64");
      const { valid, counter } = verifyTotpMatch(secretBytes, token, timeSeconds, options);
      if (!valid) return { ok: false, reason: "invalid" };
      if (counter <= state.totp.lastUsedCounter) return { ok: false, reason: "replay" };
      state.totp.lastUsedCounter = counter;
      await persist(state);
      return { ok: true };
    });
  }

  // Consume a recovery code (single-use). On success the digest is removed and
  // the reduced set persisted, all inside the critical section so the same code
  // cannot be spent twice by concurrent logins. Returns { ok, reason, remaining }.
  //
  // Rollback check happens here, not on every read: this is the one
  // operation a resurrected old code could exploit, so it's the one place the
  // cost of the watermark comparison is worth paying. If the loaded state is
  // behind the watermark, the whole set is poisoned -- wiped, not consumed --
  // and the call fails with reason "reset_detected" before the submitted code
  // is even checked, so a resurrected previously-spent code can never succeed
  // by riding along with this call.
  function consumeRecoveryCode(code) {
    return runExclusive(async () => {
      const state = await loadRaw();
      if (state === null) return { ok: false, reason: "not_configured" };
      const watermarkEpoch = await loadWatermarkEpoch();
      if (state.epoch < watermarkEpoch) {
        state.recoveryCodes = [];
        state.epoch = watermarkEpoch + 1;
        await persistAndBumpWatermark(state);
        return { ok: false, reason: "reset_detected", remaining: 0 };
      }
      // A recovery already in progress (review finding, upstream PR #201,
      // 2026-09-08): the first successful consumption below already wiped
      // every sibling code, so any further code would fail as "unknown"
      // regardless -- checked explicitly here only so the caller can give an
      // accurate "recovery already started" message instead of "wrong code".
      if (state.recoveryPending) return { ok: false, reason: "recovery_pending" };
      const result = consumeRecoveryCodePure(code, state.recoveryCodes);
      if (!result.ok) return { ok: false, reason: result.reason };
      // Atomic invalidation on the FIRST successful consumption (review
      // finding, upstream PR #201, 2026-09-08 -- docs/rfc-console-auth.md's
      // "atomically invalidates the entire old recovery-code set" promise was
      // previously only honored at commit() time, leaving a window where
      // sibling codes could start a second resetup session and the old TOTP
      // secret still logged in normally). Rather than keep `result.remaining`
      // (only the submitted code removed), wipe the WHOLE set and mark the
      // existing factor recovery-pending in the same persisted write --
      // durable across a restart, since this is the same JSON file/write path
      // every other mutation here already uses.
      state.recoveryCodes = [];
      state.recoveryPending = true;
      state.epoch += 1;
      await persistAndBumpWatermark(state);
      // factorVersion is returned (not advanced -- consuming a code doesn't
      // change the factor) so the caller can snapshot "the factor I'm
      // starting a resetup session against" and hand it back to commit() as
      // expectedFactorVersion, closing the concurrent-recovery-session gap
      // described on commit() above.
      return { ok: true, remaining: 0, factorVersion: state.factorVersion };
    });
  }

  // Regenerate the recovery-code set (invalidating all current codes). Returns
  // { ok:true, codes } with the one-time plaintext codes, or
  // { ok:false, reason:"not_configured" }. TOTP secret/counter are untouched.
  //
  // Heals a detected rollback rather than leaving it armed. A plain
  // `epoch += 1` was a trap: after a single-file restore the loaded epoch is
  // BELOW the watermark, `bumpWatermark` no-ops while `epoch <= current`, and
  // the freshly-issued set is therefore wiped unread by the next
  // consumeRecoveryCode() -- so the remedy the console's own rollback banner
  // tells the operator to perform produced codes guaranteed to fail in the one
  // emergency they exist for. Regeneration behind fresh password+TOTP proof is
  // exactly the deliberate, authenticated event that should RESOLVE a rollback,
  // which is why it clears the condition the way consumeRecoveryCode() does
  // (and clear() does by deleting the watermark outright).
  function regenerateRecoveryCodes({ count } = {}) {
    return runExclusive(async () => {
      const state = await loadRaw();
      if (state === null) return { ok: false, reason: "not_configured" };
      // Review finding: a concurrent consumeRecoveryCode() call (a resetup
      // already in progress against this same factor) can set
      // recoveryPending in the window between the caller's own
      // requireFreshTier3Proof.verifyTotpToken() check and this call --
      // those are two SEPARATE runExclusive() critical sections, not one
      // atomic transaction. Without this check, this would persist a fresh
      // code set that verifyTotpToken()/consumeRecoveryCode() immediately
      // refuse (their own recoveryPending check, above), handing the
      // operator ten plaintext codes that can never work -- and the
      // in-progress resetup's own commit() would silently replace them
      // again anyway. Same reason, same refusal shape as those two.
      if (state.recoveryPending) return { ok: false, reason: "recovery_pending" };
      const watermarkEpoch = await loadWatermarkEpoch();
      const healedRollback = state.epoch < watermarkEpoch;
      const { codes, digests } = count ? generateRecoveryCodes(count) : generateRecoveryCodes();
      state.recoveryCodes = digests;
      state.epoch = Math.max(state.epoch, watermarkEpoch) + 1;
      await persistAndBumpWatermark(state);
      return { ok: true, codes, healedRollback };
    });
  }

  // How many unused recovery codes remain (for the settings UI). Throws on
  // corruption/newer-version.
  function remainingRecoveryCodes() {
    return runExclusive(async () => {
      const state = await loadRaw();
      return state === null ? 0 : state.recoveryCodes.length;
    });
  }

  // Remove all second-factor state (the documented total-loss host reset, RFC
  // §3.4, and the pre-rotation clear). Idempotent. Also removes the watermark
  //: a deliberate reset must start genuinely fresh at epoch 0, or the
  // very next recovery-code use after re-enrollment would find epoch 0 behind
  // the old watermark and wrongly treat this intentional reset as the
  // backward-file-move it's meant to catch.
  function clear() {
    return runExclusive(async () => {
      await rm(filePath, { force: true });
      await rm(resolvedWatermarkPath, { force: true });
      return { ok: true };
    });
  }

  // Release this store's hold on its path (for teardown / tests). After close(),
  // further ops reject and the path can be re-opened.
  function close() {
    closed = true;
    openPaths.delete(key);
  }

  return {
    isConfigured,
    checkForRollback,
    enroll,
    commit,
    verifyTotpToken,
    consumeRecoveryCode,
    regenerateRecoveryCodes,
    remainingRecoveryCodes,
    clear,
    close,
  };
}
