import { describe, expect, it } from "vitest";
import { cameraClipMatrix, cameraFromRect, fovForTilt, screenToWorldAtZ } from "./terrainCamera";
import type { TerrainCamera } from "./terrainCamera";
import { invert4, isOccluded } from "./terrainOcclusion";
import type { DepthGrid } from "./terrainOcclusion";

const W = 800;
const H = 600;
const GW = 200;
const GH = 150;
const deg = (d: number) => (d * Math.PI) / 180;

function camera(tiltDeg: number, yawDeg = 0): TerrainCamera {
  const tilt = deg(tiltDeg);
  return {
    ...cameraFromRect({ minX: -200000, maxX: 200000, minY: -150000, maxY: 150000, flipY: false }, W, H),
    cz: 0, tilt, yaw: deg(yawDeg), fov: fovForTilt(tilt)
  };
}

type Block = { x0: number; x1: number; y0: number; y1: number; top: number };

/**
 * The depth grid a scene would leave: flat ground at z = 0 plus axis-aligned
 * blocks, each texel taking the nearest surface along its ray.
 */
function scene(cam: TerrainCamera, blocks: Block[]): DepthGrid {
  const matrix = cameraClipMatrix(cam, -1000, 60000, 300000);
  const depth = new Float32Array(GW * GH * 4).fill(1);
  const depthOf = (x: number, y: number, z: number) => {
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    return ((matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w) * 0.5 + 0.5;
  };
  const top = Math.max(0, ...blocks.map((b) => b.top));
  for (let ty = 0; ty < GH; ty++) {
    for (let tx = 0; tx < GW; tx++) {
      const sx = ((tx + 0.5) / GW) * W;
      const sy = (1 - (ty + 0.5) / GH) * H; // rows bottom-up
      let hit = screenToWorldAtZ(cam, sx, sy, 0);
      let hitZ = 0;
      for (let z = top; z > 0; z -= 250) {
        const p = screenToWorldAtZ(cam, sx, sy, z);
        if (blocks.some((b) => z <= b.top && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1)) {
          hit = p;
          hitZ = z;
          break;
        }
      }
      depth[(ty * GW + tx) * 4] = depthOf(hit.x, hit.y, hitZ);
    }
  }
  return { depth, stride: 4, width: GW, height: GH, matrix, inverse: invert4(matrix)! };
}

describe("invert4", () => {
  it("inverts the camera's clip matrix", () => {
    const m = cameraClipMatrix(camera(50, 30), -1000, 60000, 300000);
    const inv = invert4(m)!;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += m[k * 4 + r] * inv[c * 4 + k];
      expect(s).toBeCloseTo(r === c ? 1 : 0, 6);
    }
  });

  it("refuses a matrix with no inverse", () => {
    expect(invert4(new Float32Array(16))).toBeNull();
  });
});

describe("isOccluded", () => {
  const TOL = 3000;
  // At yaw 0 the viewer is on the +Y side, looking toward -Y.
  const cam = camera(50);
  const wall: Block = { x0: -40000, x1: 40000, y0: -10000, y1: 10000, top: 40000 };
  const grid = scene(cam, [wall]);

  it("hides a marker standing behind something tall", () => {
    expect(isOccluded(grid, 0, -25000, 0, TOL)).toBe(true);
  });

  it("keeps a marker in front of it, though the wall rises behind", () => {
    expect(isOccluded(grid, 0, 25000, 0, TOL)).toBe(false);
  });

  it("keeps a marker on top of it", () => {
    expect(isOccluded(grid, 0, 0, 40000, TOL)).toBe(false);
  });

  it("keeps markers on open ground, where the ground in front is nearer the eye", () => {
    for (const [x, y] of [[-120000, 60000], [100000, -90000], [0, 90000], [-150000, -100000]]) {
      expect(isOccluded(grid, x, y, 0, TOL)).toBe(false);
    }
  });

  it("keeps a marker inside or just under something lower than the tolerance", () => {
    const low = scene(cam, [{ ...wall, top: 2500 }]);
    expect(isOccluded(low, 0, 0, 0, TOL)).toBe(false);
    // The same marker under the tall wall is hidden.
    expect(isOccluded(grid, 0, 0, 0, TOL)).toBe(true);
  });

  it("does not hide a marker an edge merely clips", () => {
    // Just past the end of the wall: part of the neighbourhood sees round it.
    const edgeX = wall.x1 + cam.scale * 3;
    expect(isOccluded(grid, edgeX, -25000, 0, TOL)).toBe(false);
  });

  it("follows the view round: what hides a marker from one side does not from the other", () => {
    const behind = scene(camera(50, 180), [wall]);
    expect(isOccluded(behind, 0, -25000, 0, TOL)).toBe(false);
    expect(isOccluded(behind, 0, 25000, 0, TOL)).toBe(true);
  });

  it("keeps a marker whose top shows a cliff behind it, however much is in front", () => {
    // Zoomed out, the texels above a marker can show ground that is higher than
    // it and yet behind it. Only the depth tells those apart from cover.
    const wide: TerrainCamera = { ...camera(50), scale: 2500 };
    const matrix = cameraClipMatrix(wide, -1000, 60000, 300000);
    const depthOf = (x: number, y: number, z: number) => {
      const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
      return ((matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w) * 0.5 + 0.5;
    };
    // The marker sits at the view centre, on the ground.
    const marker = { x: wide.cx, y: wide.cy, z: 0 };
    const tx = GW / 2;
    const ty = GH / 2;
    /** A grid where each of the marker's three texel rows shows a surface at a chosen height. */
    const build = (heights: { below: number; level: number; above: number }): DepthGrid => {
      const depth = new Float32Array(GW * GH * 4).fill(1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const cx = tx + dx;
        const cy = ty + dy;
        const z = dy < 0 ? heights.below : dy === 0 ? heights.level : heights.above;
        const hit = screenToWorldAtZ(wide, ((cx + 0.5) / GW) * W, (1 - (cy + 0.5) / GH) * H, z);
        depth[(cy * GW + cx) * 4] = depthOf(hit.x, hit.y, z);
      }
      return { depth, stride: 4, width: GW, height: GH, matrix, inverse: invert4(matrix)! };
    };
    const markerDepth = depthOf(marker.x, marker.y, marker.z);

    // Tall rock in front on the lower two rows; the row above sees past it to higher ground behind.
    const cliffBehind = build({ below: 10000, level: 10000, above: 3500 });
    expect(cliffBehind.depth[((ty + 1) * GW + tx) * 4]).toBeGreaterThan(markerDepth);
    expect(cliffBehind.depth[(ty * GW + tx) * 4]).toBeLessThan(markerDepth);
    expect(isOccluded(cliffBehind, marker.x, marker.y, marker.z, TOL)).toBe(false);

    // The same rock, tall enough to cover the top row too: now it is hidden.
    const covered = build({ below: 10000, level: 10000, above: 20000 });
    expect(covered.depth[((ty + 1) * GW + tx) * 4]).toBeLessThan(markerDepth);
    expect(isOccluded(covered, marker.x, marker.y, marker.z, TOL)).toBe(true);
  });

  it("hides nothing outside the view or where nothing was drawn", () => {
    expect(isOccluded(grid, 5e6, 5e6, 0, TOL)).toBe(false);
    const empty = { ...grid, depth: new Float32Array(GW * GH * 4).fill(1) };
    expect(isOccluded(empty, 0, -25000, 0, TOL)).toBe(false);
  });
});
