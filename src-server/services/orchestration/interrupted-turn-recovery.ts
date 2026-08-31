import crypto from 'node:crypto';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { TURN_INTERRUPTED_MESSAGE } from '@kontourai/station-shared/runtime-event-projection';
// Same directory depth as the service, so this specifier resolves to the id
// `interrupted-turn-recovery.test.ts` already `vi.mock`s. A module at a
// different depth would silently get the REAL resolver and red the
// delegation test — the T12 failure mode in a non-metrics guise.
import { resolveConversationTranscriptSource } from '../../runtime/conversation/conversation-transcript-source.js';
import type { EventStore } from './event-store.js';

/** Narrow structural logger: this module warns, never debugs. */
export type InterruptedTurnRecoveryLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
};

export interface InterruptedTurnRecoveryDeps {
  /**
   * Called, not captured: the store is optional on the service options and a
   * swap after construction must be honoured. The handle crosses here
   * deliberately — the four operations this module needs
   * (`takeInterruptedTurnBoundaries`, `latestEventByMethod`, `hasEventId`,
   * `resolveInterruptedTurnBoundary`) are one transactional unit over the
   * boundary table and event log, and fanning them into four unrelated
   * arrows would hide that. No Map crosses (T13).
   */
  eventStore: () => EventStore | undefined;
  /**
   * The `options.memoryAdapters` Map is absorbed at the ctor seam, so this
   * module never holds a Map handle (T13) — only the narrow
   * `InterruptedTurnMemoryAdapter` seam, which moves with it.
   */
  memoryAdapterFor: (
    agentSlug: string,
  ) => InterruptedTurnMemoryAdapter | undefined;
  /**
   * C2's projection+publish. Returns boolean in-service and the M4 refusal
   * branch READS it — a declined publish must retain the boundary row — so
   * unlike the CooperativeStop/FlowPolicySidecar precedent this is NOT
   * `void`. Narrowing it would silently convert "declined" into "done".
   */
  publishEvent: (event: CanonicalRuntimeEvent) => boolean;
  logger: InterruptedTurnRecoveryLogger;
}

/**
 * archive#4080: the narrow FileMemory seam
 * `consumeInterruptedTurnBoundaries` needs — the same three operations
 * `routes/chat/conversations.ts`'s `readConversationMessages` uses to decide
 * whether a session's transcript lives in this store at all. `getMessages`'s
 * `metadata` echoes whatever `addMessage` wrote (round-tripped verbatim
 * through the JSONL store), which is how the interrupted-turn banner's own
 * idempotence marker (H1b) survives a read.
 */
export interface InterruptedTurnMemoryAdapter {
  addMessage(
    message: {
      id: string;
      role: 'user';
      parts: Array<{ type: 'text'; text: string }>;
      metadata?: { interruptedTurnBoundaryId: string };
    },
    userId: string,
    conversationId: string,
  ): Promise<void>;
  getMessages(
    userId: string,
    conversationId: string,
    options?: { limit?: number },
  ): Promise<Array<{ metadata?: { interruptedTurnBoundaryId?: string } }>>;
  getConversation(conversationId: string): Promise<{ userId: string } | null>;
}

/**
 * archive#4080: `options.limit` bounds the RESULT
 * `resolveConversationTranscriptSource`'s `getMessages` call returns — the
 * underlying `FileMemoryAdapter.getMessages` (`readStoredMessages`) reads
 * the conversation's whole JSONL file and slices the last `limit` entries
 * off the end before returning, so this bounds what this method inspects,
 * not what it reads off disk. That bounded RESULT is used for two things:
 * deciding whether the store is occupied at all (any result is a positive
 * answer — `readConversationMessages`'s own check is likewise "is this
 * non-empty", never "read everything") and scanning for the interruption
 * banner's own idempotence marker. The marker scan's soundness rests on an
 * ordering assumption, not a guarantee: `consumeInterruptedTurnBoundaries`
 * runs fire-and-forget once, after boot's session-attachment settles — not
 * before live traffic can reach this thread. If a real message is sent
 * before this method runs for a given boundary, the marker (if a prior
 * attempt already wrote one) is no longer guaranteed to be within the tail
 * `limit` messages this scan inspects, and a residual crash-window replay
 * could double-banner. Five is slack for the ordinary case — appended right
 * after boot, before anything else has had the chance to write to a session
 * whose owning process just died — not a guarantee against a live send
 * racing it.
 */
