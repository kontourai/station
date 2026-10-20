import { describe, expect, test, vi } from 'vitest';
import {
  FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
  hasCurrentLiteTelemetryNotice,
  LITE_TELEMETRY_INVENTORY_REVISION,
  monthlyTelemetryId,
  PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
  parseProductTelemetryBatch,
  parseStationDailyPing,
  parseTelemetryFeedback,
} from '../product-telemetry.js';

const batch = () => ({
  schema_version: 1,
  inventory_revision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
  distinct_id: 'a'.repeat(64),
  events: [
    {
      event_id: '11111111-2222-4333-8444-555555555555',
      event: 'engine_turn',
      occurred_at: '2026-10-10T12:00:00.000Z',
      observed_at: '2026-10-10T12:00:01.000Z',
      build: { version: '1.2.3', platform: 'linux', arch: 'x64' },
      properties: { engine: 'codex', outcome: 'completed' },
    },
  ],
});

describe('versioned content-free product ingestion contract', () => {
  test('retains missing build provenance rather than assigning a current release hash', () => {
    expect(
      parseProductTelemetryBatch(batch()).events[0].build.sha,
    ).toBeUndefined();
  });
  test('validated properties do not alias mutable input', () => {
    const input = batch();
    const parsed = parseProductTelemetryBatch(input);
    input.events[0].properties.engine = 'private-engine-name';
    expect(parsed.events[0].properties.engine).toBe('codex');
  });
  test.each([
    [
      'legacy',
      () => ({
        distinct_id: 'a'.repeat(64),
        events: [{ event: 'engine_turn', properties: {} }],
      }),
    ],
    [
      'prototype property',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              properties: {
                ...value.events[0].properties,
                constructor: '1.2.3',
              },
            },
          ],
        };
      },
    ],
    ['unsupported version', () => ({ ...batch(), schema_version: 2 })],
    [
      'stale disclosure',
      () => ({ ...batch(), inventory_revision: 'b'.repeat(64) }),
    ],
    [
      'excessive batch',
      () => ({ ...batch(), events: Array(21).fill(batch().events[0]) }),
    ],
    ['unexpected top-level content', () => ({ ...batch(), prompt: 'secret' })],
    [
      'non-event timestamp',
      () => {
        const value = batch();
        value.events[0].occurred_at = 'yesterday';
        return value;
      },
    ],
    [
      'rolled-over timestamp',
      () => {
        const value = batch();
        value.events[0].occurred_at = '2026-02-30T12:00:00.000Z';
        return value;
      },
    ],
    [
      'unexpected event property',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              properties: { ...value.events[0].properties, prompt: 'secret' },
            },
          ],
        };
      },
    ],
    [
      'unclassified event',
      () => {
        const value = batch();
        value.events[0].event = 'new_private_event';
        return value;
      },
    ],
    [
      'unexpected build content',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: { ...value.events[0].build, branch: 'secret' },
            },
          ],
        };
      },
    ],
    [
      'coerced provenance enum',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: {
                ...value.events[0].build,
                sha: 'a'.repeat(40),
                sha_source: ['checkout'],
              },
            },
          ],
        };
      },
    ],
    [
      'coerced channel enum',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: { ...value.events[0].build, channel: ['nightly'] },
            },
          ],
        };
      },
    ],
    [
      'not a full Git hash',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: {
                ...value.events[0].build,
                sha: 'a'.repeat(50),
                sha_source: 'checkout',
              },
            },
          ],
        };
      },
    ],
    [
      'unproven build hash',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: { ...value.events[0].build, sha: 'a'.repeat(40) },
            },
          ],
        };
      },
    ],
    [
      'invalid classification',
      () => {
        const value = batch();
        value.events[0].properties.engine = 'private-model-name';
        return value;
      },
    ],
  ])('refuses %s at the receiver boundary', (_name, invalid) => {
    expect(() => parseProductTelemetryBatch(invalid())).toThrow();
  });
});

