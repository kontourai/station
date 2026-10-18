import { createHash } from 'node:crypto';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import type { Pool, QueryResultRow } from 'pg';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProductBroker } from '../app.js';
import { clientAddressPolicy } from '../client-address.js';
import {
  assertLiteSchema,
  LiteRepository,
  migrateLite,
} from '../lite-store.js';
import { noisyCount } from '../noisy-count.js';
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
  vi.restoreAllMocks();
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
  await lite.finalize();
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
  await lite.finalize();
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
  expect(publicCells.epsilonPerAddedPing).toBe(1 / 7);
  const own = await readAll(
    '/v1/publishers/publisher%3Aexample/aggregates',
    publisherKey,
  );
  expect(own.some((c) => c.value === 'third.plugin')).toBe(true);
  expect(
    own.some((c) => c.value === 'rare.plugin' || c.value === '1.2.3'),
  ).toBe(false);
});

test('trusted proxy contributes distinct clients and accepts the sender unknown sentinels', async () => {
  await lite.createSource({
    id: 'unknown-channel',
    publisher: 'kontour',
    channel: 'unknown',
    registryIds: [],
    releaseVersions: [],
  });
  const addresses = clientAddressPolicy('192.0.2.1/32');
  const full = new PgProductRepository({} as Pool);
  app = createProductBroker(
    Object.assign(full, { lite }),
    operatorKey,
    addresses,
  );
  const header = '203.0.113.87';
  for (const [peer, value] of [
    ['192.0.2.1', header],
    ['192.0.2.1', '203.0.113.88'],
    ['192.0.2.2', header],
    ['192.0.2.2', '203.0.113.89'],
  ]) {
    const response = await app.request(
      '/v1/lite/unknown-channel',
      {
        method: 'POST',
        headers: { 'cf-connecting-ip': value },
        body: JSON.stringify({
          ...dailyPing(),
          version: 'custom',
          channel: 'unknown',
          distribution: 'unknown',
          layouts_customized: 'unknown',
          public_plugins_enabled: [],
        }),
      },
      socketBindings(peer),
    );
    expect(response.status).toBe(202);
  }
  await closeDay();
  await lite.finalize();
  const exact = await (
    await app.request('/v1/operator/lite/daily', auth())
  ).json();
  expect(exact.marginals).toContainEqual({
    period: closedWeek,
    publisher: 'kontour',
    dimension: 'channel',
    value: 'unknown',
    pings: '4',
    contributors: '3',
  });
  const published = await readAll();
  for (const dimension of ['channel', 'distribution'])
    expect(
      published.some((c) => c.dimension === dimension && c.value === 'unknown'),
    ).toBe(true);
  expect((await app.request('/v1/operator/diagnostics')).status).toBe(401);
  expect(
    await (await app.request('/v1/operator/diagnostics', auth())).json(),
  ).toEqual({ invalidClientIpHeaders: 0 });
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
    await lite.finalize();
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

test('release waits for the closed ISO week and sums network-days from multiple days exactly once', async () => {
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
  await lite.finalize();
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
  await lite.finalize();
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
  await lite.finalize();
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
  await lite.finalize();
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
  for (const suffix of [
    '?cursor=' +
      Buffer.from(JSON.stringify(['2026-02-30', 'platform', 'linux'])).toString(
        'base64url',
      ),
    '?cursor=bad',
    '?platform=linux',
    '?cursor=a&cursor=b',
  ])
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

test('58 pings in one network-day publish one contribution; eight pings over a UTC week publish seven', async () => {
  for (let i = 0; i < 58; i++) await send('198.51.100.58');
  await closeDay();
  for (let day = 0; day < 7; day++) {
    const date = new Date(Date.parse(closedWeek) + day * 86400000)
      .toISOString()
      .slice(0, 10);
    for (let i = 0; i < (day === 0 ? 2 : 1); i++) {
      await lite.ingest(
        'third-party',
        {
          ...dailyPing(),
          version: '2.0.0',
          public_plugins_enabled: ['third.plugin'],
        },
        {
          day: today,
          hash: createHash('sha256')
            .update(`daily-network-${day}`)
            .digest('hex'),
        },
      );
    }
    await closeDay(date);
  }
  await lite.finalize();
  const daily = await lite.exact('daily');
  expect(daily.marginals).toContainEqual({
    period: closedWeek,
    publisher: 'kontour',
    dimension: 'platform',
    value: 'linux',
    pings: '58',
    contributors: '1',
  });
  const weekly = await lite.exact('weekly');
  expect(weekly.marginals).toContainEqual({
    period: closedWeek,
    publisher: 'publisher:example',
    dimension: 'platform',
    value: 'linux',
    pings: '8',
    contributors: '7',
  });
  for (const [publisher, count] of [
    ['kontour', 1],
    ['publisher:example', 7],
  ] as const) {
    const cells = await db.query<{
      dimension: string;
      value: string;
      estimate: number;
    }>(
      'SELECT dimension,value,estimate FROM station_telemetry.lite_published WHERE publisher=$1 AND week=$2 AND (dimension,value) IN (SELECT dimension,value FROM station_telemetry.lite_marginals WHERE publisher=$1 AND day=$2)',
      [publisher, closedWeek],
    );
    expect(
      cells.rows.some(
        (c) =>
          noisyCount(
            Buffer.alloc(32, 7),
            publisher,
            closedWeek,
            c.dimension,
            c.value,
            count,
          ) > 0,
      ),
      'the fixture must exercise unclamped counts',
    ).toBe(true);
    for (const cell of cells.rows)
      expect(Number(cell.estimate)).toBe(
        noisyCount(
          Buffer.alloc(32, 7),
          publisher,
          closedWeek,
          cell.dimension,
          cell.value,
          count,
        ),
      );
    const result = await lite.aggregates(publisher);
    const domain = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM station_telemetry.lite_published WHERE publisher=$1 AND week=$2',
      [publisher, closedWeek],
    );
    expect(result.maximumPublicCoordinatesPerWeek).toBe(domain.rows[0].n);
    expect(result.maximumNetworkWeekEpsilon).toBeCloseTo(
      (7 * domain.rows[0].n) / 280,
      12,
    );
    expect(result).not.toHaveProperty('maximumHonestInstallWeekEpsilon');
  }
});

test('poisoned publisher/day does not block reads or healthy finalization; operator sees the failed job', async () => {
  await send('198.51.100.1');
  await closeDay();
  await lite.finalize();
  // Ensure the public request below is a cache miss, and poison real stored input.
  await lite.ingest(
    'third-party',
    {
      ...dailyPing(),
      version: '2.0.0',
      public_plugins_enabled: ['third.plugin'],
    },
    { day: today, hash: 'b'.repeat(64) },
  );
  await closeDay();
  await db.query(
    "UPDATE station_telemetry.lite_pings SET contributions=jsonb_set(contributions,'{version}', '{}'::jsonb) WHERE source_id='third-party'",
  );
  // A second healthy day must still finish and erase its contributor association.
  await send('198.51.100.2');
  const healthyDay = new Date(Date.parse(closedWeek) + 86400000)
    .toISOString()
    .slice(0, 10);
  await closeDay(healthyDay);
  // Reads must work even before the background job retries the poisoned day.
  const finalizer = vi
    .spyOn(lite, 'finalize')
    .mockRejectedValue(new Error('must never finalize on read'));
  for (const [path, key] of [
    ['/v1/public/aggregates', undefined],
    ['/v1/publishers/publisher%3Aexample/aggregates', publisherKey],
    ['/v1/operator/lite/daily', operatorKey],
    ['/v1/operator/lite/weekly', operatorKey],
  ] as const)
    expect((await app.request(path, key ? auth(key) : undefined)).status).toBe(
      200,
    );
  expect(finalizer).not.toHaveBeenCalled();
  finalizer.mockRestore();
  await expect(lite.finalize()).resolves.toBe(today);
  const exact = await (
    await app.request('/v1/operator/lite/daily', auth())
  ).json();
  expect(exact.finalizationDiagnostics.failures).toContainEqual({
    period: closedWeek,
    publisher: 'publisher:example',
    stage: 'daily',
    code: '22023',
  });
  expect(exact.marginals).toContainEqual({
    period: healthyDay,
    publisher: 'kontour',
    dimension: 'platform',
    value: 'linux',
    pings: '1',
    contributors: '1',
  });
  expect(
    (
      await db.query<{ client_hash: unknown; contributions: unknown }>(
        "SELECT client_hash,contributions FROM station_telemetry.lite_pings WHERE source_id='kontour'",
      )
    ).rows.every((r) => r.client_hash === null && r.contributions === null),
  ).toBe(true);
  expect(
    (
      await db.query<{ n: number }>(
        "SELECT count(*) AS n FROM station_telemetry.lite_finalization WHERE publisher='publisher:example'",
      )
    ).rows[0].n,
  ).toBeGreaterThan(0);
});

test('a Sunday cutoff cannot publish the week that closes while finalization is in flight', async () => {
  // SQL's live clock is in a later week; the finalizer captured the preceding Sunday.
  const sunday = new Date(Date.parse(closedWeek) + 6 * 86400000)
    .toISOString()
    .slice(0, 10);
  const fenced = new LiteRepository(
    (operation) =>
      db.transaction((tx) => {
        const client = sqlClient(tx);
        return operation({
          async query<Row extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: unknown[],
          ) {
            if (
              text ===
              "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day"
            ) {
              return client.query<Row>('SELECT $1::text AS day', [sunday]);
            }
            return client.query<Row>(text, values);
          },
        });
      }),
    100000,
    1_073_741_824,
  );
  await fenced.finalize();
  expect(
    (
      await db.query(
        'SELECT week FROM station_telemetry.lite_publications WHERE week=$1',
        [closedWeek],
      )
    ).rows,
  ).toEqual([]);
  // The next pass crosses the fence, includes Sunday's arrival, and publishes it once.
  await send('198.51.100.1');
  await closeDay(sunday);
  await lite.finalize();
  expect((await lite.exact('weekly')).marginals).toContainEqual({
    period: closedWeek,
    publisher: 'kontour',
    dimension: 'platform',
    value: 'linux',
    pings: '1',
    contributors: '1',
  });
  expect(
    (
      await db.query<{ n: number }>(
        "SELECT count(*) AS n FROM station_telemetry.lite_publications WHERE publisher='kontour' AND week=$1",
        [closedWeek],
      )
    ).rows[0].n,
  ).toBe(1);
});

test('forged cursors return 400 without evicting a cached public page', async () => {
  await lite.finalize();
  const reads = vi.spyOn(lite, 'publicAggregates');
  const first = await app.request('/v1/public/aggregates');
  const page = await first.json();
  expect(first.status).toBe(200);
  expect(page.nextCursor).toBeTypeOf('string');
  // Use a valid issued payload with a forged authentication tag (not merely bad syntax).
  const payload = page.nextCursor.split('.')[0];
  let elapsed = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  for (let i = 0; i < 130; i++) {
    elapsed += 1000;
    const signature = createHash('sha256')
      .update(String(i))
      .digest('base64url');
    expect(
      (
        await app.request(
          `/v1/public/aggregates?cursor=${payload}.${signature}`,
        )
      ).status,
    ).toBe(400);
  }
  const calls = reads.mock.calls.length;
  expect((await app.request('/v1/public/aggregates')).status).toBe(200);
  expect(reads).toHaveBeenCalledTimes(calls);
  expect(
    (await app.request(`/v1/public/aggregates?cursor=${page.nextCursor}`))
      .status,
  ).toBe(200);
});
