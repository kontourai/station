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
  purpose?: string;
  approvalStatus?: string;
  [key: string]: unknown;
}

export interface ContentPartBlock<P> {
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
   * Prose folded between this run's calls by {@link foldTurnWork}, in
   * original order. Present only on a folded settled turn; the batch sheet
   * interleaves it with the calls by `index` so nothing becomes unreachable.
   */
  interludes?: { part: P; index: number }[];
}

export type RunBlock<P extends ToolCallLike = ToolCallLike> =
  | ContentPartBlock<P>
  | ToolCallRun<P>;

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

/**
 * Splits a message's content parts into runs of consecutive tool-call parts
 * and everything else, preserving order. The grouping rule: parts of type
 * `tool-invocation` (or any `tool-*` persisted-part variant) that are
 * *adjacent* in the array merge into one run. Any other part in between —
 * prose text, reasoning, a file preview, a UI block — breaks the run,
 * because it means the agent said something between those tool calls that
 * the transcript must not bury inside a collapsed batch.
 */
export function splitToolCallRuns<P extends ToolCallLike>(
  parts: P[] | undefined | null,
): RunBlock<P>[] {
  if (!parts || parts.length === 0) return [];

  const blocks: RunBlock<P>[] = [];
  let pending: { part: P; index: number }[] = [];

  const flushRun = () => {
    if (pending.length === 0) return;
    blocks.push(buildRun(pending));
    pending = [];
  };

  parts.forEach((part, index) => {
    if (isToolCallPart(part)) {
      pending.push({ part, index });
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
 * Only narration folds. Anything else inside that span — a file the agent
 * produced, a UI block, a runtime error, a reasoning part — is kept, in
 * order, directly after the folded run, so the fold never hides an artifact
 * or a failure. When no visible text follows the last call, the last
 * narration is kept there too: it is the turn's last word. With one tool-call run or fewer this returns exactly
 * {@link splitToolCallRuns}'s blocks: nothing to merge.
 */
export function foldTurnWork<P extends ToolCallLike>(
  parts: P[] | undefined | null,
): RunBlock<P>[] {
  const blocks = splitToolCallRuns(parts);
  if (!parts) return blocks;
  const runCount = blocks.filter((b) => b.type === 'tool-call-run').length;
  if (runCount < 2) return blocks;

  const firstRun = blocks.findIndex((b) => b.type === 'tool-call-run');
  let lastRun = blocks.length - 1;
  while (blocks[lastRun]?.type !== 'tool-call-run') lastRun -= 1;

  const calls: { part: P; index: number }[] = [];
  const interludes: { part: P; index: number }[] = [];
  const kept: RunBlock<P>[] = [];
  for (const block of blocks.slice(firstRun, lastRun + 1)) {
    if (block.type === 'tool-call-run') {
      calls.push(...block.calls);
    } else if (isFoldableProse(block.part)) {
      interludes.push({ part: block.part, index: block.index });
    } else {
      kept.push(block);
    }
  }
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
  const lastWords = hasOutcome ? undefined : interludes.pop();
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
