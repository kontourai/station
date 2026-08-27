import type {
  OrchestrationSessionDetail,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  InternalSessionReadScope,
  SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import {
  foldedSessionLifecycleState,
  type SessionLifecycleState,
  type SessionTransitionReason,
  type SessionTransitionSource,
  validateSessionLifecycleTransition,
} from '../../../packages/contracts/src/session-lifecycle.js';
import type { SessionExecutionCoordinator } from './session-execution-coordinator.js';

type SessionReadScope = SessionReadAuthority | InternalSessionReadScope;

import {
  activeTurnIdForEvents,
  createManualSessionTransitionEvent,
} from './session-lifecycle-service.js';

export type SessionLifecycleTransitionInput = {
  threadId: string;
  authority: SessionReadScope;
  to: SessionLifecycleState;
  reason?: SessionTransitionReason;
  source?: SessionTransitionSource;
  message?: string;
};

type CompletionPreparation = {
  apply(events: CanonicalRuntimeEvent[]): void;
};

export interface SessionLifecycleDependencies {
  coordinator: SessionExecutionCoordinator;
  initialize(): void;
  isReadOnlyAttached(threadId: string): boolean;
  attachedReadOnlyMessage: string;
  readSession(
    threadId: string,
    authority: SessionReadScope,
  ): Promise<OrchestrationSessionDetail | null>;
  prepareCompletion(input: {
    threadId: string;
    provider: OrchestrationSessionSummary['provider'];
    events: CanonicalRuntimeEvent[];
    fromState: SessionLifecycleState;
  }): Promise<CompletionPreparation>;
  publish(event: CanonicalRuntimeEvent): void;
  latestStateEventAt(
    threadId: string,
    state: SessionLifecycleState,
  ): string | undefined;
  observeTransition(input: {
    from: SessionLifecycleState;
    to: SessionLifecycleState;
    provider: OrchestrationSessionSummary['provider'];
    source: SessionTransitionSource;
    reason: SessionTransitionReason;
    outcome: string;
  }): void;
  observeBoardAction(input: {
    action: SessionLifecycleState;
    outcome: string;
    state: SessionLifecycleState | 'unknown';
  }): void;
  observeStateDuration(input: {
    previousState: SessionLifecycleState;
    nextEventAt: string;
    previousEventAt?: string;
    provider: OrchestrationSessionSummary['provider'];
  }): void;
}

/**
 * The public lifecycle mutation Interface. It owns authority, transition
 * validation, completion gates, post-gate revalidation, exact publication,
 * and serialization against provider turn startup for one thread.
 */
export interface SessionLifecycleModule {
  transition(
    input: SessionLifecycleTransitionInput,
  ): Promise<OrchestrationSessionSummary>;
}

function observe(operation: () => void): void {
  try {
    operation();
  } catch {
    // Metrics and diagnostics cannot decide an authoritative transition.
  }
}

export function createSessionLifecycleModule(
  deps: SessionLifecycleDependencies,
): SessionLifecycleModule {
  return {
    async transition(input) {
      deps.initialize();
      return deps.coordinator.runLifecycleTransition(
        input.threadId,
        async () => {
          if (deps.isReadOnlyAttached(input.threadId)) {
            throw new Error(deps.attachedReadOnlyMessage);
          }
          let detail = await deps.readSession(input.threadId, input.authority);
          if (!detail) {
            observe(() =>
              deps.observeBoardAction({
                action: input.to,
                outcome: 'not_found',
                state: 'unknown',
              }),
            );
            throw new Error(`Session not found: ${input.threadId}`);
          }
          const from = foldedSessionLifecycleState(
            detail.session.lifecycleState,
          );
          const validation = validateSessionLifecycleTransition(from, input.to);
          if (!validation.ok) {
            observe(() =>
              deps.observeTransition({
                from,
                to: input.to,
                provider: detail!.session.provider,
                source: input.source ?? 'user_action',
                reason: input.reason ?? 'manual_update',
                outcome: validation.code,
              }),
            );
            observe(() =>
              deps.observeBoardAction({
                action: input.to,
                outcome: validation.code,
                state: from,
              }),
            );
            throw new Error(validation.message ?? validation.code);
          }

          if (input.to === 'completed') {
            assertNoActiveTurn(deps, input.threadId, detail.events);
            const completion = await deps.prepareCompletion({
              threadId: input.threadId,
              provider: detail.session.provider,
              events: detail.events,
              fromState: from,
            });
            const revalidated = await deps.readSession(
              input.threadId,
              input.authority,
            );
            if (!revalidated) {
              throw new Error(`Session not found: ${input.threadId}`);
            }
            const revalidatedFrom = foldedSessionLifecycleState(
              revalidated.session.lifecycleState,
            );
            if (revalidatedFrom !== from) {
              throw new Error(
                `Session changed while completion gates were evaluated: ${input.threadId}`,
              );
            }
            const revalidation = validateSessionLifecycleTransition(
              revalidatedFrom,
              input.to,
            );
            if (!revalidation.ok) {
              throw new Error(revalidation.message ?? revalidation.code);
            }
            assertNoActiveTurn(deps, input.threadId, revalidated.events);
            detail = revalidated;
            completion.apply(revalidated.events);
          }

          const event = createManualSessionTransitionEvent({
            provider: detail.session.provider,
            threadId: input.threadId,
            from,
            to: input.to,
            reason: input.reason ?? 'manual_update',
            source: input.source ?? 'user_action',
            message: input.message,
          });
          deps.publish(event);
          observe(() =>
            deps.observeTransition({
              from,
              to: input.to,
              provider: detail!.session.provider,
              source: input.source ?? 'user_action',
              reason: input.reason ?? 'manual_update',
              outcome: 'success',
            }),
          );
          observe(() =>
            deps.observeStateDuration({
              previousState: from,
              nextEventAt: event.createdAt,
              previousEventAt: deps.latestStateEventAt(input.threadId, from),
              provider: detail!.session.provider,
            }),
          );
          observe(() =>
            deps.observeBoardAction({
              action: input.to,
              outcome: 'success',
              state: from,
            }),
          );

          const next = await deps.readSession(input.threadId, input.authority);
          if (!next) {
            throw new Error(
              `Session not found after transition: ${input.threadId}`,
            );
          }
          return next.session;
        },
      );
    },
  };
}

function assertNoActiveTurn(
  deps: SessionLifecycleDependencies,
  threadId: string,
  events: CanonicalRuntimeEvent[],
): void {
  if (
    deps.coordinator.hasActiveTurn(threadId) ||
    activeTurnIdForEvents(events)
  ) {
    throw new Error(`Session has an active turn: ${threadId}`);
  }
}
