import { PGlite } from '@electric-sql/pglite';
import {
  createProductTelemetryIncidentDraft,
  isProductTelemetryIncidents,
} from '@kontourai/station-contracts/product-telemetry';
import type { QueryResultRow } from 'pg';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createProductBroker } from '../app.js';
import { readProductIncidents } from '../product-incidents.js';
import type { ProductRepository } from '../store.js';

let db: PGlite;
const from = '2026-10-01T00:00:00.000Z',
  to = '2026-10-02T00:00:00.000Z';
const operator = `sto_${'o'.repeat(43)}`;
const build = {
  version: '1.2.3',
  platform: 'linux',
  arch: 'x64',
  sha: 'a'.repeat(40),
  sha_source: 'build-stamp',
  channel: 'stable',
  dirty: false,
};
const queryClient = {
  async query<Row extends QueryResultRow>(text: string, values: unknown[]) {
    const result = await db.query<Row>(text, values);
    return { rows: result.rows };
  },
};
beforeEach(async () => {
  db = new PGlite();
  // The query's product-event relation. Private usage and source identity
  // relations are deliberately absent: this read must not depend on either.
  await db.exec(`CREATE SCHEMA station_telemetry;
    CREATE TABLE station_telemetry.events(source_id uuid,event_id uuid,distinct_id text,event text,
    occurred_at timestamptz,observation jsonb,PRIMARY KEY(source_id,event_id));`);
});
afterEach(async () => db.close());
async function insert(
  index: number,
  event: string,
  outcome: string | null,
  version = '1.2.3',
) {
  await db.query(
    `INSERT INTO station_telemetry.events VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
    [
      '11234567-89ab-4cde-8fab-0123456789ab',
      `11234567-89ab-4cde-8fab-${String(index).padStart(12, '0')}`,
      index % 2 ? 'installation-a' : 'installation-b',
      event,
      `2026-10-01T12:00:${String(index % 60).padStart(2, '0')}.000Z`,
      JSON.stringify({
        build: { ...build, version, unexpectedPath: '/private/secret' },
        properties: {
          engine: 'codex',
          failure_kind: 'rate-limit',
          ...(outcome ? { outcome } : {}),
          rawStack: 'SECRET_STACK',
        },
      }),
    ],
  );
}
const reportSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      event: z.string(),
      engine: z.string().nullable(),
      failureKind: z.string(),
      build: z.object({ version: z.string() }),
      observed: z.number(),
      observedInstalls: z.number(),
      affectedInstalls: z.number(),
      populations: z.object({
        succeeded: z.number(),
        failed: z.number(),
        aborted: z.number(),
        unresolved: z.number(),
        unknown: z.number(),
      }),
      firstSeen: z.string(),
      lastSeen: z.string(),
    }),
  ),
});

test('operator incidents expose independent outcome populations and received denominators without raw identity or content', async () => {
  await insert(1, 'engine_turn', 'failed');
  await insert(1, 'engine_turn', 'failed');
  await insert(2, 'engine_turn', 'completed');
  await insert(3, 'engine_turn', 'aborted');
  await insert(4, 'engine_turn', null);
  await insert(5, 'engine_turn', 'failed', '1.2.4');
  for (const [index, outcome] of [
    'failed',
    'canceled',
    'armed',
    'succeeded',
    null,
  ].entries())
    await insert(10 + index, 'session_recovery', outcome);
  await insert(20, 'app_started', null);
  const incidents = vi.fn(async (start: string, end: string) =>
    readProductIncidents(queryClient, start, end, 30),
  );
  const product: ProductRepository = {
    hasCredential: () => false,
    authenticate: vi.fn(),
    ingest: vi.fn(),
    probe: vi.fn(),
    createSource: vi.fn(),
    revokeSource: vi.fn(),
    receipt: vi.fn(),
    trends: vi.fn(),
    incidents,
    ready: vi.fn(),
  };
  const app = createProductBroker(product, operator);
  const path = `/v1/operator/incidents?from=${from}&to=${to}`;
  expect(
    (
      await app.request(path, {
        headers: { authorization: `Bearer stp_${'s'.repeat(43)}` },
      })
    ).status,
  ).toBe(401);
  expect(incidents).not.toHaveBeenCalled();
  const response = await app.request(path, {
    headers: { authorization: `Bearer ${operator}` },
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  for (const privateValue of [
    'installation-a',
    'installation-b',
    'SECRET_STACK',
    '/private/secret',
  ])
    expect(text).not.toContain(privateValue);
  const raw: unknown = JSON.parse(text);
  expect(raw).toMatchObject({
    protocol: 'station-product-incidents/v1',
    deliveryCoverage: 'unknown',
    eventTime: 'producer-wall-clock',
    storageProbes: 'not-recorded',
    retentionDays: 30,
  });
  expect(isProductTelemetryIncidents(raw)).toBe(true);
  const report = reportSchema.parse(raw);
  expect(report.rows).toHaveLength(3);
  const engine = report.rows.find(
    (row) => row.event === 'engine_turn' && row.build.version === '1.2.3',
  );
  expect(engine).toMatchObject({
    engine: 'codex',
    failureKind: 'unclassified',
    observed: 4,
    observedInstalls: 2,
    affectedInstalls: 2,
    populations: {
      succeeded: 1,
      failed: 1,
      aborted: 1,
      unresolved: 0,
      unknown: 1,
    },
    firstSeen: '2026-10-01T12:00:01.000Z',
    lastSeen: '2026-10-01T12:00:04.000Z',
  });
  expect(
    report.rows.find((row) => row.event === 'session_recovery'),
  ).toMatchObject({
    engine: null,
    failureKind: 'rate-limit',
    observed: 5,
    populations: {
      succeeded: 1,
      failed: 1,
      aborted: 1,
      unresolved: 1,
      unknown: 1,
    },
  });
  expect(
    report.rows.find((row) => row.build.version === '1.2.4'),
  ).toMatchObject({ observed: 1, populations: { failed: 1, succeeded: 0 } });
  if (!engine) throw new Error('missing engine cohort');
  const draft = createProductTelemetryIncidentDraft(raw, engine.id);
  expect(draft?.title).toBe('Observed engine_turn incident: codex · 1.2.3');
  expect(draft?.body).toContain(
    '1 failed; 1 aborted; 0 unresolved; 1 unknown; 1 succeeded',
  );
  expect(draft?.body).toContain('Observed denominator: 4');
  expect(draft?.body).toContain('Delivery coverage is unknown');
  expect(draft?.evidence).toEqual({
    protocol: 'station-product-incidents/v1',
    groupId: engine.id,
    window: { from, to },
  });
  for (const secret of [
    'installation-a',
    'installation-b',
    'SECRET_STACK',
    '/private/secret',
  ])
    expect(draft?.body).not.toContain(secret);
  if (!isProductTelemetryIncidents(raw)) throw new Error('invalid report');
  const first = raw.rows[0];
  if (!first) throw new Error('missing group');
  for (const tampered of [
    { ...raw, unexpectedPath: '/private/secret' },
    {
      ...raw,
      rows: [
        { ...first, build: { ...first.build, version: '/private/secret' } },
      ],
    },
    { ...raw, rows: [{ ...first, observed: first.observed + 1 }] },
    {
      ...raw,
      rows: [{ ...first, affectedInstalls: first.observedInstalls + 1 }],
    },
  ])
    expect(createProductTelemetryIncidentDraft(tampered, first.id)).toBeNull();
  const again = await readProductIncidents(queryClient, from, to, 30);
  expect(
    again.rows.find(
      (row) => row.event === 'engine_turn' && row.build.version === '1.2.3',
    )?.id,
  ).toBe(engine?.id);
  const count = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM station_telemetry.events',
  );
  expect(count.rows[0]?.count).toBe('11');
});

test('incident group overflow fails rather than returning a successful truncated report', async () => {
  await db.query(
    `INSERT INTO station_telemetry.events
    SELECT '11234567-89ab-4cde-8fab-0123456789ab'::uuid,('11234567-89ab-4cde-8fab-'||lpad(n::text,12,'0'))::uuid,
    'installation', 'engine_turn', $1::timestamptz,
    jsonb_build_object('build',jsonb_build_object('version','1.0.'||n::text,'platform','linux','arch','x64'),'properties',jsonb_build_object('engine','codex','outcome','failed'))
    FROM generate_series(1,1001) n`,
    ['2026-10-01T12:00:00.000Z'],
  );
  await expect(
    readProductIncidents(queryClient, from, to, 30),
  ).rejects.toMatchObject({ code: 'query_limit' });
});
