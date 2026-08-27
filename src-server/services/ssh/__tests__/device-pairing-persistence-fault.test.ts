import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DevicePairingService,
  type PairingApproval,
} from '../device-pairing-service.js';

/**
 * station#3277: the persist-before-mutate contract on the four clone-and-swap
 * mutation paths (exchange, revokeDevice, removeRevokedDevice,
 * recordCredentialActivity — each builds a next registry, persists it, and
 * only then swaps it into memory) is proven elsewhere by revoking write
 * permission on the security directory,
 * which some hosts cannot express — Windows maps chmod onto the read-only
 * attribute (creating and renaming inside the directory still succeeds) and
 * root bypasses modes entirely, so those tests are correctly skipped there.
 *
 * That left the fault path unproven on the one platform whose write path
 * actually diverges: `#persistRegistry` skips `fchmodSync` on win32, and a
 * transiently locked registry (antivirus, backup) is a win32-shaped failure.
 *
 * Faulting the syscall itself is portable, so that is what this pins. The
 * mock delegates to the real `node:fs` and fails only the durable rename,
 * which is the last step of the temp-file-then-rename write and therefore the
 * point where a partially applied mutation would become observable.
 *
 * Scope: station#3324 brought the remaining `#persistRegistry` callers onto
 * the same contract, so every mutation path is exercised here. The one
 * deliberate asymmetry is the `lastUsedAt` touch, which sits on a READ path
 * (verifyCredential/identifyDevice): it persists before mutating like the
 * rest, but swallows a write failure instead of propagating it, because a
 * transiently unwritable registry must not turn credential verification into
 * a thrown error. That behaviour has its own test below.
 */
const renameFault = vi.hoisted(() => ({ armed: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: never, to: never) => {
      if (renameFault.armed) {
        const error = new Error(
          `EACCES: permission denied, rename '${String(from)}' -> '${String(to)}'`,
        ) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return actual.renameSync(from, to);
    },
  };
});

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_APPROVAL: PairingApproval = { kind: 'presented-credential' };
const CLIENT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

// Mirrors the service's own bounded write cadence for lastUsedAt; the test
// only needs to move the clock past it.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

let homeDir: string;
let service: DevicePairingService;
let clock: number;

function advanceClock(ms: number) {
  clock += ms;
}

function pair(name: string, clientInstanceId?: string) {
  const offer = service.createOffer({
    endpoint: 'https://station.example.test',
  });
  const request = service.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
    clientInstanceId,
  });
  service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
  return {
    offer,
    request,
    result: service.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
      clientInstanceId,
    }),
  };
}

