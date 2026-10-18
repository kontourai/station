import { createHash, randomBytes } from 'node:crypto';
import type {
  StationDailyPing,
  TelemetryPublisherId,
} from '@kontourai/station-contracts/product-telemetry';
import { TELEMETRY_CHANNELS } from '@kontourai/station-contracts/product-telemetry';
import { parseStationDailyPing } from '@kontourai/station-shared/product-telemetry';
import type { QueryResultRow } from 'pg';
import { BrokerError } from './broker-error.js';
import { noisyCount } from './noisy-count.js';

interface LiteSqlClient {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const SCHEMA = `
CREATE TABLE station_telemetry.lite_sources (
 id text PRIMARY KEY, publisher text NOT NULL, channel text NOT NULL,
 registry_ids jsonb NOT NULL, release_versions jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE station_telemetry.publisher_keys (
 publisher text PRIMARY KEY, credential_hash bytea UNIQUE NOT NULL CHECK(octet_length(credential_hash)=32));
CREATE TABLE station_telemetry.lite_pings (
 source_id text NOT NULL REFERENCES station_telemetry.lite_sources(id), event_id uuid NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(), ping jsonb NOT NULL,
 PRIMARY KEY(source_id,event_id));
CREATE INDEX lite_received ON station_telemetry.lite_pings(received_at);
CREATE TABLE station_telemetry.lite_rollups (
 day date NOT NULL, publisher text NOT NULL, cell_hash bytea NOT NULL, cell jsonb NOT NULL, pings bigint NOT NULL CHECK(pings>0),
 PRIMARY KEY(day,publisher,cell_hash));
`;
const DIGEST = createHash('sha256').update(SCHEMA).digest('hex');
const MARGINAL_SCHEMA = `
DROP TABLE station_telemetry.lite_rollups;
CREATE TABLE station_telemetry.lite_marginals (
 day date NOT NULL, publisher text NOT NULL, dimension text NOT NULL, value text NOT NULL,
 pings bigint NOT NULL CHECK(pings>0), clients bigint NOT NULL CHECK(clients>0), finalized boolean NOT NULL DEFAULT false,
 PRIMARY KEY(day,publisher,dimension,value));
CREATE TABLE station_telemetry.lite_clients (
 day date NOT NULL, publisher text NOT NULL, dimension text NOT NULL, value text NOT NULL,
 client_hash bytea NOT NULL CHECK(octet_length(client_hash)=32), PRIMARY KEY(day,publisher,dimension,value,client_hash));
CREATE TABLE station_telemetry.lite_capacity (singleton boolean PRIMARY KEY CHECK(singleton), pings bigint NOT NULL CHECK(pings>=0));
INSERT INTO station_telemetry.lite_capacity SELECT true,count(*) FROM station_telemetry.lite_pings;
`;
const MARGINAL_DIGEST = createHash('sha256')
  .update(MARGINAL_SCHEMA)
  .digest('hex');
const SUPPRESSION_SCHEMA = `
DELETE FROM station_telemetry.lite_marginals;
DELETE FROM station_telemetry.lite_clients;
ALTER TABLE station_telemetry.lite_marginals ADD COLUMN publishable boolean NOT NULL DEFAULT false;
ALTER TABLE station_telemetry.lite_pings ADD COLUMN client_hash bytea CHECK(client_hash IS NULL OR octet_length(client_hash)=32);
ALTER TABLE station_telemetry.lite_pings ADD COLUMN contributions jsonb;
`;
const SUPPRESSION_DIGEST = createHash('sha256')
  .update(SUPPRESSION_SCHEMA)
  .digest('hex');
const NOISE_SCHEMA = `
DROP TABLE station_telemetry.lite_clients;
ALTER TABLE station_telemetry.lite_marginals DROP COLUMN publishable;
CREATE TABLE station_telemetry.lite_finalization (
 day date NOT NULL, publisher text NOT NULL, dimension text NOT NULL,
 PRIMARY KEY(day,publisher,dimension));
INSERT INTO station_telemetry.lite_finalization
 SELECT DISTINCT day,publisher,dimension FROM station_telemetry.lite_marginals WHERE NOT finalized;
CREATE TABLE station_telemetry.lite_noise_key (
 singleton boolean PRIMARY KEY CHECK(singleton), secret bytea NOT NULL CHECK(octet_length(secret)=32));
REVOKE ALL ON station_telemetry.lite_noise_key FROM PUBLIC;
`;
const NOISE_DIGEST = createHash('sha256').update(NOISE_SCHEMA).digest('hex');
const tables = [
  'lite_capacity',
  'lite_finalization',
  'lite_marginals',
  'lite_noise_key',
  'lite_pings',
  'lite_sources',
  'publisher_keys',
];

export async function migrateLite(client: LiteSqlClient): Promise<void> {
  const { rows } = await client.query<{ digest: string }>(
    'SELECT digest FROM station_telemetry.migrations WHERE version=2',
  );
  if (!rows.length) {
    await client.query(SCHEMA);
    await client.query(
      'INSERT INTO station_telemetry.migrations VALUES(2,$1)',
      [DIGEST],
    );
  } else if (rows[0].digest !== DIGEST)
    throw new BrokerError('schema_incompatible');
  const marginal = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=3',
  );
  if (!marginal.rows.length) {
    // Legacy joint cells cannot establish distinct network contributors. Never promote them.
    await client.query(MARGINAL_SCHEMA);
    await client.query(
      'INSERT INTO station_telemetry.migrations VALUES(3,$1)',
      [MARGINAL_DIGEST],
    );
  } else if (marginal.rows[0].digest !== MARGINAL_DIGEST)
    throw new BrokerError('schema_incompatible');
  const suppression = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=4',
  );
  if (!suppression.rows.length) {
    // /64-era marginals cannot prove /48 contributors or safe complements.
    await client.query(SUPPRESSION_SCHEMA);
    await client.query(
      'INSERT INTO station_telemetry.migrations VALUES(4,$1)',
      [SUPPRESSION_DIGEST],
    );
  } else if (suppression.rows[0].digest !== SUPPRESSION_DIGEST)
    throw new BrokerError('schema_incompatible');
  const noise = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=5',
  );
  if (!noise.rows.length) {
    await client.query(NOISE_SCHEMA);
    await client.query(
      'INSERT INTO station_telemetry.lite_noise_key VALUES(true,$1)',
      [randomBytes(32)],
    );
    await client.query(
      'INSERT INTO station_telemetry.migrations VALUES(5,$1)',
      [NOISE_DIGEST],
    );
  } else if (noise.rows[0].digest !== NOISE_DIGEST)
    throw new BrokerError('schema_incompatible');
}

