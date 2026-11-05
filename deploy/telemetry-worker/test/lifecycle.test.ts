import { STATION_DAILY_FIELDS } from '@kontourai/station-contracts/product-telemetry';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { nextMaintenance } from '../src/receiver.ts';
import {
  call,
  fakeReceiver,
  LITE_PATH,
  ping,
  post,
  provision,
  testEnv,
} from './helpers.ts';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const LITE = LITE_PATH;
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const operator = async (env: ReturnType<typeof testEnv>, path: string) => {
  const response = await call(env, path, { operator: true });
  expect(response.status).toBe(200);
  return response.json();
};

test('the daily salt lives in object storage: a restarted object keys a network the same way', async () => {
  at('2026-11-04T08:00:00Z');
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  await post(env, LITE, ping(), { ip: '2001:db8:5:1::1' });
  receiver.restart();
  // Same /48, different /64 and a later arrival on the same UTC day.
  at('2026-11-04T20:00:00Z');
  await post(env, LITE, ping(), { ip: '2001:db8:5:2::9' });
  await post(env, LITE, ping(), { ip: '198.51.100.1' });

  at('2026-11-05T00:30:00Z');
  receiver.restart();
  await receiver.object.alarm();
  const daily = await operator(env, '/v1/operator/lite/daily');
  const linux = daily.marginals.find(
    (row: Record<string, string>) =>
      row.dimension === 'platform' && row.value === 'linux',
  );
  expect(linux).toEqual({
    period: '2026-11-04',
    publisher: 'kontour',
    dimension: 'platform',
    value: 'linux',
    pings: '3',
    contributors: '2',
  });
});

test('closing a day erases its salt and every contributor key', async () => {
  at('2026-11-04T23:59:00Z');
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  await post(env, LITE, ping());
  await post(env, LITE, {
    publisher: 'kontour',
    action: 'tier-lowered',
    reason: 'privacy',
  });
  expect(receiver.rows('SELECT day FROM lite_salts')).toEqual([
    { day: '2026-11-04' },
  ]);
  expect(
    receiver.rows(
      'SELECT count(*) AS n FROM lite_pings WHERE client_hash IS NOT NULL',
    ),
  ).toEqual([{ n: 1 }]);

  // The next day's first arrival replaces the salt before any alarm runs.
  at('2026-11-05T00:00:02Z');
  await post(env, LITE, ping(), { ip: '192.0.2.1' });
  expect(receiver.rows('SELECT day FROM lite_salts')).toEqual([
    { day: '2026-11-05' },
  ]);

  await receiver.object.alarm();
  expect(
    receiver.rows(
      "SELECT client_hash, contributions FROM lite_pings WHERE day = '2026-11-04'",
    ),
  ).toEqual([{ client_hash: null, contributions: null }]);
  expect(receiver.rows('SELECT client_hash FROM lite_feedback')).toEqual([
    { client_hash: null },
  ]);
  // Today's keys stay until today closes.
  expect(
    receiver.rows(
      "SELECT count(*) AS n FROM lite_pings WHERE day = '2026-11-05' AND client_hash IS NOT NULL",
    ),
  ).toEqual([{ n: 1 }]);
  expect(receiver.storage.alarmAt()).toBe(nextMaintenance(Date.now()));
});

