// @vitest-environment jsdom

/**
 * #2459: the Agents pane over the REAL stores — the chat store, the
 * background-tasks store and the global child-work store — with only
 * navigation, the SDK (queries and mutations) and the stream registration
 * stubbed. The stream's own refresh path is exercised, unstubbed, in
 * `AgentsWorkspacePane.streamRefresh.test.tsx`.
 */

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let activeChat: string | null = null;
let sessionsResult: {
  data?: Partial<OrchestrationSessionSummary>[];
  isError?: boolean;
  refetch?: () => void;
} = { data: [] };
const showSurface = vi.fn();

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: (
    selector: (state: { activeChat: string | null }) => unknown,
  ) => selector({ activeChat }),
}));
vi.mock('../../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
}));
vi.mock('../../hooks/orchestration/ensureOrchestrationEventStream', () => ({
  ensureOrchestrationEventStream: () => () => {},
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryClient: () => ({}),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => sessionsResult,
  useOrchestrationSessionQuery: () => ({ data: undefined }),
  useInterruptDelegatedTaskMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
  useStopProviderTaskMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
}));

import { activeChatsStore } from '../../contexts/active-chats-store';
import {
  backgroundTasksStore,
  selectChatBackgroundTasks,
} from '../../contexts/background-tasks-store';
import { childWorkGlobalStore } from '../../contexts/child-work-global-store';

/** The Station these events arrive from (the store is partitioned by it). */
const API = 'http://station.test';

import { AgentsWorkspacePane } from '../AgentsWorkspacePane';

const CHAT = 'chat-2459';

function openChat(provider: string) {
  activeChatsStore.initChat(CHAT, {
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'Morning triage',
  });
  activeChatsStore.updateChat(CHAT, {
    orchestrationProvider: provider,
    currentSessionId: 'exec-1',
  });
  activeChat = CHAT;
}

function claudeRegistry(active: unknown[]) {
  childWorkGlobalStore.ingest(API, {
    provider: 'claude',
    threadId: 'exec-1',
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'extension.notification',
    namespace: 'claude-code',
    type: 'task/registry',
    payload: { active },
  });
}

beforeEach(() => {
  localStorage.clear();
  childWorkGlobalStore.reset();
  backgroundTasksStore.reset();
  activeChatsStore.removeChat(CHAT);
  activeChat = null;
  sessionsResult = { data: [] };
});

afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(CHAT);
  vi.clearAllMocks();
});

const pressed = (name: string) =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed');

