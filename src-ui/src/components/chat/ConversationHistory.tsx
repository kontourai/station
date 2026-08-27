import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { useSessionManagementMenu } from '../../hooks/useSessionManagementMenu';
import { useSessionManagementViewModel } from '../../hooks/useSessionManagementViewModel';
import { ConfirmModal } from '../modals/ConfirmModal';
import { SessionConversationItem } from '../session/SessionConversationItem';
import { Empty, SkeletonList } from '../state';

interface Session {
  id: string;
  conversationId: string;
  agentSlug: string;
  agentName: string;
  title: string;
}

interface ConversationHistoryProps {
  sessions: Session[];
  activeSessionId: string | null;
  agents: Array<{
    slug: string;
    name: string;
    source?: string;
    connectionType?: string | null;
    connectionName?: string | null;
    engineDisplayName?: string | null;
    model?: string;
    engineId?: EngineId;
    execution?: { agentConnectionId?: string | null };
  }>;
  projects: Array<{ slug: string; name: string }>;
  /** Explicit dock scope. Null keeps History global. */
  projectScope?: { slug: string; name: string } | null;
  onTitleUpdate: (sessionId: string, newTitle: string) => void;
  onDelete: (sessionId: string) => void;
  onSelect: (sessionId: string) => void;
  onOpenConversation: (
    conversationId: string,
    agentSlug: string,
    projectSlug?: string,
    projectName?: string,
    model?: string,
  ) => void;
  onClose: () => void;
}

export function ConversationHistory({
  sessions,
  activeSessionId,
  agents,
  projects,
  projectScope,
  onTitleUpdate,
  onDelete,
  onSelect,
  onOpenConversation,
  onClose,
}: ConversationHistoryProps) {
  const menu = useSessionManagementMenu({
    sessions,
    agents,
    onTitleUpdate,
    onDelete,
  });

  const {
    conversations,
    loading,
    hasMore,
    loadingMore,
    loadMoreError,
    loadMore,
  } = useSessionManagementViewModel(agents, true);
  // Preserve project-less legacy history under an explicit Project scope so
  // older conversations never disappear behind a filter they predate.
  const visibleConversations = projectScope
    ? conversations.filter(
        (conversation) =>
          !conversation.projectSlug ||
          conversation.projectSlug === projectScope.slug,
      )
    : conversations;
  const mutableConversations = visibleConversations.filter(
    (conversation) => conversation.mutable !== false,
  );
  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );

  const handleSelectConversation = (conv: {
    id: string;
    agentSlug: string;
    projectSlug?: string;
    model?: string;
  }) => {
    const existing = sessions.find((s) => s.conversationId === conv.id);
    if (existing) {
      onSelect(existing.id);
    } else {
      onOpenConversation(
        conv.id,
        conv.agentSlug,
        conv.projectSlug,
        undefined,
        conv.model,
      );
    }
    onClose();
  };

  return (
    <div className="conversation-history">
      <div className="conversation-history__header">
        <span className="conversation-history__title">
          History ({visibleConversations.length})
        </span>
        <div className="conversation-history__actions">
          {mutableConversations.length > 0 && (
            <button
              type="button"
              className="conversation-history__clear-btn"
              onClick={() => menu.setShowClearAllConfirm(true)}
            >
              Clear All
            </button>
          )}
          <button
            type="button"
            className="conversation-history__close-btn"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>

      {projectScope && (
        <div className="conversation-history__scope">
          Project: <strong>{projectScope.name}</strong>
        </div>
      )}

      <div className="conversation-history__list">
        {loading ? (
          <SkeletonList />
        ) : visibleConversations.length === 0 ? (
          <Empty
            variant="compact"
            label="No conversations yet"
            action={
              <button
                type="button"
                className="conversation-history__load-more"
                onClick={onClose}
              >
                Start a chat
              </button>
            }
          />
        ) : (
          visibleConversations.map((conv) => (
            <SessionConversationItem
              key={conv.id}
              conversation={conv}
              projectLabel={
                projects.find((project) => project.slug === conv.projectSlug)
                  ?.name ?? conv.projectSlug
              }
              isActive={sessions.some(
                (s) => s.conversationId === conv.id && s.id === activeSessionId,
              )}
              hasActiveChat={sessions.some((s) => s.conversationId === conv.id)}
              isRenaming={menu.renamingId === conv.id}
              newTitle={menu.newTitle}
              inputRef={menu.inputRef}
              onSelect={() => handleSelectConversation(conv)}
              onStartRename={() => menu.startRename(conv)}
              onRename={() => menu.handleRename(conv)}
              onCancelRename={menu.cancelRename}
              onDelete={() => menu.handleDelete(conv)}
              onRegenerateTitle={() => void menu.handleRegenerateTitle(conv)}
              actionError={
                menu.actionError?.id === conv.id
                  ? menu.actionError.message
                  : undefined
              }
              onOpenForkSource={(conversationId) => {
                const source = conversationsById.get(conversationId);
                if (source) handleSelectConversation(source);
              }}
              onOpenForkConversation={(conversationId) => {
                const fork = conversationsById.get(conversationId);
                if (fork) handleSelectConversation(fork);
              }}
              resolveConversationTitle={(conversationId) =>
                conversationsById.get(conversationId)?.title
              }
              onTitleChange={menu.setNewTitle}
            />
          ))
        )}
        {loadingMore ? (
          <SkeletonList
            count={2}
            withIcon={false}
            label="Loading older messages"
          />
        ) : loadMoreError ? (
          <>
            <p className="conversation-history__pagination-status" role="alert">
              Could not load older messages. Try again.
            </p>
            <button
              type="button"
              className="conversation-history__load-more"
              onClick={() => void loadMore()}
            >
              Try again
            </button>
          </>
        ) : hasMore ? (
          <button
            type="button"
            className="conversation-history__load-more"
            onClick={() => void loadMore()}
          >
            Load more
          </button>
        ) : visibleConversations.length > 0 ? (
          <p className="conversation-history__pagination-status">
            No more messages
          </p>
        ) : null}
      </div>

      <ConfirmModal
        isOpen={!!menu.deleteConfirm}
        title="Delete Conversation"
        message={`Delete "${menu.deleteConfirm?.conv.title || 'this conversation'}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={menu.confirmDelete}
        onCancel={menu.cancelDelete}
      />

      <ConfirmModal
        isOpen={!!menu.regenerateConfirm}
        title="Replace manual title?"
        message={`Regenerate and replace your title "${menu.regenerateConfirm?.conv.title || 'Untitled'}"?`}
        confirmLabel="Replace title"
        cancelLabel="Keep title"
        onConfirm={() => void menu.confirmRegenerateTitle()}
        onCancel={menu.cancelRegenerateTitle}
      />

      <ConfirmModal
        isOpen={menu.showClearAllConfirm}
        title="Clear All Conversations"
        message={`Delete all ${mutableConversations.length} editable conversations? Runtime-owned history will remain available.`}
        confirmLabel="Clear All"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => menu.clearAll(mutableConversations)}
        onCancel={() => menu.setShowClearAllConfirm(false)}
      />
    </div>
  );
}
