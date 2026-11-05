import { pluginTelemetryPublisherId } from '@kontourai/station-shared/plugin-telemetry';
import { parseTelemetryFeedback } from '@kontourai/station-shared/product-telemetry';
import { expect, test } from 'vitest';
import {
  admitLiteObservation,
  ipFamily,
  networkKey,
  parseLiteSource,
} from '../lite-core.js';
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

// Source provisioning and feedback cross separate validators in the receiver.
test.each([
  ['publisher:writer', true],
  [pluginTelemetryPublisherId(`sha256:${'a'.repeat(64)}`, 'writer'), true],
  [
    pluginTelemetryPublisherId(`sha256:${'a'.repeat(64)}`, 'w'.repeat(128)),
    true,
  ],
  [
    pluginTelemetryPublisherId(`sha256:${'a'.repeat(64)}`, 'Writer_1.2:beta-3'),
    true,
  ],
  ['publisher:constructor', false],
  ['publisher:prototype', false],
  ['publisher:__proto__', false],
  [`publisher:${'a'.repeat(24)}/constructor`, false],
  [`publisher:${'a'.repeat(24)}/prototype`, false],
  [`publisher:${'A'.repeat(24)}/writer`, false],
  [`publisher:${'g'.repeat(24)}/writer`, false],
  [`publisher:${'a'.repeat(24)}/${'w'.repeat(129)}`, false],
  [`publisher:${'a'.repeat(24)}/writer/extra`, false],
  ['publisher:@scope/plugin', false],
] as const)(
  'source and feedback admission for %s is %s',
  (publisher, accepted) => {
    const input = {
      id: 'public-source',
      publisher,
      channels: ['stable'],
      registryIds: [],
      releaseVersions: [],
      versionPolicy: 'catalog' as const,
    };
    const feedback = { publisher, action: 'tier-lowered', reason: 'privacy' };
    if (accepted) {
      const source = parseLiteSource(input);
      expect(source.publisher).toBe(publisher);
      expect(admitLiteObservation(feedback, source)).toEqual({
        kind: 'feedback',
        feedback,
      });
    } else {
      expect(() => parseLiteSource(input)).toThrow('invalid_source');
      expect(() => parseTelemetryFeedback(feedback)).toThrow(
        'Invalid telemetry feedback',
      );
    }
  },
);
