import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTENTION_SNOOZE_MAX_MS } from '@kontourai/station-contracts/attention';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { AttentionProjectionService } from '../../../services/projects/attention-projection.js';
import { FileAttentionSnoozeStore } from '../../../services/projects/attention-snooze-store.js';
import { createLogger } from '../../../utils/logger.js';
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

  test('#2323 S5 review M6: GET / tells the projection whether the viewer is the operator, and fails closed without a resolver', async () => {
    const list = vi.fn().mockResolvedValue({ pendingCount: 0, items: [] });
    await createAttentionRoutes({ list } as never, {
      viewerIsOperator: () => true,
    }).request('/');
    await createAttentionRoutes({ list } as never, {
      viewerIsOperator: () => false,
    }).request('/');
    await createAttentionRoutes({ list } as never).request('/');
    expect(list.mock.calls.map((call) => call[1]?.isOperator)).toEqual([
      true,
      false,
      false,
    ]);
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

  /**
   * Contract pin (#890 review). The SDK's `acknowledgeAttentionItem` treats a
   * 404 carrying THIS EXACT message as a no-op — the item left the projection
   * between render and click, which is not a failure worth reporting — while
   * letting every other 404 propagate. That discrimination is only sound while
   * the message is stable, and nothing else pins it, so changing the string
   * below without updating `packages/sdk/src/query-domains/attention.ts` must
   * fail here rather than silently turn benign staleness back into a rendered
   * error in the user's inbox.
   */
  test('the 404 body carries the exact message the SDK discriminates on', async () => {
    const app = createAttentionRoutes({
      list: vi.fn(),
      acknowledge: vi.fn().mockResolvedValue(false),
    } as never);

    const response = await app.request('/no-such-item/ack', { method: 'POST' });

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Attention item is not acknowledgeable',
    });
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

    // The second argument arrived with #765 D5 (`viewerCanDecide` is derived
    // from the request principal, and defaults closed when no predicate is
    // wired). Asserted explicitly rather than relaxed to `expect.anything()`:
    // the fail-closed `false` is the security-relevant half of this call.
    expect(list).toHaveBeenCalledWith(authority, {
      mayDecidePairingRequests: false,
      isOperator: false,
    });
    expect(acknowledge).toHaveBeenCalledWith('session-failed:alpha', authority);
  });
});

