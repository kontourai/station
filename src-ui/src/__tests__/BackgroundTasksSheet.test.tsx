// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BackgroundTaskEntry } from '../contexts/background-tasks-store';
import type { SessionIconAgent } from '../utils/sessionDisplay';

const agents: SessionIconAgent[] = [];
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => agents }));

const useChatBackgroundTasks = vi.fn();
const interruptTask = vi.fn();
const useOrchestrationSessionQuery = vi.fn();
const useOrchestrationSessionActivityQuery = vi.fn();
const useInterruptDelegatedTaskMutation = vi.fn();
// station#1877: the provider card's own task-scoped stop.
const useStopProviderTaskMutation = vi.fn();
const stopProviderTask = vi.fn();
vi.mock('../hooks/useBackgroundTasks', () => ({
  useChatBackgroundTasks: (...args: unknown[]) =>
    useChatBackgroundTasks(...args),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionActivityQuery: (...args: unknown[]) =>
    useOrchestrationSessionActivityQuery(...args),
  useOrchestrationSessionQuery: (...args: unknown[]) =>
    useOrchestrationSessionQuery(...args),
  useInterruptDelegatedTaskMutation: (...args: unknown[]) =>
    useInterruptDelegatedTaskMutation(...args),
  useStopProviderTaskMutation: (...args: unknown[]) =>
    useStopProviderTaskMutation(...args),
}));

import { BackgroundTasksSheet } from '../components/chat-dock/BackgroundTasksSheet';

const SECTION_STORAGE_KEY = 'station.background-tasks.sections';

function runningEntry(
  overrides: Partial<BackgroundTaskEntry> = {},
): BackgroundTaskEntry {
  return {
    id: 'call-1',
    kind: 'tool',
    source: 'tool-event',
    chatThreadId: 'chat-1',
    title: 'Run tests',
    startedAt: Date.now(),
    state: 'running',
    ...overrides,
  };
}

function finishedEntry(
  overrides: Partial<BackgroundTaskEntry> = {},
): BackgroundTaskEntry {
  return {
    id: 'call-2',
    kind: 'agent',
    source: 'delegate-session',
    chatThreadId: 'chat-1',
    title: 'Investigate flaky test',
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    state: 'completed',
    ...overrides,
  };
}

function renderSheet(view: {
  running: BackgroundTaskEntry[];
  finished: BackgroundTaskEntry[];
}) {
  useChatBackgroundTasks.mockReturnValue(view);
  const anchorRef = createRef<HTMLElement>();
  const onClose = vi.fn();
  const onOpenTranscript = vi.fn();
  const result = render(
    <BackgroundTasksSheet
      chatThreadId="chat-1"
      anchorRef={anchorRef}
      onOpenTranscript={onOpenTranscript}
      onClose={onClose}
    />,
  );
  return { ...result, onClose, onOpenTranscript };
}

