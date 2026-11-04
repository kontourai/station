import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  call,
  fakeReceiver,
  OPERATOR_KEY,
  ping,
  post,
  provision,
  testEnv,
} from './helpers.ts';

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
    url: 'https://telemetry.kontourai.com/',
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
  const deadline = Date.now() + 5000;
  vi.useRealTimers();
  while (!settled() && Date.now() < deadline)
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
    await post(
      env,
      '/v1/lite/kontour-nightly-v1',
      ping({ install_age_bucket: '0d' }),
      { ip },
    );
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
  await post(env, '/v1/lite/kontour-nightly-v1', ping());
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
    'Network-days, week of Oct 26',
  );
  expect(titles(document)).toEqual(
    expect.arrayContaining([
      'Weekly network-days',
      'Harnesses used',
      'Platform',
      'Versions',
    ]),
  );
});
