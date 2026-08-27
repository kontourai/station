import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { TurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
// IMPORTANT (T12): the suite vi.mocks '../../../telemetry/metrics.js' by
// RESOLVED module id; from this directory the compliant specifier is
// '../../telemetry/metrics.js'. A barrel or a different depth silently gets
// the REAL counter under a mocked suite and reds an unrelated assertion.
import { turnProvenanceProjections } from '../../telemetry/metrics.js';
import type { EventStore } from './event-store.js';

/** Narrow structural logger: this module warns, never debugs. */
export type TurnProvenanceLogger = {
  warn?(message: string, meta?: Record<string, unknown>): void;
};

export interface TurnProvenanceSidecarDeps {
  /**
   * Called, not captured: the store is optional on the service options and a
   * swap after construction must be honoured. This module needs it for both
   * halves of its job — the durable `upsertTurnProvenance` WRITE performed
   * while assembling a live envelope, and the `readTurnProvenance` read the
   * replay path serves from. No Map or per-thread state crosses (T13).
   */
  eventStore: () => EventStore | undefined;
  logger: TurnProvenanceLogger;
}

/**
 * Turn-provenance envelopes for the sibling slot beside a canonical event
 * (station#1410; epic #4024 C2 sub-cut).
 *
 * Extracted from the C2 ingest/publish spine, which is otherwise CLOSED BY
 * INSPECTION — see the map's §II.3 C2 closure section for why the spine
 * itself must not move (own-nothing hub with eight back-edges, ~28-30 deps,
 * and two construction cycles that only `this` makes legal today). This trio
 * was the one part of C2 that is a genuine leaf: it touches
 * `options.eventStore` and `options.logger` and NOTHING else, which is why it
 * needs exactly two deps where the spine would need thirty.
 *
 * The move is also an encapsulation gain rather than a relocation: the
 * durable `upsertTurnProvenance` write lived inside a method named for
 * assembly, where a reader of the ingest spine had no reason to look for a
 * write at all. Here the write is on the module that owns the concern.
 *
 * Counts `turnProvenanceProjections`, so it DOES need the T12-compliant
 * metrics specifier (see the import note above). An earlier draft of this
 * docblock claimed the module emits no metrics; the typechecker caught that
 * as an unresolved name, which is the only reason the wrong specifier was
 * never written. Recorded because "this module emits no metrics" is a claim
 * worth checking rather than inheriting.
 */
export class TurnProvenanceSidecar {
  constructor(private readonly deps: TurnProvenanceSidecarDeps) {}

  /**
   * station#1410: the completed turn's provenance envelope, for the sibling
   * slot beside the canonical event. Empty for every other event.
   *
   * Canonical events remain authoritative. The live path folds this turn
   * after its terminal event is persisted, then saves the exact bounded
   * envelope as a replay sidecar. A replay performs the keyed sidecar read;
   * rows that predate this projection deliberately disclose no envelope.
   *
   * Deliberately scoped to `turn.completed`: `turn.aborted` commits no
   * assistant bubble on the live path (`handleTurnAbortedEvent` clears the
   * streaming shell), so there would be nothing to attach an envelope to.
   *
   * Fails soft. The live caller runs inside the single dispatch point every
   * event flows through; a throw there would break event publication for the
   * whole session, and a missing card is enormously cheaper than a broken
   * stream.
   */
  private assembleFor(event: CanonicalRuntimeEvent): {
    provenance?: TurnProvenanceEnvelope;
  } {
    if (event.method !== 'turn.completed' || !event.turnId) return {};
    try {
      // Narrow to THIS turn before folding. The fold is linear, but the
      // unfiltered version re-walked (and re-parsed) the whole session on
      // every completed turn, on the hot publish path — quadratic over a
      // long session, for one turn's answer. The filter is the same strict
      // correlation the fold itself uses, so the result is identical.
      const events = (
        this.deps
          .eventStore()
          ?.listEventsForTurn(event.threadId, event.turnId) ?? []
      ).map((persisted) => persisted.payload);
      const envelope = assembleTurnProvenanceEnvelopes(events).find(
        (candidate) =>
          candidate.turnId === event.turnId &&
          candidate.sessionId === event.threadId,
      );
      const boundary = this.deps
        .eventStore()
        ?.conversationContextBoundaryForSuccessor(event.threadId);
      // A reservation is not answer provenance. Only the consumed, durable
      // effect becomes a fact on every answer from its successor Session.
      const withContextBoundary =
        envelope && boundary?.status === 'consumed'
          ? {
              ...envelope,
              contextBoundary: {
                state: 'observed' as const,
                value: {
                  boundaryId: boundary.boundaryId,
                  policy: boundary.policy,
                  priorTranscriptInjected:
                    boundary.policy === 'continue-from-history',
                },
                observedFrom: [
                  { eventId: event.eventId, method: event.method },
                ],
              },
            }
          : envelope;
      if (withContextBoundary)
        this.deps.eventStore()?.upsertTurnProvenance(withContextBoundary);
      return withContextBoundary ? { provenance: withContextBoundary } : {};
    } catch (error) {
      this.deps.logger?.warn?.(
        'turn-provenance: failed to assemble the live envelope for a completed turn',
        { error: error instanceof Error ? error.message : String(error) },
      );
      return {};
    }
  }

  /**
   * The live publish path's sidecar: assembly plus the metric.
   *
   * The counter sits ABOVE the turn-id guard inside `assembleTurnProvenanceFor`
   * on purpose — a completed turn carrying no turn id is precisely the
   * population `absent` is meant to measure (an engine whose events cannot be
   * correlated). Counting only turns that HAVE an id would report a perfect
   * assembly rate for exactly the sessions the metric exists to expose.
   */
  sidecarFor(event: CanonicalRuntimeEvent): {
    provenance?: TurnProvenanceEnvelope;
  } {
    if (event.method !== 'turn.completed') return {};
    const sidecar = this.assembleFor(event);
    turnProvenanceProjections.add(1, {
      envelope: sidecar.provenance ? 'assembled' : 'absent',
    });
    return sidecar;
  }

  /**
   * station#1410 (D2): the same sidecar for a REPLAYED frame.
   *
   * A client that was disconnected while a turn completed resumes through the
   * `/events` replay branch, which re-emits persisted events from the cursor.
   * Those frames are the ONLY delivery that turn gets — the live publish
   * already happened and nothing triggers a REST refetch — so without this a
   * turn completed during a blip had no card until the next remount, which is
   * the same hole `turnProvenanceSidecar` closed for the live path.
   *
   * Deliberately does NOT record the metric: the counter measures completed
   * TURNS, and a replay is a redelivery of a turn already counted. Counting
   * here would inflate the denominator by however many clients reconnected.
   */
  replaySidecarFor(event: CanonicalRuntimeEvent): {
    provenance?: TurnProvenanceEnvelope;
  } {
    if (event.method !== 'turn.completed' || !event.turnId) return {};
    const provenance = this.deps
      .eventStore()
      ?.readTurnProvenance(event.threadId, event.turnId);
    return provenance ? { provenance } : {};
  }
}
