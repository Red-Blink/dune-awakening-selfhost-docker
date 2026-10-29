import { describe, expect, it } from "vitest";
import { advanceRestartLifecycle, createRestartLifecycleState, getHomeServerState, summarizeContainers, summarizeHomeStatus } from "./ServerPanels";

// status.sh prints ten container rows. Only eight are battlegroup services:
// dune-orchestrator is the control plane and is always Up (it is what starts
// and stops the others), and dune-coriolis-coordinator is optional. Every
// fixture here includes both, which is what the older fixtures leave out.
const BATTLEGROUP = [
  "dune-postgres",
  "dune-rmq-admin",
  "dune-rmq-game",
  "dune-text-router",
  "dune-director",
  "dune-server-gateway",
  "dune-server-survival-1",
  "dune-server-overmap"
];

function statusText(options: {
  overall?: string;
  battlegroup: string;
  coordinator?: string;
  orchestrator?: string;
}) {
  const rows = BATTLEGROUP.map((name) => `${name.padEnd(26)} ${options.battlegroup}`);
  rows.push(`${"dune-coriolis-coordinator".padEnd(26)} ${options.coordinator ?? "Up 30 minutes"}`);
  rows.push(`${"dune-orchestrator".padEnd(26)} ${options.orchestrator ?? "Up 32 minutes"}`);
  return [
    "=== Dune status ===",
    ...(options.overall ? [`Overall:     ${options.overall}`] : []),
    "Title:       Example Sietch",
    "",
    "=== Containers ===",
    "SERVICE                    STATUS",
    ...rows,
    "",
    "=== Listeners ===",
    "CHECK                    PORT     STATUS",
    "Postgres localhost       15432/tcp OK",
    ""
  ].join("\n");
}

// Anything that is not a "READY:" line, so readyOverride cannot mask the row.
const NOT_READY = "=== Container checks ===\nNOT READY: one or more required checks failed.";

function healthRow(status: string, readiness: string, label: string) {
  const summary = summarizeHomeStatus(status, readiness, "", false);
  const row = summary.health.find((item) => item.label === label);
  if (!row) throw new Error(`no health row for ${label}`);
  return row;
}

// The user-visible bug. The coordinator is optional --
// DUNE_CORIOLIS_COORDINATOR_ENABLED=0 deletes the container outright, and
// start-all treats a failed start as non-fatal -- so its absence is a
// configuration choice, not a fault.
describe("Containers row with the coordinator switched off", () => {
  const status = statusText({ overall: "WARMING", battlegroup: "Up 20 minutes", coordinator: "missing" });

  // There is no longer a Containers row -- the services it listed each have
  // their own home now -- so this asserts the summariser directly, as the rest
  // of this file already does.
  it("reads OK rather than blaming an optional service that is meant to be off", () => {
    expect(summarizeContainers(status)).toMatchObject({ label: "OK", status: "Ready" });
  });

  // Guards the fix from being "ignore every row": a real battlegroup container
  // going down must still be reported. Asserted on the summarizer rather than
  // the rendered row, because with core containers up and readiness not READY
  // the panel is legitimately in its boot-starting state, which relabels every
  // row "Getting Ready" whatever the underlying reading.
  it("still reports a battlegroup container that is actually down", () => {
    const broken = statusText({ overall: "ISSUE", battlegroup: "Up 20 minutes", coordinator: "missing" })
      .replace(/^dune-director\s+Up 20 minutes$/m, "dune-director              exited");
    expect(broken).toMatch(/dune-director\s+exited/);
    expect(summarizeContainers(broken)).toMatchObject({ label: "Needs Review", status: "WARN" });
  });

  it("reads OK when all eight are up and only the coordinator is absent", () => {
    expect(summarizeContainers(status)).toMatchObject({ label: "OK", status: "Ready" });
  });

  // docker reports a paused container as "Up 3 hours (Paused)" -- verified
  // against docker 29.7.2 -- so it satisfies /\bUp\b/ and used to read as
  // healthy. Nothing in this stack pauses containers, but a paused one is not
  // serving.
  it("does not read a paused container as healthy", () => {
    const paused = statusText({ overall: "ISSUE", battlegroup: "Up 20 minutes", coordinator: "missing" })
      .replace(/^dune-director\s+Up 20 minutes$/m, "dune-director              Up 3 hours (Paused)");
    expect(paused).toMatch(/dune-director\s+Up 3 hours \(Paused\)/);
    expect(summarizeContainers(paused)).toMatchObject({ label: "Needs Review", status: "WARN" });
  });
});

