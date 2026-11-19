/** @vitest-environment jsdom */

import { _setApiBase } from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The coordinator (#5063) has its own tests; these rooms run with its
// preview off, as a Station that never turned it on.
vi.mock('../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set<string>(),
}));

import { setClientCredentialResolver } from '../../../../packages/sdk/src/client/http';
import { navigationStore } from '../../contexts/navigation-store';

// This host serves the shared live stream, typing and the member directory
// (#4798, #4799); the handshake itself has its own suite.
vi.mock(
  '../../../../packages/sdk/src/client/project-room-live',
  async (original) => ({
    ...(await original<
      typeof import('../../../../packages/sdk/src/client/project-room-live')
    >()),
    readProjectRoomLiveCapability: async () => true,
  }),
);
const { ProjectRoom } = await import('./ProjectRoom');

const roomId = '11111111-1111-4111-8111-111111111111';
const requestScope = { apiBase: 'https://live.example', authorityKey: 'one' };
const ada = { id: 'human:deployment:ada', displayName: 'Ada', kind: 'person' };
const lin = { id: 'human:deployment:lin', displayName: 'Lin', kind: 'person' };
const scope = {
  stationId: 'station',
  localProjectId: 'project',
  localProjectSlug: 'team',
  portableProjectId: 'portable',
};
const at = '2026-11-15T12:00:00.000Z';
let messages: Array<Record<string, unknown>>;
let members: Array<typeof ada>;
let writes: Array<Record<string, unknown>>;
let typing: Array<Record<string, unknown>>;
let live: ReadableStreamDefaultController<Uint8Array>[];
let requestIds: string[];
let agentCalls: Array<{ path: string; body: Record<string, unknown> }>;

function push(event: string, data: Record<string, unknown>) {
  for (const stream of live)
    stream.enqueue(
      new TextEncoder().encode(
        `event: ${event}\ndata: ${JSON.stringify({ key: roomId, ...data })}\n\n`,
      ),
    );
}
function message(
  seq: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    intentId: randomCorrelationId(),
    text,
    roomId,
    messageId: randomCorrelationId(),
    seq,
    actor: lin,
    createdAt: at,
    ...extra,
  };
}
beforeEach(() => {
  sessionStorage.clear();
  messages = [];
  members = [ada, lin];
  writes = [];
  typing = [];
  live = [];
  agentCalls = [];
  requestIds = [];
  _setApiBase(requestScope.apiBase);
  setClientCredentialResolver(() => ({
    origin: requestScope.apiBase,
    requestAuthority: { ...requestScope, isCurrent: () => true },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const ok = (data: unknown) => Response.json({ success: true, data });
      if (url.pathname === '/api/agents')
        return ok([{ slug: 'writer', name: 'Writer' }]);
      if (url.pathname.includes('/room/agents')) {
        agentCalls.push({ path: url.pathname, body });
        const handle = (state: string, extra: Record<string, unknown> = {}) =>
          ok({
            intentId: agentCalls[0]?.body.intentId,
            agentId: 'writer',
            text: 'Draft the notes',
            roomId,
            requestId: requestIds.at(-1),
            actor: ada,
            state,
            createdAt: at,
            updatedAt: at,
            ...extra,
          });
        if (url.pathname.endsWith('/cancel')) return handle('cancelled');
        if (url.pathname.endsWith('/room/agents')) {
          requestIds.push(randomCorrelationId());
          return ok({
            ...body,
            expectedRoomId: undefined,
            expectedProjectId: undefined,
            expectedActorId: undefined,
            roomId,
            requestId: requestIds.at(-1),
            actor: ada,
            state: 'started',
            createdAt: at,
            updatedAt: at,
          });
        }
        return handle('started');
      }
      if (url.pathname === '/api/read-markers/mark')
        return ok({
          target: body.target,
          latestVersion: body.version,
          seenVersion: body.version,
          unread: false,
        });
      if (url.pathname === '/api/projects/team/channels')
        return ok({
          channels: [{ channelId: roomId, name: 'general', isDefault: true }],
        });
      if (url.pathname === '/api/projects/team/rooms/live')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              live.push(controller);
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      if (url.pathname.endsWith('/members')) return ok({ members });
      if (url.pathname.endsWith('/typing')) {
        typing.push(body);
        return ok({ typing: body.typing });
      }
      if (url.pathname.endsWith('/presence')) return ok([]);
      if (url.pathname.endsWith('/messages') && init?.method === 'POST') {
        writes.push(body);
        const {
          expectedRoomId: _r,
          expectedProjectId: _p,
          expectedActorId: _a,
          ...rest
        } = body;
        const stored = {
          ...rest,
          roomId,
          messageId: randomCorrelationId(),
          seq: messages.length + 1,
          actor: ada,
          createdAt: at,
        };
        messages.push(stored);
        return ok(stored);
      }
      if (url.pathname.endsWith('/messages')) {
        const after = Number(url.searchParams.get('after'));
        return ok({
          scope,
          roomId,
          messages: messages.filter((m) => Number(m.seq) > after).slice(0, 25),
          checkpoint: { roomId, lastSeq: messages.length },
          nextAfter: null,
        });
      }
      return ok({
        scope,
        roomId,
        actor: ada,
        presence: [],
        capabilities: { view: true, discuss: true, edit: true, execute: true },
        checkpoint: { roomId, lastSeq: messages.length },
        note: null,
      });
    }),
  );
});
afterEach(async () => {
  cleanup();
  // The Project's live hub closes its connection once nothing listens; let
  // it, so the next test's stream is its own.
  await new Promise((resolve) => setTimeout(resolve, 80));
  _setApiBase('');
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(live.length).toBeGreaterThan(0));
  push('subscribed', { roomId, lastSeq: messages.length, activity: 0 });
  return screen.findByRole('list', { name: 'Conversation' });
}

