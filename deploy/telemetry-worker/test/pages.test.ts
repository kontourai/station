import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  ACCESS_AUDIENCE,
  ACCESS_TEAM,
  accessFixture,
} from './access-fixture.ts';
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
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openPage(
  env: ReturnType<typeof testEnv>,
  path: string,
  script: string,
  key?: string,
  storageDenied = false,
) {
  const html = await (await call(env, path)).text();
  const js = await (await call(env, script)).text();
  const dom = new JSDOM(html, {
    url: 'https://telemetry.kontourai.io/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  if (key) window.localStorage.setItem('station-insights-operator-key', key);
  const fixture = await accessFixture();
  env.ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
  env.ACCESS_AUDIENCE = ACCESS_AUDIENCE;
  vi.stubGlobal('fetch', async () => Response.json(fixture.jwks));
  const requests: string[] = [];
  window.fetch = (async (input: string, init?: RequestInit) => {
    requests.push(String(input));
    const response = await call(env, String(input), {
      headers:
        key === OPERATOR_KEY && init?.credentials === 'same-origin'
          ? { 'cf-access-jwt-assertion': fixture.token }
          : (init?.headers as Record<string, string>),
    });
    // jsdom has no Response; the pages read only these members.
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      json: async () => JSON.parse(body),
    };
  }) as unknown as typeof window.fetch;
  if (storageDenied)
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new window.DOMException('Storage disabled', 'SecurityError');
      },
    });
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
  expect(requests).toEqual(['/insights/data']);
  const hero = document.querySelector('.tile.hero');
  expect(hero?.querySelector('.label')?.textContent).toBe(
    'Reports received today',
  );
  expect(hero?.querySelector('.value')?.textContent).toBe('3');
  expect(titles(document)).toEqual(
    expect.arrayContaining([
      'Daily usage reports',
      'First activity by week',
      'First activity by month',
      'New-install reports per day',
      'Reported harnesses',
      'Version adoption',
      'Surfaces used',
      'Platform',
    ]),
  );
  expect(
    document.querySelectorAll('svg.chart path.line').length,
  ).toBeGreaterThan(0);
  // These seeded pings carry no token field, so there is no token panel.
  expect(titles(document)).not.toContain('Token throughput by engine');
});

