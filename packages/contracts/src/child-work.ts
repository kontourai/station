/**
 * #2456 (epic #2455): the provider-neutral "child work" contract.
 *
 * A session can have work running underneath it that is not its own turn:
 * a subagent its ENGINE spawned (Claude Code's Task tool), or a delegated task
 * STATION launched on its behalf. Both used to reach clients through
 * unrelated shapes — an opaque `claude-code` extension tuple and a delegate
 * session's metadata — so every consumer re-derived "what is running under
 * this session" twice and the two answers disagreed about terminality.
 *
 * This module is the one vocabulary for both, plus the one pure fold over it.
 * Producers emit `ChildWorkDelta`s; server and client fold them through
 * `applyChildWorkDelta`, so the same log yields the same registry anywhere.
 *
 * Absent means "not reported", never zero or false: a child whose engine sent
 * no usage has no `usage`, and a session whose engine reports nothing about
 * children is `not-reported`, which is a different claim from "reported, and
 * nothing is running".
 */

import {
  isSessionLifecycleState,
  sessionLifecycleOutcome,
} from './session-lifecycle.js';

export const CHILD_WORK_STATUSES = [
  'running',
  'completed',
  'failed',
  'cancelled',
  /** A stop was requested and the engine never confirmed it took effect. */
  'stopped-unconfirmed',
  /**
   * The reporter stopped listing a running child without ever settling it:
   * no outcome was observed. Distinct from `cancelled` (someone stopped it)
   * and `failed` (the engine said it failed).
   */
  'unresolved',
] as const;

export type ChildWorkStatus = (typeof CHILD_WORK_STATUSES)[number];
export type ChildWorkTerminalStatus = Exclude<ChildWorkStatus, 'running'>;

/**
 * Who reports the child. `engine-subagent` is a subagent the engine spawned
 * and reports on itself; `station-delegate` is a delegated task Station
 * launched as its own session.
 */
export type ChildWorkProducer = 'engine-subagent' | 'station-delegate';

/** Bound on a settled child's summary; a longer one is cut and flagged. */
export const CHILD_WORK_SUMMARY_MAX_CHARS = 4_000;

/**
 * Bound on the RUNNING children one reporter may hold, and separately on the
 * settled ones it retains. A reporter listing more than this is not a shape
 * any engine produces; the bound exists so a misbehaving one cannot grow a
 * server-side registry without limit. Settled children beyond the bound are
 * evicted oldest-first.
 */
export const CHILD_WORK_ITEMS_MAX_PER_REPORTER = 64;

export interface ChildWorkParent {
  threadId?: string;
  conversationId?: string;
  turnId?: string;
  /** The engine tool call that spawned the child, when it has one. */
  toolCallId?: string;
  /**
   * The parent as the producer named it. For a Station delegate this is the
   * delegation's `parentTaskId`, carried under its own name rather than
   * asserted to be a thread or conversation id.
   */
  taskId?: string;
}

export interface ChildWorkKey {
  producer: ChildWorkProducer;
  /** The session thread that reported this child. */
  reporterThreadId: string;
  /** Unique within `producer` + `reporterThreadId`. */
  childId: string;
}

/** Accounting for the child alone. Every field is absent when unreported — never 0. */
export interface ChildWorkUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export type ChildWorkResultHandle =
  | { kind: 'transcript-file'; path: string }
  | { kind: 'session'; threadId: string; conversationId?: string };

export interface ChildWorkResult {
  summary?: string;
  /** Present only when `summary` was cut to `CHILD_WORK_SUMMARY_MAX_CHARS`. */
  summaryTruncated?: true;
  handle?: ChildWorkResultHandle;
}

export interface ChildWorkItem extends ChildWorkKey {
  status: ChildWorkStatus;
  parent?: ChildWorkParent;
  /** 1 for a top-level spawn, N+1 inside a depth-N child. Absent when unreported. */
  depth?: number;
  title?: string;
  /** The producer's own name for the kind of child (e.g. a subagent type). */
  kindLabel?: string;
  /** The child outlived (or will outlive) the turn that spawned it. */
  backgrounded?: boolean;
  /** Latest one-line status while running. */
  progress?: string;
  usage?: ChildWorkUsage;
  result?: ChildWorkResult;
  startedAt?: string;
  endedAt?: string;
  /** A stop seam Station has actually wired for this child. */
  controls?: { stop?: 'delegate-interrupt' | 'provider-task-stop' };
}

