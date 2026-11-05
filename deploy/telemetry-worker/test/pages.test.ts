import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  call,
  fakeReceiver,
  LITE_PATH,
  OPERATOR_KEY,
  ping,
  post,
  provision,
  testEnv,
} from './helpers.ts';

const LITE = LITE_PATH;

// The served page scripts, run in a DOM against what the Worker actually
// answers for the same request.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

async function openPage(
  env: ReturnType<typeof testEnv>,
  path: string,
  script: string,
  key?: string,
) {
  const html = await (await call(env, path)).text();
  const js = await (await call(env, script)).text();
  const dom = new JSDOM(html, {
    url: 'https://telemetry.kontourai.io/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  if (key) window.localStorage.setItem('station-insights-operator-key', key);
  const requests: string[] = [];
  window.fetch = (async (input: string, init?: RequestInit) => {
    requests.push(String(input));
    const response = await call(env, String(input), {
      headers: init?.headers as Record<string, string>,
    });
    // jsdom has no Response; the pages read only these members.
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      json: async () => JSON.parse(body),
    };
  }) as unknown as typeof window.fetch;
  window.eval(js);
  // Settled once the status line is empty or final and nothing is in flight.
  const settled = () => {
    const status = window.document.getElementById('status')?.textContent ?? '';
    const unlock = window.document.getElementById('unlock');
    return (
      (status !== 'Loading…' && status !== '') ||
      window.document.querySelector('.card') !== null ||
      (unlock !== null && !unlock.hidden && requests.length === (key ? 1 : 0))
    );
  };
  // Only Date is faked, so timers still run. Keep the fixed date while the
  // page's requests reach the receiver: bound the wait by attempts, never by
  // the clock, or the receiver reads the real date.
  for (let attempt = 0; attempt < 500 && !settled(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { document: window.document, requests };
}

const titles = (document: Document) =>
  [...document.querySelectorAll('.card h2')].map((node) => node.textContent);

test('insights renders the operator JSON as headline numbers and charts', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3'])
    await post(env, LITE, ping({ install_age_bucket: '0d' }), { ip });
  const { document, requests } = await openPage(
    env,
    '/insights',
    '/insights/insights.js',
    OPERATOR_KEY,
  );
  expect(requests).toEqual(['/v1/operator/lite/insights']);
  const hero = document.querySelector('.tile.hero');
  expect(hero?.querySelector('.label')?.textContent).toBe(
    'Active installs today',
  );
  expect(hero?.querySelector('.value')?.textContent).toBe('3');
  expect(titles(document)).toEqual(
    expect.arrayContaining([
      'Daily active installs',
      'Weekly actives',
      'Monthly actives',
      'New installs per day',
      'Favorite harness',
      'Version adoption',
      'Surfaces used',
      'Platform',
    ]),
  );
  expect(
    document.querySelectorAll('svg.chart path.line').length,
  ).toBeGreaterThan(0);
  // No token field in the contract yet: no token panel.
  expect(titles(document)).not.toContain('Token throughput by engine');
});

test('a per-engine token dimension gets its own panel once pings carry it', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  // The parallel contract change adds engine_tokens_today; stand in for the
  // receiver's answer so the dashboard's detection is proven independently.
  const insights = receiver.object.fetch.bind(receiver.object);
  receiver.namespace.get = () => ({
    fetch: async (request: Request) => {
      const response = await insights(request);
      const data = await response.json();
      if (data.scope === 'operator-insights')
        data.dimensions.engine_tokens_today = {
          'codex:1M-10M': data.days.map(() => 2),
          'claude:10k-100k': data.days.map(() => 1),
        };
      return Response.json(data, { status: response.status });
    },
  });
  await provision(env);
  const { document } = await openPage(
    env,
    '/insights',
    '/insights/insights.js',
    OPERATOR_KEY,
  );
  expect(titles(document)).toContain('Token throughput by engine');
  const legend = [...document.querySelectorAll('.card')]
    .find(
      (card) =>
        card.querySelector('h2')?.textContent === 'Token throughput by engine',
    )
    ?.querySelector('.legend')?.textContent;
  expect(legend).toBe('10k-100k1M-10M');
});

test('insights asks for the key when none is stored, and forgets a refused one', async () => {
  const env = testEnv(fakeReceiver());
  const empty = await openPage(env, '/insights', '/insights/insights.js');
  expect(empty.document.getElementById('unlock')?.hidden).toBe(false);
  expect(empty.requests).toEqual([]);
  const refused = await openPage(
    env,
    '/insights',
    '/insights/insights.js',
    `sto_${'x'.repeat(43)}`,
  );
  expect(refused.document.getElementById('unlock-status')?.textContent).toBe(
    'That key was not accepted.',
  );
});

test('the public page charts the published weeks', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
  await provision(env);
  await post(env, LITE, ping());
  vi.setSystemTime(new Date('2026-11-02T00:10:00Z'));
  await receiver.object.alarm();
  const { document, requests } = await openPage(
    env,
    '/public/',
    '/public/dashboard.js',
  );
  expect(requests[0]).toBe('/v1/public/aggregates');
  expect(requests.length).toBeGreaterThan(1);
  expect(document.querySelector('.tile.hero .label')?.textContent).toBe(
    'Weekly active networks, week of Oct 26',
  );
  expect(titles(document)).toEqual(
    expect.arrayContaining([
      'Weekly active networks',
      'Harnesses used',
      'Platform',
      'Versions',
    ]),
  );
});

