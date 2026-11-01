import { useMemo } from 'react';
import {
  useConversationInbox,
  visibleInboxEntries,
} from '../../hooks/useConversationInbox';
import { type HeldMessages, QueuedMessages } from './QueuedMessages';

type QueuedMessagesProps = Parameters<typeof QueuedMessages>[0];

/**
 * The one pending-message surface above the composer: this browser's queued
 * follow-ups and the ones Station holds in the conversation's server inbox
 * (#3868), in one list. Nothing renders while neither holds anything, and a
 * background read of the inbox changes nothing on screen unless its answer
 * does.
 */
export function ConversationInboxMessages({
  conversationId,
  conversationActive,
  onResend,
  ...queue
}: Omit<QueuedMessagesProps, 'held'> & {
  /** Absent for a replay or a conversation Station has not named yet. */
  conversationId?: string;
  /** The conversation is working, so Station may start holding follow-ups. */
  conversationActive?: boolean;
  /** Restore an unknown message for explicit review; false preserves a busy composer. */
  onResend?: (message: string) => boolean;
}) {
  const inbox = useConversationInbox(conversationId ?? '', {
    active: conversationActive,
  });
  const entries = inbox.entries;
  const visible = useMemo(() => visibleInboxEntries(entries), [entries]);
  const displayEntries = useMemo(
    () =>
      (entries ?? []).filter(
        (entry) => entry.kind === 'display' && entry.state === 'sent',
      ),
    [entries],
  );
  const { remove, refresh, removing, removalError, lostSightOfEntries } = inbox;
  const held: HeldMessages = {
    entries: visible,
    unavailable: lostSightOfEntries,
    removing,
    removalError,
    onRemove: (key) => {
      void remove(key).catch(() => undefined);
    },
    onRetry: refresh,
    ...(onResend
      ? {
          onResend: (entry) => {
            if (entry.clientTurnId && onResend(entry.message))
              void remove(entry.clientTurnId).catch(() => undefined);
          },
        }
      : {}),
  };
  return (
    <>
      {displayEntries.length > 0 && (
        <section aria-label="Display-only entries">
          {displayEntries.map((entry) => (
            <div
              className="queued-message"
              key={entry.clientTurnId ?? `${entry.createdAt}:${entry.message}`}
            >
              <span className="queued-message__text">
                <span className="queued-message__body">{entry.message}</span>
                <span className="queued-message__status">Display only</span>
              </span>
            </div>
          ))}
        </section>
      )}
      <QueuedMessages {...queue} held={held} />
    </>
  );
}
