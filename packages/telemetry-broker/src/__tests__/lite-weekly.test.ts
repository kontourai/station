import { createHash } from 'node:crypto';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import type { Pool, QueryResultRow } from 'pg';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProductBroker } from '../app.js';
import {
  assertLiteSchema,
  LiteRepository,
  migrateLite,
} from '../lite-store.js';
import { PgProductRepository } from '../store.js';
import { dailyPing, socketBindings } from './lite-fixture.js';

const operatorKey = `sto_${'o'.repeat(43)}`,
  publisherKey = `stq_${'p'.repeat(43)}`;
const sqlClient = (connection: Pick<PGliteInterface, 'query' | 'exec'>) => ({
  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) {
    if (text.includes(';')) {
      await connection.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const r = await connection.query<Row>(text, values);
    return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
  },
});
let db: PGlite, lite: LiteRepository;
let app: ReturnType<typeof createProductBroker>;
let today: string, closedWeek: string;
beforeEach(async () => {
  db = new PGlite();
  lite = new LiteRepository(
    (operation) => db.transaction((tx) => operation(sqlClient(tx))),
    100000,
    1_073_741_824,
  );
  await db.exec(
    'CREATE SCHEMA station_telemetry; CREATE TABLE station_telemetry.migrations(version integer PRIMARY KEY,digest text NOT NULL)',
  );
  await migrateLite(sqlClient(db));
  await migrateLite(sqlClient(db));
  await sqlClient(db).query(
    'UPDATE station_telemetry.lite_noise_key SET secret=$1',
    [Buffer.alloc(32, 7)],
  );
  await db.transaction((tx) => assertLiteSchema(sqlClient(tx)));
  today = (
    await db.query<{ day: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
    )
  ).rows[0].day;
  closedWeek = (
    await db.query<{ day: string }>(
      "SELECT to_char(date_trunc('week',statement_timestamp() AT TIME ZONE 'UTC')-interval '7 days','YYYY-MM-DD') AS day",
    )
  ).rows[0].day;
  await lite.createSource({
    id: 'kontour',
    publisher: 'kontour',
    channel: 'stable',
    registryIds: ['public.plugin', 'rare.plugin'],
    releaseVersions: ['1.2.3'],
  });
  await lite.createSource({
    id: 'third-party',
    publisher: 'publisher:example',
    channel: 'stable',
    registryIds: ['third.plugin'],
    releaseVersions: ['2.0.0'],
  });
  await lite.setPublisherKey(
    'publisher:example',
    createHash('sha256').update(publisherKey).digest('hex'),
  );
  const full = new PgProductRepository({} as Pool);
  app = createProductBroker(Object.assign(full, { lite }), operatorKey);
});
afterEach(async () => {
  vi.useRealTimers();
  await db.close();
});
const auth = (key = operatorKey) => ({
  headers: { authorization: `Bearer ${key}` },
});
async function send(address: string, rare = false) {
  const r = await app.request(
    '/v1/lite/kontour',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...dailyPing(),
        surfaces_today: ['web', 'cli'],
        safe_mode_entered: 127,
        public_plugins_enabled: rare ? ['rare.plugin'] : ['public.plugin'],
      }),
    },
    socketBindings(address),
  );
  expect(r.status).toBe(202);
}
async function closeDay(day = closedWeek) {
  await db.query(
    'UPDATE station_telemetry.lite_finalization SET day=$1 WHERE day=$2',
    [day, today],
  );
  await db.query(
    "UPDATE station_telemetry.lite_pings SET received_at=$1::date::timestamp AT TIME ZONE 'UTC' WHERE received_at >= $2::date::timestamp AT TIME ZONE 'UTC'",
    [day, today],
  );
}
async function readAll(path = '/v1/public/aggregates', key?: string) {
  const cells: Awaited<ReturnType<LiteRepository['aggregates']>>['cells'] = [];
  let cursor: string | null = null;
  do {
    const r = await app.request(
      path + (cursor ? `?cursor=${cursor}` : ''),
      key ? auth(key) : undefined,
    );
    expect(r.status).toBe(200);
    const page: Awaited<ReturnType<LiteRepository['aggregates']>> =
      await r.json();
    expect(page.cells.length).toBeLessThanOrEqual(200);
    cells.push(...page.cells);
    cursor = page.nextCursor;
  } while (cursor);
  return cells;
}

