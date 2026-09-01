import { describe, expect, it } from "vitest";
import { probeTerrainSupport } from "./terrainSupport";

// A fake canvas is enough: the probe only ever asks for a context and two
// extensions. jsdom's real canvas returns null from getContext("webgl2"), which
// is itself one of the cases under test.
function fakeCanvas(options: { webgl2?: boolean; bptc?: boolean; throwOnContext?: boolean } = {}) {
  const { webgl2 = true, bptc = true, throwOnContext = false } = options;
  const asked: string[] = [];
  const gl = {
    getExtension(name: string) {
      asked.push(name);
      if (name === "EXT_texture_compression_bptc") return bptc ? {} : null;
      if (name === "WEBGL_lose_context") return { loseContext() {} };
      return {};
    }
  };
  return {
    asked,
    canvas: {
      getContext(kind: string) {
        if (throwOnContext) throw new Error("context creation blocked");
        return kind === "webgl2" && webgl2 ? gl : null;
      }
    } as unknown as HTMLCanvasElement
  };
}

describe("probeTerrainSupport", () => {
  it("passes when the browser has everything", () => {
    const { canvas } = fakeCanvas();
    expect(probeTerrainSupport({ createCanvas: () => canvas, hasDecompressionStream: () => true })).toEqual({ supported: true });
  });

  it("reports missing DecompressionStream, and does not bother touching the GPU", () => {
    const { canvas, asked } = fakeCanvas();
    const result = probeTerrainSupport({ createCanvas: () => canvas, hasDecompressionStream: () => false });
    expect(result).toEqual({ supported: false, reason: expect.stringContaining("DecompressionStream") });
    expect(asked).toEqual([]);
  });

  it("reports missing WebGL2", () => {
    const { canvas } = fakeCanvas({ webgl2: false });
    const result = probeTerrainSupport({ createCanvas: () => canvas, hasDecompressionStream: () => true });
    expect(result).toEqual({ supported: false, reason: expect.stringContaining("WebGL2") });
  });

  it("reports missing BC7 rather than drawing untextured sand", () => {
    const { canvas } = fakeCanvas({ bptc: false });
    const result = probeTerrainSupport({ createCanvas: () => canvas, hasDecompressionStream: () => true });
    expect(result).toEqual({ supported: false, reason: expect.stringContaining("BC7") });
  });

  it("treats a browser that refuses to create a context as unsupported, not as a crash", () => {
    const { canvas } = fakeCanvas({ throwOnContext: true });
    const result = probeTerrainSupport({ createCanvas: () => canvas, hasDecompressionStream: () => true });
    expect(result).toEqual({ supported: false, reason: expect.stringContaining("WebGL2") });
  });

  it("releases the probe context, which is one of a small pool the browser hands out", () => {
    const { canvas, asked } = fakeCanvas();
    probeTerrainSupport({ createCanvas: () => canvas, hasDecompressionStream: () => true });
    expect(asked).toContain("WEBGL_lose_context");
  });

  it("releases the probe context even when the GPU check fails", () => {
    const { canvas, asked } = fakeCanvas({ bptc: false });
    probeTerrainSupport({ createCanvas: () => canvas, hasDecompressionStream: () => true });
    expect(asked).toContain("WEBGL_lose_context");
  });

  it("is unsupported under jsdom, which is the honest default for a headless browser", () => {
    expect(probeTerrainSupport({ hasDecompressionStream: () => true }).supported).toBe(false);
  });

  // These strings are shown verbatim in the Live Map's Overview strip, a narrow
  // grid cell. Written as sentences they wrapped to five lines and doubled the
  // strip's height, so they have to stay phrase-length.
  it("gives reasons short enough for the readout that displays them", () => {
    const reasons = [
      probeTerrainSupport({ hasDecompressionStream: () => false }),
      probeTerrainSupport({ hasDecompressionStream: () => true }),
      probeTerrainSupport({ createCanvas: () => fakeCanvas({ bptc: false }).canvas, hasDecompressionStream: () => true })
    ].map((support) => (support.supported ? "" : support.reason));

    for (const reason of reasons) {
      expect(reason.length).toBeGreaterThan(0);
      expect(reason.length).toBeLessThanOrEqual(28);
      // A phrase, not a sentence: no full stop to run into the next word.
      expect(reason.endsWith(".")).toBe(false);
    }
  });
});
