import { describe, expect, it } from "vitest";
import { HOME_SUBSYSTEM_ROUTES, isGameServersComingUp, summarizeHomeStatus } from "./ServerPanels";
// Shared with the property test so the two cannot drift apart -- a generator
// per file means the property test keeps passing against a shape the app no
// longer produces.
import { MAPS, READY_READINESS, statusText } from "./homeStatusFixtures";

function counts(status: string, readiness = READY_READINESS, runningAction: "start" | "stop" | "restart" | "" = "") {
  const summary = summarizeHomeStatus(status, readiness, "", false, runningAction);
  return Object.fromEntries(summary.health.map((item) => [item.label, item.detail]));
}

function values(status: string, readiness = READY_READINESS, runningAction: "start" | "stop" | "restart" | "" = "") {
  const summary = summarizeHomeStatus(status, readiness, "", false, runningAction);
  return Object.fromEntries(summary.health.map((item) => [item.label, item.value]));
}

describe("Readiness & Health rows carry an x-of-y count", () => {
  it("counts a fully healthy battlegroup", () => {
    expect(counts(statusText())).toMatchObject({
      Messaging: "3 of 3",
      "Battlegroup services": "2 of 2",
      "Game servers": "7 of 7",
      "Funcom/FLS": "4 of 4"
    });
  });

  // The denominator is the services a row owns, not the printed rows. A
  // container with no row at all is missing, and counting printed rows would
  // report "2 of 2" for exactly that case.
  it("keeps a row's denominator at what it owns when rows are missing", () => {
    const missing = statusText().replace(/^dune-text-router.*$/m, "");
    expect(counts(missing).Messaging).toBe("2 of 3");
  });

  it("counts a partially down battlegroup", () => {
    // BATTLEGROUP order is postgres, rmq-admin, rmq-game, text-router, ...
    expect(counts(statusText({ downContainers: 3 })).Messaging).toBe("1 of 3");
    expect(counts(statusText({ flsWait: 2 }))["Funcom/FLS"]).toBe("2 of 4");
  });

  // Messaging is the two brokers plus the text router, which is a hard client of
  // the game broker. The connections section only ever speaks about the game
  // broker, so the count comes from the container table, which lists all three.
  it("counts all three messaging services", () => {
    expect(counts(statusText()).Messaging).toBe("3 of 3");
    // dune-rmq-admin is the second battlegroup container.
    expect(counts(statusText({ downContainers: 2 })).Messaging).toBe("2 of 3");
    expect(counts(statusText({ downContainers: 4 })).Messaging).toBe("0 of 3");
  });

  it("leaves a row blank when there is no container table to read", () => {
    const noContainers = statusText().replace(/=== Containers ===[\s\S]*?\n\n/, "");
    expect(counts(noContainers).Messaging).toBe("");
  });

  it("counts only the maps that are actually READY", () => {
    const warming: Array<[string, string]> = [
      ["Survival_1", "READY"],
      ["Survival_1#60", "READY"],
      ["Overmap", "READY"],
      ["SH_Arrakeen", "WARMING"],
      ["SH_HarkoVillage", "WAIT"],
      ["DeepDesert_1", "WARMING"],
      ["DeepDesert_1#59", "WARMING"]
    ];
    expect(counts(statusText({ maps: warming }))["Game servers"]).toBe("3 of 7");
  });

  // Database counts its one service, like every other row. The partition
  // figure deliberately does NOT appear: it is a property of the world, not a
  // measure of how much of the subsystem is ready.
  it("counts Database's single service", () => {
    expect(counts(statusText()).Database).toBe("1 of 1");
    expect(counts(statusText({ downContainers: 1 })).Database).toBe("0 of 1");
  });

  // Funcom/FLS is the last section status.sh prints, so sectionLines runs to
  // end of output and takes the trailing tips with it. Counting those made a
  // healthy dune2 read "4 of 6". One of the real tips contains the word "fail",
  // so this also guards the failure check that has only ever passed by luck.
  it("does not count the trailing tips as FLS checks", () => {
    const withTips = [
      statusText(),
      "Tip: use 'dune ready' for pass/wait/fail readiness checks.",
      "Tip: use 'dune doctor' for troubleshooting suggestions."
    ].join("\n");
    expect(counts(withTips)["Funcom/FLS"]).toBe("4 of 4");
    expect(values(withTips)["Funcom/FLS"]).toBe("OK");
  });
});

