/**
 * #2893 inert foundation — the server-minted RuntimeNativeDeviceProofPrincipal.
 * Proves exact minting, the absence of any credential field, mutual exclusion
 * with the existing credential principal in both write orders, no implicit
 * inheritance by Request clone, fail-closed stale
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
} from '../runtime-request-security.js';

const approvedSurface = () => ({
  kind: 'station-native' as const,
  appIdentifier: 'io.kontourai.station',
  channel: 'stable' as const,
  clientInstanceId: '33333333-3333-4333-8333-333333333333',
  keyThumbprint: 'a'.repeat(43),
});

function nativePrincipal(
  overrides: Partial<
    Parameters<typeof setRuntimeNativeDeviceProofPrincipal>[1]
  > = {},
): Parameters<typeof setRuntimeNativeDeviceProofPrincipal>[1] {
  return {
    kind: 'native-device-proof',
    deviceId: 'dev-native-1',
    bindingId: 'binding-1',
    approvedSurface: approvedSurface(),
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
      approvedSurface: approvedSurface(),
      isCurrent: expect.any(Function),
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect('credential' in (principal ?? {})).toBe(false);
    expect('locality' in (principal ?? {})).toBe(false);
    expect('mintKind' in (principal ?? {})).toBe(false);
    expect('source' in (principal ?? {})).toBe(false);
  });

  it('refuses to replace a native principal with credential authority', () => {
    const request = new Request('http://station.test/api/x');
    setRuntimeNativeDeviceProofPrincipal(request, nativePrincipal());
    expect(() =>
      setRuntimeAuthenticatedRequestPrincipal(request, {
        credential: 'cred-1',
        authority: 'device-credential',
        source: 'bearer',
      }),
    ).toThrow();
    expect(getRuntimeNativeDeviceProofPrincipal(request)?.deviceId).toBe(
      'dev-native-1',
    );
    expect(getRuntimeAuthenticatedRequestPrincipal(request)).toBeUndefined();
  });

  it('refuses to replace a credential principal with native authority', () => {
    const request = new Request('http://station.test/api/x');
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential: 'cred-1',
      authority: 'device-credential',
      source: 'bearer',
    });
    expect(() =>
      setRuntimeNativeDeviceProofPrincipal(request, nativePrincipal()),
    ).toThrow();
    expect(getRuntimeAuthenticatedRequestPrincipal(request)?.credential).toBe(
      'cred-1',
    );
    expect(getRuntimeNativeDeviceProofPrincipal(request)).toBeUndefined();
  });

  it('copies and freezes the approved surface instead of retaining a mutable caller object', () => {
    const request = new Request('http://station.test/api/x');
    const mutable = approvedSurface();
    setRuntimeNativeDeviceProofPrincipal(
      request,
      nativePrincipal({ approvedSurface: mutable }),
    );
    (mutable as { keyThumbprint: string }).keyThumbprint = 'b'.repeat(43);
    const bound = getRuntimeNativeDeviceProofPrincipal(request);
    expect(bound?.approvedSurface.keyThumbprint).toBe('a'.repeat(43));
    expect(Object.isFrozen(bound?.approvedSurface)).toBe(true);
  });

  it('rejects a native principal that smuggles a credential field', () => {
    const request = new Request('http://station.test/api/x');
    expect(() =>
      setRuntimeNativeDeviceProofPrincipal(request, {
        ...nativePrincipal(),
        credential: 'forged',
      } as never),
    ).toThrow();
    expect(getRuntimeNativeDeviceProofPrincipal(request)).toBeUndefined();
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
