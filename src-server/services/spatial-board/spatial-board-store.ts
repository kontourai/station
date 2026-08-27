import { readFile } from 'node:fs/promises';
import {
  isFiniteBoardNumber,
  MAX_SPATIAL_BOARD_COORDINATE,
  MAX_SPATIAL_BOARD_PINS,
  MAX_SPATIAL_BOARD_SIZE,
  MAX_SPATIAL_BOARD_ZOOM,
  MIN_SPATIAL_BOARD_ZOOM,
  SPATIAL_BOARD_SCHEMA_VERSION,
  type SpatialBoard,
  type SpatialBoardPin,
  type SpatialBoardSnapshot,
  type WorkReference,
  workReferenceIdentityKey,
} from '@kontourai/station-contracts';
import { mutateJsonFile } from '../../domain/file-storage-helpers.js';
import { spatialBoardMutationOutcomes } from '../../telemetry/metrics.js';
import { isSpatialBoardWorkReference } from './spatial-board-reference.js';

const MAX_STORE_BYTES = 256 * 1024;
const EMPTY: SpatialBoard = Object.freeze({
  schemaVersion: SPATIAL_BOARD_SCHEMA_VERSION,
  id: 'personal',
  title: 'Board',
  revision: 0,
  camera: Object.freeze({ x: 0, y: 0, zoom: 1 }),
  pins: Object.freeze([]),
});
type LegacyReference = Extract<WorkReference, { kind: 'task' | 'session' }>;
type LegacySpatialBoardPin = Omit<SpatialBoardPin, 'reference'> & {
  reference: LegacyReference;
};
type LegacySpatialBoardSnapshot = Omit<SpatialBoardSnapshot, 'pins'> & {
  pins: readonly LegacySpatialBoardPin[];
};
type LegacySpatialBoardV0 = {
  schemaVersion: 0;
  id: 'personal';
  title: string;
  camera: SpatialBoard['camera'];
  pins: readonly LegacySpatialBoardPin[];
};
type LegacySpatialBoardV1 = {
  schemaVersion: 1;
  id: 'personal';
  revision: number;
  title: string;
  camera: SpatialBoard['camera'];
  pins: readonly LegacySpatialBoardPin[];
  undo?: LegacySpatialBoardSnapshot;
};

export class SpatialBoardConflictError extends Error {}
export class SpatialBoardUnavailableError extends Error {}
export class SpatialBoardCapacityError extends Error {}
export class SpatialBoardPinNotFoundError extends Error {}

const exactKeys = (
  value: object,
  required: string[],
  optional: string[] = [],
) => {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};
const text = (value: unknown, maxBytes: number) =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= maxBytes &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
const bounded = (value: unknown, absoluteMax: number) =>
  isFiniteBoardNumber(value) && Math.abs(value) <= absoluteMax;
function validCamera(value: unknown): value is SpatialBoard['camera'] {
  if (!value || typeof value !== 'object') return false;
  const camera = value as Record<string, unknown>;
  return (
    exactKeys(camera, ['x', 'y', 'zoom']) &&
    bounded(camera.x, MAX_SPATIAL_BOARD_COORDINATE) &&
    bounded(camera.y, MAX_SPATIAL_BOARD_COORDINATE) &&
    isFiniteBoardNumber(camera.zoom) &&
    camera.zoom >= MIN_SPATIAL_BOARD_ZOOM &&
    camera.zoom <= MAX_SPATIAL_BOARD_ZOOM
  );
}

function validPin(value: unknown): value is SpatialBoardPin {
  if (!value || typeof value !== 'object') return false;
  const pin = value as Record<string, unknown>;
  return (
    exactKeys(pin, ['id', 'reference', 'x', 'y', 'width', 'height', 'order']) &&
    text(pin.id, 160) &&
    isSpatialBoardWorkReference(pin.reference) &&
    bounded(pin.x, MAX_SPATIAL_BOARD_COORDINATE) &&
    bounded(pin.y, MAX_SPATIAL_BOARD_COORDINATE) &&
    isFiniteBoardNumber(pin.width) &&
    pin.width > 0 &&
    pin.width <= MAX_SPATIAL_BOARD_SIZE &&
    isFiniteBoardNumber(pin.height) &&
    pin.height > 0 &&
    pin.height <= MAX_SPATIAL_BOARD_SIZE &&
    typeof pin.order === 'number' &&
    Number.isInteger(pin.order) &&
    pin.order >= 0 &&
    pin.order <= MAX_SPATIAL_BOARD_PINS
  );
}

