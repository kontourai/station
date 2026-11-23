// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDockInboxPanel } from '../components/chat-dock/ChatDockInboxPanel';
import { InboxDismissUndo } from '../components/chat-dock/inbox-dismissals';
import { useInboxNeedsYouCount } from '../components/chat-dock/useInboxGroups';
import { NotificationContainer } from '../components/notifications/NotificationContainer';
import { UndoableActionShortcut } from '../components/undo/UndoableActionShortcut';
import {
  offerUndoableAction,
  resetUndoableActionsForTest,
} from '../components/undo/undoable-actions';
import { AuthorityPersistenceContext } from '../contexts/AuthorityPersistenceContext';
import { ActiveChatsStore } from '../contexts/active-chats-store';
import {
  findShortcutConflicts,
  KeyboardShortcutsProvider,
  useShortcutRegistry,
} from '../contexts/KeyboardShortcutsContext';
import { ToastProvider, toastStore } from '../contexts/ToastContext';
import { deviceSettingsStore } from '../lib/device-settings-store';
import type { HomeWorkItem } from '../views/home/home-view-model';
import type { WorkFactsById } from '../views/home/work-facts';

const station = vi.hoisted(() => ({ apiBase: 'http://localhost' }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: station.apiBase }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn() }),
}));

// This panel fixture supplies the scope catalogue without connection queries.
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [] }),
}));

const NOW = Date.parse('2026-10-28T18:00:00Z');
const thread: HomeWorkItem = {
  id: 'conversation',
  conversationId: 'conversation',
  kind: 'orchestration',
  kindLabel: 'Conversation',
  title: 'Review the inbox',
  projectLabel: 'Station',
  agentLabel: 'Codex',
  modelLabel: 'GPT',
  lifecycleLabel: 'Running',
  updatedAt: NOW - 1000,
};

let registeredShortcuts: ReturnType<
  ReturnType<typeof useShortcutRegistry>['getAllShortcuts']
> = [];

function RegistryProbe() {
  registeredShortcuts = useShortcutRegistry().getAllShortcuts();
  return null;
}

function Harness({
  items,
  facts,
}: {
  items: HomeWorkItem[];
  facts?: WorkFactsById;
}) {
  const count = useInboxNeedsYouCount(items, NOW, facts);
  return (
    <ToastProvider>
      <KeyboardShortcutsProvider>
        <InboxDismissUndo>
          <UndoableActionShortcut>
            <RegistryProbe />
            <output aria-label="Needs you count">{count}</output>
            <ChatDockInboxPanel
              items={items}
              workFacts={facts}
              now={NOW}
              activeChatSessionId={null}
              openChatSessionIds={[]}
              onFocusChat={vi.fn()}
              onOpenConversation={vi.fn()}
              onOpenSession={vi.fn()}
              onCloseChat={vi.fn()}
              onOpenHistory={vi.fn()}
            />
            <NotificationContainer />
          </UndoableActionShortcut>
        </InboxDismissUndo>
      </KeyboardShortcutsProvider>
    </ToastProvider>
  );
}

/** Whether the dismissal's notice is live (a closing card lingers, inert, until its exit animation ends). */
function dismissNoticeShown() {
  return toastStore
    .getSnapshot()
    .some((toast) => toast.message === 'Conversation dismissed');
}

function dismiss() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Dismiss Review the inbox from inbox' }),
  );
}

beforeEach(() => {
  station.apiBase = 'http://localhost';
  toastStore.clear();
  toastStore.clearHistory();
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
});

