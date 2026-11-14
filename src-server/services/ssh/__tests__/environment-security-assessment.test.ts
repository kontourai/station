import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
} from '@kontourai/station-contracts/environment-security';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EnvironmentSecurityService } from '../environment-security-service.js';

const observations = vi.hoisted(() => ({ acquisitions: 0 }));
vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      prepareFileMutationOwner: async (
        ...args: Parameters<typeof actual.prepareFileMutationOwner>
      ) => {
        const owner = await actual.prepareFileMutationOwner(...args);
        return {
          ...owner,
          tryAcquire: () => {
            observations.acquisitions++;
            return owner.tryAcquire();
          },
        };
      },
    };
  },
);

const temporary = trackTempDirs();
afterEach(() => {
  observations.acquisitions = 0;
});

async function pairedService() {
  const home = temporary('station-route-assessment-');
  const service = new EnvironmentSecurityService({ homeDir: home });
  const operator = await service.initialize();
  const offer = service.devicePairing.createOffer({
    endpoint: 'https://station.example.test',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
  });
  const request = service.devicePairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Assessment device',
    requesterPosition: 'off-box',
  });
  service.devicePairing.confirmRequest(request.requestId, {
    kind: 'presented-credential',
  });
  const device = service.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
  return { service, operator, device };
}

const route = { method: 'GET', path: '/api/projects' };

test('one credential-route assessment resolves authorization and scope under one physical Home acquisition', async () => {
  const { service, device } = await pairedService();
  observations.acquisitions = 0;
  const open = fs.openSync;
  let tokenOpens = 0;
  const observer = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (String(args[0]).includes('.home-writer.mutation')) tokenOpens++;
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    expect(
      service.assessCredentialRoute(device.credential, route),
    ).toMatchObject({
      operator: false,
      grantedScope: PAIRING_SCOPE_ORCHESTRATION_READ,
    });
    expect(observations.acquisitions).toBe(1);
    expect(tokenOpens).toBeGreaterThan(0);
    expect(
      tokenOpens,
      'assessment Home inspections; duplicate-lookup baseline was 16',
    ).toBeLessThanOrEqual(15);
  } finally {
    observer.mockRestore();
    syncBuiltinESMExports();
  }
});

test('assessments preserve operator and device authority, observe revocation between calls, and never write activity', async () => {
  const { service, operator, device } = await pairedService();
  const before = service.identifyDevice(device.credential);
  const activity = { ...route, activity: { lastSeenFrom: 'lan' as const } };
  expect(
    service.assessCredentialRoute(operator.credential, route),
  ).toMatchObject({
    operator: true,
    grantedScope: DEFAULT_GRANT_PAIRING_SCOPE,
  });
  expect(
    service.assessCredentialRoute(device.credential, activity),
  ).toMatchObject({
    operator: false,
    grantedScope: PAIRING_SCOPE_ORCHESTRATION_READ,
  });
  for (const restricted of [
    { method: 'POST', path: '/api/environments/peers' },
    { method: 'GET', path: '/api/pairing/devices' },
    { method: 'POST', path: '/api/pairing/offers' },
  ]) {
    expect(
      service.assessCredentialRoute(device.credential, restricted),
    ).toBeUndefined();
  }
  expect(service.identifyDevice(device.credential)).toEqual(before);
  expect(
    service.assessCredentialRoute('unknown-credential', route),
  ).toBeUndefined();
  expect(service.authorizeCredential('unknown-credential', route)).toBe(false);
  service.devicePairing.revokeDevice(device.device.id, 'operator-credential');
  expect(
    service.assessCredentialRoute(device.credential, route),
  ).toBeUndefined();
});