function validV1Pin(value: unknown): value is SpatialBoardPin {
  if (!validPin(value)) return false;
  return value.reference.kind === 'task' || value.reference.kind === 'session';
}

function validSnapshot(value: unknown): value is SpatialBoardSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  return (
    exactKeys(snapshot, ['title', 'camera', 'pins']) &&
    text(snapshot.title, 512) &&
    validCamera(snapshot.camera) &&
    validPins(snapshot.pins)
  );
}

function validPins(value: unknown): value is readonly SpatialBoardPin[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SPATIAL_BOARD_PINS &&
    value.every(validPin) &&
    new Set(value.map((pin) => pin.id)).size === value.length
  );
}

function validV1Pins(value: unknown): value is readonly SpatialBoardPin[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SPATIAL_BOARD_PINS &&
    value.every(validV1Pin) &&
    new Set(value.map((pin) => pin.id)).size === value.length
  );
}

function validV0Board(value: unknown): value is LegacySpatialBoardV0 {
  if (!value || typeof value !== 'object') return false;
  const board = value as Record<string, unknown>;
  return (
    exactKeys(board, ['schemaVersion', 'id', 'title', 'camera', 'pins']) &&
    board.schemaVersion === 0 &&
    board.id === 'personal' &&
    text(board.title, 512) &&
    validCamera(board.camera) &&
    validV1Pins(board.pins)
  );
}

function validBoard(value: unknown): value is SpatialBoard {
  if (!value || typeof value !== 'object') return false;
  const board = value as Record<string, unknown>;
  return (
    exactKeys(
      board,
      ['schemaVersion', 'id', 'title', 'revision', 'camera', 'pins'],
      ['undo'],
    ) &&
    board.schemaVersion === SPATIAL_BOARD_SCHEMA_VERSION &&
    board.id === 'personal' &&
    text(board.title, 512) &&
    Number.isSafeInteger(board.revision) &&
    (board.revision as number) >= 0 &&
    validCamera(board.camera) &&
    validPins(board.pins) &&
    (board.undo === undefined || validSnapshot(board.undo))
  );
}

function validV1Snapshot(value: unknown): value is SpatialBoardSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  return (
    exactKeys(snapshot, ['title', 'camera', 'pins']) &&
    text(snapshot.title, 512) &&
    validCamera(snapshot.camera) &&
    validV1Pins(snapshot.pins)
  );
}

function validV1Board(value: unknown): value is LegacySpatialBoardV1 {
  if (!value || typeof value !== 'object') return false;
  const board = value as Record<string, unknown>;
  return (
    exactKeys(
      board,
      ['schemaVersion', 'id', 'title', 'revision', 'camera', 'pins'],
      ['undo'],
    ) &&
    board.schemaVersion === 1 &&
    board.id === 'personal' &&
    text(board.title, 512) &&
    Number.isSafeInteger(board.revision) &&
    (board.revision as number) >= 0 &&
    validCamera(board.camera) &&
    validV1Pins(board.pins) &&
    (board.undo === undefined || validV1Snapshot(board.undo))
  );
}

function snapshot(board: SpatialBoard): SpatialBoardSnapshot {
  return structuredClone({
    title: board.title,
    camera: board.camera,
    pins: board.pins,
  });
}

