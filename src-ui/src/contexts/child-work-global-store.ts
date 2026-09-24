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

export interface GlobalChildWorkState {
  registry: ChildWorkRegistryState;
  /**
   * childWorkKey → when THIS window observed the child settle (epoch ms).
   * Ordering and eviction only: a settle often carries no `endedAt`, and
   * this is not one — it is never rendered as the child's end time.
   */
  settledObservedAt: Record<string, number>;
}

const EMPTY_STATE: GlobalChildWorkState = {
  registry: createEmptyChildWorkRegistry(),
  settledObservedAt: {},
};

let state: GlobalChildWorkState = EMPTY_STATE;
const listeners = new Set<() => void>();

function eventTime(iso: string | undefined): number {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function fold(delta: ChildWorkDelta, at: number): void {
  const before = state.registry;
  const registry = applyChildWorkDelta(before, delta);
  if (registry === before) return;
  let settledObservedAt = state.settledObservedAt;
  for (const [key, item] of Object.entries(registry.items)) {
    if (
      isChildWorkTerminalStatus(item.status) &&
      settledObservedAt[key] === undefined
    ) {
      if (settledObservedAt === state.settledObservedAt)
        settledObservedAt = { ...settledObservedAt };
      settledObservedAt[key] = at;
    }
  }
  state = bound({ registry, settledObservedAt });
  for (const listener of listeners) listener();
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
  return { registry: { ...next.registry, items }, settledObservedAt };
}

/** Ends every child a reporter still lists as running: `unresolved`, kept. */
function endReporter(reporterThreadId: string, at: number): void {
  fold(
    {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId,
      running: [],
    },
    at,
  );
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

  getSnapshot(): GlobalChildWorkState {
    return state;
  },

  /**
   * Called from the dispatcher BEFORE the chat guard, for every live
   * (non-replay) event. Engine subagents only: a Station delegate's own
   * record comes from the session read model, which lists every delegate.
   */
  ingest(event: OrchestrationEvent): void {
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
  },

  /**
   * A FULL connect/reconnect snapshot. Each row's `children` view is folded
   * like a live snapshot delta; a reporter this store holds that the list no
   * longer names is gone, so its running children end `unresolved`.
   */
  reconcileSnapshot(
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
    const reporters = new Set(
      Object.values(state.registry.items)
        .filter((item) => item.status === 'running')
        .map((item) => item.reporterThreadId),
    );
    for (const reporter of reporters)
      if (!listed.has(reporter)) endReporter(reporter, at);
  },

  /** Test-only. */
  reset(): void {
    state = EMPTY_STATE;
  },
};