test('a per-engine token dimension gets its own panel once pings carry it', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  // Stand in for the receiver's answer so the dashboard's detection of the
  // engine_tokens_today dimension is proven independently of ingest.
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

test('insights uses the browser session and explains an expired sign-in without asking for a key', async () => {
  const env = testEnv(fakeReceiver());
  const refused = await openPage(env, '/insights', '/insights/insights.js');
  expect(refused.requests).toEqual(['/insights/data']);
  expect(refused.document.getElementById('status')?.textContent).toContain(
    'sign-in has expired',
  );
  expect(refused.document.querySelector('input[type="password"]')).toBeNull();
});

test('signed-in insights still load when browser storage is disabled', async () => {
  const env = testEnv(fakeReceiver());
  const page = await openPage(
    env,
    '/insights',
    '/insights/insights.js',
    OPERATOR_KEY,
    true,
  );
  expect(page.requests).toEqual(['/insights/data']);
  expect(page.document.querySelector('.tile.hero .value')?.textContent).toBe(
    '0',
  );
  expect(page.document.getElementById('status')?.textContent).toContain(
    'No usage reports',
  );
});

test('the public page explains an uncertain release without filling the page with empty charts', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  vi.setSystemTime(new Date('2026-10-26T09:00:00Z'));
  await provision(env);
  await post(env, LITE, ping());
  vi.setSystemTime(new Date('2026-11-02T00:10:00Z'));
  await receiver.object.alarm();
  receiver.storage.db.exec('UPDATE lite_published SET estimate = 0');
  const { document, requests } = await openPage(
    env,
    '/public/',
    '/public/dashboard.js',
  );
  expect(requests[0]).toBe('/v1/public/aggregates');
  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(titles(document)).toEqual(['No reliable public estimates yet']);
  expect(document.body.textContent).toContain(
    'does not mean there was no activity',
  );
  expect(document.getElementById('publication')?.textContent).toContain(
    '2026-11-01',
  );
  expect(document.querySelector('svg.chart')).toBeNull();
  expect(document.querySelector('.tile')).toBeNull();
  expect(document.querySelector('a[href="/insights"]')).not.toBeNull();
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

/** The per-card Bonferroni threshold the page applies (the README states it). */
async function thresholds(env: ReturnType<typeof testEnv>) {
  const { epsilonPerCount: epsilon } = await (
    await call(env, '/v1/public/aggregates')
  ).json();
  const alpha = Math.exp(-epsilon);
  return (m: number) => Math.log(m / (0.05 * (1 + alpha))) / epsilon;
}

test("no bar, chart label or table cell shows a value within its card's noise threshold", async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  const threshold = await thresholds(env);
  // Between the per-cell 95% bound (about 839) and the card thresholds.
  expect(threshold(4)).toBeGreaterThan(1000);
  expect(threshold(5)).toBeGreaterThan(1000);
  publish(receiver, [['first_active_this_week', 'true', 900]], '2026-10-05');
  publish(receiver, [['first_active_this_week', 'true', 3000]], '2026-10-12');
  publish(receiver, [['first_active_this_week', 'true', 838]], '2026-10-19');
  publish(receiver, [
    ['first_active_this_week', 'true', 2000],
    ['platform', 'darwin', 2400],
    ['platform', 'linux', 840],
    ['platform', 'cygwin', 589],
    ['platform', 'haiku', 300],
    ['platform', 'win32', 0],
    // One candidate cell: its threshold is about 645.
    ['arch', 'mipsel', 600],
    ['engines_used_today', 'claude', 2900],
    ['engines_used_today', 'codex', 2000],
  ]);
  const { document } = await openPage(env, '/public/', '/public/dashboard.js');
  const card = (title: string) =>
    [...document.querySelectorAll('.card')].find(
      (node) => node.querySelector('h2')?.textContent === title,
    );
  const numbers = (root: Element | undefined, selector: string) =>
    [...(root?.querySelectorAll(selector) ?? [])]
      .map((node) => node.textContent?.replace(/[^0-9]/g, '') ?? '')
      .filter(Boolean)
      .map(Number);
  // Every number in a card clears that card's threshold: m is its number of
  // candidate cells (weeks for the chart).
  for (const [title, m] of [
    ['Weekly active networks', 4],
    ['Platform', 5],
    ['Architecture', 1],
    ['Harnesses used', 2],
  ] as const)
    for (const value of [
      ...numbers(card(title), '.bars .val'),
      ...numbers(card(title), 'svg.chart text.end'),
      ...numbers(card(title), 'details.table td:last-child'),
    ])
      expect(value, title).toBeGreaterThan(threshold(m));
  const platform = card('Platform');
  expect(
    [...(platform?.querySelectorAll('.bars .name') ?? [])].map(
      (n) => n.textContent,
    ),
  ).toEqual(['darwin']);
  expect(platform?.textContent).toContain('4 other values within noise');
  const rows = (root: Element | undefined) =>
    [...(root?.querySelectorAll('details.table tr') ?? [])].map((row) =>
      [...row.querySelectorAll('td')].map((td) => td.textContent),
    );
  // 840 clears the single-cell bound but not this card's.
  expect(rows(platform)).toContainEqual(['linux', 'within noise']);
  expect(rows(platform)).toContainEqual(['darwin', '2,400']);
  const arch = card('Architecture');
  expect(arch?.querySelectorAll('.bars .name')).toHaveLength(0);
  expect(arch?.textContent).toContain('1 other value within noise');
  const trend = card('Weekly active networks');
  expect(trend?.querySelectorAll('svg.chart .col.noise')).toHaveLength(2);
  expect(rows(trend)).toEqual(
    expect.arrayContaining([
      ['2026-10-05', 'within noise'],
      ['2026-10-12', '3,000'],
      ['2026-10-19', 'within noise'],
      ['2026-10-26', '2,000'],
    ]),
  );
  // A leader needs a gap wider than the single-cell bound: 900 is not enough
  // for two independent noisy cells; 2,400 clear of the rest is.
  const tiles = [...document.querySelectorAll('.tile .label')].map(
    (n) => n.textContent,
  );
  expect(tiles).not.toContain('Most used harness');
  expect(tiles).toContain('Top platform');
  expect(document.body.textContent).toContain(
    'Small estimates cannot be reliably separated from the added noise.',
  );
});

test("the headline's previous-week note appears only when that week clears the noise", async () => {
  const quiet = fakeReceiver();
  publish(quiet, [['first_active_this_week', 'true', 500]], '2026-10-19');
  publish(quiet, [['first_active_this_week', 'true', 2500]]);
  const below = await openPage(
    testEnv(quiet),
    '/public/',
    '/public/dashboard.js',
  );
  expect(below.document.querySelector('.tile.hero .value')?.textContent).toBe(
    '≈ 2,500',
  );
  expect(below.document.querySelector('.tile.hero .note')).toBeNull();

  const clear = fakeReceiver();
  publish(clear, [['first_active_this_week', 'true', 3000]], '2026-10-19');
  publish(clear, [['first_active_this_week', 'true', 2500]]);
  const above = await openPage(
    testEnv(clear),
    '/public/',
    '/public/dashboard.js',
  );
  expect(above.document.querySelector('.tile.hero .note')?.textContent).toBe(
    'Previous week ≈ 3,000',
  );
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
  // The only week is within noise: placeholders, no scale and no numbers.
  const trendText = [...document.querySelectorAll('.card')]
    .find(
      (card) =>
        card.querySelector('h2')?.textContent === 'Weekly active networks',
    )
    ?.querySelector('svg.chart')?.textContent;
  // Only the week's date label and the note: no tick values.
  expect(trendText).toBe('Oct 26Every period is within noise');
  const tiles = [...document.querySelectorAll('.tile')].map(
    (tile) => tile.querySelector('.label')?.textContent,
  );
  expect(tiles).not.toContain('Most used harness');
  const platform = [...document.querySelectorAll('.tile')].find(
    (tile) => tile.querySelector('.label')?.textContent === 'Top platform',
  );
  expect(platform?.querySelector('.value')?.textContent).toBe('darwin');
  expect(text).toContain(
    'Estimates with privacy noise added, not counts of people.',
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
  expect(tile('Reports in window')).toBe('5');
  expect(tile('Reports received today')).toBe('1');
  expect(tile('Yesterday')).toBe('0');
  expect(tile('First activity this week')).toBe('2');
  expect(tile('First activity this month')).toBe('1');
  expect(tile('New-install reports')).toBe('3');
  expect(tile('New-install reports in window')).toBe('3');
  const endLabel = (title: string) =>
    [...document.querySelectorAll('.card')]
      .find((card) => card.querySelector('h2')?.textContent === title)
      ?.querySelector('svg text.end')?.textContent;
  expect(endLabel('First activity by week')).toBe('2');
  expect(endLabel('First activity by month')).toBe('1');
});
