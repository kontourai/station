/**
 * #2494: unit pins for the resolution rules the start-path suite
 * (`confinement-start.test.ts`) cannot reach with Station's one real
 * provider: level ranking, spawn-wrapper engagement, and stored-record
 * parsing. The start path, the Codex adapter and the delegation route own
 * the integration evidence.
 */

import { join } from 'node:path';
import type { ConfinementMechanism } from '@kontourai/station-contracts/execution-confinement';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterAll, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { codexSandboxConfinementProvider } from '../../../providers/adapters/codex-confinement.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  assertRequiredConfinementObserved,
  type ConfinementProvider,
  confinedNetworkPlan,
  fallbackConfinementRecord,
  loadConfinedNetworkPlan,
  noMechanismConfinementRecord,
  observedConfinementRecord,
  readConfinementRecord,
  requiredConfinementLevel,
  resolveConfinement,
  sessionNetworkRestricted,
} from '../confinement-provider.js';

function provider(
  overrides: Omit<Partial<ConfinementProvider>, 'mechanism'> & {
    mechanism: string;
  },
): ConfinementProvider {
  return {
    level: 'os-profile',
    workspaceAccess: 'mounted',
    supportedIsolationModes: ['shared', 'worktree'],
    engagement: 'engine-native',
    availability: () => ({ available: true, reason: 'test' }),
    confine: (spec) => ({
      spec,
      pending: { observe: () => 'configured-but-failed' },
    }),
    ...overrides,
    mechanism: overrides.mechanism as ConfinementMechanism,
  };
}

const WORKSPACE_NEVER = {
  confinement: 'workspace',
  engine: 'claude',
  appliedMode: 'never',
  isolationMode: 'shared',
} as const;

describe('requiredConfinementLevel', () => {
  test.each([
    ['workspace', 'never', 'os-profile'],
    ['workspace', 'auto', 'host'],
    ['workspace', 'ask', 'host'],
    ['workspace', undefined, 'host'],
    ['host', 'never', 'host'],
  ] as const)('%s at %s requires %s', (confinement, mode, expected) => {
    expect(requiredConfinementLevel(confinement, mode)).toBe(expected);
  });
});

