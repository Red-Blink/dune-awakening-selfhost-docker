import { octDecode } from "./terrainGeometry";
import type { TerrainLibrary, TerrainMesh } from "./types";

/**
 * The map's rock meshes are stacks of open plates: the bottom of one cliff face
 * hangs a few metres above the ledge below, leaving a slit that shows sand once
 * the view is tilted. A skirt hung from every open edge closes them.
 */

/** How far a skirt hangs, in the mesh's own units (x100 for world uu: 60 m). */
export const SKIRT_DROP = 60;

const U16 = 65535;

function octEncode(x: number, y: number, z: number): [number, number] {
  const sum = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let ex = x / sum;
  let ey = y / sum;
  if (z < 0) {
    const fx = (1 - Math.abs(ey)) * (ex >= 0 ? 1 : -1);
    const fy = (1 - Math.abs(ex)) * (ey >= 0 ? 1 : -1);
    ex = fx;
    ey = fy;
  }
  return [Math.max(-127, Math.min(127, Math.round(ex * 127))), Math.max(-127, Math.min(127, Math.round(ey * 127)))];
}

export type MeshBuffers = {
  /** u16 x 3 per vertex, quantised over the mesh's extent. */
  pos: Uint16Array;
  /** Octahedral normal, i8 x 2 per vertex. */
  nrm: Int8Array;
  /** u16 x 2 per vertex, or null for a mesh that carries none. */
  uv: Uint16Array | null;
  /** Triangle list, indices local to this mesh. */
  idx: Uint16Array;
  /** Index of the first lowered skirt vertex, on a mesh that was given a skirt. */
  skirt?: number;
};

/**
 * Edges used by exactly one triangle, with vertices at the same position
 * treated as one (the meshes split vertices wherever a normal or UV changes).
 * Returned as flat vertex-index pairs.
 */
export function openEdges(pos: Uint16Array, idx: Uint16Array): Uint32Array {
  const count = pos.length / 3;
  const welded = new Uint32Array(count);
  const seen = new Map<number, number>();
  for (let v = 0; v < count; v++) {
    const key = pos[v * 3] * 4294967296 + pos[v * 3 + 1] * 65536 + pos[v * 3 + 2];
    let id = seen.get(key);
    if (id === undefined) {
      id = seen.size;
      seen.set(key, id);
    }
    welded[v] = id;
  }
  const span = seen.size;
  // edge key -> how many triangles use it, and one use of it
  const uses = new Map<number, number>();
  const from = new Map<number, number>();
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = welded[idx[t]], b = welded[idx[t + 1]], c = welded[idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    for (let e = 0; e < 3; e++) {
      const va = idx[t + e];
      const vb = idx[t + ((e + 1) % 3)];
      const wa = welded[va], wb = welded[vb];
      const key = wa < wb ? wa * span + wb : wb * span + wa;
      const n = uses.get(key) ?? 0;
      uses.set(key, n + 1);
      if (n === 0) from.set(key, va * 65536 + vb);
    }
  }
  const open: number[] = [];
  for (const [key, n] of uses) {
    if (n !== 1) continue;
    const packed = from.get(key)!;
    open.push(Math.floor(packed / 65536), packed % 65536);
  }
  return Uint32Array.from(open);
}

/**
 * Hang a skirt `drop` (quantised z) below every open edge not already on the
 * mesh's floor. A skirt has its own vertices top and bottom, with the normal
 * laid flat: sharing the ledge's vertices would shade it as a ramp from ledge
 * to cliff. The lowered ones come last, from `skirt` on.
 * Returns the mesh unchanged if there is nothing to close or no index room.
 */
export function sealMesh(mesh: MeshBuffers, drop: number): MeshBuffers {
  const edges = openEdges(mesh.pos, mesh.idx);
  const count = mesh.pos.length / 3;
  // Per skirted vertex, in first-seen order: its slot and its flat normal.
  const slot = new Map<number, number>();
  const flat: number[] = [];
  const quads: number[] = [];
  const claim = (v: number, ex: number, ey: number): void => {
    if (slot.has(v)) return;
    slot.set(v, slot.size);
    const n = octDecode(mesh.nrm[v * 2] / 127, mesh.nrm[v * 2 + 1] / 127);
    let nx = n[0];
    let ny = n[1];
    if (Math.hypot(nx, ny) < 0.35) {
      // A ledge's normal has no flat part: use the edge's perpendicular.
      const side = nx * -ey + ny * ex >= 0 ? 1 : -1;
      nx = -ey * side;
      ny = ex * side;
    }
    flat.push(...octEncode(nx, ny, 0));
  };
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e];
    const b = edges[e + 1];
    if (mesh.pos[a * 3 + 2] === 0 && mesh.pos[b * 3 + 2] === 0) continue;
    if (count + (slot.size + 2) * 2 > 65536) break;
    const ex = mesh.pos[b * 3] - mesh.pos[a * 3];
    const ey = mesh.pos[b * 3 + 1] - mesh.pos[a * 3 + 1];
    const len = Math.hypot(ex, ey) || 1;
    claim(a, ex / len, ey / len);
    claim(b, ex / len, ey / len);
    quads.push(a, b);
  }
  if (!quads.length) return mesh;
  const added = slot.size;
  const pos = new Uint16Array(added * 6);
  const nrm = new Int8Array(added * 4);
  const uv = mesh.uv ? new Uint16Array(added * 4) : null;
  for (const [v, k] of slot) {
    for (const [at, z] of [[k, mesh.pos[v * 3 + 2]], [added + k, Math.max(0, mesh.pos[v * 3 + 2] - drop)]]) {
      pos[at * 3] = mesh.pos[v * 3];
      pos[at * 3 + 1] = mesh.pos[v * 3 + 1];
      pos[at * 3 + 2] = z;
      nrm[at * 2] = flat[k * 2];
      nrm[at * 2 + 1] = flat[k * 2 + 1];
      if (uv && mesh.uv) {
        uv[at * 2] = mesh.uv[v * 2];
        uv[at * 2 + 1] = mesh.uv[v * 2 + 1];
      }
    }
  }
  const idx = new Uint16Array(quads.length * 3);
  for (let q = 0; q < quads.length; q += 2) {
    const ta = count + slot.get(quads[q])!;
    const tb = count + slot.get(quads[q + 1])!;
    idx.set([ta, tb, tb + added, ta, tb + added, ta + added], q * 3);
  }
  const join = <A extends Uint16Array | Int8Array>(base: A, extra: A): A => {
    const out = new (base.constructor as new (n: number) => A)(base.length + extra.length);
    out.set(base);
    out.set(extra, base.length);
    return out;
  };
  return {
    pos: join(mesh.pos, pos),
    nrm: join(mesh.nrm, nrm),
    uv: mesh.uv && uv ? join(mesh.uv, uv) : null,
    idx: join(mesh.idx, idx),
    skirt: count + added
  };
}

