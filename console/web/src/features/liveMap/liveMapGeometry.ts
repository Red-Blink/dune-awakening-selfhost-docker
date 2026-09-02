import type { LiveMapConfig, LiveMapMarker } from "../../api/liveMap";

// The Live Map's coordinate maths, extracted from LiveMapPanel so it can be
// tested without rendering a 1300-line component. Behaviour is unchanged; the
// terrain renderer needs the same mapping the markers use, and the two agreeing
// by construction is the whole point.

// 8, not 4: the Deep Desert is drawn from geometry now, so rock holds up at any
// magnification and the limit is the sand. Compared at one spot across 4/6/8/12,
// the dune ripples stay readable to 8 (74 uu/px) and look washed out by 12.
// Hagga Basin still uses a 4096px image, so its own detail runs out sooner --
// this is a ceiling, not a recommendation.
export const MAX_LIVE_MAP_ZOOM = 8;
export const MIN_ZOOM_FIT_FACTOR = 1;

export type LiveMapPoint = { px: number; py: number; inBounds: boolean };

/**
 * How far outside the map rect a marker may sit and still be drawn.
 *
 * The rect is the sector square the image covers, and the world does not stop
 * dead at its edge: measured on a live farm, a player and the ornithopter they
 * were flying sat 4,216 uu past the north edge, and a handful of world markers
 * about 1,100 uu past it. A hard cut drops exactly the marker an admin is most
 * likely to be hunting for. 16 px is about 8,800 uu here -- twice the worst case
 * observed -- and markers are still drawn at their true position, never clamped.
 */
const EDGE_TOLERANCE_PX = 16;

export function worldToLiveMapPoint(marker: Pick<LiveMapMarker, "x" | "y">, config: LiveMapConfig): LiveMapPoint | null {
  const x = Number(marker.x);
  const y = Number(marker.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (config.maxX === config.minX || config.maxY === config.minY) return null;
  const px = ((x - config.minX) / (config.maxX - config.minX)) * config.width;
  let py = ((y - config.minY) / (config.maxY - config.minY)) * config.height;
  if (config.flipY) py = config.height - py;
  return {
    px,
    py,
    inBounds: px >= -EDGE_TOLERANCE_PX && px <= config.width + EDGE_TOLERANCE_PX
      && py >= -EDGE_TOLERANCE_PX && py <= config.height + EDGE_TOLERANCE_PX
  };
}

export function liveMapPixelsToWorld(px: number, py: number, config: LiveMapConfig) {
  if (!Number.isFinite(px) || !Number.isFinite(py) || config.width === 0 || config.height === 0) return null;
  let normalizedY = py / config.height;
  if (config.flipY) normalizedY = 1 - normalizedY;
  return {
    x: config.minX + (px / config.width) * (config.maxX - config.minX),
    y: config.minY + normalizedY * (config.maxY - config.minY)
  };
}

export function liveMapMinimumZoom(config: LiveMapConfig | null | undefined, frame: HTMLElement | null) {
  if (!config || !frame) return 0.16;
  // Math.min, not Math.max -- this needs to be a "contain" fit (the whole
  // map visible, letterboxed on the shorter axis) so the fully-zoomed-out
  // view never overflows the frame and forces a scrollbar. Math.max would
  // "cover" the frame instead, cropping whichever axis has the smaller
  // required ratio.
  const fitRatio = Math.min(frame.clientWidth / config.width, frame.clientHeight / config.height);
  return Math.max(0.02, fitRatio * MIN_ZOOM_FIT_FACTOR);
}

export function clampLiveMapZoom(value: number, minimum = 0.16) {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(MAX_LIVE_MAP_ZOOM, value));
}

/**
 * The world rectangle currently scrolled into view, for the terrain renderer.
 *
 * The panel scrolls a div and scales a canvas element by `zoom`; the renderer
 * has no camera of its own and draws exactly the rect it is given. Deriving that
 * rect through `liveMapPixelsToWorld` -- the same inverse the double-click
 * teleport uses -- is what keeps terrain and markers on the same pixel.
 */
export function visibleWorldRect(
  config: LiveMapConfig,
  zoom: number,
  scrollLeft: number,
  scrollTop: number,
  viewWidth: number,
  viewHeight: number
) {
  const a = liveMapPixelsToWorld(scrollLeft / zoom, scrollTop / zoom, config);
  const b = liveMapPixelsToWorld((scrollLeft + viewWidth) / zoom, (scrollTop + viewHeight) / zoom, config);
  if (!a || !b) return null;
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
    flipY: config.flipY
  };
}
