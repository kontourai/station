import { memo, useEffect, useMemo, useState } from 'react';
import type {
  ChatActivityHint,
  ChatContentPart,
} from '../../contexts/active-chats-state';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useStreamingContent } from '../../hooks/useStreamingContent';
import { useStreamingHaptics } from '../../hooks/useStreamingHaptics';
import { deriveToolProgressSummary } from '../../utils/chat-progress';
import type { OwnerAttribution } from '../../utils/ownerAttribution';
import { ElapsedWait } from '../ElapsedWait';
import { LoadingDots } from '../LoadingDots';
import { MessageAttribution } from './message-bubble/MessageAttribution';
import { INLINE_RUN_LIMIT } from './message-bubble/MessageContent';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ToolCallBatchBoundary } from './ToolCallBatchBoundary';
import { splitToolCallRuns } from './tool-call-runs';
import { UIBlockRenderer } from './UIBlockRenderer';

export type StreamingMessageProps = {
  sessionId: string;
  agentIcon: React.ReactNode;
  agentIconStyle: React.CSSProperties;
  fontSize: number;
  showReasoning?: boolean;
  renderToolCall?: (
    part: ChatContentPart,
    index: number,
    expanded?: boolean,
  ) => React.ReactNode;
  renderReasoning?: (
    content: string,
    index: number,
    hasAnswerText: boolean,
  ) => React.ReactNode;
  /** Transient provider activity signal (thinking/compacting/…). */
  activityHint?: ChatActivityHint;
  elapsedMs?: number;
  /**
   * #2304: when the open turn started, from the server's `turn.started`
   * (`ChatUIState.openTurnStartedAt`). The working count reads from the
   * EARLIER of the last start the row saw and its own clock (its mount,
   * reset when a different start replaces that one; a clear keeps the last
   * start): a row remounted mid-turn reads the turn's real
   * duration, while the sender's row — mounted at send, before the server's
   * start — keeps counting without jumping back when `turn.started` lands.
   * Until a start arrives, the row counts from its own clock. The
   * server start is compared against this client's clock, so skew between
   * the two shows up in the count.
   */
  turnStartedAt?: number;
  suppressActivity?: boolean;
  statusLabel?: string;
  /**
   * Row attribution (archive#1424 fix): shown from the FIRST
   * frame of streaming, not just after the turn settles into a persisted
   * `MessageBubble` row — resolved from the current live agent binding,
   * which is the honest source while this turn is actually executing. No
   * `engine` prop here — see the doc comment on
   * `ChatMessageList`'s `streamingAttributionAgent` for why the engine chip
   * is suppressed on this row too, not just the persisted one.
   */
  attributionAgent?: { name: string } | null;
  owner?: OwnerAttribution | null;
  /** Lets the owning scroll surface follow streaming text-height growth. */
  onContentChange?: () => void;
};

/**
 * Human label for the pre-content phase, richest-signal-first: an explicit
 * provider hint beats the generic fallback. Exported for unit tests.
 */
export function deriveActivityLabel(
  activityHint: ChatActivityHint | undefined,
  hasReasoningPart: boolean,
): string {
  if (activityHint?.kind === 'thinking') {
    return activityHint.detail
      ? `Thinking… ${activityHint.detail}`
      : 'Thinking…';
  }
  if (activityHint?.kind === 'compacting') return 'Compacting context…';
  if (activityHint?.kind === 'requesting') return 'Preparing…';
  return hasReasoningPart ? 'Thinking…' : 'Working…';
}

/**
 * Renders a streaming assistant message with loading indicator.
 */