/** A mesh is rock exactly when it carries a rock texture: see `TerrainMesh.texLayer`. */
function isRock(mesh: TerrainMesh): boolean {
  return mesh.texLayer !== undefined && mesh.uvo !== undefined;
}

/**
 * The shared library (`positions | normals | indices`) with every rock mesh
 * sealed and the table's offsets moved to match. POIs and ground patches are
 * thin structures, not solids, and are copied through untouched.
 */
export function sealRockLibrary(
  library: TerrainLibrary,
  geometry: Uint8Array,
  rockUV: Uint8Array,
  drop = SKIRT_DROP
): { library: TerrainLibrary; geometry: Uint8Array; rockUV: Uint8Array } {
  const vertices = library.posBytes / 6;
  // Copies, so the views are aligned whatever offset the bytes arrived at.
  const allPos = new Uint16Array(geometry.slice(0, library.posBytes).buffer);
  const allNrm = new Int8Array(geometry.slice(library.posBytes, library.posBytes + library.nrmBytes).buffer);
  const allIdx = new Uint16Array(geometry.slice(library.posBytes + library.nrmBytes).buffer);
  const allUV = new Uint16Array(rockUV.slice().buffer);
  if (library.nrmBytes !== vertices * 2) return { library, geometry, rockUV };

  const sealed: MeshBuffers[] = [];
  let anything = false;
  for (const mesh of library.meshes) {
    const base: MeshBuffers = {
      pos: allPos.subarray(mesh.vo * 3, (mesh.vo + mesh.vn) * 3),
      nrm: allNrm.subarray(mesh.vo * 2, (mesh.vo + mesh.vn) * 2),
      uv: isRock(mesh) ? allUV.subarray(mesh.uvo! * 2, (mesh.uvo! + mesh.vn) * 2) : null,
      idx: allIdx.subarray(mesh.io, mesh.io + mesh.ic)
    };
    if (!isRock(mesh)) {
      sealed.push(base);
      continue;
    }
    // The drop is in the mesh's units; its z is quantised over its own height.
    const out = sealMesh(base, Math.round((drop / Math.max(mesh.ext[2], 1e-6)) * U16));
    if (out !== base) anything = true;
    sealed.push(out);
  }
  if (!anything) return { library, geometry, rockUV };

  let vn = 0, ic = 0, un = 0;
  for (const m of sealed) {
    vn += m.pos.length / 3;
    ic += m.idx.length;
    if (m.uv) un += m.uv.length / 2;
  }
  const pos = new Uint16Array(vn * 3);
  const nrm = new Int8Array(vn * 2);
  const idx = new Uint16Array(ic);
  const uv = new Uint16Array(un * 2);
  const meshes: TerrainMesh[] = [];
  let vo = 0, io = 0, uo = 0;
  library.meshes.forEach((mesh, i) => {
    const m = sealed[i];
    const count = m.pos.length / 3;
    pos.set(m.pos, vo * 3);
    nrm.set(m.nrm, vo * 2);
    idx.set(m.idx, io);
    const next: TerrainMesh = { ...mesh, vo, vn: count, io, ic: m.idx.length };
    if (m.skirt !== undefined) next.skirt = m.skirt;
    if (m.uv) {
      uv.set(m.uv, uo * 2);
      next.uvo = uo;
      uo += count;
    }
    meshes.push(next);
    vo += count;
    io += m.idx.length;
  });
  const out = new Uint8Array(pos.byteLength + nrm.byteLength + idx.byteLength);
  out.set(new Uint8Array(pos.buffer), 0);
  out.set(new Uint8Array(nrm.buffer), pos.byteLength);
  out.set(new Uint8Array(idx.buffer), pos.byteLength + nrm.byteLength);
  return {
    library: { ...library, posBytes: pos.byteLength, nrmBytes: nrm.byteLength, idxBytes: idx.byteLength, uvBytes: uv.byteLength, meshes },
    geometry: out,
    rockUV: new Uint8Array(uv.buffer)
  };
}
