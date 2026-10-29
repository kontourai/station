import { createHash } from 'node:crypto';
import type {
  ProductTelemetryBuild,
  ProductTelemetryIncidents,
} from '@kontourai/station-contracts/product-telemetry';
import type { QueryResultRow } from 'pg';
import { BrokerError } from './broker-error.js';

interface IncidentQueryClient {
  query<Row extends QueryResultRow>(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Row[] }>;
}
interface IncidentRow extends QueryResultRow {
  event: 'engine_turn' | 'session_recovery';
  engine: string | null;
  failure_kind: string;
  build: ProductTelemetryBuild;
  first_seen: Date;
  last_seen: Date;
  observed: string;
  observed_installs: string;
  affected_installs: string;
  succeeded: string;
  failed: string;
  aborted: string;
  unresolved: string;
  unknown: string;
}

/** Read through the product owner's bounded transaction; private usage is never joined. */
export async function readProductIncidents(
  client: IncidentQueryClient,
  from: string,
  to: string,
  retentionDays: number,
): Promise<ProductTelemetryIncidents> {
  const { rows } = await client.query<IncidentRow>(
    `
WITH observations AS (
 SELECT event, CASE WHEN event='engine_turn' THEN observation->'properties'->>'engine' ELSE NULL END AS engine,
 CASE WHEN event='session_recovery' THEN coalesce(observation->'properties'->>'failure_kind','unknown') ELSE 'unclassified' END AS failure_kind,
 observation->'build' AS build, distinct_id, occurred_at,
 CASE
 WHEN event='engine_turn' AND observation->'properties'->>'outcome'='completed' THEN 'succeeded'
 WHEN event='session_recovery' AND observation->'properties'->>'outcome' IN ('succeeded','resumed') THEN 'succeeded'
 WHEN observation->'properties'->>'outcome'='failed' THEN 'failed'
 WHEN (event='engine_turn' AND observation->'properties'->>'outcome'='aborted') OR (event='session_recovery' AND observation->'properties'->>'outcome'='canceled') THEN 'aborted'
 WHEN event='session_recovery' AND observation->'properties'->>'outcome' IN ('armed','manual','unsupported','compensation-required','indeterminate') THEN 'unresolved'
 ELSE 'unknown' END AS population
 FROM station_telemetry.events
 WHERE occurred_at >= $1 AND occurred_at < $2 AND event IN ('engine_turn','session_recovery')
), grouped AS (
 SELECT event,engine,failure_kind,build,
 min(occurred_at) FILTER(WHERE population<>'succeeded') AS first_seen,
 max(occurred_at) FILTER(WHERE population<>'succeeded') AS last_seen,
 count(*)::text AS observed, count(DISTINCT distinct_id)::text AS observed_installs,
 count(DISTINCT distinct_id) FILTER(WHERE population<>'succeeded')::text AS affected_installs,
 count(*) FILTER(WHERE population='succeeded')::text AS succeeded,
 count(*) FILTER(WHERE population='failed')::text AS failed,
 count(*) FILTER(WHERE population='aborted')::text AS aborted,
 count(*) FILTER(WHERE population='unresolved')::text AS unresolved,
 count(*) FILTER(WHERE population='unknown')::text AS unknown
 FROM observations GROUP BY event,engine,failure_kind,build
)
SELECT * FROM grouped WHERE affected_installs::bigint > 0
ORDER BY event,engine NULLS FIRST,failure_kind,build LIMIT 1001`,
    [from, to],
  );
  if (rows.length > 1000) throw new BrokerError('query_limit');
  const count = (value: string) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0)
      throw new BrokerError('query_limit');
    return number;
  };
  return {
    protocol: 'station-product-incidents/v1',
    scope: 'received-product-observations',
    window: { from, to },
    retentionDays,
    eventTime: 'producer-wall-clock',
    deliveryCoverage: 'unknown',
    storageProbes: 'not-recorded',
    rows: rows.map((row) => {
      // Pick public immutable build facts, never an arbitrary stored object.
      const build: ProductTelemetryBuild = {
        version: row.build.version,
        platform: row.build.platform,
        arch: row.build.arch,
        ...(row.build.sha
          ? { sha: row.build.sha, sha_source: row.build.sha_source }
          : {}),
        ...(row.build.channel ? { channel: row.build.channel } : {}),
        ...(row.build.dirty !== undefined ? { dirty: row.build.dirty } : {}),
      };
      const id = createHash('sha256')
        .update(
          JSON.stringify([
            row.event,
            row.engine,
            row.failure_kind,
            build.version,
            build.platform,
            build.arch,
            build.sha ?? null,
            build.sha_source ?? null,
            build.channel ?? null,
            build.dirty ?? null,
          ]),
        )
        .digest('hex');
      return {
        id,
        event: row.event,
        engine: row.engine,
        failureKind: row.failure_kind,
        build,
        firstSeen: new Date(row.first_seen).toISOString(),
        lastSeen: new Date(row.last_seen).toISOString(),
        observed: count(row.observed),
        observedInstalls: count(row.observed_installs),
        affectedInstalls: count(row.affected_installs),
        populations: {
          succeeded: count(row.succeeded),
          failed: count(row.failed),
          aborted: count(row.aborted),
          unresolved: count(row.unresolved),
          unknown: count(row.unknown),
        },
      };
    }),
  };
}
