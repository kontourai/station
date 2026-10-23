/** @vitest-environment jsdom */

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
import { setClientCredentialResolver } from '../../../../packages/sdk/src/client/http';
import { navigationStore } from '../../contexts/navigation-store';
import { ProjectRoom } from './ProjectRoom';

const roomId = '11111111-1111-4111-8111-111111111111';
const requestScope = { apiBase: 'https://room.example', authorityKey: 'one' };
const actor = { id: 'ada', displayName: 'Ada', kind: 'person' };
const scope = {
  stationId: 'station',
  localProjectId: 'project',
  localProjectSlug: 'team',
  portableProjectId: 'portable',
};
const at = '2026-10-22T12:00:00.000Z';
let messages: Array<Record<string, unknown>>;
let note: null | {
  roomId: string;
  revision: number;
  markdown: string;
  sourceMessageIds: string[];
  actor: typeof actor;
  updatedAt: string;
};
let provisioned: boolean;
let failInitialization: boolean;
let initializationBodies: unknown[];
let loseAck: boolean;
let conflict: boolean;
let writes: Array<Record<string, unknown>>;
let streams: ReadableStreamDefaultController<Uint8Array>[];
let selectedAuthority: string;
let agentWrites: Array<Record<string, unknown>>;
let agentOperations: string[];
let agentLostAck: boolean;
let agentRetentions: boolean[];
let agentDenied: boolean;
let agentHandle: Record<string, unknown> | undefined;
let execute: boolean;
let discuss: boolean;
let heldInspection: Promise<void> | undefined;
let inspectionStarted: (() => void) | undefined;
function fixture() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const ok = (data: unknown) => Response.json({ success: true, data });
      if (url.pathname === '/api/agents')
        return ok([
          { slug: 'researcher', name: 'Researcher', available: true },
          { slug: 'offline', name: 'Offline', available: false },
        ]);
      if (url.pathname.endsWith('/room/agents')) {
        agentWrites.push(body);
        const stored = Object.values(sessionStorage).map((raw) => {
          try {
            return JSON.parse(String(raw));
          } catch {
            return undefined;
          }
        });
        agentRetentions.push(
          stored.some(
            (item) => JSON.stringify(item?.intent) === JSON.stringify(body),
          ),
        );
        agentHandle = {
          intentId: body.intentId,
          agentId: body.agentId,
          text: body.text,
          ...(body.replyTo ? { replyTo: body.replyTo } : {}),
          roomId,
          requestId: body.intentId,
          actor,
          state: 'started',
          createdAt: at,
          updatedAt: at,
        };
        if (agentLostAck) {
          agentLostAck = false;
          throw new TypeError('Lost Agent acknowledgement');
        }
        return ok(agentHandle);
      }
      if (url.pathname.includes('/room/agents/')) {
        const operation = url.pathname.split('/').at(-1)!;
        agentOperations.push(operation);
        if (agentDenied)
          return Response.json(
            { success: false, error: 'Access changed' },
            { status: 403 },
          );
        if (operation === 'reconcile') {
          const messageId = randomCorrelationId();
          messages.push({
            intentId: randomCorrelationId(),
            text: 'Shared Agent answer',
            roomId,
            messageId,
            seq: messages.length + 1,
            actor: {
              id: 'researcher',
              kind: 'agent',
              displayName: 'Researcher',
            },
            createdAt: at,
          });
          agentHandle = {
            ...agentHandle,
            state: 'published',
            publishedMessageId: messageId,
          };
        }
        if (operation === 'cancel')
          agentHandle = { ...agentHandle, state: 'cancelled' };
        const response = ok(agentHandle);
        const held = heldInspection;
        heldInspection = undefined;
        if (held) {
          inspectionStarted?.();
          await held;
        }
        return response;
      }
      if (url.pathname.endsWith('/init')) {
        initializationBodies.push(body);
        if (failInitialization) {
          failInitialization = false;
          return Response.json(
            { success: false, error: 'Unavailable' },
            { status: 503 },
          );
        }
        provisioned = true;
        return ok({ scope, roomId });
      }
      if (url.pathname.endsWith('/room') && !provisioned) {
        return Response.json(
          {
            success: false,
            error: 'Room not found',
            code: 'project_room_not_found',
          },
          { status: 404 },
        );
      }
      if (url.pathname.endsWith('/events')) {
        let ownedController: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              ownedController = controller;
              streams.push(controller);
            },
            cancel() {
              streams = streams.filter((stream) => stream !== ownedController);
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (url.pathname.endsWith('/presence')) return ok([]);
      if (url.pathname.endsWith('/messages') && init?.method === 'POST') {
        writes.push(body);
        let message = messages.find((m) => m.intentId === body.intentId);
        if (!message) {
          message = {
            ...body,
            expectedRoomId: undefined,
            expectedProjectId: undefined,
            expectedActorId: undefined,
            roomId,
            messageId: randomCorrelationId(),
            seq: messages.length + 1,
            actor,
            createdAt: at,
          };
          if (message) messages.push(message);
        }
        for (const stream of streams.filter(
          (stream) => stream.desiredSize !== null,
        ))
          stream.enqueue(
            new TextEncoder().encode(
              `event: changed\ndata: ${JSON.stringify({ roomId, lastSeq: messages.length })}\n\n`,
            ),
          );
        if (loseAck) {
          loseAck = false;
          throw new TypeError('Lost acknowledgement');
        }
        return ok(message);
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
      if (url.pathname.endsWith('/note')) {
        if (conflict) {
          conflict = false;
          note = {
            roomId,
            revision: 2,
            markdown: 'Team changed the decision',
            sourceMessageIds: [],
            actor,
            updatedAt: at,
          };
          return Response.json(
            { success: false, error: 'Conflict' },
            { status: 409 },
          );
        }
        note = {
          roomId,
          revision: body.expectedRevision + 1,
          markdown: body.markdown,
          sourceMessageIds: body.sourceMessageIds,
          actor,
          updatedAt: at,
        };
        return ok(note);
      }
      return ok({
        scope,
        roomId,
        actor,
        presence: [],
        capabilities: { view: true, discuss, edit: true, execute },
        checkpoint: { roomId, lastSeq: messages.length },
        note,
      });
    }),
  );
}
function mount(authority = 'one') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={{ ...requestScope, authorityKey: authority }}
      />
    </QueryClientProvider>,
  );
  return { ...ui, client };
}
beforeEach(() => {
  sessionStorage.clear();
  agentWrites = [];
  agentRetentions = [];
  agentOperations = [];
  agentLostAck = false;
  agentDenied = false;
  agentHandle = undefined;
  heldInspection = undefined;
  inspectionStarted = undefined;
  execute = true;
  discuss = true;
  messages = [];
  writes = [];
  streams = [];
  provisioned = true;
  failInitialization = false;
  initializationBodies = [];
  loseAck = false;
  conflict = false;
  note = null;
  selectedAuthority = 'one';
  setClientCredentialResolver(() => ({
    origin: requestScope.apiBase,
    requestAuthority: {
      ...requestScope,
      authorityKey: selectedAuthority,
      isCurrent: () => true,
    },
  }));
  fixture();
});
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
test('reload offers exact retained retry without automatically resending, then authority switch retires it', async () => {
  loseAck = true;
  const a = mount();
  const composer = await screen.findByRole('textbox', {
    name: 'Message the project',
  });
  fireEvent.change(composer, { target: { value: 'Team update' } });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await screen.findByText(/Send not confirmed/);
  expect(writes).toHaveLength(1);
  a.unmount();
  const b = mount();
  await screen.findByRole('button', { name: 'Retry same message' });
  expect(writes).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same message' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
  await waitFor(() =>
    expect(b.client.getMutationCache().getAll().at(-1)?.state.error).toBeNull(),
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Message the project',
      }).value,
    ).toBe(''),
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Bring an Agent' })
      .disabled,
  ).toBe(true);
  loseAck = true;
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Old authority proposal' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await screen.findByText(/Send not confirmed/);
  selectedAuthority = 'two';
  b.rerender(
    <QueryClientProvider client={b.client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={{ ...requestScope, authorityKey: 'two' }}
      />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Message the project',
      }).value,
    ).toBe(''),
  );
  expect(sessionStorage.length).toBe(0);
});
test('shared notes preserve the draft on CAS conflict and dirty navigation asks before leaving', async () => {
  note = {
    roomId,
    revision: 1,
    markdown: 'First decision',
    sourceMessageIds: [],
    actor,
    updatedAt: at,
  };
  const ui = mount();
  await screen.findByRole('textbox', { name: 'Message the project' });
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Notes (Markdown)' }), {
    target: { value: 'My decision' },
  });
  conflict = true;
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  await screen.findByText(/Shared notes changed while/);
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Notes (Markdown)',
    }).value,
  ).toBe('My decision');
  expect(screen.getByText('Team changed the decision')).toBeTruthy();
  act(() => navigationStore.navigate('/project-room-test-next'));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Notes (Markdown)',
    }).value,
  ).toBe('My decision');
  ui.unmount();
});
test('revocation clears retained content and stops the live connection', async () => {
  messages = [
    {
      roomId,
      intentId: randomCorrelationId(),
      messageId: randomCorrelationId(),
      seq: 1,
      actor,
      createdAt: at,
      text: 'Shared team content',
    },
  ];
  const ui = mount();
  await screen.findByText('Shared team content');
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  act(() =>
    streams[0].enqueue(
      new TextEncoder().encode(
        'event: revoked\ndata: {"reason":"access_changed"}\n\n',
      ),
    ),
  );
  await screen.findByText(/Room access changed/);
  expect(screen.queryByText('Shared team content')).toBeNull();
  expect(
    ui.client
      .getQueryCache()
      .findAll({ queryKey: ['project-room'] })
      .every((query) => query.state.data === undefined),
  ).toBe(true);
});

