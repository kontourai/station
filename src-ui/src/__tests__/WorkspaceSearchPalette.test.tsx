// @vitest-environment jsdom
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
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
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WorkspaceSearchPalette from '../components/search/WorkspaceSearchPalette';
import { navigationStore } from '../contexts/navigation-store';

let active: { apiBase: string; authorityKey: string; isCurrent: () => boolean };
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => active,
}));
const clients: QueryClient[] = [];
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status === 200, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const scope = (authorityKey: string) => {
  const captured = {
    apiBase: 'https://station.test',
    authorityKey,
    isCurrent: () => active === captured,
  };
  return captured;
};
beforeEach(() => {
  active = scope('epoch-a');
  window.history.replaceState({}, '', '/');
  setClientCredentialResolver(() => ({
    origin: active.apiBase,
    requestAuthority: active,
  }));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function result(kind: 'task' | 'message' = 'message') {
  return {
    version: UNIFIED_SEARCH_V1,
    key: `${kind}:qualified`,
    providerId: kind === 'task' ? 'station.tasks' : 'station.messages',
    owner: { kind: 'station', stationId: 'station-a' },
    id: 'exact-event',
    kind,
    scope: {
      projectId: 'alpha',
      ...(kind === 'message'
        ? { sessionId: 'historical-a' }
        : { taskId: 'task-a' }),
    },
    title: kind === 'task' ? 'Task with no query in title' : 'Agent response',
    snippet: 'cobalt excerpt',
    matchedFields: ['snippet'],
    currentness: { state: 'current', observedAt: '2026-09-04T00:00:00Z' },
    relevance: 0.8,
    openIntent:
      kind === 'message'
        ? {
            kind: 'session-message',
            sessionId: 'historical-a',
            matchedEventId: 'exact-event',
            messageId: 'legacy-anchor',
          }
        : { kind: 'task', taskId: 'task-a', projectId: 'alpha' },
  };
}
function search(kind: 'task' | 'message' = 'message') {
  return {
    version: UNIFIED_SEARCH_V1,
    state: 'partial',
    results: [result(kind)],
    sources: [
      {
        providerId: 'station.tasks',
        owner: { kind: 'station', stationId: 'station-a' },
        state: 'unavailable',
        reason: 'source-unavailable',
      },
      {
        providerId: 'station.messages',
        owner: { kind: 'station', stationId: 'station-a' },
        state: 'available',
      },
    ],
  };
}
function page(text = 'Canonical historical A text', nextContinuation?: string) {
  return {
    state: 'available',
    page: {
      sessionId: 'historical-a',
      matchedEventId: 'exact-event',
      role: 'assistant',
      text,
      contentRevision: 'a'.repeat(64),
      offset: 0,
      ...(nextContinuation ? { nextContinuation } : {}),
    },
  };
}
function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [query, setQuery] = useState('cobalt');
  return (
    <WorkspaceSearchPalette
      query={query}
      onQueryChange={setQuery}
      onClose={onClose}
      onCommands={vi.fn()}
    />
  );
}
function mount(onClose?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <Harness onClose={onClose} />
    </QueryClientProvider>,
  );
}
test('server-ranked message survives local text mismatch, names partial source, resolves exact event and pages canonical text', async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/search') return reply(search());
    const body = JSON.parse(String(init?.body));
    expect(body.sessionId).toBe('historical-a');
    expect(body.matchedEventId).toBe('exact-event');
    expect(body.messageId).toBeUndefined();
    if (path.endsWith('/resolve-open'))
      return reply({
        state: 'resolved',
        target: {
          kind: 'session-message',
          sessionId: body.sessionId,
          matchedEventId: body.matchedEventId,
          navigationMessageId: 'legacy-anchor',
        },
      });
    expect(path).toBe('/api/search/read-message');
    return reply(
      body.continuation
        ? page('Second canonical page')
        : page(undefined, 'next-page'),
    );
  });
  vi.stubGlobal('fetch', fetch);
  mount();
  expect(await screen.findByRole('option')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('combobox'));
  expect(screen.getByText('Tasks: unavailable')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(
    (await screen.findByRole('region', { name: 'Exact matched message' }))
      .textContent,
  ).toContain('Canonical historical A text');
  expect(screen.getByText(/No assigned Agent identity available/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next text page' }));
  expect(await screen.findByText('Second canonical page')).toBeTruthy();
  expect(screen.queryByText('Canonical historical A text')).toBeNull();
  expect(
    fetch.mock.calls.every(([url]) => !String(url).includes('/conversations/')),
  ).toBe(true);
});
test('query change and repeated Enter cannot publish a superseded message open', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn((input: RequestInfo | URL) =>
    String(input).endsWith('/resolve-open')
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(reply(search())),
  );
  vi.stubGlobal('fetch', fetch);
  mount();
  await screen.findByRole('option');
  const input = screen.getByRole('combobox');
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(
    fetch.mock.calls.filter(([url]) => String(url).endsWith('/resolve-open')),
  ).toHaveLength(1);
  fireEvent.change(input, { target: { value: 'different' } });
  await act(async () => {
    finish(
      reply({
        state: 'resolved',
        target: {
          kind: 'session-message',
          sessionId: 'historical-a',
          matchedEventId: 'exact-event',
          navigationMessageId: 'legacy-anchor',
        },
      }),
    );
  });
  expect(screen.queryByText('Matched message — read-only')).toBeNull();
  expect(
    fetch.mock.calls.some(([url]) => String(url).endsWith('/read-message')),
  ).toBe(false);
});
test('a delayed dirty-state guard checks authority before requesting an exact Task open', async () => {
  let proceed!: () => void;
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('search-dirty'),
    (next) => {
      proceed = next;
    },
  );
  const fetch = vi.fn().mockImplementation(async () => reply(search('task')));
  vi.stubGlobal('fetch', fetch);
  try {
    mount();
    await screen.findByRole('option');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    await waitFor(() => expect(proceed).toBeTypeOf('function'));
    active = scope('epoch-b');
    await act(async () => {
      proceed();
    });
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith('/resolve-open')),
    ).toBe(false);
    expect(window.location.pathname).toBe('/');
  } finally {
    unregister();
  }
});