export async function assertLiteSchema(client: LiteSqlClient): Promise<void> {
  await client.query(
    'LOCK TABLE station_telemetry.lite_sources,station_telemetry.publisher_keys,station_telemetry.lite_pings,station_telemetry.lite_marginals,station_telemetry.lite_finalization,station_telemetry.lite_noise_key,station_telemetry.lite_capacity IN ACCESS SHARE MODE',
  );
  const { rows } = await client.query<{
    name: string;
    shape: string;
    durable: boolean;
  }>(
    `
    SELECT c.relname AS name, string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull,',' ORDER BY a.attnum) AS shape,
    c.relkind='r' AND c.relpersistence='p' AS durable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='station_telemetry' AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped GROUP BY c.oid ORDER BY c.relname`,
    [tables],
  );
  const expected = [
    'lite_capacity|singleton:boolean:true,pings:bigint:true',
    'lite_finalization|day:date:true,publisher:text:true,dimension:text:true',
    'lite_marginals|day:date:true,publisher:text:true,dimension:text:true,value:text:true,pings:bigint:true,clients:bigint:true,finalized:boolean:true',
    'lite_noise_key|singleton:boolean:true,secret:bytea:true',
    'lite_pings|source_id:text:true,event_id:uuid:true,received_at:timestamp with time zone:true,ping:jsonb:true,client_hash:bytea:false,contributions:jsonb:false',
    'lite_sources|id:text:true,publisher:text:true,channel:text:true,registry_ids:jsonb:true,release_versions:jsonb:true,enabled:boolean:true',
    'publisher_keys|publisher:text:true,credential_hash:bytea:true',
  ];
  if (
    rows.some((r) => !r.durable) ||
    JSON.stringify(rows.map((r) => `${r.name}|${r.shape}`)) !==
      JSON.stringify(expected)
  )
    throw new BrokerError('schema_incompatible');
  const constraints = await client.query<{
    definition: string;
    valid: boolean;
  }>(
    `
    SELECT c.relname||'|'||pg_get_constraintdef(co.oid) AS definition,
    co.convalidated AND NOT co.condeferrable AND COALESCE(i.indisvalid AND i.indisready,true) AS valid
    FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_index i ON i.indexrelid=co.conindid WHERE n.nspname='station_telemetry' AND c.relname=ANY($1) AND co.contype<>'n' ORDER BY 1`,
    [tables],
  );
  if (
    constraints.rows.some((r) => !r.valid) ||
    JSON.stringify(constraints.rows.map((r) => r.definition)) !==
      JSON.stringify([
        'lite_capacity|CHECK ((pings >= 0))',
        'lite_capacity|CHECK (singleton)',
        'lite_capacity|PRIMARY KEY (singleton)',
        'lite_finalization|PRIMARY KEY (day, publisher, dimension)',
        'lite_marginals|CHECK ((clients > 0))',
        'lite_marginals|CHECK ((pings > 0))',
        'lite_marginals|PRIMARY KEY (day, publisher, dimension, value)',
        'lite_noise_key|CHECK ((octet_length(secret) = 32))',
        'lite_noise_key|CHECK (singleton)',
        'lite_noise_key|PRIMARY KEY (singleton)',
        'lite_pings|CHECK (((client_hash IS NULL) OR (octet_length(client_hash) = 32)))',
        'lite_pings|FOREIGN KEY (source_id) REFERENCES station_telemetry.lite_sources(id)',
        'lite_pings|PRIMARY KEY (source_id, event_id)',
        'lite_sources|PRIMARY KEY (id)',
        'publisher_keys|CHECK ((octet_length(credential_hash) = 32))',
        'publisher_keys|PRIMARY KEY (publisher)',
        'publisher_keys|UNIQUE (credential_hash)',
      ])
  )
    throw new BrokerError('schema_incompatible');
  const defaults = await client.query(
    `SELECT c.relname||'|'||a.attname||'|'||pg_get_expr(d.adbin,d.adrelid) AS definition
    FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='station_telemetry' AND c.relname=ANY($1) ORDER BY 1`,
    [tables],
  );
  if (
    JSON.stringify(defaults.rows.map((r) => r.definition)) !==
    JSON.stringify([
      'lite_marginals|finalized|false',
      'lite_pings|received_at|clock_timestamp()',
      'lite_sources|enabled|true',
    ])
  )
    throw new BrokerError('schema_incompatible');
  const marker = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=2',
  );
  if (marker.rows[0]?.digest !== DIGEST)
    throw new BrokerError('schema_incompatible');
  const marginalMarker = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=3',
  );
  if (marginalMarker.rows[0]?.digest !== MARGINAL_DIGEST)
    throw new BrokerError('schema_incompatible');
  const suppressionMarker = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=4',
  );
  if (suppressionMarker.rows[0]?.digest !== SUPPRESSION_DIGEST)
    throw new BrokerError('schema_incompatible');
  const noiseMarker = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=5',
  );
  if (noiseMarker.rows[0]?.digest !== NOISE_DIGEST)
    throw new BrokerError('schema_incompatible');
  const secret = await client.query(
    'SELECT octet_length(secret) AS length FROM station_telemetry.lite_noise_key WHERE singleton',
  );
  if (secret.rows.length !== 1 || secret.rows[0].length !== 32)
    throw new BrokerError('schema_incompatible');
  const index = await client.query(
    "SELECT indisvalid AND indisready AS valid,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid=to_regclass('station_telemetry.lite_received') AND indrelid='station_telemetry.lite_pings'::regclass",
  );
  if (
    index.rows.length !== 1 ||
    !index.rows[0].valid ||
    index.rows[0].definition !==
      'CREATE INDEX lite_received ON station_telemetry.lite_pings USING btree (received_at)'
  )
    throw new BrokerError('schema_incompatible');
}

