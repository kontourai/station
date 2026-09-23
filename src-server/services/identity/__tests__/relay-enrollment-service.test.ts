import { mkdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openRelayEnrollmentJournal } from '../../relay/relay-enrollment-journal.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import {
  createRelayEnrollmentRuntime,
  RelayEnrollmentService,
} from '../relay-enrollment-service.js';

const stationId = '11111111-1111-4111-8111-111111111111';
const origin = 'https://station.example.test';
const key = {
  kty: 'EC' as const,
  crv: 'P-256' as const,
  x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
};
const homeDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    homeDirs
      .splice(0)
      .map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function createHome() {
  const home = await mkdtemp(join(tmpdir(), 'station-relay-enrollment-'));
  homeDirs.push(home);
  return home;
}

function journalAt(home: string) {
  return openRelayEnrollmentJournal({
    dbPath: join(home, 'authentication', 'relay-enrollment.sqlite'),
    stationId,
    now: () => 100,
  });
}

function reserve(journal: ReturnType<typeof journalAt>, enrollmentId: string) {
  return journal.reserveChallenge({
    enrollmentId,
    stationId,
    clientOrigin: origin,
    keyThumbprint: 'd'.repeat(43),
    publicKey: key,
    nonce: 'n'.repeat(43),
    expiresAt: 200,
  });
}

