import { describe, expect, it } from "vitest";
import { buildReadinessGroups } from "./ReadinessTimeline";

describe("buildReadinessGroups", () => {
  it.each(["healthy", "unhealthy", "starting", "paused", "exited", "dead", "stopped"])("capitalizes the %s container detail", (state) => {
    const groups = buildReadinessGroups("", `=== Containers ===\ndune-postgres   Up 3 hours (${state})`);
    expect(groups["Container Checks"][0].detail).toBe(`Up 3 hours (${state.charAt(0).toUpperCase() + state.slice(1)})`);
  });
  it("shows the real RabbitMQ readiness result instead of the delegated status placeholder", () => {
    const readiness = `=== RabbitMQ game users ===
OK   game server sg.* RMQ connections`;
    const status = `=== RabbitMQ game connections ===
RabbitMQ connection details: Checked by readiness`;

    expect(buildReadinessGroups(readiness, status)["RabbitMQ Game Connections"]).toEqual([
      {
        name: "Game Server Connections",
        detail: "",
        status: "Ready",
        kind: "pass"
      }
    ]);
  });

  it.each([
    ["OK", "Ready", "pass"],
    ["WAIT", "Warn", "warn"],
    ["FAIL", "Failed", "fail"]
  ])("uses a friendly connection label without losing the %s result", (prefix, status, kind) => {
    const rows = buildReadinessGroups(`${prefix} game server sg.* RMQ connections`, "")["RabbitMQ Game Connections"];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Game Server Connections", status, kind });
    expect(rows[0].detail).not.toMatch(/sg\.\*|RMQ/i);
  });
});
