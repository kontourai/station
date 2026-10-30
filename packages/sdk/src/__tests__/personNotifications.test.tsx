// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  dismissPersonNotification,
  fetchPersonNotifications,
  markPersonNotificationRead,
  personNotificationsKey,
  usePersonNotificationsQuery,
} from '../query-domains/personNotifications';

const base = 'http://station.test';
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }));
const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('person feed queries partition same-host accounts by captured authority', async () => {
  let active = 'alice';
  const scope = (person: string) => ({
    apiBase: base,
    authorityKey: person,
    isCurrent: () => active === person,
  });
  const alice = scope('alice');
  const bob = scope('bob');
  setClientCredentialResolver(() => {
    const captured = active;
    return {
      origin: base,
      requestAuthority: {
        ...scope(captured),
        isCurrent: () => active === captured,
      },
    };
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response([{ id: 'alice-private' }]))
    .mockResolvedValueOnce(response([{ id: 'bob-private' }]));
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient();
  const view = renderHook(
    ({ current }) => usePersonNotificationsQuery(current),
    {
      wrapper: wrapper(client),
      initialProps: { current: alice },
    },
  );
  await waitFor(() =>
    expect(view.result.current.data).toEqual([{ id: 'alice-private' }]),
  );
  active = 'bob';
  view.rerender({ current: bob });
  expect(view.result.current.data).toBeUndefined();
  await waitFor(() =>
    expect(view.result.current.data).toEqual([{ id: 'bob-private' }]),
  );
  expect(client.getQueryData(personNotificationsKey(alice))).toEqual([
    { id: 'alice-private' },
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a late response after authority changes reaches neither the waiting caller nor the old cache', async () => {
  let active = 'alice';
  const scope = (person: string) => ({
    apiBase: base,
    authorityKey: person,
    isCurrent: () => active === person,
  });
  const alice = scope('alice');
  const bob = scope('bob');
  setClientCredentialResolver(() => {
    const captured = active;
    return { origin: base, requestAuthority: scope(captured) };
  });
  let release!: (response: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(response([{ id: 'bob-private' }]));
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const waiting = client.fetchQuery({
    queryKey: personNotificationsKey(alice),
    queryFn: () => fetchPersonNotifications(alice),
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  active = 'bob';
  const current = await client.fetchQuery({
    queryKey: personNotificationsKey(bob),
    queryFn: () => fetchPersonNotifications(bob),
  });
  expect(current).toEqual([{ id: 'bob-private' }]);
  release(response([{ id: 'alice-private' }]));
  await expect(waiting).rejects.toThrow();
  expect(client.getQueryData(personNotificationsKey(alice))).toBeUndefined();
  expect(client.getQueryData(personNotificationsKey(bob))).toEqual([
    { id: 'bob-private' },
  ]);
});

test('person mutations use their own encoded routes and old hosts are reported unsupported', async () => {
  const scope = { apiBase: base, authorityKey: 'alice', isCurrent: () => true };
  setClientCredentialResolver(() => ({
    origin: base,
    requestAuthority: scope,
  }));
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response({ outcome: 'read' }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })))
    .mockResolvedValueOnce(new Response('Not found', { status: 404 }))
    .mockResolvedValueOnce(new Response('Not found', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  expect(
    await markPersonNotificationRead(scope, {
      id: 'notice/one',
      clientSessionId: 'session-1',
    }),
  ).toBe('read');
  await dismissPersonNotification(scope, {
    id: 'notice/one',
    clientSessionId: 'session-1',
  });
  expect(fetch.mock.calls[0][0]).toBe(
    `${base}/api/me/notifications/notice%2Fone/read`,
  );
  expect(fetch.mock.calls[0][1]?.method).toBe('POST');
  expect(
    new Headers(fetch.mock.calls[0][1]?.headers).get(
      'x-station-client-session',
    ),
  ).toBe('session-1');
  expect(fetch.mock.calls[1][0]).toBe(
    `${base}/api/me/notifications/notice%2Fone`,
  );
  expect(fetch.mock.calls[1][1]?.method).toBe('DELETE');
  await expect(fetchPersonNotifications(scope)).rejects.toThrow(
    'does not support person notifications',
  );
  await expect(
    dismissPersonNotification(scope, { id: 'missing' }),
  ).rejects.toThrow('not found, or this Station does not support');
});
