import { isSupportedTurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import {
  FORCED_STOP_REASON,
  STALL_FORCED_STOP_REASON,
  TURN_INTERRUPTED_MESSAGE,
} from '@kontourai/station-shared/runtime-event-projection';
import type { ChatMessage } from '../../../types';
import {
  isToolCallPart,
  type RunBlock,
  splitToolCallRuns,
  type ToolCallLike,
} from '../tool-call-runs';
import { useTranscriptChildBlocks } from '../transcript-child-work';

type TranscriptPart = NonNullable<ChatMessage['contentParts']>[number];

export interface VisibleContentOptions {
  /** The reader's reasoning setting: hidden reasoning is not content. */
  showReasoning: boolean;
}

const NO_APP_TOOLS: ReadonlySet<string> = new Set();

/**
 * Whether one transcript part draws anything in an assistant bubble. This is
 * the one rule the settled row (`MessageBubble`/`MessageContent`) and the
 * streaming row (`StreamingMessage`) share, so a bubble never renders as a
 * header with nothing under it in either phase.
 */
function partHasVisibleContent(
  part: TranscriptPart,
  { showReasoning }: VisibleContentOptions,
): boolean {
  if (isToolCallPart(part)) return true;
  switch (part.type) {
    case 'text':
      return Boolean(part.content?.trim());
    case 'reasoning':
      return showReasoning && Boolean(part.content?.trim());
    case 'file':
      return true;
    case 'ui-block':
      return Boolean(part.uiBlock);
    case 'input-request':
      return Boolean(part.inputRequestRecord);
    default:
      return false;
  }
}

/** Block-level form: tool runs, published replies and subagents always draw. */
export function blockHasVisibleContent<P extends ToolCallLike>(
  block: RunBlock<P> | { type: 'subagent' },
  options: VisibleContentOptions,
): boolean {
  if (block.type !== 'content-part') return true;
  return partHasVisibleContent(block.part as TranscriptPart, options);
}

/**
 * The settled row's answer to "is there anything to show?", including the
 * subagent cards the transcript attaches to this row's turn. Reasoning counts
 * when the reader shows it: a settled reasoning-only row keeps a collapsed
 * disclosure rather than an empty bubble.
 */
export function useHasVisibleTranscriptContent(
  contentParts: readonly TranscriptPart[] | undefined,
  textContent: string,
  options: VisibleContentOptions,
): boolean {
  const parts: TranscriptPart[] = contentParts?.length
    ? [...contentParts]
    : textContent
      ? [{ type: 'text', content: textContent }]
      : [];
  // App-tool classification only decides which tool calls become published
  // replies; both draw, so visibility does not depend on it.
  const blocks = useTranscriptChildBlocks(
    splitToolCallRuns(parts, NO_APP_TOOLS),
  );
  return blocks.some((block) => blockHasVisibleContent(block, options));
}

/**
 * The one line an ended assistant row with nothing to draw shows: how its
 * turn ended. `turnEnded` comes from the turn's terminal event; a row from
 * an older path may carry only its provenance envelope. Undefined while the
 * turn is open, so a starting turn never draws an empty card.
 */
export function endedTurnMarker(
  msg: Pick<ChatMessage, 'turnEnded' | 'provenance'>,
): 'No reply' | 'Stopped' | undefined {
  const outcome =
    msg.turnEnded ??
    (isSupportedTurnProvenanceEnvelope(msg.provenance)
      ? msg.provenance.outcome
      : undefined);
  if (outcome === 'aborted') return 'Stopped';
  return outcome === 'completed' ? 'No reply' : undefined;
}

/** A stop with no reason worth showing: the person's own Stop. */
const PLAIN_STOP_REASONS = new Set([
  'interrupted',
  'stopped',
  'cancelled',
  'canceled',
]);

/** Short lines for the stop reasons engines and Station write as tokens. */
const STOP_REASON_LINES: Record<string, string> = {
  'engine-restarted': 'The agent restarted',
  'engine-ended-before-start': 'The agent exited before starting',
  superseded: 'Replaced by a newer message',
  [TURN_INTERRUPTED_MESSAGE]: 'Station restarted mid-turn',
};

/**
 * Who stopped the turn: Station's record, or, for a forced Stop from before
 * that record existed, the reason the forced Stop wrote (the plain one is
 * only ever the person's).
 */
function stoppedBy(
  msg: Pick<ChatMessage, 'turnStoppedBy'>,
  reason: string | undefined,
): ChatMessage['turnStoppedBy'] {
  if (msg.turnStoppedBy) return msg.turnStoppedBy;
  if (reason === FORCED_STOP_REASON) return 'person';
  if (reason === STALL_FORCED_STOP_REASON) return 'stall';
  return undefined;
}

/**
 * Why a stopped turn with nothing to show stopped, when it was not the
 * person's own Stop: a second line under "Stopped". Station's own record of
 * who stopped it wins; otherwise the engine's reason, as a known short line
 * or as written, cut to one line (its full text is the tooltip).
 */
export function endedTurnStopDetail(
  msg: Pick<ChatMessage, 'turnEnded' | 'turnEndedReason' | 'turnStoppedBy'>,
): { text: string; title?: string } | undefined {
  if (msg.turnEnded !== 'aborted') return;
  const reason = msg.turnEndedReason?.trim();
  const by = stoppedBy(msg, reason);
  if (by === 'person') return;
  const text =
    by === 'stall'
      ? 'No progress for too long'
      : by === 'restart'
        ? 'Station restarted mid-turn'
        : reason && !PLAIN_STOP_REASONS.has(reason)
          ? (STOP_REASON_LINES[reason] ?? reason)
          : undefined;
  if (!text) return;
  // A reason with no short line of its own is the tooltip, in full.
  return reason &&
    reason !== text &&
    !PLAIN_STOP_REASONS.has(reason) &&
    !(reason in STOP_REASON_LINES)
    ? { text, title: reason }
    : { text };
}

/**
 * Drops the restart notice recovery writes after a turn Station's restart
 * cut off (`[SYSTEM_EVENT] [TURN_INTERRUPTED] …`) when the row just above it
 * already says so: an empty row reads "Stopped / Station restarted mid-turn",
 * or a legacy row contains the notice text. Partial answers retain their
 * separate notice without appending recovery text to the answer.
 */
export function withoutRepeatedRestartNotice<
  M extends Pick<
    ChatMessage,
    | 'role'
    | 'content'
    | 'contentParts'
    | 'turnEnded'
    | 'turnEndedReason'
    | 'turnStoppedBy'
  >,
>(messages: readonly M[]): M[] {
  return messages.filter((message, index) => {
    const notice =
      message.role === 'user'
        ? /^\[SYSTEM_EVENT\]\s*\[TURN_INTERRUPTED\]\s*([\s\S]*)$/.exec(
            message.content ?? '',
          )?.[1]
        : undefined;
    if (notice === undefined) return true;
    const previous = messages[index - 1];
    if (previous?.role !== 'assistant') return true;
    const saysRestart =
      endedTurnStopDetail(previous)?.text === 'Station restarted mid-turn';
    const saysNotice = Boolean(
      notice.trim() && previous.content?.includes(notice.trim()),
    );
    return !(saysRestart || saysNotice);
  });
}

/**
 * Whether the row has answer text: the server's Basis read answers only a
 * turn whose row has non-empty text other than a runtime error
 * (`answerOnly` in session-query-module.ts), so a row without any gets no
 * Basis chip rather than one that can only read 404.
 */
export function hasAnswerText(
  msg: Pick<ChatMessage, 'content' | 'contentParts'>,
): boolean {
  if (!msg.contentParts?.length) return Boolean(msg.content?.trim());
  return msg.contentParts.some(
    (part) =>
      part.type === 'text' &&
      part.runtimeError !== true &&
      Boolean(part.content?.trim()),
  );
}
