import { useState } from 'react';
import type { UnsentMessageRecord } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import './UnsentMessages.css';

interface UnsentMessagesProps {
  sessionId: string;
  messages: UnsentMessageRecord[];
}

/**
 * The permanently refused follow-ups this chat is still holding for the user
 * (archive#3706). Each row is user-authored text whose queue entry was dropped
 * and whose optimistic bubble was rolled back — this surface is the only
 * durable place it still exists, so every affordance here is about getting the
 * text back out, never about resending it: the refusal was permanent for this
 * conversation, and a Retry would re-offer the exact send that was refused.
 *
 * Rows leave only by the user's own Dismiss, keyed on the record's `id`.
 */
export function UnsentMessages({ sessionId, messages }: UnsentMessagesProps) {
// Copy feedback is per-row and transient; `id` is the row key (`at` is a
 // timestamp, not an identity — archive#3706).
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const dismiss = (id: string) => {
    const chat = activeChatsStore.getSnapshot()[sessionId];
    activeChatsStore.updateChat(sessionId, {
      unsentMessages: (chat?.unsentMessages ?? []).filter(
        (record) => record.id !== id,
      ),
    });
  };

  const copy = async (record: UnsentMessageRecord) => {
    try {
      await navigator.clipboard.writeText(record.content);
      setCopiedId(record.id);
    } catch {
// The row itself keeps showing the full text, so a refused clipboard
// write costs nothing — and claiming "Copied" here would be false.
      setCopiedId(null);
    }
  };

  if (messages.length === 0) return null;
  return (
    <section className="unsent-messages" aria-label="Unsent messages">
      <div className="unsent-messages__label">Not sent</div>
      <div className="unsent-messages__list">
        {messages.map((record) => (
          <div className="unsent-message" key={record.id}>
            <div className="unsent-message__body">
              <span className="unsent-message__text">{record.content}</span>
              <span className="unsent-message__reason">{record.reason}</span>
            </div>
            <div className="unsent-message__actions">
              <button
                type="button"
                className="unsent-message__action"
                onClick={() => void copy(record)}
              >
                {copiedId === record.id ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className="unsent-message__action"
                onClick={() => dismiss(record.id)}
                aria-label="Dismiss unsent message"
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default UnsentMessages;
