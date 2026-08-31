import crypto from 'node:crypto';
import type {
  ConversationContextBoundaryProjection,
  ConversationContextBoundaryRequest,
} from '@kontourai/station-contracts/conversation-context-boundary';
import type {
  ConversationHandoffStatusProjection,
  ConversationListItem,
  OrchestrationSessionDetail,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import type { EngineId } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { isSessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import {
  foldedSessionLifecycleState,
  isSessionLifecycleStateStopped,
} from '../../../packages/contracts/src/session-lifecycle.js';
import { safeSanitizeUIBlockEventProvenance } from '../../runtime/conversation/ui-block-provenance.js';
import { conversationContinuationOutcomes } from '../../telemetry/metrics.js';
import { projectConversationContextBoundary } from './conversation-context-boundary-module.js';
import {
  type ConversationHistoryPage,
  type ConversationHistoryReadService,
  deduplicateConversationItems,
} from './conversation-history-read-service.js';
import type { ConversationForkProvenance, EventStore } from './event-store.js';
// Type-only import back into the service module: erased at runtime, so no
// import cycle exists.
import type { SessionReadScope } from './orchestration-service.js';
import type { TurnDeduplicator } from './turn-deduplicator.js';

const CONVERSATION_HISTORY_MAX_ENTRIES = 100;

/**
 * Read-only companion to resolveConversationContinuation. It intentionally
 * does not reserve a successor: it answers only whether that command would
 * be admissible for the current child rather than treating terminal lifecycle
 * as a permanent read-only state.
 */
export function isConversationContinuationControlEligible(
  detail: OrchestrationSessionDetail,
): boolean {
  const session = detail.session;
  if (
    session.controlMode !== 'station-owned' ||
    session.pendingReview === true
  ) {
    return false;
  }
  if (session.answerability.answerable) return true;
  // #834: `answerable: false` + `past_resume` is the steady state of every
  // stopped/finished, unloaded current child — the answerability contract
  // itself warns it speaks only about answering an open request on the
  // CURRENT child in THIS process. Continuation never does that: for a
  // stopped child it reserves a successor (the stopped-predecessor branch of
  // resolveConversationContinuation, the #765 A1 / PR #796 recovery), so the
  // same stopped-lifecycle condition that branch keys on is what makes the
  // conversation continuable. `provider_absent` stays denied: it names a
  // child whose work could still resume but which nothing serving this
  // process can drive, so the reserve path is not the recovery for it.
  return (
    session.answerability.qualification === 'past_resume' &&
    isSessionLifecycleStateStopped(
      foldedSessionLifecycleState(session.lifecycleState),
    )
  );
}

export function canResolveConversationContinuation(
  detail: OrchestrationSessionDetail,
): boolean {
  return (
    isConversationContinuationControlEligible(detail) &&
    detail.session.hasActiveTurn !== true
  );
}

export interface ConversationLineageDeps {
  // Value-typed deps, captured once at service construction (slice-3
  // precedent). Safe only while nothing mutates the service options
  // post-construction — nothing does today.
  eventStore?: EventStore;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  turnDeduplicator?: TurnDeduplicator;
  conversationHistoryReader?: ConversationHistoryReadService;

  readSession: (
    threadId: string,
    authority: SessionReadScope,
  ) => Promise<OrchestrationSessionDetail | null>;
  /**
   * #764: observed per-connection resume support, consulted BEFORE a
   * continuation takes the resumeCursor path. `false` must mean an OBSERVED
   * capability absence (an ACP initialize handshake that did not advertise
   * `loadSession`); `undefined` (unknown, or a non-ACP provider) keeps the
   * cursor path and leaves the ACP adapter's own fail-closed A3 ruling
   * authoritative.
   */
  resumeCursorSupport?: (requested: {
    provider: EngineId;
    connectionId?: string;
  }) => boolean | undefined;
  readSessionMessages: (
    threadId: string,
    authority: SessionReadScope,
  ) => ConversationMessage[];
  listSessionReadModel: (
    authority: SessionReadScope,
  ) => Promise<OrchestrationSessionSummary[]>;
  canReadSession: (threadId: string, authority: SessionReadScope) => boolean;
}

/** Deliberately shared by absent, unauthorized, and cross-tenant requests. */
export class ConversationContextBoundaryNotFoundError extends Error {
  readonly name = 'ConversationContextBoundaryNotFoundError';
  constructor() {
    super('Conversation context boundary not found');
  }
}

/**
 * Conversation lineage, handoff, and history (epic archive#4024, archive#4155):
 * the C11 cluster from the seam map — zero owned service fields (verified:
 * its only writes are durable event-store writes that move with the code,
 * plus transitive map writes through the real service methods the deps
 * close over). The service keeps flat same-named forwarders; the ones whose
 * bodies latched `initialize()` keep that latch in the forwarder (T9).
 */
export class ConversationLineage {
  constructor(private readonly deps: ConversationLineageDeps) {}

  /**
   * Resolve the execution session for a durable conversation. A completed,
   * failed, or canceled execution session is intentionally never reopened:
   * this reserves one child session beneath the unchanged conversation.
   *
   * The reservation is durable before a provider is started. A retry after a
   * crash therefore receives the same child identity; concurrent callers
   * cannot create sibling children from one predecessor. A trusted native
   * cursor is reused when present; otherwise the next turn carries a bounded
   * provider-neutral transcript seed rather than silently forgetting turn 1.
   */
  async resolveConversationContinuation(
    conversationId: string,
    authority: SessionReadScope,
    requested: { provider: EngineId; connectionId?: string },
  ): Promise<{
    sessionId: string;
    startRequired: boolean;
    resumeCursor?: unknown;
    transcriptSeed?: string;
    contextBoundary?: ConversationContextBoundaryProjection;
  }> {
    const store = this.deps.eventStore;
    if (!store) {
      return { sessionId: conversationId, startRequired: false };
    }
    const lineage = store.conversationSessions(conversationId);
    if (lineage.length === 0) {
      return { sessionId: conversationId, startRequired: false };
    }
    const current = lineage[lineage.length - 1]!;
    // #764: decide cursor-vs-seed BEFORE a child start. An observed ACP
    // capability absence (no loadSession) must take the transcriptSeed
    // fresh-child path here; the adapter's fail-closed start refusal stays
    // authoritative only for the cases this observation cannot speak for.
    const resumeSupported = this.deps.resumeCursorSupport?.(requested);
    const detail = await this.deps.readSession(current.sessionId, authority);
    if (!detail) {
      // A handoff-reserved child must be launched by its selected target, not
      // by an ordinary continuation racing after the reservation. Once that
      // child exists, it is a normal current Session and may continue.
      if (store.conversationHandoffForSession(current.sessionId)) {
        throw new Error(
          'This conversation has an explicit Agent/engine handoff awaiting its target session start.',
        );
      }
      const contextBoundary = store.conversationContextBoundaryForSuccessor(
        current.sessionId,
      );
      if (contextBoundary) {
        if (
          contextBoundary.status === 'cancelled' ||
          contextBoundary.status === 'indeterminate'
        )
          throw new Error(
            'This conversation context boundary is not startable.',
          );
        const predecessor = current.predecessorSessionId
          ? await this.deps.readSession(current.predecessorSessionId, authority)
          : null;
        return {
          sessionId: current.sessionId,
          startRequired: true,
          contextBoundary: projectConversationContextBoundary(contextBoundary),
          ...(contextBoundary.policy === 'continue-from-history' && predecessor
            ? continuationLaunchContext(
                predecessor,
                requested,
                this.readConversationTranscriptMessages(
                  conversationId,
                  authority,
                ),
                resumeSupported,
              )
            : {}),
        };
      }
      // A reservation can outlive a crash between reservation and provider
      // start. Its immutable parent binding is checked by the foreground
      // seam before retrying this exact child start.
      observeConversationContinuation('reserved_unstarted');
      const predecessor = current.predecessorSessionId
        ? await this.deps.readSession(current.predecessorSessionId, authority)
        : null;
      return {
        sessionId: current.sessionId,
        startRequired: true,
        ...(predecessor
          ? continuationLaunchContext(
              predecessor,
              requested,
              this.readConversationTranscriptMessages(
                conversationId,
                authority,
              ),
              resumeSupported,
            )
          : {}),
      };
    }
    const lifecycle = foldedSessionLifecycleState(
      detail.session.lifecycleState,
    );
    if (!isConversationContinuationControlEligible(detail)) {
      throw new Error(
        'This conversation is not writable under its current control state.',
      );
    }
    if (!isSessionLifecycleStateStopped(lifecycle)) {
      observeConversationContinuation('current_open');
      return { sessionId: current.sessionId, startRequired: false };
    }
    const child = store.reserveNextConversationSession({
      conversationId,
      predecessorSessionId: current.sessionId,
      proposedSessionId: `${conversationId}:session:${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    });
    observeConversationContinuation(child.outcome);
    return {
      sessionId: child.lineage.sessionId,
      startRequired: true,
      ...continuationLaunchContext(
        detail,
        requested,
        this.readConversationTranscriptMessages(conversationId, authority),
        resumeSupported,
      ),
    };
  }

  /** Current replaceable Session for a durable conversation; legacy falls back to its id. */
  currentConversationSessionId(conversationId: string): string {
    return (
      this.deps.eventStore?.conversationSessions(conversationId).at(-1)
        ?.sessionId ?? conversationId
    );
  }

  /**
   * Authorize and read the current execution child for supervision without
   * reserving or starting another Session.
   */
  async readCurrentConversationSession(
    conversationId: string,
    authority: SessionReadScope,
  ): Promise<OrchestrationSessionDetail | null> {
    const currentSessionId = this.currentConversationSessionId(conversationId);
    const current = await this.deps.readSession(currentSessionId, authority);
    if (current) return current;

    // A durable reservation creates lineage before it creates a provider
    // Session.  Keep the canonical Conversation readable across that crash
    // window, but only by following the exact lineage tail back to its
    // authorized predecessor (a plain continuation reservation, an active
    // context-boundary, or an active handoff marker — #764). A missing
    // arbitrary lineage child is deliberately not a fallback: that would
    // turn corruption or a foreign child into an authorization bypass.
    const store = this.deps.eventStore;
    const currentLineage = store?.conversationSessions(conversationId).at(-1);
    if (
      !store ||
      !currentLineage ||
      currentLineage.sessionId !== currentSessionId ||
      !currentLineage.predecessorSessionId
    )
      return null;
    const boundary =
      store.conversationContextBoundaryForSuccessor(currentSessionId);
    const handoff = store.conversationHandoffForSession(currentSessionId);
    // #764: a plain continuation reservation creates lineage with NO marker
    // of either kind. It is as legitimate a tail as the two marked kinds, and
    // the predecessor is reached under the same exact-tail +
    // authorized-predecessor shape the marked arms use.
    if (!boundary && !handoff) {
      return this.deps.readSession(
        currentLineage.predecessorSessionId,
        authority,
      );
    }
    const activeBoundary =
      boundary &&
      boundary.conversationId === conversationId &&
      boundary.predecessorSessionId === currentLineage.predecessorSessionId &&
      boundary.successorSessionId === currentSessionId &&
      ['reserved', 'claimed', 'failed', 'indeterminate'].includes(
        boundary.status,
      );
    const activeHandoff =
      handoff &&
      handoff.conversationId === conversationId &&
      handoff.predecessorSessionId === currentLineage.predecessorSessionId &&
      handoff.sessionId === currentSessionId;
    if (!activeBoundary && !activeHandoff) return null;
    return this.deps.readSession(
      currentLineage.predecessorSessionId,
      authority,
    );
  }

  reservedConversationHandoff(sessionId: string) {
    return this.deps.eventStore?.conversationHandoffForSession(sessionId);
  }

  async reserveConversationContextBoundary(
    conversationId: string,
    authority: SessionReadScope,
    input: ConversationContextBoundaryRequest & {
      actorId: string;
      clientOrigin?: string;
    },
  ): Promise<ConversationContextBoundaryProjection> {
    const store = this.deps.eventStore;
    if (!store)
      throw new Error(
        'Conversation context boundaries require durable storage',
      );
    const existing = store.conversationContextBoundaryByKey(
      conversationId,
      input.idempotencyKey,
    );
    const lineage = store.conversationSessions(conversationId);
    const current = lineage.at(-1);
    if (!current || current.sessionId !== input.expectedCurrentSessionId)
      throw new Error(
        'The conversation changed before its context boundary could be reserved.',
      );
    const detail = await this.deps.readSession(current.sessionId, authority);
    if (!detail) throw new ConversationContextBoundaryNotFoundError();
    if (existing) {
      // Same-key replay is safe only for the same complete request identity.
      // Checking after the current lineage read also prevents a stale tab from
      // learning or reusing a predecessor it no longer controls.
      if (
        existing.policy !== input.policy ||
        existing.predecessorSessionId !== current.sessionId ||
        existing.actorId !== input.actorId
      ) {
        throw new Error(
          'The context boundary idempotency key names a different request.',
        );
      }
      return projectConversationContextBoundary(existing);
    }
    if (
      !isSessionLifecycleStateStopped(
        foldedSessionLifecycleState(detail.session.lifecycleState),
      ) ||
      detail.session.hasActiveTurn
    )
      throw new Error(
        'Stop the current Session first: a context boundary requires an idle terminal Session with no active turn or approval.',
      );
    const result = store.reserveConversationContextBoundary({
      boundaryId: crypto.randomUUID(),
      conversationId,
      predecessorSessionId: current.sessionId,
      successorSessionId: `${conversationId}:session:${crypto.randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      policy: input.policy,
      status: 'reserved',
      actorId: input.actorId,
      ...(input.clientOrigin ? { clientOrigin: input.clientOrigin } : {}),
      createdAt: new Date().toISOString(),
    });
    return projectConversationContextBoundary(result.marker);
  }

  async readConversationContextBoundaryStatus(
    conversationId: string,
    idempotencyKey: string,
    authority: SessionReadScope,
  ): Promise<ConversationContextBoundaryProjection | null> {
    const store = this.deps.eventStore;
    const marker = store?.conversationContextBoundaryByKey(
      conversationId,
      idempotencyKey,
    );
    if (
      !marker ||
      !(await this.deps.readSession(marker.predecessorSessionId, authority))
    )
      return null;
    return projectConversationContextBoundary(marker);
  }

  async cancelConversationContextBoundary(
    conversationId: string,
    idempotencyKey: string,
    authority: SessionReadScope,
  ): Promise<ConversationContextBoundaryProjection | null> {
    const store = this.deps.eventStore;
    const marker = store?.conversationContextBoundaryByKey(
      conversationId,
      idempotencyKey,
    );
    if (
      !marker ||
      !(await this.deps.readSession(marker.predecessorSessionId, authority))
    )
      return null;
    return projectConversationContextBoundary(
      store!.cancelConversationContextBoundary(
        marker.boundaryId,
        new Date().toISOString(),
      ),
    );
  }

  claimConversationContextBoundaryColdStart(
    boundaryId: string,
    startCommandId: string,
  ) {
    return this.deps.eventStore?.claimConversationContextBoundaryColdStart(
      boundaryId,
      startCommandId,
      new Date().toISOString(),
    );
  }

  consumeConversationContextBoundary(
    boundaryId: string,
    startCommandId: string,
  ) {
    return this.deps.eventStore?.consumeConversationContextBoundary(
      boundaryId,
      startCommandId,
      new Date().toISOString(),
    );
  }

  releaseConversationContextBoundaryFailedClaim(
    boundaryId: string,
    indeterminate = false,
  ) {
    return indeterminate
      ? this.deps.eventStore?.markConversationContextBoundaryIndeterminate(
          boundaryId,
          new Date().toISOString(),
        )
      : this.deps.eventStore?.releaseConversationContextBoundaryFailedClaim(
          boundaryId,
          new Date().toISOString(),
        );
  }

  /**
   * Reserve the next child specifically for an explicit Agent/engine
   * handoff.  This is deliberately not part of ordinary continuation: the
   * caller has already resolved a configured, ready target, while this module
   * owns terminal-predecessor checks, durable idempotency and the portable
   * text-only context boundary.
   */
  async prepareConversationHandoff(
    conversationId: string,
    authority: SessionReadScope,
    target: {
      agentId: string;
      environmentId: string;
      connectionId?: string;
      modelId?: string;
      idempotencyKey: string;
      messageDigest: string;
    },
  ) {
    const store = this.deps.eventStore;
    if (!store)
      throw new Error('Conversation handoff requires durable storage');
    const hasTarget = (marker: {
      targetAgentId: string;
      targetEnvironmentId: string;
      targetConnectionId?: string;
      targetModelId?: string;
      messageDigest: string;
    }) =>
      marker.targetAgentId === target.agentId &&
      marker.targetEnvironmentId === target.environmentId &&
      marker.targetConnectionId === target.connectionId &&
      marker.targetModelId === target.modelId &&
      marker.messageDigest === target.messageDigest;
    const existing = store.conversationHandoffByKey(
      conversationId,
      target.idempotencyKey,
    );
    if (existing) {
      if (!hasTarget(existing)) {
        throw new Error(
          'The handoff idempotency key already names a different target or message.',
        );
      }
      const boundary = store.conversationContextBoundaryForSuccessor(
        existing.sessionId,
      );
      const contextBoundary =
        boundary &&
        boundary.conversationId === conversationId &&
        boundary.predecessorSessionId === existing.predecessorSessionId &&
        boundary.successorSessionId === existing.sessionId
          ? projectConversationContextBoundary(boundary)
          : undefined;
      return {
        ...store.describeConversationHandoff(existing, 'existing'),
        ...(contextBoundary ? { contextBoundary } : {}),
        ...handoffTranscriptContext(
          contextBoundary,
          this.readConversationTranscriptMessages(conversationId, authority),
        ),
      };
    }
    const lineage = store.conversationSessions(conversationId);
    const current = lineage.at(-1);
    if (!current)
      throw new Error('Conversation handoff predecessor was not found');
    // A deliberate context replacement reserves the same successor the
    // handoff will start.  The policies compose at that shared child; neither
    // operation may allocate a competing lineage edge.
    const boundary = store.conversationContextBoundaryForSuccessor(
      current.sessionId,
    );
    const predecessor = boundary
      ? lineage.find(
          (entry) => entry.sessionId === boundary.predecessorSessionId,
        )
      : current;
    if (!predecessor)
      throw new Error('Conversation handoff predecessor was not found');
    if (store.conversationHandoffForPredecessor(predecessor.sessionId)) {
      throw new Error(
        'This conversation already has an explicit Agent/engine handoff awaiting its target session start.',
      );
    }
    const detail = await this.deps.readSession(
      predecessor.sessionId,
      authority,
    );
    if (!detail)
      throw new Error('Conversation handoff predecessor was not found');
    const lifecycle = foldedSessionLifecycleState(
      detail.session.lifecycleState,
    );
    if (
      !isSessionLifecycleStateStopped(lifecycle) ||
      detail.session.hasActiveTurn
    ) {
      throw new Error(
        'An Agent/engine handoff requires the predecessor Session to be terminal with no active turn.',
      );
    }
    const reservation = store.reserveConversationHandoff({
      conversationId,
      predecessorSessionId: predecessor.sessionId,
      sessionId:
        boundary?.successorSessionId ??
        `${conversationId}:session:${crypto.randomUUID()}`,
      idempotencyKey: target.idempotencyKey,
      messageDigest: target.messageDigest,
      targetAgentId: target.agentId,
      targetEnvironmentId: target.environmentId,
      ...(target.connectionId
        ? { targetConnectionId: target.connectionId }
        : {}),
      ...(target.modelId ? { targetModelId: target.modelId } : {}),
      createdAt: new Date().toISOString(),
    });
    return {
      ...reservation,
      // Never pass a provider cursor across an Agent boundary, even when two
      // Agents share an engine connection.  The target gets only the bounded
      // authorized text projection and a structural reset disclosure.
      ...(boundary
        ? { contextBoundary: projectConversationContextBoundary(boundary) }
        : {}),
      ...handoffTranscriptContext(
        boundary ? projectConversationContextBoundary(boundary) : undefined,
        this.readConversationTranscriptMessages(conversationId, authority),
      ),
    };
  }

  /**
   * Observe one durable handoff without resolving its mutable Agent catalog.
   * Authorization covers every materialized Session in the conversation;
   * the reserved child is authorized by its already-authorized predecessor
   * until a provider Session exists.
   */
  async readConversationHandoffStatus(
    conversationId: string,
    idempotencyKey: string,
    authority: SessionReadScope,
  ): Promise<ConversationHandoffStatusProjection | null> {
    const store = this.deps.eventStore;
    if (!store) return null;
    const marker = store.conversationHandoffByKey(
      conversationId,
      idempotencyKey,
    );
    if (!marker) return null;
    const lineage = store.conversationSessions(conversationId);
    if (!lineage.some((entry) => entry.sessionId === marker.sessionId)) {
      return null;
    }
    for (const entry of lineage) {
      if (!store.readSessionByThread(entry.sessionId)) continue;
      if (!(await this.deps.readSession(entry.sessionId, authority)))
        return null;
    }
    if (
      !(await this.deps.readSession(marker.predecessorSessionId, authority))
    ) {
      return null;
    }

    const clientTurnId = `handoff:${crypto
      .createHash('sha256')
      .update(`${conversationId}\0${idempotencyKey}`)
      .digest('hex')}`;
    const providerTurnId = await this.deps.turnDeduplicator?.awaitResolution({
      threadId: marker.sessionId,
      clientTurnId,
      timeoutMs: 1,
      intervalMs: 1,
    });
    const turnEvents = providerTurnId
      ? store
          .listEvents(marker.sessionId)
          .filter((event) => event.turnId === providerTurnId)
      : [];
    const terminal = turnEvents
      .filter((event) =>
        ['turn.completed', 'turn.aborted', 'runtime.error'].includes(
          event.method,
        ),
      )
      .at(-1)?.method;
    const status =
      terminal === 'turn.completed'
        ? ('completed' as const)
        : terminal === 'turn.aborted' || terminal === 'runtime.error'
          ? ('failed' as const)
          : providerTurnId
            ? ('accepted' as const)
            : store.readSessionByThread(marker.sessionId)
              ? ('indeterminate' as const)
              : ('reserved' as const);
    const disclosure = store.describeConversationHandoff(marker, 'existing');
    return {
      conversationId,
      currentSessionId: marker.sessionId,
      status,
      marker: {
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
      },
      ...(providerTurnId ? { providerTurnId } : {}),
    };
  }

  /** Ordered, authorized text-only context across the durable lineage. */
  private readConversationTranscriptMessages(
    conversationId: string,
    authority: SessionReadScope,
  ): ConversationMessage[] {
    return (
      this.deps.eventStore?.conversationSessions(conversationId) ?? []
    ).flatMap((lineage) =>
      this.deps.readSessionMessages(lineage.sessionId, authority),
    );
  }

  /**
   * Expose orchestration-owned sessions through the same lightweight
   * conversation identity used by chat navigation and history. The transcript
   * remains canonical in the event store; this is only a discovery projection.
   */
  async readSessionConversation(threadId: string, authority: SessionReadScope) {
    if (!this.deps.canReadSession(threadId, authority)) {
      return null;
    }
    const detail = await this.deps.readSession(threadId, authority);
    const assignedAgentSlug = detail?.session.assignedAgentSlug;
    if (!detail || !assignedAgentSlug) return null;
    const agentSlug = assignedAgentSlug;
    const messages = this.deps.readSessionMessages(threadId, authority);
    const firstUserText = messages
      .find((message) => message.role === 'user')
      ?.parts.find((part) => part.type === 'text')?.text;
    const durableConversationId =
      this.deps.eventStore?.conversationForSession(threadId)?.conversationId ??
      detail.session.conversationId ??
      threadId;
    const acceptedModel =
      this.deps.eventStore?.readLatestAcceptedConversationModel({
        conversationId: durableConversationId,
        environmentId: detail.session.environmentId,
      });
    return {
      id: durableConversationId,
      agentSlug,
      ...(detail.session.environmentId
        ? { environmentId: detail.session.environmentId }
        : {}),
      ...(acceptedModel ? { acceptedModel } : {}),
      ...(detail.session.projectSlug
        ? { projectSlug: detail.session.projectSlug }
        : {}),
      title: firstUserText?.trim().slice(0, 80) || `${agentSlug} chat`,
      ...((detail.session.reportedModel ??
      detail.session.effectiveModel ??
      detail.session.model)
        ? {
            model:
              detail.session.reportedModel ??
              detail.session.effectiveModel ??
              detail.session.model,
          }
        : {}),
      createdAt: detail.session.createdAt,
      updatedAt: detail.session.lastEventAt ?? detail.session.updatedAt,
      messageCount: messages.length,
      mutable: false as const,
    };
  }

  /**
   * Shared event-store seam for immutable cross-conversation provenance.
   * archive#1399 fix round 2, B3: this is a generic pass-through of
   * whatever `CanonicalRuntimeEvent` its caller constructs (today, a
   * fork-marker event, never `tool.completed`) — routed through the safe
   * sanitizer anyway so the writer-inventory ratchet needs no
   * per-call-site exemption reasoning to stay correct if a future caller
   * ever passes something else through this seam.
   */
  appendConversationFork(event: CanonicalRuntimeEvent): void {
    this.deps.eventStore?.appendEvent(
      safeSanitizeUIBlockEventProvenance(event, (message, meta) =>
        this.deps.logger.warn(message, meta),
      ),
    );
  }

  /** Insert a deterministic fork fact once; safe for retry after a crash. */
  appendConversationForkIfAbsent(event: CanonicalRuntimeEvent): boolean {
    return (
      this.deps.eventStore?.appendEventIfAbsent(
        safeSanitizeUIBlockEventProvenance(event, (message, meta) =>
          this.deps.logger.warn(message, meta),
        ),
      ) !== undefined
    );
  }

  /** Pure fold; this intentionally does not initialize or rehydrate anything. */
  readConversationForkProvenance(conversationId: string): {
    forkedFrom?: ConversationForkProvenance;
    forkedTo: ConversationForkProvenance[];
  } {
    return (
      this.deps.eventStore?.readConversationForkProvenance(conversationId) ?? {
        forkedTo: [],
      }
    );
  }

  async listSessionConversations(
    agentSlug: string,
    authority: SessionReadScope,
  ) {
    const sessions = await this.deps.listSessionReadModel(authority);
    const conversations = await Promise.all(
      sessions
        .filter(
          (session) =>
            session.assignedAgentSlug !== undefined &&
            session.assignedAgentSlug === agentSlug,
        )
        .slice(-CONVERSATION_HISTORY_MAX_ENTRIES)
        .map((session) =>
          this.readSessionConversation(session.threadId, authority),
        ),
    );
    return conversations.filter(
      (conversation): conversation is NonNullable<typeof conversation> =>
        conversation !== null,
    );
  }

  /**
   * S2 of archive#1302 (conversation-surface consolidation): global counterpart to
   * `listSessionConversations` above — folds every agent's session-backed
   * conversations, not just one, for the new `GET /api/conversations`
   * inventory endpoint. Reuses `readSessionConversation` for its ACL check,
   * exact agent slug and title derivation, and enriches
   * each item with the live session fields the inbox/history surfaces need
   * (`controlMode`/`lifecycleState`/`pendingReview`/`provider`/
   * `hasActiveTurn`) so one query can drive them without a second
   * round-trip.
   *
   * Perf (the plan's flagged hazard): `readSessionConversation` derives a
   * title by reading the session's full message history — expensive at
   * scale. The recency cap below runs BEFORE that derivation, over the
   * cheap read-model summaries (mirroring `listSessionConversations`'
   * `.slice(-CONVERSATION_HISTORY_MAX_ENTRIES)`), so a large session
   * population only pays the title-derivation cost for the capped window
   * actually returned, never for every session that exists.
   */
  async listAllSessionConversations(
    authority: SessionReadScope,
  ): Promise<ConversationListItem[]> {
    if (
      this.deps.conversationHistoryReader &&
      isSessionReadAuthority(authority)
    ) {
      return this.deps.conversationHistoryReader.list({
        authority,
        limit: CONVERSATION_HISTORY_MAX_ENTRIES,
      }).items;
    }
    const sessions = await this.deps.listSessionReadModel(authority);
    const capped = sessions
      .filter((session) => session.assignedAgentSlug !== undefined)
      .slice(-CONVERSATION_HISTORY_MAX_ENTRIES);
    const items = await Promise.all(
      capped.map(async (session) => {
        const conversation = await this.readSessionConversation(
          session.threadId,
          authority,
        );
        if (!conversation) return null;
        const item: ConversationListItem = {
          id: conversation.id,
          source: 'runtime',
          agentSlug: conversation.agentSlug,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          messageCount: conversation.messageCount,
          mutable: false,
          // Carried, never re-derived (archive#1778). `ProjectSidebar` folds
          // this item's lifecycle fields into an attention badge; without the
          // decoration it would be the sixteenth consumer reading a raw state
          // that is permanently wrong for a dead session.
          answerability: session.answerability,
          controlMode: session.controlMode,
          provider: session.provider,
          ...(conversation.model ? { model: conversation.model } : {}),
          ...(conversation.acceptedModel
            ? { acceptedModel: conversation.acceptedModel }
            : {}),
          ...(conversation.environmentId
            ? { environmentId: conversation.environmentId }
            : {}),
        };
        if (conversation.projectSlug) {
          item.projectSlug = conversation.projectSlug;
        }
        if (session.lifecycleState) {
          item.lifecycleState = session.lifecycleState;
        }
        if (session.pendingReview !== undefined) {
          item.pendingReview = session.pendingReview;
        }
        if (session.hasActiveTurn !== undefined) {
          item.hasActiveTurn = session.hasActiveTurn;
        }
        return item;
      }),
    );
    return deduplicateConversationItems(
      items.filter((item): item is ConversationListItem => item !== null),
    );
  }

  async listConversationHistoryPage(
    authority: SessionReadAuthority,
    options: { limit: number; cursor?: string; agentSlug?: string },
  ): Promise<ConversationHistoryPage> {
    if (!this.deps.conversationHistoryReader) {
      return { items: [], hasMore: false };
    }
    return this.deps.conversationHistoryReader.list({
      authority,
      ...options,
    });
  }
}

const CONTINUATION_TRANSCRIPT_SEED_MAX_CHARS = 6_000;

function continuationLaunchContext(
  detail: Pick<OrchestrationSessionDetail, 'session' | 'events'>,
  requested: { provider: EngineId; connectionId?: string },
  messages: readonly ConversationMessage[],
  resumeSupported?: boolean,
): { resumeCursor?: unknown; transcriptSeed?: string } {
  const sourceConnectionId = [...detail.events].reverse().flatMap((event) => {
    if (
      event.method !== 'session.started' &&
      event.method !== 'session.configured'
    )
      return [];
    const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
    return typeof metadata?.connectionId === 'string'
      ? [metadata.connectionId]
      : [];
  })[0];
  const sameExecutionIdentity =
    detail.session.provider === requested.provider &&
    sourceConnectionId === requested.connectionId;
  // #765 A1: a predecessor started with an explicit `persistSession: false`
  // has no durable engine transcript behind its cursor — the Claude adapter
  // spawns such sessions with `--no-session-persistence`, so a child start
  // that presents the cursor gets the CLI's terminal "No conversation found
  // with session ID" and the conversation dies. The cursor is a claim the
  // predecessor's own start posture disproves; carry the bounded transcript
  // seed instead. `undefined` (providers that ignore the flag, e.g. Codex's
  // always-persisted rollouts, and rows persisted before the flag existed)
  // keeps the cursor path.
  const cursorBackedByTranscript = detail.session.persistSession !== false;
  // #765 A1: `dead` is the engine's own structured verdict that THIS binding
  // can never resume (archive#1827 — e.g. Claude's `--resume` answered
  // "No conversation found with session ID"). Reserving the next child on
  // the same disproved cursor re-runs the identical failure forever; the
  // transcript-seed fresh child is the recovery that actually works, and it
  // is what makes the UI's "send your message again" claim true for
  // conversations whose predecessor ran before persistence was fixed.
  // `error` status deliberately keeps the cursor: archive#1090's contract is
  // that a config-shaped failure may retry the SAME cursor once fixed.
  const cursorDisprovenByEngine = detail.session.status === 'dead';
  // #764: `resumeSupported === false` is an observed capability absence
  // (e.g. an ACP handshake without loadSession) — take the engine-agnostic
  // transcript-seed fresh child instead of a start the adapter must refuse.
  // `undefined` keeps the cursor path for every provider this observation
  // cannot speak for.
  return sameExecutionIdentity &&
    detail.session.resumeCursor !== undefined &&
    cursorBackedByTranscript &&
    !cursorDisprovenByEngine &&
    resumeSupported !== false
    ? { resumeCursor: detail.session.resumeCursor }
    : { transcriptSeed: continuationTranscriptSeed(messages) };
}

/**
 * A handoff never carries a provider cursor.  A context boundary narrows the
 * remaining safe retry states: after an accepted start, the exact handoff
 * turn may still need its transcript seed; while a claim is ambiguous, it
 * must not be sent or reconstructed.
 */
function handoffTranscriptContext(
  boundary: ConversationContextBoundaryProjection | undefined,
  messages: readonly ConversationMessage[],
): { transcriptSeed?: string } {
  if (boundary?.policy === 'empty-next-cold-start') return {};
  if (
    boundary &&
    boundary.status !== 'reserved' &&
    boundary.status !== 'failed' &&
    boundary.status !== 'consumed'
  )
    return {};
  return { transcriptSeed: continuationTranscriptSeed(messages) };
}

/**
 * Deterministic cross-engine fallback. It is deliberately bounded and carries
 * only the already-authorized canonical conversation projection; provider
 * cursor state, tool state, approvals, and connection secrets never cross
 * this boundary. The next handoff slice can render an explicit marker from
 * the same child lineage without changing this start contract.
 */
function continuationTranscriptSeed(
  messages: readonly ConversationMessage[],
): string {
  const text = messages
    .filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    )
    .map((message) => {
      const content = message.parts
        .filter((part) => typeof part.text === 'string' && !part.runtimeError)
        .map((part) => part.text!.trim())
        .filter(Boolean)
        .join('\n');
      return content
        ? `${message.role === 'user' ? 'User' : 'Assistant'}: ${content}`
        : '';
    })
    .filter(Boolean)
    .join('\n');
  const bounded = text.slice(-CONTINUATION_TRANSCRIPT_SEED_MAX_CHARS);
  return `Prior conversation transcript (context only; provider-native state is not carried):\n${bounded}`;
}

function observeConversationContinuation(
  outcome: 'created' | 'existing' | 'current_open' | 'reserved_unstarted',
): void {
  try {
    conversationContinuationOutcomes.add(1, { outcome });
  } catch {
    // Telemetry exporters are observational and cannot overturn durability.
  }
}
