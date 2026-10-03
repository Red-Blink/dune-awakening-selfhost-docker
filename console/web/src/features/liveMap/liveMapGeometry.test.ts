import { describe, expect, it } from "vitest";
import type { LiveMapConfig } from "../../api/liveMap";
import { clampLiveMapZoom, liveMapCamera, liveMapMinimumZoom, liveMapPixelsToWorld, MAX_LIVE_MAP_ZOOM, panScrollDelta, terrainViewport, visibleWorldRect, worldToLiveMapPoint, zoomCentreFor } from "./liveMapGeometry";
import { eyeDistance, projectToScreen, screenToWorldAtZ } from "./terrain/terrainCamera";

// LIVE_MAP_CONFIGS.DeepDesert, verbatim from console/api/src/duneDb.js.
const DEEP_DESERT: LiveMapConfig = {
  key: "DeepDesert",
  label: "The Deep Desert",
  actorMap: "DeepDesert",
  image: "/images/maps/deep-desert.png",
  width: 4096,
  height: 4096,
  minX: -1177656,
  maxX: 1072344,
  minY: -1177066,
  maxY: 1072934,
  flipY: false,
  defaultPartitionId: 8
};

describe("worldToLiveMapPoint", () => {
  it("puts the corners on the image corners and the centre in the middle", () => {
    expect(worldToLiveMapPoint({ x: DEEP_DESERT.minX, y: DEEP_DESERT.minY }, DEEP_DESERT)).toMatchObject({ px: 0, py: 0 });
    const max = worldToLiveMapPoint({ x: DEEP_DESERT.maxX, y: DEEP_DESERT.maxY }, DEEP_DESERT)!;
    expect(max.px).toBeCloseTo(4096, 6);
    expect(max.py).toBeCloseTo(4096, 6);
  });

  it("rejects non-numeric coordinates rather than placing a marker at NaN", () => {
    expect(worldToLiveMapPoint({ x: "nope" as unknown as number, y: 0 }, DEEP_DESERT)).toBeNull();
  });

  it("round-trips through liveMapPixelsToWorld", () => {
    for (const [x, y] of [[0, 0], [-1138004, 400000], [900000, -900000]]) {
      const point = worldToLiveMapPoint({ x, y }, DEEP_DESERT)!;
      const back = liveMapPixelsToWorld(point.px, point.py, DEEP_DESERT)!;
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });
});

describe("visibleWorldRect", () => {
  // This is the contract that keeps the terrain and the markers on the same
  // pixel: the renderer draws exactly the rect the panel believes it is showing.
  it("returns the whole map when scrolled to the origin at fit zoom", () => {
    const zoom = 0.25; // 4096 * 0.25 = 1024
    const rect = visibleWorldRect(DEEP_DESERT, zoom, 0, 0, 1024, 1024)!;
    expect(rect.minX).toBeCloseTo(DEEP_DESERT.minX, 6);
    expect(rect.maxX).toBeCloseTo(DEEP_DESERT.maxX, 6);
    expect(rect.minY).toBeCloseTo(DEEP_DESERT.minY, 6);
    expect(rect.maxY).toBeCloseTo(DEEP_DESERT.maxY, 6);
  });

  it("agrees with where the panel would position a marker in the same view", () => {
    const zoom = 1;
    const scrollLeft = 900;
    const scrollTop = 500;
    const width = 800;
    const height = 600;
    const rect = visibleWorldRect(DEEP_DESERT, zoom, scrollLeft, scrollTop, width, height)!;
    // A marker at the rect's top-left must sit at the viewport's top-left.
    const point = worldToLiveMapPoint({ x: rect.minX, y: rect.minY }, DEEP_DESERT)!;
    expect(point.px * zoom - scrollLeft).toBeCloseTo(0, 6);
    expect(point.py * zoom - scrollTop).toBeCloseTo(0, 6);
    const far = worldToLiveMapPoint({ x: rect.maxX, y: rect.maxY }, DEEP_DESERT)!;
    expect(far.px * zoom - scrollLeft).toBeCloseTo(width, 6);
    expect(far.py * zoom - scrollTop).toBeCloseTo(height, 6);
  });

  it("narrows as zoom increases rather than staying put", () => {
    const wide = visibleWorldRect(DEEP_DESERT, 0.25, 0, 0, 1024, 1024)!;
    const close = visibleWorldRect(DEEP_DESERT, 2, 0, 0, 1024, 1024)!;
    expect(close.maxX - close.minX).toBeLessThan(wide.maxX - wide.minX);
  });

  it("always returns an ordered rectangle, including when flipY inverts it", () => {
    const flipped = { ...DEEP_DESERT, flipY: true };
    const rect = visibleWorldRect(flipped, 1, 100, 100, 400, 400)!;
    expect(rect.maxX).toBeGreaterThan(rect.minX);
    expect(rect.maxY).toBeGreaterThan(rect.minY);
  });

  it("returns null for a degenerate config instead of a rect full of NaN", () => {
    expect(visibleWorldRect({ ...DEEP_DESERT, width: 0 }, 1, 0, 0, 10, 10)).toBeNull();
  });
});

describe("zoom helpers", () => {
  it("fits the whole map, letterboxing rather than cropping", () => {
    const frame = { clientWidth: 800, clientHeight: 600 } as HTMLElement;
    // "contain": the tighter of the two ratios, so nothing overflows the frame.
    expect(liveMapMinimumZoom(DEEP_DESERT, frame)).toBeCloseTo(600 / 4096, 9);
  });

  it("falls back to a sane zoom with no config or frame", () => {
    expect(liveMapMinimumZoom(null, null)).toBe(0.16);
  });

  it("clamps to the allowed range and survives NaN", () => {
    expect(clampLiveMapZoom(99, 0.1)).toBe(MAX_LIVE_MAP_ZOOM);
    expect(clampLiveMapZoom(0.001, 0.1)).toBe(0.1);
    expect(clampLiveMapZoom(Number.NaN, 0.1)).toBe(0.1);
  });
});

// The map rect is the sector square the image covers, but the world does not
// stop dead at its edge. Measured on a live farm: a player and the ornithopter
// they were flying sat 4,216 uu past the north edge, and a few world markers
// about 1,100 uu past it. A hard cut would drop exactly the marker an admin is
// most likely to be hunting for.
describe("markers just outside the map square", () => {
  const northEdge = DEEP_DESERT.maxY;

  it("keeps the live farm's out-of-bounds player, at its true position", () => {
    const point = worldToLiveMapPoint({ x: 92450, y: 1077150 }, DEEP_DESERT)!;
    expect(point).not.toBeNull();
    expect(point.inBounds).toBe(true);
    // Not clamped: it really is past the edge, and is drawn there.
    expect(point.py).toBeGreaterThan(DEEP_DESERT.height);
    expect(point.py - DEEP_DESERT.height).toBeLessThan(16);
  });

  it("still excludes something genuinely off the map", () => {
    const wayOut = worldToLiveMapPoint({ x: 92450, y: northEdge + 200000 }, DEEP_DESERT)!;
    expect(wayOut.inBounds).toBe(false);
  });

  it("treats the four corners of the square as in bounds", () => {
    for (const [x, y] of [[DEEP_DESERT.minX, DEEP_DESERT.minY], [DEEP_DESERT.maxX, DEEP_DESERT.maxY],
                          [DEEP_DESERT.minX, DEEP_DESERT.maxY], [DEEP_DESERT.maxX, DEEP_DESERT.minY]]) {
      expect(worldToLiveMapPoint({ x, y }, DEEP_DESERT)!.inBounds).toBe(true);
    }
  });
});

describe("3D view helpers", () => {
  const zoom = 2;
  const viewport = terrainViewport(DEEP_DESERT, zoom, 3000, 2500, 1100, 700);
  const deg = (d: number) => (d * Math.PI) / 180;

  it("places the canvas over the viewport, clamped to the map", () => {
    expect(viewport).toEqual({ left: 3000, top: 2500, width: 1100, height: 700 });
    const past = terrainViewport(DEEP_DESERT, zoom, 1e9, -50, 1100, 700);
    expect(past.left).toBe(Math.floor(DEEP_DESERT.width * zoom) - 1100);
    expect(past.top).toBe(0);
  });

  it("with fill, widens a map narrower than the frame to the frame, about the map's centre", () => {
    const z = 0.2;
    const mapWidth = Math.floor(DEEP_DESERT.width * z);
    const v = terrainViewport(DEEP_DESERT, z, 0, 0, 1300, 700, true);
    expect(v).toEqual({ left: -(1300 - mapWidth) / 2, top: 0, width: 1300, height: Math.min(700, Math.floor(DEEP_DESERT.height * z)) });
    const camera = liveMapCamera(DEEP_DESERT, z, v, deg(45), 0, 0)!;
    // The centre of the canvas the CSS centres, which is floor(map width) wide.
    const centre = liveMapPixelsToWorld(mapWidth / 2 / z, (v.top + v.height / 2) / z, DEEP_DESERT)!;
    expect(camera.cx).toBeCloseTo(centre.x, 6);
    // Without fill, or once the map is wider than the frame, it is the clamped viewport.
    expect(terrainViewport(DEEP_DESERT, z, 0, 0, 1300, 700).width).toBe(mapWidth);
    expect(terrainViewport(DEEP_DESERT, zoom, 3000, 2500, 1100, 700, true)).toEqual(viewport);
  });

  it("flat, projects every point exactly where the flat map draws it", () => {
    const camera = liveMapCamera(DEEP_DESERT, zoom, viewport, 0, 0, 0)!;
    for (const [px, py] of [[1600, 1300], [2100, 1500], [1500.5, 1250.25]]) {
      const world = liveMapPixelsToWorld(px, py, DEEP_DESERT)!;
      const s = projectToScreen(camera, world.x, world.y, 12345);
      expect(s.sx).toBeCloseTo(px * zoom - viewport.left, 6);
      expect(s.sy).toBeCloseTo(py * zoom - viewport.top, 6);
    }
  });

  it("pans so the ground under the pointer follows it, rotated and tilted", () => {
    for (const [t, y] of [[0, 0], [0, 90], [40, 25], [60, -130]]) {
      const before = liveMapCamera(DEEP_DESERT, zoom, viewport, deg(t), deg(y), 8000)!;
      // Far from the centre and off the pivot height, where perspective bites hardest.
      for (const [sx, sy, z] of [[700, 300, 8000], [40, 660, 8000], [1050, 30, 21000]]) {
        const grabbed = screenToWorldAtZ(before, sx, sy, z);
        const d = panScrollDelta(before, { sx, sy }, { sx: sx + 137, sy: sy - 91 }, z);
        const moved = { ...viewport, left: viewport.left + d.left, top: viewport.top + d.top };
        const after = liveMapCamera(DEEP_DESERT, zoom, moved, deg(t), deg(y), 8000)!;
        const s = projectToScreen(after, grabbed.x, grabbed.y, z);
        expect(s.sx).toBeCloseTo(sx + 137, 6);
        expect(s.sy).toBeCloseTo(sy - 91, 6);
      }
    }
  });

  it("flat, pans by exactly the drag reversed", () => {
    const camera = liveMapCamera(DEEP_DESERT, zoom, viewport, 0, 0, 8000)!;
    const d = panScrollDelta(camera, { sx: 200, sy: 300 }, { sx: 237, sy: 279 }, 8000);
    expect(d.left).toBeCloseTo(-37, 9);
    expect(d.top).toBeCloseTo(21, 9);
  });

  it("keeps the eye above the tallest rock at any zoom, without moving what is in the middle of the view", () => {
    const pivot = 5000;
    const top = 137000;
    for (const z of [0.22, 1, 3, 5, 8]) {
      const v = terrainViewport(DEEP_DESERT, z, 1500 * z, 1400 * z, 1100, 700);
      const camera = liveMapCamera(DEEP_DESERT, z, v, deg(60), deg(20), pivot, top)!;
      const free = liveMapCamera(DEEP_DESERT, z, v, deg(60), deg(20), pivot)!;
      const eyeHeight = pivot + eyeDistance(camera) * Math.cos(camera.tilt);
      expect(eyeHeight).toBeGreaterThan(top);
      // Same target and same scale: only the amount of perspective differs, and never upward.
      expect([camera.cx, camera.cy, camera.cz, camera.scale]).toEqual([free.cx, free.cy, free.cz, free.scale]);
      expect(camera.fov).toBeLessThanOrEqual(free.fov);
      const centre = projectToScreen(camera, camera.cx, camera.cy, camera.cz);
      expect(centre.sx).toBeCloseTo(v.width / 2, 9);
      expect(centre.sy).toBeCloseTo(v.height / 2, 9);
    }
    // At the fit the eye is far overhead already: untouched.
    const v = terrainViewport(DEEP_DESERT, 0.22, 0, 0, 1100, 700);
    expect(liveMapCamera(DEEP_DESERT, 0.22, v, deg(60), 0, pivot, top)!.fov).toBe(liveMapCamera(DEEP_DESERT, 0.22, v, deg(60), 0, pivot)!.fov);
    // Without the guard, full zoom puts the eye below the rock tops.
    const v8 = terrainViewport(DEEP_DESERT, 8, 12000, 11200, 1100, 700);
    const unguarded = liveMapCamera(DEEP_DESERT, 8, v8, deg(60), 0, pivot)!;
    expect(pivot + eyeDistance(unguarded) * Math.cos(unguarded.tilt)).toBeLessThan(top);
  });

  it("zooms about the point under the cursor, perspective included", () => {
    const camera = liveMapCamera(DEEP_DESERT, zoom, viewport, deg(45), deg(30), 8000)!;
    const anchor = screenToWorldAtZ(camera, 900, 200, 8000);
    const next = 3.1;
    const centre = zoomCentreFor(camera, anchor, zoom, next);
    const scaled = { ...camera, cx: centre.x, cy: centre.y, scale: camera.scale * zoom / next };
    const s = projectToScreen(scaled, anchor.x, anchor.y, 8000);
    expect(s.sx).toBeCloseTo(900, 6);
    expect(s.sy).toBeCloseTo(200, 6);
  });
});
