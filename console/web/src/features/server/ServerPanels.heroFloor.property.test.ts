import { describe, expect, it } from "vitest";
import serverPanelsSource from "./ServerPanels.tsx?raw";
import {
  applyHeroHealthFloor,
  heroReadsGreen,
  homeOverallHeading,
  homeStateDotTone,
  summarizeHomeStatus
} from "./ServerPanels";
import { FAILING_READINESS, MAPS, READY_READINESS, statusText } from "./homeStatusFixtures";

// The hero heading has three times read green over a non-OK row, each time
// through a different branch, because "OK" is produced in four independent
// expressions. Example-based tests are what let it recur: each fix pinned the
// one branch that had just been reported.
//
// These are exhaustive rather than randomised. The row card vocabulary is a
// closed set of eight shapes, so enumerating it outright is both stronger than
// property-based generation (no seed luck) and non-flaky (no seeds at all).
// Please do not swap this for fast-check.

// Every (value, status) pair a Readiness & Health row can carry. SOURCE GUARD
// below fails if ServerPanels.tsx grows a shape this table does not have -- when
// it does, ADD THE NEW SHAPE HERE and re-read the properties. Do not loosen the
// guard's regex.
const ROW_CARDS = [
  { value: "OK", status: "Ready" },
  { value: "Needs Review", status: "WARN" },
  { value: "Warming", status: "Starting" },
  { value: "Waiting", status: "Starting" },
  { value: "Getting Ready", status: "Starting" },
  { value: "Stopped", status: "FAILED" },
  { value: "Token Mismatch Detected", status: "FAILED" },
  { value: "Unknown", status: "Unknown" }
] as const;

// Every value the Overall ternary and its fallbacks can produce, including the
// friendlyHomeOverall passthrough words that inferStatus badges green -- the
// producer no guard ever covered.
const HERO_CANDIDATES = [
  "OK", "Needs Review", "Starting", "Stopping", "Restarting Battlegroup",
  "Stopped", "Warming", "Waiting", "Checking", "Unknown", "Status loaded",
  "Status loaded, readiness warning", "Readiness checked",
  "Healthy", "Running", "Listening", "Up", "Succeeded", "Found", "Checked"
] as const;

const ROW_COUNT = 5;

function everyRowVector(): { value: string; status: string }[][] {
  let vectors: { value: string; status: string }[][] = [[]];
  for (let i = 0; i < ROW_COUNT; i += 1) {
    const next: { value: string; status: string }[][] = [];
    for (const vector of vectors) for (const card of ROW_CARDS) next.push([...vector, card]);
    vectors = next;
  }
  return vectors;
}

// Mirrors homeHealthRowSeverity's intent without importing it -- asserting
// against the implementation's own classifier would be a tautology.
function rowIsBad(row: { value: string; status: string }) {
  return !/^OK$/i.test(row.value) && !/^Unknown$/i.test(row.status);
}

function rowIsFailOrWarn(row: { value: string; status: string }) {
  return rowIsBad(row) && !/^Starting$/i.test(row.status);
}

