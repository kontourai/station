import { createHash } from 'node:crypto';
import type {
  StationDailyPing,
  TelemetryPublisherId,
} from '@kontourai/station-contracts/product-telemetry';
import {
  STATION_DAILY_FIELDS,
  TELEMETRY_CHANNELS,
} from '@kontourai/station-contracts/product-telemetry';
import { parseStationDailyPing } from '@kontourai/station-shared/product-telemetry';
import type { PoolClient } from 'pg';
import { BrokerError } from './store.js';

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
const tables = ['lite_pings', 'lite_rollups', 'lite_sources', 'publisher_keys'];

export async function migrateLite(client: PoolClient): Promise<void> {
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
}

export async function assertLiteSchema(client: PoolClient): Promise<void> {
  await client.query(
    'LOCK TABLE station_telemetry.lite_sources,station_telemetry.publisher_keys,station_telemetry.lite_pings,station_telemetry.lite_rollups IN ACCESS SHARE MODE',
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
    'lite_pings|source_id:text:true,event_id:uuid:true,received_at:timestamp with time zone:true,ping:jsonb:true',
    'lite_rollups|day:date:true,publisher:text:true,cell_hash:bytea:true,cell:jsonb:true,pings:bigint:true',
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
    LEFT JOIN pg_index i ON i.indexrelid=co.conindid WHERE n.nspname='station_telemetry' AND c.relname=ANY($1) ORDER BY 1`,
    [tables],
  );
  if (
    constraints.rows.some((r) => !r.valid) ||
    JSON.stringify(constraints.rows.map((r) => r.definition)) !==
      JSON.stringify([
        'lite_pings|FOREIGN KEY (source_id) REFERENCES station_telemetry.lite_sources(id)',
        'lite_pings|PRIMARY KEY (source_id, event_id)',
        'lite_rollups|CHECK ((pings > 0))',
        'lite_rollups|PRIMARY KEY (day, publisher, cell_hash)',
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
    (value === 'kontour' ||
      value === 'operator' ||
      /^publisher:[a-z0-9][a-z0-9._-]{0,79}$/.test(value))
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
interface CellRow {
  day: string;
  cell: Omit<StationDailyPing, 'event' | 'event_id'>;
  pings: string;
}
type Transaction = <T>(
  operation: (client: PoolClient) => Promise<T>,
) => Promise<T>;

export class LiteRepository {
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
  }
  async revokePublisherKey(publisher: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        'DELETE FROM station_telemetry.publisher_keys WHERE publisher=$1',
        [publisher],
      );
    });
  }
  private async admission(client: PoolClient): Promise<void> {
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
        'SELECT count(*) AS count FROM station_telemetry.lite_pings',
      );
      if (Number(count.rows[0].count) >= this.maxPings)
        throw new BrokerError('storage_limit');
      // The receipt day is chosen after admission; no transaction can update a closed day.
      const inserted = await client.query<{ day: string }>(
        "INSERT INTO station_telemetry.lite_pings(source_id,event_id,ping) VALUES($1,$2,$3) RETURNING to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
        [sourceId, ping.event_id, JSON.stringify(ping)],
      );
      const { event: _event, event_id: _id, ...cell } = ping;
      await client.query(
        'INSERT INTO station_telemetry.lite_rollups VALUES($1,$2,$3,$4,1) ON CONFLICT(day,publisher,cell_hash) DO UPDATE SET pings=lite_rollups.pings+1',
        [
          inserted.rows[0].day,
          config.publisher,
          hash(
            JSON.stringify(
              Object.keys(STATION_DAILY_FIELDS)
                .filter((k) => k !== 'event' && k !== 'event_id')
                .map((k) => cell[k as keyof typeof cell]),
            ),
          ),
          JSON.stringify(cell),
        ],
      );
      return { inserted: 1 };
    });
  }
  async aggregates(publisher: string, key?: string) {
    return this.transaction(async (client) => {
      if (key !== undefined) {
        if (!/^stq_[A-Za-z0-9_-]{43}$/.test(key))
          throw new BrokerError('source_unauthorized');
        const authority = await client.query(
          'SELECT publisher FROM station_telemetry.publisher_keys WHERE publisher=$1 AND credential_hash=$2 FOR SHARE',
          [publisher, hash(key)],
        );
        if (!authority.rows.length)
          throw new BrokerError('source_unauthorized');
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('station.product.telemetry.admission'))",
      );
      // Every public marginal comes from the SAME disjoint, thresholded cells. No raw total is released.
      const rows = await client.query<CellRow>(
        `SELECT to_char(day,'YYYY-MM-DD') AS day,cell,pings::text FROM station_telemetry.lite_rollups
        WHERE publisher=$1 AND day >= (statement_timestamp() AT TIME ZONE 'UTC')::date-30
        AND day < (statement_timestamp() AT TIME ZONE 'UTC')::date AND ($2::boolean OR pings>=10)
        ORDER BY day,cell LIMIT 10001`,
        [publisher, key !== undefined],
      );
      if (rows.rows.length > 10000) throw new BrokerError('query_limit');
      const days = new Map<
        string,
        {
          day: string;
          representedPings: number;
          firstActiveThisWeek: number;
          firstActiveThisMonth: number;
          distributions: Record<string, Record<string, number>>;
        }
      >();
      for (const { day, cell, pings } of rows.rows) {
        const n = Number(pings);
        let result = days.get(day);
        if (!result) {
          result = {
            day,
            representedPings: 0,
            firstActiveThisWeek: 0,
            firstActiveThisMonth: 0,
            distributions: Object.create(null),
          };
          days.set(day, result);
        }
        result.representedPings += n;
        if (cell.first_active_this_week) result.firstActiveThisWeek += n;
        if (cell.first_active_this_month) result.firstActiveThisMonth += n;
        for (const [field, value] of Object.entries(cell)) {
          result.distributions[field] ??= Object.create(null);
          const histogram = result.distributions[field];
          const values = Array.isArray(value)
            ? value.length
              ? value.map((v) =>
                  typeof v === 'object' ? `${v.engine}:${v.bucket}` : String(v),
                )
              : ['none']
            : [String(value)];
          for (const bucket of values)
            histogram[bucket] = (histogram[bucket] ?? 0) + n;
        }
      }
      return {
        scope:
          key === undefined
            ? 'public-kontour-safe-cells'
            : 'publisher-received-pings',
        publisher,
        minimumCellPings: key === undefined ? 10 : null,
        dayBasis: 'UTC-receiver-arrival',
        deliveryCoverage: 'unknown',
        days: [...days.values()],
      };
    });
  }
}