describe("getHomeServerState with the real ten-row container table", () => {
  // The assertion that pins allContainersMissing. With the whole table scanned,
  // the always-Up orchestrator row made it unreachable, and only the
  // "Overall: STOPPED" line was holding the stopped verdict up.
  it("reads a stopped battlegroup as stopped without the Overall line", () => {
    const status = statusText({ battlegroup: "missing", coordinator: "missing" });
    expect(status).not.toMatch(/Overall:/);
    expect(getHomeServerState(status, "").stopped).toBe(true);
  });

  it("still reads it as stopped with the Overall line present", () => {
    const status = statusText({ overall: "STOPPED", battlegroup: "missing", coordinator: "missing" });
    expect(getHomeServerState(status, "").stopped).toBe(true);
  });

  // isHomeBootStarting returns early once it sees the eight are all down, which
  // stops a stale WARMING reading from being taken as "still booting" -- and
  // bootStarting suppresses the stopped verdict entirely. Counting the always-Up
  // orchestrator defeated that early return, so this reported not-stopped.
  it("is not booting when the eight are down, whatever the Overall line claims", () => {
    const status = statusText({ overall: "WARMING", battlegroup: "missing", coordinator: "missing" });
    expect(getHomeServerState(status, "").stopped).toBe(true);
  });

  // A crash-looping container is neither Up nor down, so the count of downed
  // battlegroup containers stops one short of the eight. Counting the absent
  // coordinator made up the difference and tripped the "everything is down, not
  // booting" early return on a battlegroup that is in fact still coming up.
  //
  // The crash-looping container is a game-stack one, not Postgres: a Postgres
  // with the whole game stack missing is deliberately not "starting" any more
  // (see isGameStackDown), whatever state Postgres itself is in.
  it("does not let an absent coordinator complete the count of downed containers", () => {
    const status = statusText({ overall: "WARMING", battlegroup: "missing", coordinator: "missing" })
      .replace(/^dune-rmq-admin\s+missing$/m, "dune-rmq-admin             Restarting (1) 5 seconds ago");
    expect(status).toMatch(/dune-rmq-admin\s+Restarting/);
    expect(getHomeServerState(status, "").starting).toBe(true);
  });

  // The other direction: the orchestrator being Up is not evidence that the
  // battlegroup is up, and the eight being Up must not read as stopped.
  it("does not call a running battlegroup stopped when the coordinator is absent", () => {
    const status = statusText({ overall: "READY", battlegroup: "Up 20 minutes", coordinator: "missing" });
    const state = getHomeServerState(status, "READY: all checks passed");
    expect(state.stopped).toBe(false);
    expect(state.running).toBe(true);
  });
});

// The rows are the visible half; the hero reads from the same summary, and
// scoping the Containers row moves it too. summarizeContainers was the only
// thing setting isHomeCoreReadyWithReview, so silencing a false review changes
// which branch the Overall value comes from. These pin the whole card, not just
// the row -- the earlier tests call the summarizers directly and would not have
// caught it.
//
// Fixture is the real dune2 output (2026-08-30), trimmed to the sections
// summarizeHomeStatus reads.
function fullStatus(overall: string, coordinator: string) {
  return [
    "=== Dune status ===",
    `Overall:     ${overall}`,
    "Title:       Example Sietch",
    "Population:  0/120",
    "",
    "=== Containers ===",
    "SERVICE                    STATUS",
    ...BATTLEGROUP.map((name) => `${name.padEnd(26)} Up 15 hours`),
    `${"dune-coriolis-coordinator".padEnd(26)} ${coordinator}`,
    `${"dune-orchestrator".padEnd(26)} Up 15 hours`,
    "",
    "=== Listeners ===",
    "CHECK                    PORT     STATUS",
    "Postgres localhost       15432/tcp OK",
    "Director                 11717/tcp OK",
    "",
    "=== Database ===",
    "World partitions: 32",
    "",
    "=== Game servers ===",
    "MAP          STATE        UPTIME",
    "Survival_1   READY        Up 15 hours",
    "Overmap      READY        Up 15 hours",
    "",
    "=== Funcom/FLS summary ===",
    "Director heartbeat:       OK",
    "Population declaration:   OK",
    "Max capacity declaration: OK",
    "Gateway DB monitoring:    OK",
    ""
  ].join("\n");
}