export type ChildWorkDelta =
  | {
      /**
       * The reporter's complete RUNNING set for `producer`. Authoritative: a
       * running child it omits, with no settle seen, becomes `unresolved`.
       */
      kind: 'snapshot';
      producer: ChildWorkProducer;
      reporterThreadId: string;
      running: ChildWorkItem[];
    }
  | { kind: 'upsert'; item: ChildWorkItem }
  | ({
      kind: 'settle';
      status: ChildWorkTerminalStatus;
      result?: ChildWorkResult;
      usage?: ChildWorkUsage;
      /** Identity a settle can supply when no earlier delta did. */
      identity?: Partial<
        Omit<ChildWorkItem, keyof ChildWorkKey | 'status' | 'result' | 'usage'>
      >;
    } & ChildWorkKey)
  | {
      /** The reporter's engine reports nothing about its children. */
      kind: 'not-reported';
      reporterThreadId: string;
      reason: string;
    };

/**
 * One session's children as a read model. `not-reported` is not an empty
 * `reported`: it says no report can arrive, where an empty `running` says the
 * engine reported and nothing is running.
 */
export type ChildWorkSessionView =
  | { observability: 'reported'; running: ChildWorkItem[]; observedAt: string }
  | { observability: 'not-reported'; reason: string };

/**
 * A session's child work as it rides on the session read model. Two
 * relations, so two members: `children` is what runs UNDER this session (its
 * engine's report, process-local), `asChild` is what this session IS to its
 * parent (a Station delegate, derived from the summary's own folds). One
 * session can carry both.
 */
export interface SessionChildWork {
  children?: ChildWorkSessionView;
  asChild?: ChildWorkItem;
}

export interface ChildWorkRegistryState {
  /** Keyed by `childWorkKey`; insertion ordered. */
  items: Record<string, ChildWorkItem>;
  /** reporterThreadId → why its engine reports no children. */
  notReported: Record<string, string>;
}

export function createEmptyChildWorkRegistry(): ChildWorkRegistryState {
  return { items: {}, notReported: {} };
}

export function childWorkKey(key: ChildWorkKey): string {
  return JSON.stringify([key.producer, key.reporterThreadId, key.childId]);
}

export function isChildWorkTerminalStatus(
  status: ChildWorkStatus,
): status is ChildWorkTerminalStatus {
  return status !== 'running';
}

/**
 * The two terminals that record an ABSENCE of an observed outcome, and so may
 * be corrected by a later real settle. Every other terminal is sticky.
 */
