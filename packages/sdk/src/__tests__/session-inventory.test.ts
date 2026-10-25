import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { getSessionInventoryInput } from '../client/session-inventory';
import {
  clearSessionInventoryCache,
  sessionInventoryQueries,
} from '../session-inventory';

describe('Session inventory protected cache', () => {
  test('tombstones matching projection and loaded pages after a denied page', () => {
    const client = new QueryClient();
    const scope = { kind: 'whole-session' as const, sessionId: 'session' };
    const authority = { apiBase: 'http://station.test', authorityKey: 'epoch' };
    const projection = sessionInventoryQueries.projection(scope, authority);
    const page = sessionInventoryQueries.page(
      scope,
      'outputs',
      'next',
      authority,
    );
    const other = sessionInventoryQueries.projection(scope, {
      ...authority,
      authorityKey: 'other-epoch',
    });
    client.setQueryData(projection.queryKey, { protected: 'projection' });
    client.setQueryData(page.queryKey, { protected: 'page' });
    client.setQueryData(other.queryKey, { protected: 'other' });
    clearSessionInventoryCache(client, scope, authority);
    expect(client.getQueryData(projection.queryKey)).toBeNull();
    expect(client.getQueryData(page.queryKey)).toBeNull();
    expect(client.getQueryData(other.queryKey)).toEqual({ protected: 'other' });
  });
});

describe('Exact inventory input client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setClientCredentialResolver(undefined);
  });
  test('matches the complete input identity and rejects a neighboring turn', async () => {
    const scope = { apiBase: 'http://station.test', authorityKey: 'epoch-a' };
    setClientCredentialResolver(() => ({
      origin: scope.apiBase,
      requestAuthority: { ...scope, isCurrent: () => true },
    }));
    let turnId = 'turn-a';
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        success: true,
        data: {
          sessionId: 'session-a',
          eventId: 'input-a',
          turnId,
          input: {
            prompt: 'Compare these invoices.',
            attachments: [
              { name: 'invoice.pdf', mediaType: 'application/pdf', size: 2048 },
            ],
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      getSessionInventoryInput(
        scope.apiBase,
        'session-a',
        'input-a',
        'turn-a',
        { requestScope: scope },
      ),
    ).resolves.toEqual({
      prompt: 'Compare these invoices.',
      attachments: [
        { name: 'invoice.pdf', mediaType: 'application/pdf', size: 2048 },
      ],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://station.test/api/orchestration/sessions/session-a/inputs/input-a?turnId=turn-a',
    );
    turnId = 'turn-b';
    await expect(
      getSessionInventoryInput(
        scope.apiBase,
        'session-a',
        'input-a',
        'turn-a',
        { requestScope: scope },
      ),
    ).rejects.toThrow('Session inventory unavailable');
  });
});
