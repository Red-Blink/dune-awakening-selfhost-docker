import { describe, expect, it } from "vitest";
import {
  FOOTED_ROCK,
  INSTANCE_FLOATS,
  buildDrawCalls,
  markHoveringRock,
  cullInstances,
  instanceCircles,
  depthRange,
  dequantizePosition,
  octDecode,
  orthoFromWorldRect,
  projectWorldPoint,
  interpolateHeightField,
  sandRingCount,
  withCommonRock,
  withOutside,
  withSandRing,
  sampleHeightField, applyCanvasSize } from "./terrainGeometry";
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

describe("withOutside", () => {
  const mesh = (n: number) => ({ lo: [0, 0, 0], ext: [n, n, n], vo: 0, vn: 3, io: 0, ic: 3 });
  const library = { posBytes: 0, nrmBytes: 0, idxBytes: 0, meshes: [mesh(10), mesh(20), mesh(30)] } as unknown as TerrainLibrary;
  const layout = { layout: 1, draws: [{ m: 0, off: 0, n: 2, overlay: 0 }, { m: 1, off: 2, n: 1, overlay: 1 }] } as unknown as TerrainLayoutMeta;
  const own = new Float32Array(3 * INSTANCE_FLOATS).fill(1);
  const extra = new Float32Array(4 * INSTANCE_FLOATS).fill(2);
  const outside = { nInst: 4, zmax: 100, draws: [{ m: 2, off: 0, n: 3 }, { m: 0, off: 3, n: 1 }] };

  it("appends the outside rock after the layout's own instances", () => {
    const calls = buildDrawCalls(library, layout);
    const merged = withOutside(calls, own, library, outside, extra);
    expect(merged.instances.length).toBe(7 * INSTANCE_FLOATS);
    // The layout's own come first, untouched; the outside block follows.
    expect(Array.from(merged.instances.subarray(0, own.length))).toEqual(Array.from(own));
    expect(Array.from(merged.instances.subarray(own.length))).toEqual(Array.from(extra));
    // The layout's draws are unchanged, and the outside draws point past them.
    expect(merged.calls.slice(0, 2)).toEqual(calls);
    expect(merged.calls.slice(2).map((c) => [c.instOff, c.instN, c.ext[0], c.overlay])).toEqual([[3, 3, 30, 0], [6, 1, 10, 0]]);
    // Every draw stays inside the merged buffer.
    for (const call of merged.calls) expect(call.instOff + call.instN).toBeLessThanOrEqual(7);
  });

  it("is the layout alone when there is no outside rock", () => {
    const calls = buildDrawCalls(library, layout);
    const merged = withOutside(calls, own, library, { nInst: 0, zmax: 0, draws: [] }, new Float32Array(0));
    expect(merged.calls).toEqual(calls);
    expect(Array.from(merged.instances)).toEqual(Array.from(own));
  });

  it("refuses an outside draw whose mesh the library does not have", () => {
    expect(() => withOutside([], own, library, { nInst: 1, zmax: 0, draws: [{ m: 9, off: 0, n: 1 }] }, extra)).toThrow(/mesh 9/);
  });
});

describe("withCommonRock", () => {
  // Two draws of the layout's own: mesh 4 with placements A and B, mesh 7 with C.
  // The shared file holds X for mesh 7 and Y, Z for mesh 4.
  const place = (tag: number) => new Float32Array(INSTANCE_FLOATS).fill(tag);
  const bytes = (...tags: number[]) => {
    const out = new Float32Array(tags.length * INSTANCE_FLOATS);
    tags.forEach((tag, i) => out.set(place(tag), i * INSTANCE_FLOATS));
    return new Uint8Array(out.buffer);
  };
  const tagsOf = (b: Uint8Array) => {
    const f = new Float32Array(b.slice().buffer);
    return Array.from({ length: f.length / INSTANCE_FLOATS }, (_, i) => f[i * INSTANCE_FLOATS]);
  };
  const meta = { layout: 3, common: 3, draws: [{ m: 4, off: 0, n: 2, overlay: 0 }, { m: 7, off: 2, n: 1, overlay: 1 }] } as unknown as TerrainLayoutMeta;
  const common = { nInst: 3, draws: [{ m: 7, overlay: 1, off: 0, n: 1 }, { m: 4, overlay: 0, off: 1, n: 2 }] };

  it("gives each draw the shared placements of its mesh first, then its own", () => {
    const out = withCommonRock(meta, bytes(1, 2, 3), common, bytes(24, 25, 26));
    expect(tagsOf(out.instances)).toEqual([25, 26, 1, 2, 24, 3]);
    expect(out.meta.draws).toEqual([{ m: 4, off: 0, n: 4, overlay: 0 }, { m: 7, off: 4, n: 2, overlay: 1 }]);
  });

  it("passes an unsplit layout through untouched", () => {
    const plain = { ...meta, common: undefined } as TerrainLayoutMeta;
    const instances = bytes(1, 2, 3);
    const out = withCommonRock(plain, instances, common, bytes(24, 25, 26));
    expect(out.meta).toBe(plain);
    expect(out.instances).toBe(instances);
  });

  it("refuses a shared file other than the one the layout was split against", () => {
    expect(() => withCommonRock({ ...meta, common: 4 }, bytes(1, 2, 3), common, bytes(24, 25, 26))).toThrow(/expects 4 shared placements, the shared file has 3/);
  });

  it("refuses shared placements for a mesh the layout does not draw", () => {
    const extra = { nInst: 4, draws: [...common.draws, { m: 9, overlay: 0, off: 3, n: 1 }] };
    expect(() => withCommonRock({ ...meta, common: 4 }, bytes(1, 2, 3), extra, bytes(24, 25, 26, 27))).toThrow(/no draw for 1 of the shared placement groups/);
  });
});

