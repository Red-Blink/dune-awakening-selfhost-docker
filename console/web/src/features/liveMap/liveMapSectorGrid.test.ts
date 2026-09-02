import { describe, expect, it } from "vitest";
import type { LiveMapConfig } from "../../api/liveMap";
import { labelAnchorInView, sectorForWorldPoint, sectorGridFor } from "./liveMapSectorGrid";

const DEEP_DESERT: LiveMapConfig = {
  key: "DeepDesert", label: "The Deep Desert", actorMap: "DeepDesert",
  image: "/images/maps/deep-desert.png", width: 4096, height: 4096,
  minX: -1177656, maxX: 1072344, minY: -1177066, maxY: 1072934,
  flipY: false, defaultPartitionId: 8
};
const HAGGA: LiveMapConfig = { ...DEEP_DESERT, key: "HaggaBasin", actorMap: "HaggaBasin" };

const CENTRE_X = -52656;
const CENTRE_Y = -52066;
const HALF = 1125000;
const CELL = 250000;

describe("sectorForWorldPoint", () => {
  // Orientation is checked against the game's own map art, which carries the
  // labels burned in: I1-I9 across the top, A1-A9 across the bottom. World +Y
  // draws downward in the panel, so the letter runs OPPOSITE to screen-down --
  // the obvious guess (A first, going down) is upside down.
  it("puts A at the high-Y edge and I at the low-Y edge", () => {
    expect(sectorForWorldPoint(CENTRE_X - HALF + 1, CENTRE_Y + HALF - 1)).toBe("A1");
    expect(sectorForWorldPoint(CENTRE_X - HALF + 1, CENTRE_Y - HALF + 1)).toBe("I1");
  });

  it("numbers columns west to east", () => {
    expect(sectorForWorldPoint(CENTRE_X + HALF - 1, CENTRE_Y + HALF - 1)).toBe("A9");
    expect(sectorForWorldPoint(CENTRE_X + HALF - 1, CENTRE_Y - HALF + 1)).toBe("I9");
  });

  it("puts the map centre in the middle cell", () => {
    expect(sectorForWorldPoint(CENTRE_X, CENTRE_Y)).toBe("E5");
  });

  it("steps one letter per cell down the grid", () => {
    const column = CENTRE_X - HALF + CELL / 2;
    const letters = Array.from({ length: 9 }, (_, row) =>
      sectorForWorldPoint(column, CENTRE_Y + HALF - (row + 0.5) * CELL));
    expect(letters).toEqual(["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1", "I1"]);
  });

  it("returns null outside the grid rather than an out-of-range letter", () => {
    expect(sectorForWorldPoint(CENTRE_X - HALF - 1, CENTRE_Y)).toBeNull();
    expect(sectorForWorldPoint(CENTRE_X, CENTRE_Y + HALF + 1)).toBeNull();
    // The rect and the grid now coincide, so the far corner is the grid's own
    // exclusive edge rather than a point beyond it -- still no sector, but for a
    // different reason.
    expect(sectorForWorldPoint(DEEP_DESERT.minX, DEEP_DESERT.minY)).toBeNull();
    // and one cell inside that corner does have a sector
    expect(sectorForWorldPoint(DEEP_DESERT.minX + 1, DEEP_DESERT.minY + 1)).toBe("I1");
  });
});

