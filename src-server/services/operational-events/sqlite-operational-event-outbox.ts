import type {
  OperationalEventOutboxCoordinator,
  PersistedOperationalEvent,
} from './operational-event-outbox.js';

export const OPERATIONAL_EVENT_RETENTION = 1_000;

interface SqliteStatement {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface OperationalEventSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

/** Private SQLite Adapter for OperationalEventOutbox. */
export function createSqliteOperationalEventCoordinator(input: {
  database: OperationalEventSqliteDatabase;
  retention?: number;
  /** Fault-only proof seam; never policy. */
  afterAppendCommit?: () => void;
  /** Fault-only proof seam for a concurrent WAL writer during replay. */
  afterReadBounds?: () => void;
}): OperationalEventOutboxCoordinator {
  const retention = input.retention ?? OPERATIONAL_EVENT_RETENTION;
  if (!Number.isSafeInteger(retention) || retention < 1)
    throw new Error('Operational event retention must be a positive integer');

  return Object.freeze({
    append(
      record: Parameters<OperationalEventOutboxCoordinator['append']>[0],
    ): ReturnType<OperationalEventOutboxCoordinator['append']> {
      let committed = false;
      let committedJournalSequence: number | undefined;
      try {
        input.database.exec('BEGIN IMMEDIATE');
        const existing = input.database
          .prepare(
            `SELECT journal_sequence
             FROM operational_event_identities WHERE event_id = ?`,
          )
          .get(record.event.id) as { journal_sequence: number } | undefined;
        if (existing) {
          input.database.exec('COMMIT');
          committed = true;
          return {
            kind: 'duplicate',
            journalSequence: existing.journal_sequence,
          } as const;
        }

        input.database
          .prepare(
            `INSERT INTO operational_events
              (event_id, event_type, occurred_at, delivery, envelope_json, payload_bytes, persisted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.event.id,
            record.event.type,
            record.event.occurredAt,
            record.event.delivery,
            record.envelopeJson,
            record.payloadBytes,
            record.persistedAt,
          );
        const inserted = input.database
          .prepare('SELECT sequence FROM operational_events WHERE event_id = ?')
          .get(record.event.id) as { sequence: number } | undefined;
        if (!inserted)
          throw new Error('Operational event insert was not observable');

        input.database
          .prepare(
            `INSERT INTO operational_event_identities
              (event_id, journal_sequence, recorded_at)
             VALUES (?, ?, ?)`,
          )
          .run(record.event.id, inserted.sequence, record.persistedAt);

        const insertScope = input.database.prepare(
          `INSERT INTO operational_event_scopes (event_id, scope_key)
           VALUES (?, ?)`,
        );
        for (const scopeKey of record.scopeKeys)
          insertScope.run(record.event.id, scopeKey);

        const corruptPruned = input.database
          .prepare(
            `SELECT 1 FROM operational_events event
             WHERE event.sequence IN (
               SELECT sequence FROM operational_events
               ORDER BY sequence DESC LIMIT -1 OFFSET ?
             )
               AND (
                 json_valid(event.envelope_json) = 0
                 OR json_type(event.envelope_json, '$.scopes') IS NULL
                 OR json_type(event.envelope_json, '$.scopes') <> 'array'
                 OR json_extract(event.envelope_json, '$.type') IS NULL
                 OR json_extract(event.envelope_json, '$.type') <> event.event_type
                 OR EXISTS (
                   SELECT 1 FROM operational_event_scopes stored
                   WHERE stored.event_id = event.event_id
                     AND NOT EXISTS (
                       SELECT 1 FROM json_each(event.envelope_json, '$.scopes') actual
                       WHERE json(actual.value) = stored.scope_key
                     )
                 )
                 OR EXISTS (
                   SELECT 1 FROM json_each(event.envelope_json, '$.scopes') actual
                   WHERE NOT EXISTS (
                     SELECT 1 FROM operational_event_scopes stored
                     WHERE stored.event_id = event.event_id
                       AND stored.scope_key = json(actual.value)
                   )
                 )
               )
             LIMIT 1`,
          )
          .get(retention);
        if (corruptPruned)
          throw new Error('Pruned operational event filter facts are corrupt');

        input.database
          .prepare(
            `INSERT INTO operational_event_consumer_gaps
              (consumer_id, latest_missing_sequence, recorded_at)
             SELECT consumer.consumer_id, event.sequence, ?
             FROM operational_events event
             JOIN operational_event_consumers consumer
             WHERE event.sequence IN (
               SELECT sequence FROM operational_events
               ORDER BY sequence DESC LIMIT -1 OFFSET ?
             )
               AND event.sequence > consumer.cursor_sequence
               AND EXISTS (
                 SELECT 1 FROM operational_event_consumer_types type
                 WHERE type.consumer_id = consumer.consumer_id
                   AND type.event_type = event.event_type
               )
               AND NOT EXISTS (
                 SELECT 1 FROM operational_event_consumer_scopes required
                 WHERE required.consumer_id = consumer.consumer_id
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(event.envelope_json, '$.scopes') actual
                     WHERE json(actual.value) = required.scope_key
                   )
               )
             ON CONFLICT(consumer_id) DO UPDATE SET
               latest_missing_sequence = MAX(
                 latest_missing_sequence,
                 excluded.latest_missing_sequence
               ),
               recorded_at = excluded.recorded_at`,
          )
          .run(record.persistedAt, retention);

        input.database
          .prepare(
            `DELETE FROM operational_events
             WHERE sequence IN (
               SELECT sequence FROM operational_events
               ORDER BY sequence DESC
               LIMIT -1 OFFSET ?
             )`,
          )
          .run(retention);
        input.database
          .prepare(
            `DELETE FROM operational_event_scopes
             WHERE event_id NOT IN (SELECT event_id FROM operational_events)`,
          )
          .run();
        input.database.exec('COMMIT');
        committed = true;
        committedJournalSequence = inserted.sequence;
        input.afterAppendCommit?.();
        return {
          kind: 'appended',
          journalSequence: inserted.sequence,
        } as const;
      } catch {
        if (committed && committedJournalSequence !== undefined)
          return {
            kind: 'appended',
            journalSequence: committedJournalSequence,
          } as const;
        if (!committed) {
          try {
            input.database.exec('ROLLBACK');
          } catch {
            // Exact readback below remains authoritative.
          }
        }
        try {
          const identity = input.database
            .prepare(
              `SELECT journal_sequence
               FROM operational_event_identities WHERE event_id = ?`,
            )
            .get(record.event.id) as { journal_sequence: number } | undefined;
          if (!identity) return { kind: 'unavailable' } as const;
          const row = input.database
            .prepare(
              `SELECT sequence, envelope_json
               FROM operational_events WHERE event_id = ?`,
            )
            .get(record.event.id) as
            | { sequence: number; envelope_json: string }
            | undefined;
          if (
            row &&
            row.sequence === identity.journal_sequence &&
            row.envelope_json === record.envelopeJson
          )
            return {
              kind: 'appended',
              journalSequence: identity.journal_sequence,
            } as const;
          return {
            kind: 'duplicate',
            journalSequence: identity.journal_sequence,
          } as const;
        } catch {
          // Storage remains unavailable; return the total outcome below.
        }
        return { kind: 'unavailable' } as const;
      }
    },

    readAfter(
      request: Parameters<OperationalEventOutboxCoordinator['readAfter']>[0],
    ): ReturnType<OperationalEventOutboxCoordinator['readAfter']> {
      let transactionOpen = false;
      try {
        input.database.exec('BEGIN');
        transactionOpen = true;
        const bounds = input.database
          .prepare(
            `SELECT COALESCE(MIN(sequence), 0) AS earliest,
                    COALESCE(MAX(sequence), 0) AS latest
             FROM operational_events`,
          )
          .get() as { earliest: number; latest: number };
        input.afterReadBounds?.();
        const rows = input.database
          .prepare(
            `SELECT sequence, event_id, event_type, occurred_at, delivery,
                    envelope_json, payload_bytes
             FROM operational_events
             WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
          )
          .all(request.afterJournalSequence, request.limit + 1) as Array<{
          sequence: number;
          event_id: string;
          event_type: string;
          occurred_at: string;
          delivery: string;
          envelope_json: string;
          payload_bytes: number;
        }>;
        const hasMore = rows.length > request.limit;
        const events: PersistedOperationalEvent[] = rows
          .slice(0, request.limit)
          .map((row) => {
            const event = JSON.parse(
              row.envelope_json,
            ) as PersistedOperationalEvent['event'];
            if (
              event.id !== row.event_id ||
              event.type !== row.event_type ||
              event.occurredAt !== row.occurred_at ||
              event.delivery !== row.delivery ||
              Buffer.byteLength(JSON.stringify(event.payload?.data)) !==
                row.payload_bytes
            )
              throw new Error('Operational event storage columns disagree');
            return { journalSequence: row.sequence, event };
          });
        input.database.exec('COMMIT');
        transactionOpen = false;
        return {
          kind: 'available',
          events,
          hasMore,
          earliestJournalSequence: bounds.earliest,
          latestJournalSequence: bounds.latest,
        } as const;
      } catch {
        if (transactionOpen) {
          try {
            input.database.exec('ROLLBACK');
          } catch {
            // The read remains unavailable; no partial snapshot is returned.
          }
        }
        return { kind: 'unavailable' } as const;
      }
    },
  });
}
