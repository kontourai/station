import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';
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
    expect(client.getQueryData(projection.queryKey)).toBeUndefined();
    expect(client.getQueryData(page.queryKey)).toBeUndefined();
    expect(client.getQueryData(other.queryKey)).toEqual({ protected: 'other' });
  });
});
