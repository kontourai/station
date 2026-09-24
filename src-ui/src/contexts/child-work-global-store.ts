import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkRegistryState,
  childWorkDeltaFromLegacyClaudeTaskNotification,
  createEmptyChildWorkRegistry,
  isChildWorkTerminalStatus,
  type SessionChildWork,
} from '@kontourai/station-contracts/child-work';
import type { OrchestrationEvent } from '../hooks/orchestration/types';

/**
 * #2459: every ENGINE subagent this window has heard about, across every
 * session — not only the ones whose chat is open.
 *
 * The chat registry (`childWorkHandlers.ts`) folds after the dispatcher's
 * `if (!chat) return` guard, so a session with no open chat (a CLI-started
 * delegate, a conversation in another tab) never reaches it. This is a
 * second registry over the SAME contract reducer, fed from the pre-guard
 * seam. It is deliberately separate rather than a pre-guard fold of the chat
 * registry: folding a delta there first would make the post-guard fold a
 * no-op, and that fold is what derives the chat's `backgroundTasks` and
 * speaks the settle announcement.
 *
 * Settled children are HISTORY: a session's exit turns what it still listed
 * as running into `unresolved` (never completed) and keeps them. What was
 * settled before this window connected is not here — a snapshot view lists
 * running children only — which is why the pane labels its finished list
 * "since this window connected".
 */

/** Settled children kept across every reporter, oldest-settled evicted first. */
export const GLOBAL_CHILD_WORK_FINISHED_LIMIT = 50;

/** Reporters whose observability this store remembers, oldest dropped first. */
export const GLOBAL_CHILD_WORK_OBSERVABILITY_LIMIT = 256;

/**
 * What a reporter's SERVER said about its children: it reports them, or it
 * does not (with the server's own reason). Absent means nothing was said.
 */
export type ReporterObservability =
  | { kind: 'reported' }
  | { kind: 'not-reported'; reason: string };

export interface GlobalChildWorkState {
  registry: ChildWorkRegistryState;
  /**
   * childWorkKey → when THIS window observed the child settle (epoch ms).
   * Ordering and eviction only: a settle often carries no `endedAt`, and
   * this is not one — it is never rendered as the child's end time.
   */
  settledObservedAt: Record<string, number>;
  /**
   * reporterThreadId → what its server said about its children. Kept here,
   * not in the reducer's `notReported` (which is never forgotten): a later
   * report replaces an earlier refusal, an exit forgets it, and the map is
   * bounded.
   */
  observability: Record<string, ReporterObservability>;
}

const EMPTY_STATE: GlobalChildWorkState = {
  registry: createEmptyChildWorkRegistry(),
  settledObservedAt: {},
  observability: {},
};

/**
 * #2459 D1: one partition per Station (the apiBase whose stream delivered
 * the events). A stream outlives the pane that ensured it (#2307), so an
 * unpartitioned registry would show Station A's work in Station B's "All".
 */
let partitions: Record<string, GlobalChildWorkState> = {};
/** The partition the running operation works on (operations are sync). */
let current = '';
let state: GlobalChildWorkState = EMPTY_STATE;
const listeners = new Set<() => void>();

function within(apiBase: string, operation: () => void): void {
  current = apiBase;
  state = partitions[apiBase] ?? EMPTY_STATE;
  operation();
}