describe("sectorGridFor", () => {
  it("returns 10 lines per axis and 81 labels", () => {
    const grid = sectorGridFor(DEEP_DESERT)!;
    expect(grid.lines).toHaveLength(20);
    expect(grid.labels).toHaveLength(81);
  });

  it("marks only the outer lines as edges", () => {
    const grid = sectorGridFor(DEEP_DESERT)!;
    expect(grid.lines.filter((line) => line.edge)).toHaveLength(4);
  });

  it("places labels where the sector lookup agrees they belong", () => {
    // The drawn label and the coordinate readout must never disagree.
    const grid = sectorGridFor(DEEP_DESERT)!;
    const toWorldX = (px: number) => DEEP_DESERT.minX + (px / DEEP_DESERT.width) * (DEEP_DESERT.maxX - DEEP_DESERT.minX);
    const toWorldY = (py: number) => DEEP_DESERT.minY + (py / DEEP_DESERT.height) * (DEEP_DESERT.maxY - DEEP_DESERT.minY);
    for (const label of grid.labels) {
      expect(sectorForWorldPoint(toWorldX(label.px), toWorldY(label.py))).toBe(label.text);
    }
  });

  it("draws A1 below I1 on screen, matching the game's map art", () => {
    const grid = sectorGridFor(DEEP_DESERT)!;
    const a1 = grid.labels.find((l) => l.text === "A1")!;
    const i1 = grid.labels.find((l) => l.text === "I1")!;
    expect(a1.py).toBeGreaterThan(i1.py);
    expect(a1.px).toBeCloseTo(i1.px, 6);
  });

  it("is Deep Desert only -- Hagga Basin has no lettered sector grid", () => {
    expect(sectorGridFor(HAGGA)).toBeNull();
  });

  it("spans the image exactly, because the rect is the sector square", () => {
    // The config rect used to be ~8% wider than the square the image covers, so
    // this grid sat inset 153 px per side while the picture's own grid ran edge
    // to edge. The two now describe the same world square.
    const grid = sectorGridFor(DEEP_DESERT)!;
    const xs = grid.lines.flatMap((line) => [line.x1, line.x2]);
    const ys = grid.lines.flatMap((line) => [line.y1, line.y2]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(DEEP_DESERT.width, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(DEEP_DESERT.height, 6);
  });
});

describe("labelAnchorInView", () => {
  const grid = sectorGridFor(DEEP_DESERT)!;
  const cell = grid.labels.find((l) => l.text === "E5")!;

  it("uses the cell's own centre when the whole cell is visible", () => {
    const anchor = labelAnchorInView(cell, { left: 0, top: 0, right: 4096, bottom: 4096 }, 0)!;
    expect(anchor.px).toBeCloseTo(cell.px, 6);
    expect(anchor.py).toBeCloseTo(cell.py, 6);
  });

  it("follows the viewport when the cell is larger than it", () => {
    // The case that matters: above ~2x zoom a cell is wider than the frame, so a
    // label at the true centre is off-screen and the grid stops being useful.
    const view = { left: cell.x0 + 10, top: cell.y0 + 10, right: cell.x0 + 90, bottom: cell.y0 + 90 };
    const anchor = labelAnchorInView(cell, view, 0)!;
    expect(anchor.px).toBeCloseTo(50 + cell.x0, 6);
    expect(anchor.py).toBeCloseTo(50 + cell.y0, 6);
    expect(anchor.px).not.toBeCloseTo(cell.px, 0);
  });

  it("stays inside the cell when the viewport straddles a boundary", () => {
    const view = { left: cell.x0 - 500, top: cell.y0 - 500, right: cell.x0 + 100, bottom: cell.y0 + 100 };
    const anchor = labelAnchorInView(cell, view, 0)!;
    expect(anchor.px).toBeGreaterThanOrEqual(cell.x0);
    expect(anchor.py).toBeGreaterThanOrEqual(cell.y0);
    expect(anchor.px).toBeLessThanOrEqual(cell.x1);
  });

  it("returns null when the cell is off-screen entirely", () => {
    expect(labelAnchorInView(cell, { left: 0, top: 0, right: 5, bottom: 5 }, 0)).toBeNull();
  });

  it("returns null when the visible sliver is thinner than the padding", () => {
    // Rather than jam a label into a 3px strip at the very edge of the frame.
    const view = { left: cell.x1 - 4, top: cell.y0, right: cell.x1 + 500, bottom: cell.y1 };
    expect(labelAnchorInView(cell, view, 20)).toBeNull();
  });
});

// Finding 16: the padding is in map pixels, so it grows as you zoom out. At the
// fit on a 375px viewport it demanded 524 map-px of clearance from a 421 map-px
// cell, and every one of the 81 labels was suppressed -- a grid of bare lines.
describe("labels survive being zoomed out", () => {
  const grid = sectorGridFor(DEEP_DESERT)!;

  function visibleAt(viewportPx: number) {
    const zoom = viewportPx / DEEP_DESERT.width;
    const view = { left: 0, top: 0, right: DEEP_DESERT.width, bottom: DEEP_DESERT.height };
    // The panel's own figure: label size scaled back out of map space.
    const padding = (15 * 1.6) / zoom;
    return grid.labels.filter((label) => labelAnchorInView(label, view, padding) !== null).length;
  }

  it("labels every cell at a phone's fit zoom, where all 81 used to vanish", () => {
    expect(visibleAt(375)).toBe(81);
  });

  it("labels every cell on a tablet and a desktop too", () => {
    expect(visibleAt(768)).toBe(81);
    expect(visibleAt(1400)).toBe(81);
  });

  it("still refuses a sliver too thin to label", () => {
    // The case the padding exists for is far smaller than the cap and unchanged.
    const cell = grid.labels.find((l) => l.text === "E5")!;
    const view = { left: cell.x1 - 4, top: cell.y0, right: cell.x1 + 500, bottom: cell.y1 };
    expect(labelAnchorInView(cell, view, 20)).toBeNull();
  });
});
