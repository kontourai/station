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
let failWrite: boolean;
let researcherAvailable: boolean;
let researcherName: string;
let agentHold: Promise<void> | undefined;
/** Holds the next Agent request until the returned release is called. */
function holdAgentRequest() {
  let release!: () => void;
  agentHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}
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
          {
            slug: 'researcher',
            name: researcherName,
            ...(researcherAvailable ? {} : { available: false }),
          },
          { slug: 'reviewer', name: 'Reviewer' },
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
        const hold = agentHold;
        agentHold = undefined;
        if (hold) await hold;
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
      // Read marks settle inside the test that made them (the SDK waits for
      // an API base, so an unanswered one would land in a later test).
      if (url.pathname === '/api/read-markers/mark')
        return ok({
          target: body.target,
          latestVersion: body.version,
          seenVersion: body.version,
          unread: false,
        });
      if (url.pathname === '/api/projects/team/channels')
        return ok({
          channels: provisioned
            ? [{ channelId: roomId, name: 'general', isDefault: true }]
            : [],
        });
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
        if (failWrite) {
          failWrite = false;
          throw new TypeError('Station unreachable');
        }
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
function mount(authority = 'one', draftRecoveryKey?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={{
          ...requestScope,
          authorityKey: authority,
          ...(draftRecoveryKey ? { draftRecoveryKey } : {}),
        }}
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
  failWrite = false;
  researcherAvailable = true;
  researcherName = 'Researcher';
  agentHold = undefined;
  conflict = false;
  note = null;
  selectedAuthority = 'one';
  _setApiBase(requestScope.apiBase);
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
  _setApiBase('');
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const roomStorage = () =>
  Object.keys(sessionStorage).filter((key) =>
    key.startsWith('station-project-room:'),
  );
test('an unsent message waits in the conversation, survives reload for an exact retry, then authority switch retires it', async () => {
  failWrite = true;
  const a = mount();
  const composer = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
        .disabled,
    ).toBe(false),
  );
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
  // The text moved into the conversation as a failed row; the field is free.
  const conversation = screen.getByRole('list', { name: 'Conversation' });
  expect(within(conversation).getByText('Team update')).toBeTruthy();
  expect(composer.value).toBe('');
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
      .disabled,
  ).toBe(true);
  a.unmount();
  const b = mount();
  await screen.findByRole('button', { name: 'Retry same message' });
  expect(writes).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same message' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Retry same message' }),
    ).toBeNull(),
  );
  expect(
    within(screen.getByRole('list', { name: 'Conversation' })).getAllByText(
      'Team update',
    ),
  ).toHaveLength(1);
  expect(roomStorage()).toEqual([]);
  failWrite = true;
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
  expect(screen.queryByText('Old authority proposal')).toBeNull();
  expect(sessionStorage.length).toBe(0);
});
test('a send whose acknowledgement was lost settles once the room shows its intent', async () => {
  loseAck = true;
  mount();
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Committed but unacknowledged' } },
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  // The server committed the intent; history shows it, so nothing is retried.
  await waitFor(() => expect(roomStorage()).toEqual([]));
  expect(
    screen.queryByRole('button', { name: 'Retry same message' }),
  ).toBeNull();
  expect(
    within(screen.getByRole('list', { name: 'Conversation' })).getAllByText(
      'Committed but unacknowledged',
    ),
  ).toHaveLength(1);
  expect(writes).toHaveLength(1);
});
test('an unsent message draft survives leaving the room and a reload, and Enter sends it', async () => {
  const first = mount();
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Draft for the team' } },
  );
  first.unmount();
  mount();
  const composer = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
  expect(composer.value).toBe('Draft for the team');
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' })
        .disabled,
    ).toBe(false),
  );
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() =>
    expect(writes).toEqual([
      expect.objectContaining({ text: 'Draft for the team' }),
    ]),
  );
  await waitFor(() => expect(composer.value).toBe(''));
});
const composerField = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
async function mentionAgent(name: string) {
  const field = composerField();
  const lead = field.value && !/\s$/.test(field.value) ? ' @' : '@';
  fireEvent.change(field, { target: { value: `${field.value}${lead}` } });
  fireEvent.click(
    await screen.findByRole('option', {
      name: new RegExp(`^${name} Agent @${name.toLowerCase()}\\b`),
    }),
  );
  await screen.findByText(`@${name}`);
}

test('a draft survives a reload whose authority epoch changes within the same recovery partition (#4810 review 1)', async () => {
  selectedAuthority = 'epoch-1';
  const first = mount('epoch-1', 'partition-a');
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Draft across reload' } },
  );
  first.unmount();
  // A reload mints a new activation epoch; the reload partition is stable.
  selectedAuthority = 'epoch-2';
  const second = mount('epoch-2', 'partition-a');
  await screen.findByRole('textbox', { name: 'Message the project' });
  expect(composerField().value).toBe('Draft across reload');
  second.unmount();
  // Another partition (another credential or connection) never sees it.
  selectedAuthority = 'other';
  mount('other', 'partition-b');
  await screen.findByRole('textbox', { name: 'Message the project' });
  expect(composerField().value).toBe('');
});

test('a second @agent request never replays the first or wipes its own draft (#4810 review 2)', async () => {
  mount();
  await screen.findByRole('textbox', { name: 'Message the project' });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
        .disabled,
    ).toBe(false),
  );
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'First ask' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await screen.findByText(
    'Agent is working. Its answer will appear in the Room.',
  );
  expect(agentWrites).toEqual([
    expect.objectContaining({ agentId: 'researcher', text: 'First ask' }),
  ]);
  await waitFor(() => expect(composerField().value).toBe(''));

  // While the first request is still running, Ask is disabled and the new
  // draft is kept; nothing replays the first intent.
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'Second ask' } });
  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Waiting for Researcher…',
    }).disabled,
  ).toBe(true);
  expect(agentWrites).toHaveLength(1);
  expect(composerField().value).toBe('Second ask');

  // Once the first settles, the new ask sends its own text.
  fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
  await screen.findByText('Agent answer shared in the Room.');
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(agentWrites).toHaveLength(2));
  expect(agentWrites[1]).toEqual(
    expect.objectContaining({ agentId: 'researcher', text: 'Second ask' }),
  );
  expect(agentWrites[1]?.intentId).not.toBe(agentWrites[0]?.intentId);
  await waitFor(() => expect(composerField().value).toBe(''));
});

