import { describe, expect, it } from "vitest";
import {
  GAME_SERVER_WARMUP_GRACE_MS,
  gameServerWarmupGraceMs,
  getHomeServerState,
  isHomeActionComplete,
  isHomeStartComplete
} from "./ServerPanels";
import { READY_READINESS, statusText } from "./homeStatusFixtures";

// Real dune2 output captured 2026-08-31, trimmed to the sections
// summarizeHomeStatus reads.
const MINUTE = 60 * 1000;

// status.sh renders map rows as printf "%-24s %-13s %s".
function mapRow(label: string, state: string, uptime: string) {
  return `${label.padEnd(24)} ${state.padEnd(13)} ${uptime}`;
}

function statusWith(
  survival: string,
  overmap: string,
  options: { extra?: Array<[string, string, string]>; concurrency?: number } = {}
) {
  const extra = options.extra ?? [];
  const rows = [
    mapRow("Survival_1", survival, "Up 7 minutes"),
    mapRow("Overmap", overmap, "Up 7 minutes"),
    ...extra.map(([label, state, uptime]) => mapRow(label, state, uptime))
  ];
  const note =
    options.concurrency === undefined
      ? []
      : [`Note: ${rows.length} always-on map servers expected, starting ${options.concurrency} at a time.`];
  return [
    "=== Dune status ===",
    "Overall:     READY",
    "Title:       Example Sietch",
    "Population:  0/120",
    "",
    "=== Containers ===",
    "SERVICE                    STATUS",
    ...[
      "dune-postgres",
      "dune-rmq-admin",
      "dune-rmq-game",
      "dune-text-router",
      "dune-director",
      "dune-server-gateway",
      "dune-server-survival-1",
      "dune-server-overmap",
      "dune-coriolis-coordinator",
      "dune-orchestrator"
    ].map((name) => `${name.padEnd(26)} Up 15 hours`),
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
    "MAP                      STATE         UPTIME",
    ...rows,
    ...note,
    "",
    "=== RabbitMQ game connections ===",
    "RabbitMQ connection details: Checked by readiness",
    "",
    "=== Funcom/FLS summary ===",
    "Director heartbeat:       OK",
    "Population declaration:   OK",
    "Max capacity declaration: OK",
    "Gateway DB monitoring:    OK",
    ""
  ].join("\n");
}

const READINESS = [
  "OK container dune-postgres",
  "OK container dune-rmq-admin",
  "OK container dune-rmq-game",
  "OK container dune-text-router",
  "OK container dune-director",
  "OK container dune-server-gateway",
  "OK container dune-server-survival-1",
  "OK container dune-server-overmap",
  "OK world_partition rows: 32",
  "OK game server sg.* RMQ connections",
  "READY: all checks passed"
].join("\n");

const ALL_READY = statusWith("READY", "READY");
const ONE_WARMING = statusWith("WARMING", "READY");

// The full dune2 roster: seven servers, two of them second partitions.
const DUNE2_EXTRA: Array<[string, string, string]> = [
  ["Survival_1#60", "READY", "Up 7 minutes"],
  ["SH_Arrakeen", "READY", "Up 7 minutes"],
  ["SH_HarkoVillage", "READY", "Up 7 minutes"],
  ["DeepDesert_1", "READY", "Up 7 minutes"],
  ["DeepDesert_1#59", "READY", "Up 7 minutes"]
];

