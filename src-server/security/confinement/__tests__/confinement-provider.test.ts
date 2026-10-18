/**
 * #2494: unit pins for the resolution rules the start-path suite
 * (`confinement-start.test.ts`) cannot reach with Station's one real
 * provider: level ranking, spawn-wrapper engagement, and stored-record
 * parsing. The start path, the Codex adapter and the delegation route own
 * the integration evidence.
 */
import type { ConfinementMechanism } from '@kontourai/station-contracts/execution-confinement';
import { describe, expect, test } from 'vitest';
import { codexSandboxConfinementProvider } from '../../../providers/adapters/codex-confinement.js';
import {
  assertRequiredConfinementObserved,
  type ConfinementProvider,
  observedConfinementRecord,
  readConfinementRecord,
  requiredConfinementLevel,
  resolveConfinement,
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
