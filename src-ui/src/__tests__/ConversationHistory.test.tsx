/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const loadMore = vi.fn();
const conversationState = vi.hoisted(() => ({
  conversations: [
    {
      id: 'thread-1',
      source: 'runtime',
      agentSlug: 'claude',
      title: 'Newest indexed conversation',
      createdAt: '2026-08-08T12:00:00.000Z',
      updatedAt: '2026-08-08T12:01:00.000Z',
      messageCount: 1,
      mutable: false,
      projectSlug: 'alpha',
    },
    {
      id: 'thread-2',
      source: 'runtime',
      agentSlug: 'claude',
      title: 'Other project conversation',
      createdAt: '2026-08-08T11:00:00.000Z',
      updatedAt: '2026-08-08T11:01:00.000Z',
      messageCount: 1,
      mutable: false,
      projectSlug: 'beta',
    },
    {
      id: 'thread-legacy',
      source: 'store',
      agentSlug: 'claude',
      title: 'Legacy project-less conversation',
      createdAt: '2026-08-08T10:00:00.000Z',
      updatedAt: '2026-08-08T10:01:00.000Z',
      messageCount: 1,
      mutable: true,
    },
  ] as Array<Record<string, unknown>>,
}));
const pagingState = vi.hoisted(() => ({
  hasMore: true,
  loadingMore: false,
  loadMoreError: false,
}));

vi.mock('../hooks/useSessionManagementViewModel', () => ({
  useSessionManagementViewModel: () => ({
    conversations: conversationState.conversations,
    loading: false,
    hasMore: pagingState.hasMore,
    loadingMore: pagingState.loadingMore,
    loadMoreError: pagingState.loadMoreError,
    loadMore,
  }),
}));

/**
 * #2144 slice 6 item E: the delete-confirm state the component decides what
 * to do with. Hoisted so a test can put a delete in flight.
 */
const menuState = vi.hoisted(() => ({
  deleteConfirm: null as { conv: { title: string } } | null,
  regenerateConfirm: null as { conv: { title: string } } | null,
  showClearAllConfirm: false,
  confirmDelete: vi.fn(),
}));

