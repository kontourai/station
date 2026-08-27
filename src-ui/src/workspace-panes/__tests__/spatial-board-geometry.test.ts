import { describe, expect, test } from 'vitest';
import {
  boundSpatialBoardCamera,
  SPATIAL_BOARD_MIN_CARD,
  spatialBoardCardBounds,
  spatialBoardPlaneGeometry,
} from '../spatial-board-geometry';

const pins = [
  {
    id: 'first',
    reference: { kind: 'project' as const, id: 'project-a' },
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    order: 0,
  },
  {
    id: 'far',
    reference: { kind: 'session' as const, id: 'session-a' },
    x: 1_120,
    y: 640,
    width: 260,
    height: 160,
    order: 1,
  },
];

describe('spatial board plane geometry', () => {
  test.each([0.5, 1, 1.25, 2])(
    'keeps the top-left authored origin explicit at %s zoom',
    (zoom) => {
      const plane = spatialBoardPlaneGeometry(pins);
      expect(plane).toEqual({ width: 1540, height: 960 });
      expect(boundSpatialBoardCamera({ x: 0, y: 0, zoom }, plane)).toEqual({
        x: 0,
        y: 0,
        zoom,
      });
    },
  );

  test('bounds restored and panned camera states by materialised plane geometry', () => {
    const plane = spatialBoardPlaneGeometry(pins);
    expect(
      boundSpatialBoardCamera({ x: 340, y: -220, zoom: 1.25 }, plane),
    ).toEqual({ x: 340, y: -220, zoom: 1.25 });
    expect(
      boundSpatialBoardCamera({ x: 9_999, y: -9_999, zoom: 2 }, plane),
    ).toEqual({ x: 1540, y: -960, zoom: 2 });
  });

  test('renders legacy and newly resized cards large enough for two 44px controls and content', () => {
    expect(SPATIAL_BOARD_MIN_CARD).toEqual({ width: 152, height: 240 });
    expect(spatialBoardCardBounds({ width: 80, height: 60 })).toEqual({
      width: 152,
      height: 240,
    });
    // Header/footer boxes are 52px each in the shipped CSS. A two-line Flow
    // title plus eyebrow badge and exact identity needs 111px at 152px wide.
    expect(52 + 52 + 16 + 111).toBeLessThanOrEqual(
      SPATIAL_BOARD_MIN_CARD.height,
    );
  });
});
