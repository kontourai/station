/**
 * #485 receiver request-claim slice — the verified delegation-grant
 * resolver is the ONLY identity a receiver claim or attempt lookup is
 * keyed by. Proves it is server-derived from the middleware-owned
 * principal (never body/user labels) and that every non-qualifying caller
 * — operator credentials, ordinary personal devices, revoked/rotated
 * grants, under-scoped grants, unauthenticated requests — resolves
 * `undefined` and can therefore never claim an attempt or look one up.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveInboundDelegationDeviceForRequest,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../runtime-request-security.js';

const OPERATE_SCOPE = 'orchestration:read orchestration:operate';

function deviceRequest(
  credential: string,
  deviceId: string | undefined,
  authority: 'device-credential' | 'operator-credential' | undefined,
) {
  const request = new Request(
    'http://station.test/api/orchestration/delegations',
  );
  if (authority !== undefined) {
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential,
      authority,
      ...(deviceId !== undefined ? { deviceId } : {}),
      source: 'bearer',
    });
  }
  return request;
}

function identify(
  devices: Record<string, { id: string; kind?: string; scope?: string } | null>,
) {
  return (credential: string) => devices[credential] ?? null;
}

describe('resolveInboundDelegationDeviceForRequest', () => {
  it('resolves the verified delegation grant with the operate scope', () => {
    const request = deviceRequest('cred-live', 'dev-1', 'device-credential');
    expect(
      resolveInboundDelegationDeviceForRequest(
        request,
        identify({
          'cred-live': {
            id: 'dev-1',
            kind: 'delegation',
            scope: OPERATE_SCOPE,
          },
        }),
      ),
    ).toEqual({ id: 'dev-1' });
  });

  it('refuses operator credentials (never a claim identity)', () => {
    const request = deviceRequest(
      'op-secret',
      undefined,
      'operator-credential',
    );
    expect(
      resolveInboundDelegationDeviceForRequest(
        request,
        identify({
          'op-secret': {
            id: 'dev-1',
            kind: 'delegation',
            scope: OPERATE_SCOPE,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('refuses ordinary personal devices', () => {
    const request = deviceRequest(
      'cred-phone',
      'dev-phone',
      'device-credential',
    );
    expect(
      resolveInboundDelegationDeviceForRequest(
        request,
        identify({
          'cred-phone': {
            id: 'dev-phone',
            kind: 'device',
            scope: OPERATE_SCOPE,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('refuses revoked grants (credential no longer resolves)', () => {
    const request = deviceRequest('cred-revoked', 'dev-1', 'device-credential');
    expect(
      resolveInboundDelegationDeviceForRequest(request, identify({})),
    ).toBeUndefined();
  });

  it('refuses rotated grants (credential resolves to a DIFFERENT device)', () => {
    const request = deviceRequest('cred-rotated', 'dev-1', 'device-credential');
    expect(
      resolveInboundDelegationDeviceForRequest(
        request,
        identify({
          'cred-rotated': {
            id: 'dev-2',
            kind: 'delegation',
            scope: OPERATE_SCOPE,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('refuses delegation grants without the operate scope', () => {
    const request = deviceRequest('cred-ro', 'dev-1', 'device-credential');
    expect(
      resolveInboundDelegationDeviceForRequest(
        request,
        identify({
          'cred-ro': {
            id: 'dev-1',
            kind: 'delegation',
            scope: 'orchestration:read',
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('refuses unauthenticated requests', () => {
    const request = deviceRequest('cred-live', 'dev-1', undefined);
    expect(
      resolveInboundDelegationDeviceForRequest(
        request,
        identify({
          'cred-live': {
            id: 'dev-1',
            kind: 'delegation',
            scope: OPERATE_SCOPE,
          },
        }),
      ),
    ).toBeUndefined();
  });
});
