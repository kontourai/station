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
import { ActiveChatsStore } from '../contexts/active-chats-store';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { ToastProvider, toastStore } from '../contexts/ToastContext';
import { deviceSettingsStore } from '../lib/device-settings-store';
import type { HomeWorkItem } from '../views/home/home-view-model';
import type { WorkFactsById } from '../views/home/work-facts';

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost' }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn() }),
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

function Harness({
  items,
  facts,
}: {
  items: HomeWorkItem[];
  facts?: WorkFactsById;
}) {
  const count = useInboxNeedsYouCount(items, NOW);
  return (
    <ToastProvider>
      <KeyboardShortcutsProvider>
        <InboxDismissUndo>
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
        </InboxDismissUndo>
      </KeyboardShortcutsProvider>
    </ToastProvider>
  );
}

function dismiss() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Dismiss Review the inbox from inbox' }),
  );
}

beforeEach(() => {
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
      screen.queryByRole('button', { name: 'Review the inbox, Station' }),
    ).toBeNull();
    editor.remove();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(
      screen.getByRole('button', { name: 'Review the inbox, Station' }),
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
        screen.queryByRole('button', { name: 'Review the inbox, Station' }),
      ).toBeNull();
      expect(screen.getByText('Conversation dismissed')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(
        screen.getByRole('button', { name: 'Review the inbox, Station' }),
      ).toBeTruthy();
    },
  );

  it('persists across remounts and restores from the collapsed Dismissed section', () => {
    const view = render(<Harness items={[thread]} />);
    dismiss();
    view.unmount();
    render(<Harness items={[thread]} />);
    expect(
      screen.queryByRole('button', { name: 'Review the inbox, Station' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Dismissed/ }));
    const section = screen.getByRole('region', { name: /Dismissed/ });
    fireEvent.click(
      within(section).getByRole('button', {
        name: 'Restore Review the inbox to inbox',
      }),
    );
    expect(
      within(screen.getByRole('region', { name: 'Running' })).getByRole(
        'button',
        { name: 'Review the inbox, Station' },
      ),
    ).toBeTruthy();
  });

  it('ignores running progress, wakes for completion, and does not hide the next turn', async () => {
    const view = render(<Harness items={[thread]} />);
    dismiss();
    view.rerender(<Harness items={[{ ...thread, updatedAt: NOW + 1000 }]} />);
    expect(
      screen.queryByRole('button', { name: 'Review the inbox, Station' }),
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
          screen.getByRole('button', { name: 'Review the inbox, Station' }),
        ).toBeTruthy(),
      { timeout: 3000 },
    );
    view.rerender(<Harness items={[{ ...thread, updatedAt: NOW + 3000 }]} />);
    expect(
      screen.getByRole('button', { name: 'Review the inbox, Station' }),
    ).toBeTruthy();
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
      screen.getByRole('button', { name: 'Review the inbox, Station' }),
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
      screen.queryByRole('button', { name: 'Review the inbox, Station' }),
    ).toBeNull();
    expect(screen.getByLabelText('Needs you count').textContent).toBe('0');
    view.rerender(
      <Harness
        items={[attention]}
        facts={new Map([[thread.id, { attention: 'answer' }]])}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Review the inbox, Station' }),
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
      screen.queryByRole('button', { name: 'Review the inbox, Station' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(
      screen.getByRole('button', { name: 'Review the inbox, Station' }),
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
      screen.getByRole('button', { name: 'Review the inbox, Station' }),
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
        screen.getByRole('button', { name: 'Review the inbox, Station' }),
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
    const show = vi.spyOn(toastStore, 'show').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not a function');
    });
    try {
      dismiss();
      expect(
        screen.queryByRole('button', { name: 'Review the inbox, Station' }),
      ).toBeNull();
      expect(
        screen.queryByText('Could not save dismissal. Try again.'),
      ).toBeNull();
      // Undo stays reachable without the toast.
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      expect(
        screen.getByRole('button', { name: 'Review the inbox, Station' }),
      ).toBeTruthy();
    } finally {
      show.mockRestore();
    }
  });
});
