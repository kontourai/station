/**
 * #3557: Station groups cap what a device tied to a person may use, through
 * the real security service every authorization reads.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test } from 'vitest';
import { nativeActiveDevice } from '../../../runtime/bootstrap/native-device-proof-runtime.js';
import { consentDecisionAuthority } from '../../../security/pairing-route-scopes.js';
import type { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { STATION_GROUPS_FILE } from '../station-groups-service.js';

// Literal: everything a device can have plus the two moderation grants.
const ADMIN_LIKE =
  'orchestration:read orchestration:operate terminal:operate access:approve consent:decide coding:exec approval:full-access';
const STANDARD = 'orchestration:read orchestration:operate terminal:operate';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

async function station(now?: () => number) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-groups-'));
  homes.push(homeDir);
  const security = new EnvironmentSecurityService({
    homeDir,
    ...(now ? { now } : {}),
  });
  await security.initialize();
  return { homeDir, security };
}

// Literal: the day before groups shipped, and the day after.
const BEFORE_GROUPS = () => Date.UTC(2026, 9, 1);
const AFTER_GROUPS = () => Date.UTC(2026, 9, 20);

function pair(
  pairing: DevicePairingService,
  name: string,
  scope: string,
  tailnetLogin?: string,
) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope,
  });
  const base = {
    requesterPosition: 'off-box' as const,
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
  };
  const request = tailnetLogin
    ? pairing.requestPairing({
        ...base,
        source: 'tailnet',
        requester: { provider: 'tailscale-serve', login: tailnetLogin },
      })
    : pairing.requestPairing(base);
  pairing.confirmRequest(
    request.requestId,
    { kind: 'presented-credential' },
    tailnetLogin
      ? {
          principalId: humanPrincipal(
            'tailscale-serve',
            tailnetLogin,
            tailnetLogin,
          ).id,
          kind: 'verified-ingress',
        }
      : undefined,
  );
  return pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
}

const person = (login: string) =>
  humanPrincipal('tailscale-serve', login, login).id;

describe('Station groups cap a device tied to a person', () => {
  test('a Member keeps Standard; every elevated grant is capped away, in every reader', async () => {
    const { security } = await station();
    const casey = pair(
      security.devicePairing,
      'Casey phone',
      ADMIN_LIKE,
      'casey@example.test',
    );

    expect(security.groupOf(person('casey@example.test'))).toBe('member');
    expect(security.resolveGrantedScope(casey.credential)).toBe(STANDARD);
    expect(security.credentialMayDecidePairingRequests(casey.credential)).toBe(
      false,
    );
    expect(security.deviceHoldsFullAccess(casey.device.id)).toBe(false);
    expect(consentDecisionAuthority(security, casey.credential)).toBeNull();
    // What it was granted is unchanged: groups cap, they never rewrite.
    expect(
      security.devicePairing.listDevices().find((d) => d.id === casey.device.id)
        ?.scope,
    ).toBe(ADMIN_LIKE);
  });

  test('an Admin uses what the device was granted, and a demotion applies on the next read', async () => {
    const { security } = await station();
    const casey = pair(
      security.devicePairing,
      'Casey phone',
      ADMIN_LIKE,
      'casey@example.test',
    );
    await security.assignGroup(person('casey@example.test'), 'admin');

    expect(security.resolveGrantedScope(casey.credential)).toBe(ADMIN_LIKE);
    expect(security.credentialMayDecidePairingRequests(casey.credential)).toBe(
      true,
    );
    expect(security.deviceHoldsFullAccess(casey.device.id)).toBe(true);
    expect(consentDecisionAuthority(security, casey.credential)).toBe(
      'device-consent-scope',
    );

    await security.assignGroup(person('casey@example.test'), 'member');
    expect(security.resolveGrantedScope(casey.credential)).toBe(STANDARD);
    expect(security.deviceHoldsFullAccess(casey.device.id)).toBe(false);
  });

  test("a device tied to no person is the operator's own and is never capped", async () => {
    const { security } = await station();
    const phone = pair(security.devicePairing, 'My phone', ADMIN_LIKE);
    expect(security.resolveGrantedScope(phone.credential)).toBe(ADMIN_LIKE);
    expect(security.credentialMayDecidePairingRequests(phone.credential)).toBe(
      true,
    );
  });

  test('a permission groups do not govern passes through untouched', async () => {
    const { security } = await station();
    const casey = pair(
      security.devicePairing,
      'Casey phone',
      `${STANDARD} relay:manage`,
      'casey@example.test',
    );
    expect(security.resolveGrantedScope(casey.credential)).toBe(
      `${STANDARD} relay:manage`,
    );
  });

  test('an unreadable groups record fails closed: everyone is a Member', async () => {
    const { homeDir, security } = await station();
    const casey = pair(
      security.devicePairing,
      'Casey phone',
      ADMIN_LIKE,
      'casey@example.test',
    );
    await security.assignGroup(person('casey@example.test'), 'admin');
    expect(security.resolveGrantedScope(casey.credential)).toBe(ADMIN_LIKE);

    writeFileSync(join(homeDir, 'security', STATION_GROUPS_FILE), '{not json');
    expect(security.resolveGrantedScope(casey.credential)).toBe(STANDARD);
  });

  test('first use seeds Admin for people whose devices already held an elevated grant, so nothing is taken away', async () => {
    const { homeDir, security } = await station(BEFORE_GROUPS);
    const casey = pair(
      security.devicePairing,
      'Casey phone',
      ADMIN_LIKE,
      'casey@example.test',
    );
    const dana = pair(
      security.devicePairing,
      'Dana laptop',
      STANDARD,
      'dana@example.test',
    );
    // As before groups shipped: no record yet.
    rmSync(join(homeDir, 'security', STATION_GROUPS_FILE), { force: true });

    const restarted = new EnvironmentSecurityService({
      homeDir,
      now: BEFORE_GROUPS,
    });
    await restarted.initialize();
    expect(restarted.groupOf(person('casey@example.test'))).toBe('admin');
    expect(restarted.groupOf(person('dana@example.test'))).toBe('member');
    expect(restarted.resolveGrantedScope(casey.credential)).toBe(ADMIN_LIKE);
    expect(restarted.resolveGrantedScope(dana.credential)).toBe(STANDARD);

    // Only on first use: the operator's later decision is not reseeded.
    await restarted.assignGroup(person('casey@example.test'), 'member');
    const again = new EnvironmentSecurityService({ homeDir });
    await again.initialize();
    expect(again.groupOf(person('casey@example.test'))).toBe('member');
  });

  test('a lost record never re-promotes anyone from a grant made after groups shipped', async () => {
    const { homeDir, security } = await station(AFTER_GROUPS);
    const casey = pair(
      security.devicePairing,
      'Casey phone',
      ADMIN_LIKE,
      'casey@example.test',
    );
    rmSync(join(homeDir, 'security', STATION_GROUPS_FILE), { force: true });
    const restarted = new EnvironmentSecurityService({
      homeDir,
      now: AFTER_GROUPS,
    });
    await restarted.initialize();
    expect(restarted.groupOf(person('casey@example.test'))).toBe('member');
    expect(restarted.resolveGrantedScope(casey.credential)).toBe(STANDARD);
  });

  test("a native request acts with the capped scope, through the runtime's device lookup", async () => {
    const { security } = await station();
    const casey = pair(
      security.devicePairing,
      'Casey phone',
      ADMIN_LIKE,
      'casey@example.test',
    );
    const phone = pair(security.devicePairing, 'My phone', ADMIN_LIKE);
    const activeDevice = nativeActiveDevice(security.devicePairing);
    expect(activeDevice(casey.device.id)?.scope).toBe(STANDARD);
    expect(activeDevice(phone.device.id)?.scope).toBe(ADMIN_LIKE);
    await security.assignGroup(person('casey@example.test'), 'admin');
    expect(activeDevice(casey.device.id)?.scope).toBe(ADMIN_LIKE);
  });

  test('only a person can be placed in a group', async () => {
    const { security } = await station();
    await expect(security.assignGroup('agent:x:y', 'admin')).rejects.toThrow();
    await expect(
      security.assignGroup(person('casey@example.test'), 'owner' as never),
    ).rejects.toThrow();
  });
});