test('a restored draft keeps its Agent recipient and reply, revalidated on restore (#4810 review 3)', async () => {
  messages = [
    {
      roomId,
      messageId: randomCorrelationId(),
      intentId: randomCorrelationId(),
      seq: 1,
      actor,
      createdAt: at,
      text: 'Team question',
    },
  ];
  const first = mount();
  await screen.findByText('Team question');
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Ada' }));
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'Look into this' } });
  first.unmount();

  const second = mount();
  await screen.findByText('@Researcher');
  expect(screen.getByRole('button', { name: 'Cancel reply' })).toBeTruthy();
  expect(composerField().value).toBe('Look into this');
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Ask Researcher' })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() =>
    expect(agentWrites).toEqual([
      expect.objectContaining({
        agentId: 'researcher',
        text: 'Look into this',
        replyTo: messages[0]?.messageId,
      }),
    ]),
  );
  expect(writes).toEqual([]);
  second.unmount();

  // A saved recipient that is no longer available is dropped, not sent to.
  sessionStorage.clear();
  const third = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Reply to Ada' }));
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'Still needed' } });
  third.unmount();
  researcherAvailable = false;
  mount();
  await screen.findByText(/The saved Agent is unavailable/);
  expect(screen.queryByText('@Researcher')).toBeNull();
  expect(composerField().value).toBe('Still needed');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
});

test('an acknowledgement keeps a newer draft whose text changed, with its recipient and reply (#4810 delta 1)', async () => {
  messages = [
    {
      roomId,
      messageId: randomCorrelationId(),
      intentId: randomCorrelationId(),
      seq: 1,
      actor,
      createdAt: at,
      text: 'Team question',
    },
  ];
  mount();
  await screen.findByText('Team question');
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
        .disabled,
    ).toBe(false),
  );
  // Case A: the text changes while the ask is in flight; recipient and reply stay.
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Ada' }));
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'First ask' } });
  const release = holdAgentRequest();
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(agentWrites).toHaveLength(1));
  fireEvent.change(composerField(), { target: { value: 'Follow-up ask' } });
  await act(async () => release());
  await screen.findByText(
    'Agent is working. Its answer will appear in the Room.',
  );
  expect(composerField().value).toBe('Follow-up ask');
  expect(screen.getByText('@Researcher')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cancel reply' })).toBeTruthy();
});

test('an acknowledgement keeps a newer draft whose recipient changed but text did not (#4810 delta 1)', async () => {
  mount();
  await screen.findByRole('textbox', { name: 'Message the project' });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
        .disabled,
    ).toBe(false),
  );
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'Follow-up ask' } });
  const release = holdAgentRequest();
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(agentWrites).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Remove Researcher' }));
  await mentionAgent('Reviewer');
  // Same text as the asked revision; only the recipient changed.
  fireEvent.change(composerField(), { target: { value: 'Follow-up ask' } });
  await act(async () => release());
  await screen.findByText(
    'Agent is working. Its answer will appear in the Room.',
  );
  expect(composerField().value).toBe('Follow-up ask');
  expect(screen.getByText('@Reviewer')).toBeTruthy();

  // Unchanged since the ask: the whole envelope clears on acknowledgement.
  fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
  await screen.findByText('Agent answer shared in the Room.');
  fireEvent.click(screen.getByRole('button', { name: 'Ask Reviewer' }));
  await waitFor(() => expect(agentWrites).toHaveLength(2));
  await waitFor(() => expect(composerField().value).toBe(''));
  expect(screen.queryByText('@Reviewer')).toBeNull();
});

test('an unconfirmed Agent request without a handle can be abandoned, keeping the new draft (#4810 delta 2)', async () => {
  agentLostAck = true;
  mount();
  await screen.findByRole('textbox', { name: 'Message the project' });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
        .disabled,
    ).toBe(false),
  );
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'Lost ask' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await screen.findByText(/Agent request not confirmed/);
  expect(composerField().value).toBe('Lost ask');
  fireEvent.change(composerField(), { target: { value: 'A new question' } });
  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Waiting for Researcher…',
    }).disabled,
  ).toBe(true);
  expect(agentWrites).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Abandon this request' }));
  fireEvent.click(
    within(
      await screen.findByRole('dialog', {
        name: 'Stop tracking this request?',
      }),
    ).getByRole('button', { name: 'Stop tracking' }),
  );
  await screen.findByText(/may already have run/);
  expect(composerField().value).toBe('A new question');
  expect(
    Object.keys(sessionStorage).filter((key) => key.endsWith(':agent')),
  ).toEqual([]);

  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(agentWrites).toHaveLength(2));
  expect(agentWrites[1]).toEqual(
    expect.objectContaining({ text: 'A new question' }),
  );
  expect(agentWrites[1]?.intentId).not.toBe(agentWrites[0]?.intentId);
});

test('a restored recipient takes the catalog name after a rename (#4810 delta 3)', async () => {
  const first = mount();
  await screen.findByRole('textbox', { name: 'Message the project' });
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'Still relevant' } });
  first.unmount();
  researcherName = 'Research Lead';
  mount();
  await screen.findByText('@Research Lead');
  expect(screen.queryByText('@Researcher')).toBeNull();
  expect(
    await screen.findByRole('button', { name: 'Ask Research Lead' }),
  ).toBeTruthy();
});

