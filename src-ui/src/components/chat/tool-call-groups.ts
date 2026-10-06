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
  classifyToolCall,
  isToolCallAwaitingApproval,
  isToolCallBatchPending,
  type ToolCallKind,
  type ToolCallPhase,
  toolCallPhase,
} from './tool-call-labels';
import type { ToolCallLike, ToolCallRun } from './tool-call-runs';
import { toolDisplayView } from './tool-display-view';

export type { ToolCallKind, ToolCallLike };

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * One kind's segment of the inventory phrase, per tense. `done` and
 * `running` are verb phrases; `pending` is a bare noun phrase, because a
 * batch holding a proposed, cancelled, denied or unresolved call cannot take
 * a verb that claims the work happened or is happening — and the bare
 * infinitive ("Run 2 commands", "search 1 search") read as an instruction.
 * Searches take "ran", never "searched 2 searches".
 */
const KIND_PHRASES: Record<
  ToolCallKind,
  Record<'done' | 'running' | 'pending', (count: number) => string>
> = {
  read: {
    done: (n) => `Read ${plural(n, 'file', 'files')}`,
    running: (n) => `Reading ${plural(n, 'file', 'files')}`,
    pending: (n) => plural(n, 'file read', 'file reads'),
  },
  write: {
    done: (n) => `Edited ${plural(n, 'file', 'files')}`,
    running: (n) => `Editing ${plural(n, 'file', 'files')}`,
    pending: (n) => plural(n, 'file edit', 'file edits'),
  },
  delete: {
    done: (n) => `Deleted ${plural(n, 'file', 'files')}`,
    running: (n) => `Deleting ${plural(n, 'file', 'files')}`,
    pending: (n) => plural(n, 'file deletion', 'file deletions'),
  },
  exec: {
    done: (n) => `Ran ${plural(n, 'command', 'commands')}`,
    running: (n) => `Running ${plural(n, 'command', 'commands')}`,
    pending: (n) => plural(n, 'command', 'commands'),
  },
  search: {
    done: (n) => `Ran ${plural(n, 'search', 'searches')}`,
    running: (n) => `Running ${plural(n, 'search', 'searches')}`,
    pending: (n) => plural(n, 'search', 'searches'),
  },
  other: {
    done: (n) => `Used ${plural(n, 'tool', 'tools')}`,
    running: (n) => `Using ${plural(n, 'tool', 'tools')}`,
    pending: (n) => plural(n, 'tool call', 'tool calls'),
  },
};

/** Fixed rendering order for multi-kind summaries — stable output, not
 * insertion order (which would make the summary depend on call order). */
const KIND_ORDER: ToolCallKind[] = [
  'read',
  'write',
  'delete',
  'exec',
  'search',
  'other',
];

function toolNameOf(part: ToolCallLike): string {
  return toolDisplayView(part).toolName;
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
  /** A failed call that a LATER call in the same list retried successfully
   * with the same tool and identical arguments ({@link recoveredFailures}). */
  recovered: boolean;
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
  /** How many of this run's calls failed and were NOT recovered by a later
   * identical call — a collapsed batch must disclose failure without being
   * opened (archive#2652 redesign). */
  failedCount: number;
  /** Failed calls a later identical call recovered. Disclosed neutrally: the
   * failure still happened, but it is not the run's outcome. */
  recoveredCount: number;
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
  /** Narration folded between the calls (`foldTurnWork`), in original order. */
  interludes: { part: P; index: number }[];
}

/** What {@link recoveredFailures} needs to know about one call. */
export interface RetryEvidence {
  toolName: string;
  args: unknown;
  failed: boolean;
  /** Observed successful completion (`toolCallPhase(...) === 'done'`). */
  succeeded: boolean;
}

/** Structural equality for JSON-shaped tool arguments. */
function sameArgs(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameArgs(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}

/**
 * Which failed calls were recovered: a failure counts as recovered only when
 * a LATER call in the same list ran the same tool with deep-equal arguments
 * and completed successfully. A retry with different arguments, a later
 * identical call that also failed (or never finished), or an earlier success
 * does not recover it. Returns one flag per input call, in order.
 */
export function recoveredFailures(calls: readonly RetryEvidence[]): boolean[] {
  return calls.map(
    (call, position) =>
      call.failed &&
      calls
        .slice(position + 1)
        .some(
          (later) =>
            later.succeeded &&
            later.toolName === call.toolName &&
            sameArgs(later.args, call.args),
        ),
  );
}

function classifyCall<P extends ToolCallLike>(
  part: P,
  index: number,
): Omit<ClassifiedToolCall<P>, 'recovered'> {
  const toolName = toolNameOf(part);
  const args = toolDisplayView(part).args;
  const kind = classifyToolCall({ toolName, toolKind: part.toolKind, args });
  const phase = toolCallPhase(part);
  const inProgress = phase === 'running';
  const unresolved = part.state === 'unresolved';
  const awaitingApproval = isToolCallAwaitingApproval(part);
  const denied =
    part.approvalStatus === 'user-denied' ||
    part.approvalStatus === 'policy-denied';
  const cancelled =
    (part.cancelled === true || part.state === 'cancelled') && !denied;
  const failed =
    (Boolean(toolDisplayView(part).error) || part.state === 'error') && !denied;
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

  const tense = pending ? 'pending' : inProgress ? 'running' : 'done';
  const segments: string[] = [];
  for (const kind of KIND_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count === 0) continue;
    // station#1569 (item 3): a batch that includes an unresolved OR proposed
    // call cannot take past or progressive tense — both claim work the
    // expanded rows refuse. It takes the noun inventory; the count badges
    // name which calls did not run.
    const phrase = KIND_PHRASES[kind][tense](count);
    segments.push(
      segments.length === 0 || tense === 'pending'
        ? phrase
        : `${phrase[0]!.toLowerCase()}${phrase.slice(1)}`,
    );
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
  const classified = run.calls.map(({ part, index }) =>
    classifyCall(part, index),
  );
  const recovered = recoveredFailures(
    classified.map((call) => {
      const view = toolDisplayView(call.part);
      return {
        toolName: view.toolName,
        args: view.args,
        failed: call.failed,
        succeeded: call.phase === 'done',
      };
    }),
  );
  const calls: ClassifiedToolCall<P>[] = classified.map((call, position) => ({
    ...call,
    recovered: recovered[position]!,
  }));
  const inProgress = calls.some((c) => c.inProgress);
  const unresolvedCount = calls.filter((c) => c.unresolved).length;
  const awaitingApprovalCount = calls.filter((c) => c.awaitingApproval).length;
  // A call with no observed outcome at all (started, no terminal — the
  // durable projection's `state: 'call'`, e.g. the open turn's running call
  // when the transcript window renders it) cannot take the past tense
  // either: "Ran 2 commands" claimed a command that was still running. A
  // plain failure keeps the past tense; its badge is the disclosure.
  const pending = calls.some(
    (c) =>
      isToolCallBatchPending(c.part) || (c.phase === 'unresolved' && !c.failed),
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
  const failedCount = calls.filter((c) => c.failed && !c.recovered).length;
  const recoveredCount = calls.filter((c) => c.recovered).length;
  const deniedCount = calls.filter((c) => c.denied).length;
  const cancelledCount = calls.filter((c) => c.cancelled).length;
  const progressSource = liveCall;
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
    recoveredCount,
    unresolvedCount,
    awaitingApprovalCount,
    deniedCount,
    cancelledCount,
    progressMessage,
    interludes: run.interludes ?? [],
  };
}
