import { describe, expect, it } from "vitest";
import {
  MAX_FOV,
  MAX_TILT,
  cameraClipMatrix,
  cameraFromRect,
  cullRectForCamera,
  eyeDistance,
  fovClearing,
  fovForTilt,
  isFlatCamera,
  projectToScreen,
  scaleAt,
  screenToWorldAtZ
} from "./terrainCamera";
import type { TerrainCamera } from "./terrainCamera";
import { orthoFromWorldRect } from "./terrainGeometry";
import type { TerrainView } from "./types";

const view: TerrainView = { minX: -300000, maxX: -100000, minY: 900000, maxY: 1020000, flipY: false };
const W = 1200;
const H = 720;
const deg = (d: number) => (d * Math.PI) / 180;

function tilted(tiltDeg: number, yawDeg: number, perspective = true): TerrainCamera {
  const tilt = deg(tiltDeg);
  return { ...cameraFromRect(view, W, H), cz: 12000, tilt, yaw: deg(yawDeg), fov: perspective ? fovForTilt(tilt) : 0 };
}

/** Where the clip matrix puts a world point, in CSS pixels -- what the GPU will draw. */
function viaMatrix(m: Float32Array, camera: TerrainCamera, x: number, y: number, z: number) {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return { sx: (cx / cw + 1) * camera.width / 2, sy: (1 - cy / cw) * camera.height / 2, ndcZ: cz / cw };
}

