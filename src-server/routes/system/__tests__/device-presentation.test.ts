// @vitest-environment node

import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  bindRuntimeLocalOperator,
  type RuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { resolveDevicePresentation } from '../device-presentation.js';

/**
 * The derivation, per locality (station#3843 §1 proof).
 *
 * Every case goes through `bindRuntimeLocalOperator` — the auth boundary's
 * ONE write — rather than reaching into the projection with a hand-made
 * flag, so a change that made the projection read something else (the
 * socket, the proxy stamp, the credential authority) fails here.
 */

const localGrant: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'local-grant-device',
  authority: 'device-credential',
  source: 'session',
  pairingSource: 'same-origin',
  locality: 'home-possession',
  mintKind: 'local-grant',
};

const uiBootstrap: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'ui-bootstrap-device',
  authority: 'device-credential',
  source: 'session',
  pairingSource: 'same-origin',
  locality: 'home-possession',
  mintKind: 'ui-bootstrap',
};

/**
 * The operator credential is the E2E paired context and the reason this
 * projection cannot key on the socket: it is presented over LOOPBACK by a
 * browser on the host machine, and it still is not home possession.
 */
const operator: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'operator',
  authority: 'operator-credential',
  source: 'bearer',
};

const accessRequestSameOrigin: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'access-request-device',
  authority: 'device-credential',
  source: 'session',
  pairingSource: 'same-origin',
};

const pairedPhone: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'paired-phone',
  authority: 'device-credential',
  source: 'session',
  pairingSource: 'pairing-code',
};

function boundRequest(
  principal: RuntimeAuthenticatedRequestPrincipal | undefined,
  url = 'http://127.0.0.1:3141/api/system/status',
): Request {
  const request = new Request(url);
  if (principal) bindRuntimeLocalOperator(request, principal);
  return request;
}

describe('devicePresentation — derived from the bound locality fact', () => {
  it('a local-grant credential reads as the host', () => {
    expect(
      resolveDevicePresentation(boundRequest(localGrant)).deviceClass,
    ).toBe('host');
  });

  it('a UI-bootstrap credential reads as the host', () => {
    expect(
      resolveDevicePresentation(boundRequest(uiBootstrap)).deviceClass,
    ).toBe('host');
  });

  it('an operator credential on loopback reads as paired', () => {
    // The discriminating case: same machine, same socket, no possession
    // proof. A projection derived from the socket answers `host` here.
    expect(resolveDevicePresentation(boundRequest(operator)).deviceClass).toBe(
      'paired',
    );
  });

  it('a same-origin credential minted via access-request reads as paired', () => {
    expect(
      resolveDevicePresentation(boundRequest(accessRequestSameOrigin))
        .deviceClass,
    ).toBe('paired');
  });

  it('a pairing-code device reads as paired', () => {
    expect(
      resolveDevicePresentation(boundRequest(pairedPhone)).deviceClass,
    ).toBe('paired');
  });

  it('a request the boundary never bound fails closed to paired', () => {
    expect(resolveDevicePresentation(boundRequest(undefined)).deviceClass).toBe(
      'paired',
    );
  });

  it('does not vary with the request URL the caller reached it through', () => {
    // `hostName` is read from the host machine. A caller-controlled Host
    // header or URL must not be able to rename the machine on screen.
    const viaTailnet = resolveDevicePresentation(
      boundRequest(
        pairedPhone,
        'https://impostor.example.test/api/system/status',
      ),
    );
    expect(viaTailnet.hostName).not.toBe('impostor.example.test');
    expect(viaTailnet.hostName).toBe(hostname().split('.')[0]);
  });

  it('names the host machine in both classes', () => {
    const expected = hostname().split('.')[0];
    expect(resolveDevicePresentation(boundRequest(localGrant)).hostName).toBe(
      expected,
    );
    expect(resolveDevicePresentation(boundRequest(pairedPhone)).hostName).toBe(
      expected,
    );
  });
});
