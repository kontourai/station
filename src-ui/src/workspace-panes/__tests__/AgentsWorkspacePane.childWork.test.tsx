// @vitest-environment jsdom

/**
 * #2459: the Agents pane over the REAL stores — the chat store, the
 * background-tasks store and the global child-work store — with only
 * navigation, the SDK (queries and mutations) and the stream registration
 * stubbed. The stream's own refresh path is exercised, unstubbed, in
 * `AgentsWorkspacePane.streamRefresh.test.tsx`.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SessionIconAgent } from '../../utils/sessionDisplay';

let activeChat: string | null = null;
let agents: SessionIconAgent[] = [];
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
vi.mock('../../contexts/AgentsContext', () => ({ useAgents: () => agents }));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryClient: () => ({}),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionActivityQuery: () => ({ data: undefined }),
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

import { handleOrchestrationEvent } from '../../hooks/orchestration/eventHandlers';
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
  agents = [];
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
  expect(pressed('All chats')).toBe('true');
  expect(
    (
      screen.getByRole('button', {
        name: 'This chat',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText('No agent work yet')).toBeTruthy();
});

test('the chosen scope persists across mounts', () => {
  openChat('claude');
  const first = render(<AgentsWorkspacePane />);
  expect(pressed('This chat')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
  expect(pressed('All chats')).toBe('true');
  first.unmount();
  render(<AgentsWorkspacePane />);
  expect(pressed('All chats')).toBe('true');
});

test('an engine that may not report subagents is not an engine reporting none', () => {
  // ACP reports per connection (Kiro does, others do not): with nothing
  // from the server, the pane says so instead of "No subagents running".
  openChat('acp');
  render(<AgentsWorkspacePane />);
  expect(
    screen.getByText('Subagents are not shown for this engine'),
  ).toBeTruthy();
  expect(screen.queryByText('No subagents running')).toBeNull();
  cleanup();
  activeChatsStore.removeChat(CHAT);
  openChat('claude');
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('No subagents running')).toBeTruthy();
  expect(
    screen.queryByText('Subagents are not shown for this engine'),
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
  agents = [
    {
      name: 'Release reviewer',
      slug: 'reviewer',
      icon: '🦉',
      engineId: 'claude',
    },
  ];
  sessionsResult = {
    data: [
      {
        threadId: 'delegate-cli',
        assignedAgentSlug: agentId('reviewer'),
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
  expect(screen.getByText('Running: 1 agent')).toBeTruthy();
  expect(
    screen.getByRole('img', { name: 'Release reviewer · Codex' }),
  ).toBeTruthy();
  expect(screen.getByText('🦉')).toBeTruthy();
  expect(screen.getByText('Nightly audit')).toBeTruthy();
  expect(
    screen.getByText('Recorded origin: CLI (reported) · Via Fixture Station'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  expect(showSurface).toHaveBeenCalledWith('chat', {
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
  backgroundTasksStore.ingest(
    {
      provider: 'codex',
      threadId: 'del-1',
      createdAt: '2026-09-24T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'del-1',
      metadata: { taskId: 'del-1', parentTaskId: CHAT },
    },
    API,
  );
  backgroundTasksStore.ingest(
    {
      provider: 'codex',
      threadId: 'del-1',
      createdAt: '2026-09-24T00:00:01.000Z',
      method: 'turn.started',
      turnId: 't-1',
      prompt: 'Audit the dependencies',
    },
    API,
  );
  render(<AgentsWorkspacePane />);
  // Main's selection for the same event sequence, read the way the sheet
  // reads it.
  const main = selectChatBackgroundTasks(
    backgroundTasksStore.getSnapshot(API),
    CHAT,
    undefined,
  );
  expect(main.running.map((entry) => entry.title)).toEqual([
    'Audit the dependencies',
  ]);
  expect(
    screen.getByRole('heading', { name: 'Running · 1 agent' }),
  ).toBeTruthy();
  expect(screen.getByText('Audit the dependencies')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open chat' })).toBeTruthy();
  expect(screen.queryByText('Last week’s audit')).toBeNull();

  cleanup();
  backgroundTasksStore.ingest(
    {
      provider: 'codex',
      threadId: 'del-1',
      createdAt: '2026-09-24T00:00:05.000Z',
      method: 'turn.completed',
      turnId: 't-1',
    },
    API,
  );
  render(<AgentsWorkspacePane />);
  expect(
    selectChatBackgroundTasks(
      backgroundTasksStore.getSnapshot(API),
      CHAT,
      undefined,
    ).finished.map((entry) => [entry.title, entry.state]),
  ).toEqual([['Audit the dependencies', 'completed']]);
  expect(
    screen.getByRole('heading', { name: 'Finished · 1 agent' }),
  ).toBeTruthy();
  expect(screen.getByText('Run finished')).toBeTruthy();
  // Delegate rows do not need the bounded subagent-history qualifier.
  expect(screen.queryByText('subagents: recent history')).toBeNull();
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
  expect(
    screen.getByRole('heading', { name: 'Running · 1 agent' }),
  ).toBeTruthy();
  expect(screen.getAllByText('Investigate flaky test')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
  expect(container.querySelectorAll('.child-work-row')).toHaveLength(1);
  // The TaskRow bridge retired itself: no provider card row at all.
  expect(
    container.querySelectorAll('.background-tasks-sheet__row'),
  ).toHaveLength(0);

  // All: the same single row and Stop.
  fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
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
  expect(
    screen.getByRole('heading', { name: 'Running · 1 agent' }),
  ).toBeTruthy();
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
  expect(screen.queryByRole('heading', { name: /^Running/ })).toBeNull();
  expect(
    screen.getByRole('heading', { name: 'Finished · 1 agent' }),
  ).toBeTruthy();
  expect(screen.getAllByText('Investigate flaky test')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

test('a reconnect snapshot shows retained finished subagents without a window-local time claim', () => {
  childWorkGlobalStore.reconcileSnapshot(API, [
    {
      threadId: 'exec-x',
      childWork: {
        children: {
          observability: 'reported',
          observedAt: '2026-10-23T00:00:00.000Z',
          running: [],
          settled: [
            {
              producer: 'engine-subagent',
              reporterThreadId: 'exec-x',
              childId: 'c-1',
              status: 'unresolved',
              title: 'Lost child',
              endedAt: '2026-09-24T00:00:00.000Z',
            },
          ],
        },
      },
    },
  ]);
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Finished: 1 agent')).toBeTruthy();
  expect(screen.getByText('Lost child')).toBeTruthy();
  expect(screen.queryByText('subagents: recent history')).toBeNull();
  expect(
    screen.queryByText('subagents: since this window connected'),
  ).toBeNull();
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
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
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

test('the pane resolves a delegate child from its Station-scoped ingress binding', () => {
  openChat('codex');
  handleOrchestrationEvent(API, {
    provider: 'codex',
    threadId: 'delegate-parent',
    sessionId: 'delegate-parent',
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'session.started',
    metadata: { taskId: 'delegate-parent', parentTaskId: CHAT },
  });
  handleOrchestrationEvent(API, {
    provider: 'codex',
    threadId: 'delegate-parent',
    createdAt: '2026-09-24T00:00:01.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'delegate-parent',
        childId: 'nested-child',
        status: 'running',
        title: 'Station-scoped nested work',
      },
    },
  });
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Station-scoped nested work')).toBeTruthy();
});

vi.mock('../../hooks/useActiveStationName', () => ({
  useActiveStationName: () => 'Fixture Station',
}));

/**
 * The owner's case (2026-11-16): "This chat" listed long-running tool calls
 * that "All" did not, so All showed FEWER rows than one chat. Two chats, each
 * with tool calls, an engine subagent and a delegate, as the stream folds
 * them.
 */