describe("the hero is never greener than its worst row", () => {
  const vectors = everyRowVector();

  it("enumerates the whole closed input space", () => {
    expect(vectors.length).toBe(Math.pow(ROW_CARDS.length, ROW_COUNT));
    expect(vectors.length * HERO_CANDIDATES.length).toBeGreaterThan(600_000);
  });

  // Violations are collected and asserted once. An expect() inside a 600k loop
  // is the difference between a fraction of a second and half a minute, and a
  // slow test is a deleted test.
  it("never renders Ready above a row that is not OK", () => {
    const violations: string[] = [];
    for (const rows of vectors) {
      if (!rows.some(rowIsBad)) continue;
      for (const candidate of HERO_CANDIDATES) {
        const gated = applyHeroHealthFloor(candidate, rows);
        // Asserted through the RENDERING function, not the gate's own
        // classifier: this is literally "the operator never reads Ready above a
        // bad row".
        if (homeOverallHeading(gated) === "Ready") {
          violations.push(`${candidate} -> ${gated} over [${rows.map((r) => r.value).join(", ")}]`);
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations.length).toBe(0);
  });

  // Defence in depth for the dot, which escalates on FAILED rows only. Rather
  // than widen that escalation to warn -- a second severity classifier that can
  // disagree with the first -- assert the composed result here.
  it("never shows a green dot with a failed or warning row", () => {
    const violations: string[] = [];
    for (const rows of vectors) {
      if (!rows.some(rowIsFailOrWarn)) continue;
      for (const candidate of HERO_CANDIDATES) {
        const gated = applyHeroHealthFloor(candidate, rows);
        if (homeStateDotTone(gated, rows) === "ok") violations.push(`${candidate} -> ${gated}`);
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations.length).toBe(0);
  });

  it("returns a non-green heading byte-identical", () => {
    const violations: string[] = [];
    for (const rows of vectors) {
      for (const candidate of HERO_CANDIDATES) {
        if (heroReadsGreen(candidate)) continue;
        const gated = applyHeroHealthFloor(candidate, rows);
        if (gated !== candidate) violations.push(`${candidate} -> ${gated}`);
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations.length).toBe(0);
  });

  it("never manufactures green", () => {
    const violations: string[] = [];
    for (const rows of vectors) {
      for (const candidate of HERO_CANDIDATES) {
        if (heroReadsGreen(candidate)) continue;
        if (heroReadsGreen(applyHeroHealthFloor(candidate, rows))) violations.push(candidate);
      }
    }
    expect(violations.length).toBe(0);
  });

  // The anti-silence mechanism. A future producer that invents a new hero
  // string, or mirrors a new row value, fails HERE -- which forces whoever adds
  // it to extend the enumeration, which re-runs every property above against it.
  it("only ever emits a value from the known vocabulary", () => {
    const allowed = new Set<string>([...HERO_CANDIDATES, ...ROW_CARDS.map((c) => c.value), "Starting"]);
    const unexpected = new Set<string>();
    for (const rows of vectors) {
      for (const candidate of HERO_CANDIDATES) {
        const gated = applyHeroHealthFloor(candidate, rows);
        if (!allowed.has(gated)) unexpected.add(gated);
      }
    }
    expect([...unexpected]).toEqual([]);
  });

  // The hero resolves a transitional worst-row to the fixed word "Starting",
  // not to the row's own value: "Starting" is a first-class hero value
  // everywhere downstream, where "Warming" badges Info and "Getting Ready"
  // means nothing to homeStateDotTone.
  //
  // This also pins the ordering trap inside homeHealthRowSeverity:
  // normalizeStatus("Starting") is "warn", so a classifier that consults it
  // before testing for transitional rows reports them as warnings, and the hero
  // mirrors the row's value instead. That misreads as harmless -- the heading is
  // still not green -- which is why it needs its own assertion.
  it("resolves a transitional worst row to Starting", () => {
    const violations: string[] = [];
    for (const rows of vectors) {
      if (rows.some(rowIsFailOrWarn)) continue;
      if (!rows.some(rowIsBad)) continue;
      for (const candidate of HERO_CANDIDATES) {
        if (!heroReadsGreen(candidate)) continue;
        const gated = applyHeroHealthFloor(candidate, rows);
        if (gated !== "Starting") violations.push(`${candidate} over [${rows.map((r) => r.value).join(", ")}] -> ${gated}`);
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations.length).toBe(0);
  });

  // An absent reading is not a severity. preferKnownHomeHealth exists to paper
  // over first-paint gaps, so letting Unknown downgrade would flicker the
  // heading on every cold load. This is the one deliberate hole in "never
  // greener than the worst row" -- it needs a test, or it looks like an
  // oversight and gets "fixed".
  it("leaves a green heading alone when the only non-OK rows are Unknown", () => {
    const violations: string[] = [];
    for (const rows of vectors) {
      if (rows.some(rowIsBad)) continue;
      if (!rows.some((row) => /^Unknown$/i.test(row.status))) continue;
      for (const candidate of HERO_CANDIDATES) {
        const gated = applyHeroHealthFloor(candidate, rows);
        if (gated !== candidate) violations.push(`${candidate} -> ${gated}`);
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations.length).toBe(0);
  });

  it("is idempotent", () => {
    const violations: string[] = [];
    for (const rows of vectors) {
      for (const candidate of HERO_CANDIDATES) {
        const once = applyHeroHealthFloor(candidate, rows);
        if (applyHeroHealthFloor(once, rows) !== once) violations.push(`${candidate} -> ${once}`);
      }
    }
    expect(violations.length).toBe(0);
  });
});

// Layer 1 is only as good as its tables, and only matters if the gate cannot be
// bypassed. These read the source as text.
describe("the enumeration still matches the source", () => {
  const src = serverPanelsSource;
  const flat = src.replace(/\s+/g, " ");

  it("knows every row card shape the summariser can produce", () => {
    const found = new Set<string>();
    for (const m of src.matchAll(/\{\s*label:\s*"([^"]+)",\s*status:\s*"([^"]+)"/g)) {
      found.add(`${m[1]}|${m[2]}`);
    }
    const known = new Set(ROW_CARDS.map((c) => `${c.value}|${c.status}`));
    const missing = [...found].filter((shape) => !known.has(shape));
    // If this fails: add the new shape to ROW_CARDS above and re-read the
    // properties. Do NOT loosen this regex.
    expect(missing).toEqual([]);
  });

  // Scoped to summarizeHomeStatus's own body. The file has several other
  // bindings called `overall` in other functions, and they are all readers of
  // the finished value -- it is only inside the summariser that a second
  // assignment would mean a bypassed gate.
  function summariserBody() {
    const start = src.indexOf("export function summarizeHomeStatus(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("keeps the gate unbypassable -- one assignment, and it is the gate", () => {
    const body = summariserBody();
    const assignments = body.match(/const overall\s*=/g) || [];
    // If this fails, something in the summariser now assigns `overall` without
    // going through applyHeroHealthFloor -- which is exactly how a green
    // heading gets back over a bad row. Route it through the gate instead of
    // relaxing this.
    expect(assignments.length).toBe(1);
    expect(body.replace(/\s+/g, " ")).toContain("const overall = applyHeroHealthFloor(overallCandidate, healthRows)");
    expect((body.match(/overallCandidate/g) || []).length).toBe(2);
  });

  it("feeds the gated value to the Overall identity row", () => {
    expect(flat).toContain('{ label: "Overall", value: overall,');
  });
});

// Layers 1-2 test the gate and its wiring. This tests that the real pipeline
// never reaches a state they did not consider.
// The floor's reach beyond the rows it was built for. A container or listener
// fault that status reports and readiness does not now survives on its row
// (pinned in healthCounts.test.ts); the floor is what carries it up to the
// heading, which read a flat "OK" above it before.
describe("a fault status can see reaches the heading", () => {
  function overall(status: string, readiness: string, action: "" | "start" = "") {
    return summarizeHomeStatus(status, readiness, "", false, action).identity.find((i) => i.label === "Overall")?.value;
  }

  it("reads the row's value, not OK, when readiness is a stale all-clear", () => {
    expect(overall(statusText({ downContainers: 1 }), READY_READINESS)).toBe("Needs Review");
    expect(overall(statusText({ badListeners: 1 }), READY_READINESS)).toBe("Needs Review");
  });

  it("still reads Starting during a start, where the row says Getting Ready", () => {
    expect(overall(statusText({ downContainers: 1 }), READY_READINESS, "start")).toBe("Starting");
  });
});

describe("through summarizeHomeStatus", () => {
  const overalls = ["READY", "WARMING", "STOPPED", null] as const;
  const containers = [0, 8];
  const mapSets: Array<[string, Array<[string, string]>]> = [
    ["all ready", MAPS],
    ["one warming", MAPS.map(([l], i) => [l, i === 0 ? "WARMING" : "READY"] as [string, string])],
    ["one waiting", MAPS.map(([l], i) => [l, i === 0 ? "WAIT" : "READY"] as [string, string])],
    ["one down", MAPS.map(([l], i) => [l, i === 0 ? "NOT RUNNING" : "READY"] as [string, string])]
  ];
  const readinesses = [READY_READINESS, FAILING_READINESS, ""];
  const actions: Array<"" | "start" | "stop" | "restart"> = ["", "start", "stop", "restart"];
  const taskResults = [
    null,
    { status: "failed", title: "Start Failed" },
    { status: "stopped", title: "Battlegroup Stopped" },
    { status: "succeeded", title: "Battlegroup Restarted Successfully" }
  ];

  const seenHeroValues = new Set<string>();
  const seenSeverities = new Set<string>();
  const violations: string[] = [];

  for (const overall of overalls) {
    for (const downContainers of containers) {
      for (const [, maps] of mapSets) {
        for (const omitDatabase of [false, true]) {
          const status = statusText({ overall, downContainers, maps, omitDatabase });
          for (const readiness of readinesses) {
            for (const runningAction of actions) {
              for (const taskResult of taskResults) {
                for (const tokenFailure of [false, true]) {
                  const summary = summarizeHomeStatus(status, readiness, "", false, runningAction, taskResult as never, false, tokenFailure);
                  const hero = String(summary.identity.find((i) => i.label === "Overall")?.value || "");
                  seenHeroValues.add(hero);
                  for (const row of summary.health) {
                    seenSeverities.add(rowIsFailOrWarn(row) ? "failwarn" : rowIsBad(row) ? "transition" : /^Unknown$/i.test(row.status) ? "unknown" : "ok");
                  }
                  if (summary.health.some(rowIsBad) && homeOverallHeading(hero) === "Ready") {
                    violations.push(`Ready over [${summary.health.filter(rowIsBad).map((r) => r.value).join(", ")}]`);
                  }
                  if (summary.health.some(rowIsFailOrWarn) && homeStateDotTone(hero, summary.health) === "ok") {
                    violations.push(`green dot over [${summary.health.filter(rowIsFailOrWarn).map((r) => r.value).join(", ")}]`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  it("never renders Ready or a green dot above a bad row", () => {
    expect(violations.slice(0, 5)).toEqual([]);
    expect(violations.length).toBe(0);
  });

  // Without this, a refactor that collapses half the matrix into one state
  // leaves thousands of assertions above that all check nothing. This is what
  // makes the block a property test rather than a slow tautology -- do not
  // relax it to arrayContaining to make CI green.
  it("actually exercised every row severity and a range of headings", () => {
    expect([...seenSeverities].sort()).toEqual(["failwarn", "ok", "transition", "unknown"]);
    expect(seenHeroValues.size).toBeGreaterThanOrEqual(4);
    expect([...seenHeroValues].every((v) => v.length > 0)).toBe(true);
  });
});
