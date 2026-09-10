// A system restore replaces .env, runtime/secrets/, runtime/generated/ and the
// database. Previewing first was only ever enforced by the browser flow, so a
// caller holding the restore grant could POST apply: true and skip it -- and
// runner.js sets DUNE_DB_ASSUME_YES, so db.sh's "Type RESTORE to confirm"
// prompt never gated the API path either.
//
// This records that a dry run actually succeeded, for this principal, against
// these exact archive bytes. Apply asks it before dispatching.
//
// Held in memory on purpose: auth.js keeps sessions the same way, a receipt is
// worthless once the process that issued it is gone, and persisting it would
// put a standing authorization to overwrite the host on disk. A console restart
// between preview and apply costs a re-preview.

const DEFAULT_MAX_ENTRIES = 64;

// Keyed on both, so one operator's preview cannot authorize another's apply and
// an API key cannot ride a browser session's preview. NUL separates them
// because it cannot occur in either half -- a printable separator would let a
// crafted principal and archive name shift the boundary between them.
function receiptKey(principal, archiveName) {
  return `${principal}\u0000${archiveName}`;
}

// A mode the preview did not carry may be chosen at apply: the preview is what
// tells the operator a conflict exists (BackupsPanel only asks for an audit-log
// answer when the preview reports one), so both callers legitimately preview
// with no modes and apply with them. Changing an explicit answer to a different
// explicit answer is not that, and is refused.
function modeCompatible(previewed, applied) {
  if (!previewed) return true;
  return previewed === applied;
}

export function createRestorePreviewReceipts({ now = () => Date.now(), ttlMs, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const receipts = new Map();

  function dropExpired(at) {
    for (const [key, receipt] of receipts) {
      if (receipt.expiresAt <= at) receipts.delete(key);
    }
  }

  // Bounded regardless of expiry: entries are only created by an authorized
  // principal completing a real dry run, but this map must not be the thing
  // that grows without limit on a long-lived console. Called AFTER the insert,
  // not before -- trimming first leaves maxEntries + 1 behind.
  function enforceBound() {
    while (receipts.size > maxEntries) {
      const oldest = receipts.keys().next();
      if (oldest.done) break;
      receipts.delete(oldest.value);
    }
  }

  return {
    // Called only when a dry-run task has SUCCEEDED. The hash is the one taken
    // before that run started -- see the plan: hashing afterwards would let a
    // file swapped mid-preview be the one apply is authorized against.
    record({ principal, archiveName, archiveHash, identityMode = "", auditLogMode = "" }) {
      const at = now();
      dropExpired(at);
      const key = receiptKey(principal, archiveName);
      // Re-previewing replaces rather than accumulates, so the newest preview
      // is the one that counts and a stale hash cannot linger beside it.
      receipts.delete(key);
      receipts.set(key, {
        principal,
        archiveName,
        archiveHash,
        identityMode,
        auditLogMode,
        previewedAt: at,
        expiresAt: at + ttlMs
      });
      enforceBound();
      return true;
    },

    // Distinct reasons rather than a bare false: each is a different thing for
    // the operator to do about it, and each is its own test case.
    verify({ principal, archiveName, archiveHash, identityMode = "", auditLogMode = "" }) {
      const at = now();
      // Looked up BEFORE expired entries are swept, so an expired preview says
      // so instead of reading as one that never happened. Both refuse; only one
      // tells the operator the archive was fine and the clock ran out.
      const key = receiptKey(principal, archiveName);
      const receipt = receipts.get(key);
      dropExpired(at);
      if (!receipt) return { ok: false, reason: "none" };
      if (receipt.expiresAt <= at) {
        receipts.delete(key);
        return { ok: false, reason: "expired" };
      }
      if (receipt.archiveHash !== archiveHash) return { ok: false, reason: "archive-changed" };
      if (!modeCompatible(receipt.identityMode, identityMode)) return { ok: false, reason: "options-changed" };
      if (!modeCompatible(receipt.auditLogMode, auditLogMode)) return { ok: false, reason: "options-changed" };
      return { ok: true, receipt };
    },

    // Consumed once the restore has actually succeeded. A FAILED apply leaves
    // it in place: Postgres being down should not also cost the operator their
    // preview, and the archive hash still has to match on the retry.
    consume({ principal, archiveName }) {
      return receipts.delete(receiptKey(principal, archiveName));
    },

    size() {
      return receipts.size;
    }
  };
}

// Why the apply was refused, in the operator's terms. The reason strings above
// are for tests and the audit log; these are what reaches the browser.
export function restorePreviewRejectionMessage(reason) {
  if (reason === "expired") {
    return "The preview of this archive has expired. Preview it again, then apply.";
  }
  if (reason === "archive-changed") {
    return "This archive changed after it was previewed. Preview it again, then apply.";
  }
  if (reason === "options-changed") {
    return "The restore options changed after the preview. Preview it again, then apply.";
  }
  return "This archive must be previewed successfully before it can be applied.";
}
