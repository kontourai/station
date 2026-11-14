/** @vitest-environment jsdom */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({
    apiBase: 'http://localhost:3242',
  }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));

vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: (props: {
    statusLabel?: string;
    turnStartedAt?: number;
  }) => (
    <div
      data-testid="streaming-message"
      data-status-label={props.statusLabel ?? ''}
      data-turn-started-at={props.turnStartedAt ?? ''}
    >
      Streaming
    </div>
  ),
}));

vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));

vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { activeChatsStore } from '../contexts/active-chats-store';
import { backgroundTasksStore } from '../contexts/background-tasks-store';
import { childWorkGlobalStore } from '../contexts/child-work-global-store';
import type { ChatSession } from '../types';

const API_BASE = 'http://localhost:3242';
const CHAT = 'background-lines-chat';
// The engine session currently reporting this conversation's subagents.
const REPORTER = 'claude:1:session:current';
const STARTED = Date.parse('2026-11-12T22:22:17.000Z');

function session(): ChatSession {
  return {
    id: CHAT,
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Get it all merged',
    source: 'manual',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    orchestrationSessionStarted: true,
    orchestrationStatus: 'idle',
    orchestrationTurnOpen: false,
    messages: [
      { role: 'user', content: 'Get it all merged', timestamp: 1 },
      { role: 'assistant', content: 'Driving it.', timestamp: 2, turnId: 't1' },
    ] as ChatSession['messages'],
    conversationActivity: {
      conversationId: CHAT,
      asOfSequence: 9,
      runningChildWork: { count: 1, producers: ['engine-subagent'] },
    },
  };
}

function seedRunningSubagent() {
  // The spawning call, which dates the task, then the engine's child report:
  // the same two events the live stream delivers for a backgrounded Agent.
  backgroundTasksStore.ingest(
    {
      provider: 'claude',
      createdAt: new Date(STARTED).toISOString(),
      threadId: CHAT,
      method: 'tool.started',
      itemId: 'toolu_lane7',
      toolCallId: 'toolu_lane7',
      toolName: 'Agent',
    } as never,
    API_BASE,
  );
  backgroundTasksStore.bindProviderReporter(API_BASE, REPORTER, CHAT);
  childWorkGlobalStore.ingest(API_BASE, {
    provider: 'claude',
    createdAt: new Date(STARTED).toISOString(),
    threadId: REPORTER,
    method: 'child-work.updated',
    delta: {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: REPORTER,
        childId: 'lane7',
        status: 'running',
        backgrounded: true,
        title: 'Lane 7: gallery baselines #4692',
        kindLabel: 'general-purpose',
        latestTool: 'Bash',
        progress: 'Waiting on dependencies:ci',
        parent: { toolCallId: 'toolu_lane7' },
      },
    },
  } as never);
}

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatMessageList
        activeSession={session()}
        fontSize={14}
        showReasoning
        showToolDetails
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(STARTED + 27 * 60_000 + 7_000);
  backgroundTasksStore.reset();
  childWorkGlobalStore.reset();
  activeChatsStore.initChat(CHAT, {
    agentSlug: 'dev-agent',
    agentName: 'Dev Agent',
    title: 'Get it all merged',
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  backgroundTasksStore.reset();
  childWorkGlobalStore.reset();
  activeChatsStore.removeChat(CHAT);
});

describe('the chat banner names what its background work is doing', () => {
  test('each running task shows its latest activity and elapsed time, and the time advances', () => {
    seedRunningSubagent();
    renderList();
    const line = screen
      .getByText('Lane 7: gallery baselines #4692')
      .closest('li') as HTMLElement;
    expect(line).toBeTruthy();
    expect(line.textContent).toContain('Bash');
    expect(line.textContent).toContain('Waiting on dependencies:ci');
    expect(line.textContent).toContain('27:07');

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(line.textContent).toContain('27:10');
  });

  test('a new progress report replaces the activity line live', () => {
    seedRunningSubagent();
    renderList();
    act(() => {
      childWorkGlobalStore.ingest(API_BASE, {
        provider: 'claude',
        createdAt: new Date(STARTED + 60_000).toISOString(),
        threadId: REPORTER,
        method: 'child-work.updated',
        delta: {
          kind: 'upsert',
          item: {
            producer: 'engine-subagent',
            reporterThreadId: REPORTER,
            childId: 'lane7',
            status: 'running',
            backgrounded: true,
            title: 'Lane 7: gallery baselines #4692',
            latestTool: 'Bash',
            progress: 'Comparing screenshots',
            parent: { toolCallId: 'toolu_lane7' },
          },
        },
      } as never);
    });
    const line = screen
      .getByText('Lane 7: gallery baselines #4692')
      .closest('li') as HTMLElement;
    expect(line.textContent).toContain('Comparing screenshots');
    expect(line.textContent).not.toContain('Waiting on dependencies:ci');
  });
});