test('while an Agent request is unsettled, Ask is disabled and a follow-up draft survives the first acknowledgement (#4810 round 2, 1)', async () => {
  mount();
  await screen.findByRole('textbox', { name: 'Message the project' });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
        .disabled,
    ).toBe(false),
  );
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'First ask' } });
  const release = holdAgentRequest();
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() => expect(agentWrites).toHaveLength(1));
  // A follow-up typed while the first ask is pending, then an attempt to ask.
  fireEvent.change(composerField(), { target: { value: 'Follow-up' } });
  fireEvent.click(
    screen.getByRole('button', { name: /^(Ask|Waiting for) Researcher/ }),
  );
  await act(async () => release());
  await screen.findByText(
    'Agent is working. Its answer will appear in the Room.',
  );
  expect(composerField().value).toBe('Follow-up');
  expect(screen.getByText('@Researcher')).toBeTruthy();
  expect(agentWrites).toHaveLength(1);
  // Still unsettled: Ask stays disabled and says why; Send still works.
  const ask = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Waiting for Researcher…',
  });
  expect(ask.disabled).toBe(true);
  expect(screen.getByText('Waiting for Researcher…')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Researcher' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() =>
    expect(writes).toEqual([expect.objectContaining({ text: 'Follow-up' })]),
  );
});

test('Abandon asks first, defaults to Cancel, and cancelling keeps the request (#4810 round 2, 2)', async () => {
  agentLostAck = true;
  mount();
  await screen.findByRole('textbox', { name: 'Message the project' });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
        .disabled,
    ).toBe(false),
  );
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'Lost ask' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await screen.findByText(/Agent request not confirmed/);
  const retainedKeys = () =>
    Object.keys(sessionStorage).filter((key) => key.endsWith(':agent'));
  expect(retainedKeys()).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Abandon this request' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Stop tracking this request?',
  });
  expect(
    within(dialog).getByText(
      /It may still be running, and you won’t be able to retry it from here\./,
    ),
  ).toBeTruthy();
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  fireEvent.click(cancel);
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Stop tracking this request?' }),
    ).toBeNull(),
  );
  // Not confirmed: the retained intent and its retry stay.
  expect(retainedKeys()).toHaveLength(1);
  expect(
    screen.getByRole('button', { name: 'Retry same Agent request' }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Abandon this request' }));
  fireEvent.click(
    within(
      await screen.findByRole('dialog', {
        name: 'Stop tracking this request?',
      }),
    ).getByRole('button', { name: 'Stop tracking' }),
  );
  await screen.findByText(/may already have run/);
  expect(retainedKeys()).toEqual([]);
  expect(composerField().value).toBe('Lost ask');
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
  messages[29]!.text +=
    '\n\n[Read policy](/api/knowledge/roots/project/records/policy)';
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
  await screen.findByText(/Update 30/);
  expect(
    (await screen.findByRole('link', { name: 'Read policy' })).getAttribute(
      'href',
    ),
  ).toBe('/api/knowledge/roots/project/records/policy');
  expect(screen.queryByText('Update 1')).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Load earlier messages' }),
  );
  await screen.findByText('Update 1');
  expect(
    within(screen.getByRole('list', { name: 'Conversation' })).getByText(
      'Agent',
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Researcher' }));
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Please investigate this' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bring an Agent' }));
  const picker = await screen.findByRole('combobox', { name: 'Agent' });
  expect(screen.queryByRole('option', { name: /^Offline\b/ })).toBeNull();
  expect(agentWrites).toHaveLength(0);
  fireEvent.change(picker, { target: { value: 'researcher' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask in room' }));
  await screen.findByText(
    'Agent is working. Its answer will appear in the Room.',
  );
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

test('preview opens the full room without replacing its draft, and the draft survives a tab switch', async () => {
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
  // The draft is kept per room, so switching tabs asks nothing and loses nothing.
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    screen.getByRole('textbox', { name: 'Notes (Markdown)' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message the project',
    }).value,
  ).toBe('Keep this draft');
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
test('Recap Project prepares a reviewable scoped prompt and requests only the explicitly chosen Agent on Ask', async () => {
  mount();
  const recap = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Recap Project',
  });
  await waitFor(() => expect(recap.disabled).toBe(false));
  await act(async () => {
    fireEvent.click(recap);
  });
  const composer = screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
  const prompt = `Recap Project team (Project ID: project; Room ID: ${roomId}).

Summarize this Project, its Tasks, this Room's discussion and shared notes, and related Project sources that current authority and available tools allow you to inspect. Cite evidence IDs and source citations for factual claims; distinguish observed facts from uncertainty.

Report observed freshness and coverage, including timestamps or checkpoints when available, and unavailable, private, or partial sources and gaps. Do not claim access beyond current permissions or infer completion from missing evidence. Do not automatically promote this recap into memory or shared notes.`;
  expect(composer.value).toBe(prompt);
  expect(document.activeElement).toBe(composer);
  expect(screen.getByText(/Recap prompt prepared/)).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(agentWrites).toEqual([]);
  expect(writes).toEqual([]);
  expect(roomStorage()).toEqual([]);
  const reviewedPrompt = `${prompt}\n\nFocus on open blockers.`;
  fireEvent.change(composer, { target: { value: reviewedPrompt } });
  fireEvent.click(screen.getByRole('button', { name: 'Bring an Agent' }));
  const dialog = await screen.findByRole('dialog', { name: 'Bring an Agent' });
  expect(
    within(dialog).getByText(reviewedPrompt, { normalizer: (value) => value }),
  ).toBeTruthy();
  const ask = within(dialog).getByRole<HTMLButtonElement>('button', {
    name: 'Ask in room',
  });
  expect(ask.disabled).toBe(true);
  await act(async () => {
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Agent' }), {
      target: { value: 'researcher' },
    });
  });
  expect(ask.disabled).toBe(false);
  expect(agentWrites).toEqual([]);
  fireEvent.click(ask);
  await screen.findByText(
    'Agent is working. Its answer will appear in the Room.',
  );
  expect(agentWrites).toEqual([
    {
      expectedProjectId: 'project',
      expectedRoomId: roomId,
      expectedActorId: 'ada',
      intentId: expect.any(String),
      agentId: 'researcher',
      text: reviewedPrompt,
    },
  ]);
  expect(agentRetentions).toEqual([true]);
  expect(writes).toEqual([]);
});

