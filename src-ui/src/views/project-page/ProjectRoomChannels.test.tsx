/** @vitest-environment jsdom */

import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../../../../packages/sdk/src/client/http';
import { ProjectRoom } from './ProjectRoom';

const general = '11111111-1111-4111-8111-111111111111';
const design = '22222222-2222-4222-8222-222222222222';
const requestScope = { apiBase: 'https://room.example', authorityKey: 'one' };
const actor = { id: 'ada', displayName: 'Ada', kind: 'person' };
const scope = {
  stationId: 'station',
  localProjectId: 'project',
  localProjectSlug: 'team',
  portableProjectId: 'portable',
};
type Channel = {
  channelId: string;
  name: string;
  topic?: string;
  archivedAt?: string;
  isDefault: boolean;
};
let channels: Channel[];
let channelsSupported: boolean;
let edit: boolean;
let execute: boolean;
let selectedAuthority: string;
let handles: Map<string, Record<string, unknown>>;
/** Stored messages by room; a room with none reads as empty. */
let history: Map<string, Array<Record<string, unknown>>>;
let reads: string[];
let writes: Array<{ method: string; path: string; body: unknown }>;
function fixture() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const ok = (data: unknown) => Response.json({ success: true, data });
      const refuse = (status: number, code: string) =>
        Response.json({ success: false, error: code, code }, { status });
      // Channel writes only; presence heartbeats are not under test here.
      if (method !== 'GET' && !path.endsWith('/presence'))
        writes.push({ method, path, body });
      else reads.push(path);
      if (path === '/api/agents')
        return ok(execute ? [{ slug: 'researcher', name: 'Researcher' }] : []);
      if (path === '/api/projects/team/channels') {
        if (!channelsSupported)
          return new Response('Not Found', { status: 404 });
        if (method === 'POST') {
          if (channels.some((c) => c.name === body.name))
            return refuse(409, 'project_room_duplicate');
          const created = {
            channelId: '33333333-3333-4333-8333-333333333333',
            name: body.name,
            ...(body.topic ? { topic: body.topic } : {}),
            isDefault: false,
          };
          channels.push(created);
          return ok(created);
        }
        return ok({ channels });
      }
      const match = path.match(
        /^\/api\/projects\/team\/(?:room|channels\/([0-9a-f-]{36}))(\/.*)?$/,
      );
      if (!match) throw new Error(`Unexpected ${method} ${path}`);
      // A host that predates channels has no /channels routes at all.
      if (!channelsSupported && match[1])
        return new Response('Not Found', { status: 404 });
      const roomId = match[1] ?? general;
      const suffix = match[2] ?? '';
      if (suffix === '' && method === 'PATCH') {
        const channel = channels.find((c) => c.channelId === roomId)!;
        Object.assign(channel, body.name ? { name: body.name } : {});
        if (body.archived) channel.archivedAt = '2026-11-11T00:00:00.000Z';
        return ok(channel);
      }
      if (suffix === '/events')
        return new Response(new ReadableStream(), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      if (suffix === '/presence') return ok([]);
      if (suffix === '/messages' && method === 'POST')
        return ok({
          intentId: body.intentId,
          text: body.text,
          ...(body.replyTo ? { replyTo: body.replyTo } : {}),
          roomId,
          messageId: randomCorrelationId(),
          seq: 1,
          actor,
          createdAt: '2026-11-11T12:00:00.000Z',
        });
      if (suffix === '/agents' && method === 'POST') {
        const handle = {
          intentId: body.intentId,
          agentId: body.agentId,
          text: body.text,
          roomId,
          requestId: randomCorrelationId(),
          actor,
          state: 'started',
          createdAt: '2026-11-11T12:00:00.000Z',
          updatedAt: '2026-11-11T12:00:00.000Z',
        };
        handles.set(String(handle.requestId), handle);
        return ok(handle);
      }
      const request = suffix.match(/^\/agents\/([0-9a-f-]{36})$/);
      if (request && method === 'GET') return ok(handles.get(request[1]!));
      if (suffix === '/messages') {
        const stored = history.get(roomId) ?? [];
        return ok({
          scope,
          roomId,
          messages: stored,
          checkpoint: { roomId, lastSeq: stored.length },
          nextAfter: null,
        });
      }
      if (suffix === '')
        return ok({
          scope,
          roomId,
          actor,
          presence: [],
          capabilities: { view: true, discuss: true, edit, execute },
          checkpoint: { roomId, lastSeq: history.get(roomId)?.length ?? 0 },
          note: null,
        });
      throw new Error(`Unexpected ${method} ${path}`);
    }),
  );
}
/** `draftRecoveryKey` is the shell's reload partition; drafts persist only with one. */
function mount(draftRecoveryKey?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={{
          ...requestScope,
          authorityKey: selectedAuthority,
          ...(draftRecoveryKey ? { draftRecoveryKey } : {}),
        }}
      />
    </QueryClientProvider>,
  );
}
const composerField = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the project',
  });
