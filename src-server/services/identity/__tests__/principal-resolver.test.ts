import {
  humanPrincipal,
  LOCAL_OPERATOR_PROVIDER,
  LOCAL_OPERATOR_SUBJECT,
  ReservedPrincipalKindError,
  ReservedPrincipalProviderError,
  tenantPrincipal,
} from '@kontourai/station-contracts/principal';
import { tenantId } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  PrincipalUnresolvedError,
  resolvePrincipal,
} from '../principal-resolver.js';

const HOME_POSSESSION = { locality: 'home-possession' as const };
const boundTenant = (id: string) =>
  ({ tenantId: tenantId(id), source: 'request' as const }) as const;

describe('resolvePrincipal', () => {
  test('resolves a human principal from a verified identity, preferring displayName', () => {
    const principal = resolvePrincipal(
      {
        provider: 'tailscale-serve',
        subject: 'brian@example.test',
        displayName: 'Brian',
      },
      'personal',
      undefined,
      undefined,
    );
    expect(principal).toEqual({
      id: 'human:tailscale-serve:brian@example.test',
      kind: 'human',
      display: 'Brian',
    });
  });

  test('resolves a human principal from a verified identity with no displayName, falling back to subject for display only', () => {
    const principal = resolvePrincipal(
      { provider: 'tailscale-serve', subject: 'brian@example.test' },
      'hosted',
      undefined,
      undefined,
    );
    expect(principal).toEqual({
      id: 'human:tailscale-serve:brian@example.test',
      kind: 'human',
      display: 'brian@example.test',
    });
  });

  test('single-operator explicit path: no identity + personal mode + the home-possession authority fact resolves the well-known local-operator principal', () => {
    const principal = resolvePrincipal(
      null,
      'personal',
      HOME_POSSESSION,
      undefined,
    );
    expect(principal).toEqual({
      id: LOCAL_OPERATOR_PRINCIPAL_ID,
      kind: 'human',
      display: 'Operator',
    });
    expect(LOCAL_OPERATOR_PRINCIPAL_ID).toBe('human:local:operator');
  });

  test('the local-operator display is cosmetic only, sourced from the injected thunk, never the id', () => {
    const principal = resolvePrincipal(
      null,
      'personal',
      HOME_POSSESSION,
      undefined,
      { resolveOperatorDisplay: () => 'osUserAliasFromCache' },
    );
    expect(principal.id).toBe(LOCAL_OPERATOR_PRINCIPAL_ID);
    expect(principal.display).toBe('osUserAliasFromCache');
  });

  test('FINDING 2: personal mode alone is NOT sufficient — no identity + personal mode + NO authority fact fails closed, never falling back to the mode label', () => {
    let result: unknown;
    let thrown: unknown;
    try {
      result = resolvePrincipal(null, 'personal', undefined, undefined);
    } catch (error) {
      thrown = error;
    }
    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(PrincipalUnresolvedError);
    expect((thrown as Error).message).toMatch(
      /personal-mode request carries no verified identity and no home-possession authority fact/,
    );
  });

  test('a present but non-home-possession-shaped authority object still fails closed (defense against a widened caller)', () => {
    expect(() =>
      resolvePrincipal(
        null,
        'personal',
        // @ts-expect-error — deliberately wrong shape to prove the check is exact
        { locality: 'something-else' },
        undefined,
      ),
    ).toThrow(PrincipalUnresolvedError);
  });

  test('an identity always wins over the personal-mode local-operator default, even with the authority fact present', () => {
    const principal = resolvePrincipal(
      { provider: 'tailscale-serve', subject: 'brian@example.test' },
      'personal',
      HOME_POSSESSION,
      undefined,
    );
    expect(principal.id).toBe('human:tailscale-serve:brian@example.test');
    expect(principal.id).not.toBe(LOCAL_OPERATOR_PRINCIPAL_ID);
  });

  test('N1: this resolver is the ONE sanctioned mint site — the public humanPrincipal() constructor refuses the same id this resolver legitimately returns', () => {
    // Proves the asymmetry end to end from this module's own suite: given
    // real authority, resolvePrincipal succeeds and returns exactly the id
    // the reserved-provider guard protects...
    const principal = resolvePrincipal(
      null,
      'personal',
      HOME_POSSESSION,
      undefined,
    );
    expect(principal.id).toBe(
      `human:${LOCAL_OPERATOR_PROVIDER}:${LOCAL_OPERATOR_SUBJECT}`,
    );
    // ...while calling the public constructor directly with the exact same
    // components — with NO authority check available to it — throws.
    expect(() =>
      humanPrincipal(LOCAL_OPERATOR_PROVIDER, LOCAL_OPERATOR_SUBJECT, 'Forged'),
    ).toThrow(ReservedPrincipalProviderError);
  });

  /**
   * station#4075 stage 2 review round 3: the three hosted outcomes,
   * exhaustively — the exact regression the hosted-composition test caught
   * (a real, currently-supported hostname-fronted tenant with no per-caller
   * identity provider in the loop) and the fix's own contract.
   */
  describe('the three hosted outcomes (station#4075 stage 2 review round 3)', () => {
    test('hosted + VerifiedIdentity resolves a human principal, taking precedence over a ALSO-bound tenant', () => {
      const principal = resolvePrincipal(
        { provider: 'tailscale-serve', subject: 'alice' },
        'hosted',
        undefined,
        boundTenant('alpha'),
      );
      expect(principal).toEqual({
        id: 'human:tailscale-serve:alice',
        kind: 'human',
        display: 'alice',
      });
    });

    test('hosted + no identity + a bound tenant context resolves the tenant principal', () => {
      const principal = resolvePrincipal(
        null,
        'hosted',
        undefined,
        boundTenant('alpha'),
      );
      expect(principal).toEqual({
        id: 'tenant:alpha',
        kind: 'tenant',
        display: 'alpha',
      });
    });

    test('the tenant principal display is cosmetic only, sourced from the injected thunk, never the id', () => {
      const principal = resolvePrincipal(
        null,
        'hosted',
        undefined,
        boundTenant('alpha'),
        { resolveTenantDisplay: (id) => `Tenant ${id}` },
      );
      expect(principal.id).toBe('tenant:alpha');
      expect(principal.display).toBe('Tenant alpha');
    });

    test('hosted + no identity + NO bound tenant context still fails closed (the floor is unchanged)', () => {
      let result: unknown;
      let thrown: unknown;
      try {
        result = resolvePrincipal(null, 'hosted', undefined, undefined);
      } catch (error) {
        thrown = error;
      }
      expect(result).toBeUndefined();
      expect(thrown).toBeInstanceOf(PrincipalUnresolvedError);
      expect((thrown as Error).message).toMatch(
        /hosted request carries no verified identity and no bound tenant context/,
      );
    });

    test('a bound tenant does not rescue PERSONAL mode — mode still gates it', () => {
      expect(() =>
        resolvePrincipal(null, 'personal', undefined, boundTenant('alpha')),
      ).toThrow(PrincipalUnresolvedError);
    });

    test('the public tenantPrincipal() constructor is reserved and always throws — the ONE sanctioned mint site is this resolver', () => {
      const principal = resolvePrincipal(
        null,
        'hosted',
        undefined,
        boundTenant('alpha'),
      );
      expect(principal.id).toBe('tenant:alpha');
      expect(() => tenantPrincipal('alpha', 'Forged')).toThrow(
        ReservedPrincipalKindError,
      );
    });
  });
});