// The counts are taken from the raw reading rather than the display override.
// readyOverride and transitionHomeHealthCard both carry an empty detail, so
// reading the count off them would blank it in the two states it matters most.
describe("counts survive the display overrides", () => {
  it("survives readyOverride on a healthy battlegroup", () => {
    // readyOverride is what rewrites every row to a bare "OK".
    expect(values(statusText())["Game servers"]).toBe("OK");
    expect(counts(statusText())["Game servers"]).toBe("7 of 7");
  });

  it("survives the transitional override mid-start", () => {
    const warming: Array<[string, string]> = MAPS.map(([label], i) =>
      [label, i < 3 ? "READY" : "WARMING"] as [string, string]
    );
    const status = statusText({ downContainers: 2, maps: warming });
    const readiness = "=== Container checks ===\nWARN container dune-director\nNOT READY: still starting";
    // The row itself reads "Getting Ready" -- the count is the only thing
    // telling an operator how far along the start actually is.
    expect(values(status, readiness, "start").Messaging).toBe("Getting Ready");
    expect(counts(status, readiness, "start")).toMatchObject({
      Messaging: "2 of 3",
      "Game servers": "3 of 7"
    });
  });

  it("survives the stopped override", () => {
    const stopped = statusText({ downContainers: 8, maps: MAPS.map(([l]) => [l, "NOT RUNNING"] as [string, string]) })
      .replace("Overall:     READY", "Overall:     STOPPED");
    expect(counts(stopped, "")).toMatchObject({
      Database: "0 of 1",
      Messaging: "0 of 3",
      "Battlegroup services": "0 of 2",
      "Game servers": "0 of 7"
    });
  });
});

// summarizeHomeStatus is a view model AND the restart lifecycle's input.
// isHomeActionComplete matches value against /^OK$/, so the count had to go in
// detail; putting it in value would break start/restart completion detection.
describe("the count does not disturb the lifecycle contract", () => {
  it("leaves a healthy row's value as the bare OK", () => {
    for (const [label, value] of Object.entries(values(statusText()))) {
      expect(value, `${label} value`).toBe("OK");
    }
  });
});

