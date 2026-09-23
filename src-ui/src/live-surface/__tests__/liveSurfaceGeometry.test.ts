import { describe, expect, test } from 'vitest';
import { mapClientPointToSurface } from '../liveSurfaceGeometry';

describe('live surface pointer mapping', () => {
  // A 2x frame of a 640x400 page is 1280x800 image pixels.
  const frame = { width: 1280, height: 800, deviceScaleFactor: 2 };

  test('divides out the frame deviceScaleFactor so input lands in page pixels', () => {
    // The element box has the frame's exact aspect: no letterbox.
    const box = { left: 100, top: 50, width: 640, height: 400 };
    expect(mapClientPointToSurface({ x: 100, y: 50 }, box, frame)).toEqual({
      x: 0,
      y: 0,
    });
    // Element px -> image px is x2 here, image px -> surface px is /2.
    expect(mapClientPointToSurface({ x: 420, y: 250 }, box, frame)).toEqual({
      x: 320,
      y: 200,
    });
  });

  test('accounts for horizontal letterbox bars on a wide box', () => {
    // 1000x400 box, frame scales to 640x400 centred: 180 px bars each side.
    const box = { left: 0, top: 0, width: 1000, height: 400 };
    expect(mapClientPointToSurface({ x: 180, y: 0 }, box, frame)).toEqual({
      x: 0,
      y: 0,
    });
    expect(mapClientPointToSurface({ x: 500, y: 200 }, box, frame)).toEqual({
      x: 320,
      y: 200,
    });
    // Inside a bar: hits nothing.
    expect(mapClientPointToSurface({ x: 179, y: 200 }, box, frame)).toBeNull();
    expect(mapClientPointToSurface({ x: 820, y: 200 }, box, frame)).toBeNull();
  });

  test('accounts for vertical letterbox bars on a tall box, with DPR 1', () => {
    const dpr1 = { width: 800, height: 400, deviceScaleFactor: 1 };
    // 400x600 box: frame scales by 0.5 to 400x200, bars of 200 top and bottom.
    const box = { left: 10, top: 20, width: 400, height: 600 };
    expect(mapClientPointToSurface({ x: 10, y: 220 }, box, dpr1)).toEqual({
      x: 0,
      y: 0,
    });
    expect(mapClientPointToSurface({ x: 110, y: 270 }, box, dpr1)).toEqual({
      x: 200,
      y: 100,
    });
    expect(mapClientPointToSurface({ x: 110, y: 219 }, box, dpr1)).toBeNull();
    expect(mapClientPointToSurface({ x: 110, y: 420 }, box, dpr1)).toBeNull();
  });

  test('a fractional downscale ratio (a screencast capped by maxWidth) maps exactly', () => {
    // A 1600-wide page captured at 1280 image px: 0.8 image px per page px.
    const capped = { width: 1280, height: 720, deviceScaleFactor: 0.8 };
    const box = { left: 0, top: 0, width: 1280, height: 720 };
    expect(mapClientPointToSurface({ x: 640, y: 360 }, box, capped)).toEqual({
      x: 800,
      y: 450,
    });
  });

  test('an unmeasured box or empty frame maps nothing', () => {
    expect(
      mapClientPointToSurface(
        { x: 0, y: 0 },
        { left: 0, top: 0, width: 0, height: 0 },
        frame,
      ),
    ).toBeNull();
  });
});
