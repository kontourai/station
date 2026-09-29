import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { type ReactNode, useMemo } from 'react';
import type { OrchestrationEvent } from '../../hooks/orchestration/types';
import type { ChatMessage } from '../../types';
import { MessageContent } from '../chat/message-bubble/MessageContent';
import { Empty } from '../state';

/**
 * Only durable events carry an `eventId`; the projection is defined over
 * canonical events and keys its output on them. Same filter the read-only
 * attached transcript applies.
 */
function hasCanonicalEventId(
  event: OrchestrationEvent,
): event is CanonicalRuntimeEvent {
  return typeof event.eventId === 'string' && event.eventId.length > 0;
}

/**
 * The read-only conversation of a Station-owned session: the user's prompts,
 * the agent's answers and its tool calls, projected from the session's own
 * event feed by the ONE projection every chat surface uses
 * (`projectRuntimeEventsToMessages`). An open turn is emitted as it stands,
 * so a running session shows its answer as it streams instead of nothing
 * until `turn.completed`.
 *
 * This is a record, not a chat: it renders no per-message actions. Replying
 * happens in the detail's composer or, for the full conversation, in chat.
 */
export function SessionTranscript({
  events,
  agentLabel,
  isStreaming,
  controls,
}: {
  events: OrchestrationEvent[];
  /** What the assistant rows are labelled with ("Code Reviewer", "Codex"). */
  agentLabel: string;
  /** A turn is in flight: the last assistant row is still being written. */
  isStreaming: boolean;
  /** Bounded-history controls ("Show older messages", elision notice). */
  controls?: ReactNode;
}) {
  const messages = useMemo(
    () => projectRuntimeEventsToMessages(events.filter(hasCanonicalEventId)),
    [events],
  );
  const lastIndex = messages.length - 1;
  const lastIsAssistant = messages[lastIndex]?.role === 'assistant';

  return (
    <section
      className="session-transcript"
      aria-label="Conversation"
      data-testid="session-transcript"
    >
      {controls}
      {messages.length === 0 ? (
        <Empty
          label={
            isStreaming
              ? 'Waiting for the first message…'
              : 'No messages in this session yet.'
          }
        />
      ) : (
        messages.map((message, index) => {
          const contentParts = message.parts.map((part) => ({
            type: part.type,
            content: part.text,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
            result: part.result,
            state: part.state,
            isError: part.isError,
          }));
          const streaming =
            isStreaming && index === lastIndex && message.role === 'assistant';
          return (
            <article
              key={message.id}
              className={`session-transcript__message session-transcript__message--${message.role}`}
              data-testid="session-transcript-message"
              data-role={message.role}
              aria-busy={streaming || undefined}
            >
              <p className="session-transcript__role">
                {message.role === 'user' ? 'You' : agentLabel}
              </p>
              <MessageContent
                contentParts={contentParts as ChatMessage['contentParts']}
                textContent=""
                chatFontSize={14}
                showReasoning={false}
                showToolDetails
                isStreamingMessage={streaming}
              />
            </article>
          );
        })
      )}
      {isStreaming && !lastIsAssistant && messages.length > 0 && (
        <p className="session-transcript__working" role="status">
          {agentLabel} is working…
        </p>
      )}
    </section>
  );
}