test('padding probe always releases rare values, including zero, on identical fixed weekly support', async () => {
  // Nine independent attacker IPv4 keys; a tenth victim must not change shape.
  for (let i = 1; i <= 9; i++) await send(`198.51.100.${i}`, true);
  await closeDay();
  const before = await readAll();
  const rare = before.find(
    (c) =>
      c.week === closedWeek &&
      c.dimension === 'public_plugins_enabled' &&
      c.value === 'rare.plugin',
  );
  expect(rare).toBeDefined();
  const truths = (
    await db.query<{
      dimension: string;
      value: string;
      pings: number;
      clients: number;
    }>(
      "SELECT dimension,value,pings,clients FROM station_telemetry.lite_marginals WHERE publisher='kontour' AND day=$1",
      [closedWeek],
    )
  ).rows;
  expect(
    truths.find(
      (r) =>
        r.dimension === 'public_plugins_enabled' && r.value === 'rare.plugin',
    ),
  ).toMatchObject({ pings: 9, clients: 9 });
  expect(
    before.some(
      (c) =>
        c.week === closedWeek &&
        c.estimate !==
          Number(
            truths.find(
              (r) => r.dimension === c.dimension && r.value === c.value,
            )?.pings ?? 0,
          ),
    ),
    'published estimates must include nonzero noise rather than exact counts',
  ).toBe(true);

  expect(
    before.filter((c) => c.dimension === 'platform' && c.value === 'aix'),
  ).toHaveLength(4);
  expect(
    before.some(
      (c) =>
        c.dimension === 'safe_mode_entered' ||
        c.dimension === 'engine_connect_failures',
    ),
  ).toBe(false);
  // A separate unpublished scenario uses the same operator domain and noise key.
  // Fixture reset only: production has no publication deletion route.
  await db.exec(
    'DELETE FROM station_telemetry.lite_published; DELETE FROM station_telemetry.lite_publications',
  );
  for (let i = 1; i <= 9; i++) await send(`198.51.100.${i}`, true);
  await send('203.0.113.1', true);
  await closeDay();
  const withVictim = await lite.aggregates('kontour');
  expect(
    (
      await db.query(
        "SELECT pings,clients FROM station_telemetry.lite_marginals WHERE publisher='kontour' AND day=$1 AND dimension='public_plugins_enabled' AND value='rare.plugin'",
        [closedWeek],
      )
    ).rows,
  ).toEqual([{ pings: 10, clients: 10 }]);

  const after = [];
  after.push(...withVictim.cells);
  let cursor = withVictim.nextCursor;
  while (cursor) {
    const p = await lite.aggregates('kontour', undefined, cursor);
    after.push(...p.cells);
    cursor = p.nextCursor;
  }
  expect(
    after.map(({ week, dimension, value }) => [week, dimension, value]),
  ).toEqual(
    before.map(({ week, dimension, value }) => [week, dimension, value]),
  );
  const kontourKey = `stq_${'k'.repeat(43)}`;
  await lite.setPublisherKey(
    'kontour',
    createHash('sha256').update(kontourKey).digest('hex'),
  );
  const publicCells = await lite.aggregates('kontour');
  expect((await lite.aggregates('kontour', kontourKey)).cells).toEqual(
    publicCells.cells,
  );
  expect(publicCells.epsilonPerCount).toBe(1 / 280);
  expect(publicCells.epsilonPerPing).toBe(1 / 7);
  const own = await readAll(
    '/v1/publishers/publisher%3Aexample/aggregates',
    publisherKey,
  );
  expect(own.some((c) => c.value === 'third.plugin')).toBe(true);
  expect(
    own.some((c) => c.value === 'rare.plugin' || c.value === '1.2.3'),
  ).toBe(false);
});