export function StreamingMessageView({
  sessionId,
  agentIcon,
  agentIconStyle,
  fontSize,
  showReasoning = true,
  renderToolCall,
  renderReasoning,
  activityHint,
  elapsedMs,
  turnStartedAt,
  suppressActivity,
  statusLabel,
  attributionAgent,
  owner,
  onContentChange,
  streamingText,
  contentParts,
  contentRevision,
}: StreamingMessageProps & {
  streamingText: string;
  hasContent: boolean;
  contentParts: ChatContentPart[];
  contentRevision: number;
}) {
  const isMobile = useIsMobile();
  // The row's own clock (#2304): `since` is when it mounted, reset only when
  // a DIFFERENT turn start replaces the last one it saw. The row can stay
  // mounted across turns (a reconnect catch-up reseeds the turn fold open
  // without closing it; a new turn's `turn.started` can land while the
  // previous turn's row is still up), so its mount alone is not "since this
  // turn". What is NOT a boundary:
  // - a clear (defined → undefined). A catch-up clears the stamp on every
  //   open-turn reconnect, usually with the SAME turn still running, so the
  //   row keeps its last start (`lastStamp`) and keeps counting from it
  //   until the refetched page says otherwise;
  // - that same start coming back after a clear;
  // - the FIRST start (none seen → defined): the sender's `turn.started`
  //   landing after send, for the turn this row already represents.
  // Adjusted during render, React's pattern for state derived from a prop.
  const [rowClock, setRowClock] = useState(() => ({
    prop: turnStartedAt,
    lastStamp: turnStartedAt,
    since: Date.now(),
  }));
  if (rowClock.prop !== turnStartedAt) {
    const replaced =
      turnStartedAt !== undefined &&
      rowClock.lastStamp !== undefined &&
      turnStartedAt !== rowClock.lastStamp;
    setRowClock({
      prop: turnStartedAt,
      lastStamp: turnStartedAt ?? rowClock.lastStamp,
      since: replaced ? Date.now() : rowClock.since,
    });
  }
  const waitingSince = rowClock.since;
  const lastTurnStartedAt = rowClock.lastStamp;
  useStreamingHaptics(sessionId, streamingText.length);
  const progressSummary = deriveToolProgressSummary(contentParts);
  const hasReasoningPart = contentParts.some(
    (part) => part.type === 'reasoning' && Boolean(part.content),
  );
  // Both disjuncts trim: models routinely emit "\n\n" as the first delta
  // after a reasoning block, and an untrimmed check would call that an answer
  // — collapsing the reasoning while the answer area is still visually empty.
  const hasAnswerText =
    Boolean(streamingText.trim()) ||
    contentParts.some(
      (part) => part.type === 'text' && Boolean(part.content?.trim()),
    );
  const activityLabel = deriveActivityLabel(activityHint, hasReasoningPart);
  // Consecutive tool-call parts collapse into one batch while the turn is
  // still streaming too — classification (inside the lazy ToolCallBatch
  // chunk) marks a batch in-progress (latest-call headline) whenever one
  // of its calls is still `running`, so the collapsed summary never
  // claims a batch is done before it is.
  const blocks = useMemo(() => splitToolCallRuns(contentParts), [contentParts]);
  useEffect(() => {
    // The numeric revision is intentionally read here: it is the O(1)
    // dependency that replaces rebuilding the complete transcript string.
    void contentRevision;
    onContentChange?.();
  }, [contentRevision, onContentChange]);

  return (
    <div
      className={`streaming-message${isMobile ? ' message-row--compact' : ''}`}
    >
      {!isMobile && (
        <div className="streaming-message-icon" style={agentIconStyle}>
          {agentIcon}
        </div>
      )}
      <div className="message assistant" style={{ fontSize: `${fontSize}px` }}>
        {!isMobile && (
          <MessageAttribution
            agent={attributionAgent ?? null}
            engine={null}
            owner={owner}
          />
        )}

        {/* Render completed content parts in order */}
        {blocks.map((block) => {
          if (block.type === 'tool-call-run') {
            if (!renderToolCall) return null;
            // Same inline threshold as the settled renderer
            // (`MessageContent`'s INLINE_RUN_LIMIT) so a run does not
            // change shape when the turn settles. Solo calls stay a
            // row; 2+ consecutive calls become one updating line.
            if (block.calls.length <= INLINE_RUN_LIMIT) {
              return block.calls.map(({ part, index }) =>
                renderToolCall(part, index),
              );
            }
            const inlineRows = block.calls.map(({ part, index }) =>
              renderToolCall(part, index),
            );
            return (
              <ToolCallBatchBoundary
                key={block.key}
                run={block}
                renderCall={renderToolCall}
                pending={inlineRows}
              />
            );
          }

          const { index: i, part } = block;
          if (
            part.type === 'reasoning' &&
            part.content &&
            showReasoning &&
            renderReasoning
          ) {
            return renderReasoning(part.content, i, hasAnswerText);
          }
          if (part.type === 'text' && part.content) {
            return <StreamingMarkdown key={i} content={part.content} />;
          }
          if (part.type === 'ui-block' && part.uiBlock) {
            return <UIBlockRenderer key={i} block={part.uiBlock} />;
          }
          return null;
        })}

        {/* Current streaming text — rendered as markdown with throttled
            updates. The wrapper carries the trailing shimmer (transform-only
            overlay) and a fixed-box blinking caret at the tip; both animate
            on a CSS clock independent of the token buffer, so a token pause
            never reads as frozen (station#2651). */}
        {streamingText && (
          <div className="streaming-tip">
            {/* archive#3354: an unclosed trailing fence renders plain and is
                never tokenized until it closes. */}
            <StreamingMarkdown content={streamingText} />
            {/* Terminal-style cursor on its own compact line — placement is
                identical during the Suspense fallback and after the markdown
                chunk loads (see .stream-caret-line in index.css). */}
            <div className="stream-caret-line" aria-hidden="true">
              <span className="stream-caret" />
            </div>
          </div>
        )}

        {!suppressActivity &&
          (statusLabel ||
            (!hasAnswerText && !(progressSummary && renderToolCall))) && (
            <div
              className="streaming-activity"
              role="status"
              title={progressSummary?.toolName}
            >
              {!statusLabel && <LoadingDots />}
              <ElapsedWait
                label={
                  statusLabel ??
                  `${(progressSummary && !renderToolCall ? progressSummary.label : activityLabel).replace(/[.\u2026]+$/u, '')} for`
                }
                separator={statusLabel ? ' · ' : ' '}
                // A status-labelled wait ("Waiting for approval") counts from
                // the row's own clock: its mount, as before #2304, reset only
                // when a different turn start replaces the last one. That is
                // not the wait's own start: nothing resets the clock when the
                // status arrives — a pre-existing limitation, deliberately
                // left alone here.
                startedAt={
                  statusLabel || lastTurnStartedAt === undefined
                    ? waitingSince
                    : Math.min(lastTurnStartedAt, waitingSince)
                }
                elapsedMs={elapsedMs}
              />
            </div>
          )}
      </div>
    </div>
  );
}

function StreamingMessageComponent(props: StreamingMessageProps) {
  const state = useStreamingContent(props.sessionId);
  return <StreamingMessageView {...props} {...state} />;
}

export const StreamingMessage = memo(StreamingMessageComponent);
