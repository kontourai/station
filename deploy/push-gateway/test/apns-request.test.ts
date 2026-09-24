import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildLiveActivityPayload,
  type LiveActivityRequest,
  livePriority,
  MAX_APNS_PAYLOAD_BYTES,
  parseChannelRequest,
  parseLiveActivityRequest,
  payloadBytes,
} from '../src/apns-request.ts';
import {
  CHANNEL_ID,
  encodeBody,
  IOS_BUNDLE,
  liveActivityBody,
  NOW,
  PUSH_TO_START_TOKEN,
  REGISTRATION_ID,
  SEALED,
} from './helpers.ts';

const parse = (value: unknown) =>
  parseLiveActivityRequest(encodeBody(value), [IOS_BUNDLE], NOW);

const request = (
  event: 'start' | 'update' | 'end',
  overrides: Record<string, unknown> = {},
): LiveActivityRequest => {
  const result = parse(liveActivityBody(overrides, event));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.request;
};

test('accepts each event with exactly its own fields', () => {
  assert.equal(request('start').pushToStartToken, PUSH_TO_START_TOKEN);
  assert.equal(request('update').staleAt, NOW + 7200);
  assert.equal(request('end').dismissAt, NOW + 900);
  // Upper-case hex is the same token; APNs paths use lower case.
  assert.equal(
    request('start', { pushToStartToken: PUSH_TO_START_TOKEN.toUpperCase() })
      .pushToStartToken,
    PUSH_TO_START_TOKEN,
  );
});

test('refuses every malformed or out-of-contract live-activity field', () => {
  const H8 = 8 * 60 * 60;
  const H4 = 4 * 60 * 60;
  const cases: Array<[unknown, string]> = [
    ['[]', 'body must be an object'],
    [liveActivityBody({ event: 'dismiss' }), 'unsupported event'],
    [liveActivityBody({ sk: 'forged' }), 'sk is stamped by the gateway'],
    [liveActivityBody({ extra: 1 }), 'unknown key extra'],
    [liveActivityBody({ aps: {} }), 'unknown key aps'],
    [
      liveActivityBody({ pushToStartToken: PUSH_TO_START_TOKEN }, 'update'),
      'unknown key pushToStartToken',
    ],
    [
      liveActivityBody({ dismissAt: NOW + 60 }, 'start'),
      'unknown key dismissAt',
    ],
    [liveActivityBody({ staleAt: NOW + 60 }, 'end'), 'unknown key staleAt'],
    [
      liveActivityBody({ pushToStartToken: undefined }),
      'missing pushToStartToken',
    ],
    [liveActivityBody({ channelId: undefined }), 'missing channelId'],
    [liveActivityBody({ staleAt: undefined }, 'update'), 'missing staleAt'],
    [liveActivityBody({ dismissAt: undefined }, 'end'), 'missing dismissAt'],
    [
      liveActivityBody({ bundleId: 'com.example.other' }),
      'bundle is not a Station app',
    ],
    [liveActivityBody({ environment: 'development' }), 'invalid environment'],
    [
      liveActivityBody({ pushToStartToken: 'ab'.repeat(31) }),
      'invalid pushToStartToken',
    ],
    [
      liveActivityBody({ pushToStartToken: 'ab'.repeat(101) }),
      'invalid pushToStartToken',
    ],
    [
      liveActivityBody({ pushToStartToken: `${'ab'.repeat(40)}a` }),
      'invalid pushToStartToken',
    ],
    [
      liveActivityBody({ pushToStartToken: 'zz'.repeat(40) }),
      'invalid pushToStartToken',
    ],
    [liveActivityBody({ channelId: 'abc\r\nx-evil: 1' }), 'invalid channelId'],
    [liveActivityBody({ channelId: 'x'.repeat(129) }), 'invalid channelId'],
    [liveActivityBody({ registrationId: 'short' }), 'invalid registrationId'],
    [
      liveActivityBody({ registrationId: `${'r'.repeat(21)}/` }),
      'invalid registrationId',
    ],
    [liveActivityBody({ sealed: 'S'.repeat(37) }), 'invalid sealed'],
    [liveActivityBody({ sealed: 'S'.repeat(3401) }), 'invalid sealed'],
    [liveActivityBody({ sealed: `${'S'.repeat(40)}=` }), 'invalid sealed'],
    [liveActivityBody({ alert: 'yes' }), 'alert must be a boolean'],
    [liveActivityBody({ timestamp: NOW - 121 }), 'timestamp out of range'],
    [liveActivityBody({ timestamp: NOW + 121 }), 'timestamp out of range'],
    [liveActivityBody({ timestamp: NOW + 0.5 }), 'timestamp out of range'],
    [liveActivityBody({ staleAt: NOW - 120 }), 'staleAt out of range'],
    [liveActivityBody({ staleAt: NOW + H8 + 121 }), 'staleAt out of range'],
    [
      liveActivityBody({ staleAt: NOW + H8 + 121 }, 'update'),
      'staleAt out of range',
    ],
    [
      liveActivityBody({ dismissAt: NOW - 121 }, 'end'),
      'dismissAt out of range',
    ],
    [
      liveActivityBody({ dismissAt: NOW + H4 + 121 }, 'end'),
      'dismissAt out of range',
    ],
  ];
  for (const [value, reason] of cases) {
    const result =
      typeof value === 'string'
        ? parseLiveActivityRequest(
            new TextEncoder().encode(value),
            [IOS_BUNDLE],
            NOW,
          )
        : parse(value);
    assert.deepEqual(result, { ok: false, reason }, JSON.stringify(value));
  }
  assert.deepEqual(
    parseLiveActivityRequest(new TextEncoder().encode('{'), [IOS_BUNDLE], NOW),
    { ok: false, reason: 'body is not JSON' },
  );
});

