import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  call,
  countingLimiter,
  fakeReceiver,
  ping,
  post,
  provision,
  testEnv,
} from './helpers.ts';

// The Worker and the real LiteReceiver object over node:sqlite, reached
// through the same namespace binding and fetch protocol as on Cloudflare.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const LITE = '/v1/lite/kontour-nightly-v1';

test('a daily ping is accepted once, replays answer the same, and a changed payload conflicts', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  const sent = ping({
    surfaces_today: ['web', 'cli'],
    engines_used_today: ['codex', 'claude'],
  });
  const first = await post(env, LITE, sent);
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ accepted: true });

  // Object order, set order and UUID letter case are the same ping.
  const reordered = Object.fromEntries(
    Object.entries({
      ...sent,
      event_id: sent.event_id.toUpperCase(),
      surfaces_today: [...sent.surfaces_today].reverse(),
      engines_used_today: [...sent.engines_used_today].reverse(),
    }).reverse(),
  );
  const replay = await post(env, LITE, reordered);
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual({ accepted: true });
  expect(receiver.rows('SELECT count(*) AS n FROM lite_pings')).toEqual([
    { n: 1 },
  ]);

  const changed = await post(env, LITE, { ...sent, platform: 'darwin' });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ error: 'event_conflict' });
  expect(receiver.rows('SELECT rows FROM lite_capacity')).toEqual([
    { rows: 1 },
  ]);
});

test('refusals: channel mismatch, invalid fields, unknown and revoked sources', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);

  const stable = await post(env, LITE, ping({ channel: 'stable' }));
  expect(stable.status).toBe(400);
  expect(await stable.json()).toEqual({ error: 'invalid_daily_ping' });
  const extra = await post(env, LITE, { ...ping(), secret: 'x' });
  expect(await extra.json()).toEqual({ error: 'invalid_daily_ping' });
  expect((await post(env, LITE, 'not json')).status).toBe(400);

  const unknown = await post(env, '/v1/lite/kontour-unknown-v1', ping());
  expect(unknown.status).toBe(401);
  expect(await unknown.json()).toEqual({ error: 'source_unauthorized' });

  const revoke = await call(
    env,
    '/v1/operator/lite/sources/kontour-nightly-v1',
    {
      method: 'DELETE',
      operator: true,
    },
  );
  expect(await revoke.json()).toEqual({ revoked: true });
  expect((await post(env, LITE, ping())).status).toBe(401);
  expect(receiver.rows('SELECT count(*) AS n FROM lite_pings')).toEqual([
    { n: 0 },
  ]);
});

test('bodies over 16 KiB are refused before the receiver is asked', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  const before = receiver.state.requests;
  const big = JSON.stringify({ ...ping(), pad: 'x'.repeat(16384) });
  const declared = await post(env, LITE, big);
  expect(declared.status).toBe(413);
  expect(await declared.json()).toEqual({ error: 'body_too_large' });
  // Streamed without a length: refused as soon as the bytes pass the cap.
  const bytes = new TextEncoder().encode(big);
  const streamed = await call(env, LITE, {
    method: 'POST',
    body: new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 4096)
          controller.enqueue(bytes.slice(i, i + 4096));
        controller.close();
      },
    }),
    // @ts-expect-error Node's fetch needs this for a streamed request body.
    duplex: 'half',
  });
  expect(streamed.status).toBe(413);
  expect(receiver.state.requests).toBe(before);
  // Exactly at the cap is still read and judged on its content.
  const fits = await post(env, LITE, `${' '.repeat(16384 - 2)}{}`);
  expect(fits.status).toBe(400);
});

