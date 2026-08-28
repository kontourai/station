import type { ConversationContextBoundaryTranscriptMarker } from '@kontourai/station-contracts/conversation-context-boundary';
import type {
  OrchestrationConversationEventWindow,
  OrchestrationSessionDetail,
  OrchestrationSessionEventPage,
  OrchestrationSessionEventWindow,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { ProviderSession } from '../../providers/adapter-shape.js';
import type { EventStore, PersistedRuntimeEvent } from './event-store.js';
import {
  type RequestReplayOutcome,
  replayRequestOutcome,
  type SessionAnswerabilityObservation,
} from './open-requests.js';
// Type-only import back into the service module: erased at runtime, so no
// import cycle exists.
import type { SessionReadScope } from './orchestration-service.js';
import { buildOrchestrationSessionSummary } from './orchestration-session-state.js';
import type { TurnProgressTracker } from './turn-progress-tracker.js';

/** Provider resume state is server-only and can be arbitrarily large. */
function eventWindowSessionSummary(
  summary: OrchestrationSessionSummary,
): OrchestrationSessionSummary {
  const { resumeCursor: _resumeCursor, ...publicSummary } = summary;
  return publicSummary;
}

export interface SessionEventReadsDeps {
  eventStore?: EventStore;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };

  /**
   * PRESERVES A SIDE EFFECT, not just a read: the service's own
   * `listSessions` fans out to every adapter and `trackSession`s each
   * result into the session maps. `readSessionEventPage` discards the
   * return value, which is exactly why the call looks deletable — it is
   * not (seam map C9 trap).
   */
  listSessions: (authority: SessionReadScope) => Promise<ProviderSession[]>;
  hydratePersistedTenantContexts: (
    sessions: readonly ProviderSession[],
  ) => void;
  loadedSessionForThread: (threadId: string) => ProviderSession | undefined;
  canReadSession: (threadId: string, authority: SessionReadScope) => boolean;
  canUserReadSession: (
    threadId: string,
    authority: SessionReadScope,
  ) => boolean;
  readTurnProgress: TurnProgressTracker['read'];
  observeAnswerability: (
    threadId: string,
    provider: string | undefined,
    observedAt: string,
  ) => SessionAnswerabilityObservation;
  readSession: (
    threadId: string,
    authority: SessionReadScope,
  ) => Promise<OrchestrationSessionDetail | null>;
}

/**
 * Event paging & stream replay (epic archive#4024, archive#4155): the C9 cluster
 * from the seam map — owns no fields; reads the session read model, turn
 * progress, and tenant hydration only through deps closures over the live
 * service members. The service keeps flat same-named forwarders with the
 * per-method `initialize()` latch (T9).
 */
export class SessionEventReads {
  constructor(private readonly deps: SessionEventReadsDeps) {}