describe("terrain camera", () => {
  it("is today's orthographic map when flat, depth included", () => {
    const camera = cameraFromRect(view, W, H);
    expect(isFlatCamera(camera)).toBe(true);
    const zRange = 300000;
    const ours = cameraClipMatrix(camera, -8000, 140000, zRange);
    // The flat view keeps the rect's aspect only if the viewport has it too; match the heights.
    const rect = { ...view, maxY: view.minY + (view.maxX - view.minX) * H / W };
    const flat = cameraClipMatrix(cameraFromRect(rect, W, H), -8000, 140000, zRange);
    const theirs = orthoFromWorldRect(rect, zRange);
    for (let i = 0; i < 16; i++) expect(flat[i]).toBeCloseTo(theirs[i], 12);
    // Float32Array storage: compare at float32 precision
    expect(ours[10]).toBeCloseTo(-1 / zRange, 12);
  });

  it("maps screen to world and back exactly, at any tilt, rotation and height", () => {
    for (const [t, y] of [[0, 0], [0, 37], [30, 0], [45, 120], [60, -75]]) {
      for (const perspective of [false, true]) {
        const camera = tilted(t, y, perspective);
        for (const z of [-4000, 12000, 30000]) {
          for (const [sx, sy] of [[0, 0], [W, 0], [W / 2, H / 2], [0, H], [W, H], [311, 97]]) {
            const p = screenToWorldAtZ(camera, sx, sy, z);
            const back = projectToScreen(camera, p.x, p.y, z);
            expect(back.behind).toBe(false);
            expect(back.sx).toBeCloseTo(sx, 6);
            expect(back.sy).toBeCloseTo(sy, 6);
          }
        }
      }
    }
  });

  it("draws exactly where projectToScreen says, so markers and terrain agree", () => {
    for (const [t, y] of [[0, 0], [25, 10], [60, 200]]) {
      const camera = tilted(t, y);
      const m = cameraClipMatrix(camera, -8000, 140000, 300000);
      for (const [x, yy, z] of [[-200000, 960000, 12000], [-150000, 1000000, 30000], [-280000, 905000, -2000]]) {
        const a = projectToScreen(camera, x, yy, z);
        const b = viaMatrix(m, camera, x, yy, z);
        expect(b.sx).toBeCloseTo(a.sx, 3);
        expect(b.sy).toBeCloseTo(a.sy, 3);
      }
    }
  });

  it("keeps the view centre fixed and at the same scale as it tilts", () => {
    for (const t of [0, 20, 45, 60]) {
      const camera = tilted(t, 30);
      const c = projectToScreen(camera, camera.cx, camera.cy, camera.cz);
      expect(c.sx).toBeCloseTo(W / 2, 9);
      expect(c.sy).toBeCloseTo(H / 2, 9);
      expect(scaleAt(camera, camera.cx, camera.cy, camera.cz)).toBeCloseTo(camera.scale, 9);
    }
  });

  it("raises higher ground on screen once tilted, and not before", () => {
    const flat = cameraFromRect(view, W, H);
    const low = projectToScreen(flat, -200000, 960000, 0);
    const high = projectToScreen(flat, -200000, 960000, 20000);
    expect(high.sy).toBeCloseTo(low.sy, 9);
    const camera = tilted(45, 0);
    expect(projectToScreen(camera, -200000, 960000, 20000).sy).toBeLessThan(projectToScreen(camera, -200000, 960000, 0).sy);
  });

  it("makes nearer ground larger and farther ground smaller with perspective", () => {
    const camera = tilted(50, 0);
    // screen-down is toward the eye at yaw 0: +Y is nearer
    expect(scaleAt(camera, camera.cx, camera.cy + 50000, camera.cz)).toBeLessThan(camera.scale);
    expect(scaleAt(camera, camera.cx, camera.cy - 50000, camera.cz)).toBeGreaterThan(camera.scale);
  });

  it("ramps perspective with tilt and never reaches the horizon", () => {
    expect(fovForTilt(0)).toBe(0);
    expect(fovForTilt(MAX_TILT)).toBeCloseTo(MAX_FOV, 12);
    expect(fovForTilt(2 * MAX_TILT)).toBeCloseTo(MAX_FOV, 12);
    expect(eyeDistance(cameraFromRect(view, W, H))).toBe(Infinity);
    // the top edge's ray, from vertical: tilt + fov/2 must stay under 90 degrees
    expect(MAX_TILT + MAX_FOV / 2).toBeLessThan(Math.PI / 2);
    const steep = tilted(60, 0);
    const top = screenToWorldAtZ(steep, W / 2, 0, steep.cz);
    expect(Number.isFinite(top.x) && Number.isFinite(top.y)).toBe(true);
  });

  it("narrows the field of view only as far as it takes to keep the eye above the rock", () => {
    const tilt = MAX_TILT;
    /** Eye height over the pivot for a field of view, at this scale and viewport. */
    const eyeRise = (fov: number, scale: number) => eyeDistance({ ...tilted(60, 0), scale, fov }) * Math.cos(tilt);
    const rise = 140000;
    // Zoomed right in: the tilt's own field of view would put the eye among the rock...
    const close = 69;
    expect(eyeRise(fovForTilt(tilt), close)).toBeLessThan(rise);
    // ...so it is narrowed, to exactly the clearance asked for.
    const narrowed = fovClearing(tilt, close, H, rise);
    expect(narrowed).toBeLessThan(fovForTilt(tilt));
    expect(narrowed).toBeGreaterThan(0);
    expect(eyeRise(narrowed, close)).toBeCloseTo(rise, 3);
    // Zoomed out the eye is already far above everything, and nothing changes.
    const far = 2500;
    expect(eyeRise(fovForTilt(tilt), far)).toBeGreaterThan(rise);
    expect(fovClearing(tilt, far, H, rise)).toBe(fovForTilt(tilt));
    // Top-down has no eye to lift, and no rise means nothing to clear.
    expect(fovClearing(0, close, H, rise)).toBe(0);
    expect(fovClearing(tilt, close, H, 0)).toBe(fovForTilt(tilt));
    expect(fovClearing(tilt, close, H, -5)).toBe(fovForTilt(tilt));
  });

  it("culls to a rect that holds every visible corner", () => {
    const camera = tilted(55, 140);
    const rect = cullRectForCamera(camera, -8000, 40000);
    for (const z of [-8000, 0, 40000]) {
      for (const [sx, sy] of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, H / 2]]) {
        const p = screenToWorldAtZ(camera, sx, sy, z);
        expect(p.x).toBeGreaterThanOrEqual(rect.minX - 1e-6);
        expect(p.x).toBeLessThanOrEqual(rect.maxX + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(rect.minY - 1e-6);
        expect(p.y).toBeLessThanOrEqual(rect.maxY + 1e-6);
      }
    }
    // flat: the rect is the view itself
    const flat = cullRectForCamera(cameraFromRect(view, W, W * (view.maxY - view.minY) / (view.maxX - view.minX)), 0, 0);
    expect(flat.minX).toBeCloseTo(view.minX, 6);
    expect(flat.maxY).toBeCloseTo(view.maxY, 6);
  });

  it("puts depth in range and nearer points in front, with perspective", () => {
    const camera = tilted(45, 0);
    const m = cameraClipMatrix(camera, -8000, 40000, 300000);
    const near = viaMatrix(m, camera, camera.cx, camera.cy + 20000, 0);
    const far = viaMatrix(m, camera, camera.cx, camera.cy - 20000, 0);
    expect(near.ndcZ).toBeLessThan(far.ndcZ);
    for (const d of [near, far]) { expect(d.ndcZ).toBeGreaterThan(-1); expect(d.ndcZ).toBeLessThan(1); }
  });
});
