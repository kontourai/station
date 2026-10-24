import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type {
  StationDailyPing,
  TelemetryFeedback,
  TelemetryPublisherId,
} from '@kontourai/station-contracts/product-telemetry';
import { TELEMETRY_CHANNELS } from '@kontourai/station-contracts/product-telemetry';
import {
  parseStationDailyPing,
  parseTelemetryFeedback,
} from '@kontourai/station-shared/product-telemetry';
import type { QueryResultRow } from 'pg';
import { BrokerError } from './broker-error.js';
import { noisyCount } from './noisy-count.js';
import {
  PUBLIC_COUNT_EPSILON,
  PUBLIC_FIELDS,
  PUBLIC_SENSITIVITY,
  publicDomain,
} from './public-domain.js';

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
CREATE INDEX lite_pending ON station_telemetry.lite_pings(received_at) WHERE client_hash IS NOT NULL OR contributions IS NOT NULL;
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
const WEEKLY_SCHEMA = `
CREATE TABLE station_telemetry.lite_publications (
 week date NOT NULL, publisher text NOT NULL, PRIMARY KEY(week,publisher));
CREATE TABLE station_telemetry.lite_published (
 week date NOT NULL, publisher text NOT NULL, dimension text NOT NULL, value text NOT NULL,
 estimate bigint NOT NULL CHECK(estimate>=0), PRIMARY KEY(week,publisher,dimension,value),
 FOREIGN KEY(week,publisher) REFERENCES station_telemetry.lite_publications(week,publisher));
`;
const WEEKLY_DIGEST = createHash('sha256').update(WEEKLY_SCHEMA).digest('hex');
const FEEDBACK_SCHEMA = `
CREATE TABLE station_telemetry.lite_feedback (
 source_id text NOT NULL REFERENCES station_telemetry.lite_sources(id), publisher text NOT NULL,
 action text NOT NULL, reason text NOT NULL, day date NOT NULL,
 client_hash bytea CHECK(client_hash IS NULL OR octet_length(client_hash)=32),
 UNIQUE(day,publisher,action,client_hash));
CREATE INDEX lite_feedback_day ON station_telemetry.lite_feedback(day);
`;
const FEEDBACK_DIGEST = createHash('sha256')
  .update(FEEDBACK_SCHEMA)
  .digest('hex');
const VERSION_POLICY_SCHEMA = `
ALTER TABLE station_telemetry.lite_sources ADD COLUMN version_policy text NOT NULL DEFAULT 'catalog'
 CHECK(version_policy IN ('catalog','semver'));
`;
const VERSION_POLICY_DIGEST = createHash('sha256')
  .update(VERSION_POLICY_SCHEMA)
  .digest('hex');
const tables = [
  'lite_capacity',
  'lite_feedback',
  'lite_finalization',
  'lite_marginals',
  'lite_noise_key',
  'lite_pings',
  'lite_publications',
  'lite_published',
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
  const weekly = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=6',
  );
  if (!weekly.rows.length) {
    await client.query(WEEKLY_SCHEMA);
    await client.query(
      'INSERT INTO station_telemetry.migrations VALUES(6,$1)',
      [WEEKLY_DIGEST],
    );
  } else if (weekly.rows[0].digest !== WEEKLY_DIGEST)
    throw new BrokerError('schema_incompatible');
  const feedback = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=7',
  );
  if (!feedback.rows.length) {
    await client.query(FEEDBACK_SCHEMA);
    await client.query(
      'INSERT INTO station_telemetry.migrations VALUES(7,$1)',
      [FEEDBACK_DIGEST],
    );
  } else if (feedback.rows[0].digest !== FEEDBACK_DIGEST)
    throw new BrokerError('schema_incompatible');
  const versionPolicy = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=8',
  );
  if (!versionPolicy.rows.length) {
    await client.query(VERSION_POLICY_SCHEMA);
    await client.query(
      'INSERT INTO station_telemetry.migrations VALUES(8,$1)',
      [VERSION_POLICY_DIGEST],
    );
  } else if (versionPolicy.rows[0].digest !== VERSION_POLICY_DIGEST)
    throw new BrokerError('schema_incompatible');
}