const OTHER_CHAT = 'chat-release';

function seedTwoChats() {
  openChat('claude');
  activeChatsStore.initChat(OTHER_CHAT, {
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'Release prep',
  });
  activeChatsStore.updateChat(OTHER_CHAT, {
    orchestrationProvider: 'claude',
    currentSessionId: 'exec-2',
    projectName: 'station',
  });
  const tool = (
    threadId: string,
    toolCallId: string,
    description: string,
    createdAt = '2026-09-24T00:00:00.000Z',
  ) =>
    backgroundTasksStore.ingest(
      {
        provider: 'claude',
        threadId,
        createdAt,
        method: 'tool.started',
        turnId: 't-1',
        itemId: toolCallId,
        toolCallId,
        toolName: 'Bash',
        arguments: { description, command: 'npm run gate:for -- src' },
      },
      API,
    );
  tool(CHAT, 'call-gate', 'Run gate:for on paths to edit');
  tool(CHAT, 'call-find', 'Find callers of key');
  backgroundTasksStore.ingest(
    {
      provider: 'claude',
      threadId: CHAT,
      createdAt: '2026-09-24T00:00:02.000Z',
      method: 'tool.completed',
      turnId: 't-1',
      itemId: 'call-find',
      toolCallId: 'call-find',
      toolName: 'Bash',
      status: 'success',
    },
    API,
  );
  tool(OTHER_CHAT, 'call-telemetry', 'Run telemetry tests after change');
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
          childId: 'sub-1',
          status: 'running',
          title: 'Inventory event-row readers for retention and replay',
          kindLabel: 'general-purpose',
          model: { id: 'claude-opus-5-5', source: 'subagent-reply' },
          latestTool: 'Read',
        },
      ],
    },
  });
  backgroundTasksStore.ingest(
    {
      provider: 'codex',
      threadId: 'del-release',
      createdAt: '2026-09-24T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'del-release',
      metadata: { taskId: 'del-release', parentTaskId: OTHER_CHAT },
    },
    API,
  );
  backgroundTasksStore.ingest(
    {
      provider: 'codex',
      threadId: 'del-release',
      createdAt: '2026-09-24T00:00:01.000Z',
      method: 'turn.started',
      turnId: 't-1',
      prompt: 'Draft the release notes',
    },
    API,
  );
}

