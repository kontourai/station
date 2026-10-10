import { createHash, randomUUID } from 'node:crypto';
import type {
  ProductTelemetryBatch,
  ProductTelemetryObservation,
} from '@kontourai/station-contracts/product-telemetry';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export class BrokerError extends Error {
  constructor(
    readonly code:
      | 'source_unauthorized'
      | 'event_conflict'
      | 'storage_limit'
      | 'invalid_source'
      | 'storage_not_durable'
      | 'query_limit'
      | 'source_conflict',
  ) {
    super(code);
  }
}
export interface ProductCommit {
  protocol: 'station-product-commit/v1';
  receiptId: string;
  sourceId: string;
  eventIds: string[];
  inserted: number;
  alreadyPresent: number;
  storedAt: string;
}
export interface ProductSource {
  id: string;
  label: string;
  revokedAt: string | null;
}
export interface ProductTrends {
  scope: 'received-product-observations';
  window: { from: string; to: string };
  retentionDays: number;
  eventTime: 'producer-wall-clock';
  deliveryCoverage: 'unknown';
  rows: Array<{
    day: string;
    event: string;
    version: string;
    sha: string | null;
    shaSource: string | null;
    engine: string | null;
    outcome: string | null;
    count: number;
  }>;
}
export interface ProductRepository {
  ingest(key: string, batch: ProductTelemetryBatch): Promise<ProductCommit>;
  createSource(
    id: string,
    label: string,
    credentialHash: string,
  ): Promise<ProductSource>;
  revokeSource(id: string): Promise<boolean>;
  receipt(key: string, id: string): Promise<ProductCommit | null>;
  trends(from: string, to: string): Promise<ProductTrends>;
  ready(): Promise<void>;
}
const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS station_telemetry;
CREATE TABLE IF NOT EXISTS station_telemetry.migrations (version integer PRIMARY KEY, digest text NOT NULL);
CREATE TABLE station_telemetry.sources (
 id uuid PRIMARY KEY, namespace text NOT NULL CHECK(namespace='product'), label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 credential_hash bytea UNIQUE NOT NULL CHECK(octet_length(credential_hash)=32), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz);
CREATE TABLE station_telemetry.events (
 source_id uuid NOT NULL REFERENCES station_telemetry.sources(id), event_id uuid NOT NULL,
 content_digest bytea NOT NULL, distinct_id text NOT NULL, event text NOT NULL,
 occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(), observation jsonb NOT NULL,
 PRIMARY KEY(source_id,event_id));
