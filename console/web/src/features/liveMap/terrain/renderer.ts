import { BFS, BVS, CFS, FS, RFS, RVS, VS } from "./shaders";
import { buildDrawCalls, depthRange, orthoFromWorldRect, applyCanvasSize } from "./terrainGeometry";
import type { LayoutAssets, SharedAssets } from "./terrainAssets";
import type { TerrainDrawCall, TerrainView } from "./types";

/**
 * The Deep Desert terrain renderer: framework-free WebGL2. Ported from the
 * offline prototype kept at `.claude/deep-desert-terrain/`.
 *
 * Two rules it is built on, because the Live Map panel owns pan and zoom:
 *
 * - **No camera.** It is handed the world rect currently in view and projects
 *   onto exactly that, so terrain and markers share one mapping.
 * - **No render loop.** `draw()` is synchronous and runs only when something
 *   changed; this console sits open for hours and must not pin a GPU.
 */

// Calibrated against the game's own material parameters and in-game screenshots.
// See the plan notes -- these are not free parameters to re-guess.
const FEATHER = 992; // local units, the measured landscape tile-to-tile overlap
const ROCKW = 8.0; // rock/POI outweigh terrain in the blend so they stay opaque
const OVERLAY = 0; // world uu of depth priority for the overlay layer
const LIFTON = 1.0;
const PATCHCUT = 400; // softness of the flat clip, world uu
const PATCHFEATHER = 7000; // world uu over which a patch dissolves at its rim
const PATCHCOL: [number, number, number] = [0.56, 0.442, 0.286];
const POICOL: [number, number, number] = [0.537, 0.659, 0.592]; // MI_UiMap_POIs #89A897
const TILE = 64762; // material's 'Normal Size', 647.62 m in world uu
const DETSTR = 0.6053; // material's 'Normal Strength'
const BRKTILE = 30000; // world uu per repeat of the breakup noise
const BRKAMP = 420; // world uu the patch clip height wobbles by
const CLIPRAISE = 700; // lift the clip clear of the sand so it owns the edge
const SUN: [number, number, number] = [-0.4, -0.5, 0.77];
/**
 * Outside the mapped square. Deliberately a deep neutral rather than a pale
 * tone: with the boundary now hard-clipped, this is what the map is seen
 * against, and a pale fill reads as unfinished empty paper.
 */
const VOID_COLOUR: [number, number, number] = [0.3, 0.26, 0.22];
const INSTANCE_STRIDE = 56; // 14 float32: mat3, translation, iMat, lift
const INSTANCE_OFFSETS = [0, 12, 24, 36, 48, 52];

export type DeepDesertRenderer = {
  readonly ready: boolean;
  setAssets(shared: SharedAssets, layout: LayoutAssets): void;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  setView(view: TerrainView): void;
  draw(): void;
  dispose(): void;
};

