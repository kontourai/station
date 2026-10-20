import type { ConversationTurnActivity } from '@kontourai/station-contracts/orchestration';
import { memo, useEffect, useMemo, useState } from 'react';
import type {
  ChatActivityHint,
  ChatContentPart,
} from '../../contexts/active-chats-state';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useStreamingContent } from '../../hooks/useStreamingContent';
import { useStreamingHaptics } from '../../hooks/useStreamingHaptics';
import { retryActivityLabel } from '../../utils/chat-activity';
import { deriveToolProgressSummary } from '../../utils/chat-progress';
import { openTurnStartedAtMs } from '../../utils/conversation-activity';
import type { OwnerAttribution } from '../../utils/ownerAttribution';
import { ElapsedWait } from '../ElapsedWait';
import { LoadingDots } from '../LoadingDots';
import { FilePartPreview } from './FilePartPreview';
import { InputRequestRecordRow } from './InputRequestRecordRow';
import { MessageAttribution } from './message-bubble/MessageAttribution';
import { INLINE_RUN_LIMIT } from './message-bubble/MessageContent';
import { blockHasVisibleContent } from './message-bubble/visibleContent';
import { PublishedHtmlReply } from './PublishedHtmlReply';
import { StreamingMarkdown } from './StreamingMarkdown';
import {
  SubagentCardsForCalls,
  SubagentTranscriptCard,
} from './SubagentTranscriptCard';
import {
  ToolCallBatchBoundary,
  usePreloadToolCallBatch,
} from './ToolCallBatchBoundary';
import { TranscriptAppTools } from './TranscriptAppTools';
import { TurnActivityProgress } from './TurnActivityProgress';
import { isToolCallPart, splitToolCallRuns } from './tool-call-runs';
import { useTranscriptChildBlocks } from './transcript-child-work';
import { UIBlockRenderer } from './UIBlockRenderer';
import { uiBlockIdentity } from './ui-block-identity';

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
   * #2309: the conversation's server activity record. When present, the
   * working count is the open turn's duration by the SERVER's start (on this
   * client's clock, so skew shows up in it), and the row below shows what the
   * turn is doing. With a record but no open turn yet (this composer's send,
   * before the server opens it) the row states no duration at all.
   */
  conversationActivity?: ConversationTurnActivity;
  /**
   * #2304: the open turn's start as this client last witnessed it
   * (`ChatUIState.openTurnStartedAt`), used ONLY when there is no activity
   * record (an older server). Unknown there too, and the row states no
   * duration at all: it never guesses from its own mount.
   */
  turnStartedAt?: number;
  suppressActivity?: boolean;
  /** #2309: see `ChatMessageList`'s `progressSilenceShownElsewhere`. */
  hideProgressSilence?: boolean;
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
  if (activityHint?.kind === 'retrying')
    return retryActivityLabel(activityHint);
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
function StreamingMessageWithApps({
  sessionId,
  agentIcon,
  agentIconStyle,
  fontSize,
  showReasoning = true,
  renderToolCall,
  renderReasoning,
  activityHint,
  elapsedMs,
  conversationActivity,
  turnStartedAt,
  suppressActivity,
  hideProgressSilence,
  statusLabel,
  attributionAgent,
  owner,
  onContentChange,
  streamingText,
  contentParts,
  contentRevision,
  appTools,
}: StreamingMessageProps & {
  streamingText: string;
  hasContent: boolean;
  contentParts: ChatContentPart[];
  contentRevision: number;
  appTools: ReadonlySet<string>;
}) {
  const isMobile = useIsMobile();
  // The status-labelled wait's clock: this row's mount, exactly as before
  // #2304. It is not the wait's own start — nothing resets it when the status
  // arrives — a pre-existing limitation, deliberately left alone.
  const [mountedAt] = useState(Date.now);
  // ONE working clock (#2309 over #2304): the server record's open-turn start
  // when a record exists, the witnessed `turn.started` start only on a server
  // without one. When neither is known — before the server opens the turn, a
  // remount before a seed, a reconnect catch-up awaiting its refetch — the row
  // states no duration rather than guess one.
  const workingStartedAt = conversationActivity
    ? openTurnStartedAtMs(conversationActivity)
    : turnStartedAt;
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
  const workingLabel =
    activityHint?.kind === 'retrying'
      ? activityLabel
      : progressSummary && !renderToolCall
        ? progressSummary.label
        : activityLabel;
  // Consecutive tool-call parts collapse into one batch while the turn is
  // still streaming too — classification (inside the lazy ToolCallBatch
  // chunk) marks a batch in-progress (latest-call headline) whenever one
  // of its calls is still `running`, so the collapsed summary never
  // claims a batch is done before it is.
  const baseBlocks = useMemo(
    () =>
      splitToolCallRuns(
        streamingText
          ? [...contentParts, { type: 'text', content: streamingText }]
          : contentParts,
        appTools,
      ),
    [contentParts, streamingText, appTools],
  );
  const blocks = useTranscriptChildBlocks(baseBlocks);
  usePreloadToolCallBatch(
    blocks.some((block) => block.type === 'tool-call-run'),
  );
  useEffect(() => {
    // The numeric revision is intentionally read here: it is the O(1)
    // dependency that replaces rebuilding the complete transcript string.
    void contentRevision;
    onContentChange?.();
  }, [contentRevision, onContentChange]);

  // Same rule as the settled row (`visibleContent.ts`). When the host shows
  // the turn's status elsewhere (the composer pill), a row with no content
  // yet would be a header over an empty card: draw nothing until the first
  // text, reasoning or tool row arrives, then the bubble eases in.
  const hasVisibleContent = blocks.some((block) =>
    block.type === 'tool-call-run' ||
    (block.type === 'content-part' && isToolCallPart(block.part))
      ? Boolean(renderToolCall)
      : blockHasVisibleContent(block, {
          showReasoning: showReasoning && Boolean(renderReasoning),
        }),
  );
  if (suppressActivity && !hasVisibleContent) return null;

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
          if (block.type === 'html-reply')
            return (
              <PublishedHtmlReply key={block.key} reference={block.reference} />
            );
          if (block.type === 'subagent')
            return (
              <SubagentTranscriptCard key={block.key} child={block.child} />
            );
          if (block.type === 'tool-call-run') {
            if (!renderToolCall) return null;
            // Same inline threshold as the settled renderer
            // (`MessageContent`'s INLINE_RUN_LIMIT) so a run does not
            // change shape when the turn settles. Solo calls stay a
            // row; 2+ consecutive calls become one updating line.
            // Same subagent cards, in the same place, as the settled row.
            const subagents = (
              <SubagentCardsForCalls
                key={`subagents:${block.key}`}
                calls={block.calls}
              />
            );
            if (block.calls.length <= INLINE_RUN_LIMIT) {
              return [
                ...block.calls.map(({ part, index }) =>
                  renderToolCall(part, index),
                ),
                subagents,
              ];
            }
            const inlineRows = block.calls.map(({ part, index }) =>
              renderToolCall(part, index),
            );
            return [
              <ToolCallBatchBoundary
                key={block.key}
                run={block}
                renderCall={renderToolCall}
                pending={inlineRows}
              />,
              subagents,
            ];
          }

          const { index: i, part } = block;
          if (isToolCallPart(part)) return renderToolCall?.(part, i) ?? null;
          if (
            part.type === 'reasoning' &&
            part.content &&
            showReasoning &&
            renderReasoning
          ) {
            return renderReasoning(part.content, i, hasAnswerText);
          }
          if (part.type === 'text' && part.content) {
            const current = i === contentParts.length;
            return (
              <div
                className={current ? 'streaming-tip' : undefined}
                key={block.key ?? i}
              >
                <StreamingMarkdown content={part.content} />
                {current && block === blocks.at(-1) && (
                  <div className="stream-caret-line" aria-hidden="true">
                    <span className="stream-caret" />
                  </div>
                )}
              </div>
            );
          }
          if (part.type === 'ui-block' && part.uiBlock) {
            const identity = uiBlockIdentity(contentParts, i, sessionId);
            return (
              <UIBlockRenderer
                key={identity}
                instanceKey={identity}
                block={part.uiBlock}
              />
            );
          }
          if (part.type === 'input-request' && part.inputRequestRecord) {
            return (
              <InputRequestRecordRow key={i} record={part.inputRequestRecord} />
            );
          }
          if (part.type === 'file') {
            // An image a tool returned mid-turn (a screenshot the agent took)
            // shows as it arrives, not only once the turn settles.
            return (
              <FilePartPreview key={i} part={part} allParts={contentParts} />
            );
          }
          return null;
        })}

        {!suppressActivity &&
          (activityHint?.kind === 'retrying' ||
            statusLabel ||
            workingStartedAt !== undefined ||
            elapsedMs !== undefined ||
            (!hasAnswerText && !(progressSummary && renderToolCall))) && (
            <div
              className="streaming-activity"
              role="status"
              title={progressSummary?.toolName}
            >
              {!statusLabel && <LoadingDots />}
              {activityHint?.kind === 'retrying' ? (
                <span className="elapsed-wait">{activityLabel}</span>
              ) : statusLabel ||
                elapsedMs !== undefined ||
                workingStartedAt !== undefined ? (
                <ElapsedWait
                  // The clock is the TURN's (server open-turn start), so the
                  // timed label names the turn, never the current phase:
                  // "Thinking for 6:59" claimed seven minutes of thinking
                  // across a turn that spent them running a command. What
                  // the turn is doing now is the progress row's to say.
                  label={statusLabel ?? 'Working for'}
                  separator={statusLabel ? ' · ' : ' '}
                  startedAt={statusLabel ? mountedAt : workingStartedAt}
                  elapsedMs={elapsedMs}
                />
              ) : (
                <span className="elapsed-wait" aria-live="off">
                  {workingLabel}
                </span>
              )}
            </div>
          )}
        {!suppressActivity && (
          <TurnActivityProgress
            activity={conversationActivity}
            showSilence={!hideProgressSilence}
          />
        )}
      </div>
    </div>
  );
}

export function StreamingMessageView(
  props: Omit<Parameters<typeof StreamingMessageWithApps>[0], 'appTools'>,
) {
  return (
    <TranscriptAppTools calls={props.contentParts}>
      {(appTools) => (
        <StreamingMessageWithApps {...props} appTools={appTools} />
      )}
    </TranscriptAppTools>
  );
}

function StreamingMessageComponent(props: StreamingMessageProps) {
  const state = useStreamingContent(props.sessionId);
  return <StreamingMessageView {...props} {...state} />;
}

export const StreamingMessage = memo(StreamingMessageComponent);
