import { describe, expect, it } from "vitest";
import { containerStatusLineHas, isHomeStopComplete, preserveTerminalStackResult, serverSettingsProgressTitle, serverSettingsRestartNotice } from "./ServerPanels";

describe("server settings restart feedback", () => {
  it("names both maps for network changes and the Director's dependent map for title changes", () => {
    expect(serverSettingsRestartNotice(true)).toMatch(/Director, Gateway, Survival_1, and Overmap if running/);
    expect(serverSettingsRestartNotice(false)).toContain("restarts a running Survival_1");
    expect(serverSettingsRestartNotice(false)).not.toContain("Overmap");
  });

  it("shows the latest actual restart, including the map restarted by Director", () => {
    const lines = [{ line: "Updated server mode: public" }];
    expect(serverSettingsProgressTitle(lines)).toBe("Saving Settings");
    for (const [service, label] of [["director", "Director"], ["Survival_1", "Survival_1"], ["gateway", "Gateway"], ["Overmap", "Overmap"]]) {
      lines.push({ line: `Restarting ${service} so the settings take effect...` }, { line: "Waiting..." });
      expect(serverSettingsProgressTitle(lines)).toBe(`Restarting ${label}`);
    }
  });
});

// Keep the shared parser tolerant of docker ps-style column padding while
// requiring an exact container-name match.
describe("containerStatusLineHas", () => {
  it("matches a start-anchored status pattern across multiple spaces of padding", () => {
    expect(containerStatusLineHas("dune-postgres", "dune-postgres   Up 5 minutes", /^Up\b/i)).toBe(true);
  });

  it("matches a start-anchored status pattern with only a single space", () => {
    expect(containerStatusLineHas("dune-postgres", "dune-postgres Up 5 minutes", /^Up\b/i)).toBe(true);
  });

  it("does not match a different container name", () => {
    expect(containerStatusLineHas("dune-postgres", "dune-postgres-backup   Up 5 minutes", /^Up\b/i)).toBe(false);
  });

  it("still matches a mid-string status pattern (e.g. missing/stopped) regardless of padding", () => {
    expect(containerStatusLineHas("dune-rmq-game", "dune-rmq-game     stopped", /\b(missing|stopped|exited|dead|not running)\b/i)).toBe(true);
  });
});

describe("isHomeStopComplete", () => {
  const requiredContainers = [
    "dune-postgres",
    "dune-rmq-admin",
    "dune-rmq-game",
    "dune-text-router",
    "dune-director",
    "dune-server-gateway",
    "dune-server-survival-1",
    "dune-server-overmap"
  ];

  it("recognizes stopped containers even when status output pads names with multiple spaces", () => {
    const lines = requiredContainers.map((name) => `${name}     stopped`);
    const status = ["=== Containers ===", "SERVICE   STATUS", ...lines, "=== Listeners ==="].join("\n");
    expect(isHomeStopComplete(status, "")).toBe(true);
  });

  it("does not report stop-complete for a running container list", () => {
    const lines = requiredContainers.map((name) => `${name} Up 5 minutes`);
    const status = ["=== Containers ===", "SERVICE STATUS", ...lines, "=== Listeners ==="].join("\n");
    expect(isHomeStopComplete(status, "")).toBe(false);
  });
});

describe("preserveTerminalStackResult", () => {
  it("does not let a late readiness poll replace startup success with Finalizing Startup", () => {
    const succeeded = { status: "succeeded" as const, title: "Battlegroup Started Successfully" };
    const staleProgress = {
      status: "running" as const,
      title: "Finalizing Startup",
      message: "Services reported ready once. Confirming they stay ready."
    };

    expect(preserveTerminalStackResult(succeeded, staleProgress)).toBe(succeeded);
  });

  it("continues updating progress while the action is still running", () => {
    const waiting = { status: "running" as const, title: "Waiting for Server Readiness" };
    const confirming = { status: "running" as const, title: "Finalizing Startup" };

    expect(preserveTerminalStackResult(waiting, confirming)).toEqual(confirming);
  });
});