test.each([
  ['IPv4', ['198.51.100.1', '198.51.100.1', '198.51.100.2']],
  [
    'IPv6 /48',
    ['2001:db8:1234:1::1', '2001:db8:1234:2::1', '2001:db8:5678:1::1'],
  ],
])(
  'operator endpoints require the operator key and return exact daily pings and contributor counts (%s)',
  async (_label, addresses) => {
    for (const address of addresses) await send(address);
    await closeDay();
    for (const period of ['daily', 'weekly']) {
      for (const key of [undefined, publisherKey, `sto_${'x'.repeat(43)}`])
        expect(
          (
            await app.request(
              `/v1/operator/lite/${period}`,
              key ? auth(key) : undefined,
            )
          ).status,
        ).toBe(401);
      expect(
        (
          await app.request(
            `/v1/operator/lite/${period}?platform=linux`,
            auth(),
          )
        ).status,
      ).toBe(400);
      const r = await app.request(`/v1/operator/lite/${period}`, auth());
      expect(r.status).toBe(200);
      const result = await r.json();
      expect(result.marginals).toContainEqual({
        period: closedWeek,
        publisher: 'kontour',
        dimension: 'platform',
        value: 'linux',
        pings: '3',
        contributors: '2',
      });
      for (const [dimension, value] of [
        ['safe_mode_entered', '21+'],
        ['surfaces_today', 'web'],
        ['surfaces_today', 'cli'],
        ['first_active_this_week', 'true'],
        ['engines_used_today', 'codex'],
      ]) {
        expect(result.marginals).toContainEqual({
          period: closedWeek,
          publisher: 'kontour',
          dimension,
          value,
          pings: '3',
          contributors: '2',
        });
      }
      expect(result.contributorUnit).toBe(
        period === 'daily'
          ? 'distinct-daily-network-keys'
          : 'sum-of-distinct-daily-network-keys',
      );
    }
  },
);

test('release waits for the closed ISO week and sums pings from multiple days exactly once', async () => {
  await send('198.51.100.1');
  await closeDay();
  await send('198.51.100.2');
  const day2 = new Date(Date.parse(closedWeek) + 86400000)
    .toISOString()
    .slice(0, 10);
  await closeDay(day2);
  await send('198.51.100.3');
  await closeDay(
    new Date(Date.parse(closedWeek) + 7 * 86400000).toISOString().slice(0, 10),
  );
  const cells = await readAll();
  expect([...new Set(cells.map((c) => c.week))]).toHaveLength(4);
  expect(cells.every((c) => new Date(c.week).getUTCDay() === 1)).toBe(true);
  const exact = await lite.exact('weekly');
  expect(exact.marginals).toContainEqual({
    period: closedWeek,
    publisher: 'kontour',
    dimension: 'platform',
    value: 'linux',
    pings: '2',
    contributors: '2',
  });
  const published = await db.query<{ n: number }>(
    "SELECT count(*) AS n FROM station_telemetry.lite_publications WHERE week>=date_trunc('week',statement_timestamp() AT TIME ZONE 'UTC')",
  );
  expect(Number(published.rows[0].n)).toBe(0);
});

