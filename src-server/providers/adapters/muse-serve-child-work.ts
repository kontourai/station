import crypto from 'node:crypto';
import {
  applyChildWorkDelta,
  CHILD_WORK_SUMMARY_MAX_CHARS,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkRegistryState,
  type ChildWorkSummarySource,
  type ChildWorkTerminalStatus,
  type ChildWorkUsage,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { ProviderRuntimeEvent as CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { isRecord } from '../../utils/is-record.js';

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
 *
 * Muse Code 1.4.18 adds two sources, mapped here too (live captures in
 * `__tests__/fixtures/muse-serve-1.4.18-workflow-child-steer.jsonl` and
 * `-background-task-stop.jsonl`):
 *
 * - A `subagent` item per child, with `subagentId` equal to the workflow's
 *   `childId`, `workflowRunId`, `depth`, `usage` and, once it reports,
 *   `result.summary`: the child's OWN result, attributed to that child
 *   whatever the workflow's size. A workflow child's lifecycle still comes
 *   from the workflow item; its `subagent` item only adds the result. A
 *   `subagent` item without `workflowRunId` (a native spawn, which this
 *   build's default agent offered no tool for in the captures) is mapped on
 *   its own from the same fields, its terminal from the item's `status`.
 * - A `toolCall` still running when its turn completes is a background task
 *   (`task/list` lists it `executionMode: background`; nothing else on the
 *   item says so). Its row closes as a call that returned, and the task is
 *   child work (`workKind: command`) until the item's own terminal.
 *
 * A running child can be steered with `subagent/sendMessage` (queued, then
 * delivered into the child's next step) and stopped: a subagent with
 * `subagent/stop`, a background task with `task/stop`. Those two id spaces
 * do not mix: muse refuses `task/stop` on a subagent id (`invalid_target`).
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
  /** The reconciliation said every child tool failed (set at completion). */
  allToolsFailed?: boolean;
  toolCallId?: string;
  background: boolean;
  /** childId → the latest revision's entry. */
  children: Map<string, MuseServeWorkflowChild>;
  /**
   * childId → usage accumulated over every revision. A revision restates
   * only what it carries (`completed` and `terminal` have a duration, not
   * the tokens `usage` reported), and revisions after a Station stop still
   * count, so the terminal settle can report the whole figure (#3337).
   */
  usage: Map<string, ChildWorkUsage>;
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
  /** Workflow childId → its own `subagent` item's result summary. */
  subagentSummaries: Map<string, string>;
  /** Open `toolCall`s of live turns, by call id: background candidates. */
  openToolCalls: Map<string, MuseServeOpenToolCall>;
  /** Background task id (the `toolCall` item id) → its call. */
  tasks: Map<string, MuseServeOpenToolCall>;
  closed: boolean;
}

interface MuseServeOpenToolCall {
  itemId: string;
  callId: string;
  tool: string;
  turnId: string;
  title?: string;
  output?: string;
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
    subagentSummaries: new Map(),
    openToolCalls: new Map(),
    tasks: new Map(),
    closed: false,
  };
}

/** Bound on the per-session id maps beside the registry, oldest first. */
const TRACKED_IDS_MAX = 128;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= TRACKED_IDS_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
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
    controls: {
      stop: 'provider-task-stop',
      // `subagent/sendMessage` reaches a running workflow child (live: queued,
      // delivered, and the child's reply carried it, after the launching turn
      // had ended). Offered for as long as the child runs: muse ends that
      // turn at launch, and the adapter declares its children outlive it
      // (`childSteerOutlivesParentTurn`), so orchestration admits the steer
      // without a running parent turn. The launching turn is the token; the
      // send names the child.
      ...(workflow.turnId ? { steer: { turnId: workflow.turnId } } : {}),
    },
  };
}