function publisherId(value: unknown): value is TelemetryPublisherId {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    (value === 'kontour' ||
      value === 'operator' ||
      /^publisher:\S{1,118}$/u.test(value))
  );
}
const hash = (value: string) => createHash('sha256').update(value).digest();
function catalog(
  value: unknown,
  limit: number,
  maxLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= maxLength,
    ) &&
    new Set(value).size === value.length
  );
}
type Transaction = <T>(
  operation: (client: LiteSqlClient) => Promise<T>,
) => Promise<T>;

export class LiteRepository {
  private publisherCredentials = new Map<string, string>();
  private credentialRevision = 0;
  private credentialsUntil = Date.now() + 60_000;

  async refreshCredentials(client: LiteSqlClient): Promise<void> {
    const revision = this.credentialRevision;
    const { rows } = await client.query<{ publisher: string; digest: string }>(
      "SELECT publisher,encode(credential_hash,'hex') AS digest FROM station_telemetry.publisher_keys",
    );
    if (revision !== this.credentialRevision) return;
    this.publisherCredentials = new Map(
      rows.map((row) => [row.publisher, row.digest]),
    );
    this.credentialsUntil = Date.now() + 60_000;
  }
  hasCredential(publisher: string, key: string): boolean {
    return (
      Date.now() < this.credentialsUntil &&
      /^stq_[A-Za-z0-9_-]{43}$/.test(key) &&
      this.publisherCredentials.get(publisher) === hash(key).toString('hex')
    );
  }

