import { describe, expect, test } from 'vitest';
import {
  axRectOnShownFrame,
  type DeviceFrameRotation,
  rotateUnitRect,
} from '../deviceAxGeometry';

/**
 * #1971: lining the accessibility tree up with a (possibly turned) device
 * screen. The expected rects are derived from `LiveSurfaceCanvas`'s own
 * drawing transform for each rotation, not from this module.
 */

const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
const PORTRAIT = { width: 400, height: 800 };
const LANDSCAPE = { width: 800, height: 400 };

/**
 * Where the canvas draws raw unit point (u, v) for each turn (the
 * translate+rotate in LiveSurfaceCanvas.draw, normalised to the shown box).
 */
function drawn(u: number, v: number, rotation: DeviceFrameRotation) {
  switch (rotation) {
    case 90:
      return { x: 1 - v, y: u };
    case 180:
      return { x: 1 - u, y: 1 - v };
    case 270:
      return { x: v, y: 1 - u };
    default:
      return { x: u, y: v };
  }
}

function close(a: number, b: number) {
  expect(a).toBeCloseTo(b, 9);
}

describe('rotateUnitRect matches the canvas drawing transform', () => {
  test.each([0, 90, 180, 270] as const)('rotation %i', (rotation) => {
    const out = rotateUnitRect(RECT, rotation);
    // Both corners of the raw rect land on corners of the turned rect.
    const corners = [
      drawn(RECT.x, RECT.y, rotation),
      drawn(RECT.x + RECT.width, RECT.y + RECT.height, rotation),
    ];
    close(out.x, Math.min(corners[0]!.x, corners[1]!.x));
    close(out.y, Math.min(corners[0]!.y, corners[1]!.y));
    close(out.x + out.width, Math.max(corners[0]!.x, corners[1]!.x));
    close(out.y + out.height, Math.max(corners[0]!.y, corners[1]!.y));
  });
});

describe('axRectOnShownFrame', () => {
  test('unturned: the tree maps straight onto the frame', () => {
    expect(axRectOnShownFrame(RECT, PORTRAIT, PORTRAIT, 0)).toEqual(RECT);
  });

  test('a quarter turn with the tree in the RAW orientation turns each rect', () => {
    // Raw portrait tree, frame shown landscape after a 90° turn.
    expect(axRectOnShownFrame(RECT, PORTRAIT, LANDSCAPE, 90)).toEqual(
      rotateUnitRect(RECT, 90),
    );
    expect(axRectOnShownFrame(RECT, PORTRAIT, LANDSCAPE, 270)).toEqual(
      rotateUnitRect(RECT, 270),
    );
  });

  test('a quarter turn with the tree already in the SHOWN orientation is left alone', () => {
    expect(axRectOnShownFrame(RECT, LANDSCAPE, LANDSCAPE, 90)).toEqual(RECT);
  });

  test('a half turn is treated as interface coordinates (no aspect to tell by)', () => {
    expect(axRectOnShownFrame(RECT, PORTRAIT, PORTRAIT, 180)).toEqual(RECT);
  });
});
