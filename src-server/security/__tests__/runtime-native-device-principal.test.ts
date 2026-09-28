/**
 * #2893 inert foundation — the server-minted RuntimeNativeDeviceProofPrincipal.
 * Proves exact minting, the absence of any credential field, mutual exclusion
 * with the existing credential principal in both write orders, no implicit
 * inheritance by Request clone, explicit trusted transfer, fail-closed stale
 * `isCurrent`, and that the existing credential-only helpers refuse native
 * authority.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  getRuntimeNativeDeviceProofPrincipal,
  isRuntimeNativeDeviceProofCurrent,
  resolveInboundDelegationDeviceForRequest,
  setRuntimeAuthenticatedRequestPrincipal,
  setRuntimeNativeDeviceProofPrincipal,
  transferRuntimeNativeDeviceProofPrincipal,
} from '../runtime-request-security.js';

function nativePrincipal(
  overrides: Partial<
    Parameters<typeof setRuntimeNativeDeviceProofPrincipal>[1]
  > = {},
): Parameters<typeof setRuntimeNativeDeviceProofPrincipal>[1] {
  return {
    kind: 'native-device-proof',
    deviceId: 'dev-native-1',
    bindingId: 'binding-1',
    approvedSurface: 'macos-shell',
    isCurrent: () => true,
    ...overrides,
  };
}

describe('RuntimeNativeDeviceProofPrincipal', () => {
  it('mints the exact typed principal with no credential field', () => {
    const request = new Request('http://station.test/api/system/identity');
    setRuntimeNativeDeviceProofPrincipal(request, nativePrincipal());
    const principal = getRuntimeNativeDeviceProofPrincipal(request);
    expect(principal).toEqual({
      kind: 'native-device-proof',
      deviceId: 'dev-native-1',
      bindingId: 'binding-1',
      approvedSurface: 'macos-shell',
      isCurrent: expect.any(Function),
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect('credential' in (principal ?? {})).toBe(false);
    expect('locality' in (principal ?? {})).toBe(false);
    expect('mintKind' in (principal ?? {})).toBe(false);
    expect('source' in (principal ?? {})).toBe(false);
  });

  it('is mutually exclusive with the credential principal (native first)', () => {
    const request = new Request('http://station.test/api/x');
    setRuntimeNativeDeviceProofPrincipal(request, nativePrincipal());
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential: 'cred-1',
      authority: 'device-credential',
      source: 'bearer',
    });
    expect(getRuntimeNativeDeviceProofPrincipal(request)).toBeUndefined();
    expect(getRuntimeAuthenticatedRequestPrincipal(request)?.credential).toBe(
      'cred-1',
    );
  });

  it('is mutually exclusive with the credential principal (credential first)', () => {
    const request = new Request('http://station.test/api/x');
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential: 'cred-1',
      authority: 'device-credential',
      source: 'bearer',
    });
    setRuntimeNativeDeviceProofPrincipal(request, nativePrincipal());
    expect(getRuntimeAuthenticatedRequestPrincipal(request)).toBeUndefined();
    expect(getRuntimeNativeDeviceProofPrincipal(request)?.deviceId).toBe(
      'dev-native-1',
    );
  });

  it('does not let a cloned Request inherit the native principal', () => {
    const request = new Request('http://station.test/api/x', {
      headers: { authorization: 'Bearer forged' },
    });
    setRuntimeNativeDeviceProofPrincipal(request, nativePrincipal());
    const clone = request.clone();
    expect(getRuntimeNativeDeviceProofPrincipal(clone)).toBeUndefined();
    expect(isRuntimeNativeDeviceProofCurrent(clone)).toBe(false);
  });

  it('transfers the principal only on the explicit trusted call and removes it from the source', () => {
    const original = new Request('http://station.test/api/x');
    setRuntimeNativeDeviceProofPrincipal(original, nativePrincipal());
    const replacement = new Request('http://station.test/api/x');
    expect(
      transferRuntimeNativeDeviceProofPrincipal(original, replacement),
    ).toBe(true);
    expect(getRuntimeNativeDeviceProofPrincipal(original)).toBeUndefined();
    expect(getRuntimeNativeDeviceProofPrincipal(replacement)?.bindingId).toBe(
      'binding-1',
    );
    expect(isRuntimeNativeDeviceProofCurrent(replacement)).toBe(true);
  });

  it('refuses transfer when no native principal is bound', () => {
    const a = new Request('http://station.test/api/x');
    const b = new Request('http://station.test/api/x');
    expect(transferRuntimeNativeDeviceProofPrincipal(a, b)).toBe(false);
    expect(getRuntimeNativeDeviceProofPrincipal(b)).toBeUndefined();
  });

  it('fails closed when the isCurrent recheck reports stale', () => {
    const request = new Request('http://station.test/api/x');
    setRuntimeNativeDeviceProofPrincipal(
      request,
      nativePrincipal({ isCurrent: () => false }),
    );
    expect(isRuntimeNativeDeviceProofCurrent(request)).toBe(false);
  });

  it('fails closed when the isCurrent recheck throws', () => {
    const request = new Request('http://station.test/api/x');
    setRuntimeNativeDeviceProofPrincipal(
      request,
      nativePrincipal({
        isCurrent: () => {
          throw new Error('binding store unavailable');
        },
      }),
    );
    expect(isRuntimeNativeDeviceProofCurrent(request)).toBe(false);
  });

  it('fails closed without a principal', () => {
    expect(
      isRuntimeNativeDeviceProofCurrent(
        new Request('http://station.test/api/x'),
      ),
    ).toBe(false);
  });

  it('existing credential-only helpers refuse native authority', () => {
    const request = new Request(
      'http://station.test/api/orchestration/delegations',
    );
    setRuntimeNativeDeviceProofPrincipal(request, nativePrincipal());
    const identifyDevice = vi.fn(() => ({
      id: 'dev-native-1',
      kind: 'delegation',
      scope: 'orchestration:read orchestration:operate',
    }));
    expect(
      resolveInboundDelegationDeviceForRequest(request, identifyDevice),
    ).toBeUndefined();
    expect(identifyDevice).not.toHaveBeenCalled();
    // No credential principal ever materialized for the native request.
    expect(getRuntimeAuthenticatedRequestPrincipal(request)).toBeUndefined();
  });
});