test('a forward clock jump closes only days that had a salt', async () => {
  at('2026-11-04T10:00:00Z');
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  expect((await post(env, LITE, ping(), { ip: '192.0.2.1' })).status).toBe(202);
  // The clock jumps two months ahead, takes a ping and runs maintenance.
  at('2027-01-04T10:00:00Z');
  expect((await post(env, LITE, ping(), { ip: '192.0.2.2' })).status).toBe(202);
  at('2027-01-04T11:00:05Z');
  await receiver.object.alarm();
  // Corrected: the real next day was never opened, so it accepts pings. The
  // day whose salt was erased stays closed.
  at('2026-11-05T10:00:00Z');
  expect((await post(env, LITE, ping(), { ip: '192.0.2.3' })).status).toBe(202);
  at('2026-11-04T12:00:00Z');
  expect((await post(env, LITE, ping(), { ip: '192.0.2.4' })).status).toBe(422);
  // The jumped day's salt is gone again, and its pings are finalized rather
  // than left holding contributor keys until 2027.
  at('2026-11-06T00:30:00Z');
  await receiver.object.alarm();
  expect(receiver.rows('SELECT day FROM lite_salts')).toEqual([]);
  expect(
    receiver.rows(
      'SELECT count(*) AS n FROM lite_pings WHERE client_hash IS NOT NULL',
    ),
  ).toEqual([{ n: 0 }]);
});

test('a clock that steps back cannot reopen or refinalize a closed day', async () => {
  at('2026-11-04T10:00:00Z');
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3'])
    expect((await post(env, LITE, ping(), { ip })).status).toBe(202);
  at('2026-11-05T00:30:00Z');
  await receiver.object.alarm();
  const marginals = () =>
    receiver.rows(
      "SELECT dimension, value, pings, clients FROM lite_marginals WHERE day = '2026-11-04' ORDER BY dimension, value",
    );
  const finalized = marginals();
  expect(finalized.find((row) => row.dimension === 'platform')).toEqual({
    dimension: 'platform',
    value: 'linux',
    pings: 3,
    clients: 3,
  });

  // The clock steps back into the closed day: refused with a content-free,
  // non-transient answer, and no salt is recreated for it.
  at('2026-11-04T23:00:00Z');
  const refused = await post(env, LITE, ping(), { ip: '192.0.2.1' });
  expect(refused.status).toBe(422);
  expect(await refused.json()).toEqual({ error: 'day_closed' });
  expect(
    receiver.rows(
      "SELECT count(*) AS n FROM lite_salts WHERE day = '2026-11-04'",
    ),
  ).toEqual([{ n: 0 }]);
  at('2026-11-05T02:00:00Z');
  await receiver.object.alarm();
  expect(marginals()).toEqual(finalized);

  // Finalization is one-time: a pending row for a finalized day (from any
  // path) has its key erased but never replaces the day's marginals.
  const source = receiver.rows(
    'SELECT source_id, ping FROM lite_pings LIMIT 1',
  )[0];
  receiver.storage.db
    .prepare('INSERT INTO lite_pings VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      String(source.source_id),
      crypto.randomUUID(),
      '2026-11-04',
      String(source.ping),
      'f'.repeat(64),
      '{"platform":["darwin"]}',
    );
  await receiver.object.alarm();
  expect(marginals()).toEqual(finalized);
  expect(
    receiver.rows(
      'SELECT count(*) AS n FROM lite_pings WHERE client_hash IS NOT NULL',
    ),
  ).toEqual([{ n: 0 }]);
  const daily = await operator(env, '/v1/operator/lite/daily');
  expect(daily.finalizationDiagnostics.failures).toEqual([
    {
      period: '2026-11-04',
      publisher: 'kontour',
      stage: 'daily',
      code: 'day_already_finalized',
    },
  ]);
});

test("the alarm erases a closed day's salt even when no request follows", async () => {
  at('2026-11-04T18:00:00Z');
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  await post(env, LITE, ping());
  at('2026-11-05T01:00:05Z');
  await receiver.object.alarm();
  expect(receiver.rows('SELECT count(*) AS n FROM lite_salts')).toEqual([
    { n: 0 },
  ]);
  expect(
    receiver.rows(
      'SELECT count(*) AS n FROM lite_pings WHERE client_hash IS NOT NULL',
    ),
  ).toEqual([{ n: 0 }]);
});

