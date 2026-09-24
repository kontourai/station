import crypto from 'node:crypto';
import {
  applyChildWorkDelta,
  CHILD_WORK_SUMMARY_MAX_CHARS,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkRegistryState,
  type ChildWorkTerminalStatus,
  type ChildWorkUsage,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * #2452 (slice 4 of epic #2455): Muse workflow subagents, mapped onto the
 * child-work contract, from what `muse serve` (MSP, Muse Code 1.3.0) actually
 * puts on the wire (live captures in
 * `__tests__/fixtures/muse-serve-1.3.0-*.jsonl`):
 *
 * - A workflow's children appear ONLY as `children[]` on the parent session's
 *   `workflow` item, re-emitted whole on every revision (`item/started`,
 *   `item/updated`, `item/completed`). Each child walks
 *   `scheduled` → `started` → `usage` (token counts) → `completed`/`cancelled`
 *   (`durationMs`, `resultRef`) → `terminal` (`terminal: completed|cancelled`).
 * - There is NO child item stream: nothing reports a child's own tools or
 *   text, so no progress line and no output are mapped.
 * - `subagent/readResult` answers with an ack only. The one result text on
 *   the wire is the workflow's own reconciliation message
 *   (`<workflow-launch-reconciled>{...final_summary.summary...}`), which is a
 *   WORKFLOW summary: it is attributed to a child only when the workflow ran
 *   exactly one child, and to nobody otherwise.
 *
 * Terminal status comes only from the child's `terminal`. A workflow that
 * completes while a child it listed never reported one leaves that child
 * `unresolved`; a Station stop is `stopped-unconfirmed` until the child's real
 * terminal arrives. Nothing defaults to success.
 *
 * A child muse reports `terminal: completed` whose every tool call was denied
 * or failed (`agents_all_tools_failed` in the reconciliation message) is kept
 * `completed` — that is the engine's own verdict, and `failed` in the contract
 * means "the engine said it failed" — but its summary leads with that fact,
 * so it never reads as a clean success.
 */

const PROVIDER = 'muse' as const;
const TITLE_MAX_CHARS = 200;
const WORKFLOW_RECONCILED_OPEN = '<workflow-launch-reconciled>';
const WORKFLOW_RECONCILED_CLOSE = '</workflow-launch-reconciled>';
/** Bound on workflows tracked per session; the oldest settled go first. */
const WORKFLOWS_MAX = 64;

/** Leads a summary whose tools muse reports all failed or were denied. */
export const MUSE_CHILD_ALL_TOOLS_FAILED_PREFIX =
  'Every tool call this subagent made was denied or failed, so its reply is unverified.';

export interface MuseServeWorkflowChild {
  childId: string;
  status: string;
  label?: string;
  durationMs?: number;
  terminal?: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface TrackedWorkflow {
  turnId?: string;
  toolCallId?: string;
  background: boolean;
  /** childId → the latest revision's entry. */
  children: Map<string, MuseServeWorkflowChild>;
  completed: boolean;
}

export interface MuseServeChildWorkState {
  registry: ChildWorkRegistryState;
  /** workflow item id → what its revisions have said. */
  workflows: Map<string, TrackedWorkflow>;
  /** workflowRunId → the `workflow` tool call that launched it. */
  launchCallIds: Map<string, string>;
  /** Children Station asked muse to stop. */
  stopRequested: Set<string>;
  closed: boolean;
}

export interface MuseServeChildWorkContext {
  state: MuseServeChildWorkState;
  reporterThreadId: string;
  nowIso: () => string;
  publish: (event: CanonicalRuntimeEvent) => void;
  /** Whether the turn that launched a workflow is still running. */
  isTurnLive: (turnId: string) => boolean;
}

/** Why an exec session's child work is `not-reported` (#2452). */
export const MUSE_EXEC_CHILD_WORK_NOT_REPORTED_REASON =
  'This Muse session runs through `muse exec`, which reports no subagent identity.';

/**
 * The one child-work fact an exec-fallback session can state: its children
 * are not reported (`muse exec` names no subagent), rather than an empty
 * "nothing running" it never derived. Built here so every muse child-work
 * emission lives in this module.
 */
export function museExecChildWorkNotReportedEvent(input: {
  threadId: string;
  createdAt: string;
}): CanonicalRuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    provider: 'muse',
    threadId: input.threadId,
    createdAt: input.createdAt,
    method: 'child-work.updated',
    delta: {
      kind: 'not-reported',
      reporterThreadId: input.threadId,
      reason: MUSE_EXEC_CHILD_WORK_NOT_REPORTED_REASON,
    },
  };
}