test('Recap Project preserves an unrelated draft and reply; human discussion never requests an Agent', async () => {
  messages = [
    {
      roomId,
      messageId: randomCorrelationId(),
      intentId: randomCorrelationId(),
      seq: 1,
      actor,
      createdAt: at,
      text: 'Team question',
    },
  ];
  mount();
  await screen.findByText('Team question');
  const composer = screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
  const recap = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Recap Project',
  });
  await waitFor(() => expect(recap.disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Ada' }));
  expect(recap.disabled).toBe(true);
  fireEvent.click(recap);
  expect(composer.value).toBe('');
  expect(screen.getByRole('button', { name: 'Cancel reply' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
  fireEvent.change(composer, { target: { value: 'Keep my draft' } });
  expect(recap.disabled).toBe(true);
  fireEvent.click(recap);
  expect(composer.value).toBe('Keep my draft');
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(composer.value).toBe(''));
  expect(writes).toEqual([expect.objectContaining({ text: 'Keep my draft' })]);
  expect(agentWrites).toEqual([]);
  expect(recap.disabled).toBe(false);
  fireEvent.click(recap);
  const recapText = composer.value;
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(composer.value).toBe(''));
  expect(writes).toHaveLength(2);
  expect(writes[1].text).toBe(recapText);
  expect(agentWrites).toEqual([]);
});

test.each([
  { discuss: true, execute: false },
  { discuss: false, execute: true },
])(
  'Recap Project retires when current capabilities become %j',
  async (capabilities) => {
    const ui = mount();
    const recap = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Recap Project',
    });
    await waitFor(() => expect(recap.disabled).toBe(false));
    discuss = capabilities.discuss;
    execute = capabilities.execute;
    await act(async () => {
      await ui.client.invalidateQueries({ queryKey: ['project-room'] });
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Recap Project' }),
      ).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'Bring an Agent' })).toBeNull();
    expect(agentWrites).toEqual([]);
    expect(writes).toEqual([]);
  },
);

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
  expect(screen.queryByRole('button', { name: 'Recap Project' })).toBeNull();
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Message the project' }),
    { target: { value: 'Different discussion' } },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry same Agent request' }),
  );
  await screen.findByText(
    'Agent is working. Its answer will appear in the Room.',
  );
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
  await screen.findByText(
    'Agent is working. Its answer will appear in the Room.',
  );
  agentDenied = true;
  fireEvent.click(screen.getByRole('button', { name: 'Inspect request' }));
  await screen.findByText('Agent request access changed. Check Room access.');
  expect(
    screen.queryByText('Agent is working. Its answer will appear in the Room.'),
  ).toBeNull();
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
  heldInspection = new Promise<void>((resolve) => {
    release = resolve;
  });
  inspectionStarted = () => {
    inspecting = true;
  };
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
  await screen.findByText(
    'Agent is working. Its answer will appear in the Room.',
  );
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
  await act(async () => {
    release();
  });
  await screen.findByText('Agent answer shared in the Room.');
  expect(agentWrites).toHaveLength(1);
  expect(agentOperations).not.toContain('reconcile');
});

// #4855 review: read marking, thread sends and old thread links.
function storedMessage(seq: number, text: string, replyTo?: string) {
  return {
    roomId,
    messageId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    intentId: randomCorrelationId(),
    seq,
    actor,
    text,
    createdAt: at,
    ...(replyTo ? { replyTo } : {}),
  };
}
/** The room with a route-owned thread, as the room destination mounts it. */
function mountThread(rootId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
        routeChannel={{ id: undefined }}
        thread={{ rootId, open: () => {} }}
      />
    </QueryClientProvider>,
  );
}
/** Records read-marker marks; `history` can hold or fail the history read. */
function watchMarks(history?: (url: URL) => Promise<Response | undefined>) {
  const original = vi.mocked(fetch).getMockImplementation()!;
  const marks: Array<{ version: number }> = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/read-markers/mark') {
      const body = JSON.parse(String(init?.body));
      marks.push(body);
      return Response.json({
        success: true,
        data: {
          target: body.target,
          latestVersion: body.version,
          seenVersion: body.version,
          unread: false,
        },
      });
    }
    if (
      history &&
      url.pathname.endsWith('/messages') &&
      init?.method !== 'POST'
    ) {
      const answer = await history(url);
      if (answer) return answer;
    }
    return original(input, init);
  });
  return marks;
}