describe('device pairing persistence faults (portable seam, station#3277/#3324)', () => {
  beforeEach(() => {
    renameFault.armed = false;
    homeDir = mkdtempSync(join(tmpdir(), 'station-pairing-fault-'));
    mkdirSync(join(homeDir, 'security'), { recursive: true });
    clock = 1_000;
    service = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
      now: () => clock,
    });
  });

  afterEach(() => {
    renameFault.armed = false;
    rmSync(homeDir, { recursive: true, force: true });
  });

  function registryContents(): string {
    return readFileSync(
      join(homeDir, 'security', 'paired-devices.json'),
      'utf8',
    );
  }

  test('a persistence fault leaves a same-instance replacement entirely unapplied', () => {
    const original = pair('Original phone', CLIENT_INSTANCE_ID).result;
    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Replacement phone',
      clientInstanceId: CLIENT_INSTANCE_ID,
    });
    service.confirmRequest(request.requestId, OPERATOR_APPROVAL);

    renameFault.armed = true;
    try {
      expect(() =>
        service.exchange({
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: request.requestId,
          clientInstanceId: CLIENT_INSTANCE_ID,
        }),
      ).toThrow(/EACCES/);
    } finally {
      renameFault.armed = false;
    }

    expect(service.verifyCredential(original.credential)).toBe(true);
    expect(service.listDevices()).toEqual([
      expect.objectContaining({ id: original.device.id, revokedAt: null }),
    ]);
    expect(registryContents()).not.toContain('Replacement phone');
  });

  test('persists revocation before changing live state, so failure, retry, and restart agree', () => {
    const paired = pair('Brian phone').result;

    renameFault.armed = true;
    try {
      expect(() =>
        service.revokeDevice(paired.device.id, 'operator-credential'),
      ).toThrow(/EACCES/);
    } finally {
      renameFault.armed = false;
    }
    expect(service.verifyCredential(paired.credential)).toBe(true);

    service.revokeDevice(paired.device.id, 'operator-credential');
    expect(service.verifyCredential(paired.credential)).toBe(false);
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(restarted.verifyCredential(paired.credential)).toBe(false);
  });

  test('persists activity before changing live state, so failure, retry, and restart agree', () => {
    const paired = pair('Brian phone').result;

    renameFault.armed = true;
    try {
      expect(() =>
        service.recordCredentialActivity(paired.credential, 'lan'),
      ).toThrow(/EACCES/);
    } finally {
      renameFault.armed = false;
    }
    expect(service.identifyDevice(paired.credential)?.usageCount).toBe(0);

    expect(service.recordCredentialActivity(paired.credential, 'lan')).toBe(
      true,
    );
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(restarted.identifyDevice(paired.credential)).toMatchObject({
      usageCount: 1,
      lastSeenFrom: 'lan',
    });
  });

  test('persists tombstone removal before changing live state', () => {
    // The fourth clone-and-swap replacement path, and the one the chmod
    // tests never covered on any platform.
    const paired = pair('Brian phone').result;
    service.revokeDevice(paired.device.id, 'operator-credential');

    renameFault.armed = true;
    try {
      expect(() =>
        service.removeRevokedDevice(paired.device.id, 'operator-credential'),
      ).toThrow(/EACCES/);
    } finally {
      renameFault.armed = false;
    }
    expect(service.listDevices().map((device) => device.id)).toEqual([
      paired.device.id,
    ]);
    expect(registryContents()).toContain(paired.device.id);

    service.removeRevokedDevice(paired.device.id, 'operator-credential');
    expect(service.listDevices()).toEqual([]);
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(restarted.listDevices()).toEqual([]);
  });

  test('persists an approval-authority grant before changing live state', () => {
    const paired = pair('Brian phone').result;

    renameFault.armed = true;
    try {
      expect(() =>
        service.setDeviceApprovalAuthority(
          paired.device.id,
          true,
          OPERATOR_APPROVAL,
        ),
      ).toThrow(/EACCES/);
    } finally {
      renameFault.armed = false;
    }
    // Authority the disk never accepted must not be live in this process:
    // otherwise a restart silently withdraws a grant the operator was told
    // had been made.
    expect(service.credentialMayApprovePairing(paired.credential)).toBe(false);

    service.setDeviceApprovalAuthority(
      paired.device.id,
      true,
      OPERATOR_APPROVAL,
    );
    expect(service.credentialMayApprovePairing(paired.credential)).toBe(true);
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(restarted.credentialMayApprovePairing(paired.credential)).toBe(true);
  });

  test('persists a push subscription, and its removal, before changing live state', () => {
    const paired = pair('Brian phone').result;
    const subscription = {
      endpoint: 'https://push.example.test/subscription/abc',
      keys: { p256dh: 'p256dh-key-value', auth: 'auth-key-value' },
    };

    renameFault.armed = true;
    try {
      expect(() =>
        service.setPushSubscription(paired.device.id, subscription),
      ).toThrow(/EACCES/);
    } finally {
      renameFault.armed = false;
    }
    expect(service.listPushSubscriptions()).toEqual([]);

    service.setPushSubscription(paired.device.id, subscription);
    expect(service.listPushSubscriptions()).toHaveLength(1);

    // Clearing is the direction revocation depends on: a subscription must
    // never survive its device record, which is only as durable as this write.
    renameFault.armed = true;
    try {
      expect(() => service.clearPushSubscription(paired.device.id)).toThrow(
        /EACCES/,
      );
    } finally {
      renameFault.armed = false;
    }
    expect(service.listPushSubscriptions()).toHaveLength(1);
    expect(registryContents()).toContain('p256dh-key-value');

    service.clearPushSubscription(paired.device.id);
    expect(service.listPushSubscriptions()).toEqual([]);
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(restarted.listPushSubscriptions()).toEqual([]);
  });

  test('persists an environment reset before adopting it', () => {
    const paired = pair('Brian phone').result;

    renameFault.armed = true;
    try {
      expect(() =>
        service.resetEnvironment('33333333-3333-4333-8333-333333333333'),
      ).toThrow(/EACCES/);
    } finally {
      renameFault.armed = false;
    }
    // A reset the disk refused must not empty this process: otherwise the
    // operator is told every device is gone while all their credentials stay
    // valid, and the next restart brings them back.
    expect(service.verifyCredential(paired.credential)).toBe(true);
    expect(service.listDevices()).toHaveLength(1);

    service.resetEnvironment('33333333-3333-4333-8333-333333333333');
    expect(service.verifyCredential(paired.credential)).toBe(false);
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: '33333333-3333-4333-8333-333333333333',
    });
    expect(restarted.listDevices()).toEqual([]);
  });

  test('a write fault on the lastUsedAt touch does not break credential verification', () => {
    const paired = pair('Brian phone').result;
    const lastUsedBeforeFault = service.identifyDevice(
      paired.credential,
    )?.lastUsedAt;
    // Force the bounded-cadence bookkeeping write to be due.
    advanceClock(LAST_USED_WRITE_INTERVAL_MS * 2);

    renameFault.armed = true;
    try {
      // The read path answers its question rather than propagating a
      // bookkeeping write failure: a transiently unwritable registry must not
      // fail every authenticated request.
      expect(service.verifyCredential(paired.credential)).toBe(true);
      expect(service.identifyDevice(paired.credential)?.id).toBe(
        paired.device.id,
      );
    } finally {
      renameFault.armed = false;
    }

    // The sample the disk refused must not be live in memory either —
    // otherwise a "mutate memory, then swallow" implementation would satisfy
    // the assertions above while leaving the two views disagreeing. Read it
    // through listDevices, which does not itself touch lastUsedAt: going
    // through identifyDevice would re-run the write, which now succeeds
    // because the fault is disarmed, and measure the retry rather than the
    // state under fault.
    expect(service.listDevices()[0]?.lastUsedAt).toBe(lastUsedBeforeFault);
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    // Read the persisted value before verifying: verifyCredential performs
    // the same touch, which would succeed now and overwrite what we came to
    // measure.
    expect(restarted.listDevices()[0]?.lastUsedAt).toBe(lastUsedBeforeFault);
    expect(restarted.verifyCredential(paired.credential)).toBe(true);
  });

  test('the fault seam is armed only on demand, so an unarmed write persists', () => {
    // Without this, every assertion above could pass against a service that
    // never persists anything at all: the fault would be indistinguishable
    // from a no-op writer.
    const paired = pair('Brian phone').result;
    expect(registryContents()).toContain(paired.device.id);
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(restarted.verifyCredential(paired.credential)).toBe(true);
  });
});
