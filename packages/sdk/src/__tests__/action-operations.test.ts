import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../client/http.js', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

import {
  cancelActionOperation,
  fetchActionOperations,
  watchActionOperations,
} from '../client/action-operations.js';

const operation = {
  schemaVersion: 'station.action-operation/v1',
  id: 'handoff-1',
  sequence: 1,
  changeSequence: 2,
  revision: 2,
  scope: { accountId: 'account-a', sessionId: 'session-a' },
  status: 'running',
  title: 'Continue attached session',
  progress: { kind: 'phase', code: 'creating-continuation' },
  cancellation: 'supported',
  domain: { kind: 'session-handoff', sourceSessionId: 'session-a' },
  reentry: { kind: 'session', sessionId: 'session-a' },
  acceptedAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:01.000Z',
};

beforeEach(() => mocks.authenticatedFetch.mockReset());

describe('action operation SDK transport', () => {
  test('loads the canonical paged envelope', async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { schemaVersion: operation.schemaVersion, items: [operation] },
      }),
    } as Response);
    await expect(
      fetchActionOperations('http://station.test'),
    ).resolves.toMatchObject({ items: [{ id: 'handoff-1' }] });
    expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      'http://station.test/api/action-operations',
    );
  });

  test('preserves the explicit reconnect snapshot mode and cursor', async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          schemaVersion: operation.schemaVersion,
          items: [operation],
          mode: 'delta',
          cursor: 'djE6MQ',
        },
      }),
    } as Response);
    await expect(
      watchActionOperations('http://station.test', 'djE6Mg'),
    ).resolves.toMatchObject({ mode: 'delta', cursor: 'djE6MQ' });
    expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      'http://station.test/api/action-operations/watch?cursor=djE6Mg',
    );
  });

  test('does not turn a cancellation conflict into a locally-cancelled operation', async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: 'Cancellation is unavailable',
      }),
    } as Response);
    await expect(
      cancelActionOperation('http://station.test', 'handoff-1'),
    ).rejects.toThrow('Cancellation is unavailable');
  });
});
