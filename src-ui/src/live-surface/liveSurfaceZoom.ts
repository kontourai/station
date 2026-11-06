/**
 * Viewer-side zoom for a live surface (pinch on touch). It is a view of the
 * picture, never input: nothing here reaches the remote page.
 *
 * The zoom is a CSS `translate(x, y) scale(s)` with `transform-origin: 0 0`
 * on the layer that holds the canvas. A browser reports a transformed
 * element's `getBoundingClientRect()` already scaled and moved, so the
 * pointer mapping (`mapClientPointToSurface`) needs no zoom term: a tap on
 * the zoomed picture maps to the surface pixel drawn under the finger.
 *
 * Coordinates are stage-local CSS pixels (the stage is the untransformed box
 * the zoom layer fills).
 */

export interface SurfaceZoom {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface ZoomPoint {
  readonly x: number;
  readonly y: number;
}

export const SURFACE_ZOOM_FIT: SurfaceZoom = { scale: 1, x: 0, y: 0 };
export const SURFACE_ZOOM_MAX = 5;
/** A pinch that ends this close to fit snaps back to it. */
const SNAP_TO_FIT = 1.05;

/**
 * Keep the zoomed picture covering the stage: no zooming out past fit, and
 * no panning an edge of the picture inside the stage.
 */
export function clampSurfaceZoom(
  zoom: SurfaceZoom,
  stage: { readonly width: number; readonly height: number },
): SurfaceZoom {
  const scale = Math.min(Math.max(zoom.scale, 1), SURFACE_ZOOM_MAX);
  if (scale === 1) return SURFACE_ZOOM_FIT;
  const minX = stage.width - stage.width * scale;
  const minY = stage.height - stage.height * scale;
  return {
    scale,
    x: Math.min(0, Math.max(minX, zoom.x)),
    y: Math.min(0, Math.max(minY, zoom.y)),
  };
}

function midpoint(a: ZoomPoint, b: ZoomPoint): ZoomPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: ZoomPoint, b: ZoomPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The zoom after two fingers moved from `from` to `to`, starting at
 * `start`. Scale follows the change in finger spread; the picture point
 * that was under the fingers' midpoint stays under it, so spreading zooms
 * into where the fingers are and moving both fingers pans.
 */
export function pinchSurfaceZoom(
  start: SurfaceZoom,
  from: readonly [ZoomPoint, ZoomPoint],
  to: readonly [ZoomPoint, ZoomPoint],
  stage: { readonly width: number; readonly height: number },
): SurfaceZoom {
  const spread = distance(from[0], from[1]);
  const ratio = spread > 0 ? distance(to[0], to[1]) / spread : 1;
  const scale = Math.min(Math.max(start.scale * ratio, 1), SURFACE_ZOOM_MAX);
  const anchor = midpoint(from[0], from[1]);
  const now = midpoint(to[0], to[1]);
  // The picture point under the starting midpoint, in unzoomed pixels.
  const contentX = (anchor.x - start.x) / start.scale;
  const contentY = (anchor.y - start.y) / start.scale;
  return clampSurfaceZoom(
    { scale, x: now.x - contentX * scale, y: now.y - contentY * scale },
    stage,
  );
}

/**
 * Zoom by `factor` about `anchor` (stage pixels): the picture point under
 * the anchor stays under it. A trackpad pinch, which a browser reports as a
 * Ctrl+wheel.
 */
export function scaleSurfaceZoomAt(
  start: SurfaceZoom,
  anchor: ZoomPoint,
  factor: number,
  stage: { readonly width: number; readonly height: number },
): SurfaceZoom {
  const scale = Math.min(Math.max(start.scale * factor, 1), SURFACE_ZOOM_MAX);
  const contentX = (anchor.x - start.x) / start.scale;
  const contentY = (anchor.y - start.y) / start.scale;
  return clampSurfaceZoom(
    { scale, x: anchor.x - contentX * scale, y: anchor.y - contentY * scale },
    stage,
  );
}

/** Where a pinch settles when the fingers lift: close to fit means fit. */
export function settleSurfaceZoom(zoom: SurfaceZoom): SurfaceZoom {
  return zoom.scale < SNAP_TO_FIT ? SURFACE_ZOOM_FIT : zoom;
}

export function surfaceZoomTransform(zoom: SurfaceZoom): string | undefined {
  if (zoom.scale === 1 && zoom.x === 0 && zoom.y === 0) return undefined;
  return `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}
