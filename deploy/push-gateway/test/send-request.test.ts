import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseSendRequest } from '../src/send-request.ts';
import { PACKAGE, sendBody } from './helpers.ts';

const parse = (overrides: Record<string, unknown> = {}) =>
  parseSendRequest(sendBody(overrides), [PACKAGE]);
const data = (extra: Record<string, unknown>) => ({
  station_kind: 'agent_activity',
  ...extra,
});

test('accepts an agent-activity message for a Station package', () => {
  const result = parse({ collapseKey: 'agent_activity' });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.request.collapseKey, 'agent_activity');
});

test('accepts a sealed Station notification, at high or normal priority', () => {
  const notification = {
    data: {
      station_kind: 'station_notification',
      device_id: 'reg-1',
      sealed: 'AAECAwQFBgcICQoL',
    },
    collapseKey: `n${'0'.repeat(40)}`,
  };
  const high = parse(notification);
  assert.equal(high.ok, true);
  assert.equal(
    high.ok && high.request.data.station_kind,
    'station_notification',
  );
  assert.equal(high.ok && high.request.priority, undefined);
  const normal = parse({ ...notification, priority: 'normal' });
  assert.equal(normal.ok && normal.request.priority, 'normal');
});

test('refuses an unknown station_kind and a priority it does not know', () => {
  assert.deepEqual(parse({ data: { station_kind: 'station_notifications' } }), {
    ok: false,
    reason: 'unsupported station_kind',
  });
  assert.deepEqual(parse({ data: { station_kind: 'Station_Notification' } }), {
    ok: false,
    reason: 'unsupported station_kind',
  });
  assert.deepEqual(parse({ priority: 'urgent' }), {
    ok: false,
    reason: 'invalid priority',
  });
  // The card must reach a dozing phone inside its freshness window.
  assert.deepEqual(parse({ priority: 'normal' }), {
    ok: false,
    reason: 'invalid priority',
  });
});

test('refuses anything that is not a Station agent-activity data message', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ packageName: 'com.example.other' }, 'package is not a Station app'],
    [{ data: { device_id: 'x' } }, 'unsupported station_kind'],
    [{ data: { station_kind: 'marketing' } }, 'unsupported station_kind'],
    [{ data: data({ active: true }) }, 'data values must be strings'],
    [{ data: data({ 'Bad-Key': 'x' }) }, 'invalid data key Bad-Key'],
    [
      { data: data({ google_sent_time: 'x' }) },
      'invalid data key google_sent_time',
    ],
    [{ data: data({ big: 'x'.repeat(3800) }) }, 'data too large'],
    [{ data: [] }, 'data must be an object'],
    [{ token: 'short' }, 'invalid token'],
    [{ token: `${'f'.repeat(100)} x` }, 'invalid token'],
    [{ collapseKey: 'Has Spaces' }, 'invalid collapseKey'],
    [{ data: data({ notification: 'x' }) }, 'invalid data key notification'],
    [{ data: data({ station_key: 'forged' }) }, 'invalid data key station_key'],
  ];
  for (const [overrides, reason] of cases) {
    assert.deepEqual(parse(overrides), { ok: false, reason }, reason);
  }
});

test('refuses a body that is not a JSON object', () => {
  assert.deepEqual(
    parseSendRequest(new TextEncoder().encode('[1]'), [PACKAGE]),
    {
      ok: false,
      reason: 'body must be an object',
    },
  );
  assert.deepEqual(parseSendRequest(new TextEncoder().encode('{'), [PACKAGE]), {
    ok: false,
    reason: 'body is not JSON',
  });
});
