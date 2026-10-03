/**
 * Which markers the tilted terrain hides. Markers are DOM elements over the
 * canvas, so nothing occludes them; they are tested against a copy of the
 * frame's depth buffer instead.
 */
export type DepthGrid = {
  /** Window-space depth, 0 (near) to 1 (far, or nothing drawn), `stride` floats per texel, rows bottom-up as readPixels returns them. */
  depth: Float32Array;
  stride: number;
  width: number;
  height: number;
  /** The clip matrix the frame was drawn with (column-major), and its inverse. */
  matrix: Float32Array;
  inverse: Float64Array;
};

/** Inverse of a column-major 4x4, or null if it has none. */
export function invert4(m: ArrayLike<number>): Float64Array | null {
  const a = new Float64Array(16);
  for (let i = 0; i < 16; i++) a[i] = m[i];
  const inv = new Float64Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!Number.isFinite(det) || det === 0) return null;
  for (let i = 0; i < 16; i++) inv[i] /= det;
  return inv;
}

/**
 * Whether the terrain drawn in `grid` hides a world point: every texel in the
 * 3x3 round it shows something both nearer the eye and more than `tolerance`
 * above it. Depth alone would hide everything behind open ground; height alone would
 * hide a marker in front of a cliff.
 */
export function isOccluded(grid: DepthGrid, x: number, y: number, z: number, tolerance: number): boolean {
  const m = grid.matrix;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(w > 0)) return false;
  const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  const depth = ((m[2] * x + m[6] * y + m[10] * z + m[14]) / w) * 0.5 + 0.5;
  const tx = Math.floor((nx * 0.5 + 0.5) * grid.width);
  const ty = Math.floor((ny * 0.5 + 0.5) * grid.height);
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return false;
  const inv = grid.inverse;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = Math.min(grid.width - 1, Math.max(0, tx + dx));
      const cy = Math.min(grid.height - 1, Math.max(0, ty + dy));
      const d = grid.depth[(cy * grid.width + cx) * grid.stride];
      // Nothing drawn there, or what is drawn is behind the point.
      if (!(d < 1) || d >= depth) return false;
      // The height of what is drawn there.
      const px = ((cx + 0.5) / grid.width) * 2 - 1;
      const py = ((cy + 0.5) / grid.height) * 2 - 1;
      const pz = d * 2 - 1;
      const sw = inv[3] * px + inv[7] * py + inv[11] * pz + inv[15];
      const sz = (inv[2] * px + inv[6] * py + inv[10] * pz + inv[14]) / sw;
      if (!(sz > z + tolerance)) return false;
    }
  }
  return true;
}
