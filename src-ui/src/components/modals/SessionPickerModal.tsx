import {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
} from '@kontourai/station-contracts/time';
import {
  type ConversationListItem,
  useConversationInventoryQuery,
} from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { type AutoSelectItem, AutoSelectModal } from './AutoSelectModal';

interface SessionPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The selected row is the input to server-authoritative open resolution. */
  onSelect: (
    conversation: ConversationListItem,
  ) => undefined | boolean | Promise<undefined | boolean>;
  agents: Array<{ slug: string; name: string }>;
  projects: Array<{ slug: string; name: string }>;
  activeConversationIds?: string[];
}

export function SessionPickerModal({
  isOpen,
  onClose,
  onSelect,
  agents,
  projects,
  activeConversationIds = [],
}: SessionPickerModalProps) {
  const inventoryQuery = useConversationInventoryQuery({ enabled: isOpen });
  const conversations = useMemo(
    () =>
      [...(inventoryQuery.data ?? [])]
        // File-store history is still listed elsewhere, but lacks the
        // principal-aware point-read contract this picker requires. Never
        // offer a row that authoritative open must deny.
        .filter((conversation) => conversation.source === 'runtime')
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
    [inventoryQuery.data],
  );

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / MS_PER_MINUTE);
    const diffHours = Math.floor(diffMs / MS_PER_HOUR);
    const diffDays = Math.floor(diffMs / MS_PER_DAY);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const items: AutoSelectItem<ConversationListItem>[] = conversations.map(
    (conv) => {
      const agent = agents.find((a) => a.slug === conv.agentSlug);
      const project = projects.find((p) => p.slug === conv.projectSlug);
      const isActive = activeConversationIds.includes(conv.id);

      return {
        id: conv.id,
        title: conv.title,
        subtitle: [agent?.name || conv.agentSlug, project?.name]
          .filter(Boolean)
          .join(' · '),
        timestamp: formatDate(conv.updatedAt),
        isActive,
        metadata: conv,
      };
    },
  );

  return (
    <AutoSelectModal
      isOpen={isOpen}
      title="Open Conversation"
      placeholder="Search conversations..."
      items={items}
      loading={inventoryQuery.isLoading}
      // archive#771: `AutoSelectModal` (published by the SDK) has no error
      // affordance of its own — only `loading`/`emptyMessage`, both plain
      // strings, so there is no button slot to wire a real retry into. A
      // settled read failure used to fall straight through to the SAME "No
      // conversations found" an actually-empty inventory shows; the smallest
      // defensible fix within that constraint is honest copy naming the
      // affordance that actually exists. This modal is conditionally mounted
      // by its parent (`ChatDockModalStack`: `{showSessionPicker && (...)}`),
      // so closing and reopening it unmounts/remounts the whole tree —
      // `useConversationInventoryQuery({ enabled: isOpen })` genuinely
      // refetches on that remount, not a fabricated "try again."
      emptyMessage={
        inventoryQuery.isError
          ? 'Could not load conversations. Close and reopen to try again.'
          : 'No conversations found'
      }
      onSelect={async (item) => {
        const conversation = item.metadata!;
        const opened = await onSelect(conversation);
        // An authoritative recovery/error result keeps the picker visible;
        // closing it would turn a denied or unavailable resolution into a
        // silent no-op.
        if (opened !== false) onClose();
      }}
      onClose={onClose}
      renderMetadata={(item) => {
        const messageCount = item.metadata?.messageCount;
        if (!messageCount) return null;

        return (
          <div
            style={{
              fontSize: '12px',
              color: 'var(--text-muted)',
              display: 'flex',
              gap: '12px',
              marginTop: '4px',
            }}
          >
            <span>{messageCount} messages</span>
          </div>
        );
      }}
    />
  );
}