function isCorrectableTerminal(status: ChildWorkStatus): boolean {
  return status === 'unresolved' || status === 'stopped-unconfirmed';
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeUsage(
  usage: ChildWorkUsage | undefined,
): ChildWorkUsage | undefined {
  if (!usage) return undefined;
  const totalTokens = finiteCount(usage.totalTokens);
  const toolUses = finiteCount(usage.toolUses);
  const durationMs = finiteCount(usage.durationMs);
  if (
    totalTokens === undefined &&
    toolUses === undefined &&
    durationMs === undefined
  ) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function normalizeResult(
  result: ChildWorkResult | undefined,
): ChildWorkResult | undefined {
  if (!result) return undefined;
  const summary =
    typeof result.summary === 'string' && result.summary.length > 0
      ? result.summary
      : undefined;
  const truncated =
    summary !== undefined && summary.length > CHILD_WORK_SUMMARY_MAX_CHARS;
  const handle = result.handle;
  if (summary === undefined && !handle) return undefined;
  return {
    ...(summary !== undefined
      ? {
          summary: truncated
            ? summary.slice(0, CHILD_WORK_SUMMARY_MAX_CHARS)
            : summary,
        }
      : {}),
    ...(truncated || (summary !== undefined && result.summaryTruncated)
      ? { summaryTruncated: true as const }
      : {}),
    ...(handle ? { handle } : {}),
  };
}

function normalizeDepth(depth: unknown): number | undefined {
  return typeof depth === 'number' && Number.isFinite(depth) && depth > 0
    ? depth
    : undefined;
}

/** Drops unreported (undefined) members and invalid depth/usage/result. */
function normalizeItem(item: ChildWorkItem): ChildWorkItem {
  const depth = normalizeDepth(item.depth);
  const usage = normalizeUsage(item.usage);
  const result = normalizeResult(item.result);
  const next: ChildWorkItem = {
    producer: item.producer,
    reporterThreadId: item.reporterThreadId,
    childId: item.childId,
    status: item.status,
  };
  if (item.parent) next.parent = item.parent;
  if (depth !== undefined) next.depth = depth;
  if (item.title !== undefined) next.title = item.title;
  if (item.kindLabel !== undefined) next.kindLabel = item.kindLabel;
  if (item.backgrounded !== undefined) next.backgrounded = item.backgrounded;
  if (item.progress !== undefined) next.progress = item.progress;
  if (usage) next.usage = usage;
  if (result) next.result = result;
  if (item.startedAt !== undefined) next.startedAt = item.startedAt;
  if (item.endedAt !== undefined) next.endedAt = item.endedAt;
  if (item.controls?.stop) next.controls = { stop: item.controls.stop };
  return next;
}

/** Fills only the members `base` leaves absent. */
function fillAbsent<T extends object>(
  base: T | undefined,
  extra: T | undefined,
): T | undefined {
  if (!extra) return base;
  if (!base) return extra;
  const next = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && next[key] === undefined) next[key] = value;
  }
  return next as T;
}

/** `over` wins member by member, except where it leaves a member undefined. */
function mergeDefined(
  base: ChildWorkItem | undefined,
  over: ChildWorkItem,
): ChildWorkItem {
  if (!base) return over;
  const next = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) next[key] = value;
  }
  return next as unknown as ChildWorkItem;
}

function sameItem(a: ChildWorkItem | undefined, b: ChildWorkItem): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function reporterItemKeys(
  items: Record<string, ChildWorkItem>,
  reporterThreadId: string,
  predicate: (item: ChildWorkItem) => boolean,
): string[] {
  return Object.keys(items).filter(
    (key) =>
      items[key].reporterThreadId === reporterThreadId && predicate(items[key]),
  );
}

/** Evicts the oldest settled children of a reporter past the retention bound. */
function boundSettled(
  items: Record<string, ChildWorkItem>,
  reporterThreadId: string,
): Record<string, ChildWorkItem> {
  const settled = reporterItemKeys(items, reporterThreadId, (item) =>
    isChildWorkTerminalStatus(item.status),
  );
  const excess = settled.length - CHILD_WORK_ITEMS_MAX_PER_REPORTER;
  if (excess <= 0) return items;
  const next = { ...items };
  for (const key of settled.slice(0, excess)) delete next[key];
  return next;
}

function runningCount(
  items: Record<string, ChildWorkItem>,
  reporterThreadId: string,
): number {
  return reporterItemKeys(
    items,
    reporterThreadId,
    (item) => item.status === 'running',
  ).length;
}

function applySnapshot(
  state: ChildWorkRegistryState,
  delta: Extract<ChildWorkDelta, { kind: 'snapshot' }>,
): ChildWorkRegistryState {
  let items = state.items;
  let changed = false;
  const listed = new Set<string>();
  for (const raw of delta.running.slice(0, CHILD_WORK_ITEMS_MAX_PER_REPORTER)) {
    if (
      raw.producer !== delta.producer ||
      raw.reporterThreadId !== delta.reporterThreadId
    ) {
      continue;
    }
    const key = childWorkKey(raw);
    listed.add(key);
    const existing = items[key];
    // A child already settled is never resurrected by a later listing: the
    // settle is the observed outcome, a snapshot only restates liveness.
    if (existing && existing.status !== 'running') continue;
    const next = normalizeItem({
      ...mergeDefined(existing, raw),
      status: 'running',
    });
    if (sameItem(existing, next)) continue;
    if (!changed) items = { ...items };
    items[key] = next;
    changed = true;
  }
  for (const key of reporterItemKeys(
    items,
    delta.reporterThreadId,
    (item) => item.producer === delta.producer && item.status === 'running',
  )) {
    if (listed.has(key)) continue;
    if (!changed) items = { ...items };
    items[key] = { ...items[key], status: 'unresolved' };
    changed = true;
  }
  if (!changed) return state;
  return {
    ...state,
    items: boundSettled(items, delta.reporterThreadId),
  };
}