describe('attention snooze HTTP routes with real projection and persistence', () => {
  const tempDir = trackTempDirs();
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  const until = new Date(now + 3_600_000).toISOString();
  async function fixture(enabled = true) {
    const home = tempDir('attention-snooze-http-');
    const registry = new FeaturePreviewRegistry(
      home,
      createLogger({ name: 'snooze-http' }),
    );
    const preview = registry.bind({
      id: 'attention-snooze',
      label: 'Attention snooze',
      description: 'Test',
    });
    if (enabled) await registry.setEnabled('attention-snooze', true);
    const projection = new AttentionProjectionService(
      { list: () => [] } as never,
      { listSessionReadModel: async () => [] } as never,
      { getRunConsole: async () => ({ gates: [] }) } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ({
        agentSlug: 'station',
        agentName: 'Station',
        reason: 'Configure a connection',
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      { store: new FileAttentionSnoozeStore(home), preview, now: () => now },
    );
    const app = new Hono();
    app.route(
      '/api/attention',
      createAttentionRoutes(projection, {
        readAuthorityForRequest: (request) =>
          sessionReadAuthorityFromRequest(
            request.headers.get('x-test-user') ?? 'alpha',
            undefined,
            undefined,
          ),
      }),
    );
    const initial = await json(await app.request('/api/attention'));
    const id = initial.data.items[0].id;
    const path = `/api/attention/${encodeURIComponent(id)}/snooze`;
    return {
      app,
      path,
      id,
      registry,
      home,
      version: initial.data.items[0].updatedAt,
    };
  }

  test('POST returns the active deadline; request authority scopes reads and idempotent DELETE', async () => {
    const { app, path, id, home, version } = await fixture();
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ until, version: '2999-01-01T00:00:00Z' }),
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      success: true,
      data: { snoozedUntil: until },
    });
    expect(
      JSON.parse(readFileSync(join(home, 'attention-snoozes.json'), 'utf8'))
        .snoozes.alpha[id].version,
    ).toBe(version);
    expect(
      (await json(await app.request('/api/attention'))).data,
    ).toMatchObject({ pendingCount: 0, items: [{ id, snoozedUntil: until }] });
    expect(
      (
        await json(
          await app.request('/api/attention', {
            headers: { 'x-test-user': 'beta' },
          }),
        )
      ).data.pendingCount,
    ).toBe(1);
    expect(
      (
        await app.request(path, {
          method: 'DELETE',
          headers: { 'x-test-user': 'beta' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await json(await app.request('/api/attention'))).data.pendingCount,
    ).toBe(0);
    for (let i = 0; i < 2; i++) {
      const deleted = await app.request(path, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      expect(await json(deleted)).toEqual({ success: true });
    }
    const restored = (await json(await app.request('/api/attention'))).data;
    expect(restored.pendingCount).toBe(1);
    expect(restored.items[0]).not.toHaveProperty('snoozedUntil');
    expect(
      (await app.request('/api/attention/missing/snooze', { method: 'DELETE' }))
        .status,
    ).toBe(200);
  });

  test.each([
    ['past', new Date(now - 1).toISOString(), 'future'],
    ['now', new Date(now).toISOString(), 'future'],
    [
      'max plus one',
      new Date(now + ATTENTION_SNOOZE_MAX_MS + 1).toISOString(),
      '30 days',
    ],
    ['malformed', 'tomorrow', 'ISO timestamp'],
    ['invalid calendar date', '2026-11-31T12:00:00Z', 'ISO timestamp'],
    ['without timezone', '2026-10-29T12:00:00', 'ISO timestamp'],
    ['wrong type', 123, 'ISO timestamp'],
    ['missing', undefined, 'ISO timestamp'],
  ])(
    'rejects %s with 400 and leaves pending unchanged',
    async (_label, value, error) => {
      const { app, path } = await fixture();
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: value }),
      });
      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({
        success: false,
        error: expect.stringContaining(error),
      });
      expect(
        (await json(await app.request('/api/attention'))).data.pendingCount,
      ).toBe(1);
    },
  );

  test('accepts exactly 30 days and refuses an unknown item', async () => {
    const { app, path } = await fixture();
    expect(
      (
        await app.request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            until: new Date(now + ATTENTION_SNOOZE_MAX_MS).toISOString(),
          }),
        })
      ).status,
    ).toBe(200);
    const response = await app.request('/api/attention/missing/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ until }),
    });
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Attention item not found',
    });
  });

  test('normalizes an ISO timestamp with an offset to UTC', async () => {
    const { app, path } = await fixture();
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ until: '2026-10-28T09:00:00-04:00' }),
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      success: true,
      data: { snoozedUntil: until },
    });
  });

  test('malformed JSON is a 400, never a successful snooze', async () => {
    const { app, path } = await fixture();
    expect(
      (await app.request(path, { method: 'POST', body: '{' })).status,
    ).toBe(400);
  });

  test('the off preview refuses both mutations and changes live after composition', async () => {
    const { app, path, registry, home } = await fixture(false);
    for (const method of ['POST', 'DELETE']) {
      const response = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ until }) : undefined,
      });
      expect(response.status).toBe(404);
      expect(await json(response)).toMatchObject({
        success: false,
        code: 'feature_preview_disabled',
        previewId: 'attention-snooze',
      });
    }
    expect(existsSync(join(home, 'attention-snoozes.json'))).toBe(false);
    await registry.setEnabled('attention-snooze', true);
    expect(
      (
        await app.request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ until }),
        })
      ).status,
    ).toBe(200);
  });
});