/** Stores one published week with chosen estimates, as the alarm would. */
function publish(
  receiver: ReturnType<typeof fakeReceiver>,
  cells: [string, string, number][],
  week = '2026-10-26',
) {
  const insert = receiver.storage.db.prepare(
    'INSERT INTO lite_published VALUES (?, ?, ?, ?, ?)',
  );
  receiver.storage.db
    .prepare('INSERT INTO lite_publications VALUES (?, ?)')
    .run(week, 'kontour');
  for (const [dimension, value, estimate] of cells)
    insert.run(week, 'kontour', dimension, value, estimate);
}

test('no bar, chart label or table cell shows a value within the noise', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  // The published bound: 95% of a cell's noise lies within ln(20)/epsilon.
  const { epsilonPerCount } = await (
    await call(env, '/v1/public/aggregates')
  ).json();
  const bound = Math.log(20) / epsilonPerCount;
  expect(bound).toBeGreaterThan(838);
  expect(bound).toBeLessThan(839);
  publish(receiver, [['first_active_this_week', 'true', 3000]], '2026-10-12');
  publish(receiver, [['first_active_this_week', 'true', 838]], '2026-10-19');
  publish(receiver, [
    ['first_active_this_week', 'true', 840],
    ['platform', 'darwin', 2400],
    ['platform', 'linux', 840],
    ['platform', 'cygwin', 589],
    ['platform', 'haiku', 300],
    ['platform', 'win32', 0],
    ['arch', 'mipsel', 700],
    ['engines_used_today', 'claude', 2900],
    ['engines_used_today', 'codex', 2000],
  ]);
  const { document } = await openPage(env, '/public/', '/public/dashboard.js');
  const numbers = (selector: string) =>
    [...document.querySelectorAll(selector)]
      .map((node) => node.textContent?.replace(/[^0-9]/g, '') ?? '')
      .filter(Boolean)
      .map(Number);
  // Bar values, the chart's labelled columns and every table cell.
  for (const value of [
    ...numbers('.bars .val'),
    ...numbers('svg.chart text.end'),
    ...numbers('details.table td:last-child'),
  ])
    expect(value).toBeGreaterThan(bound);
  const card = (title: string) =>
    [...document.querySelectorAll('.card')].find(
      (node) => node.querySelector('h2')?.textContent === title,
    );
  const platform = card('Platform');
  expect(
    [...(platform?.querySelectorAll('.bars .name') ?? [])].map(
      (n) => n.textContent,
    ),
  ).toEqual(['darwin', 'linux']);
  expect(platform?.textContent).toContain('3 other values within noise');
  const rows = [...(platform?.querySelectorAll('details.table tr') ?? [])].map(
    (row) => [...row.querySelectorAll('td')].map((td) => td.textContent),
  );
  expect(rows).toContainEqual(['cygwin', 'within noise']);
  expect(rows).toContainEqual(['darwin', '2,400']);
  // Architecture has nothing above the bound: no bars, only the fold line.
  const arch = card('Architecture');
  expect(arch?.querySelectorAll('.bars .name')).toHaveLength(0);
  expect(arch?.textContent).toContain('1 other value within noise');
  // The 10-19 week is a muted placeholder with no number.
  const trend = card('Weekly active networks');
  expect(trend?.querySelectorAll('svg.chart .col.noise')).toHaveLength(1);
  const weeks = [...(trend?.querySelectorAll('details.table tr') ?? [])].map(
    (row) => [...row.querySelectorAll('td')].map((td) => td.textContent),
  );
  expect(weeks).toContainEqual(['2026-10-19', 'within noise']);
  expect(weeks).toContainEqual(['2026-10-26', '840']);
  // A leader needs a gap wider than the single-cell bound: 900 is not enough
  // for two independent noisy cells; 1,560 is.
  const tiles = [...document.querySelectorAll('.tile .label')].map(
    (n) => n.textContent,
  );
  expect(tiles).not.toContain('Most used harness');
  expect(tiles).toContain('Top platform');
});