test('a held history read marks nothing; the shown version is marked once it shows', async () => {
  messages = [storedMessage(1, 'Unseen held history')];
  let requested = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const marks = watchMarks(async () => {
    requested = true;
    await held;
    return undefined;
  });
  try {
    mount();
    await waitFor(() => expect(requested).toBe(true));
    // Discovery already reported version 1; nothing of it is on screen.
    await screen.findByRole('textbox', { name: 'Message the project' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Unseen held history')).toBeNull();
    expect(marks).toEqual([]);
    release();
    await screen.findByText('Unseen held history');
    await waitFor(() => expect(marks.map((mark) => mark.version)).toEqual([1]));
  } finally {
    release();
  }
});

test('a failed history read never moves the read marker', async () => {
  messages = [storedMessage(1, 'Never shown')];
  const marks = watchMarks(async () =>
    Response.json({ success: false, error: 'Unavailable' }, { status: 503 }),
  );
  mount();
  await screen.findByText('History could not be loaded.');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByText('Never shown')).toBeNull();
  expect(marks).toEqual([]);
});

test('every send from an open thread replies to its root, not only the first', async () => {
  const root = storedMessage(1, 'Thread root');
  messages = [root];
  mountThread(root.messageId);
  const input = await screen.findByRole('textbox', { name: 'Reply in thread' });
  await screen.findByText('Thread root');
  const sendReply = async (text: string) => {
    fireEvent.change(input, { target: { value: text } });
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' })
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText(text);
  };
  await sendReply('First reply');
  await sendReply('Second reply');
  expect(writes.map((write) => write.replyTo)).toEqual([
    root.messageId,
    root.messageId,
  ]);
  // Both stay in the thread, under its count.
  expect(screen.getByText('2 replies')).toBeTruthy();
});

test('a thread link to a root older than the newest window pages back to it', async () => {
  messages = Array.from({ length: 30 }, (_, index) =>
    storedMessage(
      index + 1,
      index === 0 ? 'Older thread root' : `Other ${index + 1}`,
    ),
  );
  const root = messages[0]!;
  messages.push(storedMessage(31, 'A later reply', String(root.messageId)));
  mountThread(String(root.messageId));
  await screen.findByText('Older thread root');
  expect(screen.getByText('A later reply')).toBeTruthy();
  expect(screen.getByText('1 reply')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Reply in thread' })).toBeTruthy();
});

test('a thread link to a message the channel does not have says so, with no composer', async () => {
  messages = Array.from({ length: 31 }, (_, index) =>
    storedMessage(index + 1, `Message ${index + 1}`),
  );
  mountThread('00000000-0000-4000-8000-999999999999');
  await screen.findByText('This message is not in #general.');
  // The empty state's own way back, beside the thread bar's.
  expect(
    screen.getAllByRole('button', { name: 'Back to #general' }).length,
  ).toBe(2);
  expect(screen.queryByRole('textbox', { name: 'Reply in thread' })).toBeNull();
});

// #4855 delta review: several quick backward pages, and thread drafts.
/** The room with a route-owned thread whose `open` re-renders the route. */
function mountThreadRoute(rootId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let ui: ReturnType<typeof render>;
  const tree = (next?: string) => (
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
        routeChannel={{ id: undefined }}
        thread={{ rootId: next, open: (root) => ui.rerender(tree(root)) }}
      />
    </QueryClientProvider>
  );
  ui = render(tree(rootId));
  return ui;
}
/** Records each history read's `after` cursor. */
function watchHistoryReads() {
  const reads: number[] = [];
  watchMarks(async (url) => {
    reads.push(Number(url.searchParams.get('after')));
    return undefined;
  });
  return reads;
}

test('a thread link pages back through many quick windows to a root inside the bound', async () => {
  // 501 short messages answer at once, so React batches the renders between
  // pages; the root (seq 26) is in the 20th and last window kept loaded.
  messages = Array.from({ length: 501 }, (_, index) =>
    storedMessage(index + 1, `Deep update ${index + 1}`),
  );
  const reads = watchHistoryReads();
  mountThreadRoute(String(messages[25]!.messageId));
  await screen.findByText('Deep update 26', {}, { timeout: 10_000 });
  expect(reads).toHaveLength(20);
  expect(reads.at(-1)).toBe(1);
  expect(screen.getByRole('textbox', { name: 'Reply in thread' })).toBeTruthy();
});

test('a thread link past the loaded-history bound stops at 20 windows and says so', async () => {
  messages = Array.from({ length: 501 }, (_, index) =>
    storedMessage(index + 1, `Bound update ${index + 1}`),
  );
  const reads = watchHistoryReads();
  mountThreadRoute(String(messages[0]!.messageId));
  await screen.findByText(
    'This thread is too far back to open here.',
    {},
    { timeout: 10_000 },
  );
  expect(reads).toHaveLength(20);
  expect(Math.min(...reads)).toBe(1);
  expect(screen.queryByRole('textbox', { name: 'Reply in thread' })).toBeNull();
});

test('an unsent thread reply stays with its thread; the channel composer has its own draft', async () => {
  const root = storedMessage(1, 'Draft target root');
  messages = [root];
  mountThreadRoute(root.messageId);
  const threadInput = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Reply in thread',
  });
  fireEvent.change(threadInput, {
    target: { value: 'Unsent answer for this thread' },
  });
  // Leaving the thread does not carry its text to the channel.
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Back to #general' })[0]!,
  );
  const channelInput = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
  expect(channelInput.value).toBe('');
  const send = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' });
  fireEvent.change(channelInput, { target: { value: 'A channel message' } });
  await waitFor(() => expect(send().disabled).toBe(false));
  fireEvent.click(send());
  await screen.findByText('A channel message');
  // Back in the thread, its own draft is waiting and still answers the root.
  // The root is the first message; its Reply opens its thread.
  fireEvent.click(screen.getAllByRole('button', { name: 'Reply to Ada' })[0]!);
  const restored = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Reply in thread',
  });
  expect(restored.value).toBe('Unsent answer for this thread');
  await waitFor(() => expect(send().disabled).toBe(false));
  fireEvent.click(send());
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes.map((write) => [write.text, write.replyTo ?? null])).toEqual([
    ['A channel message', null],
    ['Unsent answer for this thread', root.messageId],
  ]);
});

test('a Project this Station does not have reads as missing, not as an unavailable room to retry', async () => {
  // The room routes answer 404 with the Project's own code (#4855).
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (
      init?.method !== 'POST' &&
      (url.pathname === '/api/projects/team/room' ||
        url.pathname === '/api/projects/team/channels')
    )
      return Response.json(
        { error: { code: 'project_room_project_not_found' } },
        { status: 404 },
      );
    return original(input, init);
  });
  mount();
  await screen.findByText("This Project isn't on this Station.");
  expect(screen.queryByText(/Room unavailable/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open room' })).toBeNull();
});

