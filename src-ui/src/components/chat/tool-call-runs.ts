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
  args?: any;
  input?: any;
  result?: any;
  output?: any;
  error?: string;
  errorText?: string;
  state?: string;
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
