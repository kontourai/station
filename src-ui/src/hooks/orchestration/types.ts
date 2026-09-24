import type { SessionChildWork } from '@kontourai/station-contracts/child-work';
import type {
  ConversationTurnActivity,
  OrchestrationDelegationContext,
} from '@kontourai/station-contracts/orchestration';
import type { EngineId } from '@kontourai/station-contracts/provider';
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
  /** Durable database identity; absent on older Station servers. */
  epoch?: string;
  sessions: Array<{
    provider: EngineId;
    threadId: string;
    status: string;
    /**
     * The read-model's turn-aware activity fold (archive#1034). `status` is the
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
     * archive#1301: the wire already carries these three fields on
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
    displayTitle?: string;
    lastEventMethod?: CanonicalRuntimeEvent['method'];
    lastRuntimeErrorMessage?: string;
    lastTurnAbortReason?: string;
    /**
     * #2309: the activity of the conversation this row's session belongs
     * to — every execution child, not just this row's. Absent from older
     * servers and for sessions with no conversation lineage.
     */
    conversationActivity?: ConversationTurnActivity;
    /** Current unresolved request ids; present even when empty. */
    openRequestIds?: string[];
    /**
     * #2303: the durable conversation this execution thread belongs to — the
     * root for the root row AND for every `<root>:session:<uuid>`
     * continuation child. Already on the wire
     * (`OrchestrationSessionSummary.conversationId`, folded from the
     * session's own `session.started`/`session.configured` metadata) and
     * previously dropped only by this type. The chat store is keyed by the
     * conversation, so this is how a turn running in a child reaches its chat.
     */
    conversationId?: string;
    /** Durable current execution child, including when it is idle. */
    currentSessionId?: string;
    /** #2456: see `OrchestrationSessionSummary.childWork`. Absent from older servers. */
    childWork?: SessionChildWork;
  }>;
};