// #4855 round 3: a coarse clock, and a late Agent acknowledgement.
test('a thread seek keeps paging when successive reads share a timestamp', async () => {
  // A privacy-rounded clock gives quick reads the same `dataUpdatedAt`; the
  // seek must still page from the history result itself.
  messages = Array.from({ length: 501 }, (_, index) =>
    storedMessage(index + 1, `Clock update ${index + 1}`),
  );
  const realNow = Date.now.bind(Date);
  const clock = vi
    .spyOn(Date, 'now')
    .mockImplementation(() => Math.floor(realNow() / 100) * 100);
  try {
    const reads = watchHistoryReads();
    mountThreadRoute(String(messages[25]!.messageId));
    await screen.findByText('Clock update 26', {}, { timeout: 10_000 });
    expect(reads).toHaveLength(20);
  } finally {
    clock.mockRestore();
  }
});

test('an Agent acknowledgement after leaving the thread clears only the thread draft it was asked from', async () => {
  const root = storedMessage(1, 'Agent draft root');
  messages = [root];
  mountThreadRoute();
  const channel = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
  fireEvent.change(channel, { target: { value: 'Private channel draft' } });
  // Open the root's thread and ask an Agent from it.
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Ada' }));
  const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Reply in thread',
  });
  fireEvent.change(input, { target: { value: 'Thread agent request' } });
  fireEvent.change(input, {
    target: { value: 'Thread agent request @', selectionStart: 22 },
  });
  fireEvent.select(input, { target: { selectionStart: 22 } });
  fireEvent.click(await screen.findByRole('option', { name: /Researcher/ }));
  const release = holdAgentRequest();
  try {
    fireEvent.click(
      await screen.findByRole('button', { name: 'Ask Researcher' }),
    );
    await waitFor(() => expect(agentWrites).toHaveLength(1));
    // Leave the thread before the acknowledgement arrives.
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Back to #general' })[0]!,
    );
    const back = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message the project',
    });
    expect(back.value).toBe('Private channel draft');
    await act(async () => {
      release();
    });
    await screen.findByText(
      'Agent is working. Its answer will appear in the Room.',
    );
    // The channel keeps its own draft.
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Message the project',
      }).value,
    ).toBe('Private channel draft');
    // The thread's asked draft was cleared, and nothing else moved into it.
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Ada' }));
    const reopened = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Reply in thread',
    });
    expect(reopened.value).toBe('');
    expect(agentWrites[0]!.replyTo).toBe(root.messageId);
  } finally {
    release();
  }
});

test('an acknowledgement keeps a newer draft retyped to the asked text, with its recipient (#4855)', async () => {
  mount();
  await screen.findByRole('textbox', { name: 'Message the project' });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
        .disabled,
    ).toBe(false),
  );
  await mentionAgent('Researcher');
  fireEvent.change(composerField(), { target: { value: 'Continue' } });
  const release = holdAgentRequest();
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
    await waitFor(() => expect(agentWrites).toHaveLength(1));
    // A newer draft that happens to read the same as the one asked.
    fireEvent.change(composerField(), { target: { value: 'Something else' } });
    fireEvent.change(composerField(), { target: { value: 'Continue' } });
    await act(async () => release());
    await screen.findByText(
      'Agent is working. Its answer will appear in the Room.',
    );
    expect(composerField().value).toBe('Continue');
    expect(screen.getByText('@Researcher')).toBeTruthy();
  } finally {
    release();
  }
});

test('a draft stored before revisions existed is still cleared by a late acknowledgement after leaving its thread (#4855)', async () => {
  const root = storedMessage(1, 'Legacy draft root');
  messages = [root];
  // A thread draft written by the build before revisions: text and an Agent
  // recipient, no `revision`. The key is the thread's own draft key.
  sessionStorage.setItem(
    `station-room-draft:${JSON.stringify([
      requestScope.authorityKey,
      requestScope.apiBase,
      'project',
      'team',
      'project-room',
      'thread',
      root.messageId,
    ])}`,
    JSON.stringify({
      text: 'Legacy thread ask',
      recipient: { id: 'researcher', name: 'Researcher' },
    }),
  );
  mountThreadRoute();
  await screen.findByText('Legacy draft root');
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Ada' }));
  const thread = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Reply in thread',
  });
  expect(thread.value).toBe('Legacy thread ask');
  const release = holdAgentRequest();
  try {
    // Ask without editing, then leave before the acknowledgement arrives.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Ask Researcher' }),
    );
    await waitFor(() => expect(agentWrites).toHaveLength(1));
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Back to #general' })[0]!,
    );
    await screen.findByRole('textbox', { name: 'Message the project' });
    await act(async () => release());
    await screen.findByText(
      'Agent is working. Its answer will appear in the Room.',
    );
    // The asked draft was cleared, so its text does not come back.
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Ada' }));
    const reopened = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Reply in thread',
    });
    expect(reopened.value).toBe('');
    expect(screen.queryByText('@Researcher')).toBeNull();
    expect(agentWrites[0]!.text).toBe('Legacy thread ask');
  } finally {
    release();
  }
});