export function migrateSpatialBoard(value: unknown): SpatialBoard {
  if (validBoard(value)) return structuredClone(value);
  if (validV0Board(value)) {
    return {
      schemaVersion: SPATIAL_BOARD_SCHEMA_VERSION,
      id: value.id,
      title: value.title,
      revision: 0,
      camera: value.camera,
      pins: value.pins,
    };
  }
  if (validV1Board(value)) {
    return {
      schemaVersion: SPATIAL_BOARD_SCHEMA_VERSION,
      id: value.id,
      title: value.title,
      revision: value.revision,
      camera: value.camera,
      pins: value.pins,
      ...(value.undo ? { undo: value.undo } : {}),
    };
  }
  throw new SpatialBoardUnavailableError(
    'Spatial board schema is unknown or corrupt.',
  );
}

function emptyBoard(): SpatialBoard {
  return structuredClone(EMPTY);
}

export class SpatialBoardStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<SpatialBoard> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return emptyBoard();
      throw new SpatialBoardUnavailableError(
        'Spatial board store is unavailable.',
      );
    }
    if (bytes.byteLength > MAX_STORE_BYTES)
      throw new SpatialBoardUnavailableError(
        'Spatial board store is oversized.',
      );
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new SpatialBoardUnavailableError(
        'Spatial board store is not valid UTF-8.',
      );
    }
    try {
      return migrateSpatialBoard(JSON.parse(source));
    } catch (error) {
      if (error instanceof SpatialBoardUnavailableError) throw error;
      throw new SpatialBoardUnavailableError(
        'Spatial board store is corrupt or unavailable.',
      );
    }
  }

  async update(
    expectedRevision: number,
    derive: (board: SpatialBoard) => SpatialBoardSnapshot,
    operation = 'update',
  ): Promise<SpatialBoard> {
    try {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new SpatialBoardConflictError('Invalid expected board revision.');
      const next = await mutateJsonFile<unknown>(
        this.filePath,
        emptyBoard(),
        (stored) => {
          const current = migrateSpatialBoard(stored);
          if (current.revision !== expectedRevision)
            throw new SpatialBoardConflictError(
              'Spatial board revision conflict.',
            );
          const nextSnapshot = derive(structuredClone(current));
          if (!validSnapshot(nextSnapshot))
            throw new SpatialBoardUnavailableError(
              'Spatial board update is invalid.',
            );
          const next: SpatialBoard = {
            schemaVersion: SPATIAL_BOARD_SCHEMA_VERSION,
            id: 'personal',
            revision: current.revision + 1,
            ...structuredClone(nextSnapshot),
            undo: snapshot(current),
          };
          if (!validBoard(next))
            throw new SpatialBoardUnavailableError(
              'Spatial board update is invalid.',
            );
          return next;
        },
        { maxBytes: MAX_STORE_BYTES, label: 'Spatial board store' },
      ).then((value) => migrateSpatialBoard(value));
      spatialBoardMutationOutcomes.add(1, { operation, outcome: 'saved' });
      return next;
    } catch (error) {
      spatialBoardMutationOutcomes.add(1, { operation, outcome: 'rejected' });
      if (
        error instanceof SpatialBoardConflictError ||
        error instanceof SpatialBoardCapacityError ||
        error instanceof SpatialBoardPinNotFoundError ||
        error instanceof SpatialBoardUnavailableError
      )
        throw error;
      throw new SpatialBoardUnavailableError(
        'Spatial board update could not be persisted.',
      );
    }
  }

  create(expectedRevision: number, pin: SpatialBoardPin) {
    return this.update(
      expectedRevision,
      (board) => {
        if (board.pins.length >= MAX_SPATIAL_BOARD_PINS)
          throw new SpatialBoardCapacityError(
            'Spatial board is at pin capacity.',
          );
        if (board.pins.some((current) => current.id === pin.id))
          throw new SpatialBoardConflictError(
            'Spatial board pin already exists.',
          );
        return { ...snapshot(board), pins: [...board.pins, pin] };
      },
      'create',
    );
  }

  replace(expectedRevision: number, pin: SpatialBoardPin) {
    return this.update(
      expectedRevision,
      (board) => {
        if (!board.pins.some((current) => current.id === pin.id))
          throw new SpatialBoardPinNotFoundError(
            'Spatial board pin not found.',
          );
        return {
          ...snapshot(board),
          pins: board.pins.map((current) =>
            current.id === pin.id ? pin : current,
          ),
        };
      },
      'replace',
    );
  }

  remove(expectedRevision: number, pinId: string) {
    if (!text(pinId, 160))
      throw new SpatialBoardPinNotFoundError('Spatial board pin not found.');
    return this.update(
      expectedRevision,
      (board) => {
        if (!board.pins.some((pin) => pin.id === pinId))
          throw new SpatialBoardPinNotFoundError(
            'Spatial board pin not found.',
          );
        return {
          ...snapshot(board),
          pins: board.pins.filter((pin) => pin.id !== pinId),
        };
      },
      'remove',
    );
  }

  setCamera(expectedRevision: number, camera: SpatialBoard['camera']) {
    return this.update(
      expectedRevision,
      (board) => ({
        ...snapshot(board),
        camera,
      }),
      'camera',
    );
  }

  setTitle(expectedRevision: number, title: string) {
    return this.update(
      expectedRevision,
      (board) => ({
        ...snapshot(board),
        title,
      }),
      'title',
    );
  }

  cleanupMissing(
    expectedRevision: number,
    missingReferences: readonly WorkReference[],
  ) {
    if (
      missingReferences.length > MAX_SPATIAL_BOARD_PINS ||
      missingReferences.some(
        (reference) => !isSpatialBoardWorkReference(reference),
      )
    )
      throw new SpatialBoardCapacityError(
        'Missing-reference set exceeds the bound.',
      );
    const missingReferenceKeys = new Set(
      missingReferences.map(workReferenceIdentityKey),
    );
    return this.update(
      expectedRevision,
      (board) => {
        const known = new Set(
          board.pins.map((pin) => workReferenceIdentityKey(pin.reference)),
        );
        if ([...missingReferenceKeys].some((key) => !known.has(key)))
          throw new SpatialBoardConflictError(
            'Cleanup named a reference that is not on this board.',
          );
        return {
          ...snapshot(board),
          pins: board.pins.filter(
            (pin) =>
              !missingReferenceKeys.has(
                workReferenceIdentityKey(pin.reference),
              ),
          ),
        };
      },
      'cleanup',
    );
  }

  async undo(expectedRevision: number): Promise<SpatialBoard> {
    try {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new SpatialBoardConflictError('Invalid expected board revision.');
      const next = await mutateJsonFile<unknown>(
        this.filePath,
        emptyBoard(),
        (stored) => {
          const current = migrateSpatialBoard(stored);
          if (current.revision !== expectedRevision)
            throw new SpatialBoardConflictError(
              'Spatial board revision conflict.',
            );
          if (!current.undo)
            throw new SpatialBoardConflictError(
              'Spatial board has no undo snapshot.',
            );
          const next: SpatialBoard = {
            schemaVersion: SPATIAL_BOARD_SCHEMA_VERSION,
            id: 'personal',
            revision: current.revision + 1,
            ...structuredClone(current.undo),
            undo: snapshot(current),
          };
          if (!validBoard(next))
            throw new SpatialBoardUnavailableError('Undo snapshot is invalid.');
          return next;
        },
        { maxBytes: MAX_STORE_BYTES, label: 'Spatial board store' },
      ).then((value) => migrateSpatialBoard(value));
      spatialBoardMutationOutcomes.add(1, {
        operation: 'undo',
        outcome: 'saved',
      });
      return next;
    } catch (error) {
      spatialBoardMutationOutcomes.add(1, {
        operation: 'undo',
        outcome: 'rejected',
      });
      if (
        error instanceof SpatialBoardConflictError ||
        error instanceof SpatialBoardUnavailableError
      )
        throw error;
      throw new SpatialBoardUnavailableError(
        'Spatial board undo could not persist.',
      );
    }
  }
}

export type { LegacySpatialBoardV0, LegacySpatialBoardV1 };