test('authority replacement during exact-page read suppresses old text and permits a fresh scoped search', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/read-message'))
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    if (path.endsWith('/resolve-open'))
      return Promise.resolve(
        reply({
          state: 'resolved',
          target: {
            kind: 'session-message',
            sessionId: 'historical-a',
            matchedEventId: 'exact-event',
            navigationMessageId: 'legacy-anchor',
          },
        }),
      );
    return Promise.resolve(reply(search()));
  });
  vi.stubGlobal('fetch', fetch);
  const view = mount();
  await screen.findByRole('option');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  active = scope('epoch-b');
  view.rerender(
    <QueryClientProvider client={clients[0]!}>
      <Harness />
    </QueryClientProvider>,
  );
  await act(async () => {
    finish(reply(page('SECRET FROM OLD AUTHORITY')));
  });
  expect(screen.queryByText('SECRET FROM OLD AUTHORITY')).toBeNull();
  expect(screen.queryByText('Matched message — read-only')).toBeNull();
  expect(await screen.findByRole('option')).toBeTruthy();
});

test('a denied exact open keeps the palette and does not read another message', async () => {
  const fetch = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      reply(
        String(input).endsWith('/resolve-open')
          ? { state: 'not-found' }
          : search(),
      ),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  mount();
  await screen.findByRole('option');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(
    await screen.findByText(
      'This exact message is unavailable. No other Session was opened.',
    ),
  ).toBeTruthy();
  expect(
    fetch.mock.calls.some(([url]) => String(url).endsWith('/read-message')),
  ).toBe(false);
});

test('a new query never inherits completed source or empty verdicts during debounce', async () => {
  let finish!: (response: Response) => void;
  const complete = {
    ...search(),
    state: 'complete',
    sources: search().sources.map(({ providerId, owner }) => ({
      providerId,
      owner,
      state: 'available',
    })),
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(reply(complete))
    .mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetch);
  mount();
  await screen.findByRole('option');
  expect(screen.getByText('Tasks: available')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: 'new query' },
  });
  expect(screen.queryByRole('option')).toBeNull();
  expect(screen.queryByText('Tasks: available')).toBeNull();
  expect(screen.queryByText('No matching work on this Station')).toBeNull();
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.queryByText('No matching work on this Station')).toBeNull();
  await act(async () => {
    finish(reply({ ...complete, results: [] }));
  });
  expect(
    await screen.findByText('No matching work on this Station'),
  ).toBeTruthy();
});
