/** @vitest-environment jsdom */

import { _setApiBase, readMarkerQueries } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../../../../../packages/sdk/src/client/http';
import { ProjectConversationList } from '../ProjectConversationList';

const API = 'https://station.example';
const general = '11111111-1111-4111-8111-111111111111';
const design = '22222222-2222-4222-8222-222222222222';
const research = '33333333-3333-4333-8333-333333333333';
const running = 'station:fix-login';

/** Server read state per target key: `latest` and what this person has seen. */
let markers: Map<string, { latest: number; seen: number }>;
let tasks: Array<Record<string, unknown>>;
let summaries: string[][];

function task(id: string, title: string, minute: number, extra = {}) {
  return {
    id,
    projectId: 'team',
    title,
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'ada',
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: `2026-11-11T10:${String(minute).padStart(2, '0')}:00.000Z`,
    ...extra,
  };
}

beforeEach(() => {
  _setApiBase(API);
  // Channel reads are scoped to the Station the list belongs to.
  setClientCredentialResolver(() => ({
    origin: API,
    requestAuthority: {
      apiBase: API,
      authorityKey: 'one',
      isCurrent: () => true,
    },
  }));
  summaries = [];
  markers = new Map([
    [`project-room:team:${general}`, { latest: 7, seen: 4 }],
    [`project-room:team:${design}`, { latest: 2, seen: 2 }],
    ['task-room:task-login', { latest: 5, seen: 3 }],
    ['task-room:task-notes', { latest: 4, seen: 4 }],
  ]);
  tasks = [
    task('task-notes', 'Draft release notes', 20),
    task('task-login', 'Fix the login redirect', 40, { sessionId: running }),
    // No room was opened for this Task: the summary answers unavailable.
    task('task-rename', 'Rename the checklist', 50),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const ok = (data: unknown) => Response.json({ success: true, data });
      if (url.pathname === '/api/projects/team/channels')
        return ok({
          channels: [
            { channelId: general, name: 'general', isDefault: true },
            { channelId: design, name: 'design', isDefault: false },
            {
              channelId: research,
              name: 'research',
              archivedAt: '2026-11-01T00:00:00.000Z',
              isDefault: false,
            },
          ],
        });
      if (url.pathname === '/api/tasks') return ok(tasks);
      if (url.pathname === '/api/agents') return ok([]);
      if (url.pathname === '/api/orchestration/sessions/read-model')
        return ok([
          {
            provider: 'station',
            threadId: running,
            projectSlug: 'team',
            status: 'busy',
            controlMode: 'station-owned',
            lifecycleState: 'running',
            hasActiveTurn: true,
            answerability: { answerable: true },
            isLoaded: true,
            isPersisted: true,
            eventCount: 1,
            createdAt: '2026-11-11T10:30:00.000Z',
            updatedAt: '2026-11-11T10:40:00.000Z',
          },
        ]);
      if (url.pathname === '/api/read-markers/summary') {
        const { targets } = JSON.parse(String(init?.body)) as {
          targets: Array<Record<string, string>>;
        };
        const keys = targets.map((target) =>
          target.kind === 'project-room'
            ? `project-room:${target.projectSlug}:${target.roomId}`
            : `task-room:${target.taskId}`,
        );
        summaries.push(keys);
        return ok({
          items: targets.map((target, index) => {
            const marker = markers.get(keys[index]!);
            if (!marker) return { target, unavailable: true };
            return {
              target,
              latestVersion: marker.latest,
              seenVersion: marker.seen,
              unread: marker.latest > marker.seen,
              unreadCount: marker.latest - marker.seen,
            };
          }),
        });
      }
      return new Response('Not Found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  _setApiBase('');
});

interface Handlers {
  onOpenChannel(channelId: string | undefined): void;
  onOpenTask(taskId: string): void;
  onMoreTasks(): void;
  onNewChannel(): void;
}

function renderList(handlers: Partial<Handlers> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props: Handlers = {
    onOpenChannel: handlers.onOpenChannel ?? (() => {}),
    onOpenTask: handlers.onOpenTask ?? (() => {}),
    onMoreTasks: handlers.onMoreTasks ?? (() => {}),
    onNewChannel: handlers.onNewChannel ?? (() => {}),
  };
  render(
    <QueryClientProvider client={client}>
      <ProjectConversationList
        project={{ slug: 'team', id: 'project-team', name: 'Team' }}
        requestScope={{ apiBase: API, authorityKey: 'one' }}
        variant="sidebar"
        {...props}
      />
    </QueryClientProvider>,
  );
  return { client };
}

const UNREAD = 'conversation-list__row--unread';
const bold = (element: HTMLElement) => element.classList.contains(UNREAD);

test('lists live channels, default first, and only Tasks whose rooms exist, newest first', async () => {
  renderList();
  const generalRow = await screen.findByRole('button', {
    name: 'general, 3 unread',
  });
  const designRow = screen.getByRole('button', { name: 'design' });
  expect(
    generalRow.compareDocumentPosition(designRow) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: /research/ })).toBeNull();

  const login = await screen.findByRole('button', {
    name: 'Fix the login redirect, Task room, agent working, 2 unread',
  });
  const notes = screen.getByRole('button', {
    name: 'Draft release notes, Task room',
  });
  expect(
    login.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: /Rename the checklist/ }),
  ).toBeNull();
  // One summary request carries every live channel and candidate Task.
  expect(summaries.at(-1)).toEqual([
    `project-room:team:${general}`,
    `project-room:team:${design}`,
    'task-room:task-rename',
    'task-room:task-login',
    'task-room:task-notes',
  ]);
});

