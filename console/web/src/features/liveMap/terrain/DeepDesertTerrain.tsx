import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveMapConfig } from "../../../api/liveMap";
import { liveMapCamera, terrainViewport, visibleWorldRect } from "../liveMapGeometry";
import { SECTOR_GRID } from "../liveMapSectorGrid";
import { createDeepDesertRenderer, type DeepDesertRenderer } from "./renderer";
import { joinShared, loadLayoutAssets, loadSharedAssets } from "./terrainAssets";
import { interpolateHeightField } from "./terrainGeometry";
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
  /** Faint elevation banding on rock and sand, so height reads from overhead. */
  elevationLines?: boolean;
  /** The sector grid, drawn on the terrain while tilted or turned. Flat, the panel draws it. */
  sectorGrid?: boolean;
  /** Lean back from top-down, radians. With `yaw`, non-zero draws through the 3D camera. */
  tilt?: number;
  /** Rotation about the vertical, radians. */
  yaw?: number;
  /** Handed the `TerrainApi` once a layout is drawing, and null when it is not. */
  onTerrainApi?: (api: TerrainApi | null) => void;
  /** Called when what the terrain hides has been re-measured. */
  onOcclusion?: () => void;
  /** Test seams, mirroring how the API side injects its runners. */
  createRenderer?: typeof createDeepDesertRenderer;
  probeSupport?: typeof probeTerrainSupport;
  /** Fired once the assets are in and the first frame can be drawn. */
  onReady?: () => void;
};

/** What the panel needs from the terrain to work in 3D, bound to the layout that is drawing. */
export type TerrainApi = {
  /** The world point drawn at a canvas pixel (CSS px), from the GPU; null where nothing is drawn or picking is unsupported. */
  pick: (sx: number, sy: number) => { x: number; y: number; z: number } | null;
  /** Sand height at a world point -- for markers that carry no height of their own. */
  heightAt: (x: number, y: number) => number;
  /** The height the 3D camera pivots about: the layout's mean sand height. */
  pivotZ: number;
  /** The top of the tallest thing in the layout, which the 3D camera's eye stays above. */
  topZ: number;
  /** Whether the terrain hides a world point, as of a frame just drawn. Only ever true while tilted. */
  occluded: (x: number, y: number, z: number) => boolean;
};

export default function DeepDesertTerrain({
  config,
  layout,
  zoom,
  frameRef,
  onUnavailable,
  elevationLines = false,
  sectorGrid = false,
  tilt = 0,
  yaw = 0,
  onTerrainApi,
  onOcclusion,
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
  const callbacks = useRef({ onUnavailable, onReady, createRenderer, probeSupport, onTerrainApi, onOcclusion });
  callbacks.current = { onUnavailable, onReady, createRenderer, probeSupport, onTerrainApi, onOcclusion };
  // The layout's pivot height, kept for the paint loop.
  const pivotRef = useRef(0);
  // ...and the height of its tallest rock, which the camera's eye is kept above.
  const topRef = useRef(0);

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
        onContextLost: () => callbacks.current.onUnavailable("graphics context lost"),
        onOcclusion: () => callbacks.current.onOcclusion?.()
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
        const full = joinShared(shared, assets);
        renderer.setAssets(shared, full);
        // The pivot stays the mean of the map's own sand, not of the ring round it.
        const inside = new Uint16Array(assets.heightField.buffer, assets.heightField.byteOffset, assets.heightField.byteLength / 2);
        let sum = 0;
        for (let i = 0; i < inside.length; i++) sum += inside[i];
        const meta = full.meta;
        const field = new Uint16Array(full.heightField.buffer);
        pivotRef.current = meta.hfZlo + (sum / Math.max(inside.length, 1) / 65535) * (meta.hfZhi - meta.hfZlo);
        topRef.current = meta.zmax;
        callbacks.current.onTerrainApi?.({
          pick: (sx, sy) => rendererRef.current?.pick(sx, sy) ?? null,
          heightAt: (x, y) => interpolateHeightField(field, meta, x, y),
          pivotZ: pivotRef.current,
          topZ: topRef.current,
          occluded: (x, y, z) => rendererRef.current?.occluded(x, y, z) ?? false
        });
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
    return () => {
      controller.abort();
      callbacks.current.onTerrainApi?.(null);
    };
  }, [layout]);

  // Track the frame's scroll and size. The canvas covers the viewport, never the
  // scaled map -- at maximum zoom that would be 16384px, over MAX_TEXTURE_SIZE on
  // plenty of GPUs and about a gigabyte of backing store.
  //
  // Layout effect, not a plain one: a zoom change resizes the map div in the same
  // commit, and a plain effect runs after the browser has had its chance to
  // paint. That left one frame showing terrain at the old size and offset inside
  // an already-resized container, which is what the flicker on zoom was.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!frame || !canvas || !renderer || !ready) return;

    const paint = () => {
      frameCallback.current = 0;
      // Clamped to the map's real extent before translating. A transform on this
      // canvas counts toward the frame's scrollable width, so translating by an
      // out-of-range scrollLeft pushes the canvas past the map's edge, inflates
      // the scroll area, and thereby makes that out-of-range scrollLeft legal --
      // a self-sustaining state where zooming back out leaves the map stuck
      // off-centre instead of returning to the fit. Clamping here keeps the
      // scroll area honest, so the browser corrects the scroll offset itself.
      const { left, top, width, height } = terrainViewport(config, zoom, frame.scrollLeft, frame.scrollTop, frame.clientWidth, frame.clientHeight, tilt !== 0 || yaw !== 0);
      if (width <= 0 || height <= 0) return;
      canvas.style.transform = `translate(${left}px, ${top}px)`;
      renderer.resize(width, height, window.devicePixelRatio || 1);
      if (tilt !== 0 || yaw !== 0) {
        // 3D: the panel builds its camera from the same helper, so markers land on this render.
        const camera = liveMapCamera(config, zoom, { left, top, width, height }, tilt, yaw, pivotRef.current, topRef.current);
        if (!camera) return;
        renderer.setCamera(camera);
      } else {
        const rect = visibleWorldRect(config, zoom, left, top, width, height);
        if (!rect) return;
        renderer.setView(rect);
      }
      renderer.setElevationLines(elevationLines);
      renderer.setSectorGrid(sectorGrid ? SECTOR_GRID : null);
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
  }, [config, zoom, ready, frameRef, elevationLines, sectorGrid, tilt, yaw]);

  return <canvas className="live-map-terrain" ref={canvasRef} aria-hidden="true" />;
}