describe("game servers gate a completed start", () => {
  it("completes immediately once every map is READY", () => {
    expect(isHomeActionComplete(ALL_READY, READINESS, 0)).toBe(true);
  });

  // The bug this closes: containers up and readiness operational, but a map
  // still warming. Readiness only proves the map's container is up, so it must
  // not stand in for the map being playable.
  it("does not complete while a map is still warming", () => {
    expect(isHomeActionComplete(ONE_WARMING, READINESS, 0)).toBe(false);
  });

  it("still does not complete just before the grace window expires", () => {
    expect(isHomeActionComplete(ONE_WARMING, READINESS, GAME_SERVER_WARMUP_GRACE_MS - 1)).toBe(false);
  });

  // The backstop. A map stuck WARMING must not pin the console in "Starting"
  // with its controls disabled forever.
  it("completes once the grace window has passed, even with a map warming", () => {
    expect(isHomeActionComplete(ONE_WARMING, READINESS, GAME_SERVER_WARMUP_GRACE_MS)).toBe(true);
  });

  // Callers with no notion of elapsed time (the Funcom token poll) must keep
  // their previous, lenient behaviour rather than being blocked indefinitely.
  it("stays lenient for callers that pass no elapsed time", () => {
    expect(isHomeActionComplete(ONE_WARMING, READINESS)).toBe(true);
  });

  // A map that has failed outright reports NOT RUNNING, not WARMING, so it
  // takes the WARN path instead of waiting out the grace window.
  it("does not hold the grace window open for a map that failed outright", () => {
    const failed = statusWith("NOT RUNNING", "READY");
    expect(isHomeActionComplete(failed, READINESS, 0)).toBe(true);
  });

  // Seen live on dune2: the core stack is up and readiness passes before the
  // autoscaler has spawned the always-on maps. status.sh reports those QUEUED,
  // and a Start must not report success until they are spawned and ready.
  it("does not complete while an always-on map is still queued", () => {
    const withMap = (state: string) =>
      statusText({ maps: [["Survival_1", "READY"], ["Overmap", "READY"], ["SH_Arrakeen", state]] });
    expect(isHomeActionComplete(withMap("QUEUED"), READY_READINESS, 0)).toBe(false);
    expect(isHomeActionComplete(withMap("QUEUED"), READY_READINESS, GAME_SERVER_WARMUP_GRACE_MS)).toBe(true);
    // What the roster used to report here, and why the Start finished early.
    expect(isHomeActionComplete(withMap("NOT RUNNING"), READY_READINESS, 0)).toBe(true);
  });

  // The wiring assertion. Every other case here uses a two-map fixture, where
  // the scaled budget and the flat floor happen to be equal -- so none of them
  // would notice the gate reverting to the constant. Seven maps two at a time
  // is 16 minutes, so a warming map is still not done at the old flat 10.
  it("gates on the scaled budget rather than the flat floor", () => {
    const status = statusWith("WARMING", "READY", { extra: DUNE2_EXTRA, concurrency: 2 });
    expect(gameServerWarmupGraceMs(status)).toBe(16 * MINUTE);
    expect(isHomeActionComplete(status, READINESS, GAME_SERVER_WARMUP_GRACE_MS)).toBe(false);
    expect(isHomeActionComplete(status, READINESS, 16 * MINUTE)).toBe(true);
  });
});

describe("isHomeStartComplete counts the maps", () => {
  it("is complete when every map is READY", () => {
    expect(isHomeStartComplete(ALL_READY, READINESS)).toBe(true);
  });

  it("is not complete while a map is still warming", () => {
    expect(isHomeStartComplete(ONE_WARMING, READINESS)).toBe(false);
  });

  it("is not complete when a map is not running at all", () => {
    expect(isHomeStartComplete(statusWith("NOT RUNNING", "READY"), READINESS)).toBe(false);
  });

  // The point of enumerating the whole roster: the two core maps being ready
  // is no longer enough on a host with more always-on maps.
  it("is not complete when an extra always-on map is still warming", () => {
    const status = statusWith("READY", "READY", {
      extra: [...DUNE2_EXTRA.slice(0, 4), ["DeepDesert_1#59", "WARMING", "Up 20 seconds"]]
    });
    expect(isHomeStartComplete(status, READINESS)).toBe(false);
  });

  it("is not complete when an extra always-on map is not running", () => {
    const status = statusWith("READY", "READY", {
      extra: [...DUNE2_EXTRA.slice(0, 4), ["DeepDesert_1#59", "NOT RUNNING", "missing"]]
    });
    expect(isHomeStartComplete(status, READINESS)).toBe(false);
  });

  it("is complete when the whole seven-server roster is READY", () => {
    const status = statusWith("READY", "READY", { extra: DUNE2_EXTRA, concurrency: 2 });
    expect(isHomeStartComplete(status, READINESS)).toBe(true);
  });
});

// A configured always-on map that simply has not been spawned yet reads WAIT.
// It must behave like warming, not like a fault, or Overall would report a
// problem through every clean boot.
describe("a queued map reads as warming, not a fault", () => {
  const queued = statusWith("READY", "READY", {
    extra: [...DUNE2_EXTRA.slice(0, 4), ["DeepDesert_1#59", "WAIT", "pending"]],
    concurrency: 2
  });

  it("holds the start open rather than completing", () => {
    expect(isHomeActionComplete(queued, READINESS, 0)).toBe(false);
  });

  it("is released once the grace window expires", () => {
    expect(isHomeActionComplete(queued, READINESS, gameServerWarmupGraceMs(queued))).toBe(true);
  });

  // status.sh writes "pending" rather than "missing" in a WAIT row's uptime
  // column precisely because summarizeGameServers scans the whole row; with
  // "missing" this would be a fault and complete immediately instead.
  it("would read as a fault if the uptime still said missing", () => {
    const withMissing = statusWith("READY", "READY", {
      extra: [...DUNE2_EXTRA.slice(0, 4), ["DeepDesert_1#59", "WAIT", "missing"]],
      concurrency: 2
    });
    expect(isHomeActionComplete(withMissing, READINESS, 0)).toBe(true);
  });
});

