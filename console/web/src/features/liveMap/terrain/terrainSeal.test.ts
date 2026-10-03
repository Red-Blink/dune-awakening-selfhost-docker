import { describe, expect, it } from "vitest";
import { octDecode } from "./terrainGeometry";
import { openEdges, sealMesh, sealRockLibrary } from "./terrainSeal";
import type { MeshBuffers } from "./terrainSeal";
import type { TerrainLibrary } from "./types";

/** A mesh from loose triangles: every triangle gets its own three vertices, as the real ones largely do. */
function soup(triangles: number[][][], normal: [number, number] = [0, 0]): MeshBuffers {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const tri of triangles) {
    for (const v of tri) {
      idx.push(pos.length / 3);
      pos.push(v[0], v[1], v[2]);
      nrm.push(normal[0], normal[1]);
      uv.push(v[0], v[1]);
    }
  }
  return { pos: Uint16Array.from(pos), nrm: Int8Array.from(nrm), uv: Uint16Array.from(uv), idx: Uint16Array.from(idx) };
}

const quad = (a: number[], b: number[], c: number[], d: number[]) => [[a, b, c], [a, c, d]];

/** A box from z0 to z1 over [x0,x1] x [y0,y1], optionally without its floor. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, floor: boolean) {
  const p = (x: number, y: number, z: number) => [x, y, z];
  const faces = [
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),
    ...quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)),
    ...quad(p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1)),
    ...quad(p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1))
  ];
  if (floor) faces.push(...quad(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)));
  return faces;
}

describe("openEdges", () => {
  it("finds none on a closed box, though no two triangles share a vertex index", () => {
    expect(openEdges(soup(box(100, 200, 100, 200, 100, 200, true)).pos, soup(box(100, 200, 100, 200, 100, 200, true)).idx)).toHaveLength(0);
  });

  it("finds the rim of a box with no floor", () => {
    const mesh = soup(box(100, 200, 100, 200, 100, 200, false));
    const edges = openEdges(mesh.pos, mesh.idx);
    expect(edges.length / 2).toBe(4);
    // every one of them along the bottom
    for (const v of edges) expect(mesh.pos[v * 3 + 2]).toBe(100);
  });

  it("ignores a triangle with no area", () => {
    const mesh = soup([[[0, 0, 0], [0, 0, 0], [10, 10, 10]]]);
    expect(openEdges(mesh.pos, mesh.idx)).toHaveLength(0);
  });
});

describe("sealMesh", () => {
  // One plate over another: the upper's walls stop at z = 1000, the lower's top is at 900.
  const upper = box(400, 600, 400, 600, 1000, 1500, false);
  const lower = box(200, 800, 200, 800, 500, 900, false);
  const stacked = soup([...upper, ...lower]);

  it("hangs a skirt from each open edge, far enough to pass the plate below", () => {
    const sealed = sealMesh(stacked, 300);
    const added = (sealed.pos.length - stacked.pos.length) / 3;
    // Both plates have a four-edge rim: 8 open edges, 2 triangles each.
    expect((sealed.idx.length - stacked.idx.length) / 3).toBe(16);
    expect(added).toBeGreaterThan(0);
    // The originals are untouched, in place.
    expect(Array.from(sealed.pos.subarray(0, stacked.pos.length))).toEqual(Array.from(stacked.pos));
    expect(Array.from(sealed.idx.subarray(0, stacked.idx.length))).toEqual(Array.from(stacked.idx));
    // The skirt's own top vertices sit on the open edges; the lowered ones, from
    // `skirt` on, are straight below them by the drop.
    const heights = (from: number, to: number) => {
      const z = new Set<number>();
      for (let v = from; v < to; v++) z.add(sealed.pos[v * 3 + 2]);
      return [...z].sort((a, b) => a - b);
    };
    expect(sealed.skirt).toBe(stacked.pos.length / 3 + added / 2);
    expect(heights(stacked.pos.length / 3, sealed.skirt!)).toEqual([500, 1000]);
    expect(heights(sealed.skirt!, sealed.pos.length / 3)).toEqual([200, 700]);
    // A skirt uses none of the mesh's own vertices, so the ledge's normal does not bleed into it.
    for (let t = stacked.idx.length; t < sealed.idx.length; t++) expect(sealed.idx[t]).toBeGreaterThanOrEqual(stacked.pos.length / 3);
    // The upper plate's skirt (z 700..1000) spans the slit (z 900..1000).
    const skirtTops = new Set<number>();
    for (let t = stacked.idx.length; t < sealed.idx.length; t++) skirtTops.add(sealed.pos[sealed.idx[t] * 3 + 2]);
    expect(skirtTops.has(1000)).toBe(true);
    expect(skirtTops.has(700)).toBe(true);
  });

  it("carries the edge's UVs down and lays its normal flat", () => {
    const sealed = sealMesh(stacked, 300);
    for (let v = stacked.pos.length / 3; v < sealed.pos.length / 3; v++) {
      // UVs here were set to the vertex's own x,y, which a skirt does not move.
      expect(sealed.uv![v * 2]).toBe(sealed.pos[v * 3]);
      expect(sealed.uv![v * 2 + 1]).toBe(sealed.pos[v * 3 + 1]);
      const n = octDecode(sealed.nrm[v * 2] / 127, sealed.nrm[v * 2 + 1] / 127);
      expect(Math.abs(n[2])).toBeLessThan(0.02);
      expect(Math.hypot(n[0], n[1])).toBeGreaterThan(0.98);
    }
  });

  it("keeps a cliff face's own direction for its skirt", () => {
    // A single wall facing +x, with that normal: oct (1, 0).
    const wall = soup(quad([500, 400, 1000], [500, 600, 1000], [500, 600, 1500], [500, 400, 1500]), [127, 0]);
    const sealed = sealMesh(wall, 200);
    for (let v = wall.pos.length / 3; v < sealed.pos.length / 3; v++) {
      const n = octDecode(sealed.nrm[v * 2] / 127, sealed.nrm[v * 2 + 1] / 127);
      expect(n[0]).toBeGreaterThan(0.98);
    }
  });

  it("leaves edges on the mesh's floor alone, and stops at the floor", () => {
    // A box standing on z = 0 with no floor: its rim has nowhere to go.
    const grounded = soup(box(100, 200, 100, 200, 0, 500, false));
    expect(sealMesh(grounded, 300)).toBe(grounded);
    // One just above the floor is clamped to it rather than wrapping below zero.
    const low = soup(box(100, 200, 100, 200, 50, 500, false));
    const sealed = sealMesh(low, 300);
    for (let v = sealed.skirt!; v < sealed.pos.length / 3; v++) expect(sealed.pos[v * 3 + 2]).toBe(0);
  });

  it("returns a closed mesh as it is", () => {
    const closed = soup(box(100, 200, 100, 200, 100, 200, true));
    expect(sealMesh(closed, 300)).toBe(closed);
  });

  it("works without UVs", () => {
    const bare = { ...stacked, uv: null };
    const sealed = sealMesh(bare, 300);
    expect(sealed.uv).toBeNull();
    expect(sealed.pos.length).toBeGreaterThan(bare.pos.length);
  });
});

describe("sealRockLibrary", () => {
  const rock = soup([...box(400, 600, 400, 600, 1000, 1500, false), ...box(200, 800, 200, 800, 500, 900, false)]);
  const poi = soup(box(100, 300, 100, 300, 2000, 2600, false));
  const rock2 = soup(box(10, 90, 10, 90, 4000, 9000, false));

  /** Pack meshes the way the pipeline does: positions | normals | indices, UVs apart. */
  function pack(parts: { mesh: MeshBuffers; rock: boolean }[]) {
    const meshes: TerrainLibrary["meshes"] = [];
    const pos: number[] = [], nrm: number[] = [], idx: number[] = [], uv: number[] = [];
    for (const part of parts) {
      const vo = pos.length / 3;
      meshes.push({
        lo: [0, 0, 0], ext: [100, 100, 65535 / 100], vo, vn: part.mesh.pos.length / 3, io: idx.length, ic: part.mesh.idx.length,
        ...(part.rock ? { texLayer: 0, texGain: 1, uvo: uv.length / 2 } : {})
      });
      pos.push(...part.mesh.pos);
      nrm.push(...part.mesh.nrm);
      idx.push(...part.mesh.idx);
      if (part.rock) uv.push(...part.mesh.uv!);
    }
    const p = Uint16Array.from(pos), n = Int8Array.from(nrm), i = Uint16Array.from(idx), u = Uint16Array.from(uv);
    const geometry = new Uint8Array(p.byteLength + n.byteLength + i.byteLength);
    geometry.set(new Uint8Array(p.buffer), 0);
    geometry.set(new Uint8Array(n.buffer), p.byteLength);
    geometry.set(new Uint8Array(i.buffer), p.byteLength + n.byteLength);
    const library: TerrainLibrary = { posBytes: p.byteLength, nrmBytes: n.byteLength, idxBytes: i.byteLength, uvBytes: u.byteLength, meshes };
    return { library, geometry, rockUV: new Uint8Array(u.buffer) };
  }

  const packed = pack([{ mesh: rock, rock: true }, { mesh: poi, rock: false }, { mesh: rock2, rock: true }]);
  // ext z is 655.35 units over the u16 range, so 1 unit = 100 counts: a drop of 3 is 300.
  const out = sealRockLibrary(packed.library, packed.geometry, packed.rockUV, 3);
  const view = (lib: TerrainLibrary, geometry: Uint8Array, rockUV: Uint8Array) => ({
    pos: new Uint16Array(geometry.slice(0, lib.posBytes).buffer),
    nrm: new Int8Array(geometry.slice(lib.posBytes, lib.posBytes + lib.nrmBytes).buffer),
    idx: new Uint16Array(geometry.slice(lib.posBytes + lib.nrmBytes).buffer),
    uv: new Uint16Array(rockUV.slice().buffer)
  });
  const before = view(packed.library, packed.geometry, packed.rockUV);
  const after = view(out.library, out.geometry, out.rockUV);

  it("seals the rock and copies everything else through unchanged", () => {
    const [r1, p1, r2] = out.library.meshes;
    const [r0, p0] = packed.library.meshes;
    expect(r1.vn).toBeGreaterThan(r0.vn);
    expect(r1.ic).toBe(r0.ic + 8 * 6);
    expect(r2.ic).toBe(packed.library.meshes[2].ic + 4 * 6);
    // The POI: same vertex and index counts, same bytes, merely moved along.
    expect(p1.vn).toBe(p0.vn);
    expect(p1.ic).toBe(p0.ic);
    expect(p1.uvo).toBeUndefined();
    // A sealed mesh records where its lowered skirt vertices start: its own come first, then the skirt's tops.
    expect(r1.skirt).toBe(r0.vn + (r1.vn - r0.vn) / 2);
    expect(p1.skirt).toBeUndefined();
    expect(Array.from(after.pos.subarray(p1.vo * 3, (p1.vo + p1.vn) * 3))).toEqual(Array.from(before.pos.subarray(p0.vo * 3, (p0.vo + p0.vn) * 3)));
    expect(Array.from(after.idx.subarray(p1.io, p1.io + p1.ic))).toEqual(Array.from(before.idx.subarray(p0.io, p0.io + p0.ic)));
  });

  it("keeps the table consistent with the bytes", () => {
    const lib = out.library;
    expect(out.geometry.byteLength).toBe(lib.posBytes + lib.nrmBytes + lib.idxBytes);
    expect(out.rockUV.byteLength).toBe(lib.uvBytes);
    expect(lib.nrmBytes).toBe((lib.posBytes / 6) * 2);
    let vo = 0, io = 0, uo = 0;
    for (const mesh of lib.meshes) {
      // packed back to back, in order
      expect(mesh.vo).toBe(vo);
      expect(mesh.io).toBe(io);
      // every index stays inside its own mesh
      for (let k = mesh.io; k < mesh.io + mesh.ic; k++) expect(after.idx[k]).toBeLessThan(mesh.vn);
      if (mesh.uvo !== undefined) {
        expect(mesh.uvo).toBe(uo);
        uo += mesh.vn;
      }
      vo += mesh.vn;
      io += mesh.ic;
    }
    expect(vo * 6).toBe(lib.posBytes);
    expect(io * 2).toBe(lib.idxBytes);
    expect(uo * 4).toBe(lib.uvBytes);
  });

  it("drops by the mesh's own height scale", () => {
    const r1 = out.library.meshes[0];
    const zs = new Set<number>();
    for (let v = r1.vo + r1.skirt!; v < r1.vo + r1.vn; v++) zs.add(after.pos[v * 3 + 2]);
    // rims at 1000 and 500, dropped 300 counts
    expect([...zs].sort((a, b) => a - b)).toEqual([200, 700]);
  });

  it("hands back the very same library when there is no rock to seal", () => {
    const plain = pack([{ mesh: poi, rock: false }]);
    const same = sealRockLibrary(plain.library, plain.geometry, plain.rockUV);
    expect(same.library).toBe(plain.library);
    expect(same.geometry).toBe(plain.geometry);
    expect(same.rockUV).toBe(plain.rockUV);
  });
});
