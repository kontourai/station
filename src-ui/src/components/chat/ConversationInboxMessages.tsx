import { useConversationInbox } from '../../hooks/useConversationInbox';
import { Button } from '../Button';
import './ConversationInboxMessages.css';

const STATE_LABEL = {
  queued: 'Waiting for the current turn',
  sending: 'Sending',
  unconfirmed: 'Delivery outcome unknown.',
  refused: 'Not sent',
  sent: 'Sent',
  cancelled: 'Removed',
};

export function ConversationInboxMessages({
  conversationId,
}: {
  conversationId: string;
}) {
  const inbox = useConversationInbox(conversationId);
  const rows = inbox.entries?.filter(
    (entry) => entry.state !== 'sent' && entry.state !== 'cancelled',
  );
  return (
    <section
      className="conversation-inbox"
      aria-label="Messages held by Station"
    >
      <div className="conversation-inbox__header">
        <span role="status">
          {inbox.availability === 'available'
            ? `${inbox.pendingCount} pending message${inbox.pendingCount === 1 ? '' : 's'} held by Station`
            : inbox.availability === 'loading'
              ? 'Checking messages held by Station…'
              : 'Messages held by Station are unavailable.'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={inbox.refresh}
          disabled={inbox.refreshing}
        >
          Refresh
        </Button>
      </div>
      {inbox.availability === 'available' && inbox.refreshing && (
        <span className="conversation-inbox__state">Refreshing queue…</span>
      )}
      {inbox.removalError && (
        <p role="alert">
          Removal was not confirmed. Read the queue again before trying another
          action.
        </p>
      )}
      {rows?.length ? (
        <ul>
          {rows.map((entry, index) => (
            <li key={entry.clientTurnId ?? `${entry.createdAt}:${index}`}>
              <div>
                <p className="conversation-inbox__message">{entry.message}</p>
                <span className="conversation-inbox__state">
                  {STATE_LABEL[entry.state]}
                </span>
                {entry.reason && <p>{entry.reason}</p>}
              </div>
              {entry.clientTurnId &&
                ['queued', 'unconfirmed', 'refused'].includes(entry.state) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    pending={inbox.removing}
                    pendingLabel="Removing…"
                    aria-label={`${entry.state === 'queued' ? 'Remove' : 'Dismiss'} held message: ${entry.message}`}
                    onClick={() => {
                      void inbox
                        .remove(entry.clientTurnId!)
                        .catch(() => undefined);
                    }}
                  >
                    {entry.state === 'queued' ? 'Remove' : 'Dismiss'}
                  </Button>
                )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