vi.mock('../hooks/useSessionManagementMenu', () => ({
  useSessionManagementMenu: () => ({
    setShowClearAllConfirm: vi.fn(),
    deleteConfirm: menuState.deleteConfirm,
    regenerateConfirm: menuState.regenerateConfirm,
    showClearAllConfirm: menuState.showClearAllConfirm,
    renamingId: null,
    newTitle: '',
    inputRef: { current: null },
    startRename: vi.fn(),
    handleRename: vi.fn(),
    cancelRename: vi.fn(),
    handleDelete: vi.fn(),
    setNewTitle: vi.fn(),
    confirmDelete: menuState.confirmDelete,
    cancelDelete: vi.fn(),
    confirmRegenerateTitle: vi.fn(),
    cancelRegenerateTitle: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock('../components/session/SessionConversationItem', () => ({
  SessionConversationItem: ({
    conversation,
    projectLabel,
  }: {
    conversation: { title: string };
    projectLabel?: string;
  }) => (
    <div>
      {conversation.title}
      {projectLabel ? ` · ${projectLabel}` : ''}
    </div>
  ),
}));

/**
 * Renders a marker only when OPEN, so a test can tell "the modal is on
 * screen" from "the modal exists but is closed" (#2144 slice 6 item E). It
 * rendered `null` unconditionally before, which cannot distinguish them.
 */
vi.mock('../components/modals/ConfirmModal', () => ({
  ConfirmModal: ({ isOpen, title }: { isOpen: boolean; title: string }) =>
    isOpen ? <div data-testid="confirm-modal">{title}</div> : null,
}));

const { ConversationHistory } = await import(
  '../components/chat/ConversationHistory'
);
const { deviceSettingsStore } = await import('../lib/device-settings-store');

describe('ConversationHistory', () => {
  afterEach(() => {
    pagingState.hasMore = true;
    pagingState.loadingMore = false;
    pagingState.loadMoreError = false;
    menuState.deleteConfirm = null;
    menuState.regenerateConfirm = null;
    menuState.showClearAllConfirm = false;
    menuState.confirmDelete.mockClear();
    deviceSettingsStore.reset('confirmConversationDelete');
  });

  test('offers a next step when conversation history is empty', () => {
    const previous = conversationState.conversations;
    conversationState.conversations = [];
    const onClose = vi.fn();
    render(
      <ConversationHistory
        sessions={[]}
        activeSessionId={null}
        agents={[]}
        projects={[]}
        onTitleUpdate={vi.fn()}
        onDelete={vi.fn()}
        onSelect={vi.fn()}
        onOpenConversation={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start a chat' }));
    expect(onClose).toHaveBeenCalledOnce();
    conversationState.conversations = previous;
  });

  test('offers explicit load-more history paging instead of silently truncating the inventory', () => {
    render(
      <ConversationHistory
        sessions={[]}
        activeSessionId={null}
        agents={[{ slug: 'claude', name: 'Claude' }]}
        projects={[
          { slug: 'alpha', name: 'Alpha Project' },
          { slug: 'beta', name: 'Beta Project' },
        ]}
        onTitleUpdate={vi.fn()}
        onDelete={vi.fn()}
        onSelect={vi.fn()}
        onOpenConversation={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  test('distinguishes in-flight, failed, and exhausted older-message history', () => {
    const props = {
      sessions: [],
      activeSessionId: null,
      agents: [{ slug: 'claude', name: 'Claude' }],
      projects: [],
      onTitleUpdate: vi.fn(),
      onDelete: vi.fn(),
      onSelect: vi.fn(),
      onOpenConversation: vi.fn(),
      onClose: vi.fn(),
    };
    pagingState.loadingMore = true;
    const { rerender } = render(<ConversationHistory {...props} />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(
      'Loading older messages',
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    pagingState.loadingMore = false;
    pagingState.loadMoreError = true;
    rerender(<ConversationHistory {...props} />);
    expect(screen.getByRole('alert').textContent).toBe(
      'Could not load older messages. Try again.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(loadMore).toHaveBeenCalled();

    pagingState.loadMoreError = false;
    pagingState.hasMore = false;
    rerender(<ConversationHistory {...props} />);
    expect(screen.getByText('No more messages')).toBeTruthy();
  });

  test('follows explicit dock Project scope while retaining legacy project-less history', () => {
    render(
      <ConversationHistory
        sessions={[]}
        activeSessionId={null}
        agents={[{ slug: 'claude', name: 'Claude' }]}
        projects={[
          { slug: 'alpha', name: 'Alpha Project' },
          { slug: 'beta', name: 'Beta Project' },
        ]}
        projectScope={{ slug: 'alpha', name: 'Alpha Project' }}
        onTitleUpdate={vi.fn()}
        onDelete={vi.fn()}
        onSelect={vi.fn()}
        onOpenConversation={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Project:', { exact: false }).textContent,
    ).toContain('Alpha Project');
    expect(
      screen.getByText(/Newest indexed conversation/).textContent,
    ).toContain('Alpha Project');
    expect(screen.getByText('Legacy project-less conversation')).not.toBeNull();
    expect(screen.queryByText(/Other project conversation/)).toBeNull();
  });

  /**
   * #2144 slice 6 item E. `confirmConversationDelete` decides whether a
   * requested delete parks in the confirm modal or resolves immediately.
   * Both directions are asserted: a consumer that always skipped the modal,
   * and one that never did, each fail exactly one of these.
   */
  describe('confirmConversationDelete', () => {
    function renderHistory() {
      return render(
        <ConversationHistory
          sessions={[]}
          activeSessionId={null}
          agents={[{ slug: 'claude', name: 'Claude' }]}
          projects={[]}
          onTitleUpdate={vi.fn()}
          onDelete={vi.fn()}
          onSelect={vi.fn()}
          onOpenConversation={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    }

    test('asks first by default, and does not delete while it asks', () => {
      expect(deviceSettingsStore.get('confirmConversationDelete')).toBe(true);
      menuState.deleteConfirm = { conv: { title: 'Doomed conversation' } };
      renderHistory();
      expect(screen.getByTestId('confirm-modal').textContent).toBe(
        'Delete Conversation',
      );
      expect(menuState.confirmDelete).not.toHaveBeenCalled();
    });

    test('deletes without the modal when the device has turned the ask off', () => {
      deviceSettingsStore.set('confirmConversationDelete', false);
      menuState.deleteConfirm = { conv: { title: 'Doomed conversation' } };
      renderHistory();
      expect(screen.queryByTestId('confirm-modal')).toBeNull();
      // The SAME `confirmDelete` the modal's confirm button calls — the
      // immediate path is not a second delete implementation.
      expect(menuState.confirmDelete).toHaveBeenCalledTimes(1);
    });

    test('with the ask off and nothing pending, nothing is deleted', () => {
      deviceSettingsStore.set('confirmConversationDelete', false);
      menuState.deleteConfirm = null;
      renderHistory();
      expect(menuState.confirmDelete).not.toHaveBeenCalled();
    });

    test('clearing every conversation still asks, with the ask off', () => {
      // The setting is named for ONE action. This drives the OTHER
      // destructive confirm in this component with the setting off and
      // asserts it is still on screen — a gate applied to the wrong modal,
      // or to all of them, fails here.
      deviceSettingsStore.set('confirmConversationDelete', false);
      menuState.showClearAllConfirm = true;
      renderHistory();
      expect(screen.getByTestId('confirm-modal').textContent).toBe(
        'Clear All Conversations',
      );
    });

    test('replacing a manual title still asks, with the ask off', () => {
      deviceSettingsStore.set('confirmConversationDelete', false);
      menuState.regenerateConfirm = { conv: { title: 'Hand-written title' } };
      renderHistory();
      expect(screen.getByTestId('confirm-modal').textContent).toBe(
        'Replace manual title?',
      );
    });
  });
});
