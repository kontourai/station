/**
 * Durable operational-event journal schema.
 *
 * The journal shares the already-hardened orchestration SQLite file, but its
 * tables and sequencing authority are independent from chat/runtime events.
 */
export const OPERATIONAL_EVENT_OUTBOX_MIGRATION = `
  CREATE TABLE IF NOT EXISTS operational_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    delivery TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    persisted_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_operational_events_type_sequence
    ON operational_events(event_type, sequence);

  -- Payload retention must not erase event identity. Producers may safely
  -- retry an event ID after its replay payload has aged out.
  CREATE TABLE IF NOT EXISTS operational_event_identities (
    event_id TEXT PRIMARY KEY,
    journal_sequence INTEGER NOT NULL UNIQUE,
    recorded_at TEXT NOT NULL
  );

  INSERT OR IGNORE INTO operational_event_identities
    (event_id, journal_sequence, recorded_at)
  SELECT event_id, sequence, persisted_at FROM operational_events;

  CREATE TABLE IF NOT EXISTS operational_event_scopes (
    event_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    PRIMARY KEY (event_id, scope_key)
  );

  CREATE INDEX IF NOT EXISTS idx_operational_event_scopes_scope
    ON operational_event_scopes(scope_key, event_id);

  INSERT OR IGNORE INTO operational_event_scopes (event_id, scope_key)
  SELECT event_id, json(scope.value)
  FROM operational_events,
       json_each(
         CASE WHEN json_valid(envelope_json)
           THEN envelope_json ELSE '{"scopes":[]}' END,
         '$.scopes'
       ) AS scope;

  CREATE TABLE IF NOT EXISTS operational_event_consumers (
    consumer_id TEXT PRIMARY KEY,
    config_fingerprint TEXT NOT NULL,
    cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK (cursor_sequence >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS operational_event_consumer_types (
    consumer_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    PRIMARY KEY (consumer_id, event_type)
  );

  CREATE TABLE IF NOT EXISTS operational_event_consumer_scopes (
    consumer_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    PRIMARY KEY (consumer_id, scope_key)
  );

  -- One bounded fact per consumer records whether payload pruning crossed a
  -- matching event. Nonmatching history never manufactures a delivery gap.
  CREATE TABLE IF NOT EXISTS operational_event_consumer_gaps (
    consumer_id TEXT PRIMARY KEY,
    latest_missing_sequence INTEGER NOT NULL CHECK (latest_missing_sequence > 0),
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS operational_event_deliveries (
    consumer_id TEXT NOT NULL,
    journal_sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    state TEXT NOT NULL CHECK (state IN ('claimed', 'retry', 'dead-letter')),
    owner_id TEXT,
    owner_pid INTEGER,
    owner_birth TEXT,
    owner_identity_kind TEXT,
    claimed_at TEXT,
    next_attempt_at TEXT,
    failure_code TEXT,
    terminal_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (consumer_id, journal_sequence),
    UNIQUE (consumer_id, idempotency_key)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_event_deliveries_active
    ON operational_event_deliveries(consumer_id)
    WHERE state IN ('claimed', 'retry');

  CREATE INDEX IF NOT EXISTS idx_operational_event_deliveries_dead_letter
    ON operational_event_deliveries(consumer_id, terminal_at DESC)
    WHERE state = 'dead-letter';

  -- One bounded exact receipt per consumer totalizes acknowledgement across a
  -- lost response without treating an unrelated later cursor advance as ack.
  CREATE TABLE IF NOT EXISTS operational_event_delivery_receipts (
    settlement_id TEXT PRIMARY KEY,
    consumer_id TEXT NOT NULL,
    journal_sequence INTEGER NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    owner_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_birth TEXT,
    owner_identity_kind TEXT NOT NULL,
    settlement_kind TEXT NOT NULL CHECK (
      settlement_kind IN ('acknowledged', 'retry', 'dead-letter', 'gap')
    ),
    failure_code TEXT,
    settled_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_operational_event_delivery_receipts_owner
    ON operational_event_delivery_receipts(owner_id, settlement_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_operational_event_delivery_receipts_consumer
    ON operational_event_delivery_receipts(consumer_id);
`;
