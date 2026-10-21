import { isSupportedTurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
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
export function partHasVisibleContent(
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
