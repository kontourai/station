import { describe, expect, it } from 'vitest';
import {
  MAX_CONFINEMENT_PREFLIGHT_ENGINES,
  MAX_CONFINEMENT_PREFLIGHT_REASON_LENGTH,
  parseConfinementPreflight,
} from '../execution-confinement.js';

const ENTRY = {
  engine: 'claude',
  mechanism: 'seatbelt',
  level: 'os-profile',
  mechanismState: 'available',
  mechanismReason: 'the Seatbelt profile applies on this host',
  confinedAuthentication: {
    state: 'unavailable',
    fallback: 'confined-credential-unavailable',
    remedy: 'Set a credential.',
    appliesTo: 'starts-without-own-credential-profile',
  },
};

function document(overrides: Record<string, unknown> = {}) {
  return {
    engines: [ENTRY],
    decidedAtStart: ['workspace-too-broad'],
    ...overrides,
  };
}

describe('#4774: parseConfinementPreflight', () => {
  it('reads a preflight and drops keys it does not know', () => {
    expect(
      parseConfinementPreflight(
        document({ engines: [{ ...ENTRY, path: '/x' }], extra: true }),
      ),
    ).toEqual({ engines: [ENTRY], decidedAtStart: ['workspace-too-broad'] });
  });

  it.each([
    ['an unknown mechanism state', { ...ENTRY, mechanismState: 'probably' }],
    ['an unknown mechanism', { ...ENTRY, mechanism: 'firejail' }],
    ['the host level', { ...ENTRY, level: 'host' }],
    [
      'an unknown credential state',
      { ...ENTRY, confinedAuthentication: { state: 'fine' } },
    ],
    [
      'an available credential with no source',
      {
        ...ENTRY,
        confinedAuthentication: {
          state: 'available',
          appliesTo: 'starts-without-own-credential-profile',
        },
      },
    ],
    [
      'a checked credential that does not say which starts it covers',
      {
        ...ENTRY,
        confinedAuthentication: { state: 'available', source: 'environment' },
      },
    ],
    [
      'a checked credential with an unknown scope',
      {
        ...ENTRY,
        confinedAuthentication: {
          state: 'unverified',
          reason: 'x',
          appliesTo: 'every-start',
        },
      },
    ],
    [
      'an unavailable credential with another fallback',
      {
        ...ENTRY,
        confinedAuthentication: {
          state: 'unavailable',
          fallback: 'workspace-too-broad',
          remedy: 'x',
          appliesTo: 'starts-without-own-credential-profile',
        },
      },
    ],
    ['an empty reason', { ...ENTRY, mechanismReason: '' }],
    [
      'an engine id carrying a path and terminal escapes',
      {
        ...ENTRY,
        engine: '/Users/jane/.station/x \u001b[2J\u001b[31mFAKE PASS',
      },
    ],
    ['an engine id with an uppercase letter', { ...ENTRY, engine: 'Claude' }],
    ['an engine id with a space', { ...ENTRY, engine: 'claude code' }],
    ['an empty engine id', { ...ENTRY, engine: '' }],
    ['an engine id that is not a string', { ...ENTRY, engine: 7 }],
  ])('refuses %s', (_name, entry) => {
    expect(parseConfinementPreflight(document({ engines: [entry] }))).toBe(
      undefined,
    );
  });

  it('accepts a reason at the limit and refuses one past it', () => {
    const at = 'r'.repeat(MAX_CONFINEMENT_PREFLIGHT_REASON_LENGTH);
    expect(MAX_CONFINEMENT_PREFLIGHT_REASON_LENGTH).toBe(1_024);
    expect(
      parseConfinementPreflight(
        document({ engines: [{ ...ENTRY, mechanismReason: at }] }),
      ),
    ).toBeDefined();
    expect(
      parseConfinementPreflight(
        document({ engines: [{ ...ENTRY, mechanismReason: `${at}r` }] }),
      ),
    ).toBe(undefined);
  });

  it('accepts the most engines and refuses one more', () => {
    expect(MAX_CONFINEMENT_PREFLIGHT_ENGINES).toBe(16);
    const at = Array.from(
      { length: MAX_CONFINEMENT_PREFLIGHT_ENGINES },
      () => ENTRY,
    );
    expect(parseConfinementPreflight(document({ engines: at }))).toBeDefined();
    expect(
      parseConfinementPreflight(document({ engines: [...at, ENTRY] })),
    ).toBe(undefined);
  });

  it('accepts an engine id at the length limit and refuses one past it', () => {
    const at = `c${'x'.repeat(63)}`;
    expect(at).toHaveLength(64);
    for (const engine of ['claude', 'codex', 'open-code_2.1']) {
      expect(
        parseConfinementPreflight(document({ engines: [{ ...ENTRY, engine }] }))
          ?.engines[0]?.engine,
      ).toBe(engine);
    }
    expect(
      parseConfinementPreflight(
        document({ engines: [{ ...ENTRY, engine: at }] }),
      ),
    ).toBeDefined();
    expect(
      parseConfinementPreflight(
        document({ engines: [{ ...ENTRY, engine: `${at}x` }] }),
      ),
    ).toBe(undefined);
  });

  it('accepts every known decided-at-start reason once, and refuses a repeat or a flood', () => {
    const all = [
      'workspace-too-broad',
      'config-root-pinned',
      'resume-bound-elsewhere',
      'confined-credential-unavailable',
    ];
    expect(
      parseConfinementPreflight(document({ decidedAtStart: all }))
        ?.decidedAtStart,
    ).toEqual(all);
    expect(
      parseConfinementPreflight(
        document({
          decidedAtStart: ['workspace-too-broad', 'workspace-too-broad'],
        }),
      ),
    ).toBe(undefined);
    expect(
      parseConfinementPreflight(
        document({
          decidedAtStart: Array.from(
            { length: 100_000 },
            () => 'workspace-too-broad',
          ),
        }),
      ),
    ).toBe(undefined);
  });

  it('refuses an unknown decided-at-start reason and non-objects', () => {
    expect(
      parseConfinementPreflight(document({ decidedAtStart: ['later'] })),
    ).toBe(undefined);
    expect(parseConfinementPreflight(null)).toBe(undefined);
    expect(parseConfinementPreflight([])).toBe(undefined);
    expect(parseConfinementPreflight({ engines: 'x' })).toBe(undefined);
  });
});
