import { describe, expect, it } from "vitest";
import {
  buildDrawCalls,
  depthRange,
  dequantizePosition,
  octDecode,
  orthoFromWorldRect,
  projectWorldPoint,
  sampleHeightField
} from "./terrainGeometry";
import type { TerrainLayoutMeta, TerrainLibrary, TerrainView } from "./types";

// LIVE_MAP_CONFIGS.DeepDesert, verbatim from console/api/src/duneDb.js.
const CONFIG = {
  width: 4096,
  height: 4096,
  minX: -1177656,
  maxX: 1072344,
  minY: -1177066,
  maxY: 1072934,
  flipY: false
};

const fullView: TerrainView = {
  minX: CONFIG.minX,
  maxX: CONFIG.maxX,
  minY: CONFIG.minY,
  maxY: CONFIG.maxY,
  flipY: false
};

/** The panel's own world -> pixel mapping (LiveMapPanel's liveMapPointFor). */
function worldToPixel(x: number, y: number) {
  const px = ((x - CONFIG.minX) / (CONFIG.maxX - CONFIG.minX)) * CONFIG.width;
  let py = ((y - CONFIG.minY) / (CONFIG.maxY - CONFIG.minY)) * CONFIG.height;
  if (CONFIG.flipY) py = CONFIG.height - py;
  return { px, py };
}

describe("orthoFromWorldRect", () => {
  // The matrix is a Float32Array, so these compare to float32 precision (~1e-7)
  // rather than double. Tightening past that tests the storage type, not the math.
  it("maps the view's own corners onto the clip cube", () => {
    const m = orthoFromWorldRect(fullView, 1);
    const [tlx, tly] = projectWorldPoint(m, fullView.minX, fullView.minY, 0);
    const [brx, bry] = projectWorldPoint(m, fullView.maxX, fullView.maxY, 0);
    expect(tlx).toBeCloseTo(-1, 5);
    expect(brx).toBeCloseTo(1, 5);
    // World +Y is drawn downward, matching the panel's pixel space, so minY is
    // the TOP of the image (clip +1) and maxY the bottom.
    expect(tly).toBeCloseTo(1, 5);
    expect(bry).toBeCloseTo(-1, 5);
  });

  it("agrees with the panel's world-to-pixel mapping, which is what corrects the 8.1% mis-scale", () => {
    // The shipped PNG covers only the 9-sector grid but is stretched across the
    // config's rect, so it disagrees with marker positions by up to a third of a
    // sector at the edge. Rendering places geometry at its true world position,
    // so terrain and markers must land on the same pixel by construction.
    const m = orthoFromWorldRect(fullView, 1);
    for (const [wx, wy] of [
      [CONFIG.minX, CONFIG.minY],
      [CONFIG.maxX, CONFIG.maxY],
      [-52656, -52066], // map centre
      [-1138004, 400000], // the westernmost real marker observed live
      [900000, -900000]
    ]) {
      const { px, py } = worldToPixel(wx, wy);
      const [nx, ny] = projectWorldPoint(m, wx, wy, 0);
      // clip -> the same pixel space the panel positions markers in
      expect(((nx + 1) / 2) * CONFIG.width).toBeCloseTo(px, 3);
      expect(((1 - ny) / 2) * CONFIG.height).toBeCloseTo(py, 3);
    }
  });

  it("keeps a zoomed, scrolled sub-rect consistent with the full view", () => {
    const sub: TerrainView = { minX: -600000, maxX: -100000, minY: 100000, maxY: 600000, flipY: false };
    const m = orthoFromWorldRect(sub, 1);
    expect(projectWorldPoint(m, sub.minX, sub.minY, 0)[0]).toBeCloseTo(-1, 5);
    expect(projectWorldPoint(m, sub.maxX, sub.maxY, 0)[0]).toBeCloseTo(1, 5);
    // A point outside the sub-rect projects outside the clip cube, so it is
    // scissored away rather than wrapping back into view.
    expect(projectWorldPoint(m, -900000, 350000, 0)[0]).toBeLessThan(-1);
  });

  it("inverts the vertical axis when the map config asks for it", () => {
    const m = orthoFromWorldRect({ ...fullView, flipY: true }, 1);
    expect(projectWorldPoint(m, 0, fullView.minY, 0)[1]).toBeCloseTo(-1, 5);
    expect(projectWorldPoint(m, 0, fullView.maxY, 0)[1]).toBeCloseTo(1, 5);
  });

  it("puts higher ground in front, so a LESS depth test keeps it", () => {
    const m = orthoFromWorldRect(fullView, depthRange({ zmin: -20000, zmax: 20000 }));
    const low = projectWorldPoint(m, 0, 0, -5000)[2];
    const high = projectWorldPoint(m, 0, 0, 5000)[2];
    expect(high).toBeLessThan(low);
  });

  it("refuses a degenerate rectangle rather than emitting a matrix full of Infinity", () => {
    expect(() => orthoFromWorldRect({ ...fullView, maxX: fullView.minX }, 1)).toThrow(/positive extent/);
    expect(() => orthoFromWorldRect({ ...fullView, maxY: fullView.minY - 10 }, 1)).toThrow(/positive extent/);
  });
});