test('the public page never sums clipped cells and names a top value only above the noise', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  // Noise-level channel cells: each is clipped at zero, so their sum (1,450)
  // overstates activity. Harness leaders are within noise of each other;
  // the platform leader clears both the noise bound and the runner-up.
  publish(receiver, [
    ['channel', 'nightly', 50],
    ['channel', 'preview', 300],
    ['channel', 'stable', 280],
    ['channel', 'dev', 290],
    ['channel', 'source-checkout', 270],
    ['channel', 'unknown', 260],
    ['first_active_this_week', 'true', 120],
    ['first_active_this_week', 'false', 410],
    ['engines_used_today', 'claude', 2900],
    ['engines_used_today', 'codex', 2850],
    ['platform', 'darwin', 2400],
    ['platform', 'linux', 300],
  ]);
  const { document } = await openPage(env, '/public/', '/public/dashboard.js');
  const text = document.body.textContent ?? '';
  expect(text).not.toContain('1,450');
  const hero = document.querySelector('.tile.hero');
  expect(hero?.querySelector('.label')?.textContent).toBe(
    'Weekly active networks, week of Oct 26',
  );
  expect(hero?.querySelector('.value')?.textContent).toBe('Too few to show');
  const tiles = [...document.querySelectorAll('.tile')].map(
    (tile) => tile.querySelector('.label')?.textContent,
  );
  expect(tiles).not.toContain('Most used harness');
  const platform = [...document.querySelectorAll('.tile')].find(
    (tile) => tile.querySelector('.label')?.textContent === 'Top platform',
  );
  expect(platform?.querySelector('.value')?.textContent).toBe('darwin');
  expect(text).toContain(
    'Estimates with privacy noise added, not counts of people. Small values are unreliable.',
  );
});

test('a weekly-active estimate clear of the noise is the headline', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  publish(receiver, [
    ['first_active_this_week', 'true', 4210],
    ['channel', 'stable', 3900],
  ]);
  const { document } = await openPage(env, '/public/', '/public/dashboard.js');
  expect(document.querySelector('.tile.hero .value')?.textContent).toBe(
    '≈ 4,210',
  );
});

test('insights tiles and period charts count the right flags on seeded pings', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  vi.setSystemTime(new Date('2026-10-31T10:00:00Z'));
  await provision(env);
  // Today is Wednesday 2026-11-04: the ISO week began Monday 11-02, the
  // month on Sunday 11-01.
  const seed: [string, Record<string, unknown>][] = [
    [
      '2026-10-31T10:00:00Z',
      {
        first_active_this_week: true,
        first_active_this_month: true,
        install_age_bucket: '0d',
      },
    ],
    [
      '2026-11-01T10:00:00Z',
      {
        first_active_this_week: true,
        first_active_this_month: true,
        install_age_bucket: '0d',
      },
    ],
    [
      '2026-11-02T10:00:00Z',
      {
        first_active_this_week: true,
        first_active_this_month: false,
        install_age_bucket: '1-7d',
      },
    ],
    [
      '2026-11-02T11:00:00Z',
      {
        first_active_this_week: true,
        first_active_this_month: false,
        install_age_bucket: '8-30d',
      },
    ],
    [
      '2026-11-04T09:00:00Z',
      {
        first_active_this_week: false,
        first_active_this_month: false,
        install_age_bucket: '0d',
      },
    ],
  ];
  let host = 10;
  for (const [time, fields] of seed) {
    vi.setSystemTime(new Date(time));
    expect(
      (await post(env, LITE, ping(fields), { ip: `192.0.2.${host++}` })).status,
    ).toBe(202);
  }
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
  const { document } = await openPage(
    env,
    '/insights',
    '/insights/insights.js',
    OPERATOR_KEY,
  );
  const tile = (label: string) =>
    [...document.querySelectorAll('.tile')]
      .find((node) => node.querySelector('.label')?.textContent === label)
      ?.querySelector('.value')?.textContent;
  expect(tile('Active installs today')).toBe('1');
  expect(tile('Yesterday')).toBe('0');
  expect(tile('This week')).toBe('2');
  expect(tile('This month')).toBe('1');
  expect(tile('New installs')).toBe('3');
  expect(tile('Installs counted')).toBe('3');
  const endLabel = (title: string) =>
    [...document.querySelectorAll('.card')]
      .find((card) => card.querySelector('h2')?.textContent === title)
      ?.querySelector('svg text.end')?.textContent;
  expect(endLabel('Weekly actives')).toBe('2');
  expect(endLabel('Monthly actives')).toBe('1');
});
