/**
 * #3568: who may still send a chat message a held follow-up recorded, through
 * the real security service: a paired device or a personal access token, by
 * id, live and holding the scope the live `POST /api/orchestration/chat`
 * route requires.
 */
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { DevicePairingService } from '../device-pairing-service.js';
import { EnvironmentSecurityService } from '../environment-security-service.js';

const STANDARD = 'orchestration:read orchestration:operate terminal:operate';
const makeTempDir = trackTempDirs();

async function station() {
  const homeDir = makeTempDir('station-may-send-');
  let clock = Date.UTC(2026, 9, 20);
  const security = new EnvironmentSecurityService({
    homeDir,
    now: () => clock,
  });
  await security.initialize();
  return {
    security,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function pair(pairing: DevicePairingService, login: string, scope: string) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope,
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

describe('deviceMaySendChat (#3568)', () => {
  test('a paired device holding the scope may; once revoked it may not', async () => {
    const { security } = await station();
    const casey = pair(security.devicePairing, 'casey', STANDARD);
    expect(security.deviceMaySendChat(casey.device.id)).toBe(true);
    security.devicePairing.revokeDevice(casey.device.id, 'operator-credential');
    expect(security.deviceMaySendChat(casey.device.id)).toBe(false);
  });

  test('a device whose grant lacks the route scope may not, including one narrowed after pairing', async () => {
    const { security } = await station();
    const reader = pair(security.devicePairing, 'robin', 'orchestration:read');
    expect(security.deviceMaySendChat(reader.device.id)).toBe(false);

    const casey = pair(security.devicePairing, 'casey', STANDARD);
    expect(security.deviceMaySendChat(casey.device.id)).toBe(true);
    security.devicePairing.setDeviceScope(
      casey.device.id,
      ['orchestration:read'],
      { kind: 'presented-credential' },
    );
    expect(security.deviceMaySendChat(casey.device.id)).toBe(false);
  });

  test('a personal access token holding the scope may, until it is revoked or expires', async () => {
    const { security, advance } = await station();
    const casey = pair(security.devicePairing, 'casey', STANDARD);
    const lasting = await security.devicePairing.mintPersonalToken({
      name: 'script',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read orchestration:operate',
      expiresAt: null,
    });
    expect(security.deviceMaySendChat(lasting.token.id)).toBe(true);
    await security.devicePairing.revokePersonalToken(lasting.token.id);
    expect(security.deviceMaySendChat(lasting.token.id)).toBe(false);

    const brief = await security.devicePairing.mintPersonalToken({
      name: 'brief',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read orchestration:operate',
      expiresAt: Date.UTC(2026, 9, 21),
    });
    expect(security.deviceMaySendChat(brief.token.id)).toBe(true);
    advance(2 * 24 * 60 * 60 * 1000);
    expect(security.deviceMaySendChat(brief.token.id)).toBe(false);
  });

  test('a read-only token may not, and an unknown id may not', async () => {
    const { security } = await station();
    const casey = pair(security.devicePairing, 'casey', STANDARD);
    const readOnly = await security.devicePairing.mintPersonalToken({
      name: 'reader',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read',
      expiresAt: null,
    });
    expect(security.deviceMaySendChat(readOnly.token.id)).toBe(false);
    expect(security.deviceMaySendChat('no-such-credential')).toBe(false);
  });
});
