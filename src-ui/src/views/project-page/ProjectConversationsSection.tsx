import type { ConversationRecord } from './types';
import { timeAgo } from './utils';

export function ProjectConversationsSection({
  conversations,
  onConversationClick,
}: {
  conversations: ConversationRecord[];
  onConversationClick: (conversation: ConversationRecord) => void;
}) {
  if (conversations.length === 0) {
    return null;
  }

  return (
    <div className="project-page__conversations">
      <div className="project-page__section-header">
        <span className="project-page__section-label">
          Recent Conversations
        </span>
      </div>
      <div className="project-page__conversation-list">
        {conversations.map((conversation) => (
          <button
            type="button"
            key={conversation.id}
            className="project-page__conversation-item"
            onClick={() => onConversationClick(conversation)}
          >
            <span className="project-page__conversation-title">
              {conversation.title || 'Untitled'}
            </span>
            <span className="project-page__conversation-agent">
              {conversation.agentSlug}
            </span>
            <span className="project-page__conversation-time">
              {timeAgo(conversation.updatedAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
