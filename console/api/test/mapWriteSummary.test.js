import test from "node:test";
import assert from "node:assert/strict";
import { summarizeMapWriteFlush } from "../src/services/mapWriteSummary.js";

const text = (result) => summarizeMapWriteFlush(result).map((line) => line.text);

test("reports applied and cleared entries per queue, not just refills", () => {
  assert.deepEqual(text({
    flushed: [
      { ok: true, refillType: "generator" },
      { ok: true, refillType: "water" },
      { ok: true, refillType: "delete" },
      { ok: true, refillType: "childAccess" },
      { ok: true, refillType: "vehicle-delete" },
      { ok: true, refillType: "delete", alreadyGone: true },
      { ok: true, refillType: "generator", noLongerApplicable: true }
    ]
  }), [
    "Applied 1 queued generator refill.",
    "Applied 1 queued water refill.",
    "Applied 1 queued base delete.",
    "Applied 1 queued base permission change.",
    "Applied 1 queued vehicle delete.",
    "Cleared 1 obsolete generator refill; the base or its generators no longer exist.",
    "Cleared 1 queued base delete; the base no longer exists."
  ]);
});

// The bug this replaces: anything not tagged "water" was counted as a
// generator refill, so an applied base delete was reported to the operator as
// "Applied 1 queued generator refill."
test("a base delete is never reported as a generator refill", () => {
  const lines = text({ flushed: [{ ok: true, refillType: "delete" }] });
  assert.deepEqual(lines, ["Applied 1 queued base delete."]);
});

test("per-entry failures are reported instead of silently dropped", () => {
  assert.deepEqual(text({
    flushed: [
      { ok: true, refillType: "delete" },
      { ok: false, refillType: "delete", error: "This base was picked up into a backup and is no longer claimed." },
      { ok: false, refillType: "delete", error: "still blocked" }
    ]
  }), [
    "Applied 1 queued base delete.",
    "2 queued base deletes could not be applied and stay queued: This base was picked up into a backup and is no longer claimed."
  ]);
});

// Retained and dropped need different reactions from the operator, so they get
// separate lines: a retained entry applies itself later, a dropped one is gone.
test("dropped entries are reported apart from retained ones", () => {
  assert.deepEqual(text({
    flushed: [
      { ok: false, refillType: "vehicle-delete", error: "still blocked" },
      { ok: false, refillType: "vehicle-delete", error: "gave up", dropped: true },
      { ok: false, refillType: "vehicle-delete", expired: true, dropped: true, error: "Queued for longer than the 168h limit without being applied." }
    ]
  }), [
    "1 queued vehicle delete could not be applied and stay queued: still blocked",
    "2 queued vehicle deletes were dropped and must be requested again: gave up"
  ]);
});

test("whole-queue failures name the queue that actually failed", () => {
  assert.deepEqual(text({
    flushed: [],
    failures: [
      { refillType: "childAccess", error: "database unavailable" },
      { refillType: "vehicle-delete", error: "backup failed" }
    ]
  }), [
    "Queued base permission changes were not applied: database unavailable",
    "Queued vehicle deletes were not applied: backup failed"
  ]);
});

test("an unrecognized queue reports vaguely rather than as the wrong queue", () => {
  assert.deepEqual(text({
    flushed: [{ ok: true, refillType: "somethingNew" }],
    failures: [{ refillType: "somethingNew", error: "boom" }]
  }), [
    "Applied 1 queued map write.",
    "Queued map writes were not applied: boom"
  ]);
});

test("nothing to report produces no lines", () => {
  assert.deepEqual(text({ flushed: [] }), []);
  assert.deepEqual(text(undefined), []);
});

test("failures are tagged stderr and successes stdout", () => {
  const lines = summarizeMapWriteFlush({
    flushed: [{ ok: true, refillType: "water" }, { ok: false, refillType: "water", error: "no" }]
  });
  assert.deepEqual(lines.map((line) => line.stream), ["stdout", "stderr"]);
});

// "1 queued base deletes" reads as a bug in the console rather than a report
// about the server, so a counted line agrees with its number.
test("counted lines agree with their number", () => {
  assert.deepEqual(text({ flushed: [{ ok: false, refillType: "delete", error: "blocked" }] }),
    ["1 queued base delete could not be applied and stay queued: blocked"]);
  assert.deepEqual(text({ flushed: [{ ok: false, refillType: "delete", error: "gave up", dropped: true }] }),
    ["1 queued base delete was dropped and must be requested again: gave up"]);
});

// The cleared branch for this queue was previously unreachable: nothing set
// noLongerApplicable on a childAccess entry, so an obsolete permission change
// could only ever be reported as applied or failed.
test("an obsolete base permission change reports as cleared, not applied", () => {
  assert.deepEqual(text({ flushed: [{ ok: true, refillType: "childAccess", noLongerApplicable: true, updated: 0 }] }),
    ["Cleared 1 queued base permission change; none of those pieces are still part of that base."]);
});

// The warning text is operator-facing, so it must not carry a secret even if
// one reaches it from outside the pg path that db.js already redacts.
test("per-entry error text is redacted", () => {
  const lines = text({ flushed: [{ ok: false, refillType: "delete", error: 'connect failed for postgres://dune:hunter2@10.0.0.5:5432/dune' }] });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /hunter2/, "credentials must not survive into the task panel");
});

// A child-access entry applies in batches of 100, each its own transaction, so
// a later batch finding its pieces gone still leaves earlier ones written. The
// cleared wording says "none of those pieces are still part of that base",
// which would be a false report of a base whose doors did change.
test("a partially-applied permission change reports as applied, not cleared", () => {
  assert.deepEqual(text({ flushed: [{ ok: true, refillType: "childAccess", noLongerApplicable: true, updated: 100 }] }),
    ["Applied 1 queued base permission change."]);
});

// Whole-queue failures go through the same redaction as per-entry ones: this
// text is operator-facing and a pg driver error routinely quotes the DSN.
test("whole-queue failure text is redacted too", () => {
  const lines = text({
    flushed: [],
    failures: [{ refillType: "delete", error: "connect failed for postgres://dune:hunter2@10.0.0.5:5432/dune" }]
  });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /hunter2/, "credentials must not survive into the task panel");
  assert.match(lines[0], /Queued base deletes were not applied/);
});
