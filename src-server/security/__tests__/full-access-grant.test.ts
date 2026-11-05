/**
 * #1796 H1 (delta review): a full-access grant names who granted it,
 * derived from the same request, so every start it unconfines can be found
 * and taken back when that device loses the grant.
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
  fullAccessGrantFor,
  fullAccessGrantor,
  mayGrantFullAccess,
} from '../coding-authority.js';
import { installManagedApprovalCeiling } from '../managed-approval-ceiling.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../runtime-request-security.js';

const FULL = 'orchestration:read orchestration:operate approval:full-access';

function request(
  principal: Parameters<typeof setRuntimeAuthenticatedRequestPrincipal>[1],
): Request {
  const req = new Request('http://station.test/api/orchestration/chat', {
    method: 'POST',
  });
  setRuntimeAuthenticatedRequestPrincipal(req, principal);
  bindRuntimeLocalOperator(req, principal);
  return req;
}

describe('fullAccessGrantFor names the grantor', () => {
  test('a paired device holding approval:full-access', () => {
    const grant = fullAccessGrantFor(
      request({
        kind: 'credential',
        credential: 'c',
        authority: 'device-credential',
        deviceId: 'device-1',
        source: 'bearer',
      }),
      FULL,
    );
    expect(grant && fullAccessGrantor(grant)).toEqual({
      kind: 'device',
      deviceId: 'device-1',
    });
  });

  test('the operator credential', () => {
    const grant = fullAccessGrantFor(
      request({
        kind: 'credential',
        credential: 'c',
        authority: 'operator-credential',
        source: 'bearer',
      }),
      undefined,
    );
    expect(grant && fullAccessGrantor(grant)).toEqual({ kind: 'operator' });
  });

  test('the operator in person through a home-possession device credential is the operator, not that device', () => {
    const grant = fullAccessGrantFor(
      request({
        kind: 'credential',
        credential: 'c',
        authority: 'device-credential',
        deviceId: 'local-ui-device',
        locality: 'home-possession',
        source: 'bearer',
      }),
      'orchestration:read orchestration:operate',
    );
    expect(grant && fullAccessGrantor(grant)).toEqual({ kind: 'operator' });
  });

  test('a caller that holds the scope but is neither the operator nor a device gets no grant', () => {
    expect(
      fullAccessGrantFor(
        request({
          kind: 'credential',
          credential: 'account-session',
          authority: undefined,
          source: 'session',
        }),
        FULL,
      ),
    ).toBeNull();
  });
});

/**
 * #4518: no `FullAccessGrant` exists above the machine's managed approval
 * ceiling. Every grant is minted from `mayGrantFullAccess`, so it is held
 * there for every caller, the operator in person included.
 */
describe('mayGrantFullAccess under a managed approval ceiling', () => {
  afterEach(() => installManagedApprovalCeiling(null));
  const ceiling = (maxApprovalMode: 'ask' | 'auto' | 'never') =>
    installManagedApprovalCeiling({
      summary: {
        organization: 'Acme',
        supportUrl: null,
        lockedSettings: [],
        limits: { maxApprovalMode },
      },
    });
  const operator = () =>
    request({
      kind: 'credential',
      credential: 'c',
      authority: 'operator-credential',
      source: 'bearer',
    });
  const grantedDevice = () =>
    request({
      kind: 'credential',
      credential: 'c',
      authority: 'device-credential',
      deviceId: 'device-1',
      source: 'bearer',
    });

  test('without a ceiling the operator and a granted device may grant full access', () => {
    expect(mayGrantFullAccess(operator(), undefined)).toBe(true);
    expect(mayGrantFullAccess(grantedDevice(), FULL)).toBe(true);
  });

  for (const max of ['ask', 'auto'] as const)
    test(`a ceiling of ${max} refuses everyone, and mints no grant`, () => {
      ceiling(max);
      expect(mayGrantFullAccess(operator(), undefined)).toBe(false);
      expect(mayGrantFullAccess(grantedDevice(), FULL)).toBe(false);
      expect(fullAccessGrantFor(operator(), undefined)).toBeNull();
      expect(fullAccessGrantFor(grantedDevice(), FULL)).toBeNull();
    });

  test('a ceiling of never restricts nothing', () => {
    ceiling('never');
    expect(mayGrantFullAccess(operator(), undefined)).toBe(true);
    expect(fullAccessGrantFor(grantedDevice(), FULL)).not.toBeNull();
  });
});