describe("the warm-up budget scales with the roster", () => {
  it("uses the flat floor for the two-map case", () => {
    expect(gameServerWarmupGraceMs(ALL_READY)).toBe(GAME_SERVER_WARMUP_GRACE_MS);
  });

  // Seven servers, two at a time -> four batches -> 16 minutes. A flat 10 would
  // expire mid-startup and complete via the fallback.
  it("scales to the batches a seven-map host actually needs", () => {
    const status = statusWith("READY", "READY", { extra: DUNE2_EXTRA, concurrency: 2 });
    expect(gameServerWarmupGraceMs(status)).toBe(16 * MINUTE);
  });

  // Same roster started one at a time is seven batches -> 28 minutes.
  it("gives a serial host longer than a parallel one", () => {
    const serial = statusWith("READY", "READY", { extra: DUNE2_EXTRA, concurrency: 1 });
    const parallel = statusWith("READY", "READY", { extra: DUNE2_EXTRA, concurrency: 2 });
    expect(gameServerWarmupGraceMs(serial)).toBe(28 * MINUTE);
    expect(gameServerWarmupGraceMs(serial)).toBeGreaterThan(gameServerWarmupGraceMs(parallel));
  });

  it("never drops below the floor", () => {
    const status = statusWith("READY", "READY", { extra: DUNE2_EXTRA, concurrency: 16 });
    expect(gameServerWarmupGraceMs(status)).toBe(GAME_SERVER_WARMUP_GRACE_MS);
  });

  it("is capped however many maps are configured", () => {
    const many: Array<[string, string, string]> = Array.from({ length: 60 }, (_, i) => [
      `Map_${i}`,
      "READY",
      "Up 1 minute"
    ]);
    const status = statusWith("READY", "READY", { extra: many, concurrency: 1 });
    expect(gameServerWarmupGraceMs(status)).toBe(45 * MINUTE);
  });

  // An older backend emits no Note: line. Assume serial rather than guessing.
  it("assumes one at a time when the note is absent", () => {
    const status = statusWith("READY", "READY", { extra: DUNE2_EXTRA });
    expect(gameServerWarmupGraceMs(status)).toBe(28 * MINUTE);
  });

  it("falls back to the floor when there is no Game servers section", () => {
    expect(gameServerWarmupGraceMs("=== Dune status ===\nOverall: READY")).toBe(GAME_SERVER_WARMUP_GRACE_MS);
  });

  // The Note: line is not a server and must not inflate the denominator.
  it("does not count the note as a map", () => {
    const withNote = statusWith("READY", "READY", { extra: DUNE2_EXTRA, concurrency: 1 });
    const withoutNote = statusWith("READY", "READY", { extra: DUNE2_EXTRA });
    expect(gameServerWarmupGraceMs(withNote)).toBe(gameServerWarmupGraceMs(withoutNote));
  });
});

// Guards ServerPanels.tsx's stopped-detection, which matches
// /Survival_1\s+NOT RUNNING/ and /Overmap\s+NOT RUNNING/ against the raw text.
// This is why the lowest partition of a map keeps the bare label: a
// "Survival_1#1" row would break it silently.
describe("stopped detection survives the wider roster", () => {
  it("still reads a stopped battlegroup as stopped", () => {
    const stopped = statusWith("NOT RUNNING", "NOT RUNNING", {
      extra: DUNE2_EXTRA.map(([label]) => [label, "NOT RUNNING", "missing"] as [string, string, string]),
      concurrency: 2
    }).replace(/^dune-.*Up 15 hours$/gm, (line) => line.replace("Up 15 hours", "missing"));
    expect(getHomeServerState(stopped, "").stopped).toBe(true);
  });

  it("does not read a running battlegroup as stopped", () => {
    const status = statusWith("READY", "READY", { extra: DUNE2_EXTRA, concurrency: 2 });
    expect(getHomeServerState(status, READINESS).stopped).toBe(false);
  });
});

// isHomeActionComplete has a final fallback: warming maps with everything else
// OK counts as complete once the grace window has passed. It reads the games
// row out of summary.health, and it used to find that row by its display label
// -- so renaming the row silently disabled this path with nothing failing.
// These pin the fallback itself, which is what makes a label-keyed lookup fail
// a test rather than fail quietly.
describe("the warming fallback finds the games row", () => {
  const warming = statusWith("WARMING", "READY", { extra: DUNE2_EXTRA, concurrency: 2 });

  it("does not complete before the grace window, on any path", () => {
    expect(isHomeActionComplete(warming, "", 0)).toBe(false);
  });

  // Readiness is empty, so isHomeReadinessOperational is false and
  // isHomeStartComplete is false too (the maps are not ready). The only route
  // left to true is the warming fallback, which needs the games row by id.
  it("completes after the grace window via the warming fallback alone", () => {
    expect(isHomeActionComplete(warming, "", gameServerWarmupGraceMs(warming))).toBe(true);
  });
});
