// @vitest-environment jsdom
import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ConversationInboxMessages } from '../components/chat/ConversationInboxMessages';
import type { PendingMessageMetadata } from '../contexts/active-chats-state';
import {
  INBOX_ACTIVE_POLL_MS,
  INBOX_IDLE_POLL_MS,
} from '../hooks/useConversationInbox';
import { shouldPersistQuery } from '../lib/queryPersistence';

function expand() {
  fireEvent.click(
    screen.getByRole('button', { name: /pending message|Held messages/ }),
  );
}

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
vi.mock('../hooks/useQueuedMessages', () => ({
  useQueuedMessages: () => ({
    editingIndex: null,
    editValue: '',
    setEditValue: vi.fn(),
    startEdit: vi.fn(),
    cancelEdit: vi.fn(),
    saveEdit: vi.fn(),
    remove: vi.fn(),
    moveUp: vi.fn(),
    moveDown: vi.fn(),
  }),
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

type Local = { messages: string[]; metadata?: PendingMessageMetadata[] };

function mount(local: Local = { messages: [] }) {
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
      <ConversationInboxMessages
        conversationId="conversation"
        sessionId="session"
        messages={local.messages}
        metadata={local.metadata}
      />
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
  // Every row the list shows counts (queued, sending, may have been sent);
  // a sent one is not listed, so it does not.
  await screen.findByText('3 pending');
  expand();
  expect(screen.getByText('another sender')).toBeTruthy();
  expect(screen.getByText('May have been sent')).toBeTruthy();
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
  const { client } = mount();
  await screen.findByText('1 pending');
  failed = true;
  await act(() => client.refetchQueries({ queryKey: ['conversation-inbox'] }));
  await screen.findByText('Couldn’t load held messages.');
  expect(screen.queryByText(/0 pending/)).toBeNull();
  // The last-read rows are not shown as if current; they collapse away.
  await waitFor(() => expect(screen.queryByText('own')).toBeNull());
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
  await screen.findByText('1 pending');
  expand();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Remove held message: own' }),
  );
  await screen.findByRole('alert');
  expect(screen.getByText('own')).toBeTruthy();
  await waitFor(() => expect(methods).toEqual(['GET', 'DELETE', 'GET']));
});

test('successful removal targets the exact key and an older read cannot restore it or remove a same-text sibling', async () => {
  const first = { ...entry('queued', 'own/first'), message: 'same text' };
  const second = { ...entry('queued', 'own/second'), message: 'same text' };
  let releaseOld!: (answer: Response) => void;
  const oldRead = new Promise<Response>((resolve) => {
    releaseOld = resolve;
  });
  const deletions: string[] = [];
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit | undefined) => {
      if (init?.method === 'DELETE') {
        deletions.push(url);
        return new Response(
          JSON.stringify({
            success: true,
            data: { entry: { ...first, state: 'cancelled' } },
          }),
        );
      }
      reads += 1;
      if (reads === 1) return response([first, second]);
      if (reads === 2) return oldRead;
      return response([{ ...first, state: 'cancelled' }, second]);
    }),
  );
  const { client } = mount();
  await screen.findByText('2 pending');
  expand();
  const previous = client.refetchQueries({ queryKey: ['conversation-inbox'] });
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(
    screen.getAllByRole('button', {
      name: 'Remove held message: same text',
    })[0],
  );
  await screen.findByText('1 pending');
  await waitFor(() => expect(screen.getAllByText('same text')).toHaveLength(1));
  releaseOld(response([first, second]));
  await previous;
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.getByText('1 pending')).toBeTruthy();
  expect(screen.getAllByText('same text')).toHaveLength(1);
  expect(deletions).toEqual([
    'http://station.test/api/orchestration/conversations/conversation/inbox/own%2Ffirst',
  ]);
});

test('an empty inbox renders nothing, before and after any number of reads', async () => {
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      reads += 1;
      return response([entry('sent', 'done'), entry('cancelled', 'gone')]);
    }),
  );
  const { client, container } = mount();
  await waitFor(() => expect(reads).toBe(1));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(container.innerHTML).toBe('');
  await act(() => client.refetchQueries({ queryKey: ['conversation-inbox'] }));
  expect(reads).toBe(2);
  expect(container.innerHTML).toBe('');
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText(/Refresh/)).toBeNull();
});

