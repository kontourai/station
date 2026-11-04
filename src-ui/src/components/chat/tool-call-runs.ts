import type { HtmlReplyReference } from '@kontourai/station-contracts/html-reply';
import { htmlReplyReference } from './html-reply-reference';
import { transcriptMcpToolRef } from './mcp-app-tool-ref';

/**
 * The STRUCTURAL half of tool-call batching: splitting a message's content
 * parts into runs of consecutive tool-call parts vs. everything else.
 *
 * This is deliberately its own tiny module, imported eagerly by
 * `MessageContent.tsx`/`StreamingMessage.tsx`. The classification/labeling/
 * summary logic (`tool-call-groups.ts` — the verb taxonomy, target
 * extraction, "Read 2 files, ran 2 commands" phrasing) only matters once a
 * run has more than one call to actually collapse, so it lives entirely
 * inside the lazily-loaded `ToolCallBatch` chunk instead of the app's
 * first-paint bundle. The station UI bundle budget
 * (`scripts/ui-bundle-budget.json`) had essentially no headroom left, so
 * putting the whole taxonomy in the eager path was not an option — see
 * `tool-call-groups.ts`'s module doc for the composition.
 */

import { hasStationControlCallRow } from './agent-message/station-control-calls';
import { claudeArtifactLinkOf } from './claude-artifact-link';

/** A call shown as its own row rather than one line of a collapsed run. */
function hasOwnCallRow(part: ToolCallLike): boolean {
  return (
    hasStationControlCallRow(part) || claudeArtifactLinkOf(part) !== undefined
  );
}

/** A single-call run whose call is a published Claude Code artifact. */
function isArtifactRun(block: { calls: { part: ToolCallLike }[] }): boolean {
  return (
    block.calls.length === 1 &&
    claudeArtifactLinkOf(block.calls[0]!.part) !== undefined
  );
}

/** Minimal duck-typed shape both `ChatMessage['contentParts']` element types
 * (`types.ts` and `contexts/active-chats-state.ts`) already satisfy. */
export interface ToolCallLike {
  type: string;
  toolCallId?: string;
  name?: string;
  toolName?: string;
  toolKind?: string;
  args?: any;
  input?: any;
  result?: any;
  output?: any;
  error?: string;
  errorText?: string;
  state?: string;
  needsApproval?: boolean;
  cancelled?: boolean;
  progressMessage?: string;
  /** ISO start of the call (`MessagePart.startedAt`). */
  startedAt?: string;
  purpose?: string;
  approvalStatus?: string;
  [key: string]: unknown;
}

export interface ContentPartBlock<P> {
  key?: string;
  type: 'content-part';
  index: number;
  part: P;
}

export interface ToolCallRun<P extends ToolCallLike = ToolCallLike> {
  type: 'tool-call-run';
  /** Stable React key: the first call's id when present, else a position key. */
  key: string;
  calls: { part: P; index: number }[];
  /**
   * Visible reasoning, plus narration moved by {@link foldTurnWork}. The
   * sheet interleaves these parts with calls by their original `index`.
   */
  interludes?: { part: P; index: number }[];
}

export type RunBlock<P extends ToolCallLike = ToolCallLike> =
  | ContentPartBlock<P>
  | ToolCallRun<P>
  | { type: 'html-reply'; key: string; reference: HtmlReplyReference };

/** True for any part the transcript renders via `ToolCallDisplay` — the
 * exact predicate `MessageContent.tsx`/`StreamingMessage.tsx` already use. */
export function isToolCallPart(
  part: { type?: string } | null | undefined,
): boolean {
  if (!part?.type) return false;
  return part.type === 'tool-invocation' || part.type.startsWith('tool-');
}

function buildRun<P extends ToolCallLike>(
  calls: { part: P; index: number }[],
): ToolCallRun<P> {
  const firstCallId = calls[0]?.part.toolCallId;
  const key = firstCallId
    ? `tool-call-run:${firstCallId}`
    : `tool-call-run:${calls[0].index}-${calls[calls.length - 1].index}`;
  return { type: 'tool-call-run', key, calls };
}

/** Adjacent tools and visible reasoning share an activity run. Prose, artifacts
 * and requests keep their own rows. Reasoning without a tool stays standalone. */