  constructor(
    private readonly transaction: Transaction,
    private readonly maxPings: number,
    private readonly maxBytes: number,
  ) {}

  async createSource(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BrokerError('invalid_source');
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).length !== 5 ||
      Object.keys(v).some(
        (k) =>
          ![
            'id',
            'publisher',
            'channel',
            'registryIds',
            'releaseVersions',
          ].includes(k),
      ) ||
      typeof v.id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(v.id) ||
      !publisherId(v.publisher) ||
      !TELEMETRY_CHANNELS.some((c) => c === v.channel) ||
      !catalog(v.registryIds, 1000, 128) ||
      !catalog(v.releaseVersions, 1000, 64)
    )
      throw new BrokerError('invalid_source');
    await this.transaction(async (client) => {
      await this.admission(client);
      const bounds = await client.query(
        'SELECT count(*) AS count FROM station_telemetry.lite_sources',
      );
      if (Number(bounds.rows[0].count) >= 10000)
        throw new BrokerError('storage_limit');
      const result = await client.query(
        'INSERT INTO station_telemetry.lite_sources(id,publisher,channel,registry_ids,release_versions) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [
          v.id,
          v.publisher,
          v.channel,
          JSON.stringify(v.registryIds),
          JSON.stringify(v.releaseVersions),
        ],
      );
      if (!result.rowCount) throw new BrokerError('source_conflict');
    });
  }
  async revokeSource(id: string): Promise<boolean> {
    return this.transaction(
      async (client) =>
        (
          await client.query(
            'UPDATE station_telemetry.lite_sources SET enabled=false WHERE id=$1 AND enabled',
            [id],
          )
        ).rowCount === 1,
    );
  }
  async setPublisherKey(
    publisher: unknown,
    credentialHash: unknown,
  ): Promise<void> {
    if (
      !publisherId(publisher) ||
      typeof credentialHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(credentialHash)
    )
      throw new BrokerError('invalid_source');
    await this.transaction(async (client) => {
      await this.admission(client);
      const count = await client.query(
        'SELECT count(*) AS count, bool_or(publisher=$1) AS replacing FROM station_telemetry.publisher_keys',
        [publisher],
      );
      if (Number(count.rows[0].count) >= 10000 && !count.rows[0].replacing)
        throw new BrokerError('storage_limit');
      await client.query(
        'INSERT INTO station_telemetry.publisher_keys VALUES($1,$2) ON CONFLICT(publisher) DO UPDATE SET credential_hash=excluded.credential_hash',
        [publisher, Buffer.from(credentialHash, 'hex')],
      );
    });
    this.credentialRevision++;
    this.publisherCredentials.set(publisher, credentialHash);
    await this.transaction((client) => this.refreshCredentials(client));
  }
  async revokePublisherKey(publisher: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        'DELETE FROM station_telemetry.publisher_keys WHERE publisher=$1',
        [publisher],
      );
    });
    this.credentialRevision++;
    this.publisherCredentials.delete(publisher);
    await this.transaction((client) => this.refreshCredentials(client));
  }
  private async admission(client: LiteSqlClient): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('station.product.telemetry.admission'))",
    );
    const bounds = await client.query(
      'SELECT pg_database_size(current_database())::text AS bytes',
    );
    if (Number(bounds.rows[0].bytes) >= this.maxBytes)
      throw new BrokerError('storage_limit');
  }
  async ingest(
    sourceId: string,
    value: unknown,
    clientKey: { day: string; hash: string },
  ): Promise<{ inserted: number }> {
    return this.transaction(async (client) => {
      await this.admission(client);
      const source = await client.query<{
        publisher: TelemetryPublisherId;
        channel: string;
        registry_ids: string[];
        release_versions: string[];
      }>(
        'SELECT publisher,channel,registry_ids,release_versions FROM station_telemetry.lite_sources WHERE id=$1 AND enabled FOR UPDATE',
        [sourceId],
      );
      const config = source.rows[0];
      if (!config) throw new BrokerError('source_unauthorized');
      let ping: StationDailyPing;
      try {
        ping = parseStationDailyPing(
          value,
          config.registry_ids,
          config.release_versions,
        );
      } catch {
        throw new BrokerError('invalid_daily_ping');
      }
      if (ping.channel !== config.channel)
        throw new BrokerError('invalid_daily_ping');
      ping = {
        ...ping,
        event_id: ping.event_id.toLowerCase(),
        engine_connect_failures: ping.engine_connect_failures.map(
          ({ engine, bucket }) => ({ engine, bucket }),
        ),
      };
      ping.surfaces_today.sort();
      ping.engines_used_today.sort();
      ping.public_plugins_enabled.sort();
      ping.engine_connect_failures.sort((a, b) =>
        a.engine.localeCompare(b.engine),
      );
      const prior = await client.query<{ same: boolean }>(
        'SELECT ping=$3::jsonb AS same FROM station_telemetry.lite_pings WHERE source_id=$1 AND event_id=$2',
        [sourceId, ping.event_id, JSON.stringify(ping)],
      );
      if (prior.rows.length) {
        if (!prior.rows[0].same) throw new BrokerError('event_conflict');
        return { inserted: 0 };
      }
      const count = await client.query(
        'SELECT pings FROM station_telemetry.lite_capacity WHERE singleton',
      );
      if (Number(count.rows[0].pings) >= this.maxPings)
        throw new BrokerError('storage_limit');
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('station.lite.day'),hashtext($1))",
        [clientKey.day],
      );
      // Assign arrival day after admission. A midnight waiter must retry with the new salt.
      const inserted = await client.query<{ day: string }>(
        "INSERT INTO station_telemetry.lite_pings(source_id,event_id,ping) VALUES($1,$2,$3) RETURNING to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
        [sourceId, ping.event_id, JSON.stringify(ping)],
      );
      const day = inserted.rows[0].day;
      if (clientKey.day !== day || !/^[0-9a-f]{64}$/.test(clientKey.hash))
        throw new BrokerError('storage_busy');
      await client.query(
        'UPDATE station_telemetry.lite_capacity SET pings=pings+1 WHERE singleton',
      );
      const contributions: Record<string, string[]> = Object.create(null);
      for (const [dimension, value] of marginals(ping)) {
        contributions[dimension] ??= [];
        contributions[dimension].push(value);
      }
      await client.query(
        'UPDATE station_telemetry.lite_pings SET client_hash=$3,contributions=$4 WHERE source_id=$1 AND event_id=$2',
        [
          sourceId,
          ping.event_id,
          Buffer.from(clientKey.hash, 'hex'),
          JSON.stringify(contributions),
        ],
      );

      await client.query(
        `INSERT INTO station_telemetry.lite_finalization(day,publisher,dimension)
         SELECT $1::date,$2,key FROM jsonb_object_keys($3::jsonb) key ON CONFLICT DO NOTHING`,
        [day, config.publisher, JSON.stringify(contributions)],
      );
      return { inserted: 1 };
    });
  }
  private finalizing?: Promise<string>;
  finalize(): Promise<string> {
    if (this.finalizing) return this.finalizing;
    const pending = this.finalizeClosedDays().finally(() => {
      if (this.finalizing === pending) this.finalizing = undefined;
    });
    this.finalizing = pending;
    return pending;
  }
  private async finalizeClosedDays(): Promise<string> {
    const cutoff = await this.transaction(async (client) => {
      const { rows } = await client.query<{ day: string }>(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
      );
      return rows[0].day;
    });
    // Each committed dimension is durable progress; retries skip completed work.
    while (
      await this.transaction(async (client) => {
        const { rows } = await client.query<{
          day: string;
          publisher: string;
          dimension: string;
        }>(
          "SELECT to_char(day,'YYYY-MM-DD') AS day,publisher,dimension FROM station_telemetry.lite_finalization WHERE day<$1::date ORDER BY day,publisher,dimension LIMIT 1",
          [cutoff],
        );
        const job = rows[0];
        if (!job) return false;
        const { day, publisher, dimension } = job;
        // Wait only for transactions assigning this closed arrival day, never the ingest lock.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('station.lite.day'),hashtext($1))",
          [day],
        );
        const claimed = await client.query(
          'SELECT 1 FROM station_telemetry.lite_finalization WHERE day=$1 AND publisher=$2 AND dimension=$3 FOR UPDATE',
          [day, publisher, dimension],
        );
        if (!claimed.rows.length) return true;
        await client.query("SET LOCAL work_mem='16MB'");
        await client.query(
          `INSERT INTO station_telemetry.lite_marginals(day,publisher,dimension,value,pings,clients,finalized)
         SELECT $1::date,$2,$3,value,sum(pings),count(*),true FROM (
           SELECT v.value,p.client_hash,count(*) AS pings
           FROM station_telemetry.lite_pings p JOIN station_telemetry.lite_sources s ON s.id=p.source_id
           CROSS JOIN LATERAL jsonb_array_elements_text(p.contributions->$3) v(value)
           WHERE s.publisher=$2 AND p.received_at >= $1::date::timestamp AT TIME ZONE 'UTC'
           AND p.received_at < ($1::date+1)::timestamp AT TIME ZONE 'UTC' AND p.client_hash IS NOT NULL
           GROUP BY v.value,p.client_hash
         ) contributors GROUP BY value ON CONFLICT(day,publisher,dimension,value)
         DO UPDATE SET pings=excluded.pings,clients=excluded.clients,finalized=true`,
          [day, publisher, dimension],
        );
        await client.query(
          'DELETE FROM station_telemetry.lite_finalization WHERE day=$1 AND publisher=$2 AND dimension=$3',
          [day, publisher, dimension],
        );
        return true;
      })
    ) {
      /* independent bounded dimension transactions */
    }
    // Erasure is separately resumable and cannot roll back already finalized dimensions.
    while (
      await this.transaction(async (client) => {
        const result = await client.query(
          `WITH batch AS (SELECT p.ctid FROM station_telemetry.lite_pings p
         JOIN station_telemetry.lite_sources s ON s.id=p.source_id
         WHERE received_at < $1::date::timestamp AT TIME ZONE 'UTC' AND client_hash IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM station_telemetry.lite_finalization f
          WHERE f.day=(p.received_at AT TIME ZONE 'UTC')::date AND f.publisher=s.publisher)
         LIMIT 2000 FOR UPDATE OF p SKIP LOCKED)
         UPDATE station_telemetry.lite_pings p SET client_hash=NULL,contributions=NULL FROM batch WHERE p.ctid=batch.ctid`,
          [cutoff],
        );
        return result.rowCount !== 0;
      })
    ) {
      /* bounded erasure batches */
    }
    const remaining = await this.transaction((client) =>
      client.query(
        'SELECT 1 FROM station_telemetry.lite_finalization WHERE day<$1::date LIMIT 1',
        [cutoff],
      ),
    );
    if (remaining.rows.length) throw new BrokerError('storage_busy');
    return cutoff;
  }
  async publicAggregates() {
    const finalizedBeforeDay = await this.finalize();
    return { ...(await this.aggregates('kontour')), finalizedBeforeDay };
  }
  async aggregates(publisher: string, key?: string) {
    if (key !== undefined && !/^stq_[A-Za-z0-9_-]{43}$/.test(key))
      throw new BrokerError('source_unauthorized');
    if (key !== undefined && !this.hasCredential(publisher, key))
      throw new BrokerError('source_unauthorized');
    return this.transaction(async (client) => {
      if (key !== undefined) {
        const authority = await client.query(
          'SELECT publisher FROM station_telemetry.publisher_keys WHERE publisher=$1 AND credential_hash=$2 FOR SHARE',
          [publisher, hash(key)],
        );
        if (!authority.rows.length)
          throw new BrokerError('source_unauthorized');
      }
      const rows = await client.query<{
        day: string;
        dimension: string;
        value: string;
        pings: string;
      }>(
        `SELECT to_char(day,'YYYY-MM-DD') AS day,dimension,value,pings::text FROM station_telemetry.lite_marginals
        WHERE publisher=$1 AND day >= (statement_timestamp() AT TIME ZONE 'UTC')::date-30
        AND day < (statement_timestamp() AT TIME ZONE 'UTC')::date AND finalized AND clients>=10
        ORDER BY day,dimension,value LIMIT 10001`,
        [publisher],
      );
      if (rows.rows.length > 10000) throw new BrokerError('query_limit');
      const secret = await client.query<{ secret: Buffer }>(
        'SELECT secret FROM station_telemetry.lite_noise_key WHERE singleton',
      );
      const days = new Map<
        string,
        { day: string; distributions: Record<string, Record<string, number>> }
      >();
      for (const { day, dimension, value, pings } of rows.rows) {
        let result = days.get(day);
        if (!result) {
          result = { day, distributions: Object.create(null) };
          days.set(day, result);
        }
        result.distributions[dimension] ??= Object.create(null);
        result.distributions[dimension][value] = noisyCount(
          secret.rows[0].secret,
          publisher,
          day,
          dimension,
          value,
          Number(pings),
        );
      }
      return {
        scope: 'daily-per-dimension-marginals',
        publisher,
        minimumDistinctDailyClients: 10,
        privacyUnit: 'daily-salted-IPv4-or-IPv6-/48',
        dayBasis: 'UTC-receiver-arrival',
        deliveryCoverage: 'unknown',
        days: [...days.values()],
      };
    });
  }
}

function marginals(ping: StationDailyPing): [string, string][] {
  const { event: _event, event_id: _id, ...fields } = ping;
  const bucketCount = (count: number) =>
    count === 0
      ? '0'
      : count === 1
        ? '1'
        : count <= 5
          ? '2-5'
          : count <= 20
            ? '6-20'
            : '21+';
  return Object.entries(fields).flatMap(([dimension, value]) => {
    const values =
      typeof value === 'number'
        ? [bucketCount(value)]
        : Array.isArray(value)
          ? value.length
            ? value.map((v) =>
                typeof v === 'object' ? `${v.engine}:${v.bucket}` : String(v),
              )
            : ['none']
          : [String(value)];
    return values.map((value): [string, string] => [dimension, value]);
  });
}