export function createMuseServeChildWorkState(): MuseServeChildWorkState {
  return {
    registry: createEmptyChildWorkRegistry(),
    workflows: new Map(),
    launchCallIds: new Map(),
    stopRequested: new Set(),
    closed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function emit(context: MuseServeChildWorkContext, delta: ChildWorkDelta) {
  const next = applyChildWorkDelta(context.state.registry, delta);
  if (next === context.state.registry) return false;
  context.state.registry = next;
  context.publish({
    eventId: crypto.randomUUID(),
    provider: PROVIDER,
    threadId: context.reporterThreadId,
    createdAt: context.nowIso(),
    method: 'child-work.updated',
    delta,
  });
  return true;
}

function itemFor(
  context: MuseServeChildWorkContext,
  childId: string,
): ChildWorkItem | undefined {
  return childWorkForReporter(
    context.state.registry,
    context.reporterThreadId,
  ).find(
    (item) => item.producer === 'engine-subagent' && item.childId === childId,
  );
}

function runningItems(context: MuseServeChildWorkContext): ChildWorkItem[] {
  return childWorkForReporter(
    context.state.registry,
    context.reporterThreadId,
  ).filter(
    (item) => item.producer === 'engine-subagent' && item.status === 'running',
  );
}

/** Whether any workflow child is still running (host-restart quiescence). */
export function museServeHasRunningChildren(
  context: MuseServeChildWorkContext,
): boolean {
  return runningItems(context).length > 0;
}

/** Whether `childId` is a child this session has seen and not yet settled. */
export function museServeChildIsRunning(
  context: MuseServeChildWorkContext,
  childId: string,
): boolean {
  return itemFor(context, childId)?.status === 'running';
}

function parseChild(value: unknown): MuseServeWorkflowChild | undefined {
  if (!isRecord(value)) return undefined;
  const childId = readString(value.childId);
  const status = readString(value.status);
  if (!childId || !status) return undefined;
  const usage = isRecord(value.usage) ? value.usage : undefined;
  const label = readString(value.label);
  const durationMs = readCount(value.durationMs);
  const terminal = readString(value.terminal);
  const inputTokens = readCount(usage?.inputTokens);
  const outputTokens = readCount(usage?.outputTokens);
  return {
    childId,
    status,
    ...(label ? { label: label.slice(0, TITLE_MAX_CHARS) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(terminal ? { terminal } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/** A child's `terminal` (turn vocabulary, wire-open), as child work. */
function mapMuseChildTerminal(terminal: string): ChildWorkTerminalStatus {
  switch (terminal) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      // A terminal this build does not know: an outcome was reported, but
      // not one Station can name.
      return 'unresolved';
  }
}

function usageOf(child: MuseServeWorkflowChild): ChildWorkUsage | undefined {
  const usage: ChildWorkUsage = {};
  if (child.inputTokens !== undefined || child.outputTokens !== undefined) {
    usage.totalTokens = (child.inputTokens ?? 0) + (child.outputTokens ?? 0);
  }
  if (child.durationMs !== undefined) usage.durationMs = child.durationMs;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The facts the reconciliation message states about the workflow. */
function parseMuseWorkflowReconciliation(message: unknown): {
  summary?: string;
  allToolsFailed: boolean;
} {
  if (typeof message !== 'string') return { allToolsFailed: false };
  const start = message.indexOf(WORKFLOW_RECONCILED_OPEN);
  const end = message.lastIndexOf(WORKFLOW_RECONCILED_CLOSE);
  if (start < 0 || end <= start) return { allToolsFailed: false };
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      message.slice(start + WORKFLOW_RECONCILED_OPEN.length, end),
    );
  } catch {
    return { allToolsFailed: false };
  }
  if (!isRecord(decoded)) return { allToolsFailed: false };
  const finalSummary = isRecord(decoded.final_summary)
    ? decoded.final_summary
    : undefined;
  const summary = readString(finalSummary?.summary);
  const allToolsFailed = (readCount(decoded.agents_all_tools_failed) ?? 0) > 0;
  return { ...(summary ? { summary } : {}), allToolsFailed };
}

/**
 * The `workflowRunId` a completed `workflow` tool call launched, from its own
 * `visibleOutput` (`{"status":"launched","workflowRunId":...}`), so the
 * workflow item can name the call that spawned it.
 */
export function observeMuseWorkflowLaunch(
  context: MuseServeChildWorkContext,
  callId: string,
  visibleOutput: unknown,
): void {
  if (typeof visibleOutput !== 'string') return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(visibleOutput);
  } catch {
    return;
  }
  if (!isRecord(decoded) || decoded.status !== 'launched') return;
  const runId = readString(decoded.workflowRunId);
  if (!runId) return;
  const calls = context.state.launchCallIds;
  if (calls.size >= WORKFLOWS_MAX) {
    const oldest = calls.keys().next().value;
    if (oldest !== undefined) calls.delete(oldest);
  }
  calls.set(runId, callId);
}

function baseItem(
  context: MuseServeChildWorkContext,
  workflow: TrackedWorkflow,
  child: MuseServeWorkflowChild,
): ChildWorkItem {
  const turnLive =
    workflow.turnId !== undefined && context.isTurnLive(workflow.turnId);
  const parent = {
    ...(workflow.turnId ? { turnId: workflow.turnId } : {}),
    ...(workflow.toolCallId ? { toolCallId: workflow.toolCallId } : {}),
  };
  return {
    producer: 'engine-subagent',
    reporterThreadId: context.reporterThreadId,
    childId: child.childId,
    status: 'running',
    ...(Object.keys(parent).length > 0 ? { parent } : {}),
    ...(child.label ? { title: child.label } : {}),
    kindLabel: 'workflow',
    // The child outlives the turn that launched it: the workflow item says
    // so, or that turn has already ended while the child is still listed.
    backgrounded: workflow.background || !turnLive,
    controls: { stop: 'provider-task-stop' },
  };
}

function settle(
  context: MuseServeChildWorkContext,
  childId: string,
  status: ChildWorkTerminalStatus,
  extra: { usage?: ChildWorkUsage; summary?: string } = {},
): void {
  const summary = extra.summary?.slice(0, CHILD_WORK_SUMMARY_MAX_CHARS + 1);
  const changed = emit(context, {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId: context.reporterThreadId,
    childId,
    status,
    ...(summary ? { result: { summary } } : {}),
    ...(extra.usage ? { usage: extra.usage } : {}),
    identity: { endedAt: context.nowIso() },
  });
  if (changed) {
    emit(context, {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: context.reporterThreadId,
      running: runningItems(context),
    });
  }
}

/**
 * One revision of a `workflow` item (`item/started`, `item/updated` or
 * `item/completed`). Each revision restates every child, so the running set
 * is rebuilt from it; a child's `terminal` settles it.
 */
export function observeMuseWorkflowItem(
  context: MuseServeChildWorkContext,
  item: Record<string, unknown>,
): void {
  const { state } = context;
  if (state.closed) return;
  const itemId = readString(item.itemId);
  if (!itemId) return;
  let workflow = state.workflows.get(itemId);
  if (!workflow) {
    if (state.workflows.size >= WORKFLOWS_MAX) {
      for (const [key, candidate] of state.workflows) {
        if (candidate.completed) {
          state.workflows.delete(key);
          break;
        }
      }
    }
    const runId = readString(item.workflowRunId);
    const turnId = readString(item.turnId);
    const toolCallId = runId ? state.launchCallIds.get(runId) : undefined;
    workflow = {
      ...(turnId ? { turnId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      background: item.background === true,
      children: new Map(),
      completed: false,
    };
    state.workflows.set(itemId, workflow);
  }
  if (item.background === true) workflow.background = true;
  const listed = Array.isArray(item.children)
    ? item.children.flatMap((raw) => {
        const child = parseChild(raw);
        return child ? [child] : [];
      })
    : [];
  for (const child of listed) workflow.children.set(child.childId, child);

  const newlyRunning: ChildWorkItem[] = [];
  const usageUpdates: ChildWorkItem[] = [];
  const terminals: MuseServeWorkflowChild[] = [];
  for (const child of listed) {
    const existing = itemFor(context, child.childId);
    if (child.terminal) {
      terminals.push(child);
      continue;
    }
    if (existing && existing.status !== 'running') continue;
    // A revision restates only what it carries (`completed` has a duration,
    // not the tokens `usage` reported), so usage accumulates.
    const reported = usageOf(child);
    const usage =
      reported || existing?.usage
        ? { ...existing?.usage, ...reported }
        : undefined;
    const next: ChildWorkItem = {
      ...baseItem(context, workflow, child),
      ...(existing?.startedAt
        ? { startedAt: existing.startedAt }
        : { startedAt: context.nowIso() }),
      ...(usage ? { usage } : {}),
    };
    if (!existing) newlyRunning.push(next);
    else usageUpdates.push(next);
  }
  if (newlyRunning.length > 0) {
    emit(context, {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: context.reporterThreadId,
      running: [...runningItems(context), ...newlyRunning],
    });
  }
  for (const next of usageUpdates)
    emit(context, { kind: 'upsert', item: next });
  for (const child of terminals) {
    const status = mapMuseChildTerminal(child.terminal ?? '');
    if (!itemFor(context, child.childId)) {
      // Settled before any revision listed it running: register it first so
      // its identity (parent call, kind) is not lost.
      emit(context, {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: context.reporterThreadId,
        running: [
          ...runningItems(context),
          {
            ...baseItem(context, workflow, child),
            startedAt: context.nowIso(),
          },
        ],
      });
    }
    state.stopRequested.delete(child.childId);
    settle(context, child.childId, status, { usage: usageOf(child) });
  }

  const itemStatus = readString(item.status);
  if (itemStatus && itemStatus !== 'inProgress' && !workflow.completed) {
    workflow.completed = true;
    // Children the workflow listed but never reported a terminal for: no
    // outcome was observed. A child Station asked to stop keeps its
    // `stopped-unconfirmed` (the reducer lets a real terminal correct it).
    for (const child of workflow.children.values()) {
      if (child.terminal) continue;
      if (itemFor(context, child.childId)?.status === 'running') {
        settle(context, child.childId, 'unresolved');
      }
    }
    const reconciliation = parseMuseWorkflowReconciliation(item.message);
    if (workflow.children.size === 1) {
      const [only] = workflow.children.values();
      const summary = reconciliation.allToolsFailed
        ? [MUSE_CHILD_ALL_TOOLS_FAILED_PREFIX, reconciliation.summary]
            .filter(Boolean)
            .join(' ')
        : reconciliation.summary;
      const current = itemFor(context, only.childId);
      if (summary && current && current.status !== 'running') {
        // Enrichment of the settle already recorded: the reducer fills the
        // result a sticky terminal lacked, and never changes its status.
        settle(
          context,
          only.childId,
          current.status as ChildWorkTerminalStatus,
          {
            summary,
          },
        );
      }
    }
  }
}

/**
 * A Station stop request that muse admitted. The child reads
 * `stopped-unconfirmed` until its real terminal arrives.
 */
export function recordMuseChildStopRequested(
  context: MuseServeChildWorkContext,
  childId: string,
): void {
  if (context.state.closed) return;
  context.state.stopRequested.add(childId);
  if (itemFor(context, childId)?.status !== 'running') return;
  settle(context, childId, 'stopped-unconfirmed');
}

/**
 * The session (or its host) ended: every child still running can no longer
 * report, so it settles `unresolved`. Idempotent.
 */
export function settleOpenMuseChildren(
  context: MuseServeChildWorkContext,
  options: { close: boolean },
): void {
  if (context.state.closed) return;
  for (const item of runningItems(context)) {
    settle(context, item.childId, 'unresolved');
  }
  if (options.close) {
    context.state.closed = true;
    context.state.workflows.clear();
    context.state.launchCallIds.clear();
    context.state.stopRequested.clear();
  }
}
