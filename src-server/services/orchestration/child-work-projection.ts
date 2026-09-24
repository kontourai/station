import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkRegistryState,
  type ChildWorkSessionView,
  childWorkDeltaFromLegacyClaudeTaskNotification,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
  forgetChildWorkReporter,
} from '@kontourai/station-contracts/child-work';
import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { settledChildWorkFromHistory } from './child-work-history.js';

/**
 * #2456: the server's process-local child-work registry.
 *
 * Fed at the projection seam with every live event, it folds
 * `child-work.updated` deltas — and, for pre-#2457 Claude history, the legacy
 * `claude-code` `task/registry` / `task/settled` tuples, through the same
 * contract translator the client uses — through the contract's one reducer,
 * and serves the per-session view that rides on
 * `OrchestrationSessionSummary.childWork.children`.
 * That is what lets the reconnect SNAPSHOT carry the live subagent set: the
 * persisted replay still delivers every delta, but the snapshot fallback only
 * sends session summaries, and before this the set was simply lost there.
 *
 * Running work is process-local, like `TurnProgressTracker`: an engine's
 * children do not survive the adapter process. Durable terminal outcomes are
 * restored separately on cold reads without reviving that running set.
 *
 * #2456 fix round (R2): every engine session gets a view, derived at READ
 * time from the engine capability matrix, not only sessions this process saw
 * report:
 * - `none` engine → `not-reported` with the matrix's reason;
 * - `declared` engine → `reported`, with whatever running set this process
 *   holds — possibly empty. Empty is TRUTHFUL for a session this process
 *   never heard from: an engine's children die with the process that ran
 *   them, so after a restart nothing reported earlier is still running, and
 *   a client holding a stale running child must be told so;
 * - a provider with no matrix entry → no view (no claim either way).
 */
/**
 * Engines whose matrix cell DECLARES subagent signals that Station does not
 * yet map into child work, keyed to the tracking issue. For these the view is
 * `not-reported`: a `reported` view with nothing running would be a claim no
 * Station code derives. `child-work-conformance.test.ts` asserts this set
 * equals the engines whose declared `lifecycle` is a known-gap `test.fails`,
 * so wiring the engine flips that test and forces the entry out.
 */
export const STATION_UNMAPPED_SUBAGENT_ENGINES: Readonly<
  Record<string, string>
> = {};

export interface ChildWorkProjectionOptions {
  /**
   * Called once per child whose fold moves it from `running` to a terminal
   * status, with the provider of the event that settled it. A later
   * correction of that terminal (an `unresolved` the engine's real outcome
   * replaces) is not a second settle and is not reported again.
   */
  onChildSettled?: (item: ChildWorkItem, provider: string) => void;
}

/** How many exited threads the projection remembers (see `exited`). */
const CHILD_WORK_EXITED_THREADS_MAX = 256;

export class ChildWorkProjection {
  private state: ChildWorkRegistryState = createEmptyChildWorkRegistry();
  /** reporterThreadId → createdAt of the last current or durable report. */
  private readonly observedAt = new Map<string, string>();
  private readonly historicalSeeded = new Set<string>();

  /**
   * #2457: bounded set of exited reporters. A late settle remains durable
   * history, but cannot recreate live state after the session ended. A new
   * session.started releases the fence for that thread.
   */
  private readonly exited = new Set<string>();

  constructor(private readonly options: ChildWorkProjectionOptions = {}) {}

  threadsNeedingHistoricalSeed(threadIds: readonly string[]): string[] {
    return threadIds.filter((threadId) => !this.historicalSeeded.has(threadId));
  }

  /** Restore durable terminal outcomes, without reviving pre-restart work. */
  seedHistoricalSettled(
    threadId: string,
    events: readonly CanonicalRuntimeEvent[],
  ): void {
    if (this.historicalSeeded.has(threadId)) return;
    const { settlements, lastReportAt } = settledChildWorkFromHistory(
      threadId,
      events,
    );
    for (const settlement of settlements)
      this.state = applyChildWorkDelta(this.state, settlement);
    if (lastReportAt && !this.observedAt.has(threadId))
      this.observedAt.set(threadId, lastReportAt);
    this.historicalSeeded.add(threadId);
  }