const INTERRUPTED_TURN_MEMORY_SCAN_LIMIT = 5;

/**
 * archive#4080 (review round 1, H2 core reshape; review round 2,
 * follow-up 1: delegates to the shared `resolveConversationTranscriptSource`
 * rather than re-deriving its own copy of the lookup). Occupancy is decided
 * by the SAME two-step FileMemory lookup `readConversationMessages` uses —
 * see that function's own doc for why this is the one shared definition.
 * `alreadyBannered` is this caller's own use of the bounded result: the
 * interrupted-turn banner's idempotence check (H1b), not part of the shared
 * occupancy question itself.
 */
async function resolveFileMemoryOccupancy(
  adapter: InterruptedTurnMemoryAdapter,
  agentSlug: string,
  threadId: string,
): Promise<{
  occupied: boolean;
  userId: string;
  alreadyBannered: (boundaryId: string) => boolean;
}> {
  const source = await resolveConversationTranscriptSource<{
    metadata?: { interruptedTurnBoundaryId?: string };
  }>(adapter, `agent:${agentSlug}`, threadId, {
    limit: INTERRUPTED_TURN_MEMORY_SCAN_LIMIT,
  });
  return {
    occupied: source.occupied,
    userId: source.userId,
    alreadyBannered: (boundaryId: string) =>
      source.messages.some(
        (message) => message.metadata?.interruptedTurnBoundaryId === boundaryId,
      ),
  };
}

/**
 * Boot-time interrupted-turn recovery (epic archive#4024, archive#4080).
 *
 * Owns no state: one method, driven once per boot, fire-and-forget from
 * `initialize()`'s third un-awaited tail. Four deps. The scope is
 * deliberately narrower than the map's "C16 — boot, recovery,
 * materialization": three of that cluster's four owned fields cannot move
 * (`initialize()` is pinned by a byte-exact source guard, `started` is its
 * T9 latch, `sessionAttachmentSettled` is read by C7's
 * `observeAnswerability`, and `recoveryCoordinator` has three non-C16
 * readers plus two test cast reach-ins), and `recoverSessions` /
 * `recoveredSessionStartOptions` are dep TABLES for
 * `recoverOrchestrationSessions`, which is already extracted — moving them
 * would nest one options interface inside another. See the map's §II.3 C16
 * closure section.
 *
 * Emits no metrics, deliberately: nothing here needs the T12-compliant
 * `'../../telemetry/metrics.js'` specifier, and its absence is not an
 * oversight to "fix".
 */
export class InterruptedTurnRecovery {
  constructor(private readonly deps: InterruptedTurnRecoveryDeps) {}