export function splitToolCallRuns<P extends ToolCallLike>(
  parts: P[] | undefined | null,
  appTools: ReadonlySet<string> = new Set(),
  showReasoning = true,
): RunBlock<P>[] {
  if (!parts || parts.length === 0) return [];

  const blocks: RunBlock<P>[] = [];
  let pending: { part: P; index: number }[] = [];
  let reasoning: { part: P; index: number }[] = [];

  const flushRun = () => {
    if (pending.length > 0) {
      const run = buildRun(pending);
      if (reasoning.length) run.interludes = reasoning;
      blocks.push(run);
    } else {
      blocks.push(
        ...reasoning.map((note) => ({
          type: 'content-part' as const,
          ...note,
        })),
      );
    }
    pending = [];
    reasoning = [];
  };

  parts.forEach((part, index) => {
    if (part.type === 'reasoning') {
      if (
        showReasoning &&
        typeof part.content === 'string' &&
        part.content.trim()
      ) {
        reasoning.push({ part, index });
      }
      return;
    }
    // #3419: a message sent to another Session is its own row, never one line
    // of a collapsed "used 3 tools" summary; so is a published artifact,
    // whose link is the call's deliverable.
    if (isToolCallPart(part) && hasOwnCallRow(part)) {
      flushRun();
      blocks.push(buildRun([{ part, index }]));
      return;
    }
    if (
      isToolCallPart(part) &&
      !appTools.has(transcriptMcpToolRef(part) ?? '')
    ) {
      pending.push({ part, index });
      const name = part.toolName ?? part.name ?? part.type;
      if (
        /^(?:mcp__station-control__|station-control[_/]|Tool: station-control\/)html_render$/.test(
          name,
        )
      ) {
        const reference =
          htmlReplyReference(part) ??
          htmlReplyReference(part.output ?? part.result);
        if (reference) {
          flushRun();
          blocks.push({
            type: 'html-reply',
            key: `html-reply:${part.toolCallId ?? index}:${reference.pageId}`,
            reference,
          });
        }
      }
      return;
    }
    flushRun();
    blocks.push({ type: 'content-part', index, part });
  });
  flushRun();

  return blocks;
}

/** Prose a folded turn may move into its work sheet: plain narration only.
 * A runtime-error part is a failure the reader must see, so it stays out. */
function isFoldableProse(part: ToolCallLike): boolean {
  return (
    part.type === 'text' &&
    typeof part.content === 'string' &&
    part.content.trim().length > 0 &&
    part.runtimeError !== true
  );
}

/**
 * The phone transcript's shape for a SETTLED assistant turn: every tool call
 * from the first to the last — and the narration between them — becomes ONE
 * run, placed where the first call was. Text after the last call (the
 * outcome) and text before the first (the intent) stay as they were.
 *
 * Narration and reasoning fold. Anything else inside that span — a file the agent
 * produced, a UI block, a runtime error — is kept, in
 * order, directly after the folded run, so the fold never hides an artifact
 * or a failure. When no visible text follows the last call, the last
 * narration is kept there too: it is the turn's last word. With one tool-call run or fewer this returns exactly
 * {@link splitToolCallRuns}'s blocks: nothing to merge.
 */
export function foldTurnWork<P extends ToolCallLike>(
  parts: P[] | undefined | null,
  appTools: ReadonlySet<string> = new Set(),
  showReasoning = true,
): RunBlock<P>[] {
  const blocks = splitToolCallRuns(parts, appTools, showReasoning);
  if (!parts) return blocks;
  if (blocks.some((block) => block.type === 'html-reply')) return blocks;
  const runCount = blocks.filter((b) => b.type === 'tool-call-run').length;
  if (runCount < 2) return blocks;

  const firstRun = blocks.findIndex((b) => b.type === 'tool-call-run');
  let lastRun = blocks.length - 1;
  while (blocks[lastRun]?.type !== 'tool-call-run') lastRun -= 1;

  const calls: { part: P; index: number }[] = [];
  const interludes: { part: P; index: number }[] = [];
  const kept: RunBlock<P>[] = [];
  for (const block of blocks.slice(firstRun, lastRun + 1)) {
    // A published artifact is something the agent produced: like a file, it
    // stays in the transcript instead of folding into the work sheet.
    if (block.type === 'tool-call-run' && isArtifactRun(block)) {
      kept.push(block);
    } else if (block.type === 'tool-call-run') {
      calls.push(...block.calls);
      interludes.push(...(block.interludes ?? []));
    } else if (block.type === 'content-part' && isFoldableProse(block.part)) {
      interludes.push({ part: block.part, index: block.index });
    } else {
      kept.push(block);
    }
  }
  // Every call in the span is a published artifact: nothing to fold.
  if (calls.length === 0) return blocks;
  const after = blocks.slice(lastRun + 1);
  // A turn that ends on a call has no outcome below the row: its last words
  // (often a question for the user) would only be reachable by opening the
  // sheet, so they stay in the transcript.
  const hasOutcome = after.some(
    (block) =>
      block.type === 'content-part' &&
      block.part.type === 'text' &&
      typeof block.part.content === 'string' &&
      block.part.content.trim().length > 0,
  );
  let lastProse = interludes.length - 1;
  while (lastProse >= 0 && !isFoldableProse(interludes[lastProse].part)) {
    lastProse -= 1;
  }
  const lastWords =
    !hasOutcome && lastProse >= 0
      ? interludes.splice(lastProse, 1)[0]
      : undefined;
  if (lastWords) {
    kept.push({ type: 'content-part', ...lastWords });
    kept.sort((a, b) =>
      a.type === 'content-part' && b.type === 'content-part'
        ? a.index - b.index
        : 0,
    );
  }
  return [
    ...blocks.slice(0, firstRun),
    { ...buildRun(calls), interludes },
    ...kept,
    ...after,
  ];
}
