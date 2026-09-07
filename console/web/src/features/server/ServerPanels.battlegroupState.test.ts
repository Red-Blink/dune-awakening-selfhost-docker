import { describe, expect, it } from "vitest";
import { getHomeServerState, isGameStackDown } from "./ServerPanels";

// Verbatim from a host after a system restore: the console started Postgres
// itself, and nothing else in the Battlegroup is up. Every field the state
// functions read is present, so this pins the real case rather than a sketch.
const restoredHostStatus = [
  "=== Dune status ===",
  "Overall:     ISSUE",
  "Title:       SteelHeart",
  "Battlegroup: sh-372e084875362ee5-krlquy",
  "",
  "=== Containers ===",
  "SERVICE                    STATUS",
  "dune-postgres              Up 31 minutes",
  "dune-rmq-admin             missing",
  "dune-rmq-game              missing",
  "dune-text-router           missing",
  "dune-director              missing",
  "dune-server-gateway        missing",
  "dune-server-survival-1     missing",
  "dune-server-overmap        missing",
  "dune-coriolis-coordinator  Up 31 minutes",
  "dune-orchestrator          Up 33 minutes",
  "",
  "=== Game servers ===",
  "MAP          STATE        UPTIME",
  "Survival_1   NOT RUNNING  missing",
  "Overmap      NOT RUNNING  missing"
].join("\n");

const runningStatus = restoredHostStatus
  .replace(/dune-rmq-admin             missing/, "dune-rmq-admin             Up 5 minutes")
  .replace(/dune-server-survival-1     missing/, "dune-server-survival-1     Up 4 minutes")
  .replace(/dune-server-overmap        missing/, "dune-server-overmap        Up 4 minutes");

describe("Battlegroup state on a host where only Postgres is up", () => {
  it("reports the Battlegroup stopped, not starting", () => {
    // Postgres, the orchestrator and the coordinator all run without a
    // Battlegroup, so on their own they were enough to report "starting"
    // forever -- which disabled Start on a host that was not running.
    const state = getHomeServerState(restoredHostStatus, "");
    expect(state.stopped).toBe(true);
    expect(state.starting).toBe(false);
    expect(state.running).toBe(false);
  });

  it("names the state rather than reporting a bare Stopped over a live database", () => {
    // The console starts Postgres itself for backups and restores and leaves it
    // up, so this is a state it creates on purpose.
    expect(getHomeServerState(restoredHostStatus, "").databaseOnly).toBe(true);
  });

  it("is not database-only once the game stack is up", () => {
    expect(getHomeServerState(runningStatus, "").databaseOnly).toBe(false);
  });

  it("is not database-only when Postgres is down too", () => {
    const allDown = restoredHostStatus.replace("dune-postgres              Up 31 minutes", "dune-postgres              missing");
    const state = getHomeServerState(allDown, "");
    expect(state.databaseOnly).toBe(false);
    expect(state.stopped).toBe(true);
  });

  it("still sees a starting Battlegroup once the game stack comes up", () => {
    const state = getHomeServerState(runningStatus, "");
    expect(state.stopped).toBe(false);
    expect(state.starting || state.running).toBe(true);
  });
});

describe("isGameStackDown", () => {
  it("is true when every game container is missing, whatever else is up", () => {
    expect(isGameStackDown(restoredHostStatus)).toBe(true);
  });

  it("is false as soon as one game container is up", () => {
    expect(isGameStackDown(runningStatus)).toBe(false);
  });

  it("is false when the container list is partial, rather than guessing", () => {
    const partial = [
      "=== Containers ===",
      "SERVICE                    STATUS",
      "dune-postgres              Up 2 minutes",
      "dune-rmq-admin             missing"
    ].join("\n");
    expect(isGameStackDown(partial)).toBe(false);
  });
});
