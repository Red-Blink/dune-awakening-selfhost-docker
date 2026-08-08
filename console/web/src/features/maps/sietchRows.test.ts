import { describe, expect, it } from "vitest";
import { isSietchWriteTarget, parseSietchRows } from "./sietchRows";

describe("parseSietchRows", () => {
  // Verbatim `dune sietches dimensions DeepDesert_1` output and its --ids
  // companion, captured from the live server.
  it("pairs each dimension with the partition id at the same index", () => {
    const table = [
      "DIMENSION  DISPLAY NAME                     PASSWORD",
      "0          Deep Desert PvP                  (unset)",
      "1          Deep Desert PvE                  (unset)"
    ].join("\n");

    expect(parseSietchRows(table, "8\n59\n").map((row) => [row.partitionId, row.displayName])).toEqual([
      ["8", "Deep Desert PvP"],
      ["59", "Deep Desert PvE"]
    ]);
  });

  // Display names are whatever the operator typed. Nothing here may assume a
  // "Sietch " prefix, ASCII, single spacing, or that the name is not itself a
  // number -- every one of these is a name a server owner could set.
  it("preserves arbitrary operator-chosen names", () => {
    const table = [
      "DIMENSION  DISPLAY NAME                     PASSWORD",
      "0          Awesome Map                      (unset)",
      "1          The Kulon Show                   (set)",
      "2          12345                            (unset)",
      "3          Bob's (unset) Palace             (unset)",
      "4          Sietch   double  spaces          (unset)",
      "5          Ünïcôdé Sïétch                   (unset)",
      "6          a                                (unset)"
    ].join("\n");

    expect(parseSietchRows(table, "1\n31\n55\n7\n8\n9\n10\n").map((row) => row.displayName)).toEqual([
      "Awesome Map",
      "The Kulon Show",
      "12345",
      // The (unset) marker is anchored to end-of-line, so a name containing
      // one of its own survives intact.
      "Bob's (unset) Palace",
      "Sietch   double  spaces",
      "Ünïcôdé Sïétch",
      "a"
    ]);
  });

  it("reads the password flag per row", () => {
    const table = [
      "DIMENSION  DISPLAY NAME                     PASSWORD",
      "0          Locked Sietch                    (set)",
      "1          Open Sietch                      (unset)"
    ].join("\n");

    expect(parseSietchRows(table, "1\n2\n").map((row) => row.passwordSet)).toEqual([true, false]);
  });

  it("falls back to the dimension when no partition ids are supplied", () => {
    const table = "0          Solo Sietch                      (unset)";
    expect(parseSietchRows(table)).toEqual([
      // partitionIdFromIds false: this id is a dimension index wearing the
      // partition field, unique only within this one map.
      { partitionId: "0", partitionIdFromIds: false, dimension: "0", displayName: "Solo Sietch", password: "", passwordSet: false, active: true }
    ]);
  });

  // The --ids call can succeed with fewer ids than the table has rows. Rows
  // past the end must be marked as fallbacks too, not just an all-empty ids
  // list -- BasesPanel pools rows from several maps and keys on this flag.
  it("marks only the rows an id actually covered", () => {
    const table = [
      "DIMENSION  DISPLAY NAME                     PASSWORD",
      "0          Deep Desert PvP                  (unset)",
      "1          Deep Desert PvE                  (unset)"
    ].join("\n");

    expect(parseSietchRows(table, "8\n").map((row) => [row.partitionId, row.partitionIdFromIds])).toEqual([
      ["8", true],
      ["1", false]
    ]);
  });
});

describe("isSietchWriteTarget", () => {
  // Real `dune sietches dimensions Survival_1 --active-only` shape: three
  // dimensions whose partitions are 1, 31 and 55 -- deliberately not equal to
  // their dimension indices, which is what makes the fallback dangerous.
  const SURVIVAL_TABLE = [
    "DIMENSION  DISPLAY NAME                     PASSWORD",
    "0          Hagga Basin                      (unset)",
    "1          Sietch Abbir                     (set)",
    "2          The Kulon Show                   (unset)"
  ].join("\n");

  it("accepts every row when the partition ids were read", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, "1\n31\n55\n");
    expect(rows.filter(isSietchWriteTarget).map((row) => row.partitionId)).toEqual(["1", "31", "55"]);
  });

  // `sietches dimensions --ids` is a separate CLI invocation from the one that
  // prints the table, and the API answers 200 with empty stdout when it fails.
  // The rows still parse, but their partition ids are dimension indices: using
  // one as a write target would rename dimension 1 by sending partition "1",
  // which is a different sietch entirely.
  it("rejects every row when the partition ids could not be read", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, "");
    expect(rows.map((row) => row.partitionId)).toEqual(["0", "1", "2"]);
    expect(rows.filter(isSietchWriteTarget)).toEqual([]);
  });

  it("rejects only the rows the ids output did not cover", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, "1\n31\n");
    expect(rows.filter(isSietchWriteTarget).map((row) => row.partitionId)).toEqual(["1", "31"]);
  });
});
