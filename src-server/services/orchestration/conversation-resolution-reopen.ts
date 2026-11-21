import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { errorMessage } from '../../utils/error-message.js';
import type { ConversationWorkStateStore } from './conversation-work-state-store.js';
import type { EventBus } from './event-bus.js';
import { resolveTurnCompletionOutcome } from './turn-completion-notifications.js';

/**
 * Whether `event` brings a settled conversation back for everyone who
 * settled it: the conversation asks a person something, a turn fails, or a
 * turn is stopped. These are facts of the conversation, not of one person,
 * so no one keeps it settled while it needs someone.
 *
 * A turn starting or finishing normally never reopens, whoever opened it:
 * an engine-opened reply to background work, a scheduled wake-up or a task
 * notification stays quiet (as `isInboxDismissed` treats a dismissal). A
 * person's own message reopens only their record, at the send route.
 */
function reopensSettledConversation(event: CanonicalRuntimeEvent): boolean {
  if (event.method === 'request.opened') return true;
  if (event.method === 'session.stop-settled') return true;
  return (
    (event.method === 'turn.aborted' || event.method === 'runtime.error') &&
    resolveTurnCompletionOutcome(event) === 'failed'
  );
}

/**
 * Clears every person's settled record for a conversation when it needs
 * someone again (`reopensSettledConversation`). Runs whether or not the
 * Open and Settled preview is on, so turning it on later never shows a
 * conversation as settled past a failure or a question.
 */
export function wireConversationResolutionReopen(
  eventBus: Pick<EventBus, 'subscribe'>,
  deps: {
    store: Pick<ConversationWorkStateStore, 'reopen'>;
    /** The conversation a thread belongs to, or `undefined` without lineage. */
    conversationIdOf(threadId: string): string | undefined;
    logger: { warn(message: string, meta?: Record<string, unknown>): void };
  },
): () => void {
  return eventBus.subscribe((message) => {
    if (message.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
    const event = message.data?.event as CanonicalRuntimeEvent | undefined;
    if (!event || typeof event.threadId !== 'string') return;
    if (!reopensSettledConversation(event)) return;
    try {
      const conversationId = deps.conversationIdOf(event.threadId);
      deps.store.reopen(
        conversationId && conversationId !== event.threadId
          ? [conversationId, event.threadId]
          : [event.threadId],
      );
    } catch (error) {
      deps.logger.warn('Could not reopen a settled conversation', {
        threadId: event.threadId,
        method: event.method,
        error: errorMessage(error),
      });
    }
  });
}

/**
 * The send routes' reopen: clears only the sending person's settled record
 * for the conversation a send names (a thread id or its conversation id).
 * A send by no person (`personFor` answers nothing) reopens nothing. A
 * failure here never fails the send; the inbox shelf only lags.
 */
export function createSenderReopen<Request>(deps: {
  store: Pick<ConversationWorkStateStore, 'reopen'>;
  /** The person's record key (`conversationAcknowledgementKey`), if any. */
  personFor(request: Request): string | undefined;
  conversationIdOf(id: string): string | undefined;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}): (request: Request, id: string) => void {
  return (request, id) => {
    try {
      const person = deps.personFor(request);
      if (!person) return;
      const conversationId = deps.conversationIdOf(id);
      deps.store.reopen(
        conversationId && conversationId !== id ? [conversationId, id] : [id],
        person,
      );
    } catch (error) {
      deps.logger.warn('Could not reopen a settled conversation', {
        conversationId: id,
        error: errorMessage(error),
      });
    }
  };
}