  /** Folds one live event. */
  observe(event: CanonicalRuntimeEvent): void {
    if (event.method === 'session.exited') {
      this.forgetThread(event.threadId);
      this.exited.delete(event.threadId);
      this.exited.add(event.threadId);
      if (this.exited.size > CHILD_WORK_EXITED_THREADS_MAX) {
        const oldest = this.exited.values().next().value;
        if (oldest !== undefined) this.exited.delete(oldest);
      }
      return;
    }
    if (event.method === 'session.started') {
      this.exited.delete(event.threadId);
      return;
    }
    if (this.exited.has(event.threadId)) return;
    const delta =
      event.method === 'child-work.updated'
        ? event.delta
        : event.method === 'extension.notification'
          ? // Replay only: before #2457 the Claude adapter reported through
            // these legacy task tuples; the contract's one translator turns
            // them into the same deltas the client folds.
            childWorkDeltaFromLegacyClaudeTaskNotification(
              event,
              event.threadId,
            )
          : undefined;
    if (!delta) return;
    // A delta names its own reporter; one arriving on another session's
    // thread is not that session's to record.
    const reporter =
      delta.kind === 'upsert'
        ? delta.item.reporterThreadId
        : delta.reporterThreadId;
    if (reporter !== event.threadId) return;
    this.apply(delta, event.createdAt, event.provider);
  }

  /**
   * The session view for `threadId`, whose engine is `provider`. `now` stamps
   * a declared engine's view when this process holds no report of its own:
   * the claim is "nothing running, as observed by this process now".
   */
  read(
    threadId: string,
    provider: string | undefined,
    now: string = new Date().toISOString(),
  ): ChildWorkSessionView | undefined {
    const reported = this.state.notReported[threadId];
    if (reported !== undefined) {
      return { observability: 'not-reported', reason: reported };
    }
    const cell = provider
      ? ENGINE_CAPABILITY_MATRICES[provider]?.subagentObservability
      : undefined;
    if (cell?.state === 'none') {
      return { observability: 'not-reported', reason: cell.reason };
    }
    const unmapped = provider
      ? STATION_UNMAPPED_SUBAGENT_ENGINES[provider]
      : undefined;
    if (cell?.state === 'declared' && unmapped) {
      return {
        observability: 'not-reported',
        reason: `The engine reports subagents, but Station does not map them yet (${unmapped}).`,
      };
    }
    const observedAt = this.observedAt.get(threadId);
    if (observedAt === undefined && cell?.state !== 'declared')
      return undefined;
    const children = childWorkForReporter(this.state, threadId).filter(
      (item) => item.producer === 'engine-subagent',
    );
    const settled = children.filter((item) => item.status !== 'running');
    return {
      observability: 'reported',
      running: children.filter((item) => item.status === 'running'),
      ...(settled.length > 0 ? { settled } : {}),
      observedAt: observedAt ?? now,
    };
  }

  forgetThread(threadId: string): void {
    this.state = forgetChildWorkReporter(this.state, threadId);
    this.observedAt.delete(threadId);
  }

  private apply(
    delta: ChildWorkDelta,
    createdAt: string,
    provider: string,
  ): void {
    const next = applyChildWorkDelta(this.state, delta);
    if (next !== this.state && this.options.onChildSettled) {
      for (const [key, item] of Object.entries(next.items)) {
        if (
          item.status !== 'running' &&
          this.state.items[key]?.status === 'running'
        ) {
          this.options.onChildSettled(item, provider);
        }
      }
    }
    if (delta.kind !== 'not-reported') {
      // Observed even when the fold was a no-op: a repeated snapshot is still
      // a fresh report that the set is what it was.
      this.observedAt.set(
        delta.kind === 'upsert'
          ? delta.item.reporterThreadId
          : delta.reporterThreadId,
        createdAt,
      );
    }
    this.state = next;
  }
}