function applyUpsert(
  state: ChildWorkRegistryState,
  delta: Extract<ChildWorkDelta, { kind: 'upsert' }>,
): ChildWorkRegistryState {
  if (delta.item.status !== 'running') return state;
  const key = childWorkKey(delta.item);
  const existing = state.items[key];
  if (existing && existing.status !== 'running') return state;
  if (
    !existing &&
    runningCount(state.items, delta.item.reporterThreadId) >=
      CHILD_WORK_ITEMS_MAX_PER_REPORTER
  ) {
    return state;
  }
  const next = normalizeItem(mergeDefined(existing, delta.item));
  if (sameItem(existing, next)) return state;
  return { ...state, items: { ...state.items, [key]: next } };
}

function applySettle(
  state: ChildWorkRegistryState,
  delta: Extract<ChildWorkDelta, { kind: 'settle' }>,
): ChildWorkRegistryState {
  const key = childWorkKey(delta);
  const existing = state.items[key];
  const result = normalizeResult(delta.result);
  const usage = normalizeUsage(delta.usage);
  const identity = delta.identity ?? {};
  let next: ChildWorkItem;
  if (!existing) {
    // Settle before any listing: record the terminal as a tombstone, so a
    // snapshot or upsert arriving later cannot bring the child back.
    next = normalizeItem({
      ...identity,
      producer: delta.producer,
      reporterThreadId: delta.reporterThreadId,
      childId: delta.childId,
      status: delta.status,
      ...(result ? { result } : {}),
      ...(usage ? { usage } : {}),
    });
  } else if (
    existing.status === 'running' ||
    (isCorrectableTerminal(existing.status) &&
      !isCorrectableTerminal(delta.status))
  ) {
    // The settle is the child's latest word: its identity and final usage
    // win over what an earlier listing or progress upsert recorded.
    next = normalizeItem({
      ...mergeDefined(existing, identity as ChildWorkItem),
      // Identity never re-keys the child, whatever the wire carried.
      producer: delta.producer,
      reporterThreadId: delta.reporterThreadId,
      childId: delta.childId,
      status: delta.status,
      result: result ?? existing.result,
      usage: usage ? { ...existing.usage, ...usage } : existing.usage,
    });
  } else {
    // Sticky terminal: a duplicate settle may only fill what is absent.
    next = normalizeItem({
      ...(fillAbsent(existing, identity as ChildWorkItem) ?? existing),
      status: existing.status,
      result: fillAbsent(existing.result, result),
      usage: fillAbsent(existing.usage, usage),
    });
  }
  if (sameItem(existing, next)) return state;
  return {
    ...state,
    items: boundSettled(
      { ...state.items, [key]: next },
      delta.reporterThreadId,
    ),
  };
}

/**
 * The one fold. Pure; a delta that changes nothing returns `state` itself, so
 * callers can skip notifying on reference equality.
 */
export function applyChildWorkDelta(
  state: ChildWorkRegistryState,
  delta: ChildWorkDelta,
): ChildWorkRegistryState {
  switch (delta.kind) {
    case 'snapshot':
      return applySnapshot(state, delta);
    case 'upsert':
      return applyUpsert(state, delta);
    case 'settle':
      return applySettle(state, delta);
    case 'not-reported':
      if (state.notReported[delta.reporterThreadId] === delta.reason)
        return state;
      return {
        ...state,
        notReported: {
          ...state.notReported,
          [delta.reporterThreadId]: delta.reason,
        },
      };
  }
}

/** Every child a reporter holds (running and settled), in insertion order. */
export function childWorkForReporter(
  state: ChildWorkRegistryState,
  reporterThreadId: string,
): ChildWorkItem[] {
  return Object.values(state.items).filter(
    (item) => item.reporterThreadId === reporterThreadId,
  );
}

