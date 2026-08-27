import type { OperationalEventEnvelope } from '@kontourai/station-contracts/operational-event';
import {
  MAX_OPERATIONAL_EVENT_DEAD_LETTERS,
  type OperationalEventDeadLetterOutcome,
  type OperationalEventDeliveryCoordinator,
  type OperationalEventDeliveryCurrentOutcome,
  type OperationalEventDeliveryOwner,
  type OperationalEventDeliveryRecord,
  type OperationalEventDeliveryTransition,
  operationalEventIdempotencyKey,
} from './operational-event-delivery.js';
import type { OperationalEventSqliteDatabase } from './sqlite-operational-event-outbox.js';

type SqliteRunResult = { changes: number | bigint };

interface DeliveryRow {
  consumer_id: string;
  journal_sequence: number;
  event_id: string;
  envelope_json: string;
  idempotency_key: string;
  attempt: number;
  state: 'claimed' | 'retry';
  owner_id: string | null;
  owner_pid: number | null;
  owner_birth: string | null;
  owner_identity_kind: string | null;
  next_attempt_at: string | null;
}

interface SettlementRow {
  settlement_id: string;
  owner_id: string;
  owner_pid: number;
  owner_birth: string | null;
  owner_identity_kind: string;
}

function changed(value: unknown): boolean {
  const result = value as SqliteRunResult;
  return Number(result.changes) === 1;
}

function record(row: DeliveryRow): OperationalEventDeliveryRecord {
  const event = JSON.parse(row.envelope_json) as OperationalEventEnvelope;
  if (
    event.id !== row.event_id ||
    operationalEventIdempotencyKey(row.consumer_id, row.event_id) !==
      row.idempotency_key
  )
    throw new Error('Operational event delivery identity is corrupt');
  return {
    consumerId: row.consumer_id,
    journalSequence: row.journal_sequence,
    event,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    state: row.state,
    ownerId: row.owner_id,
    ownerPid: row.owner_pid,
    ownerBirth: row.owner_birth,
    ownerIdentityKind: row.owner_identity_kind,
    nextAttemptAt: row.next_attempt_at,
  };
}

function ownerArgs(owner: OperationalEventDeliveryOwner): unknown[] {
  return [
    owner.id,
    owner.pid,
    owner.identityKind === 'exact' ? owner.birth : null,
    owner.identityKind,
  ];
}

function rollback(database: OperationalEventSqliteDatabase): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // The caller returns unavailable; rollback diagnostics are not authority.
  }
}

function pruneDeadLetters(
  database: OperationalEventSqliteDatabase,
  consumerId: string,
  maxDeadLetters: number,
): void {
  database
    .prepare(
      `DELETE FROM operational_event_deliveries
       WHERE rowid IN (
         SELECT rowid FROM operational_event_deliveries
         WHERE consumer_id = ? AND state = 'dead-letter'
         ORDER BY terminal_at DESC, journal_sequence DESC
         LIMIT -1 OFFSET ?
       )`,
    )
    .run(consumerId, maxDeadLetters);
}

function exactActive(
  database: OperationalEventSqliteDatabase,
  input: {
    consumerId: string;
    journalSequence: number;
    attempt: number;
    owner: OperationalEventDeliveryOwner;
  },
): DeliveryRow | undefined {
  return database
    .prepare(
      `SELECT consumer_id, journal_sequence, event_id, envelope_json,
              idempotency_key, attempt, state, owner_id, owner_pid,
              owner_birth, owner_identity_kind, next_attempt_at
       FROM operational_event_deliveries
       WHERE consumer_id = ? AND journal_sequence = ? AND attempt = ?
         AND owner_id = ? AND state = 'claimed'`,
    )
    .get(
      input.consumerId,
      input.journalSequence,
      input.attempt,
      input.owner.id,
    ) as DeliveryRow | undefined;
}