test('bold follows the server’s read state, not the client', async () => {
  const { client } = renderList();
  const unread = await screen.findByRole('button', {
    name: 'general, 3 unread',
  });
  expect(bold(unread)).toBe(true);
  expect(bold(screen.getByRole('button', { name: 'design' }))).toBe(false);

  // Another device reads #general: the server's answer changes, nothing here.
  markers.set(`project-room:team:${general}`, { latest: 7, seen: 7 });
  await client.invalidateQueries({ queryKey: readMarkerQueries.all() });
  const read = await screen.findByRole('button', { name: 'general' });
  expect(bold(read)).toBe(false);
});

test('Up and Down move between rows with one tab stop; Enter opens the row', async () => {
  const user = userEvent.setup();
  const onOpenChannel = vi.fn();
  const onOpenTask = vi.fn();
  renderList({ onOpenChannel, onOpenTask });
  const first = await screen.findByRole('button', {
    name: 'general, 3 unread',
  });
  await screen.findByRole('button', { name: /Fix the login redirect/ });
  const rows = screen
    .getAllByRole('button')
    .filter((button) => button.dataset.conversationRow);
  expect(rows.filter((row) => row.tabIndex === 0)).toEqual([first]);

  first.focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'design' }),
  );
  await user.keyboard('{Enter}');
  expect(onOpenChannel).toHaveBeenLastCalledWith(design);

  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: /Fix the login redirect/ }),
  );
  await user.keyboard('{Enter}');
  expect(onOpenTask).toHaveBeenLastCalledWith('task-login');

  await user.keyboard('{Home}');
  expect(document.activeElement).toBe(first);
  await user.keyboard('{Enter}');
  // The default channel is addressed without an id, as its room is.
  expect(onOpenChannel).toHaveBeenLastCalledWith(undefined);
});

test('caps Task rooms and offers More Tasks', async () => {
  tasks = Array.from({ length: 7 }, (_, index) =>
    task(`task-${index}`, `Task ${index}`, 10 + index),
  );
  for (const item of tasks)
    markers.set(`task-room:${item.id}`, { latest: 1, seen: 1 });
  const onMoreTasks = vi.fn();
  renderList({ onMoreTasks });
  await screen.findByRole('button', { name: 'Task 6, Task room' });
  expect(
    screen.getAllByRole('button', { name: /^Task \d, Task room$/ }),
  ).toHaveLength(5);
  // Newest first: the two oldest are behind More.
  expect(
    screen.queryByRole('button', { name: 'Task 1, Task room' }),
  ).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'More Tasks' }));
  expect(onMoreTasks).toHaveBeenCalledOnce();
});

test('a failed summary keeps channels listed and offers a retry for Task rooms', async () => {
  const fetchMock = vi.mocked(fetch);
  const real = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) =>
    new URL(String(input)).pathname === '/api/read-markers/summary'
      ? new Response('Bad Gateway', { status: 502 })
      : real(input, init),
  );
  renderList();
  // Unknown read state is not unread.
  const row = await screen.findByRole('button', { name: 'general' });
  expect(bold(row)).toBe(false);
  await waitFor(() =>
    expect(screen.getByText('Task rooms could not be loaded.')).toBeTruthy(),
  );
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

test('a failed summary with no Tasks still says unread is unknown and retries it', async () => {
  // No Tasks: the Task section has nothing to ask, so only the channel
  // section can report the failure (#4855 review 4).
  tasks = [];
  const fetchMock = vi.mocked(fetch);
  const real = fetchMock.getMockImplementation()!;
  let failSummary = true;
  fetchMock.mockImplementation(async (input, init) =>
    failSummary &&
    new URL(String(input)).pathname === '/api/read-markers/summary'
      ? new Response('Bad Gateway', { status: 502 })
      : real(input, init),
  );
  renderList();
  // The channels stay listed, at normal weight: unknown is not unread.
  const row = await screen.findByRole('button', { name: 'general' });
  expect(bold(row)).toBe(false);
  await screen.findByText('Unread state could not be loaded.');
  failSummary = false;
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Retry unread state' }));
  const unread = await screen.findByRole('button', {
    name: 'general, 3 unread',
  });
  expect(bold(unread)).toBe(true);
  expect(screen.queryByText('Unread state could not be loaded.')).toBeNull();
});

test('a Project this Station does not have lists nothing and offers no retry', async () => {
  const fetchMock = vi.mocked(fetch);
  const real = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) =>
    new URL(String(input)).pathname === '/api/projects/team/channels'
      ? Response.json(
          { error: { code: 'project_room_project_not_found' } },
          { status: 404 },
        )
      : real(input, init),
  );
  renderList();
  await screen.findByText("This Project isn't on this Station.");
  // Not an older host (whose fallback is #general), and not an outage.
  expect(screen.queryByRole('button', { name: 'general' })).toBeNull();
  expect(screen.queryByText('Channels could not be loaded.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});