async function switchTo(from: string, to: string) {
  const list = await openSwitcher(from);
  const archived = within(list).queryByRole('button', { name: /Archived/ });
  if (
    archived?.getAttribute('aria-expanded') === 'false' &&
    !within(list).queryByRole('button', { name: to })
  )
    fireEvent.click(archived);
  fireEvent.click(within(list).getByRole('button', { name: to }));
  await screen.findByRole('button', { name: trigger(to) });
}
const trigger = (name: string) => new RegExp(`^${name}\\b.*switch channel$`);
async function openSwitcher(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: trigger(name) }));
  return screen.findByRole('dialog', { name: 'Channels' });
}
beforeEach(() => {
  sessionStorage.clear();
  channels = [
    { channelId: general, name: 'general', isDefault: true },
    {
      channelId: design,
      name: 'design',
      topic: 'Screens and flows',
      isDefault: false,
    },
  ];
  channelsSupported = true;
  edit = true;
  execute = false;
  selectedAuthority = 'one';
  handles = new Map();
  history = new Map();
  reads = [];
  writes = [];
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

test('the header names the current channel and the switcher moves to another channel room', async () => {
  mount();
  const heading = await screen.findByRole('heading', { name: /general/ });
  expect(heading.textContent).not.toContain('Project room');
  const list = await openSwitcher('general');
  // Opening lands on the current channel, so arrow/Tab moves from there.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(list).getByRole('button', { name: 'general' }),
    ),
  );
  const items = within(list).getAllByRole('button', { name: /general|design/ });
  expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([
    'true',
    null,
  ]);
  fireEvent.click(within(list).getByRole('button', { name: 'design' }));
  expect(
    await screen.findByRole('button', { name: trigger('design') }),
  ).toBeTruthy();
  expect(screen.getByText('Screens and flows')).toBeTruthy();
  await waitFor(() =>
    expect(reads).toContain(`/api/projects/team/channels/${design}/messages`),
  );
});

test('New channel normalizes the typed name, shows a taken name inline, and submits on Enter', async () => {
  channels.push({
    channelId: '44444444-4444-4444-8444-444444444444',
    name: 'design-review',
    isDefault: false,
  });
  mount();
  const list = await openSwitcher('general');
  fireEvent.click(within(list).getByRole('button', { name: /New channel/ }));
  const form = await screen.findByRole('dialog', { name: 'New channel' });
  const name = within(form).getByRole('textbox', { name: 'Name' });
  await waitFor(() => expect(document.activeElement).toBe(name));
  const user = userEvent.setup();
  await user.type(name, 'Design Review');
  expect((name as HTMLInputElement).value).toBe('design-review');
  await user.keyboard('{Enter}');
  const error = await within(form).findByText('#design-review already exists.');
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(name.getAttribute('aria-describedby')).toBe(error.id);
  await user.clear(name);
  await user.type(name, 'research');
  expect(within(form).queryByText(/already exists/)).toBeNull();
  await user.keyboard('{Enter}');
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'New channel' })).toBeNull(),
  );
  expect(writes.at(-1)).toEqual({
    method: 'POST',
    path: '/api/projects/team/channels',
    body: {
      expectedProjectId: 'project',
      expectedActorId: actor.id,
      name: 'research',
    },
  });
  // The new channel opens.
  expect(
    await screen.findByRole('button', { name: trigger('research') }),
  ).toBeTruthy();
});