test('an immediate Enter on a legacy thread draft submits the migrated revision, so a late acknowledgement still clears it', async () => {
  const { createRoot } = await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  const rootMessage = storedMessage(1, 'Immediate legacy root');
  messages = [rootMessage];
  const draftKey = `station-room-draft:${JSON.stringify([
    requestScope.authorityKey,
    requestScope.apiBase,
    'project',
    'team',
    'project-room',
    'thread',
    rootMessage.messageId,
  ])}`;
  sessionStorage.setItem(
    draftKey,
    JSON.stringify({
      text: 'Immediate legacy ask',
      recipient: { id: 'researcher', name: 'Researcher' },
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const tree = (rootId?: string) => (
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
        routeChannel={{ id: undefined }}
        thread={{ rootId, open: () => {} }}
      />
    </QueryClientProvider>
  );
  const release = holdAgentRequest();
  try {
    await act(async () => root.render(tree()));
    await screen.findByText('Immediate legacy root');
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Recap Project' })
          .disabled,
      ).toBe(false),
    );
    // Commit the route without act's additional drain of passive updates.
    flushSync(() => root.render(tree(rootMessage.messageId)));
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Reply in thread',
    });
    expect(field.value).toBe('Immediate legacy ask');
    const ask = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Ask Researcher',
    });
    if (ask.disabled) await waitFor(() => expect(ask.disabled).toBe(false));
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await waitFor(() => expect(agentWrites).toHaveLength(1));
    await act(async () => root.render(tree()));
    await act(async () => release());
    await screen.findByText(
      'Agent is working. Its answer will appear in the Room.',
    );
    await act(async () => root.render(tree(rootMessage.messageId)));
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Reply in thread',
      }).value,
    ).toBe('');
  } finally {
    release();
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});

test('a live delete reaches a row kept from a history window the room has moved past (#4797)', async () => {
  messages = Array.from({ length: 25 }, (_, i) =>
    storedMessage(i + 1, `Original ${i + 1}`),
  );
  const first = messages[0]!;
  const { client } = mount();
  await screen.findByText('Original 1');
  messages.push(
    ...Array.from({ length: 25 }, (_, i) =>
      storedMessage(i + 26, `New ${i + 26}`),
    ),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['project-room'] });
  });
  await screen.findByText('New 50');
  expect(screen.getByText('Original 1')).toBeTruthy();
  messages[0] = { ...first, text: '', deletedAt: at };
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  await act(async () => {
    for (const stream of streams)
      stream.enqueue(
        new TextEncoder().encode(
          `event: changed\ndata: ${JSON.stringify({ roomId, lastSeq: 50 })}\n\n`,
        ),
      );
  });
  await waitFor(() => expect(screen.queryByText('Original 1')).toBeNull());
  expect(screen.getByText('Message deleted')).toBeTruthy();
});

/**
 * #4852 review: a thread root kept from a window `newer` messages back, then
 * deleted. The retained re-read covers 500 messages below the live windows.
 */
async function deleteKeptThreadRoot(newer: number) {
  messages = Array.from({ length: 25 }, (_, i) =>
    storedMessage(i + 1, `Original ${i + 1}`),
  );
  const first = messages[0]!;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
        routeChannel={{ id: undefined }}
        thread={{ rootId: first.messageId as string, open: () => {} }}
      />
    </QueryClientProvider>,
  );
  await screen.findByText('Original 1');
  messages.push(
    ...Array.from({ length: newer }, (_, i) =>
      storedMessage(i + 26, `New ${i + 26}`),
    ),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['project-room'] });
  });
  await waitFor(() =>
    expect(
      client
        .getQueryCache()
        .getAll()
        .some(
          (query) =>
            query.queryKey.at(-1) === newer && query.state.status === 'success',
        ),
    ).toBe(true),
  );
  messages[0] = { ...first, text: '', deletedAt: at };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['project-room'] });
  });
  return client;
}

test('a kept row the re-read can still reach shows a live delete: 500 newer messages (#4852)', async () => {
  await deleteKeptThreadRoot(500);
  await screen.findByText('Message deleted');
  expect(screen.queryByText('Original 1')).toBeNull();
});

test('a kept row past the re-read span is never left showing deleted text: 501 newer messages (#4852)', async () => {
  await deleteKeptThreadRoot(501);
  // The root left the live windows and was read again at once (a tombstone);
  // the thread's seek then paged back so it is inside the re-read span. The
  // deleted text never shows, and the thread does not give up on its root.
  await screen.findByText('Message deleted', {}, { timeout: 10_000 });
  expect(screen.queryByText('Original 1')).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(screen.getByText('Message deleted')).toBeTruthy();
  expect(screen.queryByText('Original 1')).toBeNull();
  expect(
    screen.queryByText('This thread is too far back to open here.'),
  ).toBeNull();
});

test('an open thread whose kept root the re-read can reach stays open as the tail moves: 480 newer messages (#4852)', async () => {
  messages = Array.from({ length: 25 }, (_, i) =>
    storedMessage(i + 1, `Original ${i + 1}`),
  );
  const root = messages[0]!;
  const reads = watchHistoryReads();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
        routeChannel={{ id: undefined }}
        thread={{ rootId: root.messageId as string, open: () => {} }}
      />
    </QueryClientProvider>,
  );
  await screen.findByText('Original 1');
  messages.push(
    ...Array.from({ length: 480 }, (_, i) =>
      storedMessage(i + 26, `New ${i + 26}`),
    ),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['project-room'] });
  });
  await waitFor(() =>
    expect(
      client
        .getQueryCache()
        .getAll()
        .some(
          (query) =>
            query.queryKey.at(-1) === 480 && query.state.status === 'success',
        ),
    ).toBe(true),
  );
  // The root was kept, not retired: no seek paged back for it, the thread
  // stayed open, and a later delete still reaches it. A retired root would
  // start a seek as soon as the new tail settles, so let that happen first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const seeks = reads.filter((after) => after > 0 && after < 480);
  expect(seeks).toEqual([]);
  expect(screen.getByText('Original 1')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Reply in thread' })).toBeTruthy();
  expect(
    screen.queryByText('This thread is too far back to open here.'),
  ).toBeNull();
  messages[0] = { ...root, text: '', deletedAt: at };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['project-room'] });
  });
  await screen.findByText('Message deleted');
  expect(screen.queryByText('Original 1')).toBeNull();
});

/** Hundreds of rows mount the transcript virtualizer, which jsdom lacks. */
function stubResizeObserver() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