test('a live rollover keeps the previously shown row without an immediate history read', async () => {
  const first = message(1, 'Earlier message still on screen');
  messages.push(first);
  const list = await mount();
  await within(list).findByText('Earlier message still on screen');
  const historyReads = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(
        ([input, init]) =>
          String(input).includes('/messages?') && init?.method !== 'POST',
      ).length;
  await waitFor(() => expect(historyReads()).toBeGreaterThanOrEqual(2));
  const before = historyReads();
  await act(async () => {
    for (let seq = 2; seq <= 502; seq++) {
      const next = message(seq, `Live message ${seq}`);
      messages.push(next);
      push('append', { message: next });
    }
  });
  // jsdom does not measure the scrollport. The production virtualizer's row
  // count includes the 500 live messages and the earlier row already shown.
  const history = await within(list).findByTestId(
    'virtualized-transcript-spacer',
  );
  await waitFor(() =>
    expect(history.getAttribute('data-transcript-row-count')).toBe('501'),
  );
  expect(historyReads()).toBe(before);
}, 20_000);

test('a mention renders by person id with their current name, and the reader’s own stands out', async () => {
  messages.push(
    message(1, '@Ada can you check the copy?', {
      mentions: [
        { kind: 'person', actorId: ada.id, display: 'Ada', offset: 0 },
      ],
    }),
  );
  // Ada was renamed after the message was written.
  members = [{ ...ada, displayName: 'Ada Lovelace' }, lin];
  const list = await mount();
  const chip = await within(list).findByText('@Ada Lovelace');
  expect(chip.className).toContain('room-mention');
  expect(chip.className).toContain('room-mention--self');
  expect(within(list).queryByText('@Ada')).toBeNull();
});