test('a name the server would refuse is flagged inline and never sent', async () => {
  mount();
  const list = await openSwitcher('general');
  fireEvent.click(within(list).getByRole('button', { name: /New channel/ }));
  const form = await screen.findByRole('dialog', { name: 'New channel' });
  const name = within(form).getByRole('textbox', { name: 'Name' });
  fireEvent.change(name, { target: { value: 'design--x' } });
  fireEvent.blur(name);
  expect(
    await within(form).findByText(
      'Use lowercase letters, numbers and single hyphens.',
    ),
  ).toBeTruthy();
  fireEvent.submit(name.closest('form')!);
  expect(writes).toEqual([]);
  fireEvent.keyDown(form, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'New channel' })).toBeNull(),
  );
});

test('people without edit can switch but get no channel management', async () => {
  edit = false;
  mount();
  const list = await openSwitcher('general');
  expect(
    within(list).queryByRole('button', { name: /New channel/ }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Channel settings' })).toBeNull();
});

test('an archived channel is marked and read-only', async () => {
  channels[1].archivedAt = '2026-11-10T00:00:00.000Z';
  mount();
  const list = await openSwitcher('general');
  fireEvent.click(within(list).getByRole('button', { name: /Archived \(1\)/ }));
  fireEvent.click(within(list).getByRole('button', { name: 'design' }));
  expect(await screen.findByText('Archived')).toBeTruthy();
  expect(await screen.findByText('No messages were posted here.')).toBeTruthy();
  expect(screen.queryByText('Start a chat with your project team.')).toBeNull();
  expect(screen.getByText('This channel is read-only.')).toBeTruthy();
  expect(
    screen.queryByRole('textbox', { name: 'Message the project' }),
  ).toBeNull();
});

test('a host without channels shows its room as #general with no switcher', async () => {
  channelsSupported = false;
  mount();
  expect(await screen.findByRole('heading', { name: 'general' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /switch channel/ })).toBeNull();
  expect(screen.queryByText('Channels unavailable')).toBeNull();
});

// #4810 integration: one shared conversation and composer, addressed per channel.

test('each channel keeps its own unsent draft while switching', async () => {
  mount('tab');
  await screen.findByRole('textbox', { name: 'Message the project' });
  fireEvent.change(composerField(), { target: { value: 'General draft' } });
  await switchTo('general', 'design');
  await waitFor(() => expect(composerField().value).toBe(''));
  fireEvent.change(composerField(), { target: { value: 'Design draft' } });
  await switchTo('design', 'general');
  await waitFor(() => expect(composerField().value).toBe('General draft'));
  await switchTo('general', 'design');
  await waitFor(() => expect(composerField().value).toBe('Design draft'));
});

test('a reload in a non-default channel returns to that channel with its draft', async () => {
  const first = mount('tab');
  await screen.findByRole('textbox', { name: 'Message the project' });
  await switchTo('general', 'design');
  fireEvent.change(composerField(), { target: { value: 'Design draft' } });
  first.unmount();
  // A reload mints a new authority epoch; the reload partition is stable.
  selectedAuthority = 'two';
  mount('tab');
  expect(
    await screen.findByRole('button', { name: trigger('design') }),
  ).toBeTruthy();
  await waitFor(() => expect(composerField().value).toBe('Design draft'));
  await waitFor(() =>
    expect(reads).toContain(`/api/projects/team/channels/${design}/messages`),
  );
});

test('a message and an @agent ask go to the selected channel', async () => {
  execute = true;
  mount('tab');
  await screen.findByRole('textbox', { name: 'Message the project' });
  await switchTo('general', 'design');
  const user = userEvent.setup();
  await user.type(composerField(), 'Hello design');
  await user.keyboard('{Enter}');
  await waitFor(() =>
    expect(writes).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: `/api/projects/team/channels/${design}/messages`,
        body: expect.objectContaining({
          expectedRoomId: design,
          text: 'Hello design',
        }),
      }),
    ),
  );
  await waitFor(() => expect(composerField().value).toBe(''));
  fireEvent.change(composerField(), { target: { value: '@' } });
  fireEvent.click(
    await screen.findByRole('option', {
      name: /^Researcher Agent @researcher\b/,
    }),
  );
  await screen.findByText('@Researcher');
  fireEvent.change(composerField(), { target: { value: 'Check the copy' } });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Ask Researcher' })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ask Researcher' }));
  await waitFor(() =>
    expect(writes).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: `/api/projects/team/channels/${design}/agents`,
        body: expect.objectContaining({
          expectedRoomId: design,
          agentId: 'researcher',
          text: 'Check the copy',
        }),
      }),
    ),
  );
  expect(
    writes.filter(
      (write) =>
        write.path.startsWith('/api/projects/team/room/') ||
        write.path.startsWith(`/api/projects/team/channels/${general}/`),
    ),
  ).toEqual([]);
});