test('paging back stops at the windows a room keeps and says so, without dropping the newest rows (#4852)', async () => {
  messages = Array.from({ length: 520 }, (_, index) =>
    storedMessage(index + 1, `Paged ${index + 1}`),
  );
  stubResizeObserver();
  const { client } = mount();
  await screen.findByText('Paged 520');
  // Rows are virtualized, so the loaded windows are read from the history.
  const windows = () => {
    const history = client
      .getQueryCache()
      .getAll()
      .find(
        (query) =>
          query.queryKey.includes('history') &&
          Array.isArray(
            (query.state.data as { pages?: unknown[] } | undefined)?.pages,
          ),
      );
    return (
      (
        history?.state.data as
          | { pages: { messages: { seq: number }[] }[] }
          | undefined
      )?.pages ?? []
    );
  };
  for (let page = 1; page < 20; page++) {
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load earlier messages' }),
    );
    await waitFor(() => expect(windows()).toHaveLength(page + 1));
  }
  await screen.findByText('This view keeps the latest 500 messages.');
  expect(
    screen.queryByRole('button', { name: 'Load earlier messages' }),
  ).toBeNull();
  // The newest window is still loaded (nothing was dropped to make room),
  // and the oldest loaded message is the 500th from the newest.
  const loaded = windows();
  expect(loaded).toHaveLength(20);
  expect(loaded[0]!.messages.at(-1)!.seq).toBe(520);
  expect(loaded.at(-1)!.messages[0]!.seq).toBe(21);
});

test('rows the room unloads to stay current are announced, and Load earlier brings history back (#4852)', async () => {
  stubResizeObserver();
  messages = Array.from({ length: 25 }, (_, i) =>
    storedMessage(i + 1, `Original ${i + 1}`),
  );
  const { client } = mount();
  await screen.findByText('Original 1');
  messages.push(
    ...Array.from({ length: 501 }, (_, i) =>
      storedMessage(i + 26, `New ${i + 26}`),
    ),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['project-room'] });
  });
  await screen.findByText(
    'Earlier messages were unloaded to keep this view current.',
  );
  expect(screen.queryByText('Original 1')).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Load earlier messages' }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText(
        'Earlier messages were unloaded to keep this view current.',
      ),
    ).toBeNull(),
  );
});

test('a delete that lands as the tail moves reaches the row at once, though the old window read was cancelled (#4852)', async () => {
  messages = Array.from({ length: 25 }, (_, i) =>
    storedMessage(i + 1, `Concurrent ${i + 1}`),
  );
  const first = messages[0]!;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
        routeChannel={{ id: undefined }}
        thread={{ rootId: first.messageId as string, open: () => {} }}
      />
    </QueryClientProvider>,
  );
  await screen.findByText('Concurrent 1');
  // Hold the old window's re-read until the tail has moved, so it is
  // cancelled and never shows the delete.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let oldStarted = false;
  let aborted = false;
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (
      url.pathname.endsWith('/messages') &&
      Number(url.searchParams.get('after')) === 0 &&
      !oldStarted
    ) {
      oldStarted = true;
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      const response = await original(input, init);
      await held;
      return response;
    }
    return original(input, init);
  });
  messages[0] = { ...first, text: '', deletedAt: at };
  messages.push(
    ...Array.from({ length: 100 }, (_, i) =>
      storedMessage(i + 26, `Fresh ${i + 26}`),
    ),
  );
  try {
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['project-room'] });
    });
    await waitFor(() =>
      expect(
        client
          .getQueryCache()
          .getAll()
          .some(
            (query) =>
              query.queryKey.at(-1) === 100 && query.state.status === 'success',
          ),
      ).toBe(true),
    );
    expect(oldStarted).toBe(true);
    expect(aborted).toBe(true);
    // No second change: the rows that left the live windows are read again.
    await screen.findByText('Message deleted');
    expect(screen.queryByText('Concurrent 1')).toBeNull();
  } finally {
    release();
  }
});

test('the unloaded notice stays when Load earlier fails, since nothing came back (#4852)', async () => {
  stubResizeObserver();
  messages = Array.from({ length: 25 }, (_, i) =>
    storedMessage(i + 1, `Notice ${i + 1}`),
  );
  const { client } = mount();
  await screen.findByText('Notice 1');
  messages.push(
    ...Array.from({ length: 501 }, (_, i) =>
      storedMessage(i + 26, `Later ${i + 26}`),
    ),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['project-room'] });
  });
  await screen.findByText(
    'Earlier messages were unloaded to keep this view current.',
  );
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (
      url.pathname.endsWith('/messages') &&
      Number(url.searchParams.get('after')) === 476
    )
      return Response.json(
        { success: false, error: 'Older page unavailable' },
        { status: 503 },
      );
    return original(input, init);
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Load earlier messages' }),
  );
  await screen.findByText('History could not be loaded.');
  expect(screen.queryByText('Notice 1')).toBeNull();
  expect(
    screen.getByText(
      'Earlier messages were unloaded to keep this view current.',
    ),
  ).toBeTruthy();
});

test('a kept row past the re-read span that changes later is not shown stale: it was retired (#4852)', async () => {
  stubResizeObserver();
  messages = Array.from({ length: 25 }, (_, i) =>
    storedMessage(i + 1, `Kept ${i + 1}`),
  );
  const first = messages[0]!;
  const { client } = mount();
  await screen.findByText('Kept 1');
  messages.push(
    ...Array.from({ length: 501 }, (_, i) =>
      storedMessage(i + 26, `After ${i + 26}`),
    ),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['project-room'] });
  });
  await screen.findByText(
    'Earlier messages were unloaded to keep this view current.',
  );
  // Later, the row past the span is deleted. Nothing re-reads that far back,
  // so a kept copy would stay stale; retirement means it is not on screen.
  messages[0] = { ...first, text: '', deletedAt: at };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['project-room'] });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(screen.queryByText('Kept 1')).toBeNull();
});
