import { memo, useMemo } from 'react';
import type { ChatMessage } from '../../../types';
import { FilePartPreview } from '../FilePartPreview';
import { LazyMarkdown } from '../LazyMarkdown';
import { ReasoningSection } from '../ReasoningSection';
import { ToolCallBatchBoundary } from '../ToolCallBatchBoundary';
import { ToolCallDisplay } from '../ToolCallDisplay';
import { splitToolCallRuns } from '../tool-call-runs';
import { UIBlockRenderer } from '../UIBlockRenderer';

type MessageContentPart = NonNullable<ChatMessage['contentParts']>[number];

/** Runs of up to this many consecutive tool calls render as individual
 * activity rows; longer runs collapse to the ToolCallBatch summary. Shared
 * with `StreamingMessage` so a run does not change shape when the turn
 * settles. */
export const INLINE_RUN_LIMIT = 3;

interface MessageContentProps {
  contentParts?: MessageContentPart[];
  textContent: string;
  chatFontSize: number;
  showReasoning: boolean;
  showToolDetails: boolean;
  isStreamingMessage: boolean;
  onToolApproval?: (
    part: MessageContentPart,
    action: 'once' | 'trust' | 'deny',
  ) => void;
}

function MessageContentComponent({
  contentParts,
  textContent,
  chatFontSize,
  showReasoning,
  showToolDetails,
  isStreamingMessage,
  onToolApproval,
}: MessageContentProps) {
  // Consecutive tool-call parts collapse into one batch (`LazyToolCallBatch`);
  // any other part in between — prose, reasoning, a file, a UI block —
  // breaks the run, so the agent's words between tool calls are never
  // buried inside a collapsed summary. Only the structural split runs
  // eagerly here; classification/summary happens inside the lazy chunk.
  const blocks = useMemo(() => splitToolCallRuns(contentParts), [contentParts]);
  const currentMessageProjection = useMemo(
    () => <div>{textContent}</div>,
    [textContent],
  );

  const renderToolCall = (part: MessageContentPart, index: number) => (
    <ToolCallDisplay
      key={index}
      toolCall={part as any}
      showDetails={showToolDetails}
      onApprove={
        isStreamingMessage && part.needsApproval
          ? (action) => onToolApproval?.(part, action)
          : undefined
      }
    />
  );

  if (contentParts && contentParts.length > 0) {
    return (
      <>
        {blocks.map((block) => {
          if (block.type === 'tool-call-run') {
            // Short runs render as individual quiet rows — cheaper to read
            // than a summary-plus-sheet hop. Only a long run collapses to
            // the batch summary (station#2652 redesign).
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

          const { index, part } = block;
          if (part.type === 'reasoning' && part.content) {
            return (
              <ReasoningSection
                key={index}
                content={part.content}
                fontSize={chatFontSize}
                show={showReasoning}
              />
            );
          }
          if (part.type === 'text' && part.content) {
            // station#3354: persisted text parts keep their highlighting —
            // they previously rendered plain once the turn settled.
            return <LazyMarkdown key={index}>{part.content}</LazyMarkdown>;
          }
          if (part.type === 'file') {
            return (
              <FilePartPreview
                key={index}
                part={part}
                allParts={contentParts}
              />
            );
          }
          if (part.type === 'ui-block' && part.uiBlock) {
            return <UIBlockRenderer key={index} block={part.uiBlock} />;
          }
          return null;
        })}
      </>
    );
  }

  if (!textContent) return null;

  return (
    <LazyMarkdown loadingProjection={currentMessageProjection}>
      {textContent}
    </LazyMarkdown>
  );
}

function areMessageContentPropsEqual(
  previous: Readonly<MessageContentProps>,
  next: Readonly<MessageContentProps>,
) {
  // A plain message does not consume any of the tool/reasoning controls or
  // approval callback.  Keep its current rendered Markdown projection stable
  // while parent chat state changes (such as composer input) refresh those
  // unrelated values.
  if (!previous.contentParts?.length && !next.contentParts?.length) {
    return previous.textContent === next.textContent;
  }
  return (
    previous.contentParts === next.contentParts &&
    previous.textContent === next.textContent &&
    previous.chatFontSize === next.chatFontSize &&
    previous.showReasoning === next.showReasoning &&
    previous.showToolDetails === next.showToolDetails &&
    previous.isStreamingMessage === next.isStreamingMessage &&
    previous.onToolApproval === next.onToolApproval
  );
}

export const MessageContent = memo(
  MessageContentComponent,
  areMessageContentPropsEqual,
);