describe("markHoveringRock", () => {
  // A sealed rock mesh 10 units tall whose floor is 2 below its origin, and an unsealed one.
  const rock = { lo: [-5, -5, -2], ext: [10, 10, 10], vo: 0, vn: 8, io: 0, ic: 6, skirt: 6 };
  const plain = { lo: [-5, -5, -2], ext: [10, 10, 10], vo: 8, vn: 4, io: 6, ic: 6 };
  const call = (mesh: object, instOff: number, instN: number) => ({ ...mesh, instOff, instN, overlay: 0, land: false }) as unknown as Parameters<typeof markHoveringRock>[0][number];

  /** One instance: uniform scale 100, at (x, y, z), with a material and a lift. */
  function instance(x: number, y: number, z: number, mat = 0, lift = 0): number[] {
    return [100, 0, 0, 0, 100, 0, 0, 0, 100, x, y, z, mat, lift];
  }
  const sandAt = (x: number) => (x < 0 ? 1000 : 5000);

  it("marks rock whose floor clears the sand, and leaves grounded rock alone", () => {
    // Floors: 3000 - 200 = 2800 over sand at 1000 (hovering), and 1200 - 200 = 1000 (standing on it).
    const instances = Float32Array.from([...instance(-50, 0, 3000), ...instance(-50, 0, 1200)]);
    expect(markHoveringRock([call(rock, 0, 2)], instances, sandAt)).toBe(1);
    expect(instances[12]).toBeCloseTo(FOOTED_ROCK, 6);
    expect(instances[INSTANCE_FLOATS + 12]).toBe(0);
  });

  it("measures against the sand under the piece, and counts its lift", () => {
    // The same floor of 5800 clears the low sand but not the high sand...
    const instances = Float32Array.from([...instance(-50, 0, 6000), ...instance(50, 0, 6000), ...instance(50, 0, 6000, 0, 1000)]);
    expect(markHoveringRock([call(rock, 0, 3)], instances, sandAt)).toBe(2);
    // ...until a lift of 1000 raises it to 6800, 1800 clear.
    expect([instances[12], instances[INSTANCE_FLOATS + 12], instances[2 * INSTANCE_FLOATS + 12]].map((v) => v > 0)).toEqual([true, false, true]);
  });

  it("skips meshes with no skirt to carry down, and instances that are not rock", () => {
    const instances = Float32Array.from([...instance(-50, 0, 9000), ...instance(-50, 0, 9000, 3)]);
    expect(markHoveringRock([call(plain, 0, 1), call(rock, 1, 1)], instances, sandAt)).toBe(0);
    expect(instances[12]).toBe(0);
    expect(instances[INSTANCE_FLOATS + 12]).toBe(3);
  });
});

