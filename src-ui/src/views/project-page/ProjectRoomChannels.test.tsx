/** @vitest-environment jsdom */

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
      if (path === '/api/agents') return ok([]);
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
      if (suffix === '/messages')
        return ok({
          scope,
          roomId,
          messages: [],
          checkpoint: { roomId, lastSeq: 0 },
          nextAfter: null,
        });
      if (suffix === '')
        return ok({
          scope,
          roomId,
          actor,
          presence: [],
          capabilities: { view: true, discuss: true, edit, execute: false },
          checkpoint: { roomId, lastSeq: 0 },
          note: null,
        });
      throw new Error(`Unexpected ${method} ${path}`);
    }),
  );
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProjectRoom
        slug="team"
        projectId="project"
        requestScope={requestScope}
      />
    </QueryClientProvider>,
  );
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
  reads = [];
  writes = [];
  setClientCredentialResolver(() => ({
    origin: requestScope.apiBase,
    requestAuthority: { ...requestScope, isCurrent: () => true },
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
