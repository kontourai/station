import { expect, test } from 'vitest';
import { admitLiteObservation, ipFamily, networkKey } from '../lite-core.js';
import { dailyPing } from './lite-fixture.js';

// Both receivers dedupe a retry by comparing this canonical JSON, so engine
// entry order and each entry's key order must not change it.
test('reordered engine entries and entry keys admit as the same ping', () => {
  const source = {
    publisher: 'kontour' as const,
    channels: ['stable' as const],
    registryIds: ['public.plugin'],
    releaseVersions: [],
    versionPolicy: 'semver' as const,
  };
  const sent = {
    ...dailyPing(),
    engine_tokens_today: [
      { engine: 'codex', bucket: '100k-1M' },
      { engine: 'claude', bucket: '1-10k' },
    ],
    engine_connect_failures: [
      { engine: 'ollama', bucket: '1' },
      { engine: 'codex', bucket: '2-3' },
    ],
  };
  const reordered = {
    ...sent,
    engine_tokens_today: [
      { bucket: '1-10k', engine: 'claude' },
      { bucket: '100k-1M', engine: 'codex' },
    ],
    engine_connect_failures: [
      { bucket: '2-3', engine: 'codex' },
      { bucket: '1', engine: 'ollama' },
    ],
  };
  const a = admitLiteObservation(sent, source);
  const b = admitLiteObservation(reordered, source);
  if (a.kind !== 'daily' || b.kind !== 'daily') throw new Error('not daily');
  expect(b.json).toBe(a.json);
  expect(a.ping.engine_tokens_today).toEqual([
    { engine: 'claude', bucket: '1-10k' },
    { engine: 'codex', bucket: '100k-1M' },
  ]);
  // Literal key order, independent of the normalizer under test.
  expect(a.json).toContain(
    '"engine_tokens_today":[{"engine":"claude","bucket":"1-10k"},{"engine":"codex","bucket":"100k-1M"}]',
  );
});

// The Node receiver accepts socket peers with an IPv6 zone ID (link-local
// peers report one); they key by prefix like any IPv6 address.
test('IPv6 addresses with a zone ID key by prefix, not as unavailable', () => {
  expect(networkKey('fe80::1%eth0', 64)).toBe('fe80:0:0:0::/64');
  expect(networkKey('fe80::1%eth0', 48)).toBe('fe80:0:0::/48');
  expect(networkKey('fe80::1%eth0', 64)).toBe(networkKey('fe80::1', 64));
  expect(ipFamily('fe80::1%eth0')).toBe(6);
  for (const invalid of ['fe80::1%', '%eth0', '1.2.3.4%eth0', 'fe80::1%eth0%x'])
    expect(networkKey(invalid, 64)).toBe('unavailable');
});