CREATE INDEX event_time ON station_telemetry.events(occurred_at);
CREATE TABLE station_telemetry.commits (
 id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES station_telemetry.sources(id), body jsonb NOT NULL,
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp());
`;
const SCHEMA_DIGEST = createHash('sha256').update(SCHEMA).digest('hex');
const hash = (key: string) => createHash('sha256').update(key).digest();
const uuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
function observationDigest(event: ProductTelemetryObservation): Buffer {
  return hash(
    JSON.stringify({
      ...event,
      event_id: event.event_id.toLowerCase(),
      properties: Object.fromEntries(
        Object.entries(event.properties).sort(([a], [b]) => a.localeCompare(b)),
      ),
      build: {
        ...event.build,
        ...(event.build.sha ? { sha: event.build.sha.toLowerCase() } : {}),
      },
    }),
  );
}
interface SourceRow extends QueryResultRow {
  id: string;
  label: string;
  revoked_at: Date | null;
}
interface EventRow extends QueryResultRow {
  event_id: string;
  content_digest: Buffer;
}
export class PgProductRepository implements ProductRepository {
  constructor(
    readonly pool: Pool,
    private readonly maxEvents = 1_000_000,
    private readonly maxDatabaseBytes = 1_073_741_824,
    readonly retentionDays = 90,
  ) {}
  private async durable(client: PoolClient): Promise<void> {
    const { rows } = await client.query<{ fsync: string; full_pages: string }>(
      "SELECT current_setting('fsync') AS fsync, current_setting('full_page_writes') AS full_pages",
    );
    if (rows[0]?.fsync !== 'on' || rows[0]?.full_pages !== 'on')
      throw new BrokerError('storage_not_durable');
    await client.query('SET LOCAL synchronous_commit=on');
  }
  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.durable(client);
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async migrate(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('station.product.telemetry.migration'))",
      );
      await client.query(
        'CREATE SCHEMA IF NOT EXISTS station_telemetry; CREATE TABLE IF NOT EXISTS station_telemetry.migrations(version integer PRIMARY KEY,digest text NOT NULL)',
      );
      const { rows } = await client.query<{ version: number; digest: string }>(
        'SELECT version,digest FROM station_telemetry.migrations ORDER BY version',
      );
      if (rows.length) {
        if (
          rows.length !== 1 ||
          rows[0].version !== 1 ||
          rows[0].digest !== SCHEMA_DIGEST
        )
          throw new Error('Unsupported telemetry storage migration');
        return;
      }
      await client.query(SCHEMA);
      await client.query(
        'INSERT INTO station_telemetry.migrations VALUES(1,$1)',
        [SCHEMA_DIGEST],
      );
    });
  }
  async ready(): Promise<void> {
    await this.transaction(async (client) => {
      const { rows } = await client.query<{ digest: string }>(
        'SELECT digest FROM station_telemetry.migrations WHERE version=1',
      );
      if (rows[0]?.digest !== SCHEMA_DIGEST)
        throw new Error('Telemetry storage migration unavailable');
      await client.query(
        'SELECT source_id,event_id,content_digest,observation FROM station_telemetry.events LIMIT 0',
      );
    });
  }
  private async source(client: PoolClient, key: string): Promise<SourceRow> {
    if (!/^stp_[A-Za-z0-9_-]{43}$/.test(key))
      throw new BrokerError('source_unauthorized');
    const { rows } = await client.query<SourceRow>(
      "SELECT id,label,revoked_at FROM station_telemetry.sources WHERE credential_hash=$1 AND namespace='product' AND revoked_at IS NULL FOR UPDATE",
      [hash(key)],
    );
    if (!rows[0]) throw new BrokerError('source_unauthorized');
    return rows[0];
  }
  async createSource(
    id: string,
    label: string,
    credentialHash: string,
  ): Promise<ProductSource> {
    if (
      !uuid(id) ||
      !label.trim() ||
      label.length > 80 ||
      !/^[0-9a-f]{64}$/.test(credentialHash)
    )
      throw new BrokerError('invalid_source');
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('station.product.telemetry.admission'))",
      );
      const bounds = await client.query<{ count: string; bytes: string }>(
        'SELECT (SELECT count(*) FROM station_telemetry.sources) AS count,pg_database_size(current_database())::text AS bytes',
      );
      if (
        Number(bounds.rows[0].count) >= 10000 ||
        Number(bounds.rows[0].bytes) >= this.maxDatabaseBytes
      )
        throw new BrokerError('storage_limit');
      const { rows } = await client.query<SourceRow>(
        "INSERT INTO station_telemetry.sources(id,namespace,label,credential_hash) VALUES($1,'product',$2,$3) ON CONFLICT DO NOTHING RETURNING id,label,revoked_at",
        [id, label, Buffer.from(credentialHash, 'hex')],
      );
      if (!rows[0]) throw new BrokerError('source_conflict');
      return { id: rows[0].id, label: rows[0].label, revokedAt: null };
    });
  }
  async revokeSource(id: string): Promise<boolean> {
    if (!uuid(id)) throw new BrokerError('invalid_source');
    return this.transaction(async (client) => {
      const result = await client.query(
        'UPDATE station_telemetry.sources SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',
        [id],
      );
      return result.rowCount === 1;
    });
  }
  async ingest(
    key: string,
    batch: ProductTelemetryBatch,
  ): Promise<ProductCommit> {
    return this.transaction(async (client) => {
      const source = await this.source(client, key);
      // Serializes admission and storage bounds across all sources, without changing Station's execution concurrency.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('station.product.telemetry.admission'))",
      );
      const events = new Map<
        string,
        { event: ProductTelemetryObservation; digest: Buffer }
      >();
      for (const event of batch.events) {
        const id = event.event_id.toLowerCase();
        const digest = observationDigest(event);
        const prior = events.get(id);
        if (prior && !prior.digest.equals(digest))
          throw new BrokerError('event_conflict');
        events.set(id, { event, digest });
      }
      const ids = [...events.keys()];
      const prior = await client.query<EventRow>(
        'SELECT event_id,content_digest FROM station_telemetry.events WHERE source_id=$1 AND event_id=ANY($2::uuid[])',
        [source.id, ids],
      );
      const existing = new Set<string>();
      for (const row of prior.rows) {
        if (!events.get(row.event_id)?.digest.equals(row.content_digest))
          throw new BrokerError('event_conflict');
        existing.add(row.event_id);
      }
      const fresh = [...events.entries()].filter(([id]) => !existing.has(id));
      const { rows } = await client.query<{
        count: string;
        commits: string;
        bytes: string;
      }>(
        'SELECT (SELECT count(*) FROM station_telemetry.events) AS count,(SELECT count(*) FROM station_telemetry.commits) AS commits,pg_database_size(current_database())::text AS bytes',
      );
      if (
        Number(rows[0].count) + fresh.length > this.maxEvents ||
        Number(rows[0].commits) >= this.maxEvents * 2 ||
        Number(rows[0].bytes) >= this.maxDatabaseBytes
      )
        throw new BrokerError('storage_limit');
      if (fresh.length) {
        const values: unknown[] = [];
        const tuples = fresh.map(([id, { event, digest }], index) => {
          values.push(
            source.id,
            id,
            digest,
            batch.distinct_id,
            event.event,
            event.occurred_at,
            JSON.stringify(event),
          );
          const p = index * 7;
          return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7}::jsonb)`;
        });
        await client.query(
          `INSERT INTO station_telemetry.events(source_id,event_id,content_digest,distinct_id,event,occurred_at,observation) VALUES ${tuples.join(',')}`,
          values,
        );
      }
      const receipt: ProductCommit = {
        protocol: 'station-product-commit/v1',
        receiptId: randomUUID(),
        sourceId: source.id,
        eventIds: ids,
        inserted: fresh.length,
        alreadyPresent: existing.size,
        storedAt: '',
      };
      const inserted = await client.query<{ stored_at: Date }>(
        'INSERT INTO station_telemetry.commits(id,source_id,body) VALUES($1,$2,$3::jsonb) RETURNING stored_at',
        [receipt.receiptId, source.id, JSON.stringify(receipt)],
      );
      receipt.storedAt = inserted.rows[0].stored_at.toISOString();
      await client.query(
        'UPDATE station_telemetry.commits SET body=$1::jsonb WHERE id=$2',
        [JSON.stringify(receipt), receipt.receiptId],
      );
      return receipt;
    });
  }
  async receipt(key: string, id: string): Promise<ProductCommit | null> {
    if (!uuid(id)) throw new BrokerError('invalid_source');
    return this.transaction(async (client) => {
      const source = await this.source(client, key);
      const { rows } = await client.query<{ body: ProductCommit }>(
        'SELECT body FROM station_telemetry.commits WHERE id=$1 AND source_id=$2',
        [id, source.id],
      );
      return rows[0]?.body ?? null;
    });
  }
  async trends(from: string, to: string): Promise<ProductTrends> {
    const { rows } = await this.pool.query<{
      day: string;
      event: string;
      version: string;
      sha: string | null;
      sha_source: string | null;
      engine: string | null;
      outcome: string | null;
      count: string;
    }>(
      `SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,event,observation->'build'->>'version' AS version,observation->'build'->>'sha' AS sha,observation->'build'->>'sha_source' AS sha_source,observation->'properties'->>'engine' AS engine,observation->'properties'->>'outcome' AS outcome,count(*)::text AS count FROM station_telemetry.events WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,2,3 LIMIT 1001`,
      [from, to],
    );
    if (rows.length > 1000) throw new BrokerError('query_limit');
    return {
      scope: 'received-product-observations',
      window: { from, to },
      retentionDays: this.retentionDays,
      eventTime: 'producer-wall-clock',
      deliveryCoverage: 'unknown',
      rows: rows.map((row) => ({
        day: row.day,
        event: row.event,
        version: row.version,
        sha: row.sha,
        shaSource: row.sha_source,
        engine: row.engine,
        outcome: row.outcome,
        count: Number(row.count),
      })),
    };
  }
  async retain(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('station.product.telemetry.admission'))",
      );
      await client.query(
        "DELETE FROM station_telemetry.commits WHERE stored_at < clock_timestamp()-interval '7 days'",
      );
      await client.query(
        "DELETE FROM station_telemetry.events WHERE received_at < clock_timestamp()-$1*interval '1 day'",
        [this.retentionDays],
      );
    });
  }
}
