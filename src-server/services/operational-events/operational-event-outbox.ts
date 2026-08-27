import {
  DEFAULT_OPERATIONAL_EVENT_TYPE_REGISTRY,
  type OperationalEventDiagnostic,
  type OperationalEventEnvelope,
  type OperationalEventScope,
  type OperationalEventTypeRegistry,
  validateOperationalEventEnvelope,
} from '@kontourai/station-contracts/operational-event';

export interface PersistedOperationalEvent {
  journalSequence: number;
  event: OperationalEventEnvelope;
}

/** Canonical private key shared by outbox persistence and consumer filters. */
export function operationalEventScopeKey(scope: OperationalEventScope): string {
  return JSON.stringify(scope);
}

export type OperationalEventAppendOutcome =
  | {
      kind: 'appended';
      journalSequence: number;
      event: OperationalEventEnvelope;
    }
  | { kind: 'duplicate'; journalSequence: number }
  | { kind: 'rejected'; diagnostics: OperationalEventDiagnostic[] }
  | { kind: 'unavailable' };

export type OperationalEventReadOutcome =
  | {
      kind: 'available';
      events: PersistedOperationalEvent[];
      hasMore: boolean;
      latestJournalSequence: number;
      gap?: {
        requestedAfterJournalSequence: number;
        earliestAvailableJournalSequence: number;
      };
    }
  | { kind: 'rejected'; code: 'invalid-cursor' | 'invalid-limit' }
  | { kind: 'unavailable' };

export interface OperationalEventPublisher {
  append(value: unknown): OperationalEventAppendOutcome;
}

export interface OperationalEventReader {
  readAfter(input?: {
    afterJournalSequence?: number;
    limit?: number;
  }): OperationalEventReadOutcome;
}

export interface OperationalEventOutbox
  extends OperationalEventPublisher,
    OperationalEventReader {}

export interface OperationalEventNotificationAdapter {
  appended(event: PersistedOperationalEvent): void;
}

export type OperationalEventStorageAppendOutcome =
  | { kind: 'appended'; journalSequence: number }
  | { kind: 'duplicate'; journalSequence: number }
  | { kind: 'unavailable' };

export type OperationalEventStorageReadOutcome =
  | {
      kind: 'available';
      events: PersistedOperationalEvent[];
      hasMore: boolean;
      earliestJournalSequence: number;
      latestJournalSequence: number;
    }
  | { kind: 'unavailable' };

export interface OperationalEventOutboxCoordinator {
  append(input: {
    event: OperationalEventEnvelope;
    envelopeJson: string;
    scopeKeys: string[];
    payloadBytes: number;
    persistedAt: string;
  }): OperationalEventStorageAppendOutcome;
  readAfter(input: {
    afterJournalSequence: number;
    limit: number;
  }): OperationalEventStorageReadOutcome;
}

const DEFAULT_PAGE_LIMIT = 100;
export const MAX_OPERATIONAL_EVENT_REPLAY_PAGE = 1_000;

function deliveryRejection(): OperationalEventDiagnostic {
  return {
    code: 'invalid-delivery',
    path: 'delivery',
    message: 'ephemeral events are not admitted to the durable outbox',
  };
}

/**
 * The one intent-shaped authority over the durable operational-event journal.
 * SQLite identity, retention, and readback stay behind the coordinator.
 */
export function createOperationalEventOutbox(input: {
  coordinator: OperationalEventOutboxCoordinator;
  registry?: OperationalEventTypeRegistry;
  notification?: OperationalEventNotificationAdapter;
  now?: () => string;
}): OperationalEventOutbox {
  const registry = input.registry ?? DEFAULT_OPERATIONAL_EVENT_TYPE_REGISTRY;
  const now = input.now ?? (() => new Date().toISOString());

  return Object.freeze({
    append(value: unknown): OperationalEventAppendOutcome {
      const validated = validateOperationalEventEnvelope(value, registry);
      if (!validated.ok)
        return { kind: 'rejected', diagnostics: validated.diagnostics };
      if (validated.event.delivery === 'ephemeral')
        return { kind: 'rejected', diagnostics: [deliveryRejection()] };

      const event = validated.event;
      const envelopeJson = JSON.stringify(event);
      const payloadBytes = Buffer.byteLength(
        JSON.stringify(event.payload.data),
      );
      const stored = input.coordinator.append({
        event,
        envelopeJson,
        scopeKeys: event.scopes.map(operationalEventScopeKey),
        payloadBytes,
        persistedAt: now(),
      });
      if (stored.kind !== 'appended') return stored;

      const persisted = {
        journalSequence: stored.journalSequence,
        event,
      };
      try {
        input.notification?.appended(persisted);
      } catch {
        // Durable truth is already committed. An observer cannot undo it or
        // change the receipt that the producer receives.
      }
      return { kind: 'appended', ...persisted };
    },

    readAfter({
      afterJournalSequence = 0,
      limit = DEFAULT_PAGE_LIMIT,
    } = {}): OperationalEventReadOutcome {
      if (
        !Number.isSafeInteger(afterJournalSequence) ||
        afterJournalSequence < 0
      )
        return { kind: 'rejected', code: 'invalid-cursor' };
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_OPERATIONAL_EVENT_REPLAY_PAGE
      )
        return { kind: 'rejected', code: 'invalid-limit' };

      const stored = input.coordinator.readAfter({
        afterJournalSequence,
        limit,
      });
      if (stored.kind === 'unavailable') return stored;
      if (afterJournalSequence > stored.latestJournalSequence)
        return { kind: 'rejected', code: 'invalid-cursor' };
      const events: PersistedOperationalEvent[] = [];
      for (const persisted of stored.events) {
        const validated = validateOperationalEventEnvelope(
          persisted.event,
          registry,
        );
        if (!validated.ok) return { kind: 'unavailable' };
        events.push({
          journalSequence: persisted.journalSequence,
          event: validated.event,
        });
      }
      const gap =
        stored.earliestJournalSequence > 0 &&
        afterJournalSequence + 1 < stored.earliestJournalSequence
          ? {
              requestedAfterJournalSequence: afterJournalSequence,
              earliestAvailableJournalSequence: stored.earliestJournalSequence,
            }
          : undefined;
      return {
        kind: 'available',
        events,
        hasMore: stored.hasMore,
        latestJournalSequence: stored.latestJournalSequence,
        ...(gap ? { gap } : {}),
      };
    },
  });
}
