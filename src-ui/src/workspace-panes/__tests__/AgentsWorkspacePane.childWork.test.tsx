// @vitest-environment jsdom

/**
 * #2459: the Agents pane over the REAL stores — the chat store, the
 * background-tasks store and the global child-work store — with only
 * navigation and the SDK (queries and mutations) stubbed.
 */

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let activeChat: string | null = null;
let sessions: Partial<OrchestrationSessionSummary>[] = [];
const showSurface = vi.fn();

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: (
    selector: (state: { activeChat: string | null }) => unknown,
  ) => selector({ activeChat }),
}));
vi.mock('../../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({ data: sessions }),
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
import { childWorkGlobalStore } from '../../contexts/child-work-global-store';
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

beforeEach(() => {
  localStorage.clear();
  childWorkGlobalStore.reset();
  activeChatsStore.removeChat(CHAT);
  activeChat = null;
  sessions = [];
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

test('a CLI-started delegate with no chat open appears live, with its provenance, and opens its session', () => {
  sessions = [
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
  ];
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

test('Claude’s per-chat Stop survives on the TaskRow bridge; ChildWorkRow offers none from a `none` cell', () => {
  openChat('claude');
  // The chat's derived provider task (the pre-contract per-chat path)...
  activeChatsStore.updateChat(CHAT, {
    backgroundTasks: [
      {
        taskId: 'task-1',
        description: 'Investigate flaky test',
        backgrounded: true,
        sessionThreadId: 'exec-1',
      },
    ],
  });
  // ...and the same child in the window-wide registry.
  childWorkGlobalStore.ingest({
    provider: 'claude',
    threadId: 'exec-1',
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'extension.notification',
    namespace: 'claude-code',
    type: 'task/registry',
    payload: {
      active: [{ taskId: 'task-1', description: 'Investigate flaky test' }],
    },
  });
  render(<AgentsWorkspacePane />);
  // Per chat: ONE row (the bridge), with the shipped Stop.
  expect(screen.getByText('Running (1)')).toBeTruthy();
  expect(screen.getAllByText('Investigate flaky test')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);

  // All: the contract row, and no Stop — Claude's cell is not wired.
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(screen.getAllByText('Investigate flaky test')).toHaveLength(1);
  expect(screen.getByText('From “Morning triage”')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

test('a settled subagent shows under Finished, which says since when', () => {
  childWorkGlobalStore.ingest({
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
    screen.getByText('subagents since this window connected'),
  ).toBeTruthy();
  expect(screen.getByText('No result')).toBeTruthy();
});
