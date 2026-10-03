import { describe, it, expect } from "vitest";
import { elevationIntervals } from "./renderer";

// Both ways the interval can go wrong were hit: too coarse for a formation, and
// wider than the whole sand field.
describe("elevationIntervals", () => {
  it("never goes finer than the base, however far you zoom in", () => {
    for (const uuPerPixel of [0.5, 10, 100, 166]) {
      const [rock] = elevationIntervals(uuPerPixel);
      expect(rock).toBeGreaterThanOrEqual(200);
    }
    // Under the floor every zoom level shares one interval, so lines do not crawl.
    expect(elevationIntervals(10)[0]).toBe(elevationIntervals(100)[0]);
  });

  it("coarsens as you zoom out", () => {
    const close = elevationIntervals(229)[0];
    const far = elevationIntervals(3373)[0];
    expect(far).toBeGreaterThan(close);
  });

  it("snaps to a 1-2-5 sequence rather than arbitrary values", () => {
    for (const uuPerPixel of [50, 229, 700, 1500, 3373, 9000]) {
      const [rock] = elevationIntervals(uuPerPixel);
      const mantissa = rock / Math.pow(10, Math.floor(Math.log10(rock)));
      expect([1, 2, 5]).toContain(Math.round(mantissa));
    }
  });

  it("keeps sand coarser than rock but caps it so it cannot exceed the dune relief", () => {
    const [rockClose, sandClose] = elevationIntervals(229);
    expect(sandClose).toBe(rockClose * 8);

    // Uncapped this would exceed the sand field's whole relief.
    const [rockFar, sandFar] = elevationIntervals(3373);
    expect(rockFar * 8).toBeGreaterThan(2500);
    expect(sandFar).toBe(2500);
  });

  it("stays finite and positive at degenerate scales", () => {
    for (const uuPerPixel of [0, -1, Number.EPSILON]) {
      const [rock, sand] = elevationIntervals(uuPerPixel);
      expect(Number.isFinite(rock)).toBe(true);
      expect(rock).toBeGreaterThan(0);
      expect(sand).toBeGreaterThan(0);
    }
  });
});