test('with no chat open the pane shows All, and "This conversation" is unavailable', () => {
  render(<AgentsWorkspacePane />);
  expect(pressed('All')).toBe('true');
  expect(
    (
      screen.getByRole('button', {
        name: 'This conversation',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText('No agent work yet')).toBeTruthy();
});

test('the chosen scope persists across mounts', () => {
  openChat('claude');
  const first = render(<AgentsWorkspacePane />);
  expect(pressed('This conversation')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(pressed('All')).toBe('true');
  first.unmount();
  render(<AgentsWorkspacePane />);
  expect(pressed('All')).toBe('true');
});

test('an engine that cannot report subagents is not an engine reporting none', () => {
  openChat('acp');
  render(<AgentsWorkspacePane />);
  expect(
    screen.getByText('This engine does not report subagents'),
  ).toBeTruthy();
  cleanup();
  activeChatsStore.removeChat(CHAT);
  openChat('claude');
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('No subagents running')).toBeTruthy();
  expect(
    screen.queryByText('This engine does not report subagents'),
  ).toBeNull();
});

test('a server refusal is shown in the server’s words, and a later report retracts it', () => {
  // The #2458-era case: the server's view said the engine reports subagents
  // but Station did not map them. "Does not report" would contradict it.
  openChat('codex');
  childWorkGlobalStore.reconcileSnapshot(API, [
    {
      threadId: 'exec-1',
      childWork: {
        children: {
          observability: 'not-reported',
          reason:
            'The engine reports subagents, but Station does not map them yet.',
        },
      },
    },
  ]);
  render(<AgentsWorkspacePane />);
  expect(
    screen.getByText('Subagents are not shown for this engine'),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'The engine reports subagents, but Station does not map them yet.',
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText('This engine does not report subagents'),
  ).toBeNull();
  cleanup();

  // The server now reports (it mapped them): no refusal, no silence claim.
  childWorkGlobalStore.reconcileSnapshot(API, [
    {
      threadId: 'exec-1',
      childWork: {
        children: {
          observability: 'reported',
          running: [],
          observedAt: '2026-09-24T00:00:00.000Z',
        },
      },
    },
  ]);
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('No subagents running')).toBeTruthy();
  expect(
    screen.queryByText('Subagents are not shown for this engine'),
  ).toBeNull();
});

test('a delegate from the session read model shows in All with its provenance and opens its session', () => {
  // `surface: 'cli'` is what the CLI declares since #2459 (packages/cli);
  // here it is a read-model fixture, not a live observation.
  sessionsResult = {
    data: [
      {
        threadId: 'delegate-cli',
        provider: 'codex',
        turnOrigin: {
          latest: {
            version: 1,
            actor: { kind: 'operator' },
            reported: { version: 1, surface: 'cli', build: null },
          },
          hasOtherOrigins: false,
        },
        childWork: {
          asChild: {
            producer: 'station-delegate',
            reporterThreadId: 'delegate-cli',
            childId: 'delegate-cli',
            status: 'running',
            title: 'Nightly audit',
            result: { handle: { kind: 'session', threadId: 'delegate-cli' } },
            controls: { stop: 'delegate-interrupt' },
          },
        },
      },
    ],
  };
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Running (1)')).toBeTruthy();
  expect(screen.getByText('Nightly audit')).toBeTruthy();
  expect(screen.getByText('Started from the CLI')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
  expect(showSurface).toHaveBeenCalledWith('activity', {
    session: 'delegate-cli',
  });
});

test('per chat, delegates are the background-tasks store’s cards — live, as the badge and sheet select them — not the read model’s history', () => {
  openChat('claude');
  // An old delegate of this chat the read model still lists.
  sessionsResult = {
    data: [
      {
        threadId: 'old-delegate',
        childWork: {
          asChild: {
            producer: 'station-delegate',
            reporterThreadId: 'old-delegate',
            childId: 'old-delegate',
            status: 'completed',
            parent: { taskId: CHAT },
            title: 'Last week’s audit',
          },
        },
      },
    ],
  };
  backgroundTasksStore.ingest({
    provider: 'codex',
    threadId: 'del-1',
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'session.started',
    sessionId: 'del-1',
    metadata: { taskId: 'del-1', parentTaskId: CHAT },
  });
  backgroundTasksStore.ingest({
    provider: 'codex',
    threadId: 'del-1',
    createdAt: '2026-09-24T00:00:01.000Z',
    method: 'turn.started',
    turnId: 't-1',
    prompt: 'Audit the dependencies',
  });
  render(<AgentsWorkspacePane />);
  // Main's selection for the same event sequence, read the way the sheet
  // reads it.
  const main = selectChatBackgroundTasks(
    backgroundTasksStore.getSnapshot(),
    CHAT,
    undefined,
  );
  expect(main.running.map((entry) => entry.title)).toEqual([
    'Audit the dependencies',
  ]);
  expect(screen.getByText('Running (1)')).toBeTruthy();
  expect(screen.getByText('Audit the dependencies')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'View transcript' })).toBeTruthy();
  expect(screen.queryByText('Last week’s audit')).toBeNull();

  cleanup();
  backgroundTasksStore.ingest({
    provider: 'codex',
    threadId: 'del-1',
    createdAt: '2026-09-24T00:00:05.000Z',
    method: 'turn.completed',
    turnId: 't-1',
  });
  render(<AgentsWorkspacePane />);
  expect(
    selectChatBackgroundTasks(
      backgroundTasksStore.getSnapshot(),
      CHAT,
      undefined,
    ).finished.map((entry) => [entry.title, entry.state]),
  ).toEqual([['Audit the dependencies', 'completed']]);
  expect(screen.getByText('Finished (1)')).toBeTruthy();
  expect(screen.getByText('Completed')).toBeTruthy();
  // Delegates are not "since this window connected" subagents.
  expect(
    screen.queryByText('subagents: since this window connected'),
  ).toBeNull();
});

test('#2457: a live Claude child with its cell wired shows exactly ONE Stop — its ChildWorkRow, no bridge row, no duplicate', () => {
  openChat('claude');
  // What `childWorkHandlers` derives for the chat from the live delta below.
  activeChatsStore.updateChat(CHAT, {
    backgroundTasks: [
      {
        taskId: 'task-1',
        description: 'Investigate flaky test',
        backgrounded: true,
        sessionThreadId: 'exec-1',
        stop: 'provider-task-stop',
        progress: 'Reading the test logs — Grep',
      },
    ],
  });
  // The live shape since #2457: `child-work.updated`, not the legacy tuple.
  childWorkGlobalStore.ingest(API, {
    provider: 'claude',
    threadId: 'exec-1',
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: 'exec-1',
      running: [
        {
          producer: 'engine-subagent',
          reporterThreadId: 'exec-1',
          childId: 'task-1',
          status: 'running',
          title: 'Investigate flaky test',
          backgrounded: true,
          progress: 'Reading the test logs — Grep',
          controls: { stop: 'provider-task-stop' },
        },
      ],
    },
  });
  const { container } = render(<AgentsWorkspacePane />);
  // Per chat: ONE row, the contract's, with ONE Stop.
  expect(screen.getByText('Running (1)')).toBeTruthy();
  expect(screen.getAllByText('Investigate flaky test')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
  expect(container.querySelectorAll('.child-work-row')).toHaveLength(1);
  // The TaskRow bridge retired itself: no provider card row at all.
  expect(
    container.querySelectorAll('.background-tasks-sheet__row'),
  ).toHaveLength(0);

  // All: the same single row and Stop.
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(screen.getAllByText('Investigate flaky test')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
});

test('a Codex child with no stop seam gets no Stop per chat', () => {
  openChat('codex');
  // The chat's derived card: the store gives any card with a session thread
  // a stop kind, so the bridge must not trust the card.
  activeChatsStore.updateChat(CHAT, {
    backgroundTasks: [
      {
        taskId: 'c-1',
        description: 'Survey the repo',
        backgrounded: false,
        sessionThreadId: 'exec-1',
      },
    ],
  });
  childWorkGlobalStore.ingest(API, {
    provider: 'codex',
    threadId: 'exec-1',
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'exec-1',
        childId: 'c-1',
        status: 'running',
        title: 'Survey the repo',
      },
    },
  });
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Running (1)')).toBeTruthy();
  expect(screen.getAllByText('Survey the repo')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

test('a settle the chat registry has not caught up with shows the child once, finished — not also running', () => {
  openChat('claude');
  // The chat's post-guard fold still lists it (a buffered delivery)...
  activeChatsStore.updateChat(CHAT, {
    backgroundTasks: [
      {
        taskId: 'task-1',
        description: 'Investigate flaky test',
        backgrounded: true,
        sessionThreadId: 'exec-1',
        stop: 'provider-task-stop',
      },
    ],
  });
  // ...while the pre-guard registry has already seen it settle.
  claudeRegistry([{ taskId: 'task-1', description: 'Investigate flaky test' }]);
  childWorkGlobalStore.ingest(API, {
    provider: 'claude',
    threadId: 'exec-1',
    createdAt: '2026-09-24T00:00:03.000Z',
    method: 'extension.notification',
    namespace: 'claude-code',
    type: 'task/settled',
    payload: { taskId: 'task-1', status: 'success', summary: 'Found it' },
  });
  render(<AgentsWorkspacePane />);
  expect(screen.queryByText(/Running \(/)).toBeNull();
  expect(screen.getByText('Finished (1)')).toBeTruthy();
  expect(screen.getAllByText('Investigate flaky test')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

test('a settled subagent shows under Finished, which says since when', () => {
  childWorkGlobalStore.ingest(API, {
    provider: 'codex',
    threadId: 'exec-x',
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: 'exec-x',
      childId: 'c-1',
      status: 'unresolved',
      identity: { title: 'Lost child' },
    },
  });
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Finished (1)')).toBeTruthy();
  expect(
    screen.getByText('subagents: since this window connected'),
  ).toBeTruthy();
  expect(screen.getByText('No result')).toBeTruthy();
});

test('All does not read an unanswered session list as "no agent work"', () => {
  sessionsResult = { data: undefined };
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Loading agent work')).toBeTruthy();
  expect(screen.queryByText('No agent work yet')).toBeNull();
  cleanup();

  const refetch = vi.fn();
  sessionsResult = { data: undefined, isError: true, refetch };
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Could not load agent work')).toBeTruthy();
  expect(screen.queryByText('No agent work yet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(refetch).toHaveBeenCalled();
  cleanup();

  // With subagents on screen, the failure is a note, not a blank.
  childWorkGlobalStore.ingest(API, {
    provider: 'codex',
    threadId: 'exec-x',
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'exec-x',
        childId: 'c-1',
        status: 'running',
        title: 'Still here',
      },
    },
  });
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Still here')).toBeTruthy();
  expect(screen.getByText(/Delegated tasks could not be loaded/)).toBeTruthy();
});

test('All shows only this Station’s subagents — another Station’s stream feeds its own partition', () => {
  childWorkGlobalStore.ingest('http://other-station.test', {
    provider: 'codex',
    threadId: 'exec-elsewhere',
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'exec-elsewhere',
        childId: 'c-elsewhere',
        status: 'running',
        title: 'Another Station’s work',
      },
    },
  });
  render(<AgentsWorkspacePane />);
  expect(screen.queryByText('Another Station’s work')).toBeNull();
  expect(screen.getByText('No agent work yet')).toBeTruthy();
});

test('a failed refresh behind a cached list says the list may be stale', () => {
  const refetch = vi.fn();
  sessionsResult = {
    data: [
      {
        threadId: 'delegate-cached',
        childWork: {
          asChild: {
            producer: 'station-delegate',
            reporterThreadId: 'delegate-cached',
            childId: 'delegate-cached',
            status: 'running',
            title: 'Cached delegate',
          },
        },
      },
    ],
    isError: true,
    refetch,
  };
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Cached delegate')).toBeTruthy();
  expect(screen.getByText(/may be out of date/)).toBeTruthy();
  refetch.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(refetch).toHaveBeenCalled();
  cleanup();

  // Cached but empty: not "no agent work" either.
  sessionsResult = { data: [], isError: true, refetch };
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Could not refresh agent work')).toBeTruthy();
  expect(screen.queryByText('No agent work yet')).toBeNull();
});

test('a continuation session’s server refusal counts for its conversation’s chat', () => {
  openChat('codex');
  activeChatsStore.updateChat(CHAT, { conversationId: 'conv-2459' });
  // The continuation child: not the chat's current session, found only
  // through its durable conversation — the rule the child list uses.
  sessionsResult = {
    data: [{ threadId: 'exec-continuation', conversationId: 'conv-2459' }],
  };
  childWorkGlobalStore.reconcileSnapshot(API, [
    {
      threadId: 'exec-continuation',
      conversationId: 'conv-2459',
      childWork: {
        children: {
          observability: 'not-reported',
          reason: 'Continuation sessions do not report subagents yet.',
        },
      },
    } as never,
  ]);
  render(<AgentsWorkspacePane />);
  expect(
    screen.getByText('Continuation sessions do not report subagents yet.'),
  ).toBeTruthy();
});

test('a refusal from a conversation two open chats share is attributed to neither', () => {
  openChat('codex');
  activeChatsStore.updateChat(CHAT, { conversationId: 'conv-shared' });
  activeChatsStore.initChat('chat-other', {
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'Other',
    conversationId: 'conv-shared',
  });
  try {
    sessionsResult = {
      data: [{ threadId: 'exec-continuation', conversationId: 'conv-shared' }],
    };
    childWorkGlobalStore.reconcileSnapshot(API, [
      {
        threadId: 'exec-continuation',
        childWork: {
          children: {
            observability: 'not-reported',
            reason: 'Belongs to one of the two chats.',
          },
        },
      },
    ]);
    render(<AgentsWorkspacePane />);
    expect(screen.queryByText('Belongs to one of the two chats.')).toBeNull();
  } finally {
    activeChatsStore.removeChat('chat-other');
  }
});
