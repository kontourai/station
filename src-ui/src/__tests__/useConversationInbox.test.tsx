// @vitest-environment jsdom
import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ConversationInboxMessages } from '../components/chat/ConversationInboxMessages';
import { shouldPersistQuery } from '../lib/queryPersistence';

const authority = vi.hoisted(() => ({
  current: {
    apiBase: 'http://station.test',
    authorityKey: 'device-a',
    requiresEnrolledCredential: false,
    isCurrent: (): boolean => true,
  },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authority.current,
}));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  authority.current = {
    apiBase: 'http://station.test',
    authorityKey: 'device-a',
    requiresEnrolledCredential: false,
    isCurrent: () => true,
  };
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function entry(
  state: ConversationInboxEntry['state'],
  key?: string,
): ConversationInboxEntry {
  return {
    conversationId: 'conversation',
    clientTurnId: key,
    kind: 'follow-up',
    state,
    message: key ?? 'another sender',
    createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T00:00:00Z',
  };
}

function response(entries: ConversationInboxEntry[]) {
  return new Response(JSON.stringify({ success: true, data: { entries } }), {
    headers: { 'content-type': 'application/json' },
  });
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  setClientCredentialResolver(() => ({
    origin: authority.current.apiBase,
    requestAuthority: authority.current,
  }));
  const view = () => (
    <QueryClientProvider client={client}>
      <ConversationInboxMessages conversationId="conversation" />
    </QueryClientProvider>
  );
  return { client, ...render(view()), view };
}

test('shows actual server states and keeps keyless entries read-only without persisting the query', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response([
        entry('queued', 'own'),
        entry('sending', 'sending'),
        entry('unconfirmed'),
        entry('sent', 'sent'),
      ]),
    ),
  );
  const { client } = mount();
  await screen.findByText('2 pending messages held by Station');
  expect(screen.getByText('another sender')).toBeTruthy();
  expect(
    screen.getByText('Sent, outcome unknown. Station will not resend it.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Dismiss held/ })).toBeNull();
  expect(
    screen.queryByRole('button', { name: /Remove held message: sending/ }),
  ).toBeNull();
  expect(screen.queryByText('sent', { exact: true })).toBeNull();
  const query = client.getQueryCache().getAll()[0];
  expect(query).toBeDefined();
  expect(shouldPersistQuery(query)).toBe(false);
});

test('a failed refresh makes a previously available count unavailable, never zero', async () => {
  let failed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      failed
        ? new Response(
            JSON.stringify({ success: false, error: 'unavailable' }),
            { status: 503 },
          )
        : response([entry('queued', 'own')]),
    ),
  );
  mount();
  await screen.findByText('1 pending message held by Station');
  failed = true;
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Messages held by Station are unavailable.');
  expect(screen.queryByText('0 pending messages held by Station')).toBeNull();
  expect(
    screen.queryByRole('button', { name: /Remove held message/ }),
  ).toBeNull();
});

test('retired authority cannot publish a late answer into the next authority view', async () => {
  let release!: (value: Response) => void;
  const first = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      ++reads === 1
        ? first
        : Promise.resolve(response([entry('queued', 'new authority')])),
    ),
  );
  const { client, rerender, view } = mount();
  await waitFor(() => expect(reads).toBe(1));
  const previous = authority.current;
  previous.isCurrent = () => false;
  authority.current = {
    ...previous,
    authorityKey: 'device-b',
    isCurrent: () => true,
  };
  rerender(view());
  await screen.findByText('new authority');
  release(response([entry('queued', 'retired authority')]));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.queryByText('retired authority')).toBeNull();
  expect(screen.getByText('new authority')).toBeTruthy();
});

test('a refused removal stays visible and refreshes rather than fabricating a cancelled entry', async () => {
  const methods: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init: RequestInit | undefined) => {
      methods.push(init?.method ?? 'GET');
      return init?.method === 'DELETE'
        ? new Response(
            JSON.stringify({
              success: false,
              error: 'already sending',
              code: 'inbox_entry_sending',
            }),
            { status: 409 },
          )
        : response([entry('queued', 'own')]);
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Remove held message: own' }),
  );
  await screen.findByRole('alert');
  expect(screen.getByText('own')).toBeTruthy();
  await waitFor(() => expect(methods).toEqual(['GET', 'DELETE', 'GET']));
});
