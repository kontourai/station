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
 * `not-reported` is recorded from the engine capability matrix when a session
 * starts on an engine whose `subagentObservability` is `none`. A provider with
 * no matrix entry gets no claim either way.
 */
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
    if (event.method === 'session.started') {
      const observability =
        ENGINE_CAPABILITY_MATRICES[event.provider]?.subagentObservability;
      if (observability?.state === 'none') {
        this.apply(
          {
            kind: 'not-reported',
            reporterThreadId: event.threadId,
            reason: observability.reason,
          },
          event.createdAt,
        );
      }
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

  read(threadId: string): ChildWorkSessionView | undefined {
    const reason = this.state.notReported[threadId];
    if (reason !== undefined) {
      return { observability: 'not-reported', reason };
    }
    const observedAt = this.observedAt.get(threadId);
    if (observedAt === undefined) return undefined;
    return {
      observability: 'reported',
      running: childWorkForReporter(this.state, threadId).filter(
        (item) =>
          item.producer === 'engine-subagent' && item.status === 'running',
      ),
      observedAt,
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
