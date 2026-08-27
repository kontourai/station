import type { IndependentReviewRequest } from '@kontourai/station-contracts/review-evidence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setClientRequestTimeout } from '../client/http.js';
import {
  getReviewReceipt,
  listAllReviewReceipts,
  listReviewReceipts,
  runIndependentReview,
} from '../client/reviews.js';

const request: IndependentReviewRequest = {
  requestId: 'request-1',
  mode: 'initial',
  target: {
    kind: 'git-range',
    projectSlug: 'station',
    baseRevision: 'origin/main',
    headRevision: 'HEAD',
  },
  implementerAgentSlug: 'terra',
  reviewers: [
    {
      reviewerId: 'sol-1',
      executorAgentSlug: 'reviewer-agent',
      lens: { id: 'failure-totality', instructions: 'Review exact outcomes.' },
    },
  ],
};

const receipt = {
  schemaVersion: 1,
  receiptId: 'a'.repeat(64),
  requestId: 'request-1',
  mode: 'initial',
  target: {
    ...request.target,
    repositoryId: 'github.com/kontourai/station',
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    diffSha256: '3'.repeat(64),
  },
  requestedBy: { actorId: 'user:operator' },
  implementer: { actorId: 'agent:terra' },
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
  executions: [
    {
      reviewerId: 'sol-1',
      executorAgentSlug: 'reviewer-agent',
      actor: { actorId: 'agent:sol' },
      lens: request.reviewers[0].lens,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      findings: [],
      deltaAssessments: [],
    },
  ],
  findings: [],
  deltaAssessments: [],
  interpretation: {
    kind: 'review-findings',
    decision: 'input-only',
    gateVerdict: null,
  },
} as const;

afterEach(() => {
  setClientRequestTimeout(undefined);
  vi.unstubAllGlobals();
});

describe('review evidence client', () => {
  it('uses the same project-scoped API for run, list, and read', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              requestId: request.requestId,
              projectSlug: 'station',
              state: 'completed',
              startedAt: receipt.startedAt,
              updatedAt: receipt.completedAt,
              result: {
                receipt,
                attachment: { status: 'not-requested' },
                cleanup: { status: 'completed' },
              },
            },
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: [receipt] })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: receipt })),
      );
    vi.stubGlobal('fetch', fetch);

    await expect(
      runIndependentReview('http://station', request),
    ).resolves.toMatchObject({ receipt: { receiptId: receipt.receiptId } });
    await expect(
      listReviewReceipts('http://station', 'station'),
    ).resolves.toEqual([receipt]);
    await expect(
      getReviewReceipt('http://station', 'station', receipt.receiptId),
    ).resolves.toEqual(receipt);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://station/api/projects/station/reviews',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(request),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      `http://station/api/projects/station/reviews/${receipt.receiptId}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('reads the total cross-project aggregate with its unavailable projects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                receipts: [receipt],
                unavailableProjects: [
                  { projectSlug: 'lost', reason: 'workspace-unreadable' },
                ],
              },
            }),
          ),
      ),
    );
    await expect(listAllReviewReceipts('http://station')).resolves.toEqual({
      receipts: [receipt],
      unavailableProjects: [
        { projectSlug: 'lost', reason: 'workspace-unreadable' },
      ],
    });
  });

  it('rejects a pre-aggregate bare-array review-evidence payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: [receipt] })),
      ),
    );
    await expect(listAllReviewReceipts('http://station')).rejects.toThrow();
  });

  it('rejects a malformed success envelope instead of widening receipt truth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: true, data: [{ receiptId: 'x' }] }),
          ),
      ),
    );
    await expect(
      listReviewReceipts('http://station', 'station'),
    ).rejects.toThrow();
  });

  it('does not inherit the short headless timeout for a bounded long-running review', async () => {
    setClientRequestTimeout(5);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason),
            );
            setTimeout(
              () =>
                resolve(
                  new Response(
                    JSON.stringify({
                      success: true,
                      data: completedStatus(),
                    }),
                  ),
                ),
              15,
            );
          }),
      ),
    );

    await expect(
      runIndependentReview('http://station', request),
    ).resolves.toMatchObject({ receipt: { receiptId: receipt.receiptId } });
  });

  it('recovers an ambiguous POST response through the caller request identity', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response connection lost'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, data: completedStatus() }),
        ),
      );
    vi.stubGlobal('fetch', fetch);

    await expect(
      runIndependentReview('http://station', request),
    ).resolves.toMatchObject({ receipt: { receiptId: receipt.receiptId } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'http://station/api/projects/station/reviews/requests/request-1',
    );
  });
});

function completedStatus() {
  return {
    requestId: request.requestId,
    projectSlug: 'station',
    state: 'completed',
    startedAt: receipt.startedAt,
    updatedAt: receipt.completedAt,
    result: {
      receipt,
      attachment: { status: 'not-requested' },
      cleanup: { status: 'completed' },
    },
  };
}
