// @vitest-environment jsdom

/**
 * #2459: a per-task Stop exists only where the CHILD carried a stop seam.
 *
 * Since #2458 Codex subagents reach the chat's `backgroundTasks` through the
 * same child-work path as Claude's, and the store used to derive a Stop from
 * the reporting session alone — so the sheet offered a Codex child a Stop
 * wired to nothing. Here the events go through the REAL handlers (the legacy
 * Claude tuple translator and `child-work.updated`) into the REAL stores, and
 * the sheet and the Agents pane render from them; only the SDK hooks,
 * navigation and the stream registration are stubbed.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let activeChat: string | null = null;
const sessionQuery = vi.fn();
const mutation = () => ({
  mutate: vi.fn(),
  isPending: false,
  isSuccess: false,
  isError: false,
});

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
  useOrchestrationSessionsQuery: () => ({ data: [] }),
  useOrchestrationSessionQuery: (...args: unknown[]) => sessionQuery(...args),
  useInterruptDelegatedTaskMutation: () => mutation(),
  useStopProviderTaskMutation: () => mutation(),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: (
    selector: (state: { activeChat: string | null }) => unknown,
  ) => selector({ activeChat }),
}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => vi.fn(),
}));
vi.mock('../hooks/orchestration/ensureOrchestrationEventStream', () => ({
  ensureOrchestrationEventStream: () => () => {},
}));
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryClient: () => ({}),
}));

import { BackgroundTasksSheet } from '../components/chat-dock/BackgroundTasksSheet';
import { activeChatsStore } from '../contexts/active-chats-store';
import { childWorkGlobalStore } from '../contexts/child-work-global-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import { AgentsWorkspacePane } from '../workspace-panes/AgentsWorkspacePane';

const CHAT = 'exec-2459-stop';

beforeEach(() => {
  sessionQuery.mockReturnValue({ data: undefined });
  localStorage.clear();
  childWorkGlobalStore.reset();
  activeChatsStore.removeChat(CHAT);
  activeChatsStore.initChat(CHAT, {
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'Stop seams',
  });
  activeChat = CHAT;
});

afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(CHAT);
});

function renderSheet() {
  return render(
    <BackgroundTasksSheet
      chatThreadId={CHAT}
      anchorRef={createRef<HTMLElement>()}
      onOpenTranscript={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

test('a Claude child — whose legacy translator carries the seam — keeps its Stop in the sheet', () => {
  activeChatsStore.updateChat(CHAT, { orchestrationProvider: 'claude' });
  handleOrchestrationEvent('http://station.test', {
    eventId: 'evt-claude-1',
    provider: 'claude',
    threadId: CHAT,
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'extension.notification',
    namespace: 'claude-code',
    type: 'task/registry',
    payload: {
      active: [
        { taskId: 'task-1', description: 'Investigate', backgrounded: true },
      ],
    },
  });
  expect(activeChatsStore.getSnapshot()[CHAT]?.backgroundTasks).toMatchObject([
    { taskId: 'task-1', stop: 'provider-task-stop' },
  ]);
  renderSheet();
  expect(screen.getByText('Investigate')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
});

test('a Codex child — which carries no seam — has no Stop in the sheet or the pane', () => {
  sessionQuery.mockReturnValue({
    data: {
      session: { threadId: CHAT, provider: 'codex' },
      events: [
        {
          eventId: 'parent-start',
          provider: 'codex',
          threadId: CHAT,
          createdAt: '2026-09-24T00:00:00.000Z',
          method: 'turn.started',
          turnId: 'parent-turn',
          prompt: 'Parent request',
        },
        {
          eventId: 'parent-tool',
          provider: 'codex',
          threadId: CHAT,
          createdAt: '2026-09-24T00:00:01.000Z',
          method: 'tool.started',
          turnId: 'parent-turn',
          itemId: 'parent-tool',
          toolCallId: 'parent-tool',
          toolName: 'WrongParentTool',
          arguments: {},
        },
        {
          eventId: 'parent-usage',
          provider: 'codex',
          threadId: CHAT,
          createdAt: '2026-09-24T00:00:02.000Z',
          method: 'token-usage.updated',
          totalTokens: 999,
        },
      ],
    },
  });
  activeChatsStore.updateChat(CHAT, { orchestrationProvider: 'codex' });
  handleOrchestrationEvent('http://station.test', {
    eventId: 'evt-codex-1',
    provider: 'codex',
    threadId: CHAT,
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: CHAT,
        childId: 'codex-child-1',
        status: 'running',
        title: 'Survey the repo',
        latestTool: 'Read',
        progress: 'Reading the source',
      },
    },
  });
  // It is listed — the chat's affordance counts it — but carries no stop.
  expect(activeChatsStore.getSnapshot()[CHAT]?.backgroundTasks).toEqual([
    expect.objectContaining({ taskId: 'codex-child-1' }),
  ]);
  expect(
    activeChatsStore.getSnapshot()[CHAT]?.backgroundTasks?.[0]?.stop,
  ).toBeUndefined();

  renderSheet();
  expect(screen.getByRole('img', { name: 'Codex' })).toBeTruthy();
  expect(screen.queryByText('Parent request')).toBeNull();
  expect(screen.queryByText('WrongParentTool')).toBeNull();

  expect(
    screen.getByText('Read', { selector: '.child-work-activity__name' }),
  ).toBeTruthy();
  expect(screen.getByText('Reading the source')).toBeTruthy();
  expect(screen.getByText('Survey the repo')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Survey the repo/ }));
  expect(screen.queryByText(/999 tokens/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  cleanup();

  render(<AgentsWorkspacePane />);
  expect(screen.getAllByText('Survey the repo')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});