test('the alarm applies 90-day retention and keeps its own schedule', async () => {
  at('2026-08-01T10:00:00Z');
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  await post(env, LITE, ping());
  await post(env, LITE, {
    publisher: 'kontour',
    action: 'plugin-uninstalled',
    reason: 'other',
  });
  expect(receiver.storage.alarmAt()).toBe(Date.parse('2026-08-01T11:00:05Z'));

  // 2026-10-29 is the 90th UTC day counting 2026-08-01: still kept.
  at('2026-10-29T03:00:00Z');
  await post(env, LITE, ping());
  await receiver.object.alarm();
  expect(receiver.rows('SELECT count(*) AS n FROM lite_pings')).toEqual([
    { n: 2 },
  ]);

  at('2026-10-30T03:00:00Z');
  await receiver.object.alarm();
  expect(receiver.rows('SELECT day FROM lite_pings')).toEqual([
    { day: '2026-10-29' },
  ]);
  expect(receiver.rows('SELECT count(*) AS n FROM lite_feedback')).toEqual([
    { n: 0 },
  ]);
  expect(receiver.rows('SELECT rows FROM lite_capacity')).toEqual([
    { rows: 1 },
  ]);
  // Finalized history outlives raw retention; the finalization journal and
  // closed-day records follow the rows they journal.
  expect(
    receiver.rows(
      "SELECT count(*) AS n FROM lite_marginals WHERE day = '2026-08-01'",
    )[0].n,
  ).toBeGreaterThan(0);
  expect(receiver.rows('SELECT day FROM lite_finalized')).toEqual([
    { day: '2026-10-29' },
  ]);
  expect(receiver.storage.alarmAt()).toBe(Date.parse('2026-10-30T04:00:05Z'));
});

test('a closed week is published once over the fixed domain, and cursors are authenticated', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  // Monday 2026-10-26 starts the week.
  at('2026-10-26T09:00:00Z');
  await provision(env);
  await post(env, LITE, ping());
  at('2026-11-02T00:10:00Z');
  await receiver.object.alarm();
  const first = await call(env, '/v1/public/aggregates');
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
  const page = await first.json();
  expect(page.scope).toBe('weekly-fixed-domain-marginals');
  expect(page.cells).toHaveLength(200);
  const cells = [...page.cells];
  let cursor = page.nextCursor;
  while (cursor) {
    const next = await (
      await call(env, `/v1/public/aggregates?cursor=${cursor}`)
    ).json();
    cells.push(...next.cells);
    cursor = next.nextCursor;
  }
  // The last four closed weeks, each over every value of the fixed domain,
  // rare and zero values included.
  expect(new Set(cells.map((c) => c.week))).toEqual(
    new Set(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']),
  );
  const week = cells.filter((c) => c.week === '2026-10-26');
  expect(week.length * 4).toBe(cells.length);
  expect(
    week.some((c) => c.dimension === 'platform' && c.value === 'haiku'),
  ).toBe(true);
  expect(
    week.some((c) => c.dimension === 'version' && c.value === '1.2.3'),
  ).toBe(true);
  const published = receiver.rows(
    'SELECT * FROM lite_published ORDER BY dimension, value',
  );

  // A second pass never republishes, even when every input the published
  // week depends on changes: its exact counts and its publisher's catalog.
  receiver.storage.db
    .prepare(
      "UPDATE lite_marginals SET clients = clients + 1000, pings = pings + 1000 WHERE day >= '2026-10-26' AND day < '2026-11-02'",
    )
    .run();
  expect(
    (
      await post(
        env,
        '/v1/operator/lite/sources',
        {
          id: 'kontour-extra-v1',
          publisher: 'kontour',
          channels: ['stable'],
          registryIds: ['extra.plugin'],
          releaseVersions: ['9.9.9'],
        },
        { operator: true },
      )
    ).status,
  ).toBe(201);
  at('2026-11-02T05:00:00Z');
  await receiver.object.alarm();
  expect(
    receiver.rows('SELECT * FROM lite_published ORDER BY dimension, value'),
  ).toEqual(published);

  const forged = `${page.nextCursor.split('.')[0]}.${'A'.repeat(43)}`;
  const refused = await call(env, `/v1/public/aggregates?cursor=${forged}`);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: 'invalid_cursor' });
  expect(
    (await call(env, '/v1/public/aggregates?week=2026-10-26')).status,
  ).toBe(400);
});