describe("withSandRing", () => {
  // A 4x4 field, 0.1 uu per raw step, and a ring 8 texels deep round it.
  const meta = { hfN: 4, hfZlo: 1000, hfZhi: 1000 + 6553.5, hfStep: 100, hfX0: 0, hfY0: 0 } as unknown as TerrainLayoutMeta;
  const ring = { pad: 8, n: 4, zlo: 0, zstep: 8 };
  const m = 4 + 2 * ring.pad;
  const count = sandRingCount(ring);
  const inside = (i: number, j: number) => i > ring.pad && i < ring.pad + 3 && j > ring.pad && j < ring.pad + 3;

  /** Ring planes holding `value(i, j)` at every texel the ring covers. */
  function planes(value: (i: number, j: number) => number): Uint8Array {
    const out = new Uint8Array(count * 2);
    let k = 0;
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        if (inside(i, j)) continue;
        const v = value(i, j);
        out[k] = v >> 8;
        out[count + k] = v & 255;
        k++;
      }
    }
    return out;
  }

  it("holds every texel outside the layout's field less its rim", () => {
    expect(count).toBe(m * m - 2 * 2);
  });

  it("keeps the layout's own texels and moves the grid's origin out by the padding", () => {
    const field = Uint16Array.from({ length: 16 }, (_, i) => 1000 + i);
    const joined = withSandRing(field, meta, ring, planes(() => 300));
    expect(joined.meta.hfN).toBe(m);
    expect(joined.meta.hfX0).toBe(-800);
    expect(joined.meta.hfY0).toBe(-800);
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) expect(joined.field[(j + ring.pad) * m + i + ring.pad]).toBe(field[j * 4 + i]);
    }
    // The same world point reads the same height through either grid.
    expect(interpolateHeightField(joined.field, joined.meta, 150, 250)).toBeCloseTo(interpolateHeightField(field, meta, 150, 250), 6);
  });

  it("converts ring heights into the layout's own scale", () => {
    // The layout's rim agrees with the ring (300 * 8 = 2400 uu = raw 14000), so nothing is faded.
    const field = new Uint16Array(16).fill(14000);
    const joined = withSandRing(field, meta, ring, planes((i) => (i === 0 ? 500 : 300)));
    expect(joined.field[5 * m + 3]).toBe(14000);
    // 500 * 8 = 4000 uu, which is 3000 above the layout's floor: raw 30000.
    expect(joined.field[5 * m + 0]).toBe(30000);
  });

  it("fades a step at the seam out over six texels, and no further", () => {
    // The layout's rim sits 1000 raw above the ring's copy of it.
    const field = new Uint16Array(16).fill(15000);
    const joined = withSandRing(field, meta, ring, planes(() => 300));
    const row = (ring.pad + 1) * m;
    const west = Array.from({ length: ring.pad }, (_, k) => joined.field[row + ring.pad - 1 - k]);
    expect(west).toEqual([14833, 14667, 14500, 14333, 14167, 14000, 14000, 14000]);
    // A corner texel is measured from the rim's corner, not from one side.
    expect(joined.field[(ring.pad - 3) * m + ring.pad - 3]).toBe(14500);
  });

  it("refuses a ring made for another field size or cut short", () => {
    const field = new Uint16Array(16);
    expect(() => withSandRing(field, meta, { ...ring, n: 6 }, planes(() => 0))).toThrow(/sand ring is for a 6 field/);
    expect(() => withSandRing(field, meta, ring, new Uint8Array(count * 2 - 2))).toThrow(/sand ring/);
  });
});

describe("interpolateHeightField", () => {
  const meta = { hfN: 4, hfZlo: 0, hfZhi: 6553.5, hfStep: 100, hfX0: 0, hfY0: 0 } as unknown as TerrainLayoutMeta;
  const field = new Uint16Array([0, 10000, 20000, 30000, 40000, 50000, 60000, 65535, 0, 0, 0, 0, 0, 0, 0, 0]);

  it("agrees with the mesh at its vertices", () => {
    for (const [x, y] of [[0, 0], [100, 0], [0, 100], [300, 100], [300, 300]]) {
      expect(interpolateHeightField(field, meta, x, y)).toBeCloseTo(sampleHeightField(field, meta, x, y), 6);
    }
  });

  it("follows the surface between vertices, where the nearest texel steps", () => {
    // Halfway along an edge, and in the middle of a cell.
    expect(interpolateHeightField(field, meta, 50, 0)).toBeCloseTo(500, 6);
    expect(interpolateHeightField(field, meta, 0, 50)).toBeCloseTo(2000, 6);
    expect(interpolateHeightField(field, meta, 50, 50)).toBeCloseTo((0 + 1000 + 4000 + 5000) / 4, 6);
    // The nearest texel is off by a visible amount at the same point.
    expect(Math.abs(sampleHeightField(field, meta, 40, 0) - interpolateHeightField(field, meta, 40, 0))).toBeGreaterThan(300);
  });

  it("clamps outside the field instead of extrapolating", () => {
    expect(interpolateHeightField(field, meta, -1e6, -1e6)).toBeCloseTo(0, 6);
    expect(interpolateHeightField(field, meta, 1e6, 0)).toBeCloseTo(3000, 6);
    expect(interpolateHeightField(field, meta, 1e6, 1e6)).toBeCloseTo(0, 6);
  });
});

