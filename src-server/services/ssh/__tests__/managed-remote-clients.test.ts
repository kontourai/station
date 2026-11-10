/**
 * #4519: under a managed policy whose `limits.clients` leaves out `remote`,
 * the security service the HTTP boundary authorizes through issues and
 * accepts only home-possession credentials. Devices paired before the policy
 * stop authenticating without being revoked, so lifting the limit restores
 * them.
 *
 * Every case pairs on one service (no limit) and then reopens the same home
 * with the limit, the way a restart after installing the policy does.
 */
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  DevicePairingError,
  type DevicePairingService,
} from '../device-pairing-service.js';
import { EnvironmentSecurityService } from '../environment-security-service.js';

const STANDARD = 'orchestration:read orchestration:operate terminal:operate';
const CODE = 'managed-policy-remote-clients';
const makeTempDir = trackTempDirs();
/** A route any paired credential may call: the boundary still decides. */
const READ = { method: 'GET', path: '/api/orchestration/sessions' };

async function open(homeDir: string, localClientsOnly: boolean) {
  const security = new EnvironmentSecurityService({
    homeDir,
    localClientsOnly,
  });
  const { credential } = await security.initialize();
  return { security, operator: credential };
}

/** A phone paired over the tailnet: an ordinary device credential. */
function pairPhone(pairing: DevicePairingService, login: string) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope: STANDARD,
  });
  const request = pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: `${login} phone`,
    source: 'tailnet',
    requester: { provider: 'tailscale-serve', login },
  });
  pairing.confirmRequest(
    request.requestId,
    { kind: 'presented-credential' },
    {
      principalId: humanPrincipal('tailscale-serve', login, login).id,
      kind: 'verified-ingress',
    },
  );
  return pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
}

/** The desktop app's mint: the same calls the local-grant route makes. */
function localGrant(pairing: DevicePairingService) {
  const offer = pairing.createOffer({
    endpoint: 'http://127.0.0.1:43141',
    homePossession: true,
  });
  const request = pairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Station desktop',
    source: 'same-origin',
    requesterPosition: 'unproven',
  });
  pairing.confirmRequest(request.requestId, { kind: 'local-grant' });
  return pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
}

function refusalCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof DevicePairingError ? error.code : String(error);
  }
  return undefined;
}

describe('managed limit without remote clients (#4519)', () => {
  test('a device paired before the policy is signed out; the desktop and the operator are not; lifting the limit restores it', async () => {
    const homeDir = makeTempDir('station-managed-clients-');
    const before = await open(homeDir, false);
    const phone = pairPhone(before.security.devicePairing, 'casey');
    const desktop = localGrant(before.security.devicePairing);
    const token = await before.security.devicePairing.mintPersonalToken({
      name: 'script',
      binding: phone.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read',
      expiresAt: null,
    });
    before.security.devicePairing.setPushSubscription(phone.device.id, {
      endpoint: 'https://push.example.test/casey',
      keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    });
    // Baseline: all of them authenticate without the limit.
    for (const credential of [
      phone.credential,
      desktop.credential,
      token.secret,
    ])
      expect(before.security.authorizeCredential(credential, READ)).toBe(true);
    expect(before.security.devicePairing.listPushSubscriptions()).toHaveLength(
      1,
    );

    const managed = await open(homeDir, true);
    expect(managed.security.authorizeCredential(phone.credential, READ)).toBe(
      false,
    );
    expect(managed.security.verifyCredential(phone.credential)).toBe(false);
    expect(managed.security.identifyDevice(phone.credential)).toBeNull();
    expect(managed.security.authorizeCredential(token.secret, READ)).toBe(
      false,
    );
    expect(managed.security.identifyDevice(token.secret)).toBeNull();
    // No push delivery to a signed-out device.
    expect(managed.security.devicePairing.listPushSubscriptions()).toEqual([]);
    // Still listed, so the operator can see and revoke it.
    expect(
      managed.security.devicePairing
        .listDevices()
        .some((device) => device.id === phone.device.id),
    ).toBe(true);
    // This machine keeps working.
    expect(managed.security.authorizeCredential(desktop.credential, READ)).toBe(
      true,
    );
    expect(managed.security.authorizeCredential(managed.operator, READ)).toBe(
      true,
    );

    const lifted = await open(homeDir, false);
    expect(lifted.security.authorizeCredential(phone.credential, READ)).toBe(
      true,
    );
    expect(lifted.security.authorizeCredential(token.secret, READ)).toBe(true);
  });

  test('pairing offers, access requests and personal tokens are refused; the home-possession mint is not', async () => {
    const homeDir = makeTempDir('station-managed-clients-');
    const { security } = await open(homeDir, true);
    const pairing = security.devicePairing;
    expect(
      refusalCode(() =>
        pairing.createOffer({ endpoint: 'https://station.example.test' }),
      ),
    ).toBe(CODE);
    expect(
      refusalCode(() =>
        pairing.requestAccess({
          endpoint: 'http://127.0.0.1:43141',
          deviceName: 'Browser',
          requesterPosition: 'unproven',
          source: 'same-origin',
        }),
      ),
    ).toBe(CODE);
    await expect(
      pairing.mintPersonalToken({
        name: 'script',
        binding: { kind: 'tailnet', login: 'casey' } as never,
        ownerPrincipalId: 'human:tailscale-serve:casey',
        scope: 'orchestration:read',
        expiresAt: null,
      }),
    ).rejects.toMatchObject({ code: CODE });

    // A caller that claims home possession for its offer must still mint
    // with it: the exchange holds it to that.
    const offer = pairing.createOffer({
      endpoint: 'http://127.0.0.1:43141',
      homePossession: true,
    });
    const request = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Not really local',
      source: 'same-origin',
      requesterPosition: 'unproven',
    });
    pairing.confirmRequest(request.requestId, { kind: 'local-grant' });
    expect(
      refusalCode(() =>
        pairing.exchange({
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: request.requestId,
        }),
      ),
    ).toBe(CODE);

    const desktop = localGrant(pairing);
    expect(security.authorizeCredential(desktop.credential, READ)).toBe(true);
  });
});