const rowTitles = (root: ParentNode) =>
  [
    ...root.querySelectorAll(
      '.background-tasks-sheet__title, .child-work-row__title',
    ),
  ].map((node) => node.textContent);

test('All chats lists every row each chat lists, grouped by chat with the current chat first', () => {
  seedTwoChats();
  try {
    const { container } = render(<AgentsWorkspacePane />);
    const thisChat = rowTitles(container);
    expect(thisChat).toEqual(
      expect.arrayContaining([
        'Run gate:for on paths to edit',
        'Find callers of key',
        'Inventory event-row readers for retention and replay',
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
    const all = rowTitles(container);
    for (const title of thisChat) expect(all).toContain(title);
    expect(all).toContain('Run telemetry tests after change');
    expect(all).toContain('Draft the release notes');
    // Never fewer: each row once, every chat's rows.
    expect(all).toHaveLength(new Set(all).size);
    expect(all.length).toBeGreaterThan(thisChat.length);

    // Groups by chat: this chat first, then the other with its project.
    const titles = [
      ...container.querySelectorAll('.agents-pane__group-heading'),
    ].map((node) => node.textContent);
    expect(titles).toEqual(['Morning triage', 'Release prep']);
    const groups = container.querySelectorAll('.agents-pane__group');
    expect(
      groups[0]?.querySelector('.agents-pane__group-meta')?.textContent,
    ).toBe('This chat · 2 running · 1 finished');
    expect(
      groups[1]?.querySelector('.agents-pane__group-meta')?.textContent,
    ).toBe('station · 2 running');
    expect(rowTitles(groups[1] as Element)).toEqual([
      'Run telemetry tests after change',
      'Draft the release notes',
    ]);

    // A group's title opens its chat (the caret beside it only folds).
    fireEvent.click(screen.getByRole('button', { name: 'Open Release prep' }));
    expect(showSurface).toHaveBeenCalledWith('chat', { session: OTHER_CHAT });
  } finally {
    activeChatsStore.removeChat(OTHER_CHAT);
  }
});

test('a collapsed chat group stays collapsed for this viewer', () => {
  seedTwoChats();
  try {
    localStorage.setItem('station.agents-pane.scope', 'all');
    const first = render(<AgentsWorkspacePane />);
    const toggle = screen.getByRole('button', {
      name: 'Collapse Release prep',
      expanded: true,
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Run telemetry tests after change')).toBeNull();
    expect(screen.getByText('Run gate:for on paths to edit')).toBeTruthy();
    first.unmount();
    render(<AgentsWorkspacePane />);
    expect(
      screen
        .getByRole('button', { name: 'Expand Release prep', expanded: false })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.queryByText('Run telemetry tests after change')).toBeNull();
  } finally {
    activeChatsStore.removeChat(OTHER_CHAT);
  }
});

test('section counts name what they count, and every status pill shares one shape and tone', () => {
  seedTwoChats();
  try {
    const { container } = render(<AgentsWorkspacePane />);
    expect(
      screen.getByRole('heading', { name: 'Running · 1 agent · 1 tool' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Finished · 1 tool' }),
    ).toBeTruthy();
    const pill = (text: string) =>
      [...container.querySelectorAll('.work-status-pill')].filter(
        (node) => node.textContent === text,
      );
    // Running: the tool card and the subagent row carry the same pill.
    const running = pill('Running');
    expect(running).toHaveLength(2);
    expect(
      running.every((node) => node.classList.contains('tone-active')),
    ).toBe(true);
    // A finished tool reads in sentence case, in the success tone.
    const [completed] = pill('Completed');
    expect(completed?.classList.contains('tone-positive')).toBe(true);
  } finally {
    activeChatsStore.removeChat(OTHER_CHAT);
  }
});

const allRowTitles = (container: HTMLElement) => {
  fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
  return rowTitles(container);
};

test('All chats lists a tool call that spawned a subagent once, as the subagent', () => {
  openChat('claude');
  backgroundTasksStore.ingest(
    {
      provider: 'claude',
      threadId: CHAT,
      createdAt: '2026-09-24T00:00:00.000Z',
      method: 'tool.started',
      turnId: 't-1',
      itemId: 'call-spawn',
      toolCallId: 'call-spawn',
      toolName: 'Task',
      arguments: { description: 'Spawn the survey' },
    },
    API,
  );
  childWorkGlobalStore.ingest(API, {
    provider: 'claude',
    threadId: 'exec-1',
    createdAt: '2026-09-24T00:00:01.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'exec-1',
        childId: 'sub-spawned',
        status: 'running',
        title: 'Survey the repository',
        parent: { toolCallId: 'call-spawn' },
      },
    },
  });
  const { container } = render(<AgentsWorkspacePane />);
  const titles = allRowTitles(container);
  expect(titles).toContain('Survey the repository');
  expect(titles).not.toContain('Spawn the survey');
  expect(titles).toHaveLength(1);
});

test('All chats lists a delegate the read model and the store both hold once', () => {
  openChat('claude');
  sessionsResult = {
    data: [
      {
        threadId: 'del-both',
        childWork: {
          asChild: {
            producer: 'station-delegate',
            reporterThreadId: 'del-both',
            childId: 'del-both',
            status: 'running',
            parent: { taskId: CHAT },
            title: 'Audit the dependencies',
          },
        },
      },
    ],
  };
  backgroundTasksStore.ingest(
    {
      provider: 'codex',
      threadId: 'del-both',
      createdAt: '2026-09-24T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'del-both',
      metadata: { taskId: 'del-both', parentTaskId: CHAT },
    },
    API,
  );
  backgroundTasksStore.ingest(
    {
      provider: 'codex',
      threadId: 'del-both',
      createdAt: '2026-09-24T00:00:01.000Z',
      method: 'turn.started',
      turnId: 't-1',
      prompt: 'Audit the dependencies',
    },
    API,
  );
  const { container } = render(<AgentsWorkspacePane />);
  // Per chat: the store's card.
  expect(rowTitles(container)).toEqual(['Audit the dependencies']);
  expect(allRowTitles(container)).toEqual(['Audit the dependencies']);
});

test('a group opens its chat by the chat’s id, even when its first row is a subagent', () => {
  openChat('claude');
  activeChatsStore.updateChat(CHAT, { conversationId: 'conv-2459' });
  // Only a subagent reported by the chat's execution session.
  childWorkGlobalStore.ingest(API, {
    provider: 'claude',
    threadId: 'exec-1',
    createdAt: '2026-09-24T00:00:01.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'exec-1',
        childId: 'sub-only',
        status: 'running',
        title: 'Survey the repository',
      },
    },
  });
  localStorage.setItem('station.agents-pane.scope', 'all');
  render(<AgentsWorkspacePane />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Morning triage' }));
  expect(showSurface).toHaveBeenCalledWith('chat', { session: 'conv-2459' });
});

test('a closed chat stays one group: its tool cards and its subagents share a key', () => {
  openChat('claude');
  // The session row names a project only by slug: the group shows none
  // rather than a slug beside other groups' names.
  sessionsResult = {
    data: [
      { threadId: 'exec-1', conversationId: 'conv-x', projectSlug: 'dev' },
    ],
  };
  backgroundTasksStore.ingest(
    {
      provider: 'claude',
      threadId: CHAT,
      createdAt: '2026-09-24T00:00:00.000Z',
      method: 'tool.started',
      turnId: 't-1',
      itemId: 'call-long',
      toolCallId: 'call-long',
      toolName: 'Bash',
      arguments: { description: 'Run the long build' },
    },
    API,
  );
  childWorkGlobalStore.ingest(API, {
    provider: 'claude',
    threadId: 'exec-1',
    createdAt: '2026-09-24T00:00:01.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'exec-1',
        childId: 'sub-1',
        status: 'running',
        title: 'Survey the repository',
      },
    },
  });
  backgroundTasksStore.bindProviderReporter(API, 'exec-1', CHAT);
  activeChatsStore.removeChat(CHAT);
  activeChat = null;
  const { container } = render(<AgentsWorkspacePane />);
  const groups = container.querySelectorAll('.agents-pane__group');
  expect(groups).toHaveLength(1);
  expect(rowTitles(groups[0] as Element)).toEqual([
    'Run the long build',
    'Survey the repository',
  ]);
  expect(
    groups[0]?.querySelector('.agents-pane__group-meta')?.textContent,
  ).toBe('2 running');
});

test('group controls have distinct names and the chat title is a heading', () => {
  seedTwoChats();
  try {
    localStorage.setItem('station.agents-pane.scope', 'all');
    render(<AgentsWorkspacePane />);
    expect(
      screen.getByRole('heading', { level: 3, name: /Release prep/ }),
    ).toBeTruthy();
    const toggle = screen.getByRole('button', {
      name: 'Collapse Release prep',
    });
    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Expand Release prep' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Open Release prep' }),
    ).toBeTruthy();
  } finally {
    activeChatsStore.removeChat(OTHER_CHAT);
  }
});

