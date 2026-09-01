import type { LiveMapConfig } from "../../api/liveMap";
import { worldToLiveMapPoint } from "./liveMapGeometry";

/**
 * The Deep Desert's 9x9 lettered sector grid.
 *
 * Game constants, not derived from the map config: the grid is 250,000 uu cells
 * spanning +/-1,125,000 uu about the map centre. The centre happens to match
 * `LIVE_MAP_CONFIGS`' centre exactly, but they are independent facts -- the grid
 * would not move if the config's bounds were ever retuned.
 *
 * Orientation is confirmed against the game's own map art
 * (`images/maps/deep-desert.png`, which carries the labels burned in): **I is at
 * the top and A at the bottom**. World +Y draws downward in the panel, so the
 * letter runs opposite to screen-down -- the row index counts down from the
 * high-Y edge. Easy to get upside down by assuming A comes first.
 */
const CENTRE_X = -52656;
const CENTRE_Y = -52066;
const HALF = 1125000;
const CELL = 250000;
const DIVISIONS = 9;

export type SectorGridLine = { x1: number; y1: number; x2: number; y2: number; edge: boolean };
/**
 * `px`/`py` is the cell's centre; `x0..y1` is its full footprint, both in
 * map-pixel space. The footprint is what lets a label be kept inside the
 * visible part of its cell when the cell is larger than the viewport.
 */
export type SectorGridLabel = { text: string; px: number; py: number; x0: number; y0: number; x1: number; y1: number };

/**
 * Which sector a world point falls in, or null outside the grid.
 *
 * Nothing in the panel calls this: the overlay is built from `sectorGridFor`,
 * which walks rows and columns directly. It is kept because it states the
 * mapping the other way round -- world point to label -- and the orientation
 * tests check the drawn grid against it. Deleting it would remove the only
 * independent statement that I is at the top, which is the thing here most
 * likely to be got wrong.
 */
export function sectorForWorldPoint(x: number, y: number): string | null {
  const column = Math.floor((x - (CENTRE_X - HALF)) / CELL);
  const row = Math.floor((CENTRE_Y + HALF - y) / CELL);
  if (column < 0 || column >= DIVISIONS || row < 0 || row >= DIVISIONS) return null;
  return `${String.fromCharCode(65 + row)}${column + 1}`;
}

/**
 * Where a cell's label should sit given the currently visible region, all in
 * map-pixel space: the centre of the part of the cell you can actually see.
 *
 * At the map's higher zooms a single 250,000 uu cell is wider than the frame, so
 * a label pinned to the cell's true centre scrolls out of view and the grid
 * stops answering the only question it exists for -- which sector am I looking
 * at. Returns null when too little of the cell is visible to label.
 */
export function labelAnchorInView(
  label: SectorGridLabel,
  view: { left: number; top: number; right: number; bottom: number },
  padding: number
): { px: number; py: number } | null {
  // Padding is given in map pixels, so it grows as you zoom out: at the fit on a
  // phone it asked for more clearance than a whole cell is wide and suppressed
  // all 81 labels, leaving a grid of unlabelled lines. Cap it against the cell
  // so a fully visible cell always gets its label; the sliver case that the
  // padding exists for is unaffected, being far smaller than a quarter cell.
  const capped = Math.min(padding, Math.min(label.x1 - label.x0, label.y1 - label.y0) / 4);
  const left = Math.max(label.x0, view.left) + capped;
  const right = Math.min(label.x1, view.right) - capped;
  const top = Math.max(label.y0, view.top) + capped;
  const bottom = Math.min(label.y1, view.bottom) - capped;
  if (right < left || bottom < top) return null;
  return { px: (left + right) / 2, py: (top + bottom) / 2 };
}

/**
 * Grid lines and cell labels in the panel's map-pixel space, so they scale and
 * scroll with the markers by multiplying through by `zoom` exactly as a marker
 * does. Returns null for a map that has no sector grid.
 */
export function sectorGridFor(config: LiveMapConfig): { lines: SectorGridLine[]; labels: SectorGridLabel[] } | null {
  if (config.key !== "DeepDesert") return null;

  const at = (x: number, y: number) => worldToLiveMapPoint({ x, y }, config);
  const lines: SectorGridLine[] = [];
  for (let i = 0; i <= DIVISIONS; i++) {
    const edge = i === 0 || i === DIVISIONS;
    const offset = -HALF + i * CELL;
    const vertical = [at(CENTRE_X + offset, CENTRE_Y - HALF), at(CENTRE_X + offset, CENTRE_Y + HALF)];
    const horizontal = [at(CENTRE_X - HALF, CENTRE_Y + offset), at(CENTRE_X + HALF, CENTRE_Y + offset)];
    if (vertical[0] && vertical[1]) {
      lines.push({ x1: vertical[0].px, y1: vertical[0].py, x2: vertical[1].px, y2: vertical[1].py, edge });
    }
    if (horizontal[0] && horizontal[1]) {
      lines.push({ x1: horizontal[0].px, y1: horizontal[0].py, x2: horizontal[1].px, y2: horizontal[1].py, edge });
    }
  }

  const labels: SectorGridLabel[] = [];
  for (let row = 0; row < DIVISIONS; row++) {
    for (let column = 0; column < DIVISIONS; column++) {
      // Cell centre: columns run with +X, rows run against +Y.
      const centre = at(
        CENTRE_X - HALF + (column + 0.5) * CELL,
        CENTRE_Y + HALF - (row + 0.5) * CELL
      );
      const near = at(CENTRE_X - HALF + column * CELL, CENTRE_Y + HALF - row * CELL);
      const far = at(CENTRE_X - HALF + (column + 1) * CELL, CENTRE_Y + HALF - (row + 1) * CELL);
      if (!centre || !near || !far) continue;
      labels.push({
        text: `${String.fromCharCode(65 + row)}${column + 1}`,
        px: centre.px,
        py: centre.py,
        x0: Math.min(near.px, far.px),
        y0: Math.min(near.py, far.py),
        x1: Math.max(near.px, far.px),
        y1: Math.max(near.py, far.py)
      });
    }
  }
  return { lines, labels };
}
