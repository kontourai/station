import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SPATIAL_BOARD_PINS,
  type SpatialBoardPin,
} from '@kontourai/station-contracts';
import { describe, expect, test, vi } from 'vitest';
import { spatialBoardMutationOutcomes } from '../../../telemetry/metrics.js';
import {
  migrateSpatialBoard,
  SpatialBoardCapacityError,
  SpatialBoardConflictError,
  SpatialBoardStore,
  SpatialBoardUnavailableError,
} from '../spatial-board-store.js';

const pin = (index: number): SpatialBoardPin => ({
  id: `pin-${index}`,
  reference:
    index % 2 === 0
      ? { kind: 'task', id: `task-${index}`, projectId: 'project-1' }
      : { kind: 'session', id: `session-${index}` },
  x: index,
  y: index,
  width: 320,
  height: 180,
  order: index,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'station-spatial-board-'));
  const file = join(root, 'board.json');
  return { file, store: new SpatialBoardStore(file) };
}

describe('SpatialBoardStore', () => {
  test('creates, replaces, removes and revision-checks exact pins', async () => {
    const { store } = await fixture();
    await expect(store.read()).resolves.toMatchObject({
      revision: 0,
      pins: [],
    });
    const created = await store.create(0, pin(0));
    expect(created).toMatchObject({ revision: 1, pins: [pin(0)] });
    await expect(store.create(0, pin(1))).rejects.toBeInstanceOf(
      SpatialBoardConflictError,
    );
    const replacement = { ...pin(0), x: 44 };
    const replaced = await store.replace(1, replacement);
    expect(replaced.pins[0]?.x).toBe(44);
    const removed = await store.remove(2, 'pin-0');
    expect(removed).toMatchObject({ revision: 3, pins: [] });
  });

  test('serializes concurrent compare-and-swap writers', async () => {
    const { store } = await fixture();
    const outcomes = await Promise.allSettled([
      store.create(0, pin(0)),
      store.create(0, pin(1)),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    await expect(store.read()).resolves.toMatchObject({ revision: 1 });
  });

  test('preserves one bounded undo snapshot and supports redo by undoing again', async () => {
    const outcomes = vi.spyOn(spatialBoardMutationOutcomes, 'add');
    outcomes.mockClear();
    const { store } = await fixture();
    await store.create(0, pin(0));
    await store.setTitle(1, 'Planning board');
    const undone = await store.undo(2);
    expect(undone).toMatchObject({ revision: 3, title: 'Board' });
    const redone = await store.undo(3);
    expect(redone).toMatchObject({ revision: 4, title: 'Planning board' });
    expect(outcomes).toHaveBeenCalledWith(1, {
      operation: 'undo',
      outcome: 'saved',
    });
    await expect(store.undo(2)).rejects.toBeInstanceOf(
      SpatialBoardConflictError,
    );
    expect(outcomes).toHaveBeenCalledWith(1, {
      operation: 'undo',
      outcome: 'rejected',
    });
    outcomes.mockRestore();
  });

  test('cleans up only exact caller-observed missing references', async () => {
    const { store } = await fixture();
    await store.create(0, pin(0));
    await store.create(1, pin(1));
    await store.create(2, {
      ...pin(2),
      reference: { kind: 'task', id: 'task-0', projectId: 'project-2' },
    });
    const cleaned = await store.cleanupMissing(3, [
      { kind: 'task', id: 'task-0', projectId: 'project-1' },
    ]);
    expect(cleaned.pins.map((item) => item.id)).toEqual(['pin-1', 'pin-2']);
    await expect(
      store.cleanupMissing(4, [
        { kind: 'task', id: 'not-on-board', projectId: 'project-1' },
      ]),
    ).rejects.toBeInstanceOf(SpatialBoardConflictError);
  });

  test('cleanup identity cannot collide through reference delimiters', async () => {
    const { store } = await fixture();
    await store.create(0, {
      ...pin(0),
      reference: { kind: 'task', projectId: 'a:b', id: 'c' },
    });
    await store.create(1, {
      ...pin(1),
      reference: { kind: 'task', projectId: 'a', id: 'b:c' },
    });
    const cleaned = await store.cleanupMissing(2, [
      { kind: 'task', projectId: 'a:b', id: 'c' },
    ]);
    expect(cleaned.pins.map((item) => item.reference)).toEqual([
      { kind: 'task', projectId: 'a', id: 'b:c' },
    ]);
  });

  test('rejects capacity before changing persisted bytes', async () => {
    const { file, store } = await fixture();
    const full = {
      schemaVersion: 2,
      id: 'personal',
      title: 'Board',
      revision: 0,
      camera: { x: 0, y: 0, zoom: 1 },
      pins: Array.from({ length: MAX_SPATIAL_BOARD_PINS }, (_, index) =>
        pin(index),
      ),
    };
    await writeFile(file, JSON.stringify(full));
    const before = await readFile(file, 'utf8');
    await expect(
      store.create(0, pin(MAX_SPATIAL_BOARD_PINS)),
    ).rejects.toBeInstanceOf(SpatialBoardCapacityError);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  test('rejects invalid geometry, duplicate ids and mutation without changing bytes', async () => {
    const { file, store } = await fixture();
    await store.create(0, pin(0));
    const before = await readFile(file, 'utf8');
    await expect(
      store.replace(1, { ...pin(0), x: Number.NaN }),
    ).rejects.toBeInstanceOf(SpatialBoardUnavailableError);
    expect(await readFile(file, 'utf8')).toBe(before);
    await expect(store.create(1, pin(0))).rejects.toBeInstanceOf(
      SpatialBoardConflictError,
    );
  });

  test('migrates the exact legacy schema and rejects unknown/corrupt schemas', async () => {
    expect(
      migrateSpatialBoard({
        schemaVersion: 0,
        id: 'personal',
        title: 'Legacy',
        camera: { x: 0, y: 0, zoom: 1 },
        pins: [pin(0)],
      }),
    ).toMatchObject({ schemaVersion: 2, revision: 0, title: 'Legacy' });
    expect(
      migrateSpatialBoard({
        schemaVersion: 1,
        id: 'personal',
        title: 'Legacy v1',
        revision: 4,
        camera: { x: 0, y: 0, zoom: 1 },
        pins: [pin(0)],
      }),
    ).toMatchObject({ schemaVersion: 2, revision: 4, title: 'Legacy v1' });
    expect(() => migrateSpatialBoard({ schemaVersion: 99 })).toThrow(
      /unknown or corrupt/,
    );
    expect(() =>
      migrateSpatialBoard({
        schemaVersion: 0,
        id: 'personal',
        title: 'Impossible legacy',
        camera: { x: 0, y: 0, zoom: 1 },
        pins: [{ ...pin(0), reference: { kind: 'agent', id: 'station' } }],
      }),
    ).toThrow(/unknown or corrupt/);
  });

  test('fails closed on strict shape and oversized stores', async () => {
    const { file, store } = await fixture();
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 2,
        id: 'personal',
        title: 'Board',
        revision: 0,
        camera: { x: 0, y: 0, zoom: 1 },
        pins: [{ ...pin(0), copiedTitle: 'forbidden' }],
      }),
    );
    await expect(store.read()).rejects.toBeInstanceOf(
      SpatialBoardUnavailableError,
    );
    await writeFile(file, 'x'.repeat(256 * 1024 + 1));
    await expect(store.read()).rejects.toThrow(/oversized/);
    await writeFile(
      file,
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
    );
    await expect(store.read()).rejects.toThrow(/valid UTF-8/);
  });

  test('applies the HTTP byte/control reference boundary to persisted v2 bytes', async () => {
    const { file, store } = await fixture();
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 2,
        id: 'personal',
        title: 'Board',
        revision: 0,
        camera: { x: 0, y: 0, zoom: 1 },
        pins: [
          {
            ...pin(0),
            reference: { kind: 'agent', id: `agent-${'😀'.repeat(2048)}` },
          },
        ],
      }),
    );
    await expect(store.read()).rejects.toThrow(/unknown or corrupt/);
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 2,
        id: 'personal',
        title: 'Board',
        revision: 0,
        camera: { x: 0, y: 0, zoom: 1 },
        pins: [{ ...pin(0), reference: { kind: 'agent', id: 'bad\nagent' } }],
      }),
    );
    await expect(store.read()).rejects.toThrow(/unknown or corrupt/);
  });
});