test('accepts the edges of each time window', () => {
  assert.ok(parse(liveActivityBody({ timestamp: NOW - 120 })).ok);
  assert.ok(parse(liveActivityBody({ staleAt: NOW + 8 * 3600 })).ok);
  assert.ok(parse(liveActivityBody({ dismissAt: NOW }, 'end')).ok);
  assert.ok(parse(liveActivityBody({ dismissAt: NOW + 4 * 3600 }, 'end')).ok);
});

test('parses channel create and delete strictly', () => {
  const channel = (value: unknown) =>
    parseChannelRequest(encodeBody(value), [IOS_BUNDLE]);
  const base = { bundleId: IOS_BUNDLE, environment: 'production' };
  assert.deepEqual(channel({ op: 'create', ...base }), {
    ok: true,
    request: { op: 'create', ...base },
  });
  assert.deepEqual(channel({ op: 'delete', ...base, channelId: CHANNEL_ID }), {
    ok: true,
    request: { op: 'delete', ...base, channelId: CHANNEL_ID },
  });
  const cases: Array<[unknown, string]> = [
    [{ op: 'list', ...base }, 'unsupported op'],
    [{ op: 'create', ...base, channelId: CHANNEL_ID }, 'unknown key channelId'],
    [{ op: 'create', ...base, sk: 'x' }, 'sk is stamped by the gateway'],
    [{ op: 'delete', ...base }, 'missing channelId'],
    [{ op: 'delete', ...base, channelId: 'a b' }, 'invalid channelId'],
    [
      { op: 'create', ...base, bundleId: 'io.other' },
      'bundle is not a Station app',
    ],
    [{ op: 'create', ...base, environment: 'prod' }, 'invalid environment'],
    [{ op: 'create', bundleId: IOS_BUNDLE }, 'missing environment'],
  ];
  for (const [value, reason] of cases) {
    assert.deepEqual(
      channel(value),
      { ok: false, reason },
      JSON.stringify(value),
    );
  }
});

test('builds a start payload from fixed vocabulary and stamps the key', () => {
  const payload = buildLiveActivityPayload(request('start'), 'THUMBPRINT');
  assert.deepEqual(payload, {
    aps: {
      timestamp: NOW,
      event: 'start',
      'content-state': {
        v: 1,
        rid: REGISTRATION_ID,
        sk: 'THUMBPRINT',
        sealed: SEALED,
      },
      'attributes-type': 'StationAgentActivityAttributes',
      attributes: { rid: REGISTRATION_ID },
      'input-push-channel': CHANNEL_ID,
      'stale-date': NOW + 7200,
      alert: { title: 'Station', body: 'Agent activity' },
    },
  });
  assert.deepEqual(
    buildLiveActivityPayload(request('start', { alert: true }), 'K').aps.alert,
    { title: 'Station', body: 'Agent activity', sound: 'default' },
  );
});

test('builds update and end payloads, alerting only when asked', () => {
  const quiet = buildLiveActivityPayload(request('update'), 'K').aps;
  assert.deepEqual(Object.keys(quiet).sort(), [
    'content-state',
    'event',
    'stale-date',
    'timestamp',
  ]);
  const loud = buildLiveActivityPayload(
    request('update', { alert: true }),
    'K',
  );
  assert.deepEqual(loud.aps.alert, {
    title: 'Station',
    body: 'Agent activity',
    sound: 'default',
  });
  const end = buildLiveActivityPayload(request('end'), 'K').aps;
  assert.equal(end['dismissal-date'], NOW + 900);
  assert.equal(end['stale-date'], undefined);
  assert.equal(end.alert, undefined);
  assert.deepEqual(end['content-state'], {
    v: 1,
    rid: REGISTRATION_ID,
    sk: 'K',
    sealed: SEALED,
  });
});

test('derives priority from the event, never from the caller', () => {
  assert.equal(livePriority(request('start')), 10);
  assert.equal(livePriority(request('end')), 10);
  assert.equal(livePriority(request('update')), 5);
  assert.equal(livePriority(request('update', { alert: true })), 10);
});

test('caps the final APNs body at 4096 bytes', () => {
  const largest = buildLiveActivityPayload(
    request('start', {
      alert: true,
      sealed: 'S'.repeat(3400),
      pushToStartToken: 'ab'.repeat(100),
      registrationId: 'r'.repeat(64),
      channelId: 'A'.repeat(128),
    }),
    'k'.repeat(43),
  );
  assert.ok(payloadBytes(largest), 'the largest valid request fits');
  const over = { aps: { pad: 'x'.repeat(MAX_APNS_PAYLOAD_BYTES) } };
  assert.equal(payloadBytes(over), null);
  const exact = { a: 'x'.repeat(MAX_APNS_PAYLOAD_BYTES - 8) };
  assert.equal(payloadBytes(exact)?.length, MAX_APNS_PAYLOAD_BYTES);
});
