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
};

export type TerrainLibrary = {
  posBytes: number;
  nrmBytes: number;
  idxBytes: number;
  meshes: TerrainMesh[];
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
