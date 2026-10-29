/**
 * `pairedDevicePrincipal` claims to be the principal a request on the
 * device's own credential resolves to. Background work (notification focus
 * and audience, the agent-activity reader) relies on that claim, so it is
 * pinned against the real request resolver for every personal device shape:
 * a local-grant (home-possession) desktop, an unbound pairing-code phone,
 * and a tailnet-bound person's phone.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import {
  createOrchestrationRequestPrincipalResolver,
  pairedDevicePrincipal,
} from '../orchestration-request-principal.js';

const makeTempDir = trackTempDirs();

function pair(
  pairing: DevicePairingService,
  name: string,
  options: { localGrant?: boolean; tailnetLogin?: string } = {},
) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope: DEFAULT_GRANT_PAIRING_SCOPE,
    kind: 'device',
  });
  const base = {
    requesterPosition: 'off-box' as const,
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
  };
  const request = options.tailnetLogin
    ? pairing.requestPairing({
        ...base,
        source: 'tailnet',
        requester: { provider: 'tailscale-serve', login: options.tailnetLogin },
      })
    : pairing.requestPairing(base);
  pairing.confirmRequest(
    request.requestId,
    options.localGrant
      ? { kind: 'local-grant' }
      : { kind: 'presented-credential' },
    options.tailnetLogin
      ? { principalId: LOCAL_OPERATOR_PRINCIPAL_ID, kind: 'verified-ingress' }
      : undefined,
  );
  return pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
    ...(options.localGrant
      ? {
          locality: 'home-possession' as const,
          mintKind: 'local-grant' as const,
        }
      : {}),
  });
}

describe('pairedDevicePrincipal matches the request resolver', () => {
  function setup() {
    const homeDir = makeTempDir('paired-device-principal-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '44444444-4444-4444-8444-444444444444',
    });
    const resolve = createOrchestrationRequestPrincipalResolver({
      environmentSecurityService: {
        identifyDevice: (credential) => pairing.identifyDevice(credential),
      },
    });
    /** A request on the credential, stamped the way the auth middleware does. */
    const requestPrincipal = (credential: string) => {
      const raw = new Request('http://station.test/api/orchestration/sessions');
      const device = pairing.identifyDevice(credential)!;
      const locality = pairing.credentialLocality(credential);
      setRuntimeAuthenticatedRequestPrincipal(raw, {
        kind: 'credential',
        credential,
        authority: 'device-credential',
        deviceId: device.id,
        deviceKind: 'device',
        source: 'bearer',
        ...(locality ? { locality } : {}),
      });
      return resolve({ env: {}, req: { raw, header: () => undefined } });
    };
    return { pairing, requestPrincipal };
  }

  test.each([
    [
      'a local-grant desktop',
      { localGrant: true },
      LOCAL_OPERATOR_PRINCIPAL_ID,
    ],
    ['an unbound pairing-code phone', {}, undefined],
    ['a tailnet-bound phone', { tailnetLogin: 'housemate@github' }, undefined],
  ] as const)('%s', (label, options, expected) => {
    const { pairing, requestPrincipal } = setup();
    const paired = pair(pairing, label, options);
    const fromRequest = requestPrincipal(paired.credential);
    const background = pairedDevicePrincipal(
      paired.device,
      pairing.deviceLocality(paired.device.id),
    );
    expect(background.id).toBe(fromRequest.id);
    if (expected) expect(background.id).toBe(expected);
    else expect(background.id).not.toBe(LOCAL_OPERATOR_PRINCIPAL_ID);
  });
});