test('feedback is deduplicated per publisher, action, day and network', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  const feedback = {
    publisher: 'kontour',
    action: 'tier-lowered',
    reason: 'privacy',
  };
  expect((await post(env, LITE, feedback)).status).toBe(202);
  const changed = await post(env, LITE, { ...feedback, reason: 'other' });
  expect(changed.status).toBe(202);
  expect(await changed.json()).toEqual({ accepted: true });
  expect((await post(env, LITE, feedback, { ip: '198.51.100.9' })).status).toBe(
    202,
  );
  expect(
    receiver.rows('SELECT reason FROM lite_feedback ORDER BY rowid'),
  ).toEqual([{ reason: 'privacy' }, { reason: 'privacy' }]);
  const wrongPublisher = await post(env, LITE, {
    ...feedback,
    publisher: 'operator',
  });
  expect(wrongPublisher.status).toBe(400);
});

test('the per-network edge limit refuses before the shared budget or the receiver', async () => {
  const receiver = fakeReceiver();
  const perIp = countingLimiter(1);
  const global = countingLimiter();
  const env = testEnv(receiver, {
    LITE_PER_IP_LIMITER: perIp,
    LITE_GLOBAL_LIMITER: global,
  });
  await provision(env);
  const before = receiver.state.requests;
  expect(
    (await post(env, LITE, ping(), { ip: '2001:db8:1:2:aaaa::1' })).status,
  ).toBe(202);
  const refused = await post(env, LITE, ping(), { ip: '2001:db8:1:2:bbbb::2' });
  expect(refused.status).toBe(429);
  expect(refused.headers.get('retry-after')).toBe('60');
  expect(await refused.json()).toEqual({ error: 'receiver_rate_limit' });
  // One /64 is one key; the refused request spent neither the global
  // budget nor a receiver request.
  expect(perIp.keys).toEqual(['2001:db8:1:2::/64', '2001:db8:1:2::/64']);
  expect(global.keys).toHaveLength(1);
  expect(receiver.state.requests).toBe(before + 1);
});

test('the global edge limit refuses too', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver, { LITE_GLOBAL_LIMITER: countingLimiter(0) });
  await provision(env);
  expect((await post(env, LITE, ping())).status).toBe(429);
  expect(receiver.rows('SELECT count(*) AS n FROM lite_pings')).toEqual([
    { n: 0 },
  ]);
});

test('each network gets 60 receiver attempts per UTC day', async () => {
  const receiver = fakeReceiver();
  const env = testEnv(receiver);
  await provision(env);
  for (let i = 0; i < 60; i++)
    expect(
      (await post(env, LITE, ping(), { ip: '2001:db8:9:9::1' })).status,
    ).toBe(202);
  const refused = await post(env, LITE, ping(), { ip: '2001:db8:9:9::2' });
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual({ error: 'lite_rate_limit' });
  expect(refused.headers.get('retry-after')).toBe('86400');
  // An adjacent /64 is independent; the next UTC day starts a new budget.
  expect(
    (await post(env, LITE, ping(), { ip: '2001:db8:9:a::1' })).status,
  ).toBe(202);
  vi.setSystemTime(new Date('2026-11-05T00:00:01Z'));
  expect(
    (await post(env, LITE, ping(), { ip: '2001:db8:9:9::1' })).status,
  ).toBe(202);
});

test('storage ceilings refuse with 507', async () => {
  const receiver = fakeReceiver({ LITE_MAX_ROWS: '1' });
  const env = testEnv(receiver);
  await provision(env);
  expect((await post(env, LITE, ping())).status).toBe(202);
  const full = await post(env, LITE, ping());
  expect(full.status).toBe(507);
  expect(await full.json()).toEqual({ error: 'storage_limit' });
});

test('only the documented routes answer', async () => {
  const env = testEnv(fakeReceiver());
  expect((await call(env, '/health/live')).status).toBe(200);
  for (const [method, path] of [
    ['GET', LITE],
    ['POST', '/v1/product/events'],
    ['GET', '/v1/publishers/kontour/aggregates'],
    ['GET', '/'],
    ['POST', '/v1/public/aggregates'],
  ])
    expect((await call(env, path, { method })).status).toBe(404);
  const page = await call(env, '/public/');
  expect(page.headers.get('content-security-policy')).toContain(
    "script-src 'self'",
  );
});
