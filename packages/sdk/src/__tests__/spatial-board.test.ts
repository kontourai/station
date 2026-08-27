import { beforeEach, describe, expect, test, vi } from 'vitest';

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../client/http', () => ({ authenticatedFetch }));
vi.mock('../query-core', () => ({
  resolveApiBase: async (apiBase?: string) => apiBase ?? 'http://station.test',
  useApiMutation: vi.fn(),
  useApiQuery: vi.fn(),
}));

import {
  createSpatialBoardPin,
  getResolvedSpatialBoard,
  getSpatialBoard,
} from '../spatial-board';

describe('spatial board SDK', () => {
  beforeEach(() => authenticatedFetch.mockReset());

  test('reads the personal board through authenticated transport', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            schemaVersion: 2,
            id: 'personal',
            revision: 0,
            title: 'Board',
            camera: { x: 0, y: 0, zoom: 1 },
            pins: [],
          },
        }),
      ),
    );
    await expect(getSpatialBoard('http://station.test')).resolves.toMatchObject(
      {
        revision: 0,
      },
    );
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'http://station.test/api/spatial-board',
    );
  });

  test('sends exact revision and WorkReference for pin creation', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            schemaVersion: 2,
            id: 'personal',
            revision: 1,
            title: 'Board',
            camera: { x: 0, y: 0, zoom: 1 },
            pins: [],
          },
        }),
      ),
    );
    const pin = {
      id: 'pin-1',
      reference: {
        kind: 'task' as const,
        id: 'task-1',
        projectId: 'project-1',
      },
      x: 1,
      y: 2,
      width: 320,
      height: 180,
      order: 0,
    };
    await createSpatialBoardPin({
      expectedRevision: 0,
      pin,
      apiBase: 'http://station.test',
    });
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'http://station.test/api/spatial-board/pins',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 0, pin }),
      },
    );
  });

  test('reads board-bounded owner projections through the canonical endpoint', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            revision: 4,
            pins: [
              {
                pinId: 'pin-agent',
                reference: { kind: 'agent', id: 'station' },
                state: 'current',
                title: 'Station',
              },
            ],
          },
        }),
      ),
    );
    await expect(
      getResolvedSpatialBoard('http://station.test'),
    ).resolves.toMatchObject({ revision: 4 });
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'http://station.test/api/spatial-board/resolved',
    );
  });

  test('does not retry a mutation when the response is lost', async () => {
    authenticatedFetch.mockRejectedValueOnce(new TypeError('network lost'));
    await expect(
      createSpatialBoardPin({
        expectedRevision: 0,
        pin: {
          id: 'pin-lost-response',
          reference: { kind: 'agent', id: 'station' },
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          order: 0,
        },
        apiBase: 'http://station.test',
      }),
    ).rejects.toThrow('network lost');
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  test('preserves validation refusal guidance', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Validation failed',
          details: { fieldErrors: { pin: ['Use an exact Task or Session.'] } },
        }),
        { status: 400 },
      ),
    );
    await expect(getSpatialBoard('http://station.test')).rejects.toThrow(
      'Use an exact Task or Session.',
    );
  });

  test('preserves a typed revision conflict for UI recovery', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          code: 'spatial_board_conflict',
          error: 'Spatial board revision conflicts with current state.',
        }),
        { status: 409 },
      ),
    );
    await expect(getSpatialBoard('http://station.test')).rejects.toMatchObject({
      name: 'SpatialBoardRequestError',
      status: 409,
      code: 'spatial_board_conflict',
      conflict: true,
    });
  });
});
