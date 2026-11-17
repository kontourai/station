// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { BackgroundTaskEntry } from '../contexts/background-tasks-store';

vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
const useChatBackgroundTasks = vi.fn();
vi.mock('../hooks/useBackgroundTasks', () => ({
  useChatBackgroundTasks: (...args: unknown[]) =>
    useChatBackgroundTasks(...args),
}));
vi.mock('@kontourai/station-sdk', () => {
  const idleMutation = () => ({
    mutate: () => {},
    isPending: false,
    isSuccess: false,
    isError: false,
  });
  return {
    useOrchestrationSessionActivityQuery: () => ({ data: undefined }),
    useOrchestrationSessionQuery: () => ({ data: undefined }),
    useInterruptDelegatedTaskMutation: idleMutation,
    useStopProviderTaskMutation: idleMutation,
  };
});

import { BackgroundTasksSheet } from '../components/chat-dock/BackgroundTasksSheet';
import type { ChatDockMobileOverflowActions } from '../components/chat-dock/ChatDockMobileHeader';
import { ChatDockMobileOverflowSheet } from '../components/chat-dock/ChatDockMobileOverflowSheet';
import { DIALOG_HISTORY_KEY } from '../components/dialog-history';

const running: BackgroundTaskEntry = {
  id: 'call-1',
  kind: 'tool',
  source: 'tool-event',
  chatThreadId: 'chat-1',
  title: 'Run tests',
  startedAt: Date.now(),
  state: 'running',
};

const noop = () => {};
/** The ⋯ sheet's required actions this test never presses. */
const UNUSED_ACTIONS: ChatDockMobileOverflowActions = {
  onOpenConversation: noop,
  onToggleHistory: noop,
  onOpenChatSettings: noop,
  onOpenProject: null,
  openProjectName: null,
  onOpenProfile: noop,
  onOpenAppSettings: noop,
  onCollapseDock: noop,
  onExpandDock: noop,
  onRestoreDock: noop,
  isDockMaximized: false,
};

function Harness({ lazy }: { lazy: boolean }) {
  const [actionsOpen, setActionsOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(false);
  return (
    <>
      <p>Chat</p>
      {actionsOpen && (
        <ChatDockMobileOverflowSheet
          overflow={{
            ...UNUSED_ACTIONS,
            onOpenBackgroundTasks: () => {
              if (!lazy) return setTasksOpen(true);
              setTimeout(() => setTasksOpen(true), 0);
            },
            backgroundTasksRunningCount: 1,
          }}
          onClose={() => setActionsOpen(false)}
        />
      )}
      {tasksOpen && (
        <BackgroundTasksSheet
          chatThreadId="chat-1"
          anchorRef={createRef<HTMLElement>()}
          onOpenTranscript={vi.fn()}
          onClose={() => setTasksOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The phone's Back gesture is a history traversal, so the sheet must own a
 * history layer that Back pops — including on the path a phone actually takes,
 * from the ⋯ actions sheet, whose own layer is folded away in the same tap
 * that opens this one. Real timers: the traversal settles through popstate.
 * Removing the sheet's history layer (`historyMode="none"`) leaves the sheet
 * open after Back; a Back that also navigated the page underneath would move
 * the URL.
 */
describe('BackgroundTasksSheet and browser Back', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/background-tasks-back');
    useChatBackgroundTasks.mockReturnValue({
      running: [running],
      finished: [],
    });
  });

  // ChatDock lazy-loads the sheet, so on a phone it mounts after the actions
  // sheet's own layer has begun folding away; `lazy` reproduces that order.
  test.each([
    ['in the same tap', false],
    ['after a lazy load', true],
  ])(
    'Back closes the sheet opened from the ⋯ actions sheet %s, and only the sheet',
    async (_label, lazy) => {
      render(<Harness lazy={lazy} />);
      const startUrl = window.location.href;
      fireEvent.click(
        await screen.findByRole('menuitem', {
          name: 'Background tasks — 1 running',
        }),
      );
      const sheet = () =>
        screen.queryByRole('dialog', { name: 'Background tasks' });
      await waitFor(() => expect(sheet()).not.toBeNull());
      expect(screen.queryByRole('dialog', { name: 'Chat actions' })).toBeNull();
      // The sheet's own layer is the live entry once the handoff settles.
      await waitFor(() =>
        expect(
          (window.history.state as Record<string, unknown> | null)?.[
            DIALOG_HISTORY_KEY
          ],
        ).toEqual(expect.any(String)),
      );

      window.history.back();
      await waitFor(() => expect(sheet()).toBeNull());
      expect(window.location.href).toBe(startUrl);
      expect(screen.getByText('Chat')).not.toBeNull();
    },
  );
});
