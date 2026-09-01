import { describe, expect, it } from "vitest";
import type { LiveMapConfig } from "../../api/liveMap";
import { clampLiveMapZoom, liveMapMinimumZoom, liveMapPixelsToWorld, MAX_LIVE_MAP_ZOOM, visibleWorldRect, worldToLiveMapPoint } from "./liveMapGeometry";

// LIVE_MAP_CONFIGS.DeepDesert, verbatim from console/api/src/duneDb.js.
const DEEP_DESERT: LiveMapConfig = {
  key: "DeepDesert",
  label: "The Deep Desert",
  actorMap: "DeepDesert",
  image: "/images/maps/deep-desert.png",
  width: 4096,
  height: 4096,
  minX: -1268624.82,
  maxX: 1163312.83,
  minY: -1266548.17,
  maxY: 1162416.13,
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
