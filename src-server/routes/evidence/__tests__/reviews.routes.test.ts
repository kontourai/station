import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  createReviewEvidenceAggregateRoutes,
  createReviewEvidenceRoutes,
} from '../reviews.js';

const request = {
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
} as const;

function app(service: Record<string, unknown>) {
  const root = new Hono();
  root.route(
    '/api/projects/:slug/reviews',
    createReviewEvidenceRoutes(service as never, {
      getUserId: () => 'user:authenticated',
      getTenantExecutionContext: () => undefined,
      reportError: vi.fn(),
    }),
  );
  return root;
}

describe('review evidence routes', () => {
  it('attributes a valid run to the authenticated requester', async () => {
    const run = vi.fn(async (_body, context) => ({
      requestId: request.requestId,
      projectSlug: 'station',
      state: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      result: {
        receipt: {
          receiptId: 'a'.repeat(64),
          requestedBy: context.requestedBy,
        },
        attachment: { status: 'not-requested' },
        cleanup: { status: 'completed' },
      },
    }));
    const response = await app({ run }).request(
      '/api/projects/station/reviews',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
    );

    expect(response.status).toBe(201);
    expect(run).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        requestedBy: { actorId: 'user:authenticated' },
        userId: 'user:authenticated',
      }),
    );
  });

  it('rejects a route/body project mismatch before execution', async () => {
    const run = vi.fn();
    const response = await app({ run }).request('/api/projects/other/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied actor attribution and exposes exact request status', async () => {
    const run = vi.fn();
    const forged = await app({ run }).request('/api/projects/station/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...request,
        reviewers: [
          { ...request.reviewers[0], actor: { actorId: 'agent:forged' } },
        ],
      }),
    });
    expect(forged.status).toBe(400);
    expect(run).not.toHaveBeenCalled();

    const status = vi.fn(async () => ({
      requestId: request.requestId,
      projectSlug: 'station',
      state: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    const response = await app({ status }).request(
      `/api/projects/station/reviews/requests/${request.requestId}`,
    );
    expect(response.status).toBe(200);
    expect(status).toHaveBeenCalledWith(request.requestId, 'station');
  });

  it('projects execution and storage failures without raw diagnostics', async () => {
    const run = vi.fn(async () => {
      throw new Error('/Users/private/provider-token exploded');
    });
    const response = await app({ run }).request(
      '/api/projects/station/reviews',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: 'review_evidence_unavailable',
        message: 'Review evidence is unavailable.',
      },
    });
  });

  it('lists and reads project-bound receipts', async () => {
    const receipt = { receiptId: 'b'.repeat(64) };
    const list = vi.fn(async () => [receipt]);
    const read = vi.fn(async () => receipt);
    const routes = app({ list, read });

    const listed = await routes.request('/api/projects/station/reviews');
    expect(await listed.json()).toEqual({ success: true, data: [receipt] });
    const found = await routes.request(
      `/api/projects/station/reviews/${receipt.receiptId}`,
    );
    expect(await found.json()).toEqual({ success: true, data: receipt });
    expect(read).toHaveBeenCalledWith(receipt.receiptId, 'station');
  });

  it('projects the cross-project Review Queue feed through the same Module', async () => {
    const aggregate = {
      receipts: [{ receiptId: 'c'.repeat(64) }],
      unavailableProjects: [
        { projectSlug: 'lost', reason: 'workspace-unreadable' },
      ],
    };
    const listAll = vi.fn(async () => aggregate);
    const response = await createReviewEvidenceAggregateRoutes(
      { listAll } as never,
      () => ['beta', 'alpha'],
    ).request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: aggregate });
    expect(listAll).toHaveBeenCalledWith(['beta', 'alpha']);
  });
});
