// @vitest-environment jsdom

/**
 * #2050: the Agents pane over the background-tasks store.
 *
 * Two things it must get right, and both are about NOT inventing: a field
 * the store does not carry renders absent rather than 0 (the #463 class),
 * and the list it shows is the ACTIVE CHAT's rather than anything the
 * instance carries — the pane binds nothing, so a wrong reading would be a
 * pane showing another conversation's work under this one's tab.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BackgroundTaskEntry } from '../../contexts/background-tasks-store';

const useChatBackgroundTasks = vi.fn();
const useOrchestrationSessionQuery = vi.fn();
const useInterruptDelegatedTaskMutation = vi.fn();
const useStopProviderTaskMutation = vi.fn();
const showSurface = vi.fn();
let activeChat: string | null = 'chat-1';

// `useChatStoreKey` stays REAL: it is the durable-id → store-key resolution
// the pane's list depends on, and stubbing it here would hide the same seam
// this file's `useChatBackgroundTasks` stub already hides. With no chat in
// the store it returns its argument unchanged, so these cases still assert
// the id the pane forwards. The divergent case lives in
// `AgentsWorkspacePane.activeChat.test.tsx`, over the real store.
vi.mock('../../hooks/useBackgroundTasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useBackgroundTasks')>()),
  useChatBackgroundTasks: (...args: unknown[]) =>
    useChatBackgroundTasks(...args),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: (
    selector: (state: { activeChat: string | null }) => unknown,
  ) => selector({ activeChat }),
}));
vi.mock('../../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionQuery: (...args: unknown[]) =>
    useOrchestrationSessionQuery(...args),
  useInterruptDelegatedTaskMutation: (...args: unknown[]) =>
    useInterruptDelegatedTaskMutation(...args),
  useStopProviderTaskMutation: (...args: unknown[]) =>
    useStopProviderTaskMutation(...args),
}));

import { AgentsWorkspacePane } from '../AgentsWorkspacePane';

function entry(overrides: Partial<BackgroundTaskEntry> = {}) {
  return {
    id: 'call-1',
    kind: 'agent' as const,
    source: 'delegate-session' as const,
    chatThreadId: 'chat-1',
    title: 'Investigate flaky test',
    startedAt: Date.now() - 65_000,
    state: 'running' as const,
    ...overrides,
  };
}

function mount(view: {
  running: BackgroundTaskEntry[];
  finished: BackgroundTaskEntry[];
}) {
  useChatBackgroundTasks.mockReturnValue(view);
  return render(<AgentsWorkspacePane />);
}

beforeEach(() => {
  activeChat = 'chat-1';
  useOrchestrationSessionQuery.mockReturnValue({ data: undefined });
  useInterruptDelegatedTaskMutation.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
  });
  useStopProviderTaskMutation.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('the pane lists the ACTIVE chat’s running and finished work', () => {
  mount({
    running: [entry()],
    finished: [
      entry({ id: 'call-2', title: 'Rebuild index', state: 'completed' }),
    ],
  });
  // Reverting `useNavigation(s => s.activeChat)` to a constant, or dropping
  // the argument, stops this from being the chat the reader is looking at.
  expect(useChatBackgroundTasks).toHaveBeenCalledWith('chat-1');
  expect(screen.getByText('Running (1)')).toBeTruthy();
  expect(screen.getByText('Finished (1)')).toBeTruthy();
  expect(screen.getByText('Investigate flaky test')).toBeTruthy();
  expect(screen.getByText('Rebuild index')).toBeTruthy();
  // Elapsed comes from `startedAt`, which IS carried.
  expect(screen.getByText(/Agent · 1:0\d/)).toBeTruthy();
});

test('no chat is no list, and an empty list says so rather than showing zeroes', () => {
  activeChat = null;
  mount({ running: [], finished: [] });
  expect(screen.getByText('Nothing here yet')).toBeTruthy();
  // Only the no-chat empty carries the remedy; the empty list has none to
  // offer, so it says nothing rather than inventing an instruction.
  expect(
    screen.getByText('Open a chat to see the work it set running.'),
  ).toBeTruthy();
  expect(useChatBackgroundTasks).toHaveBeenCalledWith(null);
  cleanup();
  activeChat = 'chat-1';
  mount({ running: [], finished: [] });
  expect(screen.getByText('Nothing here yet')).toBeTruthy();
  expect(
    screen.queryByText('Open a chat to see the work it set running.'),
  ).toBeNull();
  expect(screen.queryByText(/Running \(/)).toBeNull();
});

test('a task the provider reported no tokens for shows no token clause', () => {
  // The engine reported usage but no token total (ACP reports context
  // occupancy only). Rendering `usageTokens ?? 0` here would print a
  // "0 tokens" nobody measured; the clause is dropped instead and the tool
  // count — which Station itself counts — still prints.
  useOrchestrationSessionQuery.mockReturnValue({
    data: { events: [] },
  });
  const { container } = mount({
    running: [entry({ delegateThreadId: 'delegate-1' })],
    finished: [],
  });
  // The two zeroes are not the same zero. Tool uses are counted by Station
  // from `tool.completed`, so zero there is a measurement and prints;
  // `totalTokens` is absent from the fold entirely, so no token figure
  // exists to print. `usageTokens ?? 0` would print one anyway, and this is
  // the assertion that reds for it.
  expect(
    container.querySelector('.background-tasks-sheet__usage')?.textContent,
  ).toBe('0 tool uses');
});

test('a running delegate can be stopped; a provider task with no session thread cannot', () => {
  mount({
    running: [
      entry({
        delegateThreadId: 'delegate-1',
        stop: { kind: 'delegate-interrupt' },
      }),
      entry({
        id: 'call-3',
        title: 'Provider subagent',
        source: 'provider-task',
        stop: { kind: 'provider-task-stop' },
      }),
    ],
    finished: [],
  });
  // One Stop: the delegate's. The provider subagent carries no
  // `sessionThreadId`, so there is nothing to send a stop to, and a button
  // that could not act must not be offered.
  expect(screen.getAllByText('Stop')).toHaveLength(1);
});

test('opening a delegate’s transcript reveals it on Activity', () => {
  mount({ running: [entry({ delegateThreadId: 'delegate-1' })], finished: [] });
  screen.getByText('View transcript').click();
  expect(showSurface).toHaveBeenCalledWith('activity', {
    session: 'delegate-1',
  });
});
