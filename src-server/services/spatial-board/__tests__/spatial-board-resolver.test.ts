import type { SpatialBoard, WorkReference } from '@kontourai/station-contracts';
import { describe, expect, test, vi } from 'vitest';
import { SpatialBoardResolver } from '../spatial-board-resolver.js';

const board = (references: readonly WorkReference[]): SpatialBoard => ({
  schemaVersion: 2,
  id: 'personal',
  revision: 7,
  title: 'Board',
  camera: { x: 0, y: 0, zoom: 1 },
  pins: references.map((reference, order) => ({
    id: `pin-${order}`,
    reference,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    order,
  })),
});

describe('SpatialBoardResolver', () => {
  test('groups only stored refs by owner and keeps owner data ephemeral', async () => {
    const resolveProjects = vi.fn(
      async (references: readonly WorkReference[]) =>
        references.map((reference) => ({
          reference,
          state: 'current' as const,
          title: 'Project A',
          href: '/projects/project-a',
        })),
    );
    const resolver = new SpatialBoardResolver({
      project: { resolve: resolveProjects },
    });
    const result = await resolver.resolve(
      board([
        { kind: 'project', id: 'project-a' },
        { kind: 'project', id: 'project-b' },
        { kind: 'agent', id: 'station' },
      ]),
    );
    expect(resolveProjects).toHaveBeenCalledTimes(1);
    expect(resolveProjects).toHaveBeenCalledWith([
      { kind: 'project', id: 'project-a' },
      { kind: 'project', id: 'project-b' },
    ]);
    expect(result).toMatchObject({
      revision: 7,
      pins: [
        { state: 'current', title: 'Project A', href: '/projects/project-a' },
        { state: 'current', title: 'Project A' },
        { state: 'NOT_VERIFIED' },
      ],
    });
  });

  test('contains owner faults, rejects foreign responses, and names ambiguity', async () => {
    const resolver = new SpatialBoardResolver({
      task: {
        resolve: async () => [
          {
            reference: { kind: 'task', id: 'foreign', projectId: 'project-a' },
            state: 'current',
            title: 'Must not leak',
          },
        ],
      },
      session: { resolve: async () => Promise.reject(new Error('offline')) },
      agent: {
        resolve: async (references) => [
          { reference: references[0]!, state: 'current' },
          { reference: references[0]!, state: 'current' },
        ],
      },
    });
    const result = await resolver.resolve(
      board([
        { kind: 'task', id: 'task-1', projectId: 'project-a' },
        { kind: 'session', id: 'session-1' },
        { kind: 'agent', id: 'station' },
      ]),
    );
    expect(result.pins.map((pin) => pin.state)).toEqual([
      'NOT_VERIFIED',
      'unavailable',
      'ambiguous',
    ]);
  });

  test('deduplicates identical stored references before owner observation', async () => {
    const resolve = vi.fn(async (references: readonly WorkReference[]) =>
      references.map((reference) => ({ reference, state: 'current' as const })),
    );
    const resolver = new SpatialBoardResolver({ agent: { resolve } });
    const result = await resolver.resolve(
      board([
        { kind: 'agent', id: 'station' },
        { kind: 'agent', id: 'station' },
      ]),
    );
    expect(resolve).toHaveBeenCalledWith([{ kind: 'agent', id: 'station' }]);
    expect(result.pins.map((pin) => pin.state)).toEqual(['current', 'current']);
  });
});
