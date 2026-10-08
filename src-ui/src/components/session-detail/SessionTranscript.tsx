import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import {
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { conversationPartToContentParts } from '../../hooks/orchestration/conversationTranscriptParts';
import { useSessionTranscriptEvents } from '../../hooks/orchestration/useSessionTranscriptEvents';
import { Button } from '../Button';
import { MessageContent } from '../chat/message-bubble/MessageContent';
import {
  TranscriptMarker,
  transcriptMarkerLabel,
} from '../chat/TranscriptMarker';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import { useSessionTranscriptScroll } from './useSessionTranscriptScroll';

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
  failureShownAbove = false,
  notices,
  onSettledChange,
  scrollContainerRef,
  preserveReading = false,
}: {
  apiBase: string;
  session: Pick<OrchestrationSessionSummary, 'threadId' | 'conversationId'>;
  /** What the assistant rows are labelled with ("Code Reviewer", "Codex"). */
  agentLabel: string;
  /** A turn is in flight: the last assistant row is still being written. */
  isStreaming: boolean;
  /**
   * The detail shows this session's terminal failure in its own card just
   * above. The last message's runtime-error part is that same failure, so it
   * is left out rather than said twice; failures of earlier turns stay in
   * the record.
   */
  failureShownAbove?: boolean;
  /** History notices owned by the caller (upgrade, retry, elision). */
  notices?: ReactNode;
  /** Whether the first window read has landed; content above may grow then. */
  onSettledChange?: (settled: boolean) => void;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  preserveReading?: boolean;
}) {
  const {
    events,
    hasMore,
    loadOlder,
    settled,
    error,
    upgradeRequired,
    retry,
    loading,
  } = useSessionTranscriptEvents(apiBase, session, isStreaming);
  const contentRef = useRef<HTMLElement | null>(null);
  const noScrollRef = useRef<HTMLDivElement | null>(null);
  const { atLatest, jumpToLatest, pauseFollowing } = useSessionTranscriptScroll(
    {
      identity: `${apiBase}\0${session.threadId}`,
      scrollRef: scrollContainerRef ?? noScrollRef,
      contentRef,
      ready: settled && !error && !upgradeRequired,
      contentVersion: events,
      preserveReading:
        preserveReading ||
        (events.length > 0 && Boolean(error || upgradeRequired)),
    },
  );
  useEffect(() => {
    if (error && scrollContainerRef?.current)
      scrollContainerRef.current.scrollTop = 0;
  }, [error, scrollContainerRef]);
  useEffect(() => {
    onSettledChange?.(settled);
  }, [onSettledChange, settled]);
  const rows = useMemo(() => {
    const projected = projectRuntimeEventsToMessages(events, {
      stableIds: true,
    }).map((message) => ({
      id: message.id,
      role: message.role,
      contentParts: message.parts.flatMap(conversationPartToContentParts),
    }));
    if (!failureShownAbove) return projected;
    const last = projected.at(-1);
    if (!last || last.role !== 'assistant') return projected;
    const kept = last.contentParts.filter((part) => !part.runtimeError);
    if (kept.length === last.contentParts.length) return projected;
    return kept.length === 0
      ? projected.slice(0, -1)
      : [...projected.slice(0, -1), { ...last, contentParts: kept }];
  }, [events, failureShownAbove]);
  const lastIndex = rows.length - 1;
  const lastIsAssistant = rows[lastIndex]?.role === 'assistant';

  return (
    <section
      className="session-transcript"
      aria-label="Conversation"
      data-testid="session-transcript"
      ref={contentRef}
    >
      {!atLatest && (
        <div className="session-transcript__toolbar responsive-surface-actions">
          <Button variant="secondary" onClick={jumpToLatest}>
            Jump to latest
          </Button>
        </div>
      )}
      {error && (
        <ErrorState
          variant="compact"
          title={
            upgradeRequired
              ? 'Update Station to read this conversation'
              : 'Conversation could not be loaded'
          }
          description={error.message}
          action={
            <Button
              variant="secondary"
              disabled={loading}
              onClick={() => void retry()}
            >
              Retry
            </Button>
          }
        />
      )}
      {(hasMore || notices) && (
        <div className="session-history-controls responsive-surface-actions">
          {hasMore && (
            <Button
              variant="secondary"
              className="session-history-controls__more"
              onClick={() => {
                pauseFollowing();
                void loadOlder();
              }}
            >
              Show older messages
            </Button>
          )}
          {notices}
        </div>
      )}
      {rows.length === 0 ? (
        error ? null : !settled ? (
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
          const marker = transcriptMarkerLabel(message.contentParts);
          if (marker)
            return <TranscriptMarker key={message.id} label={marker} />;
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