test('two independent mounted query contexts receive the shared stream through real SDK fetch and SSE', async () => {
  const a = mount();
  const b = mount();
  const browserA = within(a.container);
  const browserB = within(b.container);
  await browserA.findByRole('textbox', { name: 'Message the project' });
  await browserB.findByRole('textbox', { name: 'Message the project' });
  await waitFor(() => expect(streams).toHaveLength(2));
  fireEvent.change(
    browserA.getByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Can everyone see this?' } },
  );
  await waitFor(() =>
    expect(
      browserA.getByRole<HTMLButtonElement>('button', { name: 'Send message' })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(browserA.getByRole('button', { name: 'Send message' }));
  await browserB.findByText('Can everyone see this?');
  expect(browserB.getByText('Ada')).toBeTruthy();
  expect(writes).toHaveLength(1);
});

test('loads older history and explicitly requests an available Agent with actual reply context', async () => {
  messages = Array.from({ length: 30 }, (_, index) => ({
    roomId,
    intentId: randomCorrelationId(),
    messageId: randomCorrelationId(),
    seq: index + 1,
    actor:
      index === 29
        ? { id: 'agent', displayName: 'Researcher', kind: 'agent' }
        : actor,
    createdAt: at,
    text: `Update ${index + 1}`,
  }));
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
      />
    </QueryClientProvider>,
  );
  await screen.findByText('Update 30');
  expect(screen.queryByText('Update 1')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
  await screen.findByText('Update 1');
  expect(screen.getByText('Agent')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Researcher' }));
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Please investigate this' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bring an Agent' }));
  const picker = await screen.findByRole('combobox', { name: 'Agent' });
  expect(screen.queryByRole('option', { name: 'Offline' })).toBeNull();
  expect(agentWrites).toHaveLength(0);
  fireEvent.change(picker, { target: { value: 'researcher' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask in room' }));
  await screen.findByText('Agent is working. Its answer will appear in the Room.');
  expect(agentWrites).toEqual([
    expect.objectContaining({
      agentId: 'researcher',
      text: 'Please investigate this',
      replyTo: messages[29].messageId,
      expectedActorId: actor.id,
      expectedRoomId: roomId,
      expectedProjectId: 'project',
    }),
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect request' }));
  await waitFor(() => expect(agentOperations).toHaveLength(1));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Check answer' })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
  await screen.findByText('Shared Agent answer');
  expect(agentWrites).toHaveLength(1);
  expect(writes).toHaveLength(0);
});

test('preview opens the full room without replacing its draft and tabs guard shared notes', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onOpenRoom = vi.fn();
  const room = (variant: 'preview' | 'full') => (
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
        variant={variant}
        onOpenRoom={onOpenRoom}
      />
    </QueryClientProvider>
  );
  const ui = render(room('preview'));
  const composer = await screen.findByRole('textbox', {
    name: 'Message the project',
  });
  fireEvent.change(composer, { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open room' }));
  expect(onOpenRoom).toHaveBeenCalledTimes(1);
  ui.rerender(room('full'));
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message the project',
    }).value,
  ).toBe('Keep this draft');
  expect(screen.getByRole('button', { name: 'Bring an Agent' })).toBeTruthy();
  expect(screen.queryByLabelText('Room menu')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Discard$/ }));
  expect(
    screen.getByRole('textbox', { name: 'Notes (Markdown)' }),
  ).toBeTruthy();
});

test('an unprovisioned room requires an explicit open and keeps failed initialization retryable', async () => {
  provisioned = false;
  failInitialization = true;
  mount();
  const open = await screen.findByRole('button', { name: 'Open room' });
  expect(initializationBodies).toEqual([]);
  expect(
    screen.queryByRole('textbox', { name: 'Message the project' }),
  ).toBeNull();
  fireEvent.click(open);
  await screen.findByRole('alert');
  expect(initializationBodies).toEqual([{ expectedProjectId: 'project' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Open room' }));
  await screen.findByRole('textbox', { name: 'Message the project' });
  expect(initializationBodies).toEqual([
    { expectedProjectId: 'project' },
    { expectedProjectId: 'project' },
  ]);
});

async function askAgent() {
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Investigate together' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bring an Agent' }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Agent' }), {
    target: { value: 'researcher' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask in room' }));
}
test('lost Agent acknowledgement reload retries immutable intent, never automatically launches or cancels', async () => {
  agentLostAck = true;
  const ui = mount();
  await askAgent();
  await screen.findByText(/Agent request not confirmed/);
  const first = agentWrites[0];
  ui.unmount();
  const second = mount();
  await screen.findByRole('button', { name: 'Retry same Agent request' });
  expect(agentWrites).toHaveLength(1);
  expect(agentOperations).toEqual([]);
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Different discussion' } },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry same Agent request' }),
  );
  await screen.findByText('Agent is working. Its answer will appear in the Room.');
  expect(agentWrites).toEqual([first, first]);
  expect(agentRetentions).toEqual([true, true]);
  fireEvent.click(screen.getByRole('button', { name: 'More Agent actions' }));
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Cancel Agent request' }),
  );
  await screen.findByText('Agent request cancelled.');
  expect(
    agentOperations.filter((operation) =>
      ['cancel', 'reconcile'].includes(operation),
    ),
  ).toEqual(['cancel']);
  second.unmount();
  expect(
    agentOperations.filter((operation) =>
      ['cancel', 'reconcile'].includes(operation),
    ),
  ).toEqual(['cancel']);
});
test('Agent handles retire on authority loss and permission-only readers cannot invoke', async () => {
  const ui = mount();
  await askAgent();
  await screen.findByText('Agent is working. Its answer will appear in the Room.');
  agentDenied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Inspect request' }));
  await screen.findByText('Agent request access changed. Check Room access.');
  expect(screen.queryByText('Agent is working. Its answer will appear in the Room.')).toBeNull();
  expect(
    Object.values(sessionStorage).some((raw) =>
      String(raw).includes('researcher'),
    ),
  ).toBe(false);
  ui.unmount();
  execute = false;
  mount();
  await screen.findByRole('textbox', { name: 'Message the project' });
  expect(screen.queryByRole('button', { name: 'Bring an Agent' })).toBeNull();
  expect(agentWrites).toHaveLength(1);
});

