import type { TerrainDrawCall, TerrainLayoutMeta, TerrainLibrary, TerrainView } from "./types";

/**
 * A mesh over 50k uu on both horizontal axes is a landscape tile; everything
 * else (rock, patch, POI) is under 1.9k. Only the tiles overlap a neighbour, so
 * only they are feathered at their rim.
 */
const LAND_EXTENT = 50000;

/** Slack either side when mapping world Z into clip depth. */
const DEPTH_SLACK = 2.2;

/**
 * Pair each of a layout's draws with its mesh from the shared library. The
 * renderer's draw loop wants one flat record per (mesh, layout) pair: geometry
 * offsets from the library, instance range and overlay flag from the layout.
 */
export function buildDrawCalls(library: TerrainLibrary, layout: TerrainLayoutMeta): TerrainDrawCall[] {
  return layout.draws.map((draw) => {
    const mesh = library.meshes[draw.m];
    if (!mesh) throw new Error(`layout ${layout.layout} references mesh ${draw.m}, which the library does not have`);
    return {
      ...mesh,
      instOff: draw.off,
      instN: draw.n,
      overlay: draw.overlay,
      land: mesh.ext[0] > LAND_EXTENT && mesh.ext[1] > LAND_EXTENT
    };
  });
}

/**
 * How far world Z is spread across clip depth. Exposed because the overlay
 * layer's depth bias is expressed in world units and has to be divided through
 * by the same number.
 */
export function depthRange(layout: Pick<TerrainLayoutMeta, "zmin" | "zmax">): number {
  return DEPTH_SLACK * Math.max(Math.abs(layout.zmax), Math.abs(layout.zmin), 1);
}

/**
 * Orthographic projection mapping a world rectangle onto the clip cube.
 *
 * This is the one piece the port genuinely changes. The prototype owned its own
 * camera and built this from a centre plus a half-extent; here the panel owns
 * pan and zoom and hands us the visible rect, so the terrain lands on exactly
 * the world rectangle the panel believes it is showing.
 *
 * That is also what corrects the shipped map image's 8.1% mis-scale: the PNG is
 * stretched to fill `LIVE_MAP_CONFIGS`' rect even though it only covers the
 * 9-sector grid, whereas rendering places geometry at its true world position.
 *
 * Screen Y runs opposite to clip Y: the panel's pixel space grows downward and
 * `flipY` is false for both maps, so increasing world Y is drawn further down.
 * Depth is negated so that higher ground wins a `LESS` depth test.
 *
 * Returns a column-major mat4 for `uniformMatrix4fv(..., false, m)`.
 */
export function orthoFromWorldRect(view: TerrainView, zRange: number): Float32Array {
  const width = view.maxX - view.minX;
  const height = view.maxY - view.minY;
  if (!(width > 0) || !(height > 0)) throw new Error("terrain view rectangle must have positive extent");

  const sx = 2 / width;
  const tx = -(view.minX + view.maxX) / width;
  // Unflipped, world +Y draws downward, so clip Y is negated.
  const flip = view.flipY ? -1 : 1;
  const sy = (-2 / height) * flip;
  const ty = ((view.minY + view.maxY) / height) * flip;

  const m = new Float32Array(16);
  m[0] = sx;
  m[5] = sy;
  m[10] = -1 / zRange;
  m[12] = tx;
  m[13] = ty;
  m[14] = 0.5;
  m[15] = 1;
  return m;
}

/** Project a world point through `orthoFromWorldRect`'s matrix. For tests and hit-testing. */
export function projectWorldPoint(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[12], m[5] * y + m[13], m[10] * z + m[14]];
}

/**
 * Decode an oct-encoded normal back to a unit vector. The shader does this
 * itself; this mirrors it so the encoding can be checked against a fixture
 * without a GPU.
 */
export function octDecode(ex: number, ey: number): [number, number, number] {
  let x = ex;
  let y = ey;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = nx;
    y = ny;
  }
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** Dequantise a u16 position triple back to world units, as the vertex shader does. */
export function dequantizePosition(
  q: ArrayLike<number>,
  at: number,
  lo: readonly [number, number, number],
  ext: readonly [number, number, number]
): [number, number, number] {
  return [
    lo[0] + (q[at] / 65535) * ext[0],
    lo[1] + (q[at + 1] / 65535) * ext[1],
    lo[2] + (q[at + 2] / 65535) * ext[2]
  ];
}

/**
 * Height of the sand at a world point, sampled from the height field the same
 * way the shader does: nearest texel, clamped at the edges.
 */
export function sampleHeightField(field: Uint16Array, layout: TerrainLayoutMeta, x: number, y: number): number {
  const n = layout.hfN;
  const ix = Math.min(n - 1, Math.max(0, Math.round((x - layout.hfX0) / layout.hfStep)));
  const iy = Math.min(n - 1, Math.max(0, Math.round((y - layout.hfY0) / layout.hfStep)));
  const raw = field[iy * n + ix];
  return layout.hfZlo + (raw / 65535) * (layout.hfZhi - layout.hfZlo);
}
