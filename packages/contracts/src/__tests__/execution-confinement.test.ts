import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ExecutionConfinementRecord,
  MAX_CONFINED_NETWORK_ALLOWED_HOSTS,
  parseConfinedNetworkSetting,
} from '../execution-confinement.js';
import type { ExecutionResolutionReceipt } from '../execution-target.js';

// Type assertions, checked by `typecheck:contracts`. The record rides the
// resolution receipt, whose recursive access/credential/transport ban lives
// in execution-target.test.ts; this pins the record's own finite key set.
describe('execution confinement contract', () => {
  it('keeps the confinement record to its nine content-free fields', () => {
    expectTypeOf<keyof ExecutionConfinementRecord>().toEqualTypeOf<
      | 'level'
      | 'required'
      | 'posture'
      | 'mechanism'
      | 'workspaceAccess'
      | 'policyBasis'
      | 'writeGrants'
      | 'fallback'
      | 'network'
    >();
    // #4769: the network policy that applied, never a host.
    expectTypeOf<ExecutionConfinementRecord['network']>().toEqualTypeOf<
      'restricted' | undefined
    >();
  });

  it('places the record on the resolution receipt as an optional, post-start field', () => {
    expectTypeOf<ExecutionResolutionReceipt['confinement']>().toEqualTypeOf<
      ExecutionConfinementRecord | undefined
    >();
  });
});

describe('#4769: the confinedNetwork setting', () => {
  it('reads full and restricted, copying the host list', () => {
    expect(parseConfinedNetworkSetting({ mode: 'full' })).toEqual({
      mode: 'full',
    });
    const hosts = ['registry.npmjs.org', '*.github.com:443'];
    const parsed = parseConfinedNetworkSetting({
      mode: 'restricted',
      allowedHosts: hosts,
    });
    expect(parsed).toEqual({ mode: 'restricted', allowedHosts: hosts });
    hosts.push('later.example');
    expect(parsed).toEqual({
      mode: 'restricted',
      allowedHosts: ['registry.npmjs.org', '*.github.com:443'],
    });
    expect(
      parseConfinedNetworkSetting({ mode: 'restricted', allowedHosts: [] }),
    ).toEqual({ mode: 'restricted', allowedHosts: [] });
  });

  it.each([
    ['nothing', undefined],
    ['a string', 'restricted'],
    ['an array', []],
    ['an unknown mode', { mode: 'loopback' }],
    ['full with hosts', { mode: 'full', allowedHosts: [] }],
    ['restricted without hosts', { mode: 'restricted' }],
    ['hosts that are not a list', { mode: 'restricted', allowedHosts: 'x' }],
    ['an empty entry', { mode: 'restricted', allowedHosts: [''] }],
    ['a non-string entry', { mode: 'restricted', allowedHosts: [443] }],
    [
      'an over-long entry',
      { mode: 'restricted', allowedHosts: ['a'.repeat(262)] },
    ],
    [
      'too many entries',
      {
        mode: 'restricted',
        allowedHosts: Array.from(
          { length: MAX_CONFINED_NETWORK_ALLOWED_HOSTS + 1 },
          (_, index) => `h${index}.example`,
        ),
      },
    ],
    ['an unknown key', { mode: 'restricted', allowedHosts: [], extra: true }],
  ])('is not one with %s', (_label, value) => {
    expect(parseConfinedNetworkSetting(value)).toBeUndefined();
  });
});
