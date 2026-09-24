import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkRegistryState,
  type ChildWorkSessionView,
  childWorkDeltaFromLegacyClaudeTaskNotification,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
  forgetChildWorkReporter,
} from '@kontourai/station-contracts/child-work';
import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * #2456: the server's process-local child-work registry.
 *
 * Fed at the projection seam with every live event, it folds
 * `child-work.updated` deltas — and, until #2457, the Claude adapter's legacy
 * `claude-code` `task/registry` / `task/settled` tuples, through the same
 * contract translator the client uses — through the contract's one reducer,
 * and serves the per-session view that rides on
 * `OrchestrationSessionSummary.childWork.children`.
 * That is what lets the reconnect SNAPSHOT carry the live subagent set: the
 * persisted replay still delivers every delta, but the snapshot fallback only
 * sends session summaries, and before this the set was simply lost there.
 *
 * Process-local on purpose, like `TurnProgressTracker`: an engine's children
 * do not survive this process (the adapter holding them dies with it), so a
 * registry rebuilt from the log after a restart would report children
 * nobody is running.
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

export class ChildWorkProjection {
  private state: ChildWorkRegistryState = createEmptyChildWorkRegistry();
  /** reporterThreadId → createdAt of the last child-work delta it reported. */
  private readonly observedAt = new Map<string, string>();

  /** Folds one live event. */
  observe(event: CanonicalRuntimeEvent): void {
    if (event.method === 'session.exited') {
      this.forgetThread(event.threadId);
      return;
    }
    const delta =
      event.method === 'child-work.updated'
        ? event.delta
        : event.method === 'extension.notification'
          ? // Until #2457 the Claude adapter still reports through its legacy
            // task tuples; the contract's one translator turns them into the
            // same deltas the client folds.
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
    this.apply(delta, event.createdAt);
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

  private apply(delta: ChildWorkDelta, createdAt: string): void {
    const next = applyChildWorkDelta(this.state, delta);
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
