import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { memo, type ReactNode, useEffect, useMemo } from 'react';
import { conversationPartToContentParts } from '../../hooks/orchestration/conversationTranscriptParts';
import { useSessionTranscriptEvents } from '../../hooks/orchestration/useSessionTranscriptEvents';
import { Button } from '../Button';
import { MessageContent } from '../chat/message-bubble/MessageContent';
import { Empty, SkeletonBlock } from '../state';

/**
 * The read-only conversation of a Station-owned session: the user's prompts,
 * the agent's answers and its tool calls, projected by the ONE projection
 * every chat surface uses (`projectRuntimeEventsToMessages`) over the chat
 * dock's own event source (`useSessionTranscriptEvents`), and mapped to
 * renderer parts by chat's own mapping (`conversationPartToContentParts`).
 * An open turn is emitted as it stands, so a running session shows its answer
 * as it streams.
 *
 * This is a record, not a chat: it renders no per-message actions. Replying
 * happens in the detail's composer or, for the full conversation, in chat.
 *
 * Memoised: the detail re-renders on every composer keystroke, and nothing
 * here depends on the draft.
 */
export const SessionTranscript = memo(function SessionTranscript({
  apiBase,
  session,
  agentLabel,
  isStreaming,
  notices,
  onSettledChange,
}: {
  apiBase: string;
  session: Pick<OrchestrationSessionSummary, 'threadId' | 'conversationId'>;
  /** What the assistant rows are labelled with ("Code Reviewer", "Codex"). */
  agentLabel: string;
  /** A turn is in flight: the last assistant row is still being written. */
  isStreaming: boolean;
  /** History notices owned by the caller (upgrade, retry, elision). */
  notices?: ReactNode;
  /** Whether the first window read has landed; content above may grow then. */
  onSettledChange?: (settled: boolean) => void;
}) {
  const { events, hasMore, loadOlder, settled } = useSessionTranscriptEvents(
    apiBase,
    session,
    isStreaming,
  );
  useEffect(() => {
    onSettledChange?.(settled);
  }, [onSettledChange, settled]);
  const rows = useMemo(
    () =>
      projectRuntimeEventsToMessages(events, { stableIds: true }).map(
        (message) => ({
          id: message.id,
          role: message.role,
          contentParts: message.parts.flatMap(conversationPartToContentParts),
        }),
      ),
    [events],
  );
  const lastIndex = rows.length - 1;
  const lastIsAssistant = rows[lastIndex]?.role === 'assistant';

  return (
    <section
      className="session-transcript"
      aria-label="Conversation"
      data-testid="session-transcript"
    >
      {(hasMore || notices) && (
        <div className="session-history-controls">
          {hasMore && (
            <Button
              variant="secondary"
              className="session-history-controls__more"
              onClick={() => void loadOlder()}
            >
              Show older messages
            </Button>
          )}
          {notices}
        </div>
      )}
      {rows.length === 0 ? (
        !settled ? (
          <SkeletonBlock label="Reading the conversation" count={2} />
        ) : (
          <Empty
            label={
              isStreaming
                ? 'Waiting for the first message…'
                : 'No messages in this session yet.'
            }
          />
        )
      ) : (
        rows.map((message, index) => {
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
                contentParts={message.contentParts}
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
      {isStreaming && !lastIsAssistant && rows.length > 0 && (
        <p className="session-transcript__working" role="status">
          {agentLabel} is working…
        </p>
      )}
    </section>
  );
});