test('a background read leaves the rendered list exactly as it was', async () => {
  let release: ((value: Response) => void) | undefined;
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      reads += 1;
      if (reads === 1)
        return Promise.resolve(response([entry('queued', 'own')]));
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  const { client, container } = mount();
  await screen.findByText('1 pending');
  // Let the arrival settle so only the read itself could change the DOM.
  await waitFor(() =>
    expect(container.querySelector('[data-phase="entering"]')).toBeNull(),
  );
  const before = container.innerHTML;
  const refetch = client.refetchQueries({ queryKey: ['conversation-inbox'] });
  await waitFor(() => expect(client.isFetching()).toBe(1));
  expect(container.innerHTML).toBe(before);
  release?.(response([entry('queued', 'own')]));
  await act(() => refetch);
  expect(container.innerHTML).toBe(before);
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
});

test('local and Station-held follow-ups share one list, counted once per message', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response([
        { ...entry('queued', 'both'), message: 'queued here and held' },
        { ...entry('queued', 'remote'), message: 'from another client' },
      ]),
    ),
  );
  mount({
    messages: ['queued here and held', 'only local'],
    metadata: [
      { id: 'both', mode: 'queue' },
      { id: 'local-only', mode: 'queue' },
    ],
  });
  await screen.findByText('3 pending');
  expect(
    screen.getAllByRole('button', { name: /pending message/ }),
  ).toHaveLength(1);
  expand();
  // Before the first read answered, the local copy was the only one; it
  // collapses away once Station's copy is known.
  await waitFor(() =>
    expect(screen.getAllByText('queued here and held')).toHaveLength(1),
  );
  expect(screen.getByText('only local')).toBeTruthy();
  expect(screen.getByText('from another client')).toBeTruthy();
  // The duplicate shows as the copy Station holds, removable through it.
  expect(
    screen.getByRole('button', {
      name: 'Remove held message: queued here and held',
    }),
  ).toBeTruthy();
  const lists = document.querySelectorAll('.queued-messages__list');
  expect(lists).toHaveLength(1);
  expect(lists[0].textContent).toContain('from another client');
  expect(lists[0].textContent).toContain('only local');
});

test('a held message that leaves collapses in place, then is removed', async () => {
  let answer = [entry('queued', 'first'), entry('queued', 'second')];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(answer)),
  );
  const { client, container } = mount();
  await screen.findByText('2 pending');
  answer = [{ ...answer[0], state: 'sent' }, answer[1]];
  await act(() => client.refetchQueries({ queryKey: ['conversation-inbox'] }));
  await screen.findByText('1 pending');
  const leaving = container.querySelector('[data-phase="exiting"]');
  expect(leaving?.textContent).toContain('first');
  expect(leaving?.getAttribute('aria-hidden')).toBe('true');
  expect(leaving?.hasAttribute('inert')).toBe(true);
  fireEvent.animationEnd(leaving as Element);
  await waitFor(() => expect(screen.queryByText('first')).toBeNull());
  expect(screen.getByText('second')).toBeTruthy();
  // The last one leaving takes the whole surface with it, the same way.
  answer = [{ ...answer[1], state: 'cancelled' }];
  await act(() => client.refetchQueries({ queryKey: ['conversation-inbox'] }));
  const surface = await waitFor(() => {
    const node = container.querySelector(
      '.queued-messages-presence[data-phase="exiting"]',
    );
    expect(node).not.toBeNull();
    return node as Element;
  });
  fireEvent.animationEnd(surface);
  await waitFor(() => expect(container.innerHTML).toBe(''));
});

test('reads every 2s while anything is held, and slowly while nothing is', async () => {
  let answer: ConversationInboxEntry[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(answer)),
  );
  const { client } = mount();
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const interval = () => {
    const query = client.getQueryCache().getAll()[0];
    // The observer's options land on the query at runtime; QueryOptions'
    // type omits the observer-only `refetchInterval`.
    const option = (query.options as { refetchInterval?: unknown })
      .refetchInterval as (q: typeof query) => unknown;
    return option(query);
  };
  expect(interval()).toBe(INBOX_IDLE_POLL_MS);
  answer = [entry('queued', 'own')];
  await act(() => client.refetchQueries({ queryKey: ['conversation-inbox'] }));
  expect(interval()).toBe(INBOX_ACTIVE_POLL_MS);
  expect(INBOX_ACTIVE_POLL_MS).toBe(2_000);
  expect(INBOX_IDLE_POLL_MS).toBe(15_000);
});
