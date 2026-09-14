// @vitest-environment jsdom

/**
 * #2050 review H2: the Agents pane must list the work the row that opened it
 * COUNTED — the same store, under the same key.
 *
 * Navigation carries a chat's DURABLE id (`activeChatDurableId` =
 * `conversationId ?? sessionId`); the active-chats store is keyed by the
 * SESSION key a reopen mints, which is the conversation id only when the
 * reopen carried a provider execution
 * (`useActiveChatSessionLifecycle`: `${agentSlug}:${Date.now()}` otherwise).
 * Handing `navigation.activeChat` straight to `useChatBackgroundTasks` finds
 * nothing for every other conversation, so the header row says
 * "Background tasks — 1 running" and the pane it opens says "Nothing here
 * yet".
 *
 * The sibling suite mocks `useChatBackgroundTasks`, which is why it could not
 * see this: it asserts a literal is forwarded. Here the STORE is real and the
 * hook is real — only the two inputs the pane cannot own (navigation, and the
 * SDK queries `TaskRow` issues) are stubbed — and the badge's own read is
 * rendered beside the pane from the id the dock passes it, so the assertion
 * is that the two agree rather than that either is a particular string.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const useOrchestrationSessionQuery = vi.fn();
const useInterruptDelegatedTaskMutation = vi.fn();
const useStopProviderTaskMutation = vi.fn();
let activeChat: string | null = null;

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: (
    selector: (state: { activeChat: string | null }) => unknown,
  ) => selector({ activeChat }),
}));
vi.mock('../../contexts/useShowSurface', () => ({
  useShowSurface: () => vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionQuery: (...args: unknown[]) =>
    useOrchestrationSessionQuery(...args),
  useInterruptDelegatedTaskMutation: (...args: unknown[]) =>
    useInterruptDelegatedTaskMutation(...args),
  useStopProviderTaskMutation: (...args: unknown[]) =>
    useStopProviderTaskMutation(...args),
}));

import { activeChatsStore } from '../../contexts/active-chats-store';
import { useChatBackgroundTasksRunningCount } from '../../hooks/useBackgroundTasks';
import { AgentsWorkspacePane } from '../AgentsWorkspacePane';

/**
 * The divergent case, which is the ordinary one: a conversation reopened from
 * the inbox with no provider execution. Its store key is synthetic; its
 * durable id — what navigation holds — is the conversation's.
 */
const SESSION_KEY = 'claude-agent:1700000000000';
const CONVERSATION_ID = 'conv-2050';

/** The dock's own read of the badge, from the id `ChatDock` passes it. */
function BadgeProbe({ sessionId }: { sessionId: string }) {
  const count = useChatBackgroundTasksRunningCount(sessionId);
  return <output data-testid="badge">{count}</output>;
}

beforeEach(() => {
  activeChat = CONVERSATION_ID;
  useOrchestrationSessionQuery.mockReturnValue({ data: undefined });
  for (const mutation of [
    useInterruptDelegatedTaskMutation,
    useStopProviderTaskMutation,
  ])
    mutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
    });
  activeChatsStore.removeChat(SESSION_KEY);
  activeChatsStore.initChat(SESSION_KEY, {
    agentSlug: 'claude-agent',
    agentName: 'Claude',
    title: 'Reopened from the inbox',
    conversationId: CONVERSATION_ID,
  });
  activeChatsStore.updateChat(SESSION_KEY, {
    backgroundTasks: [
      {
        taskId: 'task-1',
        description: 'Investigate flaky test',
        subagentType: 'general-purpose',
        sessionThreadId: 'exec-1',
      },
    ],
  });
});

afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(SESSION_KEY);
  vi.clearAllMocks();
});

/**
 * Reverting the pane to `useChatBackgroundTasks(activeChat ?? null)` fails at
 * "Running (1)": `activeChatsStore.getSnapshot()['conv-2050']` is undefined,
 * so the pane renders its empty state while the badge beside it reads 1.
 */
test('the pane lists the work the badge counts, for a conversation whose store key is not its durable id', () => {
  expect(activeChatsStore.getSnapshot()[CONVERSATION_ID]).toBeUndefined();
  expect(activeChatsStore.getChatKeyForExecutionSession(CONVERSATION_ID)).toBe(
    SESSION_KEY,
  );

  render(
    <>
      <BadgeProbe sessionId={SESSION_KEY} />
      <AgentsWorkspacePane />
    </>,
  );

  expect(screen.getByTestId('badge').textContent).toBe('1');
  expect(screen.getByText('Running (1)')).toBeTruthy();
  expect(screen.getByText('Investigate flaky test')).toBeTruthy();
  expect(screen.queryByText('Nothing here yet')).toBeNull();
});

/**
 * The resolution must not invent a chat: with no conversation open the pane
 * still reads the no-chat empty, and an id the store has never seen falls
 * through unchanged rather than binding to some other conversation's work.
 */
test('no chat is still no list, and an unknown id borrows nobody else’s work', () => {
  activeChat = null;
  const { unmount } = render(<AgentsWorkspacePane />);
  expect(
    screen.getByText('Open a chat to see the work it set running.'),
  ).toBeTruthy();
  unmount();

  activeChat = 'conv-nobody-has';
  render(<AgentsWorkspacePane />);
  expect(screen.getByText('Nothing here yet')).toBeTruthy();
  expect(screen.queryByText('Investigate flaky test')).toBeNull();
});
