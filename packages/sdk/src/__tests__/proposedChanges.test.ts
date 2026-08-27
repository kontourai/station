import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  approveProposedChange,
  bulkRejectProposedChanges,
  fetchProposedChanges,
  proposedChangesQueryKey,
} from '../query-domains/proposedChanges';

describe('proposedChanges query domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('builds a stable query key from filters', () => {
    expect(
      proposedChangesQueryKey({
        projectId: 'project-a',
        status: ['pending'],
      }),
    ).toEqual([
      'proposed-changes',
      {
        projectId: 'project-a',
        status: ['pending'],
      },
    ]);
  });

  it('fetches proposed changes with status, session, and project filters', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: [{ id: 'change-1' }] }),
    } as Response);

    await expect(
      fetchProposedChanges({
        status: ['pending', 'rejected'],
        sessionId: 'session-1',
        projectId: 'project-a',
      }),
    ).resolves.toEqual([{ id: 'change-1' }]);

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/proposed-changes?status=pending&status=rejected&sessionId=session-1&projectId=project-a',
    );
  });

  it('posts single and bulk decisions through the API contract', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { id: 'change-1' } }),
    } as Response);

    await expect(
      approveProposedChange({
        id: 'change-1',
        decision: { reason: 'good' },
      }),
    ).resolves.toEqual({ id: 'change-1' });
    const [approveUrl, approveInit] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(approveUrl).toBe(
      'http://example.test/api/proposed-changes/change-1/approve',
    );
    expect(approveInit.method).toBe('POST');
    expect(approveInit.body).toBe(JSON.stringify({ reason: 'good' }));
    expect(new Headers(approveInit.headers).get('Content-Type')).toBe(
      'application/json',
    );

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: [{ id: 'change-2' }] }),
    } as Response);

    await expect(
      bulkRejectProposedChanges({
        ids: ['change-2'],
        reason: 'wrong',
      }),
    ).resolves.toEqual([{ id: 'change-2' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [rejectUrl, rejectInit] = vi.mocked(fetch).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(rejectUrl).toBe(
      'http://example.test/api/proposed-changes/bulk/reject',
    );
    expect(rejectInit.method).toBe('POST');
    expect(rejectInit.body).toBe(
      JSON.stringify({ ids: ['change-2'], reason: 'wrong' }),
    );
    expect(new Headers(rejectInit.headers).get('Content-Type')).toBe(
      'application/json',
    );
  });
});