export type RendererOptions = {
  /**
   * Fired when the GPU takes the context away -- a driver update, a GPU reset,
   * or the browser reclaiming it. The caller should fall back to the flat map
   * image rather than leave a blank canvas.
   */
  onContextLost?: () => void;
};

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`terrain shader failed to compile: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("could not create program");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`terrain program failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export function createDeepDesertRenderer(canvas: HTMLCanvasElement, options: RendererOptions = {}): DeepDesertRenderer {
  const context = canvas.getContext("webgl2", { antialias: true, alpha: false }) as WebGL2RenderingContext | null;
  if (!context) throw new Error("WebGL2 is not available");
  // Rebound to a non-nullable const: the narrowing above does not survive into
  // the nested draw helpers, and `gl!` on every one of ~200 call sites would be
  // noise that hides a real nullable somewhere else.
  const gl: WebGL2RenderingContext = context;

  const compressedFormats = gl.getExtension("EXT_texture_compression_bptc");
  if (!compressedFormats) throw new Error("EXT_texture_compression_bptc is not available");
  const bptc: EXT_texture_compression_bptc = compressedFormats;
  // Order-independent weighted blending wants a float accumulator. Without it
  // the blend still works, just flatter -- not a reason to refuse to draw.
  const floatBuffer = !!gl.getExtension("EXT_color_buffer_float");
  const rockWeight = floatBuffer ? ROCKW : 1.0;

  const terrain = link(gl, VS, FS);
  const resolve = link(gl, RVS, RFS);
  const backdrop = link(gl, BVS, BFS);
  const decode = link(gl, RVS, CFS);

  const u = (program: WebGLProgram, name: string) => gl.getUniformLocation(program, name);
  const t = {
    lo: u(terrain, "uLo"), ext: u(terrain, "uExt"), vp: u(terrain, "uVP"), light: u(terrain, "uL"),
    zlo: u(terrain, "uZlo"), zhi: u(terrain, "uZhi"), c: u(terrain, "uC"), half: u(terrain, "uHalf"),
    feather: u(terrain, "uFeather"), hf: u(terrain, "uHF"), hfMode: u(terrain, "uHFMode"),
    hn: u(terrain, "uHN"), hStep: u(terrain, "uHStep"), hx0: u(terrain, "uHX0"), hy0: u(terrain, "uHY0"),
    hzlo: u(terrain, "uHZlo"), hzhi: u(terrain, "uHZhi"), wScale: u(terrain, "uWScale"),
    bias: u(terrain, "uBias"), lift: u(terrain, "uLift"), patchCut: u(terrain, "uPatchCut"),
    patchFeather: u(terrain, "uPatchFeather"), patchCol: u(terrain, "uPatchCol"), poiCol: u(terrain, "uPoiCol"),
    brk: u(terrain, "uBrk"), brkTile: u(terrain, "uBrkTile"), brkAmp: u(terrain, "uBrkAmp"),
    clipRaise: u(terrain, "uClipRaise"), prepass: u(terrain, "uPrepass"), view: u(terrain, "uV"),
    d1: u(terrain, "uD1"), d2: u(terrain, "uD2"), tile: u(terrain, "uTile"),
    detStr: u(terrain, "uDetStr"), detail: u(terrain, "uDetail")
  };
  const r = { tex: u(resolve, "uT"), texel: u(resolve, "uTexel"), ss: u(resolve, "uSS") };
  const b = { vp: u(backdrop, "uVP"), c: u(backdrop, "uC"), half: u(backdrop, "uHalf"), z: u(backdrop, "uZ") };
  const decodeTex = u(decode, "uT");

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.disable(gl.CULL_FACE);

  /**
   * WebGL cannot mip a compressed texture, and at map zoom one pixel covers
   * ~100 texels -- unmipped these alias into noise. So decode the BC7 blocks
   * once on the GPU into an RGBA8 copy that can carry a real mip chain.
   */
  function decodeToMipped(raw: Uint8Array, size: number): WebGLTexture {
    const compressed = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, compressed);
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, bptc.COMPRESSED_RGBA_BPTC_UNORM_EXT, size, size, 0, raw);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const decoded = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, decoded);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, decoded, 0);
    gl.viewport(0, 0, size, size);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(decode);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, compressed);
    gl.uniform1i(decodeTex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribDivisor(0, 0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(compressed);

    gl.bindTexture(gl.TEXTURE_2D, decoded);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.enable(gl.DEPTH_TEST);
    return decoded;
  }

  // ---- mutable state --------------------------------------------------------
  let sharedRef: SharedAssets | null = null;
  let layoutRef: LayoutAssets | null = null;
  let calls: TerrainDrawCall[] = [];
  let zRange = 1;
  let view: TerrainView | null = null;
  let lost = false;
  let pixelRatio = 1;

  let bPos: WebGLBuffer | null = null;
  let bNrm: WebGLBuffer | null = null;
  let bIdx: WebGLBuffer | null = null;
  let bIns: WebGLBuffer | null = null;
  let bHfIdx: WebGLBuffer | null = null;
  let hfIndexCount = 0;
  let texHf: WebGLTexture | null = null;
  let det1: WebGLTexture | null = null;
  let det2: WebGLTexture | null = null;
  let texBrk: WebGLTexture | null = null;

  let fbo: WebGLFramebuffer | null = null;
  let accTex: WebGLTexture | null = null;
  let accDepth: WebGLRenderbuffer | null = null;
  let fbW = 0;
  let fbH = 0;

  const onLost = (event: Event) => {
    // Without preventDefault the context can never be restored; we still report
    // it so the panel can fall back rather than show a blank canvas.
    event.preventDefault();
    lost = true;
    options.onContextLost?.();
  };
  canvas.addEventListener("webglcontextlost", onLost as EventListener);

  function upload(target: number, data: Uint8Array): WebGLBuffer {
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return buffer;
  }

  function ensureFramebuffer(width: number, height: number) {
    if (fbo && fbW === width && fbH === height) return;
    if (fbo) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(accTex);
      gl.deleteRenderbuffer(accDepth);
    }
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    accTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, accTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, floatBuffer ? gl.RGBA16F : gl.RGBA8, width, height, 0, gl.RGBA,
      floatBuffer ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, accTex, 0);
    accDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, accDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, accDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fbW = width;
    fbH = height;
  }

  function setAssets(shared: SharedAssets, layout: LayoutAssets) {
    if (lost) return;
    // Geometry and the sand textures are shared by all 12 layouts: only re-upload
    // them when the shared set itself changes, so a Coriolis reset costs one
    // instance buffer and one height field rather than 6 MB of re-upload.
    if (sharedRef !== shared) {
      const { library, geometry } = shared;
      const nrmAt = library.posBytes;
      const idxAt = nrmAt + library.nrmBytes;
      if (bPos) gl.deleteBuffer(bPos);
      if (bNrm) gl.deleteBuffer(bNrm);
      if (bIdx) gl.deleteBuffer(bIdx);
      bPos = upload(gl.ARRAY_BUFFER, geometry.subarray(0, nrmAt));
      bNrm = upload(gl.ARRAY_BUFFER, geometry.subarray(nrmAt, idxAt));
      bIdx = upload(gl.ELEMENT_ARRAY_BUFFER, geometry.subarray(idxAt));
      if (det1) gl.deleteTexture(det1);
      if (det2) gl.deleteTexture(det2);
      if (texBrk) gl.deleteTexture(texBrk);
      det1 = decodeToMipped(shared.detail1, 1024);
      det2 = decodeToMipped(shared.detail2, 1024);
      texBrk = decodeToMipped(shared.breakup, 128);
      sharedRef = shared;
    }

    if (layoutRef !== layout) {
      if (bIns) gl.deleteBuffer(bIns);
      bIns = upload(gl.ARRAY_BUFFER, layout.instances);

      const meta = layout.meta;
      if (texHf) gl.deleteTexture(texHf);
      texHf = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texHf);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, meta.hfN, meta.hfN, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT,
        new Uint16Array(layout.heightField.buffer, layout.heightField.byteOffset, layout.heightField.byteLength / 2));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // The grid's indices are generated rather than shipped: 6 MB of payload
      // for something a loop reproduces exactly.
      const n = meta.hfN;
      const indices = new Uint32Array((n - 1) * (n - 1) * 6);
      let k = 0;
      for (let y = 0; y < n - 1; y++) {
        for (let x = 0; x < n - 1; x++) {
          const a = y * n + x;
          const c = a + n;
          indices[k++] = a; indices[k++] = a + 1; indices[k++] = c;
          indices[k++] = a + 1; indices[k++] = c + 1; indices[k++] = c;
        }
      }
      if (bHfIdx) gl.deleteBuffer(bHfIdx);
      bHfIdx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bHfIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      hfIndexCount = indices.length;
      layoutRef = layout;
    }

    calls = buildDrawCalls(shared.library, layout.meta);
    zRange = depthRange(layout.meta);
  }

  function drawHeightField() {
    // Drawn from gl_VertexID alone. Disabling the mesh loop's arrays is not
    // enough: location 0 is an integer attribute, and a disabled integer
    // attribute whose generic value was never set with vertexAttribI4ui makes
    // the whole draw INVALID_OPERATION under ANGLE.
    for (let k = 0; k < 8; k++) {
      gl.disableVertexAttribArray(k);
      gl.vertexAttribDivisor(k, 0);
    }
    gl.vertexAttribI4ui(0, 0, 0, 0, 0);
    gl.uniform1f(t.hfMode, 1);
    gl.uniform1f(t.feather, 0);
    gl.uniform1f(t.wScale, 1);
    gl.uniform1f(t.bias, 0);
    gl.uniform1f(t.lift, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bHfIdx);
    gl.drawElements(gl.TRIANGLES, hfIndexCount, gl.UNSIGNED_INT, 0);
    gl.uniform1f(t.hfMode, 0);
  }

  function drawGeometry() {
    drawHeightField();
    for (const call of calls) {
      gl.uniform3f(t.lo, call.lo[0], call.lo[1], call.lo[2]);
      gl.uniform3f(t.ext, call.ext[0], call.ext[1], call.ext[2]);
      gl.uniform1f(t.feather, call.land ? FEATHER : 0);
      gl.uniform1f(t.wScale, call.land ? 1 : call.overlay ? 64 : rockWeight);
      gl.uniform1f(t.lift, LIFTON);
      gl.uniform1f(t.bias, call.overlay ? -OVERLAY / zRange : 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, bPos);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribDivisor(0, 0);
      gl.vertexAttribIPointer(0, 3, gl.UNSIGNED_SHORT, 6, call.vo * 6);
      gl.bindBuffer(gl.ARRAY_BUFFER, bNrm);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribDivisor(1, 0);
      gl.vertexAttribPointer(1, 2, gl.BYTE, true, 2, call.vo * 2);

      gl.bindBuffer(gl.ARRAY_BUFFER, bIns);
      const base = call.instOff * INSTANCE_STRIDE;
      for (let k = 0; k < 6; k++) {
        const location = k < 5 ? 2 + k : 7;
        const size = k >= 4 ? 1 : 3;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, INSTANCE_STRIDE, base + INSTANCE_OFFSETS[k]);
        gl.vertexAttribDivisor(location, 1);
      }

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
      gl.drawElementsInstanced(gl.TRIANGLES, call.ic, gl.UNSIGNED_SHORT, call.io * 2, call.instN);
    }
  }

  function draw() {
    if (lost || !view || !layoutRef || !sharedRef || !calls.length) return;
    const meta = layoutRef.meta;
    const width = canvas.width;
    const height = canvas.height;
    if (!width || !height) return;

    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    // Supersample when the device pixel ratio is low, so effective sampling
    // stays roughly constant across displays. Dropped back to 1 rather than
    // failing if the supersampled target would exceed MAX_TEXTURE_SIZE.
    let ss = pixelRatio >= 2 ? 1 : 2;
    while (ss > 1 && (width * ss > maxTexture || height * ss > maxTexture)) ss--;
    const fw = width * ss;
    const fh = height * ss;
    ensureFramebuffer(fw, fh);

    const m = orthoFromWorldRect(view, zRange);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, fw, fh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(terrain);
    gl.uniformMatrix4fv(t.vp, false, m);
    gl.uniform3f(t.light, SUN[0], SUN[1], SUN[2]);
    gl.uniform1f(t.zlo, meta.zmin);
    gl.uniform1f(t.zhi, meta.zmin + (meta.zmax - meta.zmin) * 0.35);
    gl.uniform2f(t.c, meta.cx, meta.cy);
    gl.uniform1f(t.half, meta.half);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, det1);
    gl.uniform1i(t.d1, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, det2);
    gl.uniform1i(t.d2, 2);
    gl.uniform1f(t.tile, TILE);
    gl.uniform1f(t.detStr, DETSTR);
    // Straight down: the Live Map is not tiltable.
    gl.uniform3f(t.view, 0, 0, 1);
    gl.uniform1f(t.detail, det1 && det2 ? 1 : 0);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, texHf);
    gl.uniform1i(t.hf, 6);
    gl.uniform1f(t.hn, meta.hfN);
    gl.uniform1f(t.hStep, meta.hfStep);
    gl.uniform1f(t.hx0, meta.hfX0);
    gl.uniform1f(t.hy0, meta.hfY0);
    gl.uniform1f(t.hzlo, meta.hfZlo);
    gl.uniform1f(t.hzhi, meta.hfZhi);
    gl.uniform1f(t.patchCut, PATCHCUT);
    gl.uniform1f(t.patchFeather, PATCHFEATHER);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, texBrk);
    gl.uniform1i(t.brk, 7);
    gl.uniform1f(t.brkTile, BRKTILE);
    gl.uniform1f(t.brkAmp, texBrk ? BRKAMP : 0);
    gl.uniform1f(t.clipRaise, CLIPRAISE);
    gl.uniform3f(t.patchCol, PATCHCOL[0], PATCHCOL[1], PATCHCOL[2]);
    gl.uniform3f(t.poiCol, POICOL[0], POICOL[1], POICOL[2]);
    gl.uniform1f(t.hfMode, 0);
    gl.enable(gl.DEPTH_TEST);

    // Pass 1: depth only. Establishes what is in front before anything blends.
    gl.colorMask(false, false, false, false);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.uniform1f(t.prepass, 1);
    drawGeometry();

    // Pass 2: colour, additive, no depth writes. Order-independent, so the
    // result does not depend on which tile happens to be drawn first.
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1f(t.prepass, 0);
    drawGeometry();

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    for (let k = 0; k < 8; k++) {
      gl.disableVertexAttribArray(k);
      gl.vertexAttribDivisor(k, 0);
    }

    // Backdrop to the screen, then the resolved terrain composited over it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(VOID_COLOUR[0], VOID_COLOUR[1], VOID_COLOUR[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribDivisor(0, 0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);

    gl.useProgram(backdrop);
    gl.uniformMatrix4fv(b.vp, false, m);
    gl.uniform2f(b.c, meta.cx, meta.cy);
    gl.uniform1f(b.half, meta.half);
    gl.uniform1f(b.z, meta.floorZ);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(resolve);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, accTex);
    gl.uniform1i(r.tex, 0);
    gl.uniform2f(r.texel, 1 / fw, 1 / fh);
    gl.uniform1f(r.ss, ss);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(0);
    gl.enable(gl.DEPTH_TEST);
  }

  return {
    get ready() {
      return !lost && calls.length > 0;
    },
    setAssets,
    resize(cssWidth: number, cssHeight: number, dpr: number) {
      pixelRatio = Math.min(dpr || 1, 2);
      applyCanvasSize(canvas, cssWidth, cssHeight, dpr);
    },
    setView(next: TerrainView) {
      view = next;
    },
    draw,
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost as EventListener);
      for (const buffer of [bPos, bNrm, bIdx, bIns, bHfIdx, quad]) if (buffer) gl.deleteBuffer(buffer);
      for (const texture of [texHf, det1, det2, texBrk, accTex]) if (texture) gl.deleteTexture(texture);
      if (accDepth) gl.deleteRenderbuffer(accDepth);
      if (fbo) gl.deleteFramebuffer(fbo);
      for (const program of [terrain, resolve, backdrop, decode]) gl.deleteProgram(program);
      calls = [];
      sharedRef = null;
      layoutRef = null;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  };
}