describe('BackgroundTasksSheet', () => {
  beforeEach(() => {
    agents.length = 0;
    localStorage.clear();
    window.history.replaceState({}, '', '/background-tasks-test');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:01:05.000Z'));
    interruptTask.mockReset();
    useOrchestrationSessionActivityQuery.mockReset();
    useOrchestrationSessionActivityQuery.mockImplementation(() => {
      const detail = useOrchestrationSessionQuery();
      return {
        data: detail.data && {
          session: detail.data.session,
          events: detail.data.events.map((event: unknown, index: number) => ({
            sequence: index + 1,
            event,
          })),
        },
      };
    });
    useOrchestrationSessionQuery.mockReset();
    useOrchestrationSessionQuery.mockReturnValue({ data: undefined });
    useInterruptDelegatedTaskMutation.mockReset();
    useInterruptDelegatedTaskMutation.mockReturnValue({
      mutate: interruptTask,
      isPending: false,
      isSuccess: false,
      isError: false,
    });
    stopProviderTask.mockReset();
    useStopProviderTaskMutation.mockReset();
    useStopProviderTaskMutation.mockReturnValue({
      mutate: stopProviderTask,
      isPending: false,
      isSuccess: false,
      isError: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('renders the empty state when there are no running or finished tasks', () => {
    renderSheet({ running: [], finished: [] });
    expect(screen.getByText('Nothing here yet')).not.toBeNull();
  });

  test('renders a Running section with a count and the Activity disclosure', () => {
    renderSheet({
      running: [runningEntry(), runningEntry({ id: 'call-3' })],
      finished: [],
    });
    expect(screen.getByText('Running (2)')).not.toBeNull();
    expect(
      screen.getByText('Remote delegations appear on the Activity page.'),
    ).not.toBeNull();
    expect(
      screen.queryByText('Remote delegations appear on the Sessions page.'),
    ).toBeNull();
  });

  test('elapsed time renders as m:ss and ticks forward with the shared 1s timer', () => {
    renderSheet({
      running: [
        runningEntry({
          startedAt: Date.parse('2026-07-29T00:00:00.000Z'),
        }),
      ],
      finished: [],
    });
    expect(screen.getByText(/Tool · 1:05/)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText(/Tool · 1:07/)).not.toBeNull();
  });

  test('Finished section is collapsed by default and shows an outcome chip once expanded', () => {
    renderSheet({ running: [], finished: [finishedEntry()] });
    expect(screen.getByText('Finished (1)')).not.toBeNull();
    expect(screen.queryByText('Investigate flaky test')).toBeNull();

    fireEvent.click(screen.getByText('Finished (1)'));
    expect(screen.getByText('Investigate flaky test')).not.toBeNull();
    expect(screen.getByText('Completed')).not.toBeNull();
  });

  // station#1558: an entry whose session ended before its tool reported must
  // not borrow "Stopped" (nobody asked it to stop) or "Failed" (nothing
  // observed a failure).
  test('an unresolved entry is chipped "No result", not Stopped or Failed', () => {
    renderSheet({
      running: [],
      finished: [finishedEntry({ state: 'unresolved' })],
    });
    fireEvent.click(screen.getByText('Finished (1)'));
    expect(screen.getByText('No result')).not.toBeNull();
    expect(screen.queryByText('Stopped')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  test('Finished section collapse state persists to localStorage and is honored on remount', () => {
    renderSheet({ running: [], finished: [finishedEntry()] });
    fireEvent.click(screen.getByText('Finished (1)'));
    expect(screen.getByText('Investigate flaky test')).not.toBeNull();

    const stored = JSON.parse(
      localStorage.getItem(SECTION_STORAGE_KEY) ?? '{}',
    );
    expect(stored.finishedExpanded).toBe(true);

    renderSheet({ running: [], finished: [finishedEntry()] });
    // Two renders now exist; the newest mount should render its detail
    // already expanded because it re-read the persisted state on init.
    expect(screen.getAllByText('Investigate flaky test').length).toBe(2);
  });

  test('a running entry with no detail renders a disabled (non-expandable) row', () => {
    renderSheet({
      running: [runningEntry({ detail: undefined })],
      finished: [],
    });
    const row = screen.getByRole('button', { name: /Run tests/ });
    expect(row.hasAttribute('disabled')).toBe(true);
  });

  test('a running entry with detail expands on click to reveal it', () => {
    renderSheet({
      running: [runningEntry({ detail: 'Executing vitest run…' })],
      finished: [],
    });
    expect(screen.queryByText('Executing vitest run…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Run tests/ }));
    expect(screen.getByText('Executing vitest run…')).not.toBeNull();
  });

  test('the close button invokes onClose', () => {
    const { onClose } = renderSheet({
      running: [runningEntry()],
      finished: [],
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Close background tasks' }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('a running delegate exposes stop and transcript controls', () => {
    const { onOpenTranscript } = renderSheet({
      running: [
        runningEntry({
          id: 'task:delegate-1',
          kind: 'agent',
          source: 'delegate-session',
          delegateThreadId: 'task:delegate-1',
          stop: { kind: 'delegate-interrupt' },
        }),
      ],
      finished: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(interruptTask).toHaveBeenCalledWith({ taskId: 'task:delegate-1' });

    fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
    expect(onOpenTranscript).toHaveBeenCalledWith('task:delegate-1');
  });

  test.each(['running', 'completed'] as const)(
    '%s delegate retains its own configured artwork and recorded engine',
    (state) => {
      agents.push(
        { name: 'Owl', slug: 'owl', icon: '/owl.png' },
        { name: 'Parent', slug: 'parent', icon: '/parent.png' },
      );
      useOrchestrationSessionQuery.mockReturnValue({
        data: {
          session: {
            threadId: 'task:owl',
            provider: 'codex',
            assignedAgentSlug: 'parent',
            delegation: { targetId: 'owl' },
          },
          events: [],
        },
      });
      const entry = runningEntry({
        id: 'task:owl',
        kind: 'agent',
        source: 'delegate-session',
        delegateThreadId: 'task:owl',
        state,
      });
      renderSheet({
        running: state === 'running' ? [entry] : [],
        finished: state === 'completed' ? [entry] : [],
      });
      if (state === 'completed')
        fireEvent.click(screen.getByText('Finished (1)'));
      expect(
        screen
          .getByRole('img', { name: 'Owl · Codex' })
          .querySelector('img')
          ?.getAttribute('src'),
      ).toBe('/owl.png');
      expect(document.querySelector('img[src="/parent.png"]')).toBeNull();
      expect(
        document.querySelector('.child-work-identity__engine'),
      ).not.toBeNull();
    },
  );

  test('delegate usage is derived from the canonical persisted event stream', () => {
    useOrchestrationSessionQuery.mockReturnValue({
      data: {
        events: [
          {
            method: 'turn.started',
            provider: 'claude-code',
            threadId: 'task:delegate-2',
            createdAt: '2026-07-29T00:00:20.000Z',
            turnId: 'turn-1',
            prompt: 'Audit the release workflow',
          },
          {
            method: 'tool.started',
            provider: 'claude-code',
            threadId: 'task:delegate-2',
            createdAt: '2026-07-29T00:00:20.100Z',
            turnId: 'turn-1',
            itemId: 'own-tool',
            toolCallId: 'own-tool',
            toolName: 'Read',
            arguments: {},
          },
          {
            method: 'tool.started',
            provider: 'claude-code',
            threadId: 'another-child',
            createdAt: '2026-07-29T00:00:20.200Z',
            turnId: 'turn-1',
            itemId: 'other-tool',
            toolCallId: 'other-tool',
            toolName: 'WrongChildTool',
            arguments: {},
          },
          {
            method: 'token-usage.updated',
            provider: 'claude-code',
            threadId: 'task:delegate-2',
            createdAt: '2026-07-29T00:00:30.000Z',
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150,
          },
          {
            method: 'tool.completed',
            provider: 'claude-code',
            threadId: 'task:delegate-2',
            createdAt: '2026-07-29T00:00:40.000Z',
            toolCallId: 'tool-1',
            toolName: 'shell',
            status: 'success',
          },
        ],
      },
    });
    renderSheet({
      running: [
        runningEntry({
          id: 'task:delegate-2',
          kind: 'agent',
          source: 'delegate-session',
          delegateThreadId: 'task:delegate-2',
        }),
      ],
      finished: [],
    });

    expect(
      screen.getByText('Read', { selector: '.child-work-activity__name' }),
    ).toBeTruthy();
    expect(screen.queryByText('WrongChildTool')).toBeNull();
    expect(screen.queryByText('150 tokens · 1 tool use')).toBeNull();
    expect(
      useOrchestrationSessionQuery.mock.calls.some(
        ([threadId, config]) =>
          threadId === 'task:delegate-2' && config?.enabled,
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(
      useOrchestrationSessionQuery.mock.calls.some(
        ([threadId, config]) =>
          threadId === 'task:delegate-2' && config?.enabled,
      ),
    ).toBe(true);
    expect(screen.getByText('150 tokens · 1 tool use')).not.toBeNull();
    expect(screen.queryByText('Audit the release workflow')).toBeNull();
    expect(screen.getByText('Run tests')).not.toBeNull();
  });

  // archive#4196: "N tokens" must not present a cache-exclusive figure as
  // the task's tokens when the provider's declared inclusivity ('disjoint'
  // — claude) backs including cache.
  test('delegate usage includes cache tokens when the provider declares disjoint inclusivity', () => {
    useOrchestrationSessionQuery.mockReturnValue({
      data: {
        events: [
          {
            method: 'token-usage.updated',
            provider: 'claude',
            threadId: 'task:delegate-3',
            createdAt: '2026-08-25T00:00:30.000Z',
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150,
            cacheReadTokens: 9000,
            cacheWriteTokens: 400,
          },
          {
            method: 'tool.completed',
            provider: 'claude',
            threadId: 'task:delegate-3',
            createdAt: '2026-08-25T00:00:40.000Z',
            toolCallId: 'tool-1',
            toolName: 'shell',
            status: 'success',
          },
        ],
      },
    });
    renderSheet({
      running: [
        runningEntry({
          id: 'task:delegate-3',
          kind: 'agent',
          source: 'delegate-session',
          delegateThreadId: 'task:delegate-3',
        }),
      ],
      finished: [],
    });

    // 150 + 9,000 + 400 — the pre-fix line said "150 tokens" while the
    // session had put 9,520 prompt-side tokens in front of the model.
    expect(screen.queryByText('9,550 tokens · 1 tool use')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('9,550 tokens · 1 tool use')).not.toBeNull();
  });

  test("delegate usage keeps an 'unverified' provider's own total unsummed", () => {
    useOrchestrationSessionQuery.mockReturnValue({
      data: {
        events: [
          {
            method: 'token-usage.updated',
            provider: 'codex',
            threadId: 'task:delegate-4',
            createdAt: '2026-08-25T00:00:30.000Z',
            promptTokens: 22,
            completionTokens: 13,
            totalTokens: 35,
            cacheReadTokens: 4,
          },
          {
            method: 'tool.completed',
            provider: 'codex',
            threadId: 'task:delegate-4',
            createdAt: '2026-08-25T00:00:40.000Z',
            toolCallId: 'tool-1',
            toolName: 'shell',
            status: 'success',
          },
        ],
      },
    });
    renderSheet({
      running: [
        runningEntry({
          id: 'task:delegate-4',
          kind: 'agent',
          source: 'delegate-session',
          delegateThreadId: 'task:delegate-4',
        }),
      ],
      finished: [],
    });

    // Codex's inclusivity is 'unverified': 35 + 4 could double-count, so
    // the provider's own total stands.
    expect(screen.queryByText('35 tokens · 1 tool use')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('35 tokens · 1 tool use')).not.toBeNull();
  });
});