// Assigning canvas.width or .height resets the drawing buffer and blanks the
// canvas even when the value is unchanged. The paint path runs on every zoom
// tick and every scroll event, so writing unconditionally cleared the terrain
// and redrew it constantly -- the flicker while zooming.
describe("applyCanvasSize", () => {
  const canvas = () => ({ width: 0, height: 0, style: { width: "", height: "" } });

  it("sizes a fresh canvas and reports the buffer reset", () => {
    const c = canvas();
    expect(applyCanvasSize(c, 800, 600, 2)).toBe(true);
    expect([c.width, c.height]).toEqual([1600, 1200]);
    expect([c.style.width, c.style.height]).toEqual(["800px", "600px"]);
  });

  it("does not touch the buffer when nothing changed", () => {
    const c = canvas();
    applyCanvasSize(c, 800, 600, 2);
    let writes = 0;
    const watched = {
      get width() { return 1600; }, set width(_v: number) { writes++; },
      get height() { return 1200; }, set height(_v: number) { writes++; },
      style: c.style
    };
    expect(applyCanvasSize(watched, 800, 600, 2)).toBe(false);
    expect(writes).toBe(0);
  });

  it("resizes when the frame really does change", () => {
    const c = canvas();
    applyCanvasSize(c, 800, 600, 2);
    expect(applyCanvasSize(c, 900, 600, 2)).toBe(true);
    expect(c.width).toBe(1800);
  });

  it("caps the pixel ratio at 2, so a 3x display does not triple the buffer", () => {
    const c = canvas();
    applyCanvasSize(c, 800, 600, 3);
    expect(c.width).toBe(1600);
  });
});

describe("instance culling", () => {
  // One rock mesh, a 100 x 100 x 40 box from the origin, and one landscape tile.
  const rock = { lo: [0, 0, 0] as [number, number, number], ext: [100, 100, 40] as [number, number, number], vo: 0, vn: 3, io: 0, ic: 3 };
  const land = { lo: [0, 0, 0] as [number, number, number], ext: [60000, 60000, 900] as [number, number, number], vo: 3, vn: 3, io: 3, ic: 3 };
  function instance(scale: number, x: number, y: number): number[] {
    return [scale, 0, 0, 0, scale, 0, 0, 0, scale, x, y, 0, 0, 0];
  }
  // rock instances: in view, far outside it, in view but tiny; then one land tile far away
  const instances = new Float32Array([
    ...instance(10, 0, 0),
    ...instance(10, 900000, 900000),
    ...instance(0.01, 10, 10),
    ...instance(1, 5000000, 5000000)
  ]);
  const calls = [
    { ...rock, instOff: 0, instN: 3, overlay: 0, land: false },
    { ...land, instOff: 3, instN: 1, overlay: 0, land: true }
  ];
  const view: TerrainView = { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000, flipY: false };

  it("bounds each instance by a circle around its transformed box", () => {
    const c = instanceCircles(calls, instances);
    // centre of the 100x100x40 box is (50, 50, 20); scale 10 puts it at (500, 500)
    expect(c[0]).toBeCloseTo(500);
    expect(c[1]).toBeCloseTo(500);
    expect(c[2]).toBeCloseTo(0.5 * Math.hypot(100, 100, 40) * 10);
  });

  it("keeps what is in view and large enough, drops the rest, always keeps land", () => {
    const c = instanceCircles(calls, instances);
    const out = new Float32Array(instances.length);
    const { draws, total } = cullInstances(calls, instances, c, view, 1, out);
    expect(draws).toEqual([{ off: 0, n: 1 }, { off: 1, n: 1 }]);
    expect(total).toBe(2);
    // packed contiguously: the kept rock instance, then the land tile
    expect(Array.from(out.subarray(0, INSTANCE_FLOATS))).toEqual(Array.from(instances.subarray(0, INSTANCE_FLOATS)));
    expect(out[INSTANCE_FLOATS + 9]).toBe(5000000);
  });

  it("keeps a sub-pixel instance once the pixel threshold allows it", () => {
    const c = instanceCircles(calls, instances);
    const out = new Float32Array(instances.length);
    expect(cullInstances(calls, instances, c, view, 0, out).draws[0].n).toBe(2);
  });

  it("takes a per-instance size threshold, for a perspective view", () => {
    const c = instanceCircles(calls, instances);
    const out = new Float32Array(instances.length);
    // a threshold that only the instance at the origin's side of x=200 can meet
    const { draws } = cullInstances(calls, instances, c, view, (x) => (x < 200 ? 1 : 1e9), out);
    expect(draws[0].n).toBe(0);
    expect(cullInstances(calls, instances, c, view, (x) => (x > 200 ? 1 : 1e9), out).draws[0].n).toBe(1);
  });

  it("keeps everything when the view covers it all and nothing is tiny", () => {
    const c = instanceCircles(calls, instances);
    const out = new Float32Array(instances.length);
    const all: TerrainView = { minX: -1e7, maxX: 1e7, minY: -1e7, maxY: 1e7, flipY: false };
    const { total } = cullInstances(calls, instances, c, all, 0, out);
    expect(total).toBe(4);
    expect(Array.from(out)).toEqual(Array.from(instances));
  });
});
