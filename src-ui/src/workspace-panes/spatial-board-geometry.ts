import type {
  SpatialBoard,
  SpatialBoardPin,
} from '@kontourai/station-contracts';

/**
 * The camera is deliberately bounded by the materialised plane, rather than a
 * magic viewport size. This keeps a restored board navigable at every zoom
 * level while still allowing a user to pan around its authored content.
 */
export const SPATIAL_BOARD_MIN_PLANE = { width: 960, height: 640 };
export const SPATIAL_BOARD_MIN_CARD = { width: 152, height: 240 };
const PLANE_GUTTER = 160;

export type SpatialBoardPlaneGeometry = {
  width: number;
  height: number;
};

export function spatialBoardPlaneGeometry(
  pins: readonly SpatialBoardPin[],
): SpatialBoardPlaneGeometry {
  const right = Math.max(
    SPATIAL_BOARD_MIN_PLANE.width,
    ...pins.map((pin) => pin.x + pin.width + PLANE_GUTTER),
  );
  const bottom = Math.max(
    SPATIAL_BOARD_MIN_PLANE.height,
    ...pins.map((pin) => pin.y + pin.height + PLANE_GUTTER),
  );
  return { width: Math.ceil(right), height: Math.ceil(bottom) };
}

export function boundSpatialBoardCamera(
  camera: SpatialBoard['camera'],
  plane: SpatialBoardPlaneGeometry,
): SpatialBoard['camera'] {
  return {
    ...camera,
    x: Math.max(-plane.width, Math.min(plane.width, camera.x)),
    y: Math.max(-plane.height, Math.min(plane.height, camera.y)),
  };
}

/** Applies the current Board card geometry at every render and resize seam. */
export function spatialBoardCardBounds(
  pin: Pick<SpatialBoardPin, 'width' | 'height'>,
) {
  return {
    width: Math.max(SPATIAL_BOARD_MIN_CARD.width, pin.width),
    height: Math.max(SPATIAL_BOARD_MIN_CARD.height, pin.height),
  };
}