function settle(
  context: MuseServeChildWorkContext,
  childId: string,
  status: ChildWorkTerminalStatus,
  extra: {
    usage?: ChildWorkUsage;
    summary?: string;
    source?: ChildWorkSummarySource;
  } = {},
): void {
  const summary = extra.summary?.slice(0, CHILD_WORK_SUMMARY_MAX_CHARS + 1);
  const source = extra.source ?? 'provider-summary';
  const changed = emit(context, {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId: context.reporterThreadId,
    childId,
    status,
    ...(summary ? { result: { summary, source } } : {}),
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
      usage: new Map(),
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
  for (const child of listed) {
    workflow.children.set(child.childId, child);
    const reported = usageOf(child);
    if (reported) {
      workflow.usage.set(child.childId, {
        ...workflow.usage.get(child.childId),
        ...reported,
      });
    }
  }

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
    const usage = workflow.usage.get(child.childId);
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
    // The accumulated figure, not the terminal revision's duration alone: a
    // settle reports usage, so a partial one would leave the running token
    // count provisional for good (#3337).
    settle(context, child.childId, status, {
      usage: workflow.usage.get(child.childId),
    });
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
    workflow.allToolsFailed = reconciliation.allToolsFailed;
    for (const child of workflow.children.values()) {
      // The child's own result first; the workflow's summary only when it
      // ran exactly this one child.
      const own = state.subagentSummaries.get(child.childId);
      const summary = workflowChildSummary(
        workflow,
        own ??
          (workflow.children.size === 1 ? reconciliation.summary : undefined),
      );
      enrichSettled(context, child.childId, summary);
    }
  }
}

/** A workflow child's summary, led by the all-tools-failed fact when known. */
function workflowChildSummary(
  workflow: TrackedWorkflow,
  summary: string | undefined,
): string | undefined {
  if (!workflow.allToolsFailed || workflow.children.size !== 1) return summary;
  return [MUSE_CHILD_ALL_TOOLS_FAILED_PREFIX, summary]
    .filter(Boolean)
    .join(' ');
}

/**
 * Enrichment of the settle already recorded: the reducer fills the result a
 * sticky terminal lacked, and never changes its status.
 */
function enrichSettled(
  context: MuseServeChildWorkContext,
  childId: string,
  summary: string | undefined,
): void {
  const current = itemFor(context, childId);
  if (!summary || !current || current.status === 'running') return;
  settle(context, childId, current.status as ChildWorkTerminalStatus, {
    summary,
  });
}

/** The child's own reported result summary, from a `subagent` item. */
function subagentResultSummary(
  item: Record<string, unknown>,
): string | undefined {
  return isRecord(item.result) ? readString(item.result.summary) : undefined;
}

function tokenUsageOf(
  item: Record<string, unknown>,
): ChildWorkUsage | undefined {
  const usage = isRecord(item.usage) ? item.usage : undefined;
  const inputTokens = readCount(usage?.inputTokens);
  const outputTokens = readCount(usage?.outputTokens);
  const durationMs = readCount(item.durationMs);
  const result: ChildWorkUsage = {};
  if (inputTokens !== undefined || outputTokens !== undefined) {
    result.totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }
  if (durationMs !== undefined) result.durationMs = durationMs;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * One revision of a `subagent` item. A workflow child's (it names
 * `workflowRunId`) only contributes its result: the workflow item owns its
 * lifecycle. Any other is a native subagent, mapped from the item alone.
 */
export function observeMuseSubagentItem(
  context: MuseServeChildWorkContext,
  item: Record<string, unknown>,
): void {
  const { state } = context;
  if (state.closed) return;
  const childId = readString(item.subagentId);
  if (!childId) return;
  const summary = subagentResultSummary(item);
  if (readString(item.workflowRunId)) {
    if (!summary) return;
    remember(state.subagentSummaries, childId, summary);
    // A result reported after its workflow completed fills the settle now.
    for (const workflow of state.workflows.values()) {
      if (workflow.completed && workflow.children.has(childId)) {
        enrichSettled(
          context,
          childId,
          workflowChildSummary(workflow, summary),
        );
      }
    }
    return;
  }
  const turnId = readString(item.turnId);
  const existing = itemFor(context, childId);
  const usage = tokenUsageOf(item);
  const status = readString(item.status);
  if (!existing) {
    emit(context, {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: context.reporterThreadId,
      running: [
        ...runningItems(context),
        nativeSubagentItem(context, item, childId, turnId, usage),
      ],
    });
  } else if (existing.status === 'running' && status === 'inProgress') {
    emit(context, {
      kind: 'upsert',
      item: {
        ...nativeSubagentItem(context, item, childId, turnId, usage),
        ...(existing.startedAt ? { startedAt: existing.startedAt } : {}),
      },
    });
  }
  if (!status || status === 'inProgress') return;
  state.stopRequested.delete(childId);
  const failureReason = readString(item.failureReason);
  settle(context, childId, mapMuseChildTerminal(status), {
    ...(usage ? { usage } : {}),
    ...(summary
      ? { summary }
      : failureReason
        ? { summary: failureReason, source: 'provider-error' as const }
        : {}),
  });
}

function nativeSubagentItem(
  context: MuseServeChildWorkContext,
  item: Record<string, unknown>,
  childId: string,
  turnId: string | undefined,
  usage: ChildWorkUsage | undefined,
): ChildWorkItem {
  const role = readString(item.role);
  const objective = readString(item.objective);
  const depth = readCount(item.depth);
  const turnLive = turnId !== undefined && context.isTurnLive(turnId);
  return {
    producer: 'engine-subagent',
    reporterThreadId: context.reporterThreadId,
    childId,
    status: 'running',
    ...(turnId ? { parent: { turnId } } : {}),
    ...(depth !== undefined && depth >= 1 ? { depth } : {}),
    ...((objective ?? role)
      ? { title: (objective ?? role ?? '').slice(0, TITLE_MAX_CHARS) }
      : {}),
    kindLabel: role ? role.slice(0, TITLE_MAX_CHARS) : 'subagent',
    workKind: 'agent',
    backgrounded: !turnLive,
    startedAt: context.nowIso(),
    ...(usage ? { usage } : {}),
    controls: {
      stop: 'provider-task-stop',
      // As for a workflow child: steerable while it runs, its launching turn
      // live or not.
      ...(turnId ? { steer: { turnId } } : {}),
    },
  };
}

function readCommand(args: unknown): string | undefined {
  if (typeof args !== 'string') return undefined;
  try {
    const decoded: unknown = JSON.parse(args);
    return isRecord(decoded) ? readString(decoded.command) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One revision of a `toolCall` item. Returns `true` when the item is a
 * background task's (its row already closed), so the caller does not treat
 * it as a call of the turn.
 */
export function observeMuseToolCallItem(
  context: MuseServeChildWorkContext,
  item: Record<string, unknown>,
): boolean {
  const { state } = context;
  if (state.closed) return false;
  const itemId = readString(item.itemId);
  const callId = readString(item.callId);
  const tool = readString(item.tool);
  const turnId = readString(item.turnId);
  const status = readString(item.status);
  if (!itemId || !callId || !tool) return false;
  const task = state.tasks.get(itemId);
  if (task) {
    if (!status || status === 'inProgress') return true;
    state.tasks.delete(itemId);
    state.stopRequested.delete(itemId);
    const output = readString(item.visibleOutput);
    const failureReason = readString(item.failureReason);
    // The command's own output; for a task that did not complete, muse's
    // reason first.
    const ended =
      status !== 'completed' && failureReason
        ? { summary: failureReason, source: 'provider-error' as const }
        : output
          ? { summary: output, source: 'tool-return' as const }
          : {};
    settle(context, itemId, mapMuseChildTerminal(status), ended);
    return true;
  }
  if (status === 'inProgress' && turnId) {
    const command = readCommand(item.args);
    const title = readString(item.bashTitle) ?? command;
    const output = readString(item.visibleOutput);
    remember(state.openToolCalls, callId, {
      itemId,
      callId,
      tool,
      turnId,
      ...(title ? { title: title.slice(0, TITLE_MAX_CHARS) } : {}),
      ...(output ? { output } : {}),
    });
  } else {
    state.openToolCalls.delete(callId);
  }
  return false;
}

/**
 * The turn `turnId` completed with these calls still open: each one muse is
 * still running is a background task from here on. Returns the calls taken,
 * with the output each returned to the model, so their rows can close as
 * calls that returned rather than as calls whose fate is unknown.
 */
export function adoptMuseBackgroundTasks(
  context: MuseServeChildWorkContext,
  turnId: string,
  openCallIds: Iterable<string>,
): Array<{ callId: string; output?: string }> {
  const { state } = context;
  if (state.closed) return [];
  const adopted: MuseServeOpenToolCall[] = [];
  for (const callId of openCallIds) {
    const call = state.openToolCalls.get(callId);
    if (!call || call.turnId !== turnId) continue;
    state.openToolCalls.delete(callId);
    remember(state.tasks, call.itemId, call);
    adopted.push(call);
  }
  if (adopted.length > 0) {
    emit(context, {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: context.reporterThreadId,
      running: [
        ...runningItems(context),
        ...adopted.map(
          (call): ChildWorkItem => ({
            producer: 'engine-subagent',
            reporterThreadId: context.reporterThreadId,
            childId: call.itemId,
            status: 'running',
            parent: { turnId: call.turnId, toolCallId: call.callId },
            title: call.title ?? call.tool,
            kindLabel: call.tool,
            workKind: 'command',
            backgrounded: true,
            startedAt: context.nowIso(),
            controls: { stop: 'provider-task-stop' },
          }),
        ),
      ],
    });
  }
  return adopted.map((call) => ({
    callId: call.callId,
    ...(call.output ? { output: call.output } : {}),
  }));
}

/** How a running child is stopped: a task by `task/stop`, else a subagent. */
export function museServeChildStopMethod(
  context: MuseServeChildWorkContext,
  childId: string,
): 'task/stop' | 'subagent/stop' {
  return context.state.tasks.has(childId) ? 'task/stop' : 'subagent/stop';
}

/**
 * Whether `childId` can take a steer under `turnId`: a running subagent (a
 * workflow child or a native one, never a background task) whose advertised
 * steer token is that turn.
 */
export function museServeChildSteerable(
  context: MuseServeChildWorkContext,
  childId: string,
  turnId: string,
): boolean {
  if (context.state.tasks.has(childId)) return false;
  const current = itemFor(context, childId);
  return (
    current?.status === 'running' && current.controls?.steer?.turnId === turnId
  );
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
    context.state.subagentSummaries.clear();
    context.state.openToolCalls.clear();
    context.state.tasks.clear();
  }
}