describe('Lite ping privacy boundary', () => {
  const ping = {
    event: 'station_daily',
    event_id: '11111111-2222-4333-8444-555555555555',
    version: '0.7.0',
    channel: 'stable',
    platform: 'linux',
    arch: 'x64',
    surfaces_today: ['web'],
    first_active_this_week: true,
    first_active_this_month: false,
    install_age_bucket: '8-30d',
    paired_devices_bucket: '2-3',
    engines_used_today: ['codex'],
    distribution: 'none',
    public_plugins_enabled: ['public-plugin'],
    private_plugins_bucket: '1',
    branding_overridden: false,
    home_replaced: true,
    layouts_customized: false,
    setup_abandoned_step: 'none',
    engine_connect_failures: [{ engine: 'codex', bucket: '1' }],
    safe_mode_entered: 0,
    plugin_disabled_after_crash: 1,
  };
  test('accepts a complete identifier-free ping and rejects private ids, extra fields and unbounded arrays/counts', () => {
    expect(parseStationDailyPing(ping, ['public-plugin'], ['0.7.0'])).toEqual(
      ping,
    );
    for (const change of [
      { distinct_id: 'private' },
      { version: '0.7.0-my-private-build' },
      { public_plugins_enabled: ['private-plugin'] },
      { distribution: 'my-company' },
      { public_plugins_enabled: Array(21).fill('public-plugin') },
      { surfaces_today: ['web', 'web'] },
      { safe_mode_entered: 65536 },
      { safe_mode_entered: -1 },
      { engine_connect_failures: [{ engine: 'secret-engine', bucket: '1' }] },
    ])
      expect(() =>
        parseStationDailyPing(
          { ...ping, ...change },
          ['public-plugin'],
          ['0.7.0'],
        ),
      ).toThrow();
    const { event_id: _omitted, ...missing } = ping;
    expect(() => parseStationDailyPing(missing, ['public-plugin'])).toThrow();
  });
  test('binds the shown notice to the Lite inventory independently of Full acknowledgement', () => {
    expect(
      hasCurrentLiteTelemetryNotice({
        inventoryRevision: LITE_TELEMETRY_INVENTORY_REVISION,
      }),
    ).toBe(true);
    expect(
      hasCurrentLiteTelemetryNotice({
        inventoryRevision: FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
      }),
    ).toBe(false);
    expect(hasCurrentLiteTelemetryNotice(undefined)).toBe(false);
  });
  test('rotates the Full id on UTC month boundaries, with no account input', () => {
    expect(
      monthlyTelemetryId('install-secret', new Date('2026-10-01T00:00:00Z')),
    ).toBe('fb5b90f9ab599f47181c003f4fa2801263b4ed1820fa7011f32daf5f59d7431f');
    expect(
      monthlyTelemetryId('install-secret', new Date('2026-10-31T23:59:59Z')),
    ).toBe(
      monthlyTelemetryId(
        'install-secret',
        new Date('2026-11-01T01:00:00+02:00'),
      ),
    );
    expect(
      monthlyTelemetryId('install-secret', new Date('2026-11-01T00:00:00Z')),
    ).not.toBe(
      monthlyTelemetryId('install-secret', new Date('2026-10-31T23:59:59Z')),
    );
    expect(
      monthlyTelemetryId('another-secret', new Date('2026-10-01T00:00:00Z')),
    ).not.toBe(
      monthlyTelemetryId('install-secret', new Date('2026-10-01T00:00:00Z')),
    );
  });
});

test('Full feature fields require public catalog membership rather than private names or build labels', () => {
  const feature = {
    ...batch(),
    events: [
      {
        ...batch().events[0],
        event: 'pane_opened',
        properties: { pane: 'private-pane' },
      },
    ],
  };
  expect(() => parseProductTelemetryBatch(feature)).toThrow();
  const publicFeature = {
    ...feature,
    events: [{ ...feature.events[0], properties: { pane: 'public-pane' } }],
  };
  expect(() =>
    parseProductTelemetryBatch(publicFeature, ['public-pane']),
  ).not.toThrow();
  const client = {
    ...batch(),
    events: [
      {
        ...batch().events[0],
        event: 'client_connected',
        properties: {
          surface: 'web',
          device_class: 'desktop',
          version: '1.2.3-private-project',
        },
      },
    ],
  };
  expect(() => parseProductTelemetryBatch(client)).toThrow();
  const publicClient = {
    ...client,
    events: [
      {
        ...client.events[0],
        properties: { ...client.events[0].properties, version: '1.2.3' },
      },
    ],
  };
  expect(() =>
    parseProductTelemetryBatch(publicClient, [], ['1.2.3']),
  ).not.toThrow();
});

test('a wording-only bump changes consent without changing batch or probe compatibility', async () => {
  vi.resetModules();
  vi.doMock(
    '@kontourai/station-contracts/product-telemetry',
    async (importOriginal) => {
      const original =
        await importOriginal<
          typeof import('@kontourai/station-contracts/product-telemetry')
        >();
      return {
        ...original,
        FULL_DISCLOSURE_WORDING_REVISION:
          original.FULL_DISCLOSURE_WORDING_REVISION + 1,
      };
    },
  );
  try {
    const revised = await import('../product-telemetry.js');
    expect(revised.PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION).toBe(
      PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
    );
    expect(revised.FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION).not.toBe(
      FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
    );
    expect(revised.parseProductTelemetryBatch(batch()).inventory_revision).toBe(
      PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
    );
    const probe = {
      protocol: 'station-product-probe/v1',
      inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
    };
    expect(revised.parseProductTelemetryProbeRequest(probe)).toEqual(probe);
    const receipt = {
      ...probe,
      sourceId: '11111111-2222-4333-8444-555555555555',
      checkedAt: '2026-10-10T12:00:00.000Z',
      storage: 'postgres-schema-v1',
    };
    expect(revised.parseProductTelemetryProbeReceipt(receipt)).toEqual(receipt);
  } finally {
    vi.doUnmock('@kontourai/station-contracts/product-telemetry');
    vi.resetModules();
  }
});

test('feedback skip is a local dismissal and cannot be submitted', () => {
  expect(() =>
    parseTelemetryFeedback({
      publisher: 'kontour',
      action: 'tier-lowered',
      reason: 'skip',
    }),
  ).toThrow('Invalid telemetry feedback');
  expect(
    parseTelemetryFeedback({
      publisher: 'kontour',
      action: 'tier-lowered',
      reason: 'privacy',
    }),
  ).toEqual({
    publisher: 'kontour',
    action: 'tier-lowered',
    reason: 'privacy',
  });
});