test('a published week cannot be finalized again when counts or operator catalogs change', async () => {
  await send('198.51.100.1');
  await closeDay();
  const first = await readAll();
  await db.query(
    "UPDATE station_telemetry.lite_marginals SET pings=pings+100000 WHERE publisher='kontour'",
  );
  await lite.createSource({
    id: 'later',
    publisher: 'kontour',
    channel: 'stable',
    registryIds: ['new.plugin'],
    releaseVersions: ['9.9.9'],
  });
  // Bypass the HTTP cache and use a reopened repository.
  const reopened = new LiteRepository(
    (operation) => db.transaction((tx) => operation(sqlClient(tx))),
    100000,
    1_073_741_824,
  );
  const after = [];
  let cursor: string | undefined;
  do {
    const p = await reopened.aggregates('kontour', undefined, cursor);
    after.push(...p.cells);
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  expect(after).toEqual(first);
  expect(
    (
      await db.query<{ n: number }>(
        "SELECT count(*) AS n FROM station_telemetry.lite_publications WHERE publisher='kontour'",
      )
    ).rows[0].n,
  ).toBe(4);
});

test('bounded cursor pages cover more than ten thousand values without truncation or publisher mixing', async () => {
  await lite.createSource({
    id: 'large',
    publisher: 'publisher:large',
    channel: 'stable',
    registryIds: Array.from({ length: 1000 }, (_, i) => `plugin.${i}`),
    releaseVersions: Array.from({ length: 1000 }, (_, i) => `v${i}`),
  });
  let cursor: string | undefined;
  const cells = [];
  do {
    const p = await lite.aggregates('publisher:large', undefined, cursor);
    expect(p.cells.length).toBeLessThanOrEqual(200);
    cells.push(...p.cells);
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  expect(cells.length).toBeGreaterThan(10000);
  expect(
    new Set(cells.map((c) => JSON.stringify([c.week, c.dimension, c.value])))
      .size,
  ).toBe(cells.length);
  for (const suffix of ['?cursor=bad', '?platform=linux', '?cursor=a&cursor=b'])
    expect((await app.request(`/v1/public/aggregates${suffix}`)).status).toBe(
      400,
    );
});

test('expired full and publisher credential snapshots return 503 after refresh failure; malformed URI returns 400', async () => {
  expect(
    (await app.request('/v1/publishers/%E0/aggregates', auth(publisherKey)))
      .status,
  ).toBe(400);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 61000);
  await expect(
    lite.refreshCredentials({
      query: async () => {
        throw new Error('database unavailable');
      },
    }),
  ).rejects.toThrow('database unavailable');
  for (const path of [
    '/v1/publishers/publisher%3Aexample/aggregates',
    '/v1/product/events',
  ]) {
    const r = await app.request(
      path,
      path.includes('/product/')
        ? {
            method: 'POST',
            headers: { 'x-api-key': `stp_${'b'.repeat(43)}` },
            body: '{}',
          }
        : auth(publisherKey),
    );
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'credentials_stale' });
  }
});

test('migration 5 to 6 is transactional and idempotent without changing exact marginals or noise key', async () => {
  await db.exec(
    'DROP TABLE station_telemetry.lite_published; DROP TABLE station_telemetry.lite_publications; DELETE FROM station_telemetry.migrations WHERE version=6',
  );
  await db.query(
    "INSERT INTO station_telemetry.lite_marginals VALUES($1,'kontour','platform','linux',123,45,true)",
    [closedWeek],
  );
  const marginals = (
    await db.query('SELECT * FROM station_telemetry.lite_marginals')
  ).rows;
  const key = (
    await db.query('SELECT secret FROM station_telemetry.lite_noise_key')
  ).rows;
  await expect(
    db.transaction(async (tx) => {
      await migrateLite(sqlClient(tx));
      throw new Error('migration interruption');
    }),
  ).rejects.toThrow('migration interruption');
  expect(
    (
      await db.query(
        'SELECT version FROM station_telemetry.migrations WHERE version=6',
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.query(
        "SELECT to_regclass('station_telemetry.lite_published') AS name",
      )
    ).rows,
  ).toEqual([{ name: null }]);
  await db.transaction((tx) => migrateLite(sqlClient(tx)));
  await db.transaction((tx) => migrateLite(sqlClient(tx)));
  await db.transaction((tx) => assertLiteSchema(sqlClient(tx)));
  expect(
    (await db.query('SELECT secret FROM station_telemetry.lite_noise_key'))
      .rows,
  ).toEqual(key);
  expect(
    (await db.query('SELECT * FROM station_telemetry.lite_marginals')).rows,
  ).toEqual(marginals);
});

test('a stale arrival-day salt rolls back raw insertion, jobs and capacity', async () => {
  await expect(
    lite.ingest('kontour', dailyPing(), {
      day: '2000-01-01',
      hash: 'a'.repeat(64),
    }),
  ).rejects.toMatchObject({ code: 'storage_busy' });
  expect(
    (await db.query('SELECT pings FROM station_telemetry.lite_capacity')).rows,
  ).toEqual([{ pings: 0 }]);
  expect(
    (await db.query('SELECT * FROM station_telemetry.lite_pings')).rows,
  ).toEqual([]);
  expect(
    (await db.query('SELECT * FROM station_telemetry.lite_finalization')).rows,
  ).toEqual([]);
});
