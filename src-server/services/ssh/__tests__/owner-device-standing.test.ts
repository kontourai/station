/**
 * Owner-device standing (owner decision 2026-11-02): on a personal Station,
 * the owner's own paired devices that already have a host shell act as the
 * owner. These tests drive the real pairing store and environment security
 * service, so each case is a device minted the way production mints it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_SCOPE_ACCESS_MANAGE,
  pairingScopeIncludes,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { afterEach, describe, expect, test } from 'vitest';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../../runtime/bootstrap/hosted-tenant-mode.js';
import { EnvironmentSecurityService } from '../environment-security-service.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

async function station(environment: NodeJS.ProcessEnv = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-owner-standing-'));
  homes.push(homeDir);
  const security = new EnvironmentSecurityService({ homeDir, environment });
  await security.initialize();
  const pairing = security.devicePairing;
  const pair = (
    scope: string,
    extra: {
      kind?: 'device' | 'delegation';
      locality?: 'home-possession';
      mintKind?: 'local-grant' | 'ui-bootstrap';
    } = {},
  ) => {
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope,
      ...(extra.kind ? { kind: extra.kind } : {}),
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Phone',
    });
    pairing.confirmRequest(request.requestId, { kind: 'presented-credential' });
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
      ...(extra.locality ? { locality: extra.locality } : {}),
      ...(extra.mintKind ? { mintKind: extra.mintKind } : {}),
    });
  };
  return { security, pairing, pair };
}

describe('owner-device standing', () => {
  test('a standard device the owner paired acts as the owner', async () => {
    const { security, pairing, pair } = await station();
    const phone = pair(pairingScopePresetString('standard'));

    expect(security.credentialHasOwnerStanding(phone.credential)).toBe(true);
    expect(security.deviceHasOwnerStanding(phone.device.id)).toBe(true);
    // Same standing as the host launcher browser: pairing management.
    expect(pairing.credentialMayManagePairing(phone.credential)).toBe(true);
    // The access:manage route tier is derived, never stored.
    const granted = security.resolveGrantedScope(phone.credential)!;
    expect(pairingScopeIncludes(granted, PAIRING_SCOPE_ACCESS_MANAGE)).toBe(
      true,
    );
    expect(pairing.listDevices().find((d) => d.id === phone.device.id)?.scope)
      .toBe(pairingScopePresetString('standard'));
  });

  test('a device without a host shell never holds it', async () => {
    const { security, pairing, pair } = await station();
    for (const scope of [
      pairingScopePresetString('read-only'),
      pairingScopePresetString('inference'),
    ]) {
      const device = pair(scope);
      expect(security.credentialHasOwnerStanding(device.credential), scope)
        .toBe(false);
      expect(pairing.credentialMayManagePairing(device.credential), scope)
        .toBe(false);
      expect(
        pairingScopeIncludes(
          security.resolveGrantedScope(device.credential)!,
          PAIRING_SCOPE_ACCESS_MANAGE,
        ),
        scope,
      ).toBe(false);
    }
  });

  test("a peer Station's delegation never holds it", async () => {
    const { security, pair } = await station();
    const peer = pair(pairingScopePresetString('delegation'), {
      kind: 'delegation',
    });
    expect(security.credentialHasOwnerStanding(peer.credential)).toBe(false);
  });

  test('a home-possession credential is the operator in person, not an owner device', async () => {
    const { security, pair } = await station();
    const desktop = pair(pairingScopePresetString('standard'), {
      locality: 'home-possession',
      mintKind: 'local-grant',
    });
    expect(security.credentialHasOwnerStanding(desktop.credential)).toBe(
      false,
    );
  });

  test('revoking or narrowing the device removes it on the next check', async () => {
    const { security, pairing, pair } = await station();
    const revoked = pair(pairingScopePresetString('standard'));
    const narrowed = pair(pairingScopePresetString('standard'));
    expect(security.credentialHasOwnerStanding(revoked.credential)).toBe(true);
    expect(security.credentialHasOwnerStanding(narrowed.credential)).toBe(
      true,
    );

    pairing.revokeDevice(revoked.device.id, 'operator-credential');
    pairing.setDeviceScope(narrowed.device.id, ['orchestration:read'], {
      kind: 'presented-credential',
    });

    expect(security.credentialHasOwnerStanding(revoked.credential)).toBe(
      false,
    );
    expect(security.credentialHasOwnerStanding(narrowed.credential)).toBe(
      false,
    );
    expect(security.deviceHasOwnerStanding(narrowed.device.id)).toBe(false);
  });

  test('a hosted tenant never grants it', async () => {
    const { security, pairing, pair } = await station({
      [HOSTED_TENANT_REGISTRY_FILE_ENV]: '/nonexistent/tenants.json',
    });
    const phone = pair(pairingScopePresetString('standard'));
    expect(security.credentialHasOwnerStanding(phone.credential)).toBe(false);
    expect(pairing.credentialMayManagePairing(phone.credential)).toBe(false);
    expect(
      pairingScopeIncludes(
        security.resolveGrantedScope(phone.credential)!,
        PAIRING_SCOPE_ACCESS_MANAGE,
      ),
    ).toBe(false);
  });

  test('an owner device creates pre-approved phone offers but never a delegation or protected scope', async () => {
    const { pairing, pair } = await station();
    const phone = pair(pairingScopePresetString('standard'));
    expect(pairing.credentialMayManagePairing(phone.credential)).toBe(true);
    // The service refuses protected promotion on a pre-approved offer for
    // every caller; the route adds the host-browser refusals on top.
    expect(() =>
      pairing.createOffer({
        endpoint: 'https://station.example.test',
        scope: 'orchestration:read access:approve',
        approval: 'on-create',
      }),
    ).toThrow();
    expect(() =>
      pairing.createOffer({
        endpoint: 'https://station.example.test',
        kind: 'delegation',
        approval: 'on-create',
      }),
    ).toThrow();
  });
});
