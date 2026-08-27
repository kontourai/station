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

vi.mock('../hooks/useSessionManagementMenu', () => ({
  useSessionManagementMenu: () => ({
    setShowClearAllConfirm: vi.fn(),
    deleteConfirm: null,
    regenerateConfirm: null,
    showClearAllConfirm: false,
    renamingId: null,
    newTitle: '',
    inputRef: { current: null },
    startRename: vi.fn(),
    handleRename: vi.fn(),
    cancelRename: vi.fn(),
    handleDelete: vi.fn(),
    setNewTitle: vi.fn(),
    confirmDelete: vi.fn(),
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

vi.mock('../components/modals/ConfirmModal', () => ({
  ConfirmModal: () => null,
}));

const { ConversationHistory } = await import(
  '../components/chat/ConversationHistory'
);

describe('ConversationHistory', () => {
  afterEach(() => {
    pagingState.hasMore = true;
    pagingState.loadingMore = false;
    pagingState.loadMoreError = false;
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
});
