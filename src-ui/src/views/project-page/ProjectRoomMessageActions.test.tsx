/** @vitest-environment jsdom */

import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../../../../packages/sdk/src/client/http';
import { resetPublicStationCapabilities } from '../../../../packages/sdk/src/client/publicStationCapabilities';
import { ProjectRoom } from './ProjectRoom';

/**
 * Reactions (#4796), edits and deletes (#4797) and channel files (#4812) in
 * the Project room, over a fetch stub that answers in the routes' shapes.
 */
const roomId = '11111111-1111-4111-8111-111111111111';
const apiBase = 'https://actions.example';
const me = { id: 'ada', displayName: 'Ada', kind: 'person' };
const jo = { id: 'jo', displayName: 'Jo', kind: 'person' };
const scout = { id: 'scout', displayName: 'Scout', kind: 'agent' };
const scope = {
  stationId: 'station',
  localProjectId: 'project',
  localProjectSlug: 'team',
  portableProjectId: 'portable',
};
const at = '2026-11-02T14:00:00.000Z';
const uuid = (n: number, prefix = 'aaaaaaaa') =>
  `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
type Message = Record<string, unknown> & {
  messageId: string;
  actor: typeof me;
  text: string;
};
let messages: Message[];
let supported: boolean;
let calls: { path: string; body: Record<string, unknown> }[];
let failReaction: number | undefined;
/** When set, an upload answers only after it settles. */
let uploadGate: Promise<void> | undefined;

function message(seq: number, actor: typeof me, text: string): Message {
  return {
    intentId: uuid(seq, 'bbbbbbbb'),
    text,
    roomId,
    messageId: uuid(seq),
    seq,
    actor,
    createdAt: at,
  };
}
function fixture() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const ok = (data: unknown) => Response.json({ success: true, data });
      if (path === '/.well-known/station/v1')
        return Response.json({
          schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
          environmentId: 'room-actions',
          authentication: {
            scheme: 'bearer',
            protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
          },
          transports: {
            http: REMOTE_AUTH_PROTOCOL_VERSION,
            sse: REMOTE_AUTH_PROTOCOL_VERSION,
            websocket: REMOTE_AUTH_PROTOCOL_VERSION,
          },
          compatibility: {
            serverVersion: '0.4.1',
            protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
            minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
          },
          capabilities: supported ? { projectRoomMessageActions: true } : {},
        });
      if (body) calls.push({ path, body });
      if (path === '/api/projects/team/channels')
        return ok({
          channels: [{ channelId: roomId, name: 'general', isDefault: true }],
        });
      if (path.endsWith('/events'))
        return new Response(new ReadableStream(), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      if (path.endsWith('/presence')) return ok([]);
      if (path.endsWith('/attachments') && body && uploadGate) await uploadGate;
      if (path.endsWith('/attachments') && body)
        return ok(
          body.attachments.map(
            (file: Record<string, unknown>, index: number) => ({
              id: uuid(900 + index, 'cccccccc'),
              kind: file.kind,
              name: file.name,
              mimeType: file.mimeType,
              size: file.size,
            }),
          ),
        );
      const action = /\/messages\/([^/]+)\/(reactions|edit|delete)$/.exec(path);
      if (action) {
        const target = messages.find((m) => m.messageId === action[1])!;
        if (action[2] === 'reactions') {
          if (failReaction) {
            const status = failReaction;
            failReaction = undefined;
            return Response.json(
              { error: { code: 'project_room_capacity' } },
              { status },
            );
          }
          const reactions = (
            (target.reactions as { emoji: string; actors: (typeof me)[] }[]) ??
            []
          )
            .map((r) => ({
              ...r,
              actors: r.actors.filter(
                (a) => !(r.emoji === body.emoji && a.id === me.id),
              ),
            }))
            .filter((r) => r.actors.length);
          if (body.reacted) {
            const existing = reactions.find((r) => r.emoji === body.emoji);
            if (existing) existing.actors.push(me);
            else reactions.push({ emoji: body.emoji, actors: [me] });
          }
          if (reactions.length) target.reactions = reactions;
          else delete target.reactions;
        } else if (action[2] === 'edit') {
          target.text = body.text;
          target.editedAt = at;
        } else {
          target.text = '';
          target.deletedAt = at;
          delete target.reactions;
          delete target.attachments;
        }
        return ok(target);
      }
      if (path.endsWith('/messages') && body) {
        const posted = {
          ...message(messages.length + 1, me, body.text),
          intentId: body.intentId,
          ...(body.attachments ? { attachments: body.attachments } : {}),
        };
        messages.push(posted);
        return ok(posted);
      }
      if (path.endsWith('/messages'))
        return ok({
          scope,
          roomId,
          messages,
          checkpoint: { roomId, lastSeq: messages.length },
          nextAfter: null,
        });
      if (path.includes('/attachments/'))
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      return ok({
        scope,
        roomId,
        actor: me,
        presence: [],
        capabilities: { view: true, discuss: true, edit: true, execute: false },
        checkpoint: { roomId, lastSeq: messages.length },
        note: null,
      });
    }),
  );
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={{ apiBase, authorityKey: 'one' }}
      />
    </QueryClientProvider>,
  );
}
const row = async (text: string) =>
  (await screen.findByText(text)).closest('.room-row') as HTMLElement;
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetPublicStationCapabilities();
  supported = true;
  calls = [];
  failReaction = undefined;
  uploadGate = undefined;
  messages = [
    message(1, jo, 'Pricing copy is ready.'),
    message(2, scout, 'Two numbers differ from the plan.'),
    message(3, me, 'Good catch, updating now.'),
  ];
  messages[0]!.reactions = [{ emoji: '👍', actors: [jo, me] }];
  setClientCredentialResolver(() => ({
    origin: apiBase,
    requestAuthority: {
      apiBase,
      authorityKey: 'one',
      isCurrent: () => true,
    },
  }));
  fixture();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('a pill shows the count and the reader’s own state, and a tap takes the reaction back', async () => {
  mount();
  const pill = await screen.findByRole('button', { name: '👍 2: Jo and You' });
  expect(pill.getAttribute('aria-pressed')).toBe('true');
  expect(pill.textContent).toBe('👍2');
  fireEvent.click(pill);
  await waitFor(() =>
    expect(calls.at(-1)).toMatchObject({
      path: `/api/projects/team/room/messages/${uuid(1)}/reactions`,
      body: { emoji: '👍', reacted: false, expectedActorId: 'ada' },
    }),
  );
  const after = await screen.findByRole('button', { name: '👍 1: Jo' });
  expect(after.getAttribute('aria-pressed')).toBe('false');
});

test('the picker searches by name and reacts with the emoji picked', async () => {
  mount();
  fireEvent.click(
    within(await row('Two numbers differ from the plan.')).getByRole('button', {
      name: 'React to Scout',
    }),
  );
  const picker = await screen.findByRole('dialog', { name: 'Add reaction' });
  expect(within(picker).getByRole('heading', { name: 'Recent' })).toBeTruthy();
  fireEvent.change(within(picker).getByRole('searchbox'), {
    target: { value: 'party' },
  });
  fireEvent.click(within(picker).getByRole('button', { name: '🎉' }));
  await waitFor(() =>
    expect(calls.at(-1)?.body).toMatchObject({ emoji: '🎉', reacted: true }),
  );
  expect(await screen.findByRole('button', { name: '🎉 1: You' })).toBeTruthy();
  // The pick is remembered first among Recent.
  expect(
    JSON.parse(localStorage.getItem('station.room.recent-emoji')!),
  ).toEqual(['🎉']);
});

test('a refused reaction says why', async () => {
  failReaction = 429;
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: '👍 2: Jo and You' }),
  );
  expect(
    await screen.findByText('This message has all the reactions it can hold.'),
  ).toBeTruthy();
});

test('only your own person messages offer Edit and Delete', async () => {
  mount();
  for (const text of [
    'Pricing copy is ready.',
    'Two numbers differ from the plan.',
  ]) {
    const other = await row(text);
    expect(within(other).queryByRole('button', { name: 'Edit message' })).toBe(
      null,
    );
    expect(
      within(other).queryByRole('button', { name: 'Delete message' }),
    ).toBe(null);
  }
  const own = await row('Good catch, updating now.');
  expect(
    within(own).getByRole('button', { name: 'Edit message' }),
  ).toBeTruthy();
  expect(
    within(own).getByRole('button', { name: 'Delete message' }),
  ).toBeTruthy();
});

test('Up in an empty composer edits your last message, saves it as an edit, and marks it edited', async () => {
  mount();
  const field = await screen.findByRole('textbox', {
    name: 'Message the project',
  });
  await row('Good catch, updating now.');
  fireEvent.keyDown(field, { key: 'ArrowUp' });
  expect(await screen.findByText('Editing message')).toBeTruthy();
  expect((field as HTMLTextAreaElement).value).toBe(
    'Good catch, updating now.',
  );
  // Nothing to save until the text changes.
  expect(
    screen.getByRole('button', { name: 'Save edit' }).matches(':disabled'),
  ).toBe(true);
  fireEvent.change(field, { target: { value: 'Good catch, both fixed.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  await waitFor(() =>
    expect(calls.at(-1)).toMatchObject({
      path: `/api/projects/team/room/messages/${uuid(3)}/edit`,
      body: { text: 'Good catch, both fixed.' },
    }),
  );
  const edited = await row('Good catch, both fixed.');
  expect(within(edited).getByText('edited')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('Editing message')).toBe(null));
  expect((field as HTMLTextAreaElement).value).toBe('');
});

test('Up with a draft keeps the draft, and Escape cancels an edit without saving', async () => {
  mount();
  const field = await screen.findByRole('textbox', {
    name: 'Message the project',
  });
  await row('Good catch, updating now.');
  fireEvent.change(field, { target: { value: 'half a thought' } });
  fireEvent.keyDown(field, { key: 'ArrowUp' });
  expect(screen.queryByText('Editing message')).toBe(null);
  fireEvent.change(field, { target: { value: '' } });
  fireEvent.keyDown(field, { key: 'ArrowUp' });
  await screen.findByText('Editing message');
  fireEvent.keyDown(field, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByText('Editing message')).toBe(null));
  expect(calls.some((call) => call.path.endsWith('/edit'))).toBe(false);
});

test('Delete asks first, and a confirmed delete leaves a tombstone', async () => {
  mount();
  const own = await row('Good catch, updating now.');
  fireEvent.click(within(own).getByRole('button', { name: 'Delete message' }));
  const confirm = await screen.findByRole('alertdialog', {
    name: 'Delete this message?',
  });
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBe(null));
  expect(calls.some((call) => call.path.endsWith('/delete'))).toBe(false);
  fireEvent.click(within(own).getByRole('button', { name: 'Delete message' }));
  fireEvent.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    }),
  );
  expect(await screen.findByText('Message deleted')).toBeTruthy();
  expect(screen.queryByText('Good catch, updating now.')).toBe(null);
  expect(calls.find((call) => call.path.endsWith('/delete'))?.path).toBe(
    `/api/projects/team/room/messages/${uuid(3)}/delete`,
  );
});

test('a pasted image uploads, then the message names it, and history shows it', async () => {
  mount();
  const field = await screen.findByRole('textbox', {
    name: 'Message the project',
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy(),
  );
  const file = new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
    'screen.png',
    { type: 'image/png' },
  );
  fireEvent.paste(field, {
    clipboardData: { types: ['Files'], files: [file], items: [] },
  });
  expect(await screen.findByRole('img', { name: 'screen.png' })).toBeTruthy();
  const send = screen.getByRole('button', { name: 'Send message' });
  await waitFor(() => expect(send.matches(':disabled')).toBe(false));
  fireEvent.click(send);
  const writes = () => calls.filter((call) => !call.path.endsWith('/presence'));
  await waitFor(() =>
    expect(writes().map((call) => call.path)).toEqual([
      '/api/projects/team/room/attachments',
      '/api/projects/team/room/messages',
    ]),
  );
  expect(writes()[0]!.body.attachments).toEqual([
    {
      kind: 'image',
      name: 'screen.png',
      mimeType: 'image/png',
      size: 8,
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    },
  ]);
  expect(writes()[1]!.body).toMatchObject({
    text: '',
    attachments: [{ id: uuid(900, 'cccccccc'), name: 'screen.png' }],
  });
  const list = await screen.findByRole('list', { name: 'Attached files' });
  expect(
    await within(list).findByRole('img', { name: 'screen.png' }),
  ).toBeTruthy();
});

test('a host without message actions keeps the room as it was', async () => {
  supported = false;
  mount();
  const own = await row('Good catch, updating now.');
  expect(
    within(own).getByRole('button', { name: 'Reply to Ada' }),
  ).toBeTruthy();
  expect(within(own).queryByRole('button', { name: 'React to Ada' })).toBe(
    null,
  );
  expect(within(own).queryByRole('button', { name: 'Edit message' })).toBe(
    null,
  );
  expect(screen.queryByRole('button', { name: 'Attach files' })).toBe(null);
  // Reactions others made still show; they just cannot be changed here.
  const pill = screen.getByRole('button', { name: '👍 2: Jo and You' });
  expect(pill.matches(':disabled')).toBe(true);
});

/** A phone: touch keyboard, coarse pointer and the mobile breakpoint. */
function emulatePhone() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: /coarse|hover: none|max-width/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

test('on a touch phone, ⋯ opens a labelled menu: focus moves in, Delete is destructive, Esc returns to ⋯', async () => {
  emulatePhone();
  mount();
  const own = await row('Good catch, updating now.');
  // No unlabelled icon bar on touch: the actions live behind ⋯.
  expect(within(own).queryByRole('toolbar')).toBe(null);
  const more = within(own).getByRole('button', { name: /^More actions for/ });
  fireEvent.click(more);
  const menu = await screen.findByRole('menu');
  const items = within(menu).getAllByRole('menuitem');
  expect(items.map((item) => item.textContent?.trim())).toEqual([
    'React',
    'Reply',
    'Edit',
    'Delete',
  ]);
  await waitFor(() => expect(document.activeElement).toBe(items[0]));
  expect(items[3]!.className).toContain('action-overflow__row--danger');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBe(null));
  expect(document.activeElement).toBe(more);
  // Someone else's message with reactions offers who reacted, not Edit.
  fireEvent.click(
    within(await row('Pricing copy is ready.')).getByRole('button', {
      name: /^More actions for/,
    }),
  );
  const theirs = await screen.findByRole('menu');
  expect(
    within(theirs)
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.trim()),
  ).toEqual(['React', 'Reply', 'Who reacted']);
  // Delete from the menu still asks first.
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  fireEvent.click(
    within(own).getByRole('button', { name: /^More actions for/ }),
  );
  fireEvent.click(
    within(await screen.findByRole('menu')).getByRole('menuitem', {
      name: 'Delete',
    }),
  );
  expect(
    await screen.findByRole('alertdialog', { name: 'Delete this message?' }),
  ).toBeTruthy();
});

function threadTree(client: QueryClient, rootId?: string) {
  return (
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={{ apiBase, authorityKey: 'one' }}
        routeChannel={{ id: undefined }}
        thread={{ rootId, open: () => {} }}
      />
    </QueryClientProvider>
  );
}
const pngFile = (name: string) =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, {
    type: 'image/png',
  });
const pasteFile = (field: HTMLElement, file: File) =>
  fireEvent.paste(field, {
    clipboardData: { types: ['Files'], files: [file], items: [] },
  });

test('a file staged in a thread stays with that thread: the channel sends without it, and the thread still has it', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = render(threadTree(client, uuid(1)));
  const reply = await screen.findByRole('textbox', { name: 'Reply in thread' });
  await screen.findByRole('button', { name: 'Attach files' });
  pasteFile(reply, pngFile('thread-only.png'));
  await screen.findByRole('img', { name: 'thread-only.png' });
  ui.rerender(threadTree(client));
  const channel = await screen.findByRole('textbox', {
    name: 'Message the project',
  });
  expect(screen.queryByRole('img', { name: 'thread-only.png' })).toBeNull();
  fireEvent.change(channel, { target: { value: 'channel-only text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() =>
    expect(calls.some((c) => c.path.endsWith('/messages'))).toBe(true),
  );
  const posted = calls.find((c) => c.path.endsWith('/messages'))!;
  expect(posted.body.text).toBe('channel-only text');
  expect(posted.body.replyTo).toBeUndefined();
  expect(posted.body.attachments).toBeUndefined();
  expect(calls.some((c) => c.path.endsWith('/attachments'))).toBe(false);
  // Back in the thread, its file is still staged and goes with its reply.
  ui.rerender(threadTree(client, uuid(1)));
  await screen.findByRole('img', { name: 'thread-only.png' });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() =>
    expect(
      calls.filter((c) => c.path.endsWith('/messages')).at(-1)?.body,
    ).toMatchObject({
      replyTo: uuid(1),
      attachments: [{ name: 'thread-only.png' }],
    }),
  );
});

test('a send keeps its files when the reader leaves the thread before the upload finishes', async () => {
  let release!: () => void;
  uploadGate = new Promise((resolve) => {
    release = resolve;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = render(threadTree(client, uuid(1)));
  const reply = await screen.findByRole('textbox', { name: 'Reply in thread' });
  await screen.findByRole('button', { name: 'Attach files' });
  pasteFile(reply, pngFile('in-flight.png'));
  await screen.findByRole('img', { name: 'in-flight.png' });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() =>
    expect(calls.some((c) => c.path.endsWith('/attachments'))).toBe(true),
  );
  ui.rerender(threadTree(client));
  const channel = await screen.findByRole('textbox', {
    name: 'Message the project',
  });
  pasteFile(channel, pngFile('channel.png'));
  await screen.findByRole('img', { name: 'channel.png' });
  release();
  await waitFor(() =>
    expect(
      calls.filter((c) => c.path.endsWith('/messages')).at(-1)?.body,
    ).toMatchObject({
      replyTo: uuid(1),
      attachments: [{ name: 'in-flight.png' }],
    }),
  );
  // The channel's own file is neither sent nor cleared by the thread's send.
  expect(screen.getByRole('img', { name: 'channel.png' })).toBeTruthy();
  ui.rerender(threadTree(client, uuid(1)));
  await screen.findByRole('textbox', { name: 'Reply in thread' });
  expect(screen.queryByRole('img', { name: 'in-flight.png' })).toBeNull();
});

test('a long press on a pill opens only Who reacted, and closing it returns focus to the pill', async () => {
  emulatePhone();
  mount();
  const pill = await screen.findByRole('button', { name: '👍 2: Jo and You' });
  const down = new Event('pointerdown', { bubbles: true });
  Object.defineProperties(down, {
    pointerType: { value: 'touch' },
    clientX: { value: 20 },
    clientY: { value: 20 },
  });
  fireEvent(pill, down);
  const sheet = await screen.findByRole('dialog', { name: 'Reactions' });
  // Past the row's own hold too: its action menu never opened.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(
    within(sheet).getByRole('button', { name: 'Close reactions' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Reactions' })).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(pill));
});

test('when the room pauses attachments, the reader is told plainly, nothing is sent, and the text sends without the file (#4852)', async () => {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/attachments') && init?.method === 'POST')
      return Response.json(
        { error: { code: 'project_room_files_unavailable' } },
        { status: 503 },
      );
    return original(input, init);
  });
  mount();
  const composer = await screen.findByRole('textbox', {
    name: 'Message the project',
  });
  await screen.findByRole('button', { name: 'Attach files' });
  pasteFile(composer, pngFile('paused.png'));
  await screen.findByRole('img', { name: 'paused.png' });
  fireEvent.change(composer, { target: { value: 'Still here.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await screen.findByText(
    'Attachments are paused for now. Remove the files to send your message.',
  );
  expect(calls.some((c) => c.path.endsWith('/messages'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Remove paused.png' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith('/messages'))?.body).toMatchObject(
      { text: 'Still here.' },
    ),
  );
  expect(
    calls.find((c) => c.path.endsWith('/messages'))?.body.attachments,
  ).toBeUndefined();
});
