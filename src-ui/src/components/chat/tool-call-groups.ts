/**
 * The CLASSIFICATION half of tool-call batching: turning a run of
 * consecutive tool-call parts (from `tool-call-runs.ts`) into a
 * `ToolCallGroup` — per-call kind/label plus a human batch summary. Kept
 * intentionally pure (no React, no DOM) so the classification and summary
 * math is unit-testable in isolation, mirroring the pattern in
 * `chat-dock/dockSnap.ts`.
 *
 * This module is only imported by the lazily-loaded `ToolCallBatch` chunk
 * (and by this file's own tests) — never eagerly by
 * `MessageContent.tsx`/`StreamingMessage.tsx`, which only need the cheap
 * structural split in `tool-call-runs.ts` to decide whether a run needs
 * batching at all. See that module's doc comment for why the split exists.
 *
 * Per-call labeling (the verb taxonomy, target extraction) lives in
 * `tool-call-labels.ts` — the eager collapsed activity row needs it too
 * (archive#2652 redesign) — and is composed here; only the multi-call
 * summary phrasing ("Read 2 files, ran 2 commands") is batch-specific.
 */
import {
  callLabel,
  classifyToolName,
  KIND_VERBS,
  type ToolCallKind,
} from './tool-call-labels';
import {
  type ContentPartBlock,
  isToolCallPart,
  splitToolCallRuns,
  type ToolCallLike,
  type ToolCallRun,
} from './tool-call-runs';

export type { ContentPartBlock, ToolCallKind, ToolCallLike };
export { classifyToolName, isToolCallPart };

interface KindNouns {
  singularNoun: string;
  pluralNoun: string;
}

const KIND_NOUNS: Record<ToolCallKind, KindNouns> = {
  read: { singularNoun: 'file', pluralNoun: 'files' },
  write: { singularNoun: 'file', pluralNoun: 'files' },
  exec: { singularNoun: 'command', pluralNoun: 'commands' },
  search: { singularNoun: 'search', pluralNoun: 'searches' },
  other: { singularNoun: 'tool', pluralNoun: 'tools' },
};

/** Fixed rendering order for multi-kind summaries — stable output, not
 * insertion order (which would make the summary depend on call order). */
const KIND_ORDER: ToolCallKind[] = ['read', 'write', 'exec', 'search', 'other'];

function toolNameOf(part: ToolCallLike): string {
  if (part.toolName) return part.toolName;
  if (part.name) return part.name;
  if (
    part.type &&
    part.type !== 'tool-invocation' &&
    part.type.startsWith('tool-')
  ) {
    return part.type.slice('tool-'.length);
  }
  return '';
}

export interface ClassifiedToolCall<P extends ToolCallLike = ToolCallLike> {
  part: P;
  /** Index of this call within the original content-parts array. */
  index: number;
  kind: ToolCallKind;
  /** e.g. "Read app.tsx", "Ran <short command>". */
  label: string;
  inProgress: boolean;
  /** The call reached a failure terminal (error text or an error state). */
  failed: boolean;
}

export interface ToolCallGroup<P extends ToolCallLike = ToolCallLike> {
  type: 'tool-call-group';
  /** Stable React key: the first call's id when present, else a position key. */
  key: string;
  calls: ClassifiedToolCall<P>[];
  /** e.g. "Read 2 files, ran 2 commands" / "Ran 3 commands" / "Ran build.sh". */
  summary: string;
  inProgress: boolean;
  /** How many of this run's calls failed — a collapsed batch must disclose
   * failure without being opened (archive#2652 redesign). */
  failedCount: number;
}

export type MessageBlock<P extends ToolCallLike = ToolCallLike> =
  | ContentPartBlock<P>
  | ToolCallGroup<P>;

function classifyCall<P extends ToolCallLike>(
  part: P,
  index: number,
): ClassifiedToolCall<P> {
  const toolName = toolNameOf(part);
  const kind = classifyToolName(toolName);
  const args = part.args ?? part.input;
  const inProgress = part.state === 'running';
  const label = callLabel(kind, toolName, args, inProgress);
  const failed =
    Boolean(part.error || part.errorText) || part.state === 'error';
  return { part, index, kind, label, inProgress, failed };
}

/** Joins per-kind segments the way the owner-supplied examples read: plain
 * comma separation, no trailing "and" ("Read 2 files, ran 2 commands"). */
function summarizeCalls(
  calls: ClassifiedToolCall[],
  inProgress: boolean,
): string {
  if (calls.length === 1) {
    const suffix = inProgress ? '…' : '';
    return `${calls[0].label}${suffix}`;
  }

  const counts = new Map<ToolCallKind, number>();
  for (const call of calls) {
    counts.set(call.kind, (counts.get(call.kind) ?? 0) + 1);
  }

  const segments: string[] = [];
  for (const kind of KIND_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count === 0) continue;
    const verbForm = inProgress
      ? KIND_VERBS[kind].progressiveVerb
      : KIND_VERBS[kind].verb;
    const verb = segments.length === 0 ? verbForm : verbForm.toLowerCase();
    const nouns = KIND_NOUNS[kind];
    const noun = count === 1 ? nouns.singularNoun : nouns.pluralNoun;
    segments.push(`${verb} ${count} ${noun}`);
  }

  const joined = segments.join(', ');
  return inProgress ? `${joined}…` : joined;
}

/** Classifies a single run (from `splitToolCallRuns`) into a `ToolCallGroup`
 * — the per-call kind/label plus the batch's human summary. This is what
 * the lazily-loaded `ToolCallBatch` calls once it actually needs to render
 * a multi-call batch. */
export function classifyToolCallRun<P extends ToolCallLike>(
  run: ToolCallRun<P>,
): ToolCallGroup<P> {
  const calls = run.calls.map(({ part, index }) => classifyCall(part, index));
  const inProgress = calls.some((c) => c.inProgress);
  const summary = summarizeCalls(calls, inProgress);
  const failedCount = calls.filter((c) => c.failed).length;
  return {
    type: 'tool-call-group',
    key: run.key,
    calls,
    summary,
    inProgress,
    failedCount,
  };
}

/**
 * Groups a message's content parts, collapsing consecutive tool-call parts
 * into `ToolCallGroup` blocks (classified + summarized) and passing every
 * other part through unchanged. Order is preserved; nothing is dropped.
 *
 * This composes `splitToolCallRuns` (structural) with `classifyToolCallRun`
 * (classification) — the full pipeline, used by this module's own tests and
 * by `ToolCallBatch`. The transcript's eager render path
 * (`MessageContent.tsx`/`StreamingMessage.tsx`) calls `splitToolCallRuns`
 * directly instead, deferring classification until a batch is actually
 * rendered — see the module doc comment above.
 */
export function groupToolCallParts<P extends ToolCallLike>(
  parts: P[] | undefined | null,
): MessageBlock<P>[] {
  return splitToolCallRuns(parts).map((block) =>
    block.type === 'tool-call-run' ? classifyToolCallRun(block) : block,
  );
}