export async function assertLiteSchema(client: LiteSqlClient): Promise<void> {
  await client.query(
    'LOCK TABLE station_telemetry.lite_sources,station_telemetry.publisher_keys,station_telemetry.lite_pings,station_telemetry.lite_marginals,station_telemetry.lite_finalization,station_telemetry.lite_noise_key,station_telemetry.lite_capacity,station_telemetry.lite_publications,station_telemetry.lite_published,station_telemetry.lite_feedback IN ACCESS SHARE MODE',
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
    'lite_feedback|source_id:text:true,publisher:text:true,action:text:true,reason:text:true,day:date:true,client_hash:bytea:false',
    'lite_finalization|day:date:true,publisher:text:true,dimension:text:true',
    'lite_marginals|day:date:true,publisher:text:true,dimension:text:true,value:text:true,pings:bigint:true,clients:bigint:true,finalized:boolean:true',
    'lite_noise_key|singleton:boolean:true,secret:bytea:true',
    'lite_pings|source_id:text:true,event_id:uuid:true,received_at:timestamp with time zone:true,ping:jsonb:true,client_hash:bytea:false,contributions:jsonb:false',
    'lite_publications|week:date:true,publisher:text:true',
    'lite_published|week:date:true,publisher:text:true,dimension:text:true,value:text:true,estimate:bigint:true',
    'lite_sources|id:text:true,publisher:text:true,channel:text:true,registry_ids:jsonb:true,release_versions:jsonb:true,enabled:boolean:true,version_policy:text:true',
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
        'lite_feedback|CHECK (((client_hash IS NULL) OR (octet_length(client_hash) = 32)))',
        'lite_feedback|FOREIGN KEY (source_id) REFERENCES station_telemetry.lite_sources(id)',
        'lite_feedback|UNIQUE (day, publisher, action, client_hash)',
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
        'lite_publications|PRIMARY KEY (week, publisher)',
        'lite_published|CHECK ((estimate >= 0))',
        'lite_published|FOREIGN KEY (week, publisher) REFERENCES station_telemetry.lite_publications(week, publisher)',
        'lite_published|PRIMARY KEY (week, publisher, dimension, value)',
        "lite_sources|CHECK ((version_policy = ANY (ARRAY['catalog'::text, 'semver'::text])))",
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
      "lite_sources|version_policy|'catalog'::text",
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
  const weeklyMarker = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=6',
  );
  if (weeklyMarker.rows[0]?.digest !== WEEKLY_DIGEST)
    throw new BrokerError('schema_incompatible');
  const feedbackMarker = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=7',
  );
  if (feedbackMarker.rows[0]?.digest !== FEEDBACK_DIGEST)
    throw new BrokerError('schema_incompatible');
  const versionPolicyMarker = await client.query(
    'SELECT digest FROM station_telemetry.migrations WHERE version=8',
  );
  if (versionPolicyMarker.rows[0]?.digest !== VERSION_POLICY_DIGEST)
    throw new BrokerError('schema_incompatible');
  const secret = await client.query(
    'SELECT octet_length(secret) AS length FROM station_telemetry.lite_noise_key WHERE singleton',
  );
  if (secret.rows.length !== 1 || secret.rows[0].length !== 32)
    throw new BrokerError('schema_incompatible');
  const indexes = await client.query(
    "SELECT indisvalid AND indisready AS valid,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid IN (to_regclass('station_telemetry.lite_received'),to_regclass('station_telemetry.lite_pending')) AND indrelid='station_telemetry.lite_pings'::regclass ORDER BY pg_get_indexdef(indexrelid)",
  );
  if (
    indexes.rows.some((row) => !row.valid) ||
    JSON.stringify(indexes.rows.map((row) => row.definition)) !==
      JSON.stringify([
        'CREATE INDEX lite_pending ON station_telemetry.lite_pings USING btree (received_at) WHERE ((client_hash IS NOT NULL) OR (contributions IS NOT NULL))',
        'CREATE INDEX lite_received ON station_telemetry.lite_pings USING btree (received_at)',
      ])
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
    if (Date.now() >= this.credentialsUntil)
      throw new BrokerError('credentials_stale');
    return (
      /^stq_[A-Za-z0-9_-]{43}$/.test(key) &&
      this.publisherCredentials.get(publisher) === hash(key).toString('hex')
    );
  }

  constructor(
    private readonly transaction: Transaction,
    private readonly maxPings: number,
    private readonly maxBytes: number,
    private readonly retentionDays = 90,
  ) {}

  async createSource(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BrokerError('invalid_source');
    const v = value as Record<string, unknown>;
    if (
      (Object.keys(v).length !== 5 && Object.keys(v).length !== 6) ||
      Object.keys(v).some(
        (k) =>
          ![
            'id',
            'publisher',
            'channel',
            'registryIds',
            'releaseVersions',
            'versionPolicy',
          ].includes(k),
      ) ||
      typeof v.id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(v.id) ||
      !publisherId(v.publisher) ||
      ![...TELEMETRY_CHANNELS, 'unknown'].some((c) => c === v.channel) ||
      !catalog(v.registryIds, 1000, 128) ||
      !catalog(v.releaseVersions, 1000, 64) ||
      (v.versionPolicy !== undefined &&
        v.versionPolicy !== 'catalog' &&
        v.versionPolicy !== 'semver')
    )
      throw new BrokerError('invalid_source');
    await this.transaction(async (client) => {
      await this.admission(client);
      const catalogs = await client.query<{ versions: number; ids: number }>(
        `
        SELECT (SELECT count(DISTINCT value) FROM (
          SELECT jsonb_array_elements_text(release_versions) AS value FROM station_telemetry.lite_sources WHERE publisher=$1
          UNION ALL SELECT jsonb_array_elements_text($2::jsonb)) v) AS versions,
        (SELECT count(DISTINCT value) FROM (
          SELECT jsonb_array_elements_text(registry_ids) AS value FROM station_telemetry.lite_sources WHERE publisher=$1
          UNION ALL SELECT jsonb_array_elements_text($3::jsonb)) r) AS ids`,
        [
          v.publisher,
          JSON.stringify(v.releaseVersions),
          JSON.stringify(v.registryIds),
        ],
      );
      if (
        Number(catalogs.rows[0].versions) > 1000 ||
        Number(catalogs.rows[0].ids) > 1000
      )
        throw new BrokerError('invalid_source');
      const bounds = await client.query(
        'SELECT count(*) AS count FROM station_telemetry.lite_sources',
      );
      if (Number(bounds.rows[0].count) >= 10000)
        throw new BrokerError('storage_limit');
      const result = await client.query(
        'INSERT INTO station_telemetry.lite_sources(id,publisher,channel,registry_ids,release_versions,version_policy) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [
          v.id,
          v.publisher,
          v.channel,
          JSON.stringify(v.registryIds),
          JSON.stringify(v.releaseVersions),
          v.versionPolicy ?? 'catalog',
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
  ): Promise<{ accepted: true }> {
    return this.transaction(async (client) => {
      await this.admission(client);
      const source = await client.query<{
        publisher: TelemetryPublisherId;
        channel: string;
        registry_ids: string[];
        release_versions: string[];
        version_policy: 'catalog' | 'semver';
      }>(
        'SELECT publisher,channel,registry_ids,release_versions,version_policy FROM station_telemetry.lite_sources WHERE id=$1 AND enabled FOR UPDATE',
        [sourceId],
      );
      const config = source.rows[0];
      if (!config) throw new BrokerError('source_unauthorized');
      if (value && typeof value === 'object' && 'action' in value) {
        let feedback: TelemetryFeedback;
        try {
          feedback = parseTelemetryFeedback(value);
        } catch {
          throw new BrokerError('invalid_daily_ping');
        }
        if (feedback.publisher !== config.publisher)
          throw new BrokerError('invalid_daily_ping');
        await client.query(
          "SELECT pg_advisory_xact_lock_shared(hashtext('station.lite.day'),hashtext($1))",
          [clientKey.day],
        );
        const {
          rows: [{ day }],
        } = await client.query<{ day: string }>(
          "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
        );
        if (clientKey.day !== day || !/^[0-9a-f]{64}$/.test(clientKey.hash))
          throw new BrokerError('storage_busy');
        const inserted = await client.query(
          `INSERT INTO station_telemetry.lite_feedback(source_id,publisher,action,reason,day,client_hash)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [
            sourceId,
            feedback.publisher,
            feedback.action,
            feedback.reason,
            day,
            Buffer.from(clientKey.hash, 'hex'),
          ],
        );
        if (inserted.rowCount) {
          const count = await client.query(
            'SELECT pings FROM station_telemetry.lite_capacity WHERE singleton',
          );
          if (Number(count.rows[0].pings) >= this.maxPings)
            throw new BrokerError('storage_limit');
          await client.query(
            'UPDATE station_telemetry.lite_capacity SET pings=pings+1 WHERE singleton',
          );
        }
        return { accepted: true };
      }
      let ping: StationDailyPing;
      try {
        ping = parseStationDailyPing(
          value,
          config.registry_ids,
          config.version_policy === 'semver'
            ? 'semver'
            : config.release_versions,
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
        return { accepted: true };
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
      return { accepted: true };
    });
  }
  private finalizationFailures: {
    period: string;
    publisher: string;
    stage: 'daily' | 'weekly';
    code: string;
  }[] = [];
  private omittedFailures = 0;
  private recordFailure(
    period: string,
    publisher: string,
    stage: 'daily' | 'weekly',
    error: unknown,
  ) {
    // Never expose SQL messages, which can contain contributor or rejected data.
    const code =
      error instanceof BrokerError
        ? error.code
        : error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string' &&
            /^[0-9A-Z]{5}$/.test(error.code)
          ? error.code
          : 'job_failed';
    if (this.finalizationFailures.length < 100)
      this.finalizationFailures.push({ period, publisher, stage, code });
    else this.omittedFailures++;
  }
  private finalizing?: Promise<string>;
  finalize(): Promise<string> {
    if (this.finalizing) return this.finalizing;
    this.finalizationFailures = [];
    this.omittedFailures = 0;
    const pending = this.finalizeClosedDays()
      .then(async (cutoff) => {
        await this.publishWeeks(cutoff);
        return cutoff;
      })
      .finally(() => {
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
      // Close the prior-day arrival fence even when no job is visible yet.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('station.lite.day'),hashtext(to_char($1::date-1,'YYYY-MM-DD')))",
        [rows[0].day],
      );
      return rows[0].day;
    });
    const failures: { day: string; publisher: string }[] = [];
    // Each committed dimension is durable progress; a failed publisher/day cannot block others.
    while (
      await (async () => {
        const failedBefore = failures.length;
        return this.transaction(async (client) => {
          const { rows } = await client.query<{
            day: string;
            publisher: string;
            dimension: string;
          }>(
            "SELECT to_char(day,'YYYY-MM-DD') AS day,publisher,dimension FROM station_telemetry.lite_finalization WHERE day<$1::date AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS f(day text,publisher text) WHERE f.day=to_char(lite_finalization.day,'YYYY-MM-DD') AND f.publisher=lite_finalization.publisher) ORDER BY day,publisher,dimension LIMIT 1",
            [cutoff, JSON.stringify(failures)],
          );
          const job = rows[0];
          if (!job) return false;
          const { day, publisher, dimension } = job;
          try {
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
          } catch (error) {
            failures.push({ day, publisher });
            this.recordFailure(day, publisher, 'daily', error);
            throw error;
          }
        }).catch((error) => {
          if (failures.length > failedBefore) return true;
          throw error;
        });
      })()
    ) {
      /* independent bounded dimension transactions */
    }
    // Erasure is separately resumable and cannot roll back already finalized dimensions.
    try {
      while (
        await this.transaction(async (client) => {
          const result = await client.query(
            `WITH batch AS MATERIALIZED (SELECT p.ctid FROM station_telemetry.lite_pings p
         JOIN station_telemetry.lite_sources s ON s.id=p.source_id
         WHERE received_at < $1::date::timestamp AT TIME ZONE 'UTC' AND (client_hash IS NOT NULL OR contributions IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM station_telemetry.lite_finalization f WHERE f.publisher=s.publisher
           AND f.day=(p.received_at AT TIME ZONE 'UTC')::date)
         ORDER BY received_at LIMIT 500 FOR UPDATE OF p SKIP LOCKED)
         UPDATE station_telemetry.lite_pings SET client_hash=NULL,contributions=NULL
         WHERE ctid=ANY(ARRAY(SELECT ctid FROM batch))`,
            [cutoff],
          );
          return result.rowCount !== 0;
        })
      ) {
        /* bounded erasure batches */
      }
    } finally {
      while (
        await this.transaction(async (client) => {
          const result = await client.query(
            `WITH batch AS MATERIALIZED (SELECT ctid FROM station_telemetry.lite_feedback
         WHERE day < $1::date AND client_hash IS NOT NULL ORDER BY day LIMIT 2000 FOR UPDATE SKIP LOCKED)
         UPDATE station_telemetry.lite_feedback SET client_hash=NULL WHERE ctid=ANY(ARRAY(SELECT ctid FROM batch))`,
            [cutoff],
          );
          return result.rowCount !== 0;
        })
      ) {
        /* bounded daily feedback key erasure */
      }
    }
    return cutoff;
  }
  private async publishWeeks(cutoff: string): Promise<void> {
    const failures: { week: string; publisher: string }[] = [];
    while (
      await (async () => {
        let job: { week: string; publisher: string } | undefined;
        return this.transaction(async (client) => {
          // Catalogs are operator configuration, never derived from observed pings.
          const jobs = await client.query<{ week: string; publisher: string }>(
            `
        SELECT to_char(w.week,'YYYY-MM-DD') AS week,s.publisher
        FROM (SELECT DISTINCT publisher FROM station_telemetry.lite_sources) s
        CROSS JOIN generate_series(date_trunc('week',$1::date::timestamp)-interval '28 days',
          date_trunc('week',$1::date::timestamp)-interval '7 days',interval '7 days') w(week)
        WHERE NOT EXISTS (SELECT 1 FROM station_telemetry.lite_publications p WHERE p.week=w.week::date AND p.publisher=s.publisher)
        AND NOT EXISTS (SELECT 1 FROM station_telemetry.lite_finalization f WHERE f.publisher=s.publisher AND f.day>=w.week::date AND f.day<w.week::date+7)
        AND w.week::date+7 <= $1::date
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS f(week text,publisher text) WHERE f.week=to_char(w.week,'YYYY-MM-DD') AND f.publisher=s.publisher)
        ORDER BY w.week,s.publisher LIMIT 1`,
            [cutoff, JSON.stringify(failures)],
          );
          job = jobs.rows[0];
          if (!job) return false;
          const { week, publisher } = job;
          const claimed = await client.query(
            'INSERT INTO station_telemetry.lite_publications VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING week',
            [week, publisher],
          );
          if (!claimed.rows.length) return true;
          const config = await client.query<{
            registry_ids: string[];
            release_versions: string[];
            version_policy: string;
          }>(
            'SELECT registry_ids,release_versions,version_policy FROM station_telemetry.lite_sources WHERE publisher=$1 ORDER BY id',
            [publisher],
          );
          const counts = await client.query<{
            dimension: string;
            value: string;
            clients: string;
          }>(
            `
        SELECT dimension,value,sum(clients)::text AS clients FROM station_telemetry.lite_marginals
        WHERE publisher=$1 AND day >= $2::date AND day < $2::date+7 AND finalized
        AND dimension=ANY($3) GROUP BY dimension,value`,
            [publisher, week, PUBLIC_FIELDS],
          );
          const totals = new Map(
            counts.rows.map((row) => [
              JSON.stringify([row.dimension, row.value]),
              Number(row.clients),
            ]),
          );
          const secret = await client.query<{ secret: Buffer }>(
            'SELECT secret FROM station_telemetry.lite_noise_key WHERE singleton',
          );
          const domain = publicDomain(config.rows);
          // Bounded insert batches; every coordinate, including true zero, is released exactly once.
          for (let offset = 0; offset < domain.length; offset += 200) {
            const cells = domain
              .slice(offset, offset + 200)
              .map(([dimension, value]) => ({
                dimension,
                value,
                estimate: noisyCount(
                  secret.rows[0].secret,
                  publisher,
                  week,
                  dimension,
                  value,
                  totals.get(JSON.stringify([dimension, value])) ?? 0,
                ),
              }));
            await client.query(
              `INSERT INTO station_telemetry.lite_published
          SELECT $1::date,$2,dimension,value,estimate FROM jsonb_to_recordset($3::jsonb) AS c(dimension text,value text,estimate bigint)`,
              [week, publisher, JSON.stringify(cells)],
            );
          }
          return true;
        }).catch((error) => {
          if (!job) throw error;
          failures.push(job);
          this.recordFailure(job.week, job.publisher, 'weekly', error);
          return true;
        });
      })()
    ) {
      /* one atomic, immutable publisher/week */
    }
  }
  async publicAggregates(cursor?: string) {
    return this.aggregates('kontour', undefined, cursor);
  }
  async aggregates(publisher: string, key?: string, cursor?: string) {
    if (key !== undefined && !this.hasCredential(publisher, key))
      throw new BrokerError('source_unauthorized');
    const after = parseCursor(cursor);
    return this.transaction(async (client) => {
      if (key !== undefined) {
        const authority = await client.query(
          'SELECT publisher FROM station_telemetry.publisher_keys WHERE publisher=$1 AND credential_hash=$2 FOR SHARE',
          [publisher, hash(key)],
        );
        if (!authority.rows.length)
          throw new BrokerError('source_unauthorized');
      }
      const { rows: keys } = await client.query<{
        secret: Buffer;
        day: string;
      }>(
        "SELECT secret,to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day FROM station_telemetry.lite_noise_key WHERE singleton",
      );
      const sign = (payload: string) =>
        createHmac('sha256', keys[0].secret)
          .update(
            JSON.stringify(['station-lite-cursor-v1', publisher, payload]),
          )
          .digest();
      if (cursor) {
        const [payload, signature] = cursor.split('.');
        const supplied = Buffer.from(signature, 'base64url');
        if (
          supplied.length !== 32 ||
          supplied.toString('base64url') !== signature ||
          !timingSafeEqual(sign(payload), supplied)
        )
          throw new BrokerError('invalid_cursor');
      }
      const rows = await client.query<{
        week: string;
        dimension: string;
        value: string;
        estimate: string;
      }>(
        `
        SELECT to_char(week,'YYYY-MM-DD') AS week,dimension,value,estimate::text FROM station_telemetry.lite_published
        WHERE publisher=$1 AND week>=date_trunc('week',statement_timestamp() AT TIME ZONE 'UTC')::date-28
        AND week<date_trunc('week',statement_timestamp() AT TIME ZONE 'UTC')::date
        AND ($2::date IS NULL OR (week,dimension,value)>($2::date,$3,$4))
        ORDER BY week,dimension,value LIMIT 201`,
        [publisher, ...(after ?? [null, null, null])],
      );
      const bounds = await client.query<{ coordinates: number }>(
        `SELECT COALESCE(max(coordinates),0)::int AS coordinates FROM (
          SELECT count(*) AS coordinates FROM station_telemetry.lite_published
          WHERE publisher=$1 AND week>=date_trunc('week',statement_timestamp() AT TIME ZONE 'UTC')::date-28
          AND week<date_trunc('week',statement_timestamp() AT TIME ZONE 'UTC')::date GROUP BY week
        ) weeks`,
        [publisher],
      );
      const cells = rows.rows
        .slice(0, 200)
        .map((row) => ({ ...row, estimate: Number(row.estimate) }));
      const last = cells.at(-1);
      return {
        scope: 'weekly-fixed-domain-marginals',
        publisher,
        privacyUnit: 'distinct-daily-network-key-per-value',
        countUnit: 'network-days',
        databaseDay: keys[0].day,
        epsilonPerCount: PUBLIC_COUNT_EPSILON,
        epsilonPerAddedPing: PUBLIC_SENSITIVITY * PUBLIC_COUNT_EPSILON,
        maximumPublicCoordinatesPerWeek: bounds.rows[0].coordinates,
        maximumNetworkWeekEpsilon:
          7 * bounds.rows[0].coordinates * PUBLIC_COUNT_EPSILON,
        weekBasis: 'ISO-8601-UTC-receiver-arrival',
        deliveryCoverage: 'unknown',
        cells,
        nextCursor:
          rows.rows.length > 200 && last
            ? (() => {
                const payload = Buffer.from(
                  JSON.stringify([last.week, last.dimension, last.value]),
                ).toString('base64url');
                return `${payload}.${sign(payload).toString('base64url')}`;
              })()
            : null,
      };
    });
  }
  async exact(period: 'daily' | 'weekly') {
    return this.transaction(async (client) => {
      const rows =
        await client.query(`SELECT to_char(${period === 'daily' ? 'day' : "date_trunc('week',day)"},'YYYY-MM-DD') AS period,
        publisher,dimension,value,sum(pings)::text AS pings,sum(clients)::text AS contributors
        FROM station_telemetry.lite_marginals WHERE finalized AND day >= ${period === 'daily' ? "(statement_timestamp() AT TIME ZONE 'UTC')::date-30" : "date_trunc('week',statement_timestamp() AT TIME ZONE 'UTC')::date-28"}
        AND day < ${period === 'daily' ? "(statement_timestamp() AT TIME ZONE 'UTC')::date" : "date_trunc('week',statement_timestamp() AT TIME ZONE 'UTC')::date"}
        GROUP BY 1,publisher,dimension,value ORDER BY 1,publisher,dimension,value LIMIT 10001`);
      const feedback = await client.query(
        `SELECT to_char(${period === 'daily' ? 'day' : "date_trunc('week',day)"},'YYYY-MM-DD') AS period,
        publisher,action,reason,count(*)::text AS count FROM station_telemetry.lite_feedback
        WHERE day >= (statement_timestamp() AT TIME ZONE 'UTC')::date-($1::integer-1)
        GROUP BY 1,publisher,action,reason ORDER BY 1,publisher,action,reason LIMIT 10001`,
        [this.retentionDays],
      );
      if (rows.rows.length > 10000 || feedback.rows.length > 10000)
        throw new BrokerError('query_limit');
      return {
        feedback: feedback.rows,
        feedbackWindow: `retained-${this.retentionDays}-UTC-days-including-current`,
        scope: 'operator-exact-marginals',
        finalizationDiagnostics: {
          failures: [...this.finalizationFailures],
          omittedFailures: this.omittedFailures,
          lifetime: 'latest-pass-this-process',
        },
        period,
        contributorUnit:
          period === 'daily'
            ? 'distinct-daily-network-keys'
            : 'sum-of-distinct-daily-network-keys',
        window:
          period === 'daily'
            ? 'last-30-closed-UTC-days'
            : 'last-4-closed-ISO-weeks',
        marginals: rows.rows,
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

function parseCursor(cursor?: string): [string, string, string] | undefined {
  if (cursor === undefined) return;
  try {
    if (
      cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)
    )
      throw new Error();
    const v: unknown = JSON.parse(
      Buffer.from(cursor.split('.')[0], 'base64url').toString(),
    );
    if (
      !Array.isArray(v) ||
      v.length !== 3 ||
      !v.every((x) => typeof x === 'string') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v[0]) ||
      !Number.isFinite(Date.parse(v[0])) ||
      v[0].startsWith('0000') ||
      new Date(v[0]).toISOString().slice(0, 10) !== v[0] ||
      new Date(v[0]).getUTCDay() !== 1 ||
      !PUBLIC_FIELDS.includes(v[1]) ||
      v[2].length > 128
    )
      throw new Error();
    return [v[0], v[1], v[2]];
  } catch {
    throw new BrokerError('invalid_cursor');
  }
}