function exactReceipt(
  database: OperationalEventSqliteDatabase,
  input: {
    settlementId: string;
    consumerId: string;
    journalSequence: number;
    attempt: number;
    owner: OperationalEventDeliveryOwner;
  },
  kind: 'acknowledged' | 'retry' | 'dead-letter' | 'gap',
  failureCode: string | null,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM operational_event_delivery_receipts
         WHERE settlement_id = ? AND consumer_id = ? AND journal_sequence = ?
           AND attempt = ? AND owner_id = ? AND settlement_kind = ?
           AND failure_code IS ?`,
      )
      .get(
        input.settlementId,
        input.consumerId,
        input.journalSequence,
        input.attempt,
        input.owner.id,
        kind,
        failureCode,
      ),
  );
}

function insertReceipt(
  database: OperationalEventSqliteDatabase,
  input: {
    settlementId: string;
    consumerId: string;
    journalSequence: number;
    attempt: number;
    owner: OperationalEventDeliveryOwner;
    now: string;
  },
  kind: 'acknowledged' | 'retry' | 'dead-letter' | 'gap',
  failureCode: string | null,
): void {
  database
    .prepare(
      `INSERT INTO operational_event_delivery_receipts
        (settlement_id, consumer_id, journal_sequence, attempt, owner_id,
         owner_pid, owner_birth, owner_identity_kind, settlement_kind,
         failure_code, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.settlementId,
      input.consumerId,
      input.journalSequence,
      input.attempt,
      ...ownerArgs(input.owner),
      kind,
      failureCode,
      input.now,
    );
}

function discardReceipt(
  database: OperationalEventSqliteDatabase,
  settlementId: string,
  beforeDiscard?: () => void,
): void {
  try {
    beforeDiscard?.();
    database
      .prepare(
        `DELETE FROM operational_event_delivery_receipts
         WHERE settlement_id = ?`,
      )
      .run(settlementId);
  } catch {
    // A committed transition remains applied; later owner cleanup reclaims it.
  }
}

function policyMatches(
  database: OperationalEventSqliteDatabase,
  input: { consumerId: string; eventTypes: string[]; scopeKeys: string[] },
): boolean {
  const persistedTypes = database
    .prepare(
      `SELECT event_type FROM operational_event_consumer_types
       WHERE consumer_id = ? ORDER BY event_type`,
    )
    .all(input.consumerId) as Array<{ event_type: string }>;
  const persistedScopes = database
    .prepare(
      `SELECT scope_key FROM operational_event_consumer_scopes
       WHERE consumer_id = ? ORDER BY scope_key`,
    )
    .all(input.consumerId) as Array<{ scope_key: string }>;
  return (
    JSON.stringify(persistedTypes.map((row) => row.event_type)) ===
      JSON.stringify([...input.eventTypes].sort()) &&
    JSON.stringify(persistedScopes.map((row) => row.scope_key)) ===
      JSON.stringify([...input.scopeKeys].sort())
  );
}