describe('resolveConfinement', () => {
  test('a stronger level satisfies a weaker requirement', () => {
    const resolution = resolveConfinement({
      ...WORKSPACE_NEVER,
      providers: [
        provider({ mechanism: 'test-container', level: 'container' }),
      ],
    });
    expect(resolution.plan).toMatchObject({
      requiredLevel: 'os-profile',
      level: 'container',
    });
  });

  test('a required start is never resolved to a spawn wrapper that names no engine applying it', () => {
    expect(() =>
      resolveConfinement({
        ...WORKSPACE_NEVER,
        providers: [
          provider({ mechanism: 'test-wrapper', engagement: 'spawn-wrapper' }),
          provider({
            mechanism: 'test-codex-wrapper',
            engagement: 'spawn-wrapper',
            engines: ['codex'],
          }),
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'confinement_mechanism_unavailable',
        message: expect.stringContaining(
          'test-wrapper: no start path applies a spawn-wrapped confinement for claude',
        ),
      }),
    );
  });

  test('#2494: a required start resolves to a spawn wrapper whose engine applies it', () => {
    expect(
      resolveConfinement({
        ...WORKSPACE_NEVER,
        providers: [
          provider({
            mechanism: 'seatbelt',
            engagement: 'spawn-wrapper',
            engines: ['claude'],
          }),
        ],
      }).plan,
    ).toEqual({
      requiredLevel: 'os-profile',
      policyBasis: 'workspace-floor',
      mechanism: 'seatbelt',
      level: 'os-profile',
      workspaceAccess: 'mounted',
    });
  });

  test('an unrequired start engages only engine-native mechanisms, and never refuses', () => {
    const resolution = resolveConfinement({
      ...WORKSPACE_NEVER,
      appliedMode: 'auto',
      providers: [
        provider({ mechanism: 'test-wrapper', engagement: 'spawn-wrapper' }),
        provider({ mechanism: 'test-copied', workspaceAccess: 'copied' }),
      ],
    });
    expect(resolution).toEqual({
      requiredLevel: 'host',
      policyBasis: 'workspace-floor',
    });
  });

  test('a provider for another engine is not applicable', () => {
    expect(() =>
      resolveConfinement({
        ...WORKSPACE_NEVER,
        providers: [codexSandboxConfinementProvider],
      }),
    ).toThrow(
      expect.objectContaining({ code: 'confinement_mechanism_unavailable' }),
    );
  });
});

describe('observedConfinementRecord', () => {
  test('a required start where nothing was engaged names no mechanism, and is still refused', () => {
    const record = observedConfinementRecord(
      {
        requiredLevel: 'os-profile',
        policyBasis: 'workspace-floor',
        mechanism: 'codex-sandbox',
        level: 'os-profile',
        workspaceAccess: 'mounted',
      },
      'no-mechanism',
    );
    expect(record).toEqual({
      level: 'host',
      required: true,
      posture: 'no-mechanism',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
    });
    expect(() => assertRequiredConfinementObserved(record, 'codex')).toThrow(
      expect.objectContaining({ code: 'confinement_not_observed' }),
    );
  });
});

describe('codexSandboxConfinementProvider', () => {
  test('wraps no spawn; its pending posture reads only the engine report', () => {
    const spec = {
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
      env: {},
      grants: { writable: ['/workspace'], readable: [] },
      network: 'none' as const,
    };
    const confined = codexSandboxConfinementProvider.confine(spec);
    expect(confined.spec).toBe(spec);
    expect(
      confined.pending.observe({
        requested: 'workspace-write',
        reported: undefined,
      }),
    ).toBe('configured-but-failed');
  });
});

describe('readConfinementRecord', () => {
  const valid = {
    level: 'os-profile',
    required: true,
    posture: 'confined',
    mechanism: 'codex-sandbox',
    workspaceAccess: 'mounted',
    policyBasis: 'workspace-floor',
  };

  test('reads back a record the server wrote', () => {
    expect(readConfinementRecord(valid)).toEqual(valid);
  });

  test('#2494: reads back a Seatbelt record with its grant kinds, and a fallback', () => {
    const seatbelt = {
      ...valid,
      mechanism: 'seatbelt',
      writeGrants: ['station-config', 'station-temp', 'workspace'],
    };
    expect(readConfinementRecord(seatbelt)).toEqual(seatbelt);
    const fallback = {
      level: 'host',
      required: false,
      posture: 'no-mechanism',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
      fallback: 'confined-credential-unavailable',
    };
    expect(readConfinementRecord(fallback)).toEqual(fallback);
  });

  test('#4770: reads back a bubblewrap record with its grant kinds', () => {
    const bubblewrap = {
      ...valid,
      mechanism: 'bubblewrap',
      writeGrants: ['station-config', 'station-temp', 'workspace'],
    };
    expect(readConfinementRecord(bubblewrap)).toEqual(bubblewrap);
  });

  test.each([
    ['an unknown write grant', { ...valid, writeGrants: ['everything'] }],
    [
      'write grants that are not a list',
      { ...valid, writeGrants: 'workspace' },
    ],
    ['an unknown fallback', { ...valid, fallback: 'because' }],
    ['an unknown level', { ...valid, level: 'kernel' }],
    ['an unknown posture', { ...valid, posture: 'probably' }],
    ['an unknown mechanism', { ...valid, mechanism: 'trust-me' }],
    ['a string for required', { ...valid, required: 'yes' }],
    ['no policy basis', { ...valid, policyBasis: undefined }],
  ])('is not one with %s', (_label, value) => {
    expect(readConfinementRecord(value)).toBeUndefined();
  });
});

describe('#4769: a restricted network policy', () => {
  const RESTRICTED = {
    policy: 'restricted',
    allowedHosts: ['registry.npmjs.org'],
  } as const;
  const wrapper = (restrictsNetwork: boolean) =>
    provider({
      mechanism: restrictsNetwork ? 'seatbelt' : 'bubblewrap',
      engagement: 'spawn-wrapper',
      engines: ['claude'],
      restrictsNetwork,
      networkRestrictionUnavailable: 'test: cannot restrict',
    });

  test('a required start resolves only a provider that can restrict the network, and its plan carries the policy', () => {
    const resolved = resolveConfinement({
      ...WORKSPACE_NEVER,
      providers: [wrapper(false), wrapper(true)],
      network: () => RESTRICTED,
    });
    expect(resolved.plan).toMatchObject({
      mechanism: 'seatbelt',
      network: RESTRICTED,
    });
    // The plan holds its own copy of the host list.
    expect(resolved.plan?.network?.allowedHosts).not.toBe(
      RESTRICTED.allowedHosts,
    );
  });

  test('a required start with only providers that cannot restrict the network is refused, naming each reason', () => {
    expect(() =>
      resolveConfinement({
        ...WORKSPACE_NEVER,
        providers: [wrapper(false)],
        network: () => RESTRICTED,
      }),
    ).toThrow(
      /requires os-profile confinement with a restricted network .*\(bubblewrap: test: cannot restrict\)/,
    );
    // A provider that does not declare it cannot restrict.
    expect(() =>
      resolveConfinement({
        ...WORKSPACE_NEVER,
        providers: [
          provider({
            mechanism: 'seatbelt',
            engagement: 'spawn-wrapper',
            engines: ['claude'],
          }),
        ],
        network: () => RESTRICTED,
      }),
    ).toThrow(/seatbelt: it cannot restrict the network/);
  });

  test('a start that requires no confinement never reads the policy, and its plan carries none', () => {
    let reads = 0;
    const resolved = resolveConfinement({
      ...WORKSPACE_NEVER,
      appliedMode: 'auto',
      engine: 'codex',
      providers: [codexSandboxConfinementProvider],
      network: () => {
        reads += 1;
        return RESTRICTED;
      },
    });
    expect(reads).toBe(0);
    expect(resolved.plan).toBeDefined();
    expect(resolved.plan).not.toHaveProperty('network');
  });

  test('the setting is opt-in: absent or full leaves the network open', () => {
    expect(confinedNetworkPlan(undefined)).toBeUndefined();
    expect(confinedNetworkPlan({ mode: 'full' })).toBeUndefined();
    expect(
      confinedNetworkPlan({
        mode: 'restricted',
        allowedHosts: [
          'registry.npmjs.org',
          '*.github.com',
          '[2001:db8::1]:8443',
        ],
      }),
    ).toEqual({
      policy: 'restricted',
      allowedHosts: [
        'registry.npmjs.org',
        '*.github.com',
        '[2001:db8::1]:8443',
      ],
    });
  });

  test.each([
    ['a value that is not a setting', { mode: 'restricted' }],
    ['an unknown mode', { mode: 'loopback' }],
    ['null', null],
    [
      'an entry the broker cannot read',
      { mode: 'restricted', allowedHosts: ['https://registry.npmjs.org'] },
    ],
  ])(
    'a policy with %s refuses the start instead of running it open',
    (_label, value) => {
      expect(() => confinedNetworkPlan(value)).toThrow(
        expect.objectContaining({
          name: 'ConfinementRefusedError',
          code: 'confinement_mechanism_unavailable',
        }),
      );
    },
  );

  test('a configuration that cannot be read refuses the start as a confinement refusal, not the loader error', async () => {
    await expect(
      loadConfinedNetworkPlan(async () => {
        throw new Error('app config exceeds the byte limit.');
      }),
    ).rejects.toMatchObject({
      name: 'ConfinementRefusedError',
      code: 'confinement_mechanism_unavailable',
      message: expect.stringContaining('could not be read'),
    });
    await expect(
      loadConfinedNetworkPlan(async () => ({
        confinedNetwork: { mode: 'restricted', allowedHosts: ['x.example'] },
      })),
    ).resolves.toEqual({ policy: 'restricted', allowedHosts: ['x.example'] });
    await expect(loadConfinedNetworkPlan(async () => ({}))).resolves.toBe(
      undefined,
    );
  });

  test('the record states a restricted network, and reads back only that value', () => {
    const plan = {
      requiredLevel: 'os-profile',
      policyBasis: 'workspace-floor',
      mechanism: 'seatbelt',
      level: 'os-profile',
      workspaceAccess: 'mounted',
      network: RESTRICTED,
    } as const;
    const record = observedConfinementRecord(
      plan,
      'confined',
      [],
      'restricted',
    );
    expect(record.network).toBe('restricted');
    expect(JSON.stringify(record)).not.toContain('registry.npmjs.org');
    expect(
      observedConfinementRecord(plan, 'confined', [], 'full'),
    ).not.toHaveProperty('network');
    expect(readConfinementRecord(record)).toEqual(record);
    expect(
      readConfinementRecord({ ...record, network: 'full' }),
    ).toBeUndefined();
    expect(
      readConfinementRecord({ ...record, network: 'open' }),
    ).toBeUndefined();
  });
});

describe('#4769: whether a session started restricted, read from the real event store', () => {
  const makeTempDir = trackTempDirs({ lifetime: 'file' });
  const store = new EventStore(
    join(makeTempDir('session-network-'), 'orchestration.sqlite'),
  );
  afterAll(() => store.close());
  const PLAN = {
    requiredLevel: 'os-profile',
    policyBasis: 'workspace-floor',
    mechanism: 'seatbelt',
    level: 'os-profile',
    workspaceAccess: 'mounted',
  } as const;
  const RESTRICTED_PLAN = {
    ...PLAN,
    network: { policy: 'restricted', allowedHosts: [] },
  } as const;
  let sequence = 0;
  /** A `session.started` as the adapters write it. */
  function started(threadId: string, metadata?: Record<string, unknown>) {
    sequence += 1;
    store.appendEvent({
      eventId: `${threadId}-started-${sequence}`,
      provider: 'claude',
      threadId,
      sessionId: threadId,
      createdAt: new Date(Date.UTC(2026, 10, 11, 0, 0, sequence)).toISOString(),
      method: 'session.started',
      ...(metadata ? { metadata } : {}),
    } as CanonicalRuntimeEvent);
  }
  const record = (value: unknown) => ({ stationConfinementRecord: value });

  test('a start observed confined under the broker-only profile reads as restricted', () => {
    started(
      'restricted',
      record(
        observedConfinementRecord(
          RESTRICTED_PLAN,
          'confined',
          [],
          'restricted',
        ),
      ),
    );
    expect(sessionNetworkRestricted(store, 'restricted')).toBe(true);
  });

  test('an open confined start, a fallback, a host start, a start before #4769 and no start read as not restricted', () => {
    started(
      'open',
      record(observedConfinementRecord(PLAN, 'confined', [], 'full')),
    );
    started(
      'fallback',
      record(fallbackConfinementRecord(RESTRICTED_PLAN, 'workspace-too-broad')),
    );
    started(
      'host',
      record(
        noMechanismConfinementRecord({
          requiredLevel: 'host',
          policyBasis: 'operator-policy',
        }),
      ),
    );
    started('older', { cwd: '/x' });
    for (const id of ['open', 'fallback', 'host', 'older', 'never-started'])
      expect(sessionNetworkRestricted(store, id), id).toBe(false);
    expect(sessionNetworkRestricted(undefined, 'restricted')).toBe(false);
    // A record that is not one (a forged or corrupt value) is not restricted.
    started('corrupt', record({ network: 'restricted' }));
    expect(sessionNetworkRestricted(store, 'corrupt')).toBe(false);
  });

  test('the latest start wins, in either direction', () => {
    started(
      'opened-later',
      record(
        observedConfinementRecord(
          RESTRICTED_PLAN,
          'confined',
          [],
          'restricted',
        ),
      ),
    );
    started(
      'opened-later',
      record(observedConfinementRecord(PLAN, 'confined', [], 'full')),
    );
    expect(sessionNetworkRestricted(store, 'opened-later')).toBe(false);
    started(
      'restricted-later',
      record(observedConfinementRecord(PLAN, 'confined', [], 'full')),
    );
    started(
      'restricted-later',
      record(
        observedConfinementRecord(
          RESTRICTED_PLAN,
          'confined',
          [],
          'restricted',
        ),
      ),
    );
    expect(sessionNetworkRestricted(store, 'restricted-later')).toBe(true);
  });
});
