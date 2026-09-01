import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveMapConfig } from "../../../api/liveMap";
import { visibleWorldRect } from "../liveMapGeometry";
import { createDeepDesertRenderer, type DeepDesertRenderer } from "./renderer";
import { loadLayoutAssets, loadSharedAssets } from "./terrainAssets";
import { probeTerrainSupport } from "./terrainSupport";

/**
 * Draws the Deep Desert's actual cartography meshes behind the Live Map.
 *
 * This replaces only the background image. The panel keeps ownership of pan,
 * zoom, markers and teleport -- all of which are DOM -- and hands this component
 * the world rect currently scrolled into view. Terrain and markers therefore
 * land on the same pixel by construction, which is also what corrects the
 * shipped image's 8.1% mis-scale.
 *
 * Every failure path here is ordinary, not exceptional: the caller renders the
 * flat map image instead. A self-hoster whose browser lacks BC7 should simply
 * see the map they see today.
 */

export type DeepDesertTerrainProps = {
  config: LiveMapConfig;
  layout: number;
  zoom: number;
  frameRef: React.RefObject<HTMLDivElement | null>;
  /** Called when this cannot draw, so the panel can fall back to the image. */
  onUnavailable: (reason: string) => void;
  /** Test seams, mirroring how the API side injects its runners. */
  createRenderer?: typeof createDeepDesertRenderer;
  probeSupport?: typeof probeTerrainSupport;
  /** Fired once the assets are in and the first frame can be drawn. */
  onReady?: () => void;
};

export default function DeepDesertTerrain({
  config,
  layout,
  zoom,
  frameRef,
  onUnavailable,
  onReady,
  createRenderer = createDeepDesertRenderer,
  probeSupport = probeTerrainSupport
}: DeepDesertTerrainProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<DeepDesertRenderer | null>(null);
  const frameCallback = useRef(0);
  const [ready, setReady] = useState(false);

  // Held in refs so creating the context depends on nothing: it must happen once
  // per mount, and a caller passing an inline callback must not be able to tear
  // down and rebuild a WebGL context on every render.
  const callbacks = useRef({ onUnavailable, onReady, createRenderer, probeSupport });
  callbacks.current = { onUnavailable, onReady, createRenderer, probeSupport };

  // Create the context once per mount. The panel unmounts this entirely when the
  // map changes, so teardown is automatic.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { onUnavailable: report, createRenderer: create, probeSupport: probe } = callbacks.current;
    const support = probe();
    if (!support.supported) {
      report(support.reason);
      return;
    }
    let renderer: DeepDesertRenderer;
    try {
      renderer = create(canvas, {
        // The context can be taken away after a successful start -- a GPU reset,
        // a driver update, the browser reclaiming it. Falling back beats leaving
        // a blank canvas on a machine that was working a minute ago.
        onContextLost: () => callbacks.current.onUnavailable("graphics context lost")
      });
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
      return;
    }
    rendererRef.current = renderer;
    return () => {
      rendererRef.current = null;
      renderer.dispose();
    };
  }, []);

  // Load the shared library and this layout. Aborts on unmount or a layout
  // change so a fast switch cannot race two decodes into one renderer.
  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    (async () => {
      try {
        const [shared, assets] = await Promise.all([
          loadSharedAssets(undefined, controller.signal),
          loadLayoutAssets(layout, undefined, controller.signal)
        ]);
        if (controller.signal.aborted) return;
        const renderer = rendererRef.current;
        if (!renderer) return;
        renderer.setAssets(shared, assets);
        setReady(true);
        // The panel holds the flat image up until this point: the canvas is
        // mounted long before it has anything to paint, and dropping the image
        // at mount left a gap with neither.
        callbacks.current.onReady?.();
      } catch (error) {
        if (controller.signal.aborted) return;
        callbacks.current.onUnavailable(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => controller.abort();
  }, [layout]);

  // Track the frame's scroll and size. The canvas covers the viewport, never the
  // scaled map -- at maximum zoom that would be 16384px, over MAX_TEXTURE_SIZE on
  // plenty of GPUs and about a gigabyte of backing store.
  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!frame || !canvas || !renderer || !ready) return;

    const paint = () => {
      frameCallback.current = 0;
      const mapWidth = Math.floor(config.width * zoom);
      const mapHeight = Math.floor(config.height * zoom);
      const width = Math.min(frame.clientWidth, mapWidth);
      const height = Math.min(frame.clientHeight, mapHeight);
      if (width <= 0 || height <= 0) return;
      // Clamp to the map's real extent before translating. A transform on this
      // canvas counts toward the frame's scrollable width, so translating by an
      // out-of-range scrollLeft pushes the canvas past the map's edge, inflates
      // the scroll area, and thereby makes that out-of-range scrollLeft legal --
      // a self-sustaining state where zooming back out leaves the map stuck
      // off-centre instead of returning to the fit. Clamping here keeps the
      // scroll area honest, so the browser corrects the scroll offset itself.
      const left = Math.min(Math.max(frame.scrollLeft, 0), Math.max(0, mapWidth - width));
      const top = Math.min(Math.max(frame.scrollTop, 0), Math.max(0, mapHeight - height));
      canvas.style.transform = `translate(${left}px, ${top}px)`;
      renderer.resize(width, height, window.devicePixelRatio || 1);
      const rect = visibleWorldRect(config, zoom, left, top, width, height);
      if (!rect) return;
      renderer.setView(rect);
      renderer.draw();
    };
    const schedule = () => {
      if (frameCallback.current) return;
      frameCallback.current = requestAnimationFrame(paint);
    };

    paint();
    frame.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(frame);
    return () => {
      frame.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frameCallback.current) cancelAnimationFrame(frameCallback.current);
      frameCallback.current = 0;
    };
  }, [config, zoom, ready, frameRef]);

  return <canvas className="live-map-terrain" ref={canvasRef} aria-hidden="true" />;
}