  /**
   * archive#4080: consumes this process's own boot-time findings
   * from `EventStore.takeInterruptedTurnBoundaries()` — dead-owner
   * `accepted`/`indeterminate` `orchestration_turn_boundaries` rows, i.e.
   * turns that were in flight when their owning process died (a `kill -9`
   * never leaves any of the ordinary terminal facts — no `turn.completed`,
   * no `runtime.error`, no `session.exited` — for this thread to fold from
   * on its own). Every banner this writes is gated on exactly one such row;
   * there is no code path that writes one without a matching row.
   *
   * PRESENTATION PATH (review round 1, H2 core reshape): chosen the SAME
   * way the read path chooses it — `readConversationMessages` serves
   * FileMemory whenever it is non-empty for the thread, regardless of
   * provider, and the persisted-runtime-events projection otherwise. This
   * method now asks the identical question (`resolveFileMemoryOccupancy`)
   * instead of branching on `provider === 'station-agent'`: a provider
   * branch was wrong in both directions (a station-agent conversation
   * created under a real user id, not the conventional `agent:${slug}` one,
   * would have gone unseen; every other provider was silently assumed
   * empty with no check). Exactly one path is ever written per session.
   *
   * LIFECYCLE-STATE FIX, engine-agnostic and always applied: a killed
   * turn's `turn.started` sets both `AgentRunStatus` (`running`,
   * `orchestration-session-state.ts`'s `deriveAgentRunStatus`) and
   * `SessionLifecycleState` (`running`, `session-lifecycle-service.ts`'s
   * `deriveLifecycleTransition`) and neither fold has anything left to
   * read it out of `running` once the crash swallows every terminal event.
   * One `session.state-changed` event stamped `sessionState:'needs_input'`
   * fixes both: `projectSessionLifecycle`'s generic early-return honors any
   * event's explicit `sessionState` stamp regardless of the fold's own
   * current state (no `validateSessionLifecycleTransition` legality check
   * applies to a system-derived recovery fact, unlike a user-initiated
   * Board transition), and `deriveAgentRunStatus`'s `session.state-changed`
   * arm reads the same event's raw `to:'awaiting-approval'` into
   * `waiting_for_approval` — the nearest `AgentRunStatus` has to "needs
   * input" (that contract has no separate value for it). The SAME event
   * also carries the visible banner for every non-FileMemory-occupied
   * session (`runtime-event-projection.ts`'s `session.state-changed` case),
   * gated on the dedicated `interruptedTurnBoundary` field (M3) rather than
   * on the (sessionState, transitionReason, transitionSource) vocabulary
   * triple — see that field's own doc in `runtime-events.ts`.
   *
   * IDEMPOTENCE (review round 1, H1): the write→delete gap between a
   * banner landing and `resolveInterruptedTurnBoundary` closing its row is
   * a real crash window — a process that dies in it leaves the row for a
   * next boot to find again. Both write paths are therefore made
   * idempotent by boundary-derived identity BEFORE that DELETE is trusted
   * to be the only guard: the event's `eventId` is deterministic
   * (`turn-interrupted:<boundaryId>`, checked via `EventStore.hasEventId`
   * before writing), and the FileMemory message carries the boundaryId as
   * `metadata.interruptedTurnBoundaryId`, scanned for before writing. A
   * retry that finds either already present skips straight to close.
   *
   * REFUSAL (review round 1, M4): `projectAndPublishEvent` returns `false`
   * when it declines to publish (e.g. a quarantined thread) — honored here
   * by leaving the boundary row unresolved and logging, rather than
   * silently treating a declined publish as done.
   *
   * INFORMATION CARRIED FORWARD (review round 1, M5): the boundary row's
   * own facts — prior state, provider turn id, owner id, its own
   * created/updated timestamps — are copied onto the event's
   * `interruptedTurnBoundary` payload before the row is deleted, so nothing
   * DELETE discards is unavailable to a future slice (e.g. bounded
   * auto-resume) reading the durable event alone.
   */
  async consume(): Promise<void> {
    const eventStore = this.deps.eventStore();
    if (!eventStore) return;
    const interrupted = eventStore.takeInterruptedTurnBoundaries();
    for (const record of interrupted) {
      if (record.state !== 'accepted' && record.state !== 'indeterminate') {
        // Read-only defensive guard: `EventStore.takeInterruptedTurnBoundaries()`
        // only ever fills this list from those two states (see
        // `session-turn-boundary.ts`'s `reconcileDeadOwners`); skip anything
        // else rather than resolve a row this method does not understand.
        continue;
      }
      try {
        const startEvent = eventStore.latestEventByMethod(
          record.threadId,
          'session.started',
        );
        const provider = startEvent?.provider;
        const agentSlug =
          typeof (startEvent?.payload as { metadata?: Record<string, unknown> })
            ?.metadata?.agentSlug === 'string'
            ? ((startEvent!.payload as { metadata: Record<string, unknown> })
                .metadata.agentSlug as string)
            : undefined;
        const now = new Date().toISOString();

        // ---- H2 core reshape: choose the presentation path by FileMemory
        // occupancy, exactly like the read path — never by provider. ----
        const memoryAdapter = agentSlug
          ? this.deps.memoryAdapterFor(agentSlug)
          : undefined;
        let fileMemoryTarget:
          | { userId: string; alreadyBannered: boolean }
          | undefined;
        if (memoryAdapter && agentSlug) {
          try {
            const occupancy = await resolveFileMemoryOccupancy(
              memoryAdapter,
              agentSlug,
              record.threadId,
            );
            if (occupancy.occupied) {
              fileMemoryTarget = {
                userId: occupancy.userId,
                alreadyBannered: occupancy.alreadyBannered(record.boundaryId),
              };
            }
          } catch (error) {
            // Safe default direction: if occupancy can't be determined,
            // fall back to the event-projected path rather than risk a
            // wrong-store write. `fileMemoryTarget` stays undefined.
            this.deps.logger.warn(
              'Interrupted-turn banner: FileMemory occupancy check failed; defaulting to the event-projected path',
              {
                threadId: record.threadId,
                agentSlug,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }

        // ---- H1(a) + M3 + M5: idempotent, provenance-gated,
        // fact-carrying lifecycle/banner event. ----
        const bannerEventId = `turn-interrupted:${record.boundaryId}`;
        if (!eventStore.hasEventId(bannerEventId)) {
          const published = this.deps.publishEvent({
            eventId: bannerEventId,
            // `EngineId` is a plain string alias, not a closed union —
            // 'unknown' is an honest fallback for the (should not happen)
            // case where no `session.started` survives for a thread that
            // still has an unresolved turn boundary.
            provider: provider ?? 'unknown',
            threadId: record.threadId,
            createdAt: now,
            method: 'session.state-changed',
            sessionId: record.threadId,
            from: 'running',
            to: 'awaiting-approval',
            reason: TURN_INTERRUPTED_MESSAGE,
            sessionState: 'needs_input',
            transitionReason: 'runtime_exit',
            transitionSource: 'system_recovery',
            interruptedTurnBoundary: {
              boundaryId: record.boundaryId,
              priorState: record.state,
              ...(record.providerTurnId
                ? { providerTurnId: record.providerTurnId }
                : {}),
              ownerId: record.ownerId,
              boundaryCreatedAt: record.createdAt,
              boundaryUpdatedAt: record.updatedAt,
            },
          });
          if (!published) {
            // M4: a declined publish (e.g. a quarantined thread) must not
            // be treated as done — retain the row for the next boot.
            this.deps.logger.warn(
              'Interrupted-turn banner event was declined; leaving the boundary row for the next boot',
              {
                threadId: record.threadId,
                boundaryId: record.boundaryId,
                reason: 'projectAndPublishEvent returned false',
              },
            );
            continue;
          }
        }

        // ---- H1(b): idempotent FileMemory write, keyed on the SAME
        // boundaryId, only when that store is the session's real transcript. ----
        if (fileMemoryTarget && !fileMemoryTarget.alreadyBannered) {
          await memoryAdapter!.addMessage(
            {
              id: crypto.randomUUID(),
              role: 'user',
              parts: [
                {
                  type: 'text',
                  text: `[SYSTEM_EVENT] [TURN_INTERRUPTED] ${TURN_INTERRUPTED_MESSAGE}`,
                },
              ],
              metadata: { interruptedTurnBoundaryId: record.boundaryId },
            },
            fileMemoryTarget.userId,
            record.threadId,
          );
        }

        eventStore.resolveInterruptedTurnBoundary({
          boundaryId: record.boundaryId,
          ownerId: record.ownerId,
          state: record.state,
        });
      } catch (error) {
        this.deps.logger.warn(
          'Interrupted-turn banner failed; leaving the boundary row for the next boot',
          {
            threadId: record.threadId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }
}