/** SQLite Adapter for scope-bound operational-event delivery state. */
export function createSqliteOperationalEventDeliveryCoordinator(input: {
  database: OperationalEventSqliteDatabase;
  /** Fault-only proof seam; never delivery policy. */
  afterClaimCommit?: () => void;
  /** Fault-only proof seam; never delivery policy. */
  afterAcknowledgeCommit?: () => void;
  /** Fault-only proof seam; never delivery policy. */
  afterGapCommit?: () => void;
  /** Fault-only proof seam; never delivery policy. */
  afterRetryCommit?: () => void;
  /** Fault-only proof seam; never delivery policy. */
  afterDeadLetterCommit?: () => void;
  /** Fault-only proof seam; never delivery policy. */
  beforeReceiptDiscard?: () => void;
}): OperationalEventDeliveryCoordinator {
  const database = input.database;
  const discardCommittedReceipt = (settlementId: string): void =>
    discardReceipt(database, settlementId, input.beforeReceiptDiscard);
  return Object.freeze({
    open(request: Parameters<OperationalEventDeliveryCoordinator['open']>[0]) {
      let committed = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        const existing = database
          .prepare(
            `SELECT config_fingerprint FROM operational_event_consumers
             WHERE consumer_id = ?`,
          )
          .get(request.consumerId) as
          | { config_fingerprint: string }
          | undefined;
        if (existing) {
          database.exec('COMMIT');
          committed = true;
          if (existing.config_fingerprint !== request.configFingerprint)
            return 'conflict';
          return policyMatches(database, request) ? 'opened' : 'unavailable';
        }
        const count = database
          .prepare('SELECT COUNT(*) AS count FROM operational_event_consumers')
          .get() as { count: number };
        if (count.count >= request.maxConsumers) {
          database.exec('COMMIT');
          committed = true;
          return 'capacity';
        }
        const retainedFloor = database
          .prepare(
            `SELECT COALESCE(MIN(sequence) - 1, 0) AS cursor
             FROM operational_events`,
          )
          .get() as { cursor: number };
        database
          .prepare(
            `INSERT INTO operational_event_consumers
              (consumer_id, config_fingerprint, cursor_sequence, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            request.consumerId,
            request.configFingerprint,
            retainedFloor.cursor,
            request.now,
            request.now,
          );
        const insertType = database.prepare(
          `INSERT INTO operational_event_consumer_types
            (consumer_id, event_type) VALUES (?, ?)`,
        );
        for (const eventType of request.eventTypes)
          insertType.run(request.consumerId, eventType);
        const insertScope = database.prepare(
          `INSERT INTO operational_event_consumer_scopes
            (consumer_id, scope_key) VALUES (?, ?)`,
        );
        for (const scopeKey of request.scopeKeys)
          insertScope.run(request.consumerId, scopeKey);
        database.exec('COMMIT');
        committed = true;
        return 'opened';
      } catch {
        if (!committed) rollback(database);
        try {
          const row = database
            .prepare(
              `SELECT config_fingerprint FROM operational_event_consumers
               WHERE consumer_id = ?`,
            )
            .get(request.consumerId) as
            | { config_fingerprint: string }
            | undefined;
          if (row)
            return row.config_fingerprint === request.configFingerprint
              ? policyMatches(database, request)
                ? 'opened'
                : 'unavailable'
              : 'conflict';
        } catch {
          // Storage remains unavailable.
        }
        return 'unavailable';
      }
    },

    current(consumerId: string): OperationalEventDeliveryCurrentOutcome {
      let transactionOpen = false;
      try {
        database.exec('BEGIN');
        transactionOpen = true;
        const consumer = database
          .prepare(
            `SELECT cursor_sequence FROM operational_event_consumers
             WHERE consumer_id = ?`,
          )
          .get(consumerId) as { cursor_sequence: number } | undefined;
        if (!consumer) throw new Error('Operational event consumer is absent');
        const bounds = database
          .prepare(
            `SELECT COALESCE(MIN(sequence), 0) AS earliest,
                    COALESCE(MAX(sequence), 0) AS latest
             FROM operational_events`,
          )
          .get() as { earliest: number; latest: number };
        const active = database
          .prepare(
            `SELECT consumer_id, journal_sequence, event_id, envelope_json,
                    idempotency_key, attempt, state, owner_id, owner_pid,
                    owner_birth, owner_identity_kind, next_attempt_at
             FROM operational_event_deliveries
             WHERE consumer_id = ? AND state IN ('claimed', 'retry')`,
          )
          .get(consumerId) as DeliveryRow | undefined;
        const settlement = database
          .prepare(
            `SELECT settlement_id, owner_id, owner_pid, owner_birth,
                    owner_identity_kind
             FROM operational_event_delivery_receipts
             WHERE consumer_id = ?`,
          )
          .get(consumerId) as SettlementRow | undefined;
        const outcome: OperationalEventDeliveryCurrentOutcome = {
          kind: 'available',
          cursorSequence: consumer.cursor_sequence,
          earliestJournalSequence: bounds.earliest,
          latestJournalSequence: bounds.latest,
          ...(active ? { active: record(active) } : {}),
          ...(settlement
            ? {
                settlement: {
                  settlementId: settlement.settlement_id,
                  ownerId: settlement.owner_id,
                  ownerPid: settlement.owner_pid,
                  ownerBirth: settlement.owner_birth,
                  ownerIdentityKind: settlement.owner_identity_kind,
                },
              }
            : {}),
        };
        database.exec('COMMIT');
        transactionOpen = false;
        return outcome;
      } catch {
        if (transactionOpen) rollback(database);
        return { kind: 'unavailable' };
      }
    },

    claimNext(
      request: Parameters<OperationalEventDeliveryCoordinator['claimNext']>[0],
    ) {
      let committed = false;
      let committedDelivery: OperationalEventDeliveryRecord | undefined;
      try {
        database.exec('BEGIN IMMEDIATE');
        const consumer = database
          .prepare(
            `SELECT cursor_sequence FROM operational_event_consumers
             WHERE consumer_id = ?`,
          )
          .get(request.consumerId) as { cursor_sequence: number } | undefined;
        if (!consumer) throw new Error('Operational event consumer is absent');
        const active = database
          .prepare(
            `SELECT 1 FROM operational_event_deliveries
             WHERE consumer_id = ? AND state IN ('claimed', 'retry')`,
          )
          .get(request.consumerId);
        const settlement = database
          .prepare(
            `SELECT 1 FROM operational_event_delivery_receipts
             WHERE consumer_id = ?`,
          )
          .get(request.consumerId);
        if (active || settlement) {
          database.exec('COMMIT');
          committed = true;
          return { kind: 'busy' } as const;
        }
        const bounds = database
          .prepare(
            `SELECT COALESCE(MIN(sequence), 0) AS earliest,
                    COALESCE(MAX(sequence), 0) AS latest
             FROM operational_events`,
          )
          .get() as { earliest: number; latest: number };
        const gap = database
          .prepare(
            `SELECT latest_missing_sequence
             FROM operational_event_consumer_gaps
             WHERE consumer_id = ?`,
          )
          .get(request.consumerId) as
          | { latest_missing_sequence: number }
          | undefined;
        if (gap && gap.latest_missing_sequence > consumer.cursor_sequence) {
          database.exec('COMMIT');
          committed = true;
          return {
            kind: 'gap',
            cursorSequence: consumer.cursor_sequence,
            earliestJournalSequence: bounds.earliest,
          } as const;
        }
        if (gap)
          database
            .prepare(
              `DELETE FROM operational_event_consumer_gaps
               WHERE consumer_id = ? AND latest_missing_sequence <= ?`,
            )
            .run(request.consumerId, consumer.cursor_sequence);
        if (
          bounds.earliest > 0 &&
          consumer.cursor_sequence + 1 < bounds.earliest
        ) {
          database
            .prepare(
              `UPDATE operational_event_consumers
               SET cursor_sequence = ?, updated_at = ?
               WHERE consumer_id = ? AND cursor_sequence = ?`,
            )
            .run(
              bounds.earliest - 1,
              request.now,
              request.consumerId,
              consumer.cursor_sequence,
            );
        }
        const row = database
          .prepare(
            `SELECT e.sequence, e.event_id, e.envelope_json
             FROM operational_events e
             JOIN operational_event_consumers c ON c.consumer_id = ?
             WHERE e.sequence > c.cursor_sequence
               AND EXISTS (
                 SELECT 1 FROM operational_event_consumer_types t
                 WHERE t.consumer_id = c.consumer_id
                   AND t.event_type = e.event_type
               )
               AND NOT EXISTS (
                     SELECT 1 FROM operational_event_consumer_scopes required
                     WHERE required.consumer_id = c.consumer_id
                       AND NOT EXISTS (
                     SELECT 1 FROM json_each(
                       CASE WHEN json_valid(e.envelope_json)
                         THEN e.envelope_json ELSE '{"scopes":[]}' END,
                       '$.scopes'
                     ) actual
                     WHERE json(actual.value) = required.scope_key
                   )
               )
             ORDER BY e.sequence ASC LIMIT 1`,
          )
          .get(request.consumerId) as
          | { sequence: number; event_id: string; envelope_json: string }
          | undefined;
        if (!row) {
          database
            .prepare(
              `UPDATE operational_event_consumers
               SET cursor_sequence = MAX(cursor_sequence, ?), updated_at = ?
               WHERE consumer_id = ?`,
            )
            .run(bounds.latest, request.now, request.consumerId);
          database.exec('COMMIT');
          committed = true;
          return { kind: 'empty' } as const;
        }
        database
          .prepare(
            `UPDATE operational_event_consumers
             SET cursor_sequence = MAX(cursor_sequence, ?), updated_at = ?
             WHERE consumer_id = ?`,
          )
          .run(row.sequence - 1, request.now, request.consumerId);
        const idempotencyKey = operationalEventIdempotencyKey(
          request.consumerId,
          row.event_id,
        );
        database
          .prepare(
            `INSERT INTO operational_event_deliveries
              (consumer_id, journal_sequence, event_id, envelope_json,
               idempotency_key, attempt, state, owner_id, owner_pid,
               owner_birth, owner_identity_kind, claimed_at, next_attempt_at,
               failure_code, terminal_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 'claimed', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
          )
          .run(
            request.consumerId,
            row.sequence,
            row.event_id,
            row.envelope_json,
            idempotencyKey,
            ...ownerArgs(request.owner),
            request.now,
            request.now,
          );
        const delivery = record(
          database
            .prepare(
              `SELECT consumer_id, journal_sequence, event_id, envelope_json,
                      idempotency_key, attempt, state, owner_id, owner_pid,
                      owner_birth, owner_identity_kind, next_attempt_at
               FROM operational_event_deliveries
               WHERE consumer_id = ? AND journal_sequence = ?`,
            )
            .get(request.consumerId, row.sequence) as DeliveryRow,
        );
        database.exec('COMMIT');
        committed = true;
        committedDelivery = delivery;
        input.afterClaimCommit?.();
        return { kind: 'claimed', delivery } as const;
      } catch {
        if (!committed) rollback(database);
        if (committedDelivery)
          return { kind: 'claimed', delivery: committedDelivery } as const;
        return { kind: 'unavailable' } as const;
      }
    },

    reclaim(
      request: Parameters<OperationalEventDeliveryCoordinator['reclaim']>[0],
    ) {
      let committed = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        const row = database
          .prepare(
            `SELECT consumer_id, journal_sequence, event_id, envelope_json,
                    idempotency_key, attempt, state, owner_id, owner_pid,
                    owner_birth, owner_identity_kind, next_attempt_at
             FROM operational_event_deliveries
             WHERE consumer_id = ? AND journal_sequence = ? AND attempt = ?
               AND owner_id IS ? AND state IN ('claimed', 'retry')`,
          )
          .get(
            request.consumerId,
            request.journalSequence,
            request.expectedAttempt,
            request.expectedOwnerId,
          ) as DeliveryRow | undefined;
        if (!row) {
          database.exec('COMMIT');
          committed = true;
          return { kind: 'stale' } as const;
        }
        if (row.attempt >= request.maxAttempts) {
          database
            .prepare(
              `UPDATE operational_event_deliveries
               SET state = 'dead-letter', owner_id = NULL, owner_pid = NULL,
                   owner_birth = NULL, owner_identity_kind = NULL,
                   failure_code = 'attempts_exhausted', terminal_at = ?,
                   next_attempt_at = NULL, updated_at = ?
               WHERE consumer_id = ? AND journal_sequence = ? AND attempt = ?
                 AND owner_id IS ? AND state IN ('claimed', 'retry')`,
            )
            .run(
              request.now,
              request.now,
              request.consumerId,
              request.journalSequence,
              request.expectedAttempt,
              request.expectedOwnerId,
            );
          database
            .prepare(
              `UPDATE operational_event_consumers
               SET cursor_sequence = MAX(cursor_sequence, ?), updated_at = ?
               WHERE consumer_id = ?`,
            )
            .run(request.journalSequence, request.now, request.consumerId);
          pruneDeadLetters(
            database,
            request.consumerId,
            MAX_OPERATIONAL_EVENT_DEAD_LETTERS,
          );
          database.exec('COMMIT');
          committed = true;
          return { kind: 'dead-lettered' } as const;
        }
        const attempt = row.attempt + 1;
        const updated = database
          .prepare(
            `UPDATE operational_event_deliveries
             SET attempt = ?, state = 'claimed', owner_id = ?, owner_pid = ?,
                 owner_birth = ?, owner_identity_kind = ?, claimed_at = ?,
                 next_attempt_at = NULL, updated_at = ?
             WHERE consumer_id = ? AND journal_sequence = ? AND attempt = ?
               AND owner_id IS ? AND state IN ('claimed', 'retry')`,
          )
          .run(
            attempt,
            ...ownerArgs(request.owner),
            request.now,
            request.now,
            request.consumerId,
            request.journalSequence,
            request.expectedAttempt,
            request.expectedOwnerId,
          );
        if (!changed(updated)) throw new Error('Delivery reclaim lost');
        const delivery = record(
          database
            .prepare(
              `SELECT consumer_id, journal_sequence, event_id, envelope_json,
                      idempotency_key, attempt, state, owner_id, owner_pid,
                      owner_birth, owner_identity_kind, next_attempt_at
               FROM operational_event_deliveries
               WHERE consumer_id = ? AND journal_sequence = ?`,
            )
            .get(request.consumerId, request.journalSequence) as DeliveryRow,
        );
        database.exec('COMMIT');
        committed = true;
        return { kind: 'claimed', delivery } as const;
      } catch {
        if (!committed) rollback(database);
        return { kind: 'unavailable' } as const;
      }
    },

    acknowledge(
      request: Parameters<
        OperationalEventDeliveryCoordinator['acknowledge']
      >[0],
    ): OperationalEventDeliveryTransition {
      let committed = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        if (!exactActive(database, request)) {
          const applied = exactReceipt(database, request, 'acknowledged', null);
          database.exec('COMMIT');
          committed = true;
          if (applied) discardCommittedReceipt(request.settlementId);
          return applied ? { kind: 'applied' } : { kind: 'stale' };
        }
        insertReceipt(database, request, 'acknowledged', null);
        database
          .prepare(
            `UPDATE operational_event_consumers
             SET cursor_sequence = MAX(cursor_sequence, ?), updated_at = ?
             WHERE consumer_id = ?`,
          )
          .run(request.journalSequence, request.now, request.consumerId);
        database
          .prepare(
            `DELETE FROM operational_event_deliveries
             WHERE consumer_id = ? AND journal_sequence = ? AND attempt = ?
               AND owner_id = ? AND state = 'claimed'`,
          )
          .run(
            request.consumerId,
            request.journalSequence,
            request.attempt,
            request.owner.id,
          );
        database.exec('COMMIT');
        committed = true;
        input.afterAcknowledgeCommit?.();
        discardCommittedReceipt(request.settlementId);
        return { kind: 'applied' };
      } catch {
        if (!committed) rollback(database);
        if (committed) {
          discardCommittedReceipt(request.settlementId);
          return { kind: 'applied' };
        }
        try {
          if (exactReceipt(database, request, 'acknowledged', null)) {
            discardCommittedReceipt(request.settlementId);
            return { kind: 'applied' };
          }
        } catch {}
        return { kind: 'unavailable' };
      }
    },

    retry(
      request: Parameters<OperationalEventDeliveryCoordinator['retry']>[0],
    ): OperationalEventDeliveryTransition {
      let committed = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        const updated = database
          .prepare(
            `UPDATE operational_event_deliveries
             SET state = 'retry', owner_id = NULL, owner_pid = NULL,
                 owner_birth = NULL, owner_identity_kind = NULL,
                 next_attempt_at = ?, failure_code = ?, updated_at = ?
             WHERE consumer_id = ? AND journal_sequence = ? AND attempt = ?
               AND owner_id = ? AND state = 'claimed'`,
          )
          .run(
            request.nextAttemptAt,
            request.failureCode,
            request.now,
            request.consumerId,
            request.journalSequence,
            request.attempt,
            request.owner.id,
          );
        if (!changed(updated)) {
          const applied = exactReceipt(
            database,
            request,
            'retry',
            request.failureCode,
          );
          database.exec('COMMIT');
          committed = true;
          if (applied) discardCommittedReceipt(request.settlementId);
          return applied ? { kind: 'applied' } : { kind: 'stale' };
        }
        insertReceipt(database, request, 'retry', request.failureCode);
        database.exec('COMMIT');
        committed = true;
        input.afterRetryCommit?.();
        discardCommittedReceipt(request.settlementId);
        return { kind: 'applied' };
      } catch {
        if (!committed) rollback(database);
        if (committed) {
          discardCommittedReceipt(request.settlementId);
          return { kind: 'applied' };
        }
        try {
          if (exactReceipt(database, request, 'retry', request.failureCode)) {
            discardCommittedReceipt(request.settlementId);
            return { kind: 'applied' };
          }
        } catch {
          // Storage remains unavailable.
        }
        return { kind: 'unavailable' };
      }
    },

    deadLetter(
      request: Parameters<OperationalEventDeliveryCoordinator['deadLetter']>[0],
    ): OperationalEventDeliveryTransition {
      let committed = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        const updated = database
          .prepare(
            `UPDATE operational_event_deliveries
             SET state = 'dead-letter', owner_id = NULL, owner_pid = NULL,
                 owner_birth = NULL, owner_identity_kind = NULL,
                 next_attempt_at = NULL, failure_code = ?, terminal_at = ?,
                 updated_at = ?
             WHERE consumer_id = ? AND journal_sequence = ? AND attempt = ?
               AND owner_id = ? AND state = 'claimed'`,
          )
          .run(
            request.failureCode,
            request.now,
            request.now,
            request.consumerId,
            request.journalSequence,
            request.attempt,
            request.owner.id,
          );
        if (!changed(updated)) {
          const applied = exactReceipt(
            database,
            request,
            'dead-letter',
            request.failureCode,
          );
          database.exec('COMMIT');
          committed = true;
          if (applied) discardCommittedReceipt(request.settlementId);
          return applied ? { kind: 'applied' } : { kind: 'stale' };
        }
        insertReceipt(database, request, 'dead-letter', request.failureCode);
        database
          .prepare(
            `UPDATE operational_event_consumers
             SET cursor_sequence = MAX(cursor_sequence, ?), updated_at = ?
             WHERE consumer_id = ?`,
          )
          .run(request.journalSequence, request.now, request.consumerId);
        pruneDeadLetters(database, request.consumerId, request.maxDeadLetters);
        database.exec('COMMIT');
        committed = true;
        input.afterDeadLetterCommit?.();
        discardCommittedReceipt(request.settlementId);
        return { kind: 'applied' };
      } catch {
        if (!committed) rollback(database);
        if (committed) {
          discardCommittedReceipt(request.settlementId);
          return { kind: 'applied' };
        }
        try {
          if (
            exactReceipt(database, request, 'dead-letter', request.failureCode)
          ) {
            discardCommittedReceipt(request.settlementId);
            return { kind: 'applied' };
          }
        } catch {
          // Storage remains unavailable.
        }
        return { kind: 'unavailable' };
      }
    },

    acknowledgeGap(
      request: Parameters<
        OperationalEventDeliveryCoordinator['acknowledgeGap']
      >[0],
    ): OperationalEventDeliveryTransition {
      let committed = false;
      const receiptInput = {
        ...request,
        journalSequence: request.expectedCursor,
        attempt: 0,
      };
      try {
        database.exec('BEGIN IMMEDIATE');
        const updated = database
          .prepare(
            `UPDATE operational_event_consumers
             SET cursor_sequence = ?, updated_at = ?
             WHERE consumer_id = ? AND cursor_sequence = ?
               AND NOT EXISTS (
                 SELECT 1 FROM operational_event_deliveries
                 WHERE consumer_id = ? AND state IN ('claimed', 'retry')
               )`,
          )
          .run(
            request.earliestJournalSequence - 1,
            request.now,
            request.consumerId,
            request.expectedCursor,
            request.consumerId,
          );
        if (changed(updated))
          database
            .prepare(
              `DELETE FROM operational_event_consumer_gaps
               WHERE consumer_id = ?
                 AND latest_missing_sequence < ?`,
            )
            .run(request.consumerId, request.earliestJournalSequence);
        if (changed(updated))
          insertReceipt(database, receiptInput, 'gap', null);
        const applied = changed(updated)
          ? true
          : exactReceipt(database, receiptInput, 'gap', null);
        database.exec('COMMIT');
        committed = true;
        input.afterGapCommit?.();
        if (applied) discardCommittedReceipt(request.settlementId);
        return applied ? { kind: 'applied' } : { kind: 'stale' };
      } catch {
        if (!committed) rollback(database);
        if (committed) {
          discardCommittedReceipt(request.settlementId);
          return { kind: 'applied' };
        }
        try {
          if (exactReceipt(database, receiptInput, 'gap', null)) {
            discardCommittedReceipt(request.settlementId);
            return { kind: 'applied' };
          }
        } catch {
          // Storage remains unavailable.
        }
        return { kind: 'unavailable' };
      }
    },

    discardSettlement(
      request: Parameters<
        OperationalEventDeliveryCoordinator['discardSettlement']
      >[0],
    ): OperationalEventDeliveryTransition {
      try {
        const result = database
          .prepare(
            `DELETE FROM operational_event_delivery_receipts
             WHERE consumer_id = ? AND settlement_id = ? AND owner_id = ?`,
          )
          .run(request.consumerId, request.settlementId, request.ownerId);
        return changed(result) ? { kind: 'applied' } : { kind: 'stale' };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    deadLetters(consumerId: string): OperationalEventDeadLetterOutcome {
      try {
        const rows = database
          .prepare(
            `SELECT journal_sequence, event_id, idempotency_key, attempt,
                    failure_code, terminal_at
             FROM operational_event_deliveries
             WHERE consumer_id = ? AND state = 'dead-letter'
             ORDER BY terminal_at DESC, journal_sequence DESC
             LIMIT ?`,
          )
          .all(consumerId, MAX_OPERATIONAL_EVENT_DEAD_LETTERS) as Array<{
          journal_sequence: number;
          event_id: string;
          idempotency_key: string;
          attempt: number;
          failure_code: string | null;
          terminal_at: string | null;
        }>;
        if (rows.some((row) => !row.failure_code || !row.terminal_at))
          return { kind: 'unavailable' };
        return {
          kind: 'available',
          entries: rows.map((row) => ({
            journalSequence: row.journal_sequence,
            eventId: row.event_id,
            idempotencyKey: row.idempotency_key,
            attempt: row.attempt,
            failureCode: row.failure_code!,
            terminalAt: row.terminal_at!,
          })),
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  });
}