test('a pushed completion waits for an in-flight inspect and then updates without manual reconciliation', async () => {
  let release!: () => void;
  let inspecting = false;
  heldInspection = new Promise<void>((resolve) => { release = resolve; });
  inspectionStarted = () => { inspecting = true; };
  mount();
  const composer = await screen.findByRole('textbox', {
    name: 'Message the project',
  });
  fireEvent.change(composer, { target: { value: 'Review the Project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Bring an Agent' }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Agent' }), {
    target: { value: 'researcher' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask in room' }));
  await screen.findByText('Agent is working. Its answer will appear in the Room.');
  await waitFor(() => expect(inspecting).toBe(true));
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  const messageId = randomCorrelationId();
  agentHandle = {
    ...agentHandle,
    state: 'published',
    publishedMessageId: messageId,
  };
  messages.push({
    roomId,
    messageId,
    seq: 1,
    intentId: randomCorrelationId(),
    text: 'Completed shared answer',
    actor: { id: 'researcher', kind: 'agent', displayName: 'Researcher' },
    createdAt: at,
  });
  await act(async () => {
    for (const stream of streams)
      stream.enqueue(
        new TextEncoder().encode(
          `event: changed\ndata: ${JSON.stringify({ roomId, lastSeq: 1 })}\n\n`,
        ),
      );
  });
  await screen.findByText('Completed shared answer');
  await act(async () => { release(); });
  await screen.findByText('Agent answer shared in the Room.');
  expect(agentWrites).toHaveLength(1);
  expect(agentOperations).not.toContain('reconcile');
});