function eventTime(iso: string | undefined): number {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function commit(next: GlobalChildWorkState): void {
  if (next === state) return;
  state = next;
  partitions = { ...partitions, [current]: next };
  for (const listener of listeners) listener();
}

function withObservability(
  current: GlobalChildWorkState,
  reporterThreadId: string,
  value: ReporterObservability | undefined,
): GlobalChildWorkState {
  const existing = current.observability[reporterThreadId];
  if (
    existing === value ||
    (existing &&
      value &&
      existing.kind === value.kind &&
      (existing.kind === 'reported' ||
        (value.kind === 'not-reported' && existing.reason === value.reason)))
  )
    return current;
  const observability = { ...current.observability };
  delete observability[reporterThreadId];
  if (value) observability[reporterThreadId] = value;
  const keys = Object.keys(observability);
  for (const key of keys.slice(
    0,
    Math.max(0, keys.length - GLOBAL_CHILD_WORK_OBSERVABILITY_LIMIT),
  ))
    delete observability[key];
  return { ...current, observability };
}

function fold(delta: ChildWorkDelta, at: number): void {
  if (delta.kind === 'not-reported') {
    // Not folded into the reducer's never-forgotten `notReported` map.
    commit(
      withObservability(state, delta.reporterThreadId, {
        kind: 'not-reported',
        reason: delta.reason,
      }),
    );
    return;
  }
  // Any engine-subagent report says this reporter's engine DOES report.
  const reporter =
    delta.kind === 'upsert'
      ? delta.item.reporterThreadId
      : delta.reporterThreadId;
  const reported =
    (delta.kind === 'upsert' ? delta.item.producer : delta.producer) ===
    'engine-subagent'
      ? withObservability(state, reporter, { kind: 'reported' })
      : state;
  const before = reported.registry;
  const registry = applyChildWorkDelta(before, delta);
  if (registry === before) {
    commit(reported);
    return;
  }
  commit(stamped(reported, registry, at));
}

/** `base` with `registry`, stamping when this window saw each child settle. */
function stamped(
  base: GlobalChildWorkState,
  registry: ChildWorkRegistryState,
  at: number,
): GlobalChildWorkState {
  let settledObservedAt = base.settledObservedAt;
  for (const [key, item] of Object.entries(registry.items)) {
    if (
      isChildWorkTerminalStatus(item.status) &&
      settledObservedAt[key] === undefined
    ) {
      if (settledObservedAt === base.settledObservedAt)
        settledObservedAt = { ...settledObservedAt };
      settledObservedAt[key] = at;
    }
  }
  return bound({ ...base, registry, settledObservedAt });
}

function bound(next: GlobalChildWorkState): GlobalChildWorkState {
  const settled = Object.keys(next.registry.items)
    .filter((key) => isChildWorkTerminalStatus(next.registry.items[key].status))
    .sort(
      (a, b) =>
        (next.settledObservedAt[a] ?? 0) - (next.settledObservedAt[b] ?? 0),
    );
  const excess = settled.length - GLOBAL_CHILD_WORK_FINISHED_LIMIT;
  const keyed = new Set(Object.keys(next.registry.items));
  const staleStamps = Object.keys(next.settledObservedAt).some(
    (key) => !keyed.has(key),
  );
  if (excess <= 0 && !staleStamps) return next;
  const items = { ...next.registry.items };
  for (const key of settled.slice(0, Math.max(0, excess))) delete items[key];
  const settledObservedAt: Record<string, number> = {};
  for (const [key, at] of Object.entries(next.settledObservedAt))
    if (items[key]) settledObservedAt[key] = at;
  return { ...next, registry: { ...next.registry, items }, settledObservedAt };
}

/**
 * The reporter is gone: every child it still lists as running ends
 * `unresolved` (kept as history), and what its server said about its
 * children is forgotten.
 */
function endReporter(reporterThreadId: string, at: number): void {
  const before = state.registry;
  const registry = applyChildWorkDelta(before, {
    kind: 'snapshot',
    producer: 'engine-subagent',
    reporterThreadId,
    running: [],
  });
  const forgotten = withObservability(state, reporterThreadId, undefined);
  if (registry === before) {
    commit(forgotten);
    return;
  }
  commit(stamped(forgotten, registry, at));
}

const TERMINAL_SESSION_STATES = new Set([
  'completed',
  'aborted',
  'errored',
  'exited',
]);

function deltaReporter(delta: ChildWorkDelta): string {
  return delta.kind === 'upsert'
    ? delta.item.reporterThreadId
    : delta.reporterThreadId;
}

export const childWorkGlobalStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** One Station's partition; a stable reference until it changes. */
  getPartition(apiBase: string): GlobalChildWorkState {
    return partitions[apiBase] ?? EMPTY_STATE;
  },

  /**
   * Called from the dispatcher BEFORE the chat guard, for every live
   * (non-replay) event. Engine subagents only: a Station delegate's own
   * record comes from the session read model, which lists every delegate.
   */
  ingest(apiBase: string, event: OrchestrationEvent): void {
    within(apiBase, () => ingestInto(event));
  },

  /**
   * A FULL connect/reconnect snapshot. Each row's `children` view is folded
   * like a live snapshot delta; a reporter this store holds that the list no
   * longer names is gone, so its running children end `unresolved`.
   */
  reconcileSnapshot(
    apiBase: string,
    sessions: ReadonlyArray<{
      threadId: string;
      childWork?: SessionChildWork;
    }>,
  ): void {
    within(apiBase, () => reconcileInto(sessions));
  },

  /** Test-only. */
  reset(): void {
    partitions = {};
    state = EMPTY_STATE;
  },
};

function ingestInto(event: OrchestrationEvent): void {
  switch (event.method) {
    case 'child-work.updated': {
      // A delta names its own reporter; one on another thread is not that
      // session's to record (the chat registry and server apply the same).
      if (deltaReporter(event.delta) !== event.threadId) return;
      fold(event.delta, eventTime(event.createdAt));
      return;
    }
    case 'extension.notification': {
      const delta = childWorkDeltaFromLegacyClaudeTaskNotification(
        event,
        event.threadId,
      );
      if (delta) fold(delta, eventTime(event.createdAt));
      return;
    }
    case 'session.exited':
      endReporter(event.threadId, eventTime(event.createdAt));
      return;
    case 'session.state-changed':
      if (TERMINAL_SESSION_STATES.has(event.to))
        endReporter(event.threadId, eventTime(event.createdAt));
      return;
    default:
      return;
  }
}

function reconcileInto(
  sessions: ReadonlyArray<{
    threadId: string;
    childWork?: SessionChildWork;
  }>,
): void {
  const at = Date.now();
  for (const session of sessions) {
    const view = session.childWork?.children;
    if (!view) continue;
    fold(
      view.observability === 'not-reported'
        ? {
            kind: 'not-reported',
            reporterThreadId: session.threadId,
            reason: view.reason,
          }
        : {
            kind: 'snapshot',
            producer: 'engine-subagent',
            reporterThreadId: session.threadId,
            running: view.running,
          },
      at,
    );
  }
  const listed = new Set(sessions.map((session) => session.threadId));
  const reporters = new Set([
    ...Object.values(state.registry.items)
      .filter((item) => item.status === 'running')
      .map((item) => item.reporterThreadId),
    ...Object.keys(state.observability),
  ]);
  for (const reporter of reporters)
    if (!listed.has(reporter)) endReporter(reporter, at);
}
