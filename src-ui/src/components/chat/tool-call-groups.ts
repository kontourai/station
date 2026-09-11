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
  isToolCallAwaitingApproval,
  KIND_VERBS,
  type ToolCallKind,
  type ToolCallPhase,
  toolCallPhase,
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

interface ClassifiedToolCall<P extends ToolCallLike = ToolCallLike> {
  part: P;
  /** Index of this call within the original content-parts array. */
  index: number;
  kind: ToolCallKind;
  /** e.g. "Read app.tsx", "Ran <short command>". */
  label: string;
  phase: ToolCallPhase;
  inProgress: boolean;
  /** The call reached a failure terminal (error text or an error state). */
  failed: boolean;
  /** The session ended with the call still open, so whether it ran is
   * unknown (station#1558's `unresolved` terminal). Neither in progress nor
   * done — the batch header's verb has to account for it separately from
   * both (station#1569 item 3). */
  unresolved: boolean;
  /** Live path only: the call is waiting on an explicit grant. */
  awaitingApproval: boolean;
  denied: boolean;
  cancelled: boolean;
}

export interface ToolCallGroup<P extends ToolCallLike = ToolCallLike> {
  type: 'tool-call-group';
  /** Stable React key: the first call's id when present, else a position key. */
  key: string;
  calls: ClassifiedToolCall<P>[];
  /**
   * Collapsed-button copy. While a multi-call run is in flight and nothing
   * in it is proposed or unresolved, this is the latest running call's own
   * label. Otherwise the inventory phrase.
   */
  summary: string;
  /**
   * Inventory phrase for the sheet title — always "Read 2 files, ran 2
   * commands" / "Ran 3 commands" / the solo label. Independent of the live
   * headline so opening a streaming batch still names the whole run.
   */
  aggregateSummary: string;
  inProgress: boolean;
  /** How many of this run's calls failed — a collapsed batch must disclose
   * failure without being opened (archive#2652 redesign). */
  failedCount: number;
  /** How many of this run's calls ended `unresolved`. Disclosed for the same
   * reason `failedCount` is: the summary's verb alone cannot say that some of
   * these calls may never have run, and a reader who does not open the batch
   * would otherwise be told nothing (station#1569 item 3). */
  unresolvedCount: number;
  /** How many of this run's calls are waiting on an explicit grant. Same
   * collapsed-visible duty as `failedCount`: collapsing 2+ calls would
   * otherwise hide Allow Once / Deny behind the sheet. */
  awaitingApprovalCount: number;
  deniedCount: number;
  cancelledCount: number;
  /** Latest running call's `progressMessage`, if any — the collapsed line
   * is the only live surface once the run is batched. */
  progressMessage?: string;
}

type MessageBlock<P extends ToolCallLike = ToolCallLike> =
  | ContentPartBlock<P>
  | ToolCallGroup<P>;

function classifyCall<P extends ToolCallLike>(
  part: P,
  index: number,
): ClassifiedToolCall<P> {
  const toolName = toolNameOf(part);
  const kind = classifyToolName(toolName);
  const args = part.args ?? part.input;
  const phase = toolCallPhase(part);
  const inProgress = phase === 'running';
  const unresolved = part.state === 'unresolved';
  const failed =
    Boolean(part.error || part.errorText) || part.state === 'error';
  const awaitingApproval = isToolCallAwaitingApproval(part);
  const denied = part.approvalStatus === 'user-denied';
  const cancelled =
    (part.cancelled === true || part.state === 'cancelled') && !denied;
  const label = callLabel(kind, toolName, args, phase);
  return {
    part,
    index,
    kind,
    label,
    phase,
    inProgress,
    failed,
    unresolved,
    awaitingApproval,
    denied,
    cancelled,
  };
}

/** Latest actually-running call in transcript order. */
function latestRunningCall(
  calls: ClassifiedToolCall[],
): ClassifiedToolCall | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index].inProgress) return calls[index];
  }
  return undefined;
}

/** Joins per-kind segments the way the owner-supplied examples read: plain
 * comma separation, no trailing "and" ("Read 2 files, ran 2 commands"). */
function summarizeCalls(
  calls: ClassifiedToolCall[],
  inProgress: boolean,
  pending: boolean,
): string {
  if (calls.length === 1) {
    const suffix = inProgress && !pending ? '…' : '';
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
    // station#1569 (item 3): a mixed batch that includes an unresolved OR
    // proposed call cannot take past or progressive tense — both claim
    // work the expanded rows refuse. The bare infinitive is the only form
    // honest for the mix; the count badges name which.
    const verbForm = pending
      ? KIND_VERBS[kind].pendingVerb
      : inProgress
        ? KIND_VERBS[kind].progressiveVerb
        : KIND_VERBS[kind].verb;
    const verb = segments.length === 0 ? verbForm : verbForm.toLowerCase();
    const nouns = KIND_NOUNS[kind];
    const noun = count === 1 ? nouns.singularNoun : nouns.pluralNoun;
    segments.push(`${verb} ${count} ${noun}`);
  }

  const joined = segments.join(', ');
  // Ellipsis means "still going". A proposed or unresolved sibling is not.
  return inProgress && !pending ? `${joined}…` : joined;
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
  const unresolvedCount = calls.filter((c) => c.unresolved).length;
  const awaitingApprovalCount = calls.filter((c) => c.awaitingApproval).length;
  const pending = calls.some(
    (c) => c.phase === 'proposed' || c.phase === 'unresolved',
  );
  const aggregateSummary = summarizeCalls(calls, inProgress, pending);
  // A live multi-call run updates to the current tool only when every
  // sibling is still allowed to claim flight. A proposed or unresolved
  // sibling owns the inventory phrase instead.
  const liveCall =
    inProgress && !pending && calls.length > 1
      ? latestRunningCall(calls)
      : undefined;
  const summary = liveCall ? `${liveCall.label}…` : aggregateSummary;
  const failedCount = calls.filter((c) => c.failed).length;
  const deniedCount = calls.filter((c) => c.denied).length;
  const cancelledCount = calls.filter((c) => c.cancelled).length;
  const progressSource = latestRunningCall(calls);
  const rawProgress = progressSource?.part.progressMessage;
  const progressMessage =
    typeof rawProgress === 'string' && rawProgress.trim().length > 0
      ? rawProgress.trim()
      : undefined;
  return {
    type: 'tool-call-group',
    key: run.key,
    calls,
    summary,
    aggregateSummary,
    inProgress,
    failedCount,
    unresolvedCount,
    awaitingApprovalCount,
    deniedCount,
    cancelledCount,
    progressMessage,
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