  /**
   * archive#1284 (HIGH 2): what the PERSISTED log says about one request —
   * the read side of converge-on-read. Replayed from the thread's event
   * store rows through the one shared derivation (`open-requests.ts`), never
   * from a stored status flag and never from having witnessed a live
   * emission, so a consumer can reconcile itself at any moment regardless of
   * what it was or was not subscribed to when the resolution happened. This
   * is `status-function.md`'s posture applied to a second consumer: "there
   * is no stored status field that overrides computation."
   *
   * Synchronous by construction (the event store is synchronous SQLite): the
   * approval inbox calls it during wiring, on a path that must not introduce
   * an await between subscribing and sweeping.
   *
   * Returns `{ state: 'undetermined' }` when there is no event store to
   * read — the honest answer when nothing computed one, and distinct from
   * `unrecorded` ("the log is readable and does not know this request").
   * A consumer holding an irreversible action must treat them differently.
   *
   * TOTAL OVER ITS OWN RETURN TYPE (round-3 review, MEDIUM 1). A failing
   * read — `SQLITE_BUSY`, a corrupt page, a database locked by another
   * process — is `undetermined` by that member's own definition ("no
   * persisted log was readable"), so it is returned rather than thrown. This
   * is reached through a public method on `OrchestrationService` (a flat
   * forwarder) and is part of the approval inbox's `Pick<>` contract: a consumer that reads the four documented
   * states and gets an exception instead is exactly the surprise this
   * function exists to remove. The inbox's sweep also wraps this call, and
   * that stays — belt and braces on a path whose failure mode is a stranded
   * approval card.
   */
  readRequestOutcome(
    threadId: string,
    requestId: string,
  ): RequestReplayOutcome {
    const eventStore = this.deps.eventStore;
    if (!eventStore) return { state: 'undetermined' };
    try {
      return replayRequestOutcome(
        eventStore
          .listEventsForRequest(threadId, requestId)
          .map((event) => event.payload),
        requestId,
      );
    } catch (error) {
      this.deps.logger.warn(
        'Could not read the persisted log for a request outcome',
        {
          threadId,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return { state: 'undetermined' };
    }
  }

  async readSessionEventPage(
    threadId: string,
    options: {
      afterSequence: number;
      limit: number;
      authority: SessionReadScope;
    },
  ): Promise<OrchestrationSessionEventPage | null> {
    await this.deps.listSessions(INTERNAL_SESSION_READ_SCOPE);

    const persistedSessions = this.deps.eventStore?.readSessions() ?? [];
    this.deps.hydratePersistedTenantContexts(persistedSessions);
    const persisted = persistedSessions.find(
      (session) => session.threadId === threadId,
    );
    const loaded = this.deps.loadedSessionForThread(threadId);
    if (!persisted && !loaded) return null;

    const projectionEvents =
      this.deps.eventStore?.listSessionProjectionEvents(threadId) ?? [];
    if (!this.deps.canReadSession(threadId, options.authority)) {
      return null;
    }
    const page = this.deps.eventStore?.listEventPage(threadId, options) ?? {
      events: [],
      hasMore: false,
      nextSequence: options.afterSequence,
    };
    return {
      session: buildOrchestrationSessionSummary({
        persisted,
        loaded,
        events: projectionEvents.map((event) => event.payload),
        eventCount: this.deps.eventStore?.countEventsByThread(threadId),
        turnProgress: this.deps.readTurnProgress(threadId),
        answerability: this.deps.observeAnswerability(
          threadId,
          (loaded ?? persisted)?.provider,
          new Date().toISOString(),
        ),
      }),
      events: page.events.map((event) => ({
        sequence: event.sequence,
        event: event.payload,
      })),
      hasMore: page.hasMore,
      nextSequence: page.nextSequence,
    };
  }

  async readSessionEventWindow(
    threadId: string,
    options: {
      cursor?: string;
      turnLimit: number;
      authority: SessionReadScope;
      signal?: AbortSignal;
    },
  ): Promise<OrchestrationSessionEventWindow | null> {
    options.signal?.throwIfAborted();
    const persisted = this.deps.eventStore?.readSessionByThread(threadId);
    options.signal?.throwIfAborted();
    if (persisted) this.deps.hydratePersistedTenantContexts([persisted]);
    const loaded = this.deps.loadedSessionForThread(threadId);
    options.signal?.throwIfAborted();
    if (
      (!persisted && !loaded) ||
      !this.deps.canReadSession(threadId, options.authority)
    ) {
      return null;
    }
    const window = this.deps.eventStore?.listEventWindowByTurn(
      threadId,
      options,
    ) ?? {
      events: [],
      hasMore: false,
      watermark: 0,
    };
    options.signal?.throwIfAborted();
    // The window is the bounded conversation payload. Its tail cannot also
    // stand in for the authoritative session summary: bindings and policy
    // facts may be older than the requested turn window.
    const projectionEvents =
      this.deps.eventStore?.listSessionProjectionEvents(threadId) ?? [];
    options.signal?.throwIfAborted();
    const fullSession = buildOrchestrationSessionSummary({
      persisted,
      loaded,
      events: projectionEvents.map((event) => event.payload),
      eventCount: this.deps.eventStore?.countEventsByThread(threadId),
      turnProgress: this.deps.readTurnProgress(threadId),
      answerability: this.deps.observeAnswerability(
        threadId,
        (loaded ?? persisted)?.provider,
        new Date().toISOString(),
      ),
    });
    // An event-window hydration never sends a provider cursor back to an
    // adapter; the client needs identity/lifecycle metadata and the events.
    // Keep opaque provider state out of this bounded recovery response.
    return {
      protocolVersion: 1,
      session: eventWindowSessionSummary(fullSession),
      events: window.events.map((event) => ({
        sequence: event.sequence,
        event: event.payload,
        // archive#3386: the read's own budget report. Dropping it here is
        // what made the elision silent — the client receives identity fields
        // and no way to tell a withheld payload from an absent one.
        ...(event.elided ? { elided: event.elided } : {}),
      })),
      hasMore: window.hasMore,
      ...(window.nextCursor ? { nextCursor: window.nextCursor } : {}),
      watermark: window.watermark,
    };
  }

  /**
   * Read a durable conversation without changing the identity of any runtime
   * event. Child sessions keep their own event cursors/endpoints; this is the
   * explicitly conversation-shaped transcript projection used by chat reload.
   */
  async readConversationEventWindow(
    conversationId: string,
    options: {
      cursor?: string;
      turnLimit: number;
      authority: SessionReadScope;
      signal?: AbortSignal;
    },
  ): Promise<OrchestrationConversationEventWindow | null> {
    options.signal?.throwIfAborted();
    const lineages =
      this.deps.eventStore?.conversationSessions(conversationId) ?? [];
    options.signal?.throwIfAborted();
    // A pre-lineage record is still a one-session conversation.
    if (lineages.length === 0) {
      // An id already linked beneath another conversation is a child Session,
      // never a legacy conversation alias. Returning its transcript here
      // would split one durable conversation and bypass conversation-bound
      // authorization/aggregation.
      if (this.deps.eventStore?.conversationForSession(conversationId)) {
        return null;
      }
      const legacy = await this.readSessionEventWindow(conversationId, options);
      return legacy
        ? {
            ...legacy,
            conversationId,
            currentSessionId: conversationId,
            handoffs: [],
            contextBoundaries: [],
          }
        : null;
    }

    // Authorization is conversation-bound and fail-closed: an owner/tenant
    // that cannot read every linked execution session gets no partial
    // transcript or lineage disclosure.
    const details: Array<
      Awaited<ReturnType<(typeof this.deps)['readSession']>>
    > = [];
    for (const lineage of lineages) {
      options.signal?.throwIfAborted();
      details.push(
        await this.deps.readSession(lineage.sessionId, options.authority),
      );
      options.signal?.throwIfAborted();
    }
    const currentLineage = lineages.at(-1)!;
    const missingIndex = details.indexOf(null);
    const missingOnlyLatestSuccessor =
      missingIndex === details.length - 1 &&
      currentLineage.predecessorSessionId !== undefined &&
      this.deps.eventStore?.readSessionByThread(currentLineage.sessionId) ===
        undefined &&
      this.deps.loadedSessionForThread(currentLineage.sessionId) ===
        undefined &&
      this.isActiveUnmaterializedConversationSuccessor(
        conversationId,
        currentLineage.sessionId,
        currentLineage.predecessorSessionId,
      );
    // An active reservation appends its child before a provider Session
    // exists. Fold that exact latest child through its already-authorized
    // predecessor for transcript reads, while retaining the child as the
    // conversation's current identity. Any other absent lineage member stays
    // fail-closed: it is not evidence that the predecessor is authorized.
    if (missingIndex !== -1 && !missingOnlyLatestSuccessor) return null;
    const current = missingOnlyLatestSuccessor
      ? details.at(-2)!
      : details.at(-1)!;
    const window = this.deps.eventStore!.listConversationEventWindowByTurn(
      lineages.map((lineage) => lineage.sessionId),
      options,
    );
    options.signal?.throwIfAborted();
    const contextBoundaries: ConversationContextBoundaryTranscriptMarker[] =
      this.deps
        .eventStore!.listConversationContextBoundaries(conversationId)
        .flatMap((marker) =>
          marker.status === 'consumed' && marker.consumedAt
            ? [
                {
                  boundaryId: marker.boundaryId,
                  successorSessionId: marker.successorSessionId,
                  policy: marker.policy,
                  priorTranscriptInjected:
                    marker.policy === 'continue-from-history',
                  consumedAt: marker.consumedAt,
                },
              ]
            : [],
        );
    options.signal?.throwIfAborted();
    return {
      protocolVersion: 1,
      conversationId,
      currentSessionId: lineages.at(-1)!.sessionId,
      // The bounded event page may omit a session's configuration event. Its
      // durable session summary is the per-turn Agent lineage, so a renderer
      // never substitutes the latest handoff target for an older answer. A
      // reserved-but-unmaterialized successor intentionally has no Agent
      // claim; its row must degrade to unknown rather than borrow its parent.
      sessionLineage: lineages.map((lineage, index) => {
        const detail = details[index];
        const presentation = this.deps.eventStore?.sessionAgentPresentation(
          lineage.sessionId,
        );
        return {
          sessionId: lineage.sessionId,
          ...(detail?.session.assignedAgentSlug
            ? { agentSlug: detail.session.assignedAgentSlug }
            : {}),
          ...presentation,
        };
      }),
      handoffs: this.deps
        .eventStore!.listConversationHandoffs(conversationId)
        .map((marker) => {
          const disclosure = this.deps.eventStore!.describeConversationHandoff(
            marker,
            'existing',
          );
          return {
            predecessorSessionId: marker.predecessorSessionId,
            sessionId: marker.sessionId,
            idempotencyKey: marker.idempotencyKey,
            targetAgentId: marker.targetAgentId,
            ...(marker.targetConnectionId
              ? { targetConnectionId: marker.targetConnectionId }
              : {}),
            ...(marker.targetModelId
              ? { targetModelId: marker.targetModelId }
              : {}),
            createdAt: marker.createdAt,
            carried: disclosure.carried,
            reset: disclosure.reset,
          };
        }),
      contextBoundaries,
      session: eventWindowSessionSummary(current!.session),
      events: window.events.map((event) => ({
        // The global sequence is stable across child sessions. It orders this
        // conversation projection without changing the event's child
        // `threadId`, which remains the endpoint/provenance identity.
        sequence: event.globalSequence,
        event: event.payload,
        ...(event.elided ? { elided: event.elided } : {}),
      })),
      hasMore: window.hasMore,
      ...(window.nextCursor ? { nextCursor: window.nextCursor } : {}),
      watermark: window.watermark,
    };
  }

  private isActiveUnmaterializedConversationSuccessor(
    conversationId: string,
    successorSessionId: string,
    predecessorSessionId: string,
  ): boolean {
    const store = this.deps.eventStore;
    if (!store) return false;
    const boundary =
      store.conversationContextBoundaryForSuccessor(successorSessionId);
    if (
      boundary &&
      boundary.conversationId === conversationId &&
      boundary.predecessorSessionId === predecessorSessionId &&
      boundary.successorSessionId === successorSessionId &&
      ['reserved', 'claimed', 'failed', 'indeterminate'].includes(
        boundary.status,
      )
    )
      return true;
    const handoff = store.conversationHandoffForSession(successorSessionId);
    return Boolean(
      handoff &&
        handoff.conversationId === conversationId &&
        handoff.predecessorSessionId === predecessorSessionId &&
        handoff.sessionId === successorSessionId,
    );
  }

  /**
   * Current global-sequence head of the orchestration event stream
   * (archive#1092) — what a fresh `orchestration:snapshot` frame advertises
   * as its resume cursor, and the reference point a reconnecting client's
   * `Last-Event-ID` cursor is compared against to decide replay vs snapshot.
   */
  readEventStreamHead(): number {
    return this.deps.eventStore?.headGlobalSequence() ?? 0;
  }

  /**
   * The global-sequence cursor already assigned to a persisted event, keyed
   * by its canonical `eventId` (archive#1092). Used to set the SSE `id:` on
   * a live-forwarded frame — the event is already durably persisted by the
   * time an `EventBus` subscriber runs.
   */
  readEventGlobalSequence(eventId: string): number | undefined {
    return this.deps.eventStore?.readGlobalSequence(eventId);
  }

  /**
   * Ordered replay of events after a reconnecting client's global-sequence
   * cursor, optionally scoped to one thread (archive#1092 resume path).
   *
   * archive#1197: the raw store query has no ownership predicate (it's a
   * plain `global_sequence > ? [AND thread_id = ?]` scan), so this is the
   * single chokepoint for both `/events` replay branches (thread-scoped and
   * global) to apply the SAME per-event authorization gate the live path
   * already applies at `orchestration.ts:879` — `canUserReadSession`, same
   * argument order, same `ownerlessSessionAccess` treatment. Without this, a
   * caller could replay another user's full persisted history simply by
   * reconnecting with a stale `Last-Event-ID`.
   */
  readEventStreamReplay(
    afterGlobalSequence: number,
    options: { threadId?: string; limit: number },
    authority: SessionReadScope,
  ): PersistedRuntimeEvent[] {
    const candidates =
      this.deps.eventStore?.listEventsAfterGlobalSequence(
        afterGlobalSequence,
        options,
      ) ?? [];
    return candidates.filter((persisted) =>
      this.deps.canUserReadSession(persisted.threadId, authority),
    );
  }

  readEventStreamReplayPlan(
    afterGlobalSequence: number,
    options: { threadId?: string; limit: number; maxSerializedBytes: number },
    authority: SessionReadScope,
  ): { count: number; fitsBudget: boolean } {
    let bytes = 0;
    let count = 0;
    for (const candidate of this.deps.eventStore?.listEventReplayDescriptors(
      afterGlobalSequence,
      options,
    ) ?? []) {
      if (!this.deps.canUserReadSession(candidate.threadId, authority))
        continue;
      count += 1;
      bytes += candidate.serializedFrameBytes;
      if (bytes > options.maxSerializedBytes)
        return { count, fitsBudget: false };
    }
    return { count, fitsBudget: true };
  }
}
