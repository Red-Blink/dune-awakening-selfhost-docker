/**
 * Whether this browser can draw the Deep Desert terrain at all.
 *
 * The answer is allowed to be no. The flat map image stays committed and stays
 * the default; the terrain canvas is strictly an upgrade over it, so every
 * negative here is an ordinary outcome, not an error state. A self-hoster on a
 * machine without BC7 should just see the map they see today.
 *
 * Dependencies are injected so this is testable without a GPU -- jsdom returns
 * null from getContext("webgl2"), which is exactly the unsupported path.
 */
export type TerrainSupport = { supported: true } | { supported: false; reason: string };

export type TerrainSupportDeps = {
  createCanvas: () => HTMLCanvasElement;
  hasDecompressionStream: () => boolean;
};

const defaultDeps: TerrainSupportDeps = {
  createCanvas: () => document.createElement("canvas"),
  hasDecompressionStream: () => typeof DecompressionStream !== "undefined"
};

export function probeTerrainSupport(deps: Partial<TerrainSupportDeps> = {}): TerrainSupport {
  const { createCanvas, hasDecompressionStream } = { ...defaultDeps, ...deps };

  // Every asset ships gzipped and is inflated in the browser, so this is a hard
  // requirement rather than a quality one. Safari gained it in 16.4.
  if (!hasDecompressionStream()) {
    return { supported: false, reason: "no DecompressionStream" };
  }

  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = createCanvas().getContext("webgl2", { antialias: true, alpha: true }) as WebGL2RenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return { supported: false, reason: "no WebGL2" };

  try {
    // The sand normals ship as BC7 blocks straight from the game's own paks.
    // Present on desktop GL/D3D11 and Apple Silicon, absent on many mobile GPUs.
    const bptc = gl.getExtension("EXT_texture_compression_bptc");
    if (!bptc) return { supported: false, reason: "no BC7 textures" };
  } finally {
    // A probe context is one of a small pool the browser will hand out; drop it
    // rather than waiting for the canvas to be collected, or repeated probes
    // can starve the real renderer of a context.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return { supported: true };
}