// Every lookup keys on the row id, never the label. The label is display text
// and is expected to change; keying on it fails SILENTLY -- the route lookup
// fails closed so the row just stops being clickable, and
// isHomeActionComplete's find returns undefined so the warming-map path is
// permanently disabled with nothing failing.
describe("health rows are addressed by a stable id", () => {
  const rows = () => summarizeHomeStatus(statusText(), READY_READINESS, "", false).health;

  it("gives every row an id", () => {
    for (const row of rows()) expect(row.id, `${row.label} id`).toMatch(/^[a-z][a-z-]*$/);
  });

  it("uses ids that are unique", () => {
    const ids = rows().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Catches a new row added without a route, and an id renamed on one side
  // only -- both of which would otherwise only show up as a button count.
  it("has a route for every row id", () => {
    for (const row of rows()) {
      expect(Object.hasOwn(HOME_SUBSYSTEM_ROUTES, row.id), `no route for id "${row.id}" (${row.label})`).toBe(true);
    }
  });

  it("routes nothing that is not a row id", () => {
    const ids = new Set(rows().map((r) => r.id));
    for (const key of Object.keys(HOME_SUBSYSTEM_ROUTES)) {
      expect(ids.has(key), `route "${key}" matches no row`).toBe(true);
    }
  });
});

// The same lesson, reached a third time. The all-clear only ever DOES anything
// when status and readiness disagree -- when they agree the row is already OK --
// so it is really "when the two reads disagree, believe readiness". Both guards
// above it were carved out after that turned out wrong, and a container or
// listener fault is the third case: ready.sh checks the same containers and TCP
// ports, so the two are contradicting each other and one read is simply stale.
// Showing it is the fail-safe direction; hiding it makes an outage read green.
describe("a readiness all-clear does not override a fault status can see", () => {
  function rows(status: string, readiness: string) {
    return summarizeHomeStatus(status, readiness, "", false).health;
  }
  it("keeps a down container visible under a green readiness", () => {
    const down = statusText({ downContainers: 1 });
    const database = rows(down, READY_READINESS).find((r) => r.id === "database");
    expect(database?.value).toBe("Needs Review");
    expect(database?.status).toBe("WARN");
  });

  it("keeps a closed listener visible under a green readiness", () => {
    const shut = statusText({ badListeners: 1 });
    const database = rows(shut, READY_READINESS).find((r) => r.id === "database");
    expect(database?.value).toBe("Needs Review");
  });

  it("leaves every row status has no complaint about alone", () => {
    const shown = rows(statusText({ downContainers: 1 }), READY_READINESS)
      .filter((r) => r.id !== "database")
      .map((r) => r.value);
    expect(shown).toEqual(["OK", "OK", "OK", "OK"]);
  });

  // The carve-out that keeps this from being a blanket "never trust readiness":
  // Unknown is not a fault, it is the absence of a reading, and filling that in
  // is the one thing the all-clear is still there to do.
  //
  // Asserted on `battlegroup` specifically. It is the only row with no
  // readiness-derived fallback, so it is the only one that can still read
  // Unknown while readiness reports READY -- on every other row
  // preferKnownHomeHealth has already filled the gap from readiness, and the
  // override never gets a say. Written against `database` first, this passed
  // whether the carve-out existed or not.
  it("still fills in a reading status could not produce at all", () => {
    const noContainerTable = [
      "=== Dune status ===",
      "Overall:     READY",
      "Title:       Example Sietch",
      "Population:  0/120",
      ""
    ].join("\n");
    const battlegroup = rows(noContainerTable, READY_READINESS).find((r) => r.id === "battlegroup");
    expect(battlegroup?.value).toBe("OK");
    expect(battlegroup?.status).toBe("Ready");
  });

  it("does not fill in that gap when readiness is not all-clear", () => {
    const noContainerTable = [
      "=== Dune status ===",
      "Overall:     READY",
      ""
    ].join("\n");
    const battlegroup = rows(noContainerTable, "").find((r) => r.id === "battlegroup");
    expect(battlegroup?.value).toBe("Unknown");
  });

  // Mid-transition the row must not jump to a bare warning: transitionHomeHealthCard
  // sits directly behind the override and reports the honest in-progress state.
  it("reads Getting Ready, not Needs Review, during a start", () => {
    const down = statusText({ downContainers: 1 });
    const database = summarizeHomeStatus(down, READY_READINESS, "", false, "start").health.find((r) => r.id === "database");
    expect(database?.value).toBe("Getting Ready");
  });
});

// ready.sh decides READY from the core containers and the two protected maps
// only, so on a host with more always-on maps it reports READY while several
// are still warming. Believing it left the hero reading "Ready" beside
// "Game servers 2 of 7" -- observed live on dune2 during a restart.
describe("a readiness all-clear does not override an incomplete roster", () => {
  const partlyWarm = statusText({
    maps: [
      ["Survival_1", "READY"],
      ["Survival_1#60", "READY"],
      ["Overmap", "READY"],
      ["SH_Arrakeen", "WARMING"],
      ["SH_HarkoVillage", "WARMING"],
      ["DeepDesert_1", "WARMING"],
      ["DeepDesert_1#59", "WARMING"]
    ]
  });

  function overall(status: string, readiness: string) {
    return summarizeHomeStatus(status, readiness, "", false).identity.find((i) => i.label === "Overall")?.value;
  }

  it("reads Starting, not OK, while maps are still coming up", () => {
    expect(overall(partlyWarm, READY_READINESS)).toBe("Starting");
  });

  it("still shows the real reading on the row rather than a blanket OK", () => {
    expect(values(partlyWarm, READY_READINESS)["Game servers"]).toBe("Warming");
    expect(counts(partlyWarm, READY_READINESS)["Game servers"]).toBe("3 of 7");
  });

  // The rows that ARE fine must not be dragged down with it.
  it("leaves the healthy rows alone", () => {
    expect(values(partlyWarm, READY_READINESS).Messaging).toBe("OK");
    expect(values(partlyWarm, READY_READINESS).Database).toBe("OK");
  });

  it("reads OK once the whole roster is up", () => {
    expect(overall(statusText(), READY_READINESS)).toBe("OK");
  });
});

// World servers start after Postgres, RabbitMQ, the text router and the
// director, so early in a start they are waiting on dependencies rather than
// loading. Reporting both as "Warming" overstated how far along a start was,
// and "Info" read as a neutral aside for something the operator is actively
// waiting on -- while the hero said "Starting" at the same moment.
describe("maps that have not started yet read differently from maps that are loading", () => {
  const allWaiting = statusText({ maps: MAPS.map(([l]) => [l, "WAIT"] as [string, string]) });
  const someWarming = statusText({
    maps: MAPS.map(([l], i) => [l, i < 3 ? "READY" : i === 3 ? "WARMING" : "WAIT"] as [string, string])
  });

  it("reads Waiting when nothing has been spawned yet", () => {
    expect(values(allWaiting, "")["Game servers"]).toBe("Waiting");
    expect(counts(allWaiting, "")["Game servers"]).toBe("0 of 7");
  });

  it("reads Warming once a map is actually loading", () => {
    expect(values(someWarming, "")["Game servers"]).toBe("Warming");
  });

  it("badges both as Starting rather than Info", () => {
    const statusOf = (text: string) =>
      summarizeHomeStatus(text, "", "", false).health.find((i) => i.id === "games")?.status;
    expect(statusOf(allWaiting)).toBe("Starting");
    expect(statusOf(someWarming)).toBe("Starting");
  });

  // Six call sites ask "are the maps on their way up?". A bare /^Warming$/i
  // check would silently stop matching the moment a start is early enough to
  // report Waiting -- the same label-as-key trap that dropped row routes.
  it("treats both labels as coming up", () => {
    expect(isGameServersComingUp("Warming")).toBe(true);
    expect(isGameServersComingUp("Waiting")).toBe(true);
    expect(isGameServersComingUp("OK")).toBe(false);
    expect(isGameServersComingUp("Needs Review")).toBe(false);
    expect(isGameServersComingUp(undefined)).toBe(false);
  });
});

// The hero and the rows have to agree. Saying "Starting" up top while a row
// says "Needs Review" invites someone to go looking for a fault that is really
// just a service that has not registered yet.
describe("the rows follow the hero during a start", () => {
  const warming = statusText({
    maps: MAPS.map(([l], i) => [l, i < 2 ? "READY" : "WARMING"] as [string, string]),
    flsWait: 3
  });

  it("shows a not-yet-registered subsystem as Getting Ready, not Needs Review", () => {
    expect(values(warming, READY_READINESS)["Funcom/FLS"]).toBe("Getting Ready");
  });

  it("keeps the hero and that row in the same vocabulary", () => {
    const s = summarizeHomeStatus(warming, READY_READINESS, "", false);
    expect(s.identity.find((i) => i.label === "Overall")?.value).toBe("Starting");
    expect(s.health.find((i) => i.id === "fls")?.status).toBe("Starting");
  });

  // The other half: when the maps are genuinely down rather than starting, a
  // READY readiness must not let the hero read OK over a Needs Review row.
  it("does not read OK over a broken roster", () => {
    const broken = statusText({ maps: MAPS.map(([l]) => [l, "NOT RUNNING"] as [string, string]) });
    const s = summarizeHomeStatus(broken, READY_READINESS, "", false);
    expect(s.health.find((i) => i.id === "games")?.value).toBe("Needs Review");
    expect(s.identity.find((i) => i.label === "Overall")?.value).toBe("Needs Review");
  });
});
