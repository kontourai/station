import type { OrchestrationDelegationContext } from '@kontourai/station-contracts/orchestration';
import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * The UI consumes the canonical provider-neutral runtime event contract.
 * Keeping a second hand-written union here previously let persisted recovery
 * events drift beyond what the live Sessions feed could represent.
 */
export type OrchestrationEvent = CanonicalRuntimeEvent extends infer Event
  ? Event extends CanonicalRuntimeEvent
    ? Omit<Event, 'eventId'> & { eventId?: string }
    : never
  : never;

export type OrchestrationSnapshotPayload = {
  sessions: Array<{
    provider: ProviderKind;
    threadId: string;
    status: string;
    /**
     * The read-model's turn-aware activity fold (#1034). `status` is the
     * provider's coarse process state — 'running' means the session process
     * is alive, not that a turn is open. When present and false, a 'running'
     * status must not re-strand the UI in turn-active rendering.
     */
    hasActiveTurn?: boolean;
    model?: string;
    effectiveModel?: string;
    /** Model identity independently reported by the runtime, when available. */
    reportedModel?: string;
    effectiveModelOptions?: Record<string, string | number | boolean>;
    /**
     * station#1301 slice 1: the wire already carries these three fields on
     * every serialized `OrchestrationSessionSummary` (the snapshot route
     * serializes the read-model's session objects verbatim) — this type
     * previously under-declared them. `delegation.parentTaskId` is the
     * delegate→parent-chat binding the background-tasks registry needs to
     * reconcile on reconnect/reload; `createdAt` seeds a delegate card's
     * elapsed timer when no live `session.started` was observed this
     * connection; `lastEventAt` is read as a demoted-entry's fallback
     * `endedAt` when a snapshot demotes a stale running delegate
     * (`hasActiveTurn === false`) with no better terminal timestamp.
     */
    delegation?: OrchestrationDelegationContext;
    createdAt?: string;
    lastEventAt?: string;
  }>;
};
