import { mkdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { RELAY_ENROLLMENT_BEGIN_PATH } from '@kontourai/station-contracts/relay-enrollment';
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRelayEnrollmentRoutes } from '../../../routes/system/relay-enrollment-routes.js';
import { openPrivateSqlite } from '../../../utils/private-sqlite.js';
import { VirtualApplicationIngress } from '../../connections/virtual-application.js';
import { openRelayEnrollmentJournal } from '../../relay/relay-enrollment-journal.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { ApplicationSessionService } from '../application-session-service.js';
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
    requestOrigin: origin,
    keyThumbprint: 'd'.repeat(43),
    publicKey: key,
    nonce: 'n'.repeat(43),
    expiresAt: 200,
  });
}

function markProviderPending(
  journal: ReturnType<typeof journalAt>,
  enrollmentId: string,
  patch: { providerSessionId: string; issuer: string; subject: string },
) {
  journal.transition({
    enrollmentId,
    expectedStates: ['challenge'],
    nextState: 'provider-creating',
    patch: { issuer: patch.issuer, loginJti: 'L'.repeat(22) },
  });
  return journal.transition({
    enrollmentId,
    expectedStates: ['provider-creating'],
    nextState: 'provider-pending',
    patch,
  });
}

describe('RelayEnrollmentService startup recovery', () => {
  test('a fresh begin can reclaim expired anonymous capacity without operator polling', async () => {
    const home = await createHome();
    let now = 100;
    const journal = openRelayEnrollmentJournal({
      dbPath: join(home, 'authentication', 'relay-enrollment.sqlite'),
      stationId,
      now: () => now,
      maxActiveAttempts: 1,
    });
    const service = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      authentication: {
        pendingEnrollmentCapabilities: () => ({ available: true }),
      } as never,
      pairing: {} as never,
      journal,
      now: () => now,
    });
    const ingress = new VirtualApplicationIngress(origin, () => ({
      stationId,
      connectionEnrollmentId: 'enroll-12345678',
      routingGeneration: 1,
      connectionId: 'client-12345678',
      stationOrigin: origin,
      browserOrigin: origin,
      signal: new AbortController().signal,
      isCurrent: () => true,
    }));
    ingress.bind(createRelayEnrollmentRoutes(service));
    const application = ingress.activate();
    const publicKey = await exportJWK(
      (await generateKeyPair('ES256')).publicKey,
    );
    const begin = () =>
      application.fetch(
        new Request(`${origin}${RELAY_ENROLLMENT_BEGIN_PATH}`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            publicKey: {
              kty: publicKey.kty,
              crv: publicKey.crv,
              x: publicKey.x,
              y: publicKey.y,
            },
          }),
        }),
      );
    try {
      const first = await begin();
      expect(first.status).toBe(201);
      const firstId = ((await first.json()) as { enrollmentId: string })
        .enrollmentId;
      expect((await begin()).status).toBe(503);
      now += 5 * 60_000;
      expect((await begin()).status).toBe(201);
      expect(journal.get(firstId)).toBeUndefined();
    } finally {
      ingress.stop();
      service.close();
    }
  });

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
    markProviderPending(journal, enrollmentId, {
      providerSessionId: 'provider-session',
      issuer: 'https://accounts.example.test',
      subject: 'subject-1',
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

  test('recovery discards a provider-creating attempt by enrollment ID without a session ID', async () => {
    const home = await createHome();
    const journal = journalAt(home);
    const enrollmentId = 'k'.repeat(43);
    reserve(journal, enrollmentId);
    journal.transition({
      enrollmentId,
      expectedStates: ['challenge'],
      nextState: 'provider-creating',
      patch: {
        issuer: 'https://accounts.example.test',
        loginJti: 'L'.repeat(22),
      },
    });
    const discard = vi.fn(async () => {});
    const service = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      authentication: {
        describe: () => ({ issuer: 'https://accounts.example.test' }),
        pendingEnrollmentCapabilities: () => ({ available: true }),
        discardPendingEnrollment: discard,
      } as never,
      pairing: {} as never,
      journal,
      now: () => 100,
    });

    await service.recoverBeforeAdmission();
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(
      enrollmentId,
      undefined,
      expect.any(AbortSignal),
    );
    expect(journal.get(enrollmentId)).toMatchObject({
      state: 'failed',
      terminalReason: 'recovery-required',
    });
    service.close();
  });

  test('never revokes a provider session through a different issuer', async () => {
    const home = await createHome();
    const journal = journalAt(home);
    const enrollmentId = 'g'.repeat(43);
    reserve(journal, enrollmentId);
    markProviderPending(journal, enrollmentId, {
      providerSessionId: 'colliding-session-id',
      issuer: 'https://old-identity.example.test',
      subject: 'subject-1',
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
    markProviderPending(journal, enrollmentId, {
      providerSessionId: 'provider-session',
      issuer: 'https://accounts.example.test',
      subject: 'subject-1',
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
    markProviderPending(journal, enrollmentId, {
      providerSessionId: 'provider-session',
      issuer: 'https://accounts.example.test',
      subject: 'account-subject',
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
    markProviderPending(journal, enrollmentId, {
      providerSessionId: 'racing-provider-session',
      issuer: 'https://accounts.example.test',
      subject: 'racing-subject',
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

describe('RelayEnrollmentService pending continuation seam', () => {
  async function approvedPendingDevice(
    journal: ReturnType<typeof journalAt>,
    enrollmentId: string,
  ) {
    reserve(journal, enrollmentId);
    journal.transition({
      enrollmentId,
      expectedStates: ['challenge'],
      nextState: 'provider-creating',
      patch: {
        issuer: 'https://accounts.example.test',
        loginJti: 'L'.repeat(22),
      },
    });
    journal.transition({
      enrollmentId,
      expectedStates: ['provider-creating'],
      nextState: 'provider-pending',
      patch: {
        providerSessionId: 'provider-session-for-continuation',
        issuer: 'https://accounts.example.test',
        subject: 'subject-for-continuation',
      },
    });
    journal.transition({
      enrollmentId,
      expectedStates: ['provider-pending'],
      nextState: 'pairing-requested',
      patch: {
        offerId: 'relay-offer-for-continuation',
        requestId: 'relay-request-for-continuation',
        offerProof: 'private-pairing-proof',
      },
    });
    journal.transition({
      enrollmentId,
      expectedStates: ['pairing-requested'],
      nextState: 'approved',
      patch: {
        approvalId: 'approval-for-continuation',
        approvalPrincipalId: 'operator-principal',
        issuedScope: ['orchestration:read'],
      },
    });
    journal.transition({
      enrollmentId,
      expectedStates: ['approved'],
      nextState: 'device-pending',
      patch: { deviceId: '11111111-2222-4333-8444-555555555555' },
    });
  }

  test('reserves one authority key before issuing to the exact pending Device', async () => {
    const home = await createHome();
    const journal = journalAt(home);
    const enrollmentId = 'M'.repeat(43);
    await approvedPendingDevice(journal, enrollmentId);
    const issuePendingRelayContinuation = vi.fn(
      async (input: { authorityKey: string }) => ({
        version: 'station.application-session/v1',
        credential: 'C'.repeat(43),
        authorityKey: input.authorityKey,
      }),
    );
    const service = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      applicationSessions: { issuePendingRelayContinuation } as never,
      pairing: {} as never,
      journal,
      now: () => 100,
    });

    const continuation = await service.issuePendingContinuation(
      enrollmentId,
      new AbortController().signal,
    );
    const record = journal.get(enrollmentId);
    expect(record).toMatchObject({
      state: 'continuation-pending',
      deviceId: '11111111-2222-4333-8444-555555555555',
      authorityKey: continuation.authorityKey,
    });
    expect(JSON.stringify(record)).not.toContain(continuation.credential);
    expect(issuePendingRelayContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        enrollmentId,
        deviceId:
          record && 'enrollmentId' in record ? record.deviceId : undefined,
        providerSessionId: 'provider-session-for-continuation',
        issuer: 'https://accounts.example.test',
        subject: 'subject-for-continuation',
        approvalId: 'approval-for-continuation',
        approvedBy: 'operator-principal',
        authorityKey: continuation.authorityKey,
        stationId,
        clientOrigin: origin,
        key,
        keyThumbprint: 'd'.repeat(43),
        nonce: 'n'.repeat(43),
        expiresAt: 200,
        signal: expect.any(AbortSignal),
      }),
    );
    service.close();
  });

  test('failed continuation issuance compensates with the exact enrollment marker', async () => {
    const home = await createHome();
    const journal = journalAt(home);
    const enrollmentId = 'N'.repeat(43);
    await approvedPendingDevice(journal, enrollmentId);
    const discardUncommittedAuthority = vi.fn(
      (_authorityKey: string, _enrollmentId: string) => 1,
    );
    const discardRelayEnrollmentDevice = vi.fn();
    const discardRelayEnrollmentOffer = vi.fn();
    const service = new RelayEnrollmentService({
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      authentication: {
        describe: () => ({ issuer: 'https://accounts.example.test' }),
        pendingEnrollmentCapabilities: () => ({ available: true }),
        discardPendingEnrollment: vi.fn(async () => {}),
        revokeSessionReference: vi.fn(async () => {}),
      } as never,
      applicationSessions: {
        issuePendingRelayContinuation: vi.fn(async () => {
          throw new Error('injected continuation persistence failure');
        }),
        discardUncommittedAuthority,
      } as never,
      pairing: {
        discardRelayEnrollmentDevice,
        discardRelayEnrollmentOffer,
      } as never,
      journal,
      now: () => 100,
    });

    await expect(
      service.issuePendingContinuation(
        enrollmentId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const receipt = journal.get(enrollmentId);
    expect(receipt && 'enrollmentIdHash' in receipt && receipt.state).toBe(
      'failed',
    );
    const authorityKey = discardUncommittedAuthority.mock.calls[0]?.[0];
    expect(discardUncommittedAuthority).toHaveBeenCalledWith(
      authorityKey,
      enrollmentId,
    );
    expect(discardRelayEnrollmentDevice).toHaveBeenCalledWith(
      '11111111-2222-4333-8444-555555555555',
      enrollmentId,
    );
    expect(discardRelayEnrollmentOffer).toHaveBeenCalledWith(
      'relay-offer-for-continuation',
      enrollmentId,
    );
    service.close();
  });

  test('startup recovery removes a persisted continuation or handles journal-only reservation', async () => {
    const home = await createHome();
    const journal = journalAt(home);
    const keyPair = await generateKeyPair('ES256');
    const exported = await exportJWK(keyPair.publicKey);
    const publicKey = {
      kty: 'EC' as const,
      crv: 'P-256' as const,
      x: exported.x!,
      y: exported.y!,
    };
    const keyThumbprint = await calculateJwkThumbprint(publicKey);
    const issuer = 'https://accounts.example.test';
    const subject = 'recovery-subject';
    const deviceId = '22222222-3333-4444-8555-666666666666';
    const approvalId = '33333333-4444-4555-8666-777777777777';
    const approvedBy = 'human:deployment:operator';
    const reserveDevicePending = (enrollmentId: string) => {
      journal.reserveChallenge({
        enrollmentId,
        stationId,
        clientOrigin: origin,
        requestOrigin: origin,
        keyThumbprint,
        publicKey,
        nonce: 'Q'.repeat(43),
        expiresAt: 200,
      });
      journal.transition({
        enrollmentId,
        expectedStates: ['challenge'],
        nextState: 'provider-creating',
        patch: { issuer, loginJti: 'J'.repeat(22) },
      });
      journal.transition({
        enrollmentId,
        expectedStates: ['provider-creating'],
        nextState: 'provider-pending',
        patch: {
          providerSessionId: `session-${enrollmentId.slice(0, 8)}`,
          issuer,
          subject,
        },
      });
      journal.transition({
        enrollmentId,
        expectedStates: ['provider-pending'],
        nextState: 'pairing-requested',
        patch: {
          offerId: `offer-${enrollmentId.slice(0, 8)}`,
          requestId: `request-${enrollmentId.slice(0, 8)}`,
          offerProof: 'private-recovery-proof',
        },
      });
      journal.transition({
        enrollmentId,
        expectedStates: ['pairing-requested'],
        nextState: 'approved',
        patch: {
          approvalId,
          approvalPrincipalId: approvedBy,
          issuedScope: ['orchestration:read'],
        },
      });
      journal.transition({
        enrollmentId,
        expectedStates: ['approved'],
        nextState: 'device-pending',
        patch: { deviceId },
      });
    };
    const issuedId = 'P'.repeat(43);
    const reservedOnlyId = 'S'.repeat(43);
    reserveDevicePending(issuedId);
    reserveDevicePending(reservedOnlyId);
    const authorityKey = '44444444-5555-4666-8777-888888888888';
    journal.transition({
      enrollmentId: reservedOnlyId,
      expectedStates: ['device-pending'],
      nextState: 'continuation-pending',
      patch: { authorityKey },
    });

    const databasePath = join(
      home,
      'authentication',
      'application-sessions.sqlite',
    );
    const database = openPrivateSqlite(
      databasePath,
      'Relay continuation crash fixture',
    );
    const activeApplicationSessions = new ApplicationSessionService(
      database,
      {
        describe: () => ({ issuer }),
        pendingEnrollmentCapabilities: () => ({ available: true }),
        verifyPendingEnrollment: async (
          enrollmentId: string,
          sessionId: string,
        ) => ({
          kind: 'pending',
          session: {
            enrollmentId,
            sessionId,
            subject,
            displayName: 'Recovery account',
            expiresAt: new Date(100_000).toISOString(),
          },
        }),
      } as never,
      stationId,
      origin,
      () => null,
      [origin],
      () => 100,
      (candidateDeviceId, candidateEnrollmentId) =>
        candidateDeviceId === deviceId &&
        [issuedId, reservedOnlyId].includes(candidateEnrollmentId)
          ? {
              deviceId,
              enrollmentId: candidateEnrollmentId,
              issuer,
              subject,
              approvalId,
              approvedBy,
              scope: ['orchestration:read'],
            }
          : null,
    );
    const discardPending = vi.fn(async () => {});
    const revokeSession = vi.fn(async () => {});
    const discardDevice = vi.fn();
    const discardOffer = vi.fn();
    const options = {
      stationId,
      requestOrigin: origin,
      allowedClientOrigins: [origin],
      authentication: {
        describe: () => ({ issuer }),
        pendingEnrollmentCapabilities: () => ({ available: true }),
        discardPendingEnrollment: discardPending,
        revokeSessionReference: revokeSession,
      } as never,
      applicationSessions: activeApplicationSessions,
      pairing: {
        discardRelayEnrollmentDevice: discardDevice,
        discardRelayEnrollmentOffer: discardOffer,
      } as never,
      journal,
      now: () => 100,
    };
    const issuerService = new RelayEnrollmentService(options);
    const issued = await issuerService.issuePendingContinuation(
      issuedId,
      new AbortController().signal,
    );
    expect(JSON.stringify(journal.get(issuedId))).not.toContain(
      issued.credential,
    );
    expect(
      database
        .prepare(
          "SELECT count(*) AS n FROM application_sessions WHERE json_extract(record, '$.authorityKey')=? AND json_extract(record, '$.relayEnrollmentId')=?",
        )
        .get(issued.authorityKey, issuedId)?.n,
    ).toBe(1);
    issuerService.close();

    const reopened = journalAt(home);
    const recovery = new RelayEnrollmentService({
      ...options,
      journal: reopened,
    });
    await recovery.recoverBeforeAdmission();
    for (const enrollmentId of [issuedId, reservedOnlyId]) {
      const receipt = reopened.get(enrollmentId);
      expect(receipt && 'enrollmentIdHash' in receipt && receipt.state).toBe(
        'failed',
      );
    }
    expect(
      database
        .prepare(
          "SELECT count(*) AS n FROM application_sessions WHERE json_extract(record, '$.authorityKey')=? AND json_extract(record, '$.relayEnrollmentId')=?",
        )
        .get(issued.authorityKey, issuedId)?.n,
    ).toBe(0);
    expect(discardPending).toHaveBeenCalledWith(
      issuedId,
      `session-${issuedId.slice(0, 8)}`,
      expect.any(AbortSignal),
    );
    expect(discardPending).toHaveBeenCalledWith(
      reservedOnlyId,
      `session-${reservedOnlyId.slice(0, 8)}`,
      expect.any(AbortSignal),
    );
    expect(revokeSession).toHaveBeenCalledWith(
      `session-${issuedId.slice(0, 8)}`,
      expect.any(AbortSignal),
    );
    expect(discardDevice).toHaveBeenCalledWith(deviceId, issuedId);
    expect(discardDevice).toHaveBeenCalledWith(deviceId, reservedOnlyId);
    expect(discardOffer).toHaveBeenCalledWith(
      `offer-${issuedId.slice(0, 8)}`,
      issuedId,
    );
    expect(discardOffer).toHaveBeenCalledWith(
      `offer-${reservedOnlyId.slice(0, 8)}`,
      reservedOnlyId,
    );
    recovery.close();
    activeApplicationSessions.close();
  });
});
