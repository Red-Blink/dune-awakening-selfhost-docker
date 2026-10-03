// Shapes of the terrain assets emitted by the offline pipeline
// (`.claude/deep-desert-terrain/`). The mesh library is shared by all 12
// layouts; a layout carries only which meshes it places and its own terrain.

/** One mesh in the shared library: where its vertices and indices live. */
export type TerrainMesh = {
  /** Quantisation origin, world units. */
  lo: [number, number, number];
  /** Quantisation extent, world units. Positions are lo + (u16 / 65535) * ext. */
  ext: [number, number, number];
  /** First vertex, in vertices (not bytes). */
  vo: number;
  /** Vertex count. */
  vn: number;
  /** First index, in indices (not bytes). */
  io: number;
  /** Index count. */
  ic: number;
  /** Rock only: the layer of the rock texture array holding this family's diffuse. */
  texLayer?: number;
  /** Brings that diffuse to the shared mean brightness. */
  texGain?: number;
  /** First vertex of this mesh's UVs in the rock UV buffer, in vertices. */
  uvo?: number;
  /** Index of the first lowered skirt vertex the seal appended; absent on an unsealed mesh. */
  skirt?: number;
};

export type TerrainLibrary = {
  posBytes: number;
  nrmBytes: number;
  idxBytes: number;
  /** Normalized u16 UV pairs for the textured meshes only, indexed by `uvo`. */
  uvBytes?: number;
  /** Layers in the rock texture array, each `texSize` square, BC1. */
  texLayers?: number;
  texSize?: number;
  /** How the index section is stored; absent means plain u16. See `decodeIndices`. */
  idxCoding?: string;
  meshes: TerrainMesh[];
};

/**
 * Rock standing wholly outside the mapped square: the same in every layout, so
 * it ships once. Draws index the shared instance block, not a layout's.
 */
export type TerrainOutside = {
  nInst: number;
  /** Top of the tallest piece, world uu. */
  zmax: number;
  draws: { m: number; off: number; n: number }[];
};

/**
 * The rock and POI placements every layout has, shipped once. Draws are keyed
 * by mesh and overlay flag, and index the shared instance block.
 */
export type TerrainCommonRock = {
  nInst: number;
  draws: { m: number; overlay: number; off: number; n: number }[];
};

/**
 * The game's sand past a layout's height field, also shared. A frame of heights
 * on the layout's grid extended `pad` texels each way: everything outside the
 * layout's field, plus that field's own outermost ring.
 */
export type TerrainSandRing = {
  pad: number;
  /** The `hfN` this frame fits round. */
  n: number;
  /** Height is `zlo + value * zstep`, world uu. */
  zlo: number;
  zstep: number;
};

/** One mesh placed by one layout. */
export type TerrainDraw = {
  /** Index into `TerrainLibrary.meshes`. */
  m: number;
  /** First instance, in instances. */
  off: number;
  /** Instance count. */
  n: number;
  /**
   * Composited over the terrain rather than depth-tested against it, so a
   * landmark buried in a dune still reads. Exactly `iMat === 2`; the pipeline
   * asserts that per mesh at build time.
   */
  overlay: number;
};

export type TerrainLayoutMeta = {
  layout: number;
  nInst: number;
  /**
   * Set once a layout's placements have been split from those every layout
   * shares: how many shared ones it expects. Its own `draws` then cover only
   * its own placements. See `withCommonRock`.
   */
  common?: number;
  tris: number;
  /** Vertical range of everything in this layout, for the depth mapping. */
  zmin: number;
  zmax: number;
  /** Centre and half-extent of the mapped square, world units. */
  cx: number;
  cy: number;
  half: number;
  /** Height the backdrop quad is painted at. */
  floorZ: number;
  /** Height field: N x N u16, spanning hfZlo..hfZhi. */
  hfN: number;
  hfZlo: number;
  hfZhi: number;
  hfStep: number;
  hfX0: number;
  hfY0: number;
  draws: TerrainDraw[];
};

/** A mesh from the library, paired with one layout's instances of it. */
export type TerrainDrawCall = TerrainMesh & {
  instOff: number;
  instN: number;
  overlay: number;
  /**
   * Landscape tiles are the only geometry that overlaps a neighbour, so only
   * they are feathered. They separate cleanly by size: every landscape mesh is
   * over 50k uu across, every rock/POI mesh is under 1.9k.
   */
  land: boolean;
};

/**
 * The world rectangle to draw, in game units. The Live Map panel owns pan and
 * zoom, so it hands the renderer the rect currently scrolled into view rather
 * than the renderer keeping a camera of its own.
 */
export type TerrainView = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  flipY: boolean;
};

/** A square lettered grid on the world plane: min corner, cell size in uu, cells per side. */
export type SectorGridSpec = { x0: number; y0: number; cell: number; divisions: number };
