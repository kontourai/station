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
      { ...ENTRY, confinedAuthentication: { state: 'available' } },
    ],
    [
      'an unavailable credential with another fallback',
      {
        ...ENTRY,
        confinedAuthentication: {
          state: 'unavailable',
          fallback: 'workspace-too-broad',
          remedy: 'x',
        },
      },
    ],
    ['an empty reason', { ...ENTRY, mechanismReason: '' }],
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

  it('refuses an unknown decided-at-start reason and non-objects', () => {
    expect(
      parseConfinementPreflight(document({ decidedAtStart: ['later'] })),
    ).toBe(undefined);
    expect(parseConfinementPreflight(null)).toBe(undefined);
    expect(parseConfinementPreflight([])).toBe(undefined);
    expect(parseConfinementPreflight({ engines: 'x' })).toBe(undefined);
  });
});
