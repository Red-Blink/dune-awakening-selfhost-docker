import { redactDbError } from "../db.js";

// Turns a flushBaseRefillQueues result into the lines a restart task shows the
// operator.
//
// Pulled out of TaskManager so it can be tested directly. It is the only
// operator-facing account of a queued write's outcome -- the audit log records
// one too, but nobody reads that while watching a restart, and the request was
// accepted hours earlier.
//
// Every queue flushBaseRefillQueues can run needs an entry here. Without one it
// falls through to the unknown-queue wording below, deliberately vague rather
// than wrong: the previous code treated anything not tagged "water" as a
// generator refill, so an applied base delete was reported to operators as
// "Applied 1 queued generator refill."
const QUEUES = [
  {
    type: "generator",
    applied: (n) => `Applied ${n} queued generator refill${plural(n)}.`,
    cleared: (n) => `Cleared ${n} obsolete generator refill${plural(n)}; the base or its generators no longer exist.`,
    label: "generator refills",
    labelOne: "generator refill"
  },
  {
    type: "water",
    applied: (n) => `Applied ${n} queued water refill${plural(n)}.`,
    cleared: (n) => `Cleared ${n} obsolete water refill${plural(n)}; the base or its water storage no longer exists.`,
    label: "water refills",
    labelOne: "water refill"
  },
  {
    type: "delete",
    applied: (n) => `Applied ${n} queued base delete${plural(n)}.`,
    cleared: (n) => `Cleared ${n} queued base delete${plural(n)}; the base no longer exists.`,
    label: "base deletes",
    labelOne: "base delete"
  },
  {
    type: "childAccess",
    applied: (n) => `Applied ${n} queued base permission change${plural(n)}.`,
    cleared: (n) => `Cleared ${n} queued base permission change${plural(n)}; none of those pieces are still part of that base.`,
    label: "base permission changes",
    labelOne: "base permission change"
  },
  {
    type: "vehicle-delete",
    applied: (n) => `Applied ${n} queued vehicle delete${plural(n)}.`,
    cleared: (n) => `Cleared ${n} queued vehicle delete${plural(n)}; the vehicle no longer exists.`,
    label: "vehicle deletes",
    labelOne: "vehicle delete"
  }
];

const UNKNOWN_QUEUE = {
  type: "",
  applied: (n) => `Applied ${n} queued map write${plural(n)}.`,
  cleared: (n) => `Cleared ${n} obsolete queued map write${plural(n)}.`,
  label: "map writes",
  labelOne: "map write"
};

function plural(n) {
  return n === 1 ? "" : "s";
}

// The whole-queue wording stays plural ("Queued base deletes were not applied")
// because it names the queue, not a count. A counted line has to agree with its
// number: "1 queued base deletes" is the kind of thing an operator reads as a
// bug in the console rather than a report about their server.
function countedLabel(queue, n) {
  return n === 1 ? queue.labelOne : queue.label;
}

function queueFor(type) {
  return QUEUES.find((queue) => queue.type === type) || UNKNOWN_QUEUE;
}

// An entry that succeeded but found its target already gone: a refill reports
// noLongerApplicable, a delete reports alreadyGone. Both mean the request is
// resolved without a write, which reads differently to an operator than an
// applied one and so gets its own line.
function isCleared(entry) {
  // A child-access entry applies in batches of 100, each its own transaction,
  // so a later batch finding its pieces gone still leaves earlier ones written.
  // The cleared wording says "none of those pieces are still part of that base",
  // which would be a false report of a base whose doors did change.
  if (Number(entry.updated) > 0) return false;
  return entry.noLongerApplicable === true || entry.alreadyGone === true;
}

// Redacted here rather than relying on db.js redacting at the query boundary.
// That inherited guarantee holds today, but this string is operator-facing and
// an error reaching it from anywhere other than a pg query would bypass it.
// redactDbError, not plain redact: only the former strips connection strings
// and password= pairs. It reads just .message, so a bare string is wrapped.
function firstError(entries) {
  const found = entries.find((entry) => entry.error);
  return found ? redactDbError({ message: String(found.error) }) : "unknown error";
}

export function summarizeMapWriteFlush(result) {
  const entries = Array.isArray(result?.flushed) ? result.flushed : [];
  const lines = [];

  const byQueue = QUEUES.concat(UNKNOWN_QUEUE).map((queue) => ({
    queue,
    entries: entries.filter((entry) => queueFor(entry?.refillType || "") === queue)
  }));

  for (const { queue, entries: own } of byQueue) {
    const applied = own.filter((entry) => entry.ok && !isCleared(entry));
    if (applied.length) lines.push({ text: queue.applied(applied.length), stream: "stdout" });
  }
  for (const { queue, entries: own } of byQueue) {
    const cleared = own.filter((entry) => entry.ok && isCleared(entry));
    if (cleared.length) lines.push({ text: queue.cleared(cleared.length), stream: "stdout" });
  }

  // Per-entry failures. Retained and dropped are reported separately because
  // they need different reactions: a retained entry applies itself on a later
  // restart, a dropped one is gone and the operator has to re-request it.
  for (const { queue, entries: own } of byQueue) {
    const failed = own.filter((entry) => entry.ok === false);
    const dropped = failed.filter((entry) => entry.dropped === true);
    const retained = failed.filter((entry) => entry.dropped !== true);
    if (retained.length) {
      lines.push({
        text: `${retained.length} queued ${countedLabel(queue, retained.length)} could not be applied and stay queued: ${firstError(retained)}`,
        stream: "stderr"
      });
    }
    if (dropped.length) {
      lines.push({
        text: `${dropped.length} queued ${countedLabel(queue, dropped.length)} ${dropped.length === 1 ? "was" : "were"} dropped and must be requested again: ${firstError(dropped)}`,
        stream: "stderr"
      });
    }
  }

  // Whole-queue failures: the pass never got as far as individual entries.
  for (const failure of result?.failures || []) {
    lines.push({
      text: `Queued ${queueFor(failure?.refillType || "").label} were not applied: ${firstError([failure])}`,
      stream: "stderr"
    });
  }

  return lines;
}
