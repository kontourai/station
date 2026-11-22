import { useEffect, useRef } from 'react';
import { absoluteTime, relativeTimeAgoFromIso } from '../../utils/relativeTime';
import { Button } from '../Button';
import { useConversationWorkState } from '../chat-dock/useConversationWorkState';
import './SettledConversationNotes.css';

/**
 * When this person settled `conversationId` (Open and Settled inbox), or
 * `undefined` while the preview is off, the record is unread, or it is open.
 *
 * A turn starting re-reads the record once: the host clears it for the
 * person's own message, a question, a failure or a stop, and keeps it for a
 * quiet turn the engine opened.
 */
export function useSettledConversation(
  conversationId: string | undefined,
  turnInFlight = false,
) {
  const state = useConversationWorkState();
  const settledAt =
    state.supported &&
    conversationId &&
    Object.hasOwn(state.settled, conversationId)
      ? state.settled[conversationId]
      : undefined;
  const refetch = useRef(state.query.refetch);
  refetch.current = state.query.refetch;
  const isSettled = settledAt !== undefined;
  useEffect(() => {
    if (turnInFlight && isSettled) void refetch.current();
  }, [turnInFlight, isSettled]);
  if (settledAt === undefined || !conversationId) return undefined;
  return {
    settledAt,
    pending: state.change.isPending,
    reopen: () => state.change.mutate({ conversationId, settled: false }),
  };
}

/** The end of a settled conversation's transcript: when, and Reopen. */
export function SettledConversationFooter({
  conversationId,
}: {
  conversationId: string | undefined;
}) {
  const settled = useSettledConversation(conversationId);
  if (!settled) return null;
  const at = Date.parse(settled.settledAt);
  return (
    <div className="settled-conversation-footer">
      <span
        title={Number.isFinite(at) ? absoluteTime(at) : undefined}
      >{`Settled ${relativeTimeAgoFromIso(settled.settledAt)}`}</span>
      <span aria-hidden="true">·</span>
      <Button
        variant="link"
        size="sm"
        disabled={settled.pending}
        onClick={settled.reopen}
      >
        Reopen
      </Button>
    </div>
  );
}

/** The composer's quiet line for a settled conversation. */
export const SETTLED_COMPOSER_NOTICE = 'Sending reopens this conversation';
