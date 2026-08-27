import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunSummary } from '@kontourai/station-contracts/runs';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createSpatialBoardOwnerResolver } from '../../services/spatial-board/spatial-board-owner-resolver.js';
import { SpatialBoardResolver } from '../../services/spatial-board/spatial-board-resolver.js';
import { SpatialBoardStore } from '../../services/spatial-board/spatial-board-store.js';
import { createSpatialBoardRoutes } from '../spatial-board.js';

describe('spatial board routes', () => {
  let app: ReturnType<typeof createSpatialBoardRoutes>;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'spatial-board-routes-'));
    app = createSpatialBoardRoutes(
      new SpatialBoardStore(join(root, 'spatial-board.json')),
      new SpatialBoardResolver({}),
    );
  });

  test('reads and revision-checks an exact Task pin', async () => {
    expect(await (await app.request('/')).json()).toMatchObject({
      success: true,
      data: { revision: 0, pins: [] },
    });
    const body = {
      expectedRevision: 0,
      pin: {
        id: 'pin-1',
        reference: { kind: 'task', id: 'task-1', projectId: 'project-1' },
        x: 10,
        y: 20,
        width: 320,
        height: 180,
        order: 0,
      },
    };
    const created = await app.request('/pins', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      success: true,
      data: { revision: 1, pins: [body.pin] },
    });
    const stale = await app.request('/pins', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, pin: { ...body.pin, id: 'pin-2' } }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: 'spatial_board_conflict',
    });
  });

  test('takes fresh project and RunService observations for each resolved GET', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spatial-board-routes-fresh-'));
    const store = new SpatialBoardStore(join(root, 'spatial-board.json'));
    await store.create(0, {
      id: 'project-pin',
      reference: { kind: 'project', id: 'project-1' },
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      order: 0,
    });
    await store.create(1, {
      id: 'receipt-pin',
      reference: { kind: 'receipt', owner: 'scheduler-run', id: 'new-receipt' },
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      order: 1,
    });
    const authority = sessionReadAuthorityFromRequest(
      'board-route-user',
      undefined,
      undefined,
    );
    let projects = [{ id: 'project-1', name: 'Original title' }];
    let runs: readonly RunSummary[] = [];
    const listRuns = vi.fn(async () => runs);
    const resolver = createSpatialBoardOwnerResolver({
      projects: { listProjects: () => projects },
      tasks: { listTasks: () => [] },
      sessions: { listSessionReadModel: async () => [] },
      sessionAuthority: authority,
      approvals: { has: () => false },
      reviews: { read: async () => null },
      flow: { listRuns: async () => [] },
      runs: { listRuns },
      agents: { listAgents: async () => [] },
    });
    const freshApp = createSpatialBoardRoutes(store, resolver);

    const first = await freshApp.request('/resolved');
    expect(await first.json()).toMatchObject({
      success: true,
      data: {
        pins: [
          { state: 'current', title: 'Original title' },
          { state: 'missing' },
        ],
      },
    });

    projects = [{ id: 'project-1', name: 'New title' }];
    runs = [
      {
        runId: 'new-receipt',
        providerId: 'scheduler',
        source: 'schedule',
        status: 'completed',
        startedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        retryEligible: false,
        attempt: 1,
      },
    ];

    const second = await freshApp.request('/resolved');
    expect(await second.json()).toMatchObject({
      success: true,
      data: {
        pins: [{ state: 'current', title: 'New title' }, { state: 'current' }],
      },
    });
    expect(listRuns).toHaveBeenCalledTimes(2);
    expect(listRuns).toHaveBeenNthCalledWith(1, authority);
    expect(listRuns).toHaveBeenNthCalledWith(2, authority);
  });

  test('isolates lazy project faults from Session reads and retries projects on the next GET', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spatial-board-routes-fault-'));
    const store = new SpatialBoardStore(join(root, 'spatial-board.json'));
    await store.create(0, {
      id: 'session-pin',
      reference: { kind: 'session', id: 'session-1' },
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      order: 0,
    });
    const authority = sessionReadAuthorityFromRequest(
      'board-route-user',
      undefined,
      undefined,
    );
    let projectsRecovered = false;
    const listProjects = vi.fn(() => {
      if (!projectsRecovered) throw new Error('project store offline');
      return [{ id: 'project-1', name: 'Recovered project' }];
    });
    const listSessionReadModel = vi.fn(async () => [
      { threadId: 'session-1', displayTitle: 'Live session' },
    ]);
    const resolver = createSpatialBoardOwnerResolver({
      projects: { listProjects },
      tasks: { listTasks: () => [] },
      sessions: { listSessionReadModel },
      sessionAuthority: authority,
      approvals: { has: () => false },
      reviews: { read: async () => null },
      flow: { listRuns: async () => [] },
      runs: { listRuns: async () => [] },
      agents: { listAgents: async () => [] },
    });
    const faultApp = createSpatialBoardRoutes(store, resolver);

    const sessionOnly = await faultApp.request('/resolved');
    expect(sessionOnly.status).toBe(200);
    await expect(sessionOnly.json()).resolves.toMatchObject({
      success: true,
      data: { pins: [{ state: 'current', title: 'Live session' }] },
    });
    expect(listProjects).not.toHaveBeenCalled();
    expect(listSessionReadModel).toHaveBeenCalledTimes(1);

    await store.create(1, {
      id: 'project-pin',
      reference: { kind: 'project', id: 'project-1' },
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      order: 1,
    });
    const mixed = await faultApp.request('/resolved');
    expect(mixed.status).toBe(200);
    await expect(mixed.json()).resolves.toMatchObject({
      success: true,
      data: {
        pins: [{ state: 'current' }, { state: 'unavailable' }],
      },
    });

    projectsRecovered = true;
    const recovered = await faultApp.request('/resolved');
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      success: true,
      data: {
        pins: [
          { state: 'current', title: 'Live session' },
          { state: 'current', title: 'Recovered project' },
        ],
      },
    });
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  test('rejects mismatched route identity and unregistered reference kinds', async () => {
    const mismatch = await app.request('/pins/expected', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 0,
        pin: {
          id: 'other',
          reference: { kind: 'session', id: 'session-1' },
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          order: 0,
        },
      }),
    });
    expect(mismatch.status).toBe(409);
    const invalid = await app.request('/pins', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 0,
        pin: {
          id: 'pin-1',
          reference: { kind: 'receipt', id: 'receipt-1' },
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          order: 0,
        },
      }),
    });
    expect(invalid.status).toBe(400);
    const outOfBounds = await app.request('/camera', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 0,
        camera: { x: 0, y: 0, zoom: 99 },
      }),
    });
    expect(outOfBounds.status).toBe(400);
  });

  test('admits every strict WorkReference shape and returns board-bounded unresolved projections', async () => {
    const references = [
      { kind: 'project', id: 'project-1' },
      { kind: 'task', id: 'task-1', projectId: 'project-1' },
      { kind: 'session', id: 'session-1' },
      { kind: 'approval', id: 'approval-1' },
      { kind: 'receipt', owner: 'scheduler-run', id: 'receipt-1' },
      {
        kind: 'receipt',
        owner: 'independent-review',
        id: 'review-1',
        projectSlug: 'project-a',
      },
      { kind: 'run', owner: 'flow', id: 'run-1', projectId: 'project-1' },
      {
        kind: 'artifact',
        owner: 'run-output',
        id: 'artifact-1',
        runId: 'run-1',
      },
      { kind: 'agent', id: 'station' },
    ];
    for (const [order, reference] of references.entries()) {
      const response = await app.request('/pins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: order,
          pin: {
            id: `pin-${order}`,
            reference,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            order,
          },
        }),
      });
      expect(response.status).toBe(200);
    }
    const resolved = (await (await app.request('/resolved')).json()) as {
      success: boolean;
      data: { revision: number; pins: Array<{ state: string }> };
    };
    expect(resolved).toMatchObject({
      success: true,
      data: { revision: references.length },
    });
    expect(resolved.data.pins).toHaveLength(references.length);
    expect(
      resolved.data.pins.every(
        (pin: { state: string }) => pin.state === 'NOT_VERIFIED',
      ),
    ).toBe(true);
  });

  test('rejects every contract bound at ingress without changing the board', async () => {
    const validPin = {
      id: 'pin-1',
      reference: { kind: 'session', id: 'session-1' },
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      order: 0,
    };
    const requests = [
      [
        '/pins',
        'POST',
        { expectedRevision: 0, pin: { ...validPin, x: 1_000_001 } },
      ],
      [
        '/pins',
        'POST',
        { expectedRevision: 0, pin: { ...validPin, width: 100_001 } },
      ],
      [
        '/pins',
        'POST',
        { expectedRevision: 0, pin: { ...validPin, order: 201 } },
      ],
      [
        '/pins',
        'POST',
        { expectedRevision: 0, pin: { ...validPin, id: '😀'.repeat(160) } },
      ],
      [
        '/camera',
        'PATCH',
        { expectedRevision: 0, camera: { x: 0, y: 0, zoom: 9 } },
      ],
      ['/title', 'PATCH', { expectedRevision: 0, title: 'bad\ntitle' }],
    ] as const;
    for (const [path, method, body] of requests) {
      const response = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    await expect((await app.request('/')).json()).resolves.toMatchObject({
      data: { revision: 0, pins: [] },
    });
  });

  test('exposes bounded title, camera, cleanup, remove, and undo operations', async () => {
    const pin = {
      id: 'pin-1',
      reference: { kind: 'session', id: 'session-1' },
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      order: 0,
    };
    await app.request('/pins', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, pin }),
    });
    const title = await app.request('/title', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, title: 'My board' }),
    });
    expect(title.status).toBe(200);
    const camera = await app.request('/camera', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 2,
        camera: { x: 2, y: 3, zoom: 1.5 },
      }),
    });
    expect(camera.status).toBe(200);
    const cleanup = await app.request('/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 3,
        missingReferences: [{ kind: 'session', id: 'session-1' }],
      }),
    });
    expect(cleanup.status).toBe(200);
    const undone = await app.request('/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 4 }),
    });
    expect(undone.status).toBe(200);
    await expect(undone.json()).resolves.toMatchObject({
      data: { revision: 5, pins: [pin] },
    });
  });
});
