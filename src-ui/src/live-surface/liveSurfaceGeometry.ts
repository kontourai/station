/**
 * Pointer mapping for a live surface drawn with `object-fit: contain` (#90).
 *
 * Three coordinate spaces:
 * - client CSS pixels: where the pointer is on THIS page;
 * - image pixels: the encoded frame (`header.width` x `header.height`),
 *   letterboxed and scaled into the canvas element's box;
 * - surface pixels: what input addresses — the surface's own layout (CSS)
 *   pixels. `header.deviceScaleFactor` is image pixels per surface pixel, so
 *   a 2x frame of a 640-wide page is 1280 image pixels and clicks land in
 *   0..640.
 *
 * The viewer's own `window.devicePixelRatio` is deliberately absent: pointer
 * events and `getBoundingClientRect` are both in client CSS pixels already.
 */

export interface LiveSurfaceFrameGeometry {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface LiveSurfaceBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LiveSurfacePoint {
  x: number;
  y: number;
}

/** Where the image is drawn inside the element box (letterboxed, centred). */
export function containRect(
  box: LiveSurfaceBox,
  frame: Pick<LiveSurfaceFrameGeometry, 'width' | 'height'>,
): LiveSurfaceBox & { scale: number } {
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return {
    scale,
    width,
    height,
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
  };
}

/**
 * Map a client point to surface pixels, or null when it falls in the
 * letterbox bars (outside the drawn image) — a click there hits nothing.
 */
export function mapClientPointToSurface(
  client: LiveSurfacePoint,
  box: LiveSurfaceBox,
  frame: LiveSurfaceFrameGeometry,
): LiveSurfacePoint | null {
  if (
    box.width <= 0 ||
    box.height <= 0 ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    frame.deviceScaleFactor <= 0
  )
    return null;
  const drawn = containRect(box, frame);
  const imageX = (client.x - drawn.left) / drawn.scale;
  const imageY = (client.y - drawn.top) / drawn.scale;
  if (
    imageX < 0 ||
    imageY < 0 ||
    imageX >= frame.width ||
    imageY >= frame.height
  )
    return null;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    x: round(imageX / frame.deviceScaleFactor),
    y: round(imageY / frame.deviceScaleFactor),
  };
}