test('All chats notes the tool-call window only when tool calls are listed', () => {
  sessionsResult = {
    data: [
      {
        threadId: 'delegate-cli',
        childWork: {
          asChild: {
            producer: 'station-delegate',
            reporterThreadId: 'delegate-cli',
            childId: 'delegate-cli',
            status: 'running',
            title: 'Nightly audit',
          },
        },
      },
    ],
  };
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Nightly audit')).toBeTruthy();
  expect(
    screen.queryByText('Tool calls are listed from when this window opened.'),
  ).toBeNull();
});

test('a chat known only from its session row shows its title but not its project slug', () => {
  sessionsResult = {
    data: [
      { threadId: 'exec-9', displayTitle: 'Old chat', projectSlug: 'dev' },
    ],
  };
  childWorkGlobalStore.ingest(API, {
    provider: 'claude',
    threadId: 'exec-9',
    createdAt: '2026-09-24T00:00:01.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'exec-9',
        childId: 'sub-9',
        status: 'running',
        title: 'Survey the repository',
      },
    },
  });
  const { container } = render(<AgentsWorkspacePane />);
  const group = container.querySelector('.agents-pane__group');
  expect(group?.querySelector('.agents-pane__group-heading')?.textContent).toBe(
    'Old chat',
  );
  expect(group?.querySelector('.agents-pane__group-meta')?.textContent).toBe(
    '1 running',
  );
});
