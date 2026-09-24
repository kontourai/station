import { memo, useMemo } from 'react';
import type { ChatMessage } from '../../../types';
import {
  projectedRuntimeErrorRaw,
  translateChatError,
  translateProjectedRuntimeError,
} from '../../../utils/chatErrorTranslation';
import { FilePartPreview } from '../FilePartPreview';
import { LazyMarkdown } from '../LazyMarkdown';
import { ReasoningSection } from '../ReasoningSection';
import { ChatErrorDetails } from '../SystemEventMessage';
import { ToolCallBatchBoundary } from '../ToolCallBatchBoundary';
import { type ToolApprovalOutcome, ToolCallDisplay } from '../ToolCallDisplay';
import { splitToolCallRuns } from '../tool-call-runs';
import { UIBlockRenderer } from '../UIBlockRenderer';

type MessageContentPart = NonNullable<ChatMessage['contentParts']>[number];

/** Consecutive tool-call runs longer than this collapse to the ToolCallBatch
 * summary + sheet. 1 means a solo call stays an inline row and any 2+ run
 * becomes one line that opens the existing overlay. Shared with
 * `StreamingMessage` so a run does not change shape when the turn settles.
 * The summary is transcript chrome, not "tool details"; opening the sheet
 * is an explicit disclosure and shows each call even when details are off.
 * A call that still needs a grant is rendered under the summary so Allow
 * Once is not behind a tap and the rest of the run stays collapsed. */
export const INLINE_RUN_LIMIT = 1;

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
  ) => Promise<ToolApprovalOutcome>;
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
  const hasAnswerText =
    Boolean(textContent.trim()) ||
    Boolean(
      contentParts?.some(
        (part) => part.type === 'text' && Boolean(part.content?.trim()),
      ),
    );

  const renderToolCall = (part: MessageContentPart, index: number) => (
    <ToolCallDisplay
      key={index}
      toolCall={part as any}
      showDetails={showToolDetails}
      onApprove={
        // #2316: a card bound to its request by the projection answers from
        // wherever its row sits — the server verifies the exact prompt
        // (`expectedRequestEventId`), which is what the last-row gate stood
        // in for. A part without that binding keeps the last-row gate.
        part.needsApproval && (isStreamingMessage || part.approvalEventId)
          ? (action) =>
              onToolApproval?.(part, action) ??
              Promise.reject(new Error('This chat cannot answer requests.'))
          : undefined
      }
    />
  );

  if (contentParts && contentParts.length > 0) {
    return (
      <>
        {blocks.map((block) => {
          if (block.type === 'tool-call-run') {
            // A solo call stays an inline row. Two or more consecutive
            // calls collapse to one summary line that opens the sheet —
            // live and settled share this threshold so a run does not
            // change shape when the turn completes.
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

          const { index, part } = block;
          if (part.type === 'reasoning' && part.content) {
            // #2211: reasoning is the STREAMING row's follow-along surface.
            // Once a row settles, the reasoning record opens from the turn's
            // overflow menu (TurnActionsMenu) instead of occupying a
            // disclosure row inside the answer bubble. StreamingMessage owns
            // the live path; this component renders settled rows, so only the
            // last-message-while-active case keeps the section here.
            if (!isStreamingMessage) return null;
            return (
              <ReasoningSection
                key={index}
                content={part.content}
                fontSize={chatFontSize}
                show={showReasoning}
                hasAnswerText={hasAnswerText}
              />
            );
          }
          if (part.type === 'text' && part.content) {
            // #765 A1: a runtime-error part rehydrated from the durable
            // projection carries the structured code beside its raw engine
            // prose. Render the same translated copy the live path shows
            // instead of the raw text (e.g. a bare
            // "No conversation found with session ID: <uuid>"); an uncoded
            // or unmapped failure keeps its verbatim prose.
            if (part.runtimeError && part.runtimeErrorCode) {
              const translated = translateProjectedRuntimeError(
                part.content,
                part.runtimeErrorCode,
              );
              if (translated) {
                const raw = projectedRuntimeErrorRaw(part.content);
                const wantsDetails = translateChatError({
                  message: raw,
                  code: part.runtimeErrorCode,
                }).disclosureRaw;
                return (
                  <div key={index}>
                    <LazyMarkdown>{translated}</LazyMarkdown>
                    {wantsDetails ? <ChatErrorDetails raw={raw} /> : null}
                  </div>
                );
              }
            }
            // archive#3354: persisted text parts keep their highlighting —
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
