import assert from 'node:assert/strict';
import { test } from 'node:test';
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