describe('RelayEnrollmentService startup recovery', () => {
  test('cleans a challenge-only record when no enrollment provider is configured', async () => {
    const home = await createHome();
    const journal = journalAt(home);
    const enrollmentId = 'a'.repeat(43);
    reserve(journal, enrollmentId);
    const service = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      pairing: {} as never,
      journal,
      now: () => 100,
    });

    await expect(service.recoverBeforeAdmission()).resolves.toBeUndefined();
    const receipt = journal.get(enrollmentId);
    expect(receipt && 'enrollmentIdHash' in receipt && receipt.state).toBe(
      'failed',
    );
    service.close();
  });

  test('blocks startup when a provider-backed attempt cannot be safely revoked', async () => {
    const home = await createHome();
    const journal = journalAt(home);
    const enrollmentId = 'b'.repeat(43);
    reserve(journal, enrollmentId);
    journal.transition({
      enrollmentId,
      expectedStates: ['challenge'],
      nextState: 'provider-pending',
      patch: {
        providerSessionId: 'provider-session',
        issuer: 'https://accounts.example.test',
        subject: 'subject-1',
      },
    });

    await expect(
      createRelayEnrollmentRuntime({
        home,
        stationId,
        requestOrigin: origin,
        allowedClientOrigins: [origin],
        pairing: {} as never,
        now: () => 100,
      }),
    ).rejects.toThrow('Relay enrollment cleanup is unconfirmed');
    expect(journal.get(enrollmentId)).toMatchObject({
      enrollmentId,
      state: 'cleaning',
      cleaningFrom: 'provider-pending',
    });
    journal.close();
  });

  test('never revokes a provider session through a different issuer', async () => {
    const home = await createHome();
    const journal = journalAt(home);
    const enrollmentId = 'g'.repeat(43);
    reserve(journal, enrollmentId);
    journal.transition({
      enrollmentId,
      expectedStates: ['challenge'],
      nextState: 'provider-pending',
      patch: {
        providerSessionId: 'colliding-session-id',
        issuer: 'https://old-identity.example.test',
        subject: 'subject-1',
      },
    });
    const discard = vi.fn(async () => {});
    const revoke = vi.fn(async () => {});
    const service = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      authentication: {
        describe: () => ({ issuer: 'https://new-identity.example.test' }),
        pendingEnrollmentCapabilities: () => ({ available: true }),
        discardPendingEnrollment: discard,
        revokeSessionReference: revoke,
      } as never,
      pairing: {} as never,
      journal,
      now: () => 100,
    });

    await expect(service.recoverBeforeAdmission()).rejects.toThrow(
      'Relay enrollment cleanup is unconfirmed',
    );
    expect(discard).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(journal.get(enrollmentId)).toMatchObject({
      state: 'cleaning',
      cleaningFrom: 'provider-pending',
    });
    service.close();
  });

  test('cleans a provider-backed attempt with pending discard and generic revoke', async () => {
    const home = await createHome();
    const journal = journalAt(home);
    const enrollmentId = 'c'.repeat(43);
    reserve(journal, enrollmentId);
    journal.transition({
      enrollmentId,
      expectedStates: ['challenge'],
      nextState: 'provider-pending',
      patch: {
        providerSessionId: 'provider-session',
        issuer: 'https://accounts.example.test',
        subject: 'subject-1',
      },
    });
    const discarded = vi.fn(async () => {});
    const revoked = vi.fn(async () => {});
    const authentication = {
      describe: () => ({ issuer: 'https://accounts.example.test' }),
      pendingEnrollmentCapabilities: () => ({ available: true }),
      discardPendingEnrollment: discarded,
      revokeSessionReference: revoked,
    } as never;
    const service = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      authentication,
      pairing: {} as never,
      journal,
      now: () => 100,
    });

    await service.recoverBeforeAdmission();
    expect(discarded).toHaveBeenCalledWith(
      enrollmentId,
      'provider-session',
      expect.any(AbortSignal),
    );
    expect(revoked).toHaveBeenCalledWith(
      'provider-session',
      expect.any(AbortSignal),
    );
    expect(journal.get(enrollmentId)).toMatchObject({ state: 'failed' });
    service.close();
  });

  test('uses pending verification for operator binding and refuses generic approval', async () => {
    const home = await createHome();
    mkdirSync(join(home, 'security'), { mode: 0o700 });
    const journal = journalAt(home);
    const enrollmentId = 'e'.repeat(43);
    reserve(journal, enrollmentId);
    journal.transition({
      enrollmentId,
      expectedStates: ['challenge'],
      nextState: 'provider-pending',
      patch: {
        providerSessionId: 'provider-session',
        issuer: 'https://accounts.example.test',
        subject: 'account-subject',
      },
    });
    const pairing = new DevicePairingService({
      homeDir: home,
      environmentId: stationId,
    });
    const candidate = {
      issuer: 'https://accounts.example.test',
      subject: 'account-subject',
      displayName: 'Account holder',
    };
    const privateRequest = pairing.requestRelayEnrollmentAccess({
      enrollmentId,
      endpoint: origin,
      candidate,
      sessionId: 'provider-session',
    });
    journal.transition({
      enrollmentId,
      expectedStates: ['provider-pending'],
      nextState: 'pairing-requested',
      patch: {
        offerId: privateRequest.offerId,
        requestId: privateRequest.requestId,
        offerProof: privateRequest.proof,
      },
    });
    const pendingVerify = vi.fn(async () => ({
      kind: 'pending' as const,
      session: {
        enrollmentId,
        sessionId: 'provider-session',
        subject: 'account-subject',
        displayName: 'Account holder',
        expiresAt: '2026-09-12T12:05:00.000Z',
      },
    }));
    const genericVerify = vi.fn(async () => ({ kind: 'unavailable' as const }));
    const discardPending = vi.fn(async () => {});
    const revokeProvider = vi.fn(async () => {});
    const authentication = {
      pendingEnrollmentCapabilities: () => ({ available: true }),
      verifyPendingEnrollment: pendingVerify,
      verifySessionReference: genericVerify,
      discardPendingEnrollment: discardPending,
      revokeSessionReference: revokeProvider,
      describe: () => ({ issuer: 'https://accounts.example.test' }),
    } as never;
    const service = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      authentication,
      pairing,
      journal,
      now: () => 100,
    });
    const approval = { kind: 'presented-credential' as const };

    expect(() =>
      pairing.confirmRequest(privateRequest.requestId, approval, {
        principalId: humanPrincipal('operator', 'one', 'Operator').id,
        kind: 'account',
      }),
    ).toThrow('relay_enrollment_finalize_required');
    const confirmation = await service.confirmOperatorBinding({
      requestId: privateRequest.requestId,
      approval,
      principalId: humanPrincipal('operator', 'one', 'Operator').id,
      signal: new AbortController().signal,
      isApprovalCurrent: () => true,
    });

    expect(confirmation?.principalBinding).toMatchObject({ kind: 'account' });
    expect(pendingVerify).toHaveBeenCalledWith(
      enrollmentId,
      'provider-session',
      expect.any(AbortSignal),
    );
    expect(genericVerify).not.toHaveBeenCalled();
    expect(journal.get(enrollmentId)).toMatchObject({
      state: 'approved',
      issuedScope: ['orchestration:read'],
    });
    const issued = await service.exchangeApprovedDevice(
      enrollmentId,
      new AbortController().signal,
    );
    expect(issued.device.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(journal.get(enrollmentId)).toMatchObject({
      state: 'device-pending',
      deviceId: issued.device.id,
    });
    expect(pairing.identifyDevice(issued.credential)).toBeNull();
    expect(pairing.verifyCredential(issued.credential)).toBe(false);
    service.close();

    const restartedJournal = journalAt(home);
    const restartedPairing = new DevicePairingService({
      homeDir: home,
      environmentId: stationId,
    });
    const restartedService = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      authentication,
      pairing: restartedPairing,
      journal: restartedJournal,
      now: () => 100,
    });
    await restartedService.recoverBeforeAdmission();
    expect(discardPending).toHaveBeenCalledWith(
      enrollmentId,
      'provider-session',
      expect.any(AbortSignal),
    );
    expect(revokeProvider).toHaveBeenCalledWith(
      'provider-session',
      expect.any(AbortSignal),
    );
    expect(restartedPairing.identifyDevice(issued.credential)).toBeNull();
    expect(restartedJournal.get(enrollmentId)).toMatchObject({
      state: 'failed',
    });
    restartedService.close();
  });

  test('cleanup uses resources added while a stale provider verification was pending', async () => {
    const home = await createHome();
    await mkdir(join(home, 'security'), { mode: 0o700 });
    const journal = journalAt(home);
    const enrollmentId = 'f'.repeat(43);
    reserve(journal, enrollmentId);
    journal.transition({
      enrollmentId,
      expectedStates: ['challenge'],
      nextState: 'provider-pending',
      patch: {
        providerSessionId: 'racing-provider-session',
        issuer: 'https://accounts.example.test',
        subject: 'racing-subject',
      },
    });
    const pairing = new DevicePairingService({
      homeDir: home,
      environmentId: stationId,
    });
    const existingOffer = pairing.createOffer({ endpoint: origin });
    const existingRequest = pairing.requestPairing({
      offerId: existingOffer.offerId,
      proof: existingOffer.challenge,
      deviceName: 'Existing unrelated Device',
      requesterPosition: 'unproven',
    });
    pairing.confirmRequest(existingRequest.requestId, {
      kind: 'presented-credential',
    });
    const existingDevice = pairing.exchange({
      offerId: existingOffer.offerId,
      proof: existingOffer.challenge,
      requestId: existingRequest.requestId,
    });
    const candidate = {
      issuer: 'https://accounts.example.test',
      subject: 'racing-subject',
      displayName: 'Racing person',
    };
    const privateRequest = pairing.requestRelayEnrollmentAccess({
      enrollmentId,
      endpoint: origin,
      candidate,
      sessionId: 'racing-provider-session',
    });
    journal.transition({
      enrollmentId,
      expectedStates: ['provider-pending'],
      nextState: 'pairing-requested',
      patch: {
        offerId: privateRequest.offerId,
        requestId: privateRequest.requestId,
        offerProof: privateRequest.proof,
      },
    });
    let releaseFirst!: (result: { kind: 'invalid'; reason: 'revoked' }) => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstResult = new Promise<{
      kind: 'invalid';
      reason: 'revoked';
    }>((resolve) => {
      releaseFirst = resolve;
    });
    const pendingResult = {
      kind: 'pending' as const,
      session: {
        enrollmentId,
        sessionId: 'racing-provider-session',
        subject: 'racing-subject',
        displayName: 'Racing person',
        expiresAt: '2026-09-12T12:05:00.000Z',
      },
    };
    let verificationCount = 0;
    const pendingVerify = vi.fn(async () => {
      verificationCount += 1;
      if (verificationCount === 1) {
        markFirstStarted();
        return firstResult;
      }
      return pendingResult;
    });
    const authentication = {
      pendingEnrollmentCapabilities: () => ({ available: true }),
      verifyPendingEnrollment: pendingVerify,
      describe: () => ({ issuer: 'https://accounts.example.test' }),
      discardPendingEnrollment: vi.fn(async () => {}),
      revokeSessionReference: vi.fn(async () => {}),
    } as never;
    const service = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      authentication,
      pairing,
      journal,
      now: () => 100,
    });
    const approve = () =>
      service.confirmOperatorBinding({
        requestId: privateRequest.requestId,
        approval: { kind: 'presented-credential' },
        principalId: humanPrincipal('operator', 'one', 'Operator').id,
        signal: new AbortController().signal,
        isApprovalCurrent: () => true,
      });

    const staleApproval = approve();
    await firstStarted;
    await approve();
    const minted = await service.exchangeApprovedDevice(
      enrollmentId,
      new AbortController().signal,
    );
    expect(journal.get(enrollmentId)).toMatchObject({
      state: 'device-pending',
      deviceId: minted.device.id,
    });
    releaseFirst({ kind: 'invalid', reason: 'revoked' });
    await expect(staleApproval).rejects.toMatchObject({ code: 'invalid' });

    expect(pairing.identifyDevice(minted.credential)).toBeNull();
    const persistedDevices = JSON.parse(
      readFileSync(join(home, 'security', 'paired-devices.json'), 'utf8'),
    ).devices as Array<{ id: string }>;
    expect(persistedDevices.map((device) => device.id)).toContain(
      existingDevice.device.id,
    );
    expect(persistedDevices.map((device) => device.id)).not.toContain(
      minted.device.id,
    );
    const reopenedPairing = new DevicePairingService({
      homeDir: home,
      environmentId: stationId,
    });
    const reopenedDevices = JSON.parse(
      readFileSync(join(home, 'security', 'paired-devices.json'), 'utf8'),
    ).devices as Array<{ id: string }>;
    expect(reopenedDevices.map((device) => device.id)).toContain(
      existingDevice.device.id,
    );
    expect(reopenedDevices.map((device) => device.id)).not.toContain(
      minted.device.id,
    );
    expect(reopenedPairing.identifyDevice(existingDevice.credential)?.id).toBe(
      existingDevice.device.id,
    );
    expect(reopenedPairing.identifyDevice(minted.credential)).toBeNull();
    expect(journal.get(enrollmentId)).toMatchObject({ state: 'denied' });
    service.close();
  });
});
