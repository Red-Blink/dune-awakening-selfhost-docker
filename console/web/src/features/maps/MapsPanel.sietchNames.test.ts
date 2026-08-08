import { describe, expect, it } from "vitest";
import { parseSietchRows } from "./MapsPanel";

describe("Sietch display names", () => {
  it("preserves arbitrary names from the fixed-width CLI table", () => {
    const output = [
      "DIMENSION  DISPLAY NAME                     PASSWORD",
      "0          Awesome Map                      (set)",
      "1          The Kulon Show                   (unset)",
    ].join("\n");

    expect(parseSietchRows(output, "1\n31\n")).toEqual([
      { partitionId: "1", partitionIdFromIds: true, dimension: "0", displayName: "Awesome Map", password: "", passwordSet: true, active: true },
      { partitionId: "31", partitionIdFromIds: true, dimension: "1", displayName: "The Kulon Show", password: "", passwordSet: false, active: true },
    ]);
  });

  it("continues to preserve conventional Sietch-prefixed names", () => {
    const output = "0          Sietch Abbir v2                (unset)";
    expect(parseSietchRows(output, "55\n")[0]?.displayName).toBe("Sietch Abbir v2");
  });
});