describe('inbox dismissal through the rendered panel', () => {
  it('undoes with the primary modifier shortcut and leaves editor undo alone', () => {
    render(<Harness items={[thread]} />);
    dismiss();
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true, metaKey: true });
    expect(
      screen.queryByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeNull();
    editor.remove();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(
      screen.getByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeTruthy();
  });
  it.each([
    thread,
    { ...thread, kind: 'chat' as const, chatSessionId: 'open-chat' },
    { ...thread, kind: 'remote-session' as const, environmentId: 'peer' },
    { ...thread, lifecycleLabel: 'Draft' as const },
  ])(
    'dismisses $kind / $lifecycleLabel without a live tab, with Undo',
    (item) => {
      render(<Harness items={[item]} />);
      dismiss();
      expect(
        screen.queryByRole('button', { name: /^Review the inbox\b/ }),
      ).toBeNull();
      expect(screen.getByText('Conversation dismissed')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(
        screen.getByRole('button', { name: /^Review the inbox\b/ }),
      ).toBeTruthy();
    },
  );

  it('keeps dismissed work out of the default inbox and finds it through search after remount', () => {
    const view = render(<Harness items={[thread]} />);
    dismiss();
    view.unmount();
    render(<Harness items={[thread]} />);
    expect(
      screen.queryByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeNull();
    expect(screen.queryByRole('region', { name: /Dismissed/ })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search inbox' }), {
      target: { value: 'Review' },
    });
    const section = screen.getByRole('region', { name: /Dismissed/ });
    fireEvent.click(
      within(section).getByRole('button', {
        name: 'Restore Review the inbox to inbox',
      }),
    );
    expect(
      within(screen.getByRole('region', { name: 'Working' })).getByRole(
        'button',
        { name: /^Review the inbox\b/ },
      ),
    ).toBeTruthy();
  });

  it('keeps a dismissed third-party session hidden through activity and lifecycle changes', async () => {
    const external: HomeWorkItem = {
      ...thread,
      controlMode: 'read-only-attached',
    };
    const view = render(<Harness items={[external]} />);
    dismiss();
    view.rerender(
      <Harness
        items={[
          { ...external, lifecycleLabel: 'Completed', updatedAt: NOW + 2000 },
        ]}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search inbox' }), {
      target: { value: 'Review' },
    });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /Dismissed/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search inbox' }), {
      target: { value: '' },
    });
    expect(screen.queryByText('Review the inbox')).toBeNull();
    view.rerender(
      <Harness items={[{ ...external, controlMode: 'station-owned' }]} />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Review the inbox\b/ }),
      ).toBeTruthy(),
    );
  });

  it('ignores running progress, wakes for completion, and does not hide the next turn', async () => {
    const view = render(<Harness items={[thread]} />);
    dismiss();
    view.rerender(<Harness items={[{ ...thread, updatedAt: NOW + 1000 }]} />);
    expect(
      screen.queryByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeNull();
    view.rerender(
      <Harness
        items={[
          { ...thread, lifecycleLabel: 'Completed', updatedAt: NOW + 2000 },
        ]}
      />,
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: /^Review the inbox\b/ }),
        ).toBeTruthy(),
      { timeout: 3000 },
    );
    view.rerender(<Harness items={[{ ...thread, updatedAt: NOW + 3000 }]} />);
    expect(
      screen.getByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeTruthy();
  });

  it('stays dismissed through a turn the engine opened on its own, until it fails', async () => {
    const ready: HomeWorkItem = { ...thread, lifecycleLabel: 'Ready' };
    const row = () =>
      screen.queryByRole('button', { name: /^Review the inbox\b/ });
    const engineOpened = new Map([
      [thread.id, { engineOpenedTurn: true as const }],
    ]);
    const view = render(<Harness items={[ready]} />);
    dismiss();
    expect(row()).toBeNull();
    // Background work finished and the engine answered it: running, then done.
    view.rerender(
      <Harness
        items={[
          {
            ...ready,
            lifecycleLabel: 'Running',
            updatedAt: NOW + 1000,
          },
        ]}
        facts={engineOpened}
      />,
    );
    expect(row()).toBeNull();
    view.rerender(
      <Harness
        items={[
          {
            ...ready,
            lifecycleLabel: 'Ready',
            updatedAt: NOW + 2000,
          },
        ]}
        facts={engineOpened}
      />,
    );
    expect(row()).toBeNull();
    // An engine-opened turn that fails still needs the person.
    view.rerender(
      <Harness
        items={[
          {
            ...ready,
            lifecycleLabel: 'Failed',
            updatedAt: NOW + 3000,
          },
        ]}
        facts={engineOpened}
      />,
    );
    await waitFor(() => expect(row()).toBeTruthy(), { timeout: 3000 });
  });

  it('a turn the person sent still brings a dismissed conversation back', async () => {
    const ready: HomeWorkItem = { ...thread, lifecycleLabel: 'Ready' };
    const view = render(<Harness items={[ready]} />);
    dismiss();
    view.rerender(<Harness items={[{ ...ready, updatedAt: NOW + 2000 }]} />);
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: /^Review the inbox\b/ }),
        ).toBeTruthy(),
      { timeout: 3000 },
    );
  });

  it('keeps Needs-you counts in step with dismissal and a new attention request', () => {
    const attention: HomeWorkItem = {
      ...thread,
      lifecycleLabel: 'Needs attention',
    };
    const view = render(<Harness items={[attention]} />);
    expect(screen.getByLabelText('Needs you count').textContent).toBe('1');
    dismiss();
    expect(screen.getByLabelText('Needs you count').textContent).toBe('0');
    view.rerender(
      <Harness items={[{ ...attention, updatedAt: NOW + 1000 }]} />,
    );
    expect(screen.getByLabelText('Needs you count').textContent).toBe('1');
    expect(
      screen.getByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeTruthy();
  });

  it('wakes for an attention-kind change even when recency is unchanged', () => {
    const attention: HomeWorkItem = {
      ...thread,
      lifecycleLabel: 'Needs attention',
    };
    const view = render(
      <Harness
        items={[attention]}
        facts={new Map([[thread.id, { attention: 'approval' }]])}
      />,
    );
    dismiss();
    expect(
      screen.queryByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeNull();
    expect(screen.getByLabelText('Needs you count').textContent).toBe('0');
    view.rerender(
      <Harness
        items={[attention]}
        facts={new Map([[thread.id, { attention: 'answer' }]])}
      />,
    );
    expect(
      screen.getByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeTruthy();
  });

  it('keeps Undo working when a dismissed draft receives its durable conversation ID', () => {
    const store = new ActiveChatsStore({ storage: localStorage });
    store.initChat('draft-local', {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Review the inbox',
    });
    const draft: HomeWorkItem = {
      ...thread,
      id: 'draft-local',
      conversationId: undefined,
      chatSessionId: 'draft-local',
      lifecycleLabel: 'Draft',
    };
    const view = render(<Harness items={[draft]} />);
    dismiss();
    act(() =>
      store.assignConversationId('draft-local', 'conversation-durable'),
    );
    view.rerender(
      <Harness
        items={[
          {
            ...draft,
            id: 'conversation-durable',
            conversationId: 'conversation-durable',
          },
        ]}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(
      screen.getByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeTruthy();
  });

  it('observes a dismissal restored by another tab', () => {
    render(<Harness items={[thread]} />);
    dismiss();
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(
      screen.getByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeTruthy();
  });

  it('keeps the row visible and reports a failed storage write', () => {
    render(<Harness items={[thread]} />);
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('Quota exceeded');
      });
    try {
      dismiss();
      expect(
        screen.getByRole('button', { name: /^Review the inbox\b/ }),
      ).toBeTruthy();
      expect(
        screen.getByText('Could not save dismissal. Try again.'),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it('a toast that cannot show does not report a saved dismissal as failed', () => {
    render(<Harness items={[thread]} />);
    const upsert = vi.spyOn(toastStore, 'upsert').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not a function');
    });
    try {
      dismiss();
      expect(
        screen.queryByRole('button', { name: /^Review the inbox\b/ }),
      ).toBeNull();
      expect(
        screen.queryByText('Could not save dismissal. Try again.'),
      ).toBeNull();
    } finally {
      upsert.mockRestore();
    }
  });

  it('registers Cmd+Z once: the dismissal shares the app undo command instead of binding its own', () => {
    render(<Harness items={[thread]} />);
    const undoChord = registeredShortcuts.filter(
      (shortcut) =>
        shortcut.key.toLowerCase() === 'z' &&
        [...shortcut.modifiers].join('+') === 'cmd',
    );
    expect(undoChord.map((shortcut) => shortcut.id)).toEqual([
      'app.undoLastAction',
    ]);
    expect(findShortcutConflicts(registeredShortcuts)).toEqual([]);
  });

  it('Cmd+Z restores the dismissal while its notice is shown, and does nothing once the notice has gone', () => {
    render(<Harness items={[thread]} />);
    const row = () =>
      screen.queryByRole('button', { name: /^Review the inbox\b/ });
    dismiss();
    expect(row()).toBeNull();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(row()).toBeTruthy();
    expect(dismissNoticeShown()).toBe(false);

    dismiss();
    expect(row()).toBeNull();
    act(() => toastStore.clear());
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(row()).toBeNull();
  });

  it('a key still saved for the removed inbox Undo command is harmless: Cmd+Z restores, the stale key does nothing', () => {
    localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify({
        version: 2,
        values: {
          shortcutOverrides: {
            'inbox.undoDismiss': { key: 'u', modifiers: ['cmd'] },
          },
        },
      }),
    );
    deviceSettingsStore.reloadFromStorage();
    render(<Harness items={[thread]} />);
    const undo = registeredShortcuts.find(
      (shortcut) => shortcut.id === 'app.undoLastAction',
    );
    expect(undo && { key: undo.key, modifiers: [...undo.modifiers] }).toEqual({
      key: 'z',
      modifiers: ['cmd'],
    });
    const row = () =>
      screen.queryByRole('button', { name: /^Review the inbox\b/ });

    dismiss();
    fireEvent.keyDown(window, { key: 'u', ctrlKey: true });
    expect(row()).toBeNull();
    expect(dismissNoticeShown()).toBe(true);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(row()).toBeTruthy();
  });

  it('a dismissal notice that closed without Undo leaves the undo stack, so Cmd+Z reaches the earlier action still on screen', () => {
    resetUndoableActionsForTest();
    try {
      render(<Harness items={[thread]} />);
      const commit = vi.fn(() => Promise.resolve());
      const onUndo = vi.fn();
      // An earlier undoable action from another surface, through the same
      // owner a Board delete uses.
      act(() =>
        offerUndoableAction({
          key: 'board:daily-brief',
          message: 'Board deleted',
          restoredMessage: 'Restored Daily brief',
          commit,
          failureMessage: 'Could not delete the Board.',
          onUndo,
        }),
      );
      dismiss();
      const notice = toastStore
        .getSnapshot()
        .find((toast) => toast.message === 'Conversation dismissed');
      expect(notice).toBeTruthy();
      // The dismissal's notice goes away without Undo; the Board's stays.
      act(() => toastStore.dismiss(notice!.id));

      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

      expect(
        onUndo,
        'Cmd+Z should undo the Board delete still on screen',
      ).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('button', { name: /^Review the inbox\b/ }),
      ).toBeNull();
    } finally {
      resetUndoableActionsForTest();
    }
  });

  it('changing Station closes the dismissal notice, and Cmd+Z then restores nothing', () => {
    const view = render(<Harness items={[thread]} />);
    dismiss();
    expect(dismissNoticeShown()).toBe(true);

    station.apiBase = 'http://other-station';
    view.rerender(<Harness items={[thread]} />);

    expect(dismissNoticeShown()).toBe(false);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(
      screen.queryByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeNull();
  });

  it('changing namespace closes the dismissal notice, and Cmd+Z then restores nothing', () => {
    const inNamespace = (namespace: string) => (
      <AuthorityPersistenceContext.Provider
        value={{ status: 'verified', namespace, observation: null }}
      >
        <Harness items={[thread]} />
      </AuthorityPersistenceContext.Provider>
    );
    const view = render(inNamespace('station-a'));
    dismiss();
    expect(dismissNoticeShown()).toBe(true);

    view.rerender(inNamespace('station-b'));
    expect(dismissNoticeShown()).toBe(false);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    // Back in the namespace the dismissal was made in, it still stands.
    view.rerender(inNamespace('station-a'));
    expect(
      screen.queryByRole('button', { name: /^Review the inbox\b/ }),
    ).toBeNull();
  });
});
