// The store behind the API-side preview-then-apply gate. Restoring a system
// backup replaces .env, runtime/secrets/, runtime/generated/ and the database,
// and until this existed the "preview first" rule was enforced only by the
// browser -- a caller could POST apply: true and skip it.
//
// Every case here is a property that, removed, lets an apply through that
// should have been refused. Each was checked by mutation, not by coverage.

import test from "node:test";
import assert from "node:assert/strict";
import { createRestorePreviewReceipts, restorePreviewRejectionMessage } from "../src/services/restorePreviewReceipts.js";

const ARCHIVE = "dune-system-20260907-004052-6506-28750.tar.gz.enc";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function makeStore({ ttlMs = 15 * 60 * 1000, start = 1_000_000, maxEntries } = {}) {
  let clock = start;
  const store = createRestorePreviewReceipts({ now: () => clock, ttlMs, maxEntries });
  return { store, advance: (ms) => { clock += ms; }, at: () => clock };
}

test("refuses an apply that was never previewed", () => {
  const { store } = makeStore();
  const verdict = store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "none");
});

test("allows an apply that matches its preview", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  assert.equal(store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH }).ok, true);
});

// The TOCTOU this exists for: preview archive A, swap the file, apply B.
test("refuses an apply when the archive changed after the preview", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  const verdict = store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: OTHER_HASH });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "archive-changed");
});

// An unreadable or missing archive hashes to "" in systemArchiveHash, which
// must not be treated as "no opinion" and matched against a recorded hash.
test("refuses an apply whose archive could not be hashed", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  assert.equal(store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: "" }).reason, "archive-changed");
});

test("refuses an apply once the preview has expired", () => {
  const { store, advance } = makeStore({ ttlMs: 60_000 });
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  advance(60_001);
  const verdict = store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "expired");
});

test("still allows an apply just inside the window", () => {
  const { store, advance } = makeStore({ ttlMs: 60_000 });
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  advance(59_999);
  assert.equal(store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH }).ok, true);
});

// The binding that stops a second operator, or an API key, riding someone
// else's preview.
test("does not let one principal's preview authorize another's apply", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  assert.equal(store.verify({ principal: "session:b", archiveName: ARCHIVE, archiveHash: HASH }).reason, "none");
  assert.equal(store.verify({ principal: "key:k1", archiveName: ARCHIVE, archiveHash: HASH }).reason, "none");
});

test("does not let a preview of one archive authorize applying another", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  const other = "dune-system-20260907-194126-7-6261.tar.gz.enc";
  assert.equal(store.verify({ principal: "session:a", archiveName: other, archiveHash: HASH }).reason, "none");
});

// Both callers preview with no modes and apply with them -- the preview is what
// tells the operator a conflict exists. Binding modes strictly would refuse
// every legitimate apply, so an unanswered mode may be answered at apply.
test("lets the operator answer a mode the preview did not carry", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  const verdict = store.verify({
    principal: "session:a",
    archiveName: ARCHIVE,
    archiveHash: HASH,
    identityMode: "adopt-backup",
    auditLogMode: "keep-current"
  });
  assert.equal(verdict.ok, true);
});

test("refuses an apply that changes a mode the preview already answered", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH, identityMode: "keep-current" });
  const verdict = store.verify({
    principal: "session:a",
    archiveName: ARCHIVE,
    archiveHash: HASH,
    identityMode: "adopt-backup"
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "options-changed");
});

test("refuses an apply that changes an audit-log answer the preview already made", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH, auditLogMode: "keep-current" });
  assert.equal(store.verify({
    principal: "session:a",
    archiveName: ARCHIVE,
    archiveHash: HASH,
    auditLogMode: "adopt-backup"
  }).reason, "options-changed");
});

test("consumes the receipt so a completed restore cannot be replayed", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  assert.equal(store.consume({ principal: "session:a", archiveName: ARCHIVE }), true);
  assert.equal(store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH }).reason, "none");
});

// Re-previewing must replace, not accumulate: otherwise the stale hash could
// still satisfy an apply after the operator previewed a changed archive.
test("keeps only the newest preview of an archive", () => {
  const { store } = makeStore();
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: OTHER_HASH });
  assert.equal(store.size(), 1);
  assert.equal(store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH }).reason, "archive-changed");
  assert.equal(store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: OTHER_HASH }).ok, true);
});

test("stays bounded rather than growing for the life of the console", () => {
  const { store } = makeStore({ maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) {
    store.record({ principal: `session:${i}`, archiveName: ARCHIVE, archiveHash: HASH });
  }
  assert.ok(store.size() <= 3, `expected at most 3 receipts, got ${store.size()}`);
});

test("drops expired receipts instead of retaining them", () => {
  const { store, advance } = makeStore({ ttlMs: 60_000 });
  store.record({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  advance(60_001);
  store.verify({ principal: "session:a", archiveName: ARCHIVE, archiveHash: HASH });
  assert.equal(store.size(), 0);
});

test("explains each refusal in terms of what the operator should do", () => {
  assert.match(restorePreviewRejectionMessage("none"), /previewed successfully/i);
  assert.match(restorePreviewRejectionMessage("expired"), /expired/i);
  assert.match(restorePreviewRejectionMessage("archive-changed"), /changed after it was previewed/i);
  assert.match(restorePreviewRejectionMessage("options-changed"), /options changed/i);
  // Every message tells them the way out.
  for (const reason of ["none", "expired", "archive-changed", "options-changed"]) {
    assert.match(restorePreviewRejectionMessage(reason), /preview/i);
  }
});
