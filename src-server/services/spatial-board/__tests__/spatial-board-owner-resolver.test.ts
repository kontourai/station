import type { SpatialBoard, WorkReference } from '@kontourai/station-contracts';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { createSpatialBoardOwnerResolver } from '../spatial-board-owner-resolver.js';

const board = (references: readonly WorkReference[]): SpatialBoard => ({
  schemaVersion: 2,
  id: 'personal',
  revision: 1,
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

describe('spatial-board production owner adapters', () => {
  test('uses persisted+live session summaries and isolates review faults', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'board-test-user',
      undefined,
      undefined,
    );
    const listSessionReadModel = vi.fn(async () => [
      { threadId: 'persisted-session', displayTitle: 'Persisted title' },
    ]);
    const read = vi.fn(async () => {
      throw new Error('receipt storage unavailable');
    });
    const listRuns = vi.fn(async () => [
      {
        runId: 'schedule:owner:1',
        providerId: 'scheduler',
        source: 'schedule' as const,
        status: 'completed' as const,
        startedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        retryEligible: false,
        attempt: 1,
      },
    ]);
    const resolver = createSpatialBoardOwnerResolver({
      projects: { listProjects: () => [] },
      tasks: { listTasks: () => [] },
      sessions: { listSessionReadModel },
      sessionAuthority: authority,
      approvals: { has: () => false },
      reviews: { read },
      flow: { listRuns: async () => [] },
      runs: { listRuns },
      agents: { listAgents: async () => [] },
    });
    const result = await resolver.resolve(
      board([
        { kind: 'session', id: 'persisted-session' },
        { kind: 'receipt', owner: 'scheduler-run', id: 'schedule:owner:1' },
        {
          kind: 'receipt',
          owner: 'independent-review',
          id: 'a'.repeat(64),
          projectSlug: 'project-a',
        },
      ]),
    );
    expect(listSessionReadModel).toHaveBeenCalledWith(authority);
    expect(result.pins).toMatchObject([
      { state: 'current', title: 'Persisted title' },
      { state: 'current' },
      { state: 'unavailable' },
    ]);
  });

  test('uses one all-source RunService observation for artifact and scheduler owners', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'board-test-user',
      undefined,
      undefined,
    );
    const listRuns = vi.fn(async () => [
      {
        runId: 'same-id',
        providerId: 'invoke-provider',
        source: 'invoke' as const,
        status: 'completed' as const,
        startedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        retryEligible: false,
        attempt: 1,
      },
      {
        runId: 'invoke-run',
        providerId: 'invoke-provider',
        source: 'invoke' as const,
        status: 'completed' as const,
        startedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        retryEligible: false,
        attempt: 1,
        outputRef: {
          source: 'invoke' as const,
          providerId: 'invoke-provider',
          runId: 'invoke-run',
          artifactId: 'invoke-artifact',
          kind: 'artifact' as const,
        },
      },
    ]);
    const resolver = createSpatialBoardOwnerResolver({
      projects: { listProjects: () => [] },
      tasks: { listTasks: () => [] },
      sessions: { listSessionReadModel: async () => [] },
      sessionAuthority: authority,
      approvals: { has: () => false },
      reviews: { read: async () => null },
      flow: { listRuns: async () => [] },
      runs: { listRuns },
      agents: { listAgents: async () => [] },
    });

    const result = await resolver.resolve(
      board([
        { kind: 'receipt', owner: 'scheduler-run', id: 'same-id' },
        {
          kind: 'artifact',
          owner: 'run-output',
          id: 'invoke-artifact',
          runId: 'invoke-run',
        },
      ]),
    );

    expect(listRuns).toHaveBeenCalledTimes(1);
    expect(listRuns).toHaveBeenCalledWith(authority);
    expect(result.pins.map((pin) => pin.state)).toEqual(['missing', 'current']);
  });

  test('resolves a current Task only against its canonical Project slug', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'board-test-user',
      undefined,
      undefined,
    );
    const resolver = createSpatialBoardOwnerResolver({
      projects: { listProjects: () => [] },
      tasks: {
        listTasks: () => [
          {
            id: 'task-live',
            projectId: 'station-berd-dogfood',
            title: 'Current Work Board task',
          },
        ],
      },
      sessions: { listSessionReadModel: async () => [] },
      sessionAuthority: authority,
      approvals: { has: () => false },
      reviews: { read: async () => null },
      flow: { listRuns: async () => [] },
      runs: { listRuns: async () => [] },
      agents: { listAgents: async () => [] },
    });

    const result = await resolver.resolve(
      board([
        {
          kind: 'task',
          id: 'task-live',
          projectId: 'station-berd-dogfood',
        },
        {
          kind: 'task',
          id: 'task-live',
          projectId: 'd6b9b7a0-project-uuid',
        },
      ]),
    );

    expect(result.pins).toMatchObject([
      { state: 'current', title: 'Current Work Board task' },
      { state: 'stale' },
    ]);
  });
});