test('operator routes refuse without the exact operator key', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  for (const path of [
    '/v1/operator/lite/daily',
    '/v1/operator/lite/insights',
    '/v1/operator/storage',
  ]) {
    expect((await call(env, path)).status).toBe(401);
    expect(
      (await call(env, path, { operator: `sto_${'x'.repeat(43)}` })).status,
    ).toBe(401);
    expect(
      (await call(env, path, { operator: `stq_${'o'.repeat(43)}` })).status,
    ).toBe(401);
  }
  const refused = await post(
    env,
    '/v1/operator/lite/sources',
    {},
    { operator: 'wrong' },
  );
  expect(await refused.json()).toEqual({ error: 'operator_unauthorized' });
  expect(receiver.state.requests).toBe(0);
  // Without the secret, operator routes stay dark; ingestion still works.
  const dark = testEnv(receiver, { OPERATOR_KEY: undefined });
  expect(
    (await call(dark, '/v1/operator/lite/daily', { operator: true })).status,
  ).toBe(503);
  expect(
    (
      await call(env, '/v1/operator/lite/daily?publisher=kontour', {
        operator: true,
      })
    ).status,
  ).toBe(400);
  expect(
    (await call(env, '/v1/operator/storage', { operator: true })).status,
  ).toBe(200);
});

test('the insights JSON counts real pings per day, including the open day', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  at('2026-10-30T10:00:00Z');
  await provision(env);
  await post(
    env,
    LITE,
    ping({ install_age_bucket: '0d', engines_used_today: ['claude', 'codex'] }),
  );
  await post(env, LITE, ping({ platform: 'darwin' }), { ip: '192.0.2.4' });
  at('2026-10-31T10:00:00Z');
  await receiver.object.alarm(); // finalizes 2026-10-30
  await post(env, LITE, ping({ first_active_this_week: false }));
  // 2026-10-31 is closed but not finalized when the dashboard reads it.
  at('2026-11-01T09:00:00Z');
  await post(env, LITE, ping({ install_age_bucket: '0d' }));
  await post(env, LITE, ping(), { ip: '192.0.2.5' });
  await post(env, LITE, ping(), { ip: '192.0.2.6' });

  const insights = await operator(env, '/v1/operator/lite/insights');
  expect(insights.today).toBe('2026-11-01');
  expect(insights.days[0]).toBe('2026-08-01');
  expect(insights.days.at(-1)).toBe('2026-11-01');
  expect(insights.provisionalDays).toEqual(['2026-10-31', '2026-11-01']);
  expect(insights.totals.slice(-3)).toEqual([2, 1, 3]);
  const last3 = (dimension: string, value: string) =>
    insights.dimensions[dimension][value].slice(-3);
  expect(last3('install_age_bucket', '0d')).toEqual([1, 0, 1]);
  expect(last3('platform', 'darwin')).toEqual([1, 0, 0]);
  expect(last3('engines_used_today', 'claude')).toEqual([1, 0, 0]);
  expect(last3('first_active_this_week', 'false')).toEqual([0, 1, 0]);
  expect(last3('engine_connect_failures', 'codex:2-3')).toEqual([2, 1, 3]);
  // Every non-envelope contract field is a dimension, so a field added to
  // STATION_DAILY_FIELDS appears here without receiver changes.
  const sent = Object.keys(ping()).filter(
    (field) => field !== 'event' && field !== 'event_id',
  );
  expect(Object.keys(insights.dimensions).sort()).toEqual(
    sent.filter((field) => field in STATION_DAILY_FIELDS).sort(),
  );
  expect((await call(env, '/v1/operator/lite/insights')).status).toBe(401);
});
