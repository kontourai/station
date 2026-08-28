import { memo, useEffect, useMemo } from 'react';
import type {
  ChatActivityHint,
  ChatContentPart,
} from '../../contexts/active-chats-state';
import { useStreamingContent } from '../../hooks/useStreamingContent';
import { useStreamingHaptics } from '../../hooks/useStreamingHaptics';
import { deriveToolProgressSummary } from '../../utils/chat-progress';
import type { OwnerAttribution } from '../../utils/ownerAttribution';
import { LoadingDots } from '../LoadingDots';
import { MessageAttribution } from './message-bubble/MessageAttribution';
import { INLINE_RUN_LIMIT } from './message-bubble/MessageContent';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ToolCallBatchBoundary } from './ToolCallBatchBoundary';
import { ToolProgressIndicator } from './ToolProgressIndicator';
import { splitToolCallRuns } from './tool-call-runs';
import { UIBlockRenderer } from './UIBlockRenderer';

type Props = {
  sessionId: string;
  agentIcon: React.ReactNode;
  agentIconStyle: React.CSSProperties;
  fontSize: number;
  showReasoning?: boolean;
  renderToolCall?: (part: ChatContentPart, index: number) => React.ReactNode;
  renderReasoning?: (content: string, index: number) => React.ReactNode;
/** Transient provider activity signal (thinking/compacting/…). */
  activityHint?: ChatActivityHint;
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
function StreamingMessageComponent({
  sessionId,
  agentIcon,
  agentIconStyle,
  fontSize,
  showReasoning = true,
  renderToolCall,
  renderReasoning,
  activityHint,
  attributionAgent,
  owner,
  onContentChange,
}: Props) {
  const { streamingText, hasContent, contentParts } =
    useStreamingContent(sessionId);
  useStreamingHaptics(sessionId, streamingText.length);
  const progressSummary = deriveToolProgressSummary(contentParts);
  const hasReasoningPart = contentParts.some(
    (part) => part.type === 'reasoning' && Boolean(part.content),
  );
  const activityLabel = deriveActivityLabel(activityHint, hasReasoningPart);
// Consecutive tool-call parts collapse into one batch while the turn is
// still streaming too — classification (inside the lazy ToolCallBatch
// chunk) marks a batch in-progress (progressive-tense summary) whenever
// one of its calls is still `running`, so the collapsed summary never
// claims a batch is done before it is.
  const blocks = useMemo(() => splitToolCallRuns(contentParts), [contentParts]);
  const contentGrowthKey = useMemo(
    () =>
      `${streamingText}\u0000${contentParts
        .map((part) => `${part.type}:${part.content ?? ''}`)
        .join('\u0001')}`,
    [contentParts, streamingText],
  );

  useEffect(() => {
// The key is the measured streaming-content revision; reading it here
// keeps this effect tied to text and part growth without changing rows.
    void contentGrowthKey;
    onContentChange?.();
  }, [contentGrowthKey, onContentChange]);

  return (
    <div className="streaming-message">
      <div className="streaming-message-icon" style={agentIconStyle}>
        {agentIcon}
      </div>
      <div className="message assistant" style={{ fontSize: `${fontSize}px` }}>
        <MessageAttribution
          agent={attributionAgent ?? null}
          engine={null}
          owner={owner}
        />

{/* Render completed content parts in order */}
        {blocks.map((block) => {
          if (block.type === 'tool-call-run') {
            if (!renderToolCall) return null;
// Same inline threshold as the settled renderer
// (`MessageContent`'s INLINE_RUN_LIMIT) so a run does not
// change shape when the turn settles.
            if (block.calls.length <= INLINE_RUN_LIMIT) {
              return block.calls.map(({ part, index }) =>
                renderToolCall(part, index),
              );
            }
            return (
              <ToolCallBatchBoundary
                key={block.key}
                run={block}
                renderCall={renderToolCall}
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
            return renderReasoning(part.content, i);
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

        {progressSummary && <ToolProgressIndicator summary={progressSummary} />}

{/* Loading indicator. Before any content arrives (redacted thinking,
            SDK spawn latency) a bare dots row reads as "stuck" — pair it
            with a live activity label so the agent never looks idle while
            working. Once content flows, the compact dots row suffices; tool
            activity is covered by ToolProgressIndicator above. */}
        {hasContent ? (
          <div className="streaming-loading">
            <LoadingDots />
          </div>
        ) : (
          <div className="streaming-activity" role="status">
            <LoadingDots />
            <span className="streaming-activity__label">{activityLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export const StreamingMessage = memo(StreamingMessageComponent);