/** Drops everything a reporter held, e.g. when its session exits. */
export function forgetChildWorkReporter(
  state: ChildWorkRegistryState,
  reporterThreadId: string,
): ChildWorkRegistryState {
  const keys = reporterItemKeys(state.items, reporterThreadId, () => true);
  const hadNotReported = reporterThreadId in state.notReported;
  if (keys.length === 0 && !hadNotReported) return state;
  const items = { ...state.items };
  for (const key of keys) delete items[key];
  const notReported = { ...state.notReported };
  delete notReported[reporterThreadId];
  return { items, notReported };
}

/**
 * The fields of a delegate session's read model a child-work projection
 * needs. Structural, so this contract does not depend on the orchestration
 * summary type (which itself carries child work).
 */
export interface DelegateChildWorkSource {
  threadId: string;
  /** The durable conversation this delegated session belongs to. */
  conversationId?: string;
  createdAt?: string;
  hasActiveTurn?: boolean;
  lifecycleState?: string;
  delegation?: {
    taskId: string;
    parentTaskId?: string;
    title?: string;
    targetId?: string;
    environmentKind?: 'current' | 'ssh' | 'peer';
  };
}

function delegateTerminalStatus(
  lifecycleState: string | undefined,
): ChildWorkTerminalStatus {
  // The one outcome mapping (#2540): a delegate whose turn finished rests
  // `idle`, as completed as the terminal `completed`. No open turn and no
  // recorded outcome: nothing observed says how the child ended.
  return (
    (isSessionLifecycleState(lifecycleState) &&
      sessionLifecycleOutcome(lifecycleState)) ||
    'unresolved'
  );
}

/**
 * A Station-delegated session, as the child work of its parent. Undefined for
 * a session that is not a delegate. A delegate with no `parentTaskId` (a CLI
 * delegation) is a root-level child: it has no `parent`.
 *
 * `controls.stop` is offered only for work running on this Station: a peer
 * record describes a task elsewhere, which a local interrupt cannot reach
 * (the same rule `DelegatedTaskCoordinator` applies to its controls).
 */
export function projectDelegateChildWork(
  summary: DelegateChildWorkSource,
  facts: {
    /**
     * The delegate's nesting depth as its own launch recorded it
     * (`AgentDelegationContext.depth` on the session's metadata). Absent when
     * the launch carried no delegation context — never defaulted to 1.
     */
    depth?: number;
    /**
     * When the delegate's last turn actually ENDED: its terminal turn fact's
     * own time (`turn.completed`/`turn.aborted`/a non-retriable
     * `runtime.error`). Absent when no terminal fact was observed. Never the
     * session's last event time — a restart's `session.started` or a state
     * change after completion is a later event, not a later end (#2459).
     */
    endedAt?: string;
  } = {},
): ChildWorkItem | undefined {
  const delegation = summary.delegation;
  if (!delegation) return undefined;
  const running = summary.hasActiveTurn === true;
  const peer = delegation.environmentKind === 'peer';
  return normalizeItem({
    producer: 'station-delegate',
    reporterThreadId: summary.threadId,
    childId: summary.threadId,
    status: running
      ? 'running'
      : delegateTerminalStatus(summary.lifecycleState),
    ...(delegation.parentTaskId
      ? { parent: { taskId: delegation.parentTaskId } }
      : {}),
    depth: facts.depth,
    ...(delegation.title ? { title: delegation.title } : {}),
    ...(delegation.targetId ? { kindLabel: delegation.targetId } : {}),
    // "Open the full session": the delegate's own session on this Station.
    // A peer record is only a compact local receipt of work running on the
    // other Station, so it names no session to open here.
    ...(peer
      ? {}
      : {
          result: {
            handle: {
              kind: 'session' as const,
              threadId: summary.threadId,
              ...(summary.conversationId
                ? { conversationId: summary.conversationId }
                : {}),
            },
          },
        }),
    ...(summary.createdAt ? { startedAt: summary.createdAt } : {}),
    ...(!running && facts.endedAt ? { endedAt: facts.endedAt } : {}),
    // A peer record is read-only on this Station: the orchestration command
    // gate rejects every command for it (including interruptTurn), and the
    // delegate interrupt route refuses its binding. So no stop is offered.
    ...(peer ? {} : { controls: { stop: 'delegate-interrupt' as const } }),
  });
}

