import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { createAttentionRoutes } from '../attention.js';

describe('Attention Routes', () => {
  test('GET / returns the read-only attention projection', async () => {
    const list = vi.fn().mockResolvedValue({
      pendingCount: 1,
      items: [
        {
          id: 'review_pending:thread-1',
          kind: 'review_pending',
          title: 'Review pending',
          createdAt: '2026-07-23T12:00:00.000Z',
          updatedAt: '2026-07-23T12:00:00.000Z',
          openHref: '/sessions?session=thread-1',
          source: { threadId: 'thread-1' },
        },
      ],
    });
    const app = createAttentionRoutes({ list } as never);

    const response = await app.request('/');
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: expect.objectContaining({ pendingCount: 1 }),
    });
    expect(list).toHaveBeenCalledOnce();
  });

  test('POST /:id/ack acknowledges a session-failed item', async () => {
    const acknowledge = vi.fn().mockResolvedValue(true);
    const app = createAttentionRoutes({
      list: vi.fn(),
      acknowledge,
    } as never);

    const response = await app.request('/session-failed:thread-1/ack', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(acknowledge).toHaveBeenCalledWith('session-failed:thread-1');
  });

  test('POST /:id/ack 404s for an item that does not resolve', async () => {
    const acknowledge = vi.fn().mockResolvedValue(false);
    const app = createAttentionRoutes({
      list: vi.fn(),
      acknowledge,
    } as never);

    const response = await app.request('/no-such-item/ack', {
      method: 'POST',
    });
    const body = await json(response);

    expect(response.status).toBe(404);
    expect(body).toEqual(expect.objectContaining({ success: false }));
  });

  test('threads request authority through both session-derived reads and acknowledgement', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'alpha',
      undefined,
      undefined,
    );
    const list = vi.fn().mockResolvedValue({ pendingCount: 0, items: [] });
    const acknowledge = vi.fn().mockResolvedValue(true);
    const app = createAttentionRoutes({ list, acknowledge } as never, {
      readAuthorityForRequest: () => authority,
    });

    await app.request('/');
    await app.request('/session-failed:alpha/ack', { method: 'POST' });

    expect(list).toHaveBeenCalledWith(authority);
    expect(acknowledge).toHaveBeenCalledWith('session-failed:alpha', authority);
  });
});