test('an archived channel offers no composer, no Agent asks and its own empty state', async () => {
  execute = true;
  channels[1].archivedAt = '2026-11-10T00:00:00.000Z';
  mount('tab');
  await screen.findByRole('textbox', { name: 'Message the project' });
  await switchTo('general', 'design');
  const empty = await screen.findByText('No messages were posted here.');
  // It is the shared conversation's own empty state, not a separate block.
  expect(empty.closest('.room-conversation__content--empty')).not.toBeNull();
  expect(screen.queryByText('Start a chat with your project team.')).toBeNull();
  expect(screen.getByText('This channel is read-only.')).toBeTruthy();
  expect(
    screen.queryByRole('textbox', { name: 'Message the project' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: /^Ask / })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Bring an Agent' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Recap Project' })).toBeNull();
});

test('switching away from an unsaved notes draft asks first', async () => {
  mount('tab');
  await screen.findByRole('textbox', { name: 'Message the project' });
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'Notes (Markdown)' }),
    { target: { value: 'Unsaved notes' } },
  );
  const list = await openSwitcher('general');
  fireEvent.click(within(list).getByRole('button', { name: 'design' }));
  expect(
    await screen.findByRole('dialog', { name: 'Unsaved Changes' }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: trigger('general') })).toBeTruthy();
});

test('the message region is named for the channel on screen', async () => {
  mount('tab');
  expect(
    await screen.findByRole('region', { name: 'Messages in #general' }),
  ).toBeTruthy();
  await switchTo('general', 'design');
  expect(
    await screen.findByRole('region', { name: 'Messages in #design' }),
  ).toBeTruthy();
});

/** A touch phone: the shared conversation shows each message's More button. */
function touchPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
const priya = {
  intentId: '44444444-4444-4444-8444-444444444441',
  text: 'New checkout screens are up for review.',
  roomId: design,
  messageId: '44444444-4444-4444-8444-444444444442',
  seq: 1,
  actor: { id: 'priya', displayName: 'Priya', kind: 'person' },
  createdAt: '2026-11-11T11:00:00.000Z',
};

test('on a touch phone a message in another channel opens More actions, and Reply answers in that channel', async () => {
  touchPhone();
  history.set(design, [priya]);
  mount('tab');
  await screen.findByRole('textbox', { name: 'Message the project' });
  await switchTo('general', 'design');
  const more = await screen.findByRole('button', {
    name: /^More actions for Priya's message/,
  });
  fireEvent.click(more);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Reply to Priya' }),
  );
  const user = userEvent.setup();
  await user.type(composerField(), 'Shorter CTA please');
  // On a touch phone Return adds a line; the round button sends (#4810).
  await user.click(screen.getByRole('button', { name: /^Send/ }));
  await waitFor(() =>
    expect(writes).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: `/api/projects/team/channels/${design}/messages`,
        body: expect.objectContaining({
          expectedRoomId: design,
          replyTo: priya.messageId,
          text: 'Shorter CTA please',
        }),
      }),
    ),
  );
});

test('on a touch phone an archived channel offers no message actions', async () => {
  touchPhone();
  channels[1].archivedAt = '2026-11-10T00:00:00.000Z';
  history.set(design, [priya]);
  mount('tab');
  await screen.findByRole('textbox', { name: 'Message the project' });
  await switchTo('general', 'design');
  expect(
    await screen.findByText('New checkout screens are up for review.'),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: /^More actions for / }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: /^Reply to / })).toBeNull();
});

test('a remembered channel falls back to #general on a host without channels', async () => {
  const first = mount('tab');
  await screen.findByRole('textbox', { name: 'Message the project' });
  await switchTo('general', 'design');
  first.unmount();
  // The same tab reloads against an older host.
  channelsSupported = false;
  selectedAuthority = 'two';
  reads = [];
  mount('tab');
  expect(await screen.findByRole('heading', { name: 'general' })).toBeTruthy();
  expect(
    await screen.findByRole('textbox', { name: 'Message the project' }),
  ).toBeTruthy();
  expect(screen.queryByText(/Room unavailable/)).toBeNull();
  await waitFor(() =>
    expect(reads).toContain('/api/projects/team/room/messages'),
  );
});
