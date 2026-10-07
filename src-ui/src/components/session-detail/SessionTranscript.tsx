import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import {
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { conversationPartToContentParts } from '../../hooks/orchestration/conversationTranscriptParts';
import { useSessionTranscriptEvents } from '../../hooks/orchestration/useSessionTranscriptEvents';
import { useActivityWorkspacePaneBinding } from '../../views/activity/ActivityWorkspacePaneBinding';
import { Button } from '../Button';
import { agentAccentStyle } from '../chat/agent-message/agentSenderAccent';
import {
  IncomingAgentCause,
  IncomingAgentHeader,
  incomingMessageLabel,
} from '../chat/agent-message/IncomingAgentHeader';
import { describeStationControlCall } from '../chat/agent-message/station-control-calls';
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
      // #3419: another agent's message is shown as that agent's.
      sender: message.metadata?.sender,
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
  const activityBinding = useActivityWorkspacePaneBinding();
  const anchor = useMemo(
    () =>
      activityBinding?.sessionId &&
      activityBinding.messageAnchor &&
      (activityBinding.sessionId === session.threadId ||
        activityBinding.sessionId === session.conversationId)
        ? {
            ...activityBinding.messageAnchor,
            sessionId: activityBinding.sessionId,
          }
        : undefined,
    [
      activityBinding?.sessionId,
      activityBinding?.messageAnchor,
      session.threadId,
      session.conversationId,
    ],
  );
  const anchoredRows = anchor
    ? rows.flatMap((row) =>
        anchor.direction === 'received'
          ? row.role === 'user' && row.sender?.requestKey === anchor.requestKey
            ? [row]
            : []
          : row.contentParts
              .filter(
                (part) =>
                  describeStationControlCall(part)?.requestKey ===
                  anchor.requestKey,
              )
              .map(() => row),
      )
    : [];
  const anchorKey = anchor
    ? JSON.stringify([
        anchor.sessionId,
        anchor.direction,
        anchor.requestKey,
        activityBinding?.intentToken,
      ])
    : undefined;
  const anchorReads = useRef<{ key?: string; pages: number }>({ pages: 0 });
  const [anchorLimit, setAnchorLimit] = useState(false);
  const announcedAnchor = useRef<string | undefined>(undefined);
  const anchorId = anchoredRows.length === 1 ? anchoredRows[0]?.id : undefined;
  useEffect(() => {
    if (anchorReads.current.key !== anchorKey) {
      anchorReads.current = { key: anchorKey, pages: 0 };
      announcedAnchor.current = undefined;
      setAnchorLimit(false);
    }
    if (!anchor || loading || !settled || error || upgradeRequired) return;
    if (announcedAnchor.current === anchorKey) return;
    pauseFollowing();
    if (hasMore) {
      if (anchorReads.current.pages >= 20) {
        setAnchorLimit(true);
        return;
      }
      anchorReads.current.pages += 1;
      void loadOlder();
      return;
    }
    if (anchorId) {
      const row = [
        ...(contentRef.current?.querySelectorAll<HTMLElement>(
          '[data-transcript-message-id]',
        ) ?? []),
      ].find((node) => node.dataset.transcriptMessageId === anchorId);
      const target =
        anchor.direction === 'sent'
          ? ([
              ...(row?.querySelectorAll<HTMLElement>(
                '[data-station-send-request]',
              ) ?? []),
            ].find(
              (node) => node.dataset.stationSendRequest === anchor.requestKey,
            ) ?? row)
          : row;
      if (anchor.direction === 'received') {
        const details = target?.querySelector<HTMLDetailsElement>(
          'details.agent-cause-disclosure',
        );
        if (details) details.open = true;
      }
      target?.scrollIntoView?.({ block: 'center' });
      if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
        announcedAnchor.current = anchorKey;
      }
    }
  }, [
    anchor,
    anchorKey,
    anchorId,
    loading,
    settled,
    error,
    upgradeRequired,
    hasMore,
    loadOlder,
    pauseFollowing,
  ]);
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
              className={`session-transcript__message session-transcript__message--${message.role}${message.sender ? ' agent-incoming' : ''}`}
              data-testid="session-transcript-message"
              data-transcript-message-id={message.id}
              tabIndex={message.id === anchorId ? -1 : undefined}
              data-role={message.role}
              data-agent-sender-session={message.sender?.sessionId}
              aria-label={
                message.sender
                  ? incomingMessageLabel(message.sender)
                  : undefined
              }
              style={
                message.sender ? agentAccentStyle(message.sender) : undefined
              }
              aria-busy={streaming || undefined}
            >
              {message.sender ? (
                <>
                  <div className="agent-incoming__desktop">
                    <IncomingAgentHeader sender={message.sender} />
                  </div>
                  <div className="agent-incoming__mobile">
                    <IncomingAgentCause sender={message.sender}>
                      {message.role === 'user' && (
                        <MessageContent
                          contentParts={message.contentParts}
                          textContent=""
                          chatFontSize={14}
                          showReasoning={false}
                          showToolDetails
                          isStreamingMessage={false}
                        />
                      )}
                    </IncomingAgentCause>
                  </div>
                </>
              ) : (
                <p className="session-transcript__role">
                  {message.role === 'user' ? 'You' : agentLabel}
                </p>
              )}
              <div
                className={
                  message.sender && message.role === 'user'
                    ? 'agent-incoming__desktop'
                    : undefined
                }
              >
                <MessageContent
                  contentParts={message.contentParts}
                  textContent=""
                  chatFontSize={14}
                  showReasoning={false}
                  showToolDetails
                  isStreamingMessage={streaming}
                />
              </div>
            </article>
          );
        })
      )}
      {anchorLimit && (
        <p role="status">
          Exact message lookup reached its 20-page limit. Load older messages to
          continue; no target has been selected.
        </p>
      )}
      {anchor && !hasMore && anchorId && (
        <p className="sr-only" role="status">
          Opened the exact{' '}
          {anchor.direction === 'sent' ? 'sending call' : 'received message'}.
        </p>
      )}
      {anchor &&
        settled &&
        !loading &&
        !error &&
        !upgradeRequired &&
        !hasMore &&
        !anchorId && (
          <p role="status">
            {anchoredRows.length > 1
              ? 'Message anchor is ambiguous: more than one recorded call or input has this request key.'
              : 'The exact message is not available in this conversation.'}
          </p>
        )}
      {isStreaming && !lastIsAssistant && rows.length > 0 && (
        <p className="session-transcript__working" role="status">
          {agentLabel} is working…
        </p>
      )}
    </section>
  );
});