function card(status: string, readiness: string) {
  const summary = summarizeHomeStatus(status, readiness, "", false);
  const overall = summary.identity.find((item) => item.label === "Overall");
  return [
    `Overall ${overall?.value}/${overall?.status}`,
    ...summary.health.map((item) => `${item.label} ${item.value}/${item.status}`)
  ].join(" | ");
}

describe("Home card with the coordinator switched off", () => {
  // Asserting equality rather than exact wording: the invariant is that turning
  // an optional service off changes nothing an operator sees, and that survives
  // future rewording of the labels.
  it("renders exactly as it does with the coordinator running, once ready", () => {
    const readiness = "READY: all checks passed";
    expect(card(fullStatus("READY", "missing"), readiness))
      .toBe(card(fullStatus("READY", "Up 15 hours"), readiness));
  });

  // The warm-up window, before ready.sh reaches "READY:" -- readyOverride is not
  // masking here, so this is where the difference used to show.
  it("renders the same during warm-up, when readyOverride is not masking", () => {
    const readiness = "=== Container checks ===\nWARN container dune-director\nNOT READY: still starting";
    expect(card(fullStatus("READY", "missing"), readiness))
      .toBe(card(fullStatus("READY", "Up 15 hours"), readiness));
  });

  // Both of the above depend on status.sh reporting READY rather than ISSUE for
  // a deliberately-disabled coordinator, which is the backend half of this fix
  // (runtime/scripts/container-issue-scan.sh). Without it Overall arrives as
  // ISSUE and the card reads "Starting" on a fully-running battlegroup.
  it("reads OK, not Starting, on a fully-running battlegroup", () => {
    const readiness = "=== Container checks ===\nWARN container dune-director\nNOT READY: still starting";
    expect(card(fullStatus("READY", "missing"), readiness)).toContain("Overall OK/Ready");
    expect(card(fullStatus("READY", "missing"), readiness)).not.toContain("Starting");
  });
});

// all() quantifies over the eight NAMES, not over the printed rows. A name with
// no row at all must make it false, so a truncated or partial Containers
// section can never read as "they are all down". Collapsing all() onto rows()
// -- filtering to the battlegroup and asking .every() of what survives -- looks
// equivalent and is not: with six of the eight absent, every *printed* row is
// down and the battlegroup would be declared stopped on two rows of evidence.
describe("a partial Containers section", () => {
  const partial = [
    "=== Dune status ===",
    "Title:       Example Sietch",
    "",
    "=== Containers ===",
    "SERVICE                    STATUS",
    `${"dune-postgres".padEnd(26)} missing`,
    `${"dune-rmq-admin".padEnd(26)} missing`,
    "",
    "=== Listeners ===",
    "CHECK                    PORT     STATUS",
    "Postgres localhost       15432/tcp OK",
    "",
    "=== Game servers ===",
    "MAP          STATE        UPTIME",
    "Survival_1   READY        Up 15 hours",
    "Overmap      READY        Up 15 hours",
    ""
  ].join("\n");

  it("is not read as a stopped battlegroup", () => {
    expect(partial).not.toMatch(/Overall:/);
    expect(getHomeServerState(partial, "READY: all checks passed").stopped).toBe(false);
  });

  it("does not report the six unlisted containers as OK either", () => {
    expect(summarizeContainers(partial)).toMatchObject({ status: "WARN" });
  });
});

// The restart lifecycle asks "has a stop been observed?" of the eight names.
// An optional coordinator that is off by configuration reads as "missing"
// forever, so an unscoped check would latch stopObserved on a battlegroup that
// never stopped -- and stopObserved is monotonic, so it never recovers.
describe("restart lifecycle with the coordinator switched off", () => {
  const running = [
    "=== Dune status ===",
    "Overall:     READY",
    "",
    "=== Containers ===",
    "SERVICE                    STATUS",
    ...BATTLEGROUP.map((name) => `${name.padEnd(26)} Up 15 hours`),
    `${"dune-coriolis-coordinator".padEnd(26)} missing`,
    `${"dune-orchestrator".padEnd(26)} Up 15 hours`,
    ""
  ].join("\n");

  it("does not latch a stop that never happened", () => {
    const next = advanceRestartLifecycle(createRestartLifecycleState(), running, "READY: all checks passed");
    expect(next.stopObserved).toBe(false);
  });
});
