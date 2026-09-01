import { render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMapConfig } from "../../../api/liveMap";
import DeepDesertTerrain from "./DeepDesertTerrain";

// The assets are 15 MB of binary behind fetch; the component's job is lifecycle,
// not loading, so the loader is stubbed out.
vi.mock("./terrainAssets", () => ({
  loadSharedAssets: vi.fn(async () => ({ library: { meshes: [] } })),
  loadLayoutAssets: vi.fn(async (layout: number) => ({ meta: { layout } }))
}));

const CONFIG: LiveMapConfig = {
  key: "DeepDesert", label: "The Deep Desert", actorMap: "DeepDesert",
  image: "/images/maps/deep-desert.png", width: 4096, height: 4096,
  minX: -1268624.82, maxX: 1163312.83, minY: -1266548.17, maxY: 1162416.13,
  flipY: false, defaultPartitionId: 8
};

function fakeRenderer() {
  return {
    ready: true,
    setAssets: vi.fn(),
    resize: vi.fn(),
    setView: vi.fn(),
    draw: vi.fn(),
    dispose: vi.fn()
  };
}

function mount(overrides: Record<string, unknown> = {}) {
  const renderer = fakeRenderer();
  const onUnavailable = vi.fn();
  const lost: Array<() => void> = [];
  const createRenderer = vi.fn((_canvas, options) => {
    if (options?.onContextLost) lost.push(options.onContextLost);
    return renderer as never;
  });
  const frame = document.createElement("div");
  Object.defineProperty(frame, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(frame, "clientHeight", { value: 600, configurable: true });
  document.body.appendChild(frame);
  const frameRef = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
  frameRef.current = frame;
  const view = render(
    <DeepDesertTerrain
      config={CONFIG}
      layout={3}
      zoom={0.25}
      frameRef={frameRef}
      onUnavailable={onUnavailable}
      createRenderer={createRenderer as never}
      probeSupport={() => ({ supported: true })}
      {...overrides}
    />
  );
  return { renderer, onUnavailable, createRenderer, frame, frameRef, view, lost };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("DeepDesertTerrain", () => {
  it("creates one context and loads the layout", async () => {
    const { createRenderer, renderer } = mount();
    expect(createRenderer).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(renderer.setAssets).toHaveBeenCalledTimes(1));
  });

  it("draws the world rect the panel is showing, not the whole map", async () => {
    const { renderer } = mount();
    await waitFor(() => expect(renderer.setView).toHaveBeenCalled());
    const rect = renderer.setView.mock.calls.at(-1)![0] as { minX: number; maxX: number };
    // 800px of an 800px-tall frame at zoom 0.25 shows less than the full width.
    expect(rect.maxX - rect.minX).toBeLessThan(CONFIG.maxX - CONFIG.minX);
    expect(renderer.draw).toHaveBeenCalled();
  });

  it("sizes the canvas to the frame, never to the scaled map", async () => {
    // At max zoom the map is 16384px, past MAX_TEXTURE_SIZE on many GPUs.
    const { renderer } = mount({ zoom: 4 });
    await waitFor(() => expect(renderer.resize).toHaveBeenCalled());
    const [w, h] = renderer.resize.mock.calls.at(-1)!;
    expect(w).toBe(800);
    expect(h).toBe(600);
  });

  it("follows the scrollport so it stays under the markers", async () => {
    const { renderer, frame } = mount();
    await waitFor(() => expect(renderer.setView).toHaveBeenCalled());
    const before = renderer.setView.mock.calls.length;
    // In range on purpose: at zoom 0.25 the map is 1024px against an 800x600
    // frame, so scrollLeft can only reach 224. Asking for more is not a pan, it
    // is an out-of-range offset, and the canvas deliberately clamps it.
    frame.scrollLeft = 200;
    frame.scrollTop = 150;
    frame.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(renderer.setView.mock.calls.length).toBeGreaterThan(before));
    const canvas = document.querySelector("canvas.live-map-terrain") as HTMLCanvasElement;
    expect(canvas.style.transform).toBe("translate(200px, 150px)");
  });

  it("reloads on a layout change, as a Coriolis reset would cause", async () => {
    const { renderer, view, frameRef, onUnavailable, createRenderer } = mount();
    await waitFor(() => expect(renderer.setAssets).toHaveBeenCalledTimes(1));
    view.rerender(
      <DeepDesertTerrain config={CONFIG} layout={7} zoom={0.25} frameRef={frameRef}
        onUnavailable={onUnavailable} createRenderer={createRenderer as never} probeSupport={() => ({ supported: true })} />
    );
    await waitFor(() => expect(renderer.setAssets).toHaveBeenCalledTimes(2));
    // The context is not rebuilt just because the layout moved.
    expect(createRenderer).toHaveBeenCalledTimes(1);
  });

  it("releases the context on unmount", async () => {
    const { renderer, view } = mount();
    await waitFor(() => expect(renderer.setAssets).toHaveBeenCalled());
    view.unmount();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("falls back when the browser cannot support it, without creating a context", () => {
    const { onUnavailable, createRenderer } = mount({
      probeSupport: () => ({ supported: false, reason: "no BC7" })
    });
    expect(onUnavailable).toHaveBeenCalledWith("no BC7");
    expect(createRenderer).not.toHaveBeenCalled();
  });

  it("falls back when creating the context throws", () => {
    const { onUnavailable } = mount({
      createRenderer: () => { throw new Error("WebGL2 is not available"); }
    });
    expect(onUnavailable).toHaveBeenCalledWith("WebGL2 is not available");
  });

  it("falls back when the context is lost after a successful start", async () => {
    const { onUnavailable, lost, renderer } = mount();
    await waitFor(() => expect(renderer.setAssets).toHaveBeenCalled());
    expect(onUnavailable).not.toHaveBeenCalled();
    lost[0]();
    expect(onUnavailable).toHaveBeenCalledWith("graphics context lost");
  });

  it("is unsupported under jsdom by default, which is the honest headless answer", () => {
    const onUnavailable = vi.fn();
    const frameRef = { current: document.createElement("div") };
    render(<DeepDesertTerrain config={CONFIG} layout={3} zoom={0.25} frameRef={frameRef} onUnavailable={onUnavailable} />);
    expect(onUnavailable).toHaveBeenCalled();
  });
});

describe("scroll-area integrity", () => {
  // A transform on the terrain canvas counts toward the frame's scrollable
  // width. Translating by an out-of-range scrollLeft therefore inflates the
  // scroll area and legitimises that offset, leaving the map stuck off-centre
  // when you zoom back out to the fit. Reproduced live as a timing-dependent
  // race before this clamp existed.
  it("never translates the canvas past the map's own extent", async () => {
    const { renderer, frame } = mount({ zoom: 0.22 });
    await waitFor(() => expect(renderer.setView).toHaveBeenCalled());
    const mapWidth = Math.floor(4096 * 0.22); // 901, barely over the 800px frame
    // an out-of-range scroll, as an inflated scroll area would permit
    frame.scrollLeft = 5000;
    frame.scrollTop = 5000;
    frame.dispatchEvent(new Event("scroll"));
    await waitFor(() => {
      const canvas = document.querySelector("canvas.live-map-terrain") as HTMLCanvasElement;
      const match = /translate\((\d+(?:\.\d+)?)px, (\d+(?:\.\d+)?)px\)/.exec(canvas.style.transform);
      expect(match).toBeTruthy();
      expect(Number(match![1])).toBeLessThanOrEqual(mapWidth - 800);
    });
  });

  // The horizontal clamp was covered; the vertical one was not, and a frame is
  // rarely square, so the two axes carry different limits and have to be
  // asserted apart. Removing either clamp used to leave the suite green.
  it("clamps the vertical offset independently of the horizontal one", async () => {
    const { renderer, frame } = mount({ zoom: 0.22 });
    await waitFor(() => expect(renderer.setView).toHaveBeenCalled());
    // 4096 * 0.22 = 901 both ways, against an 800x600 frame: 101px of scroll
    // range across, 301px down. A shared limit would satisfy neither.
    frame.scrollLeft = 5000;
    frame.scrollTop = 5000;
    frame.dispatchEvent(new Event("scroll"));
    await waitFor(() => {
      const canvas = document.querySelector("canvas.live-map-terrain") as HTMLCanvasElement;
      expect(canvas.style.transform).toBe("translate(101px, 301px)");
    });
  });

  it("sizes the canvas to the map, not the frame, when the map is the smaller of the two", async () => {
    // Zoomed out past the fit the map no longer fills the frame, and a canvas
    // covering the whole frame would paint terrain over the surrounding page.
    const { renderer } = mount({ zoom: 0.1 });
    await waitFor(() => expect(renderer.resize).toHaveBeenCalled());
    const [width, height] = renderer.resize.mock.calls.at(-1)!;
    expect(width).toBe(409); // floor(4096 * 0.1), under the 800px frame
    expect(height).toBe(409); // and under the 600px frame
  });

  it("keeps the canvas at the origin when the map exactly fills the frame", async () => {
    // At the fit there is no scroll range, so any translation is wrong.
    const { renderer, frame } = mount({ zoom: 800 / 4096 });
    await waitFor(() => expect(renderer.setView).toHaveBeenCalled());
    frame.scrollLeft = 300;
    frame.dispatchEvent(new Event("scroll"));
    await waitFor(() => {
      const canvas = document.querySelector("canvas.live-map-terrain") as HTMLCanvasElement;
      expect(canvas.style.transform).toBe("translate(0px, 0px)");
    });
  });
});