test('a person picked from @ is sent as a structured mention; a name typed by hand is not', async () => {
  await mount();
  const composer = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
  fireEvent.change(composer, { target: { value: '@Li', selectionStart: 3 } });
  composer.setSelectionRange(3, 3);
  fireEvent.change(composer, { target: { value: '@Li' } });
  const option = await screen.findByRole('option', { name: /Lin/ });
  fireEvent.click(option);
  await waitFor(() => expect(composer.value).toBe('@Lin '));
  fireEvent.change(composer, {
    target: { value: '@Lin please review, and @Ada too' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.mentions).toEqual([
    { kind: 'person', actorId: lin.id, display: 'Lin', offset: 0 },
  ]);
  // Typing was signalled, and sending stopped it.
  expect(typing.map((t) => t.typing)).toEqual(
    expect.arrayContaining([true, false]),
  );
  expect(typing.at(-1)?.typing).toBe(false);
});

test('"is typing" follows the stream and clears when it does', async () => {
  await mount();
  push('typing', { actors: [lin] });
  expect(await screen.findByText('Lin is typing…')).toBeTruthy();
  push('typing', { actors: [] });
  await waitFor(() => expect(screen.queryByText('Lin is typing…')).toBeNull());
});

test('the Agent working row appears and clears with the request record', async () => {
  const list = await mount();
  const request = {
    requestId: randomCorrelationId(),
    agentId: 'writer',
    actor: lin,
    state: 'started',
    createdAt: at,
    updatedAt: at,
  };
  // No request: no row.
  push('agents', { requests: [] });
  await act(async () => {});
  expect(within(list).queryByText('Working on it…')).toBeNull();
  push('agents', { requests: [request] });
  expect(await within(list).findByText('Working on it…')).toBeTruthy();
  expect(within(list).getByText('Writer')).toBeTruthy();
  expect(within(list).getByText(/Asked by Lin/)).toBeTruthy();
  // Someone else's request: no Stop for this reader.
  expect(
    within(list).queryByRole('button', { name: 'Stop Writer' }),
  ).toBeNull();
  push('agents', {
    requests: [{ ...request, state: 'published', updatedAt: at }],
  });
  await waitFor(() =>
    expect(within(list).queryByText('Working on it…')).toBeNull(),
  );
  // An ending without an answer stays inline.
  push('agents', {
    requests: [
      {
        ...request,
        requestId: randomCorrelationId(),
        state: 'started',
        failure: 'execution_failed',
        updatedAt: '2026-11-15T12:05:00.000Z',
      },
    ],
  });
  expect(await within(list).findByText('Couldn’t finish')).toBeTruthy();
  expect(within(list).getByText(/It stopped with an error/)).toBeTruthy();
});

test('a notification’s message is brought into view and marked', async () => {
  const target = message(2, 'The exact message');
  messages.push(message(1, 'Before'), target, message(3, 'After'));
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.textContent ?? '');
  };
  act(() =>
    navigationStore.navigate('/projects/team', {
      section: 'room',
      message: String(target.messageId),
    }),
  );
  const list = await mount();
  const row = await within(list).findByText('The exact message');
  await waitFor(() =>
    expect(row.closest('.room-row')?.className).toContain('room-row--focused'),
  );
  await waitFor(() =>
    expect(scrolled.some((text) => text.includes('The exact message'))).toBe(
      true,
    ),
  );
  act(() => navigationStore.navigate('/projects/team', { message: null }));
});

test('the person who asked can Stop a working request, and Retry asks again with the same words', async () => {
  const list = await mount();
  const composer = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
  // Ask Writer through the @ list, as a person would.
  composer.setSelectionRange(0, 0);
  fireEvent.change(composer, { target: { value: '@' } });
  fireEvent.click(await screen.findByRole('option', { name: /^Writer/ }));
  fireEvent.change(composer, { target: { value: 'Draft the notes' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Ask Writer' }));
  await waitFor(() => expect(requestIds).toHaveLength(1));
  const request = {
    requestId: requestIds[0],
    agentId: 'writer',
    actor: ada,
    state: 'started',
    createdAt: at,
    updatedAt: at,
  };
  push('agents', { requests: [request] });
  const stop = await within(list).findByRole('button', { name: 'Stop Writer' });
  fireEvent.click(stop);
  await waitFor(() =>
    expect(agentCalls.map((call) => call.path.split('/').at(-1))).toContain(
      'cancel',
    ),
  );
  push('agents', {
    requests: [
      { ...request, state: 'cancelled', updatedAt: '2026-11-15T12:06:00.000Z' },
    ],
  });
  expect(await within(list).findByText('Stopped')).toBeTruthy();
  fireEvent.click(within(list).getByRole('button', { name: 'Retry Writer' }));
  await waitFor(() => expect(requestIds).toHaveLength(2));
  const asks = agentCalls.filter((call) => call.path.endsWith('/room/agents'));
  expect(asks).toHaveLength(2);
  // A new request with the same words: the ended one is never replayed.
  expect(asks[1]?.body.text).toBe(asks[0]?.body.text);
  expect(asks[1]?.body.intentId).not.toBe(asks[0]?.body.intentId);
});