/**
 * Namespace of the pre-contract Claude Code task tuples
 * (`extension.notification` `task/registry` / `task/settled`). Since #2457
 * the adapter emits `child-work.updated` instead; these survive only in
 * persisted history.
 */
export const LEGACY_CLAUDE_TASK_NAMESPACE = 'claude-code';

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The legacy tuple's tool-call statuses; anything else observed no outcome. */
function legacyClaudeTaskStatus(
  status: string | undefined,
): ChildWorkTerminalStatus {
  switch (status) {
    case 'success':
      return 'completed';
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unresolved';
  }
}

/**
 * #2456: the ONE translation from the Claude adapter's legacy task tuples to
 * child work, shared by the server projection and the client so both fold
 * the same deltas. REPLAY ONLY since #2457 moved the adapter onto
 * `child-work.updated`: this is how persisted pre-#2457 history, and cursor
 * replay of it, still reaches the registry. Nothing live emits these tuples.
 *
 * - `task/registry` → an authoritative `snapshot` of the running set.
 * - `task/settled` → a `settle`, carrying whatever identity, result and usage
 *   the tuple has (the #1892 enrichment arrives as a second settle, which the
 *   reducer folds as enrichment).
 *
 * Returns undefined for any other tuple, or a settle naming no task.
 */
export function childWorkDeltaFromLegacyClaudeTaskNotification(
  notification: { namespace: string; type: string; payload: unknown },
  reporterThreadId: string,
): ChildWorkDelta | undefined {
  if (notification.namespace !== LEGACY_CLAUDE_TASK_NAMESPACE) return undefined;
  const payload = asRecord(notification.payload) ?? {};
  if (notification.type === 'task/registry') {
    const running: ChildWorkItem[] = [];
    const active = payload.active;
    for (const entry of Array.isArray(active) ? active : []) {
      const raw = asRecord(entry);
      const taskId = raw ? readString(raw, 'taskId') : undefined;
      if (!raw || !taskId) continue;
      const toolCallId = readString(raw, 'toolCallId');
      const description = readString(raw, 'description');
      const subagentType = readString(raw, 'subagentType');
      running.push(
        normalizeItem({
          producer: 'engine-subagent',
          reporterThreadId,
          childId: taskId,
          status: 'running',
          ...(toolCallId ? { parent: { toolCallId } } : {}),
          ...(description ? { title: description } : {}),
          ...(subagentType ? { kindLabel: subagentType } : {}),
          backgrounded: raw.backgrounded === true,
          depth: raw.spawnDepth as number | undefined,
          // station#1877: the adapter's per-task stop, addressed by the
          // reporting session and this task id.
          controls: { stop: 'provider-task-stop' },
        }),
      );
    }
    return {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId,
      running,
    };
  }
  if (notification.type !== 'task/settled') return undefined;
  const taskId = readString(payload, 'taskId');
  if (!taskId) return undefined;
  const summary = readString(payload, 'summary');
  const outputFile = readString(payload, 'outputFile');
  const toolCallId = readString(payload, 'toolCallId');
  const description = readString(payload, 'description');
  const backgrounded =
    typeof payload.backgrounded === 'boolean'
      ? payload.backgrounded
      : undefined;
  const usage = normalizeUsage(asRecord(payload.usage) as ChildWorkUsage);
  const identity = {
    ...(toolCallId ? { parent: { toolCallId } } : {}),
    ...(description ? { title: description } : {}),
    ...(backgrounded !== undefined ? { backgrounded } : {}),
  };
  return {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId,
    childId: taskId,
    status: legacyClaudeTaskStatus(readString(payload, 'status')),
    ...(summary || outputFile
      ? {
          result: {
            ...(summary ? { summary } : {}),
            ...(outputFile
              ? {
                  handle: {
                    kind: 'transcript-file' as const,
                    path: outputFile,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(usage ? { usage } : {}),
    ...(Object.keys(identity).length > 0 ? { identity } : {}),
  };
}
