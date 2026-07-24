import { describe, it, expect } from "vitest";
import { deepDesertPartitionName } from "./MapsPanel";
import type { PartitionCombatStateRow } from "../../api/maps";

// Regression coverage for the fix to deepDesertPartitionName: it must
// resolve PvP/PvE labeling from the server-resolved combat state (backed by
// the effective UserGame.ini configuration), never from `row.dimension`.
// Previously dimension 0 was hard-labeled "Deep Desert PvP" and dimension 1
// "Deep Desert PvE" regardless of actual partition configuration.

function combatRow(overrides: Partial<PartitionCombatStateRow> = {}): PartitionCombatStateRow {
  return {
    map: "DeepDesert_1",
    partitionId: "8",
    dimensionIndex: 0,
    databaseLabel: "DeepDesert_0",
    runtimeStatus: "RUNNING",
    configuredState: "PVE",
    materializedState: "PVE",
    source: "legacy-flags",
    securityZonesEnabled: true,
    restartRequired: false,
    configurationDrift: false,
    warnings: [],
    ...overrides
  };
}

describe("deepDesertPartitionName", () => {
  it("uses a real database label when present and not purely numeric", () => {
    const name = deepDesertPartitionName({ label: "Custom Sietch Name", dimension: 0 });
    expect(name).toBe("Custom Sietch Name");
  });

  it("falls back to a neutral instance name with no combat state supplied", () => {
    const name = deepDesertPartitionName({ label: "", dimension: 0 });
    expect(name).toBe("Deep Desert 1");
  });

  it("does NOT label dimension 0 as PvP when the resolved combat state is PVE", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 0 },
      combatRow({ dimensionIndex: 0, configuredState: "PVE" })
    );
    expect(name).toContain("PvE");
    expect(name).not.toContain("PvP");
  });

  it("does NOT label dimension 1 as PvE when the resolved combat state is PVP", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 1 },
      combatRow({ dimensionIndex: 1, partitionId: "9", configuredState: "PVP" })
    );
    expect(name).toContain("PvP");
    expect(name).not.toContain("PvE");
  });

  it("surfaces a CONFLICT combat state instead of guessing PvP or PvE", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 0 },
      combatRow({ configuredState: "CONFLICT" })
    );
    expect(name).toMatch(/conflicting/i);
    expect(name).not.toContain("(PvP)");
    expect(name).not.toContain("(PvE)");
  });

  it("does not append a PvP/PvE suffix when combat state is UNKNOWN", () => {
    const name = deepDesertPartitionName(
      { label: "", dimension: 0 },
      combatRow({ configuredState: "UNKNOWN" })
    );
    expect(name).toBe("Deep Desert 1");
  });

  it("a purely numeric database label is treated as non-descriptive and ignored", () => {
    const name = deepDesertPartitionName(
      { label: "0", dimension: 0 },
      combatRow({ configuredState: "PVP" })
    );
    expect(name).toContain("PvP");
  });
});