describe("buildDrawCalls", () => {
  const library: TerrainLibrary = {
    posBytes: 0,
    nrmBytes: 0,
    idxBytes: 0,
    meshes: [
      { lo: [0, 0, 0], ext: [60000, 70000, 900], vo: 0, vn: 4, io: 0, ic: 6 }, // landscape
      { lo: [0, 0, 0], ext: [1200, 900, 400], vo: 4, vn: 8, io: 6, ic: 12 } // rock
    ]
  };
  const layout = {
    layout: 3,
    draws: [
      { m: 1, off: 0, n: 5, overlay: 0 },
      { m: 0, off: 5, n: 2, overlay: 0 }
    ]
  } as unknown as TerrainLayoutMeta;

  it("pairs each draw with its library mesh and carries the instance range", () => {
    const calls = buildDrawCalls(library, layout);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ vo: 4, ic: 12, instOff: 0, instN: 5 });
    expect(calls[1]).toMatchObject({ vo: 0, ic: 6, instOff: 5, instN: 2 });
  });

  it("flags only landscape tiles for feathering, since only they overlap a neighbour", () => {
    const calls = buildDrawCalls(library, layout);
    expect(calls[0].land).toBe(false); // 1200 x 900 rock
    expect(calls[1].land).toBe(true); // 60000 x 70000 tile
  });

  it("throws rather than drawing garbage when a layout outruns the library", () => {
    // The pipeline refuses partial rebuilds precisely because mesh ids are
    // library-wide; if that guard is ever bypassed this is what it looks like.
    const stale = { layout: 3, draws: [{ m: 99, off: 0, n: 1, overlay: 0 }] } as unknown as TerrainLayoutMeta;
    expect(() => buildDrawCalls(library, stale)).toThrow(/mesh 99/);
  });
});

describe("octDecode", () => {
  it("round-trips the unit vectors the encoder is fed", () => {
    for (const v of [
      [0, 0, 1],
      [0, 0, -1],
      [1, 0, 0],
      [0, -1, 0],
      [0.5773502692, 0.5773502692, 0.5773502692]
    ]) {
      const [x, y, z] = v;
      const d = Math.abs(x) + Math.abs(y) + Math.abs(z);
      let ex = x / d;
      let ey = y / d;
      if (z < 0) {
        const qx = (1 - Math.abs(y / d)) * (ex >= 0 ? 1 : -1);
        const qy = (1 - Math.abs(x / d)) * (ey >= 0 ? 1 : -1);
        ex = qx;
        ey = qy;
      }
      const out = octDecode(ex, ey);
      expect(out[0]).toBeCloseTo(x, 6);
      expect(out[1]).toBeCloseTo(y, 6);
      expect(out[2]).toBeCloseTo(z, 6);
    }
  });

  it("always returns a unit vector", () => {
    for (const [ex, ey] of [[0.3, -0.4], [-0.9, 0.05], [0, 0], [0.5, 0.5]]) {
      const [x, y, z] = octDecode(ex, ey);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    }
  });
});

describe("dequantizePosition", () => {
  const lo = [-1000, -2000, -50] as const;
  const ext = [2000, 4000, 100] as const;

  it("reproduces the vertex shader's lo + (u16 / 65535) * ext", () => {
    const q = new Uint16Array([0, 32768, 65535, 65535, 0, 13107]);
    const [x, y, z] = dequantizePosition(q, 0, lo, ext);
    expect(x).toBeCloseTo(-1000, 9); // 0 -> the low corner
    expect(y).toBeCloseTo(-2000 + (32768 / 65535) * 4000, 9); // just past the midpoint
    expect(z).toBeCloseTo(50, 9); // 65535 -> the high corner
  });

  it("reads the triple at an offset, so a vertex buffer can be walked", () => {
    const q = new Uint16Array([0, 32768, 65535, 65535, 0, 13107]);
    const [x, y, z] = dequantizePosition(q, 3, lo, ext);
    expect(x).toBeCloseTo(1000, 9);
    expect(y).toBeCloseTo(-2000, 9);
    expect(z).toBeCloseTo(-50 + (13107 / 65535) * 100, 9);
  });

  it("spans exactly lo..lo+ext across the u16 range", () => {
    const q = new Uint16Array([0, 0, 0, 65535, 65535, 65535]);
    expect(dequantizePosition(q, 0, lo, ext)).toEqual([lo[0], lo[1], lo[2]]);
    const high = dequantizePosition(q, 3, lo, ext);
    expect(high[0]).toBeCloseTo(lo[0] + ext[0], 9);
    expect(high[1]).toBeCloseTo(lo[1] + ext[1], 9);
    expect(high[2]).toBeCloseTo(lo[2] + ext[2], 9);
  });
});

describe("sampleHeightField", () => {
  const meta = {
    hfN: 4,
    hfZlo: 0,
    hfZhi: 6553.5,
    hfStep: 100,
    hfX0: 0,
    hfY0: 0
  } as unknown as TerrainLayoutMeta;
  // 0.1 world units per raw count over this range.
  const field = new Uint16Array([0, 10000, 20000, 30000, 40000, 50000, 60000, 65535, 0, 0, 0, 0, 0, 0, 0, 0]);

  it("reads the nearest texel, as the shader does", () => {
    expect(sampleHeightField(field, meta, 0, 0)).toBeCloseTo(0, 6);
    expect(sampleHeightField(field, meta, 100, 0)).toBeCloseTo(1000, 3);
    expect(sampleHeightField(field, meta, 0, 100)).toBeCloseTo(4000, 3);
  });

  it("clamps outside the field instead of wrapping or reading out of bounds", () => {
    expect(sampleHeightField(field, meta, -1e6, -1e6)).toBeCloseTo(0, 6);
    expect(Number.isFinite(sampleHeightField(field, meta, 1e6, 1e6))).toBe(true);
  });
});
