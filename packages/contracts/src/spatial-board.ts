import type { WorkReference } from './work-reference.js';

export const SPATIAL_BOARD_SCHEMA_VERSION = 2 as const;
export const MAX_SPATIAL_BOARD_PINS = 200;
export const MAX_SPATIAL_BOARD_COORDINATE = 1_000_000;
export const MAX_SPATIAL_BOARD_SIZE = 100_000;
export const MIN_SPATIAL_BOARD_ZOOM = 0.1;
export const MAX_SPATIAL_BOARD_ZOOM = 8;

export type SpatialBoardPin = Readonly<{
  id: string;
  /**
   * Correlation only. Mutable owner facts are intentionally absent from the
   * persisted board and are re-resolved through the board-bounded read seam.
   */
  reference: WorkReference;
  x: number;
  y: number;
  width: number;
  height: number;
  order: number;
}>;

export type SpatialBoardResolutionState =
  | 'current'
  | 'missing'
  | 'stale'
  | 'unavailable'
  | 'ambiguous'
  | 'NOT_VERIFIED';

/** A transient owner projection for one pin; it is never stored in the board. */
export type SpatialBoardResolvedPin = Readonly<{
  pinId: string;
  reference: WorkReference;
  state: SpatialBoardResolutionState;
  /** Present only when the owner made a bounded current projection truthful. */
  title?: string;
  /** Present only when the owner made a bounded current target truthful. */
  href?: string;
}>;

export type SpatialBoardResolved = Readonly<{
  revision: number;
  pins: readonly SpatialBoardResolvedPin[];
}>;

export type SpatialBoardSnapshot = Readonly<{
  title: string;
  camera: Readonly<{ x: number; y: number; zoom: number }>;
  pins: readonly SpatialBoardPin[];
}>;

export type SpatialBoard = Readonly<{
  schemaVersion: typeof SPATIAL_BOARD_SCHEMA_VERSION;
  id: 'personal';
  revision: number;
  title: string;
  camera: SpatialBoardSnapshot['camera'];
  pins: readonly SpatialBoardPin[];
  undo?: SpatialBoardSnapshot;
}>;

export const isFiniteBoardNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
