import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DevicePairingConfirmation,
  PAIRING_SCOPE_ORCHESTRATION_READ,
} from '@kontourai/station-contracts/environment-security';
import type {
  RelayEnrollmentJournal,
  RelayEnrollmentRecord,
  RelayEnrollmentTerminalState,
} from '../relay/relay-enrollment-journal.js';
import { openRelayEnrollmentJournal } from '../relay/relay-enrollment-journal.js';
import {
  DevicePairingError,
  type DevicePairingService,
  type PairingApproval,
  type VerifiedRelayEnrollmentCandidate,
} from '../ssh/device-pairing-service.js';
import type { ApplicationSessionService } from './application-session-service.js';
import type { DeploymentAuthenticationService } from './deployment-authentication-service.js';

const CLEANUP_TIMEOUT_MS = 15_000;
const ENROLLMENT_DATABASE_NAME = 'relay-enrollment.sqlite';

export class RelayEnrollmentRefusal extends Error {
  constructor(
    readonly code:
      | 'unsupported'
      | 'invalid'
      | 'unavailable'
      | 'expired'
      | 'approval_required',
  ) {
    super(`Relay enrollment ${code}.`);
    this.name = 'RelayEnrollmentRefusal';
  }
}

export interface RelayEnrollmentServiceOptions {
  stationId: string;
  requestOrigin: string;
  allowedClientOrigins: readonly string[];
  authentication?: DeploymentAuthenticationService;
  applicationSessions?: ApplicationSessionService;
  pairing: DevicePairingService;
  journal: RelayEnrollmentJournal;
  now?: () => number;
}

/**
 * Private relay enrollment owner. It is composed before Station listeners and
 * owns pending-provider verification separately from generic authentication.
 */
export class RelayEnrollmentService {
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: RelayEnrollmentServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Startup recovery is a listener precondition: any incomplete enrollment
   * must lose its provider session, continuation and reserved Device before
   * HTTP or VirtualApplication admission begins.
   */
  async recoverBeforeAdmission(): Promise<void> {
    this.ensureOpen();
    for (const record of this.options.journal.listUnfinished()) {
      await this.cleanupRecord(
        record,
        record.expiresAt <= this.now() ? 'expired' : 'failed',
        record.expiresAt <= this.now() ? 'expired' : 'recovery-required',
      );
    }
  }

  /** Operator-only approval path; marked requests never fall back to generic verification. */
  async confirmOperatorBinding(input: {
    requestId: string;
    approval: PairingApproval;
    principalId: string;
    signal: AbortSignal;
    isApprovalCurrent: () => boolean;
  }): Promise<DevicePairingConfirmation | undefined> {
    this.ensureOpen();
    const pairing = this.options.pairing.relayEnrollmentForRequest(
      input.requestId,
    );
    if (!pairing) return undefined;
    if (input.approval.kind !== 'presented-credential')
      throw new RelayEnrollmentRefusal('approval_required');
    const entry = this.options.journal.get(pairing.enrollmentId);
    if (!entry || !('enrollmentId' in entry))
      throw new RelayEnrollmentRefusal('unavailable');
    if (
      entry.state !== 'pairing-requested' ||
      entry.stationId !== this.options.stationId ||
      entry.offerId !== pairing.offerId ||
      entry.requestId !== pairing.requestId ||
      entry.offerProof !== pairing.proof ||
      entry.providerSessionId !== pairing.sessionId ||
      entry.issuer !== pairing.candidate.issuer ||
      entry.subject !== pairing.candidate.subject ||
      pairing.scope !== PAIRING_SCOPE_ORCHESTRATION_READ ||
      !this.isTrustedOrigin(entry.clientOrigin)
    ) {
      throw new RelayEnrollmentRefusal('invalid');
    }
    if (entry.expiresAt <= this.now()) {
      await this.cleanupRecord(entry, 'expired', 'expired');
      throw new RelayEnrollmentRefusal('expired');
    }
    const authentication = this.options.authentication;
    if (!authentication?.pendingEnrollmentCapabilities().available)
      throw new RelayEnrollmentRefusal('unsupported');
    const verified = await authentication.verifyPendingEnrollment(
      entry.enrollmentId,
      pairing.sessionId,
      input.signal,
    );
    if (verified.kind === 'unavailable')
      throw new RelayEnrollmentRefusal('unavailable');
    if (
      verified.kind !== 'pending' ||
      verified.session.enrollmentId !== entry.enrollmentId ||
      verified.session.sessionId !== pairing.sessionId ||
      authentication.describe().issuer !== entry.issuer ||
      verified.session.subject !== entry.subject
    ) {
      await this.denyAndCleanup(entry, 'approval-denied');
      throw new RelayEnrollmentRefusal('invalid');
    }
    if (
      input.signal.aborted ||
      !input.isApprovalCurrent() ||
      input.approval.kind !== 'presented-credential'
    )
      throw new RelayEnrollmentRefusal('approval_required');

    const current = this.options.journal.get(entry.enrollmentId);
    if (
      !current ||
      !('enrollmentId' in current) ||
      current.state !== 'pairing-requested' ||
      current.providerSessionId !== entry.providerSessionId ||
      current.requestId !== entry.requestId ||
      current.offerId !== entry.offerId ||
      current.offerProof !== entry.offerProof ||
      current.expiresAt <= this.now()
    )
      throw new RelayEnrollmentRefusal('unavailable');

    const pendingIdentity: VerifiedRelayEnrollmentCandidate = {
      enrollmentId: entry.enrollmentId,
      sessionId: pairing.sessionId,
      issuer: entry.issuer,
      subject: entry.subject,
    };
    const confirmation = this.options.pairing.confirmRelayEnrollmentRequest(
      input.requestId,
      input.approval,
      input.principalId,
      pendingIdentity,
    );
    if (
      !confirmation.principalBinding ||
      !('kind' in confirmation.principalBinding) ||
      confirmation.principalBinding.kind !== 'account'
    )
      throw new RelayEnrollmentRefusal('invalid');
    const approved = this.options.journal.transition({
      enrollmentId: entry.enrollmentId,
      expectedStates: ['pairing-requested'],
      nextState: 'approved',
      patch: {
        approvalPrincipalId: confirmation.principalBinding.approvedBy,
        approvalId: confirmation.principalBinding.approvalId,
        issuedScope: [PAIRING_SCOPE_ORCHESTRATION_READ],
      },
    });
    if (!approved) {
      await this.cleanupRecord(entry, 'failed', 'recovery-required');
      throw new RelayEnrollmentRefusal('unavailable');
    }
    return confirmation;
  }

  /**
   * Server-only approved exchange. The reserved Device id reaches the journal
   * before the synchronous pairing service can persist the pending grant.
   * The credential is returned only to a trusted server caller; no HTTP route
   * exposes it until the later continuation and signed ACK lifecycle exists.
   */
  async exchangeApprovedDevice(
    enrollmentId: string,
    signal: AbortSignal,
  ): Promise<ReturnType<DevicePairingService['exchangeRelayEnrollment']>> {
    this.ensureOpen();
    const entry = this.options.journal.get(enrollmentId);
    if (
      !entry ||
      !('enrollmentId' in entry) ||
      entry.state !== 'approved' ||
      entry.expiresAt <= this.now() ||
      !entry.offerId ||
      !entry.requestId ||
      !entry.offerProof ||
      !entry.providerSessionId ||
      entry.issuedScope?.length !== 1 ||
      entry.issuedScope[0] !== PAIRING_SCOPE_ORCHESTRATION_READ ||
      !this.isTrustedOrigin(entry.clientOrigin)
    ) {
      if (entry && 'enrollmentId' in entry && entry.expiresAt <= this.now())
        await this.cleanupRecord(entry, 'expired', 'expired');
      throw new RelayEnrollmentRefusal('invalid');
    }
    const authentication = this.options.authentication;
    if (!authentication?.pendingEnrollmentCapabilities().available)
      throw new RelayEnrollmentRefusal('unsupported');
    const verified = await authentication.verifyPendingEnrollment(
      enrollmentId,
      entry.providerSessionId,
      signal,
    );
    if (verified.kind === 'unavailable')
      throw new RelayEnrollmentRefusal('unavailable');
    if (
      verified.kind !== 'pending' ||
      verified.session.enrollmentId !== enrollmentId ||
      verified.session.sessionId !== entry.providerSessionId ||
      verified.session.subject !== entry.subject ||
      authentication.describe().issuer !== entry.issuer
    ) {
      await this.cleanupRecord(entry, 'failed', 'provider-rejected');
      throw new RelayEnrollmentRefusal('invalid');
    }
    signal.throwIfAborted();
    const latest = this.options.journal.get(enrollmentId);
    if (
      !latest ||
      !('enrollmentId' in latest) ||
      latest.state !== 'approved' ||
      latest.providerSessionId !== entry.providerSessionId ||
      latest.requestId !== entry.requestId ||
      latest.offerId !== entry.offerId ||
      latest.offerProof !== entry.offerProof ||
      latest.expiresAt <= this.now()
    )
      throw new RelayEnrollmentRefusal('unavailable');
    const deviceId = randomUUID();
    const reserved = this.options.journal.transition({
      enrollmentId,
      expectedStates: ['approved'],
      nextState: 'device-pending',
      patch: { deviceId },
    });
    if (!reserved) throw new RelayEnrollmentRefusal('unavailable');
    try {
      signal.throwIfAborted();
      return this.options.pairing.exchangeRelayEnrollment({
        offerId: reserved.offerId!,
        proof: reserved.offerProof!,
        requestId: reserved.requestId!,
        enrollmentId,
        deviceId,
      });
    } catch (error) {
      await this.cleanupRecord(reserved, 'failed', 'recovery-required');
      throw error;
    }
  }

  /** Denial of an enrollment-owned request cleans the exact provider attempt. */
  async denyRequest(requestId: string): Promise<boolean> {
    this.ensureOpen();
    const pairing = this.options.pairing.relayEnrollmentForRequest(requestId);
    if (!pairing) return false;
    const entry = this.options.journal.get(pairing.enrollmentId);
    if (!entry || !('enrollmentId' in entry))
      throw new RelayEnrollmentRefusal('unavailable');
    if (entry.state === 'pairing-requested') {
      this.options.pairing.denyRequest(requestId);
    }
    await this.cleanupRecord(entry, 'denied', 'approval-denied');
    return true;
  }

  /** Expiry is reconciled on operator polling and on new trusted coordinator work. */
  async cleanupExpired(): Promise<number> {
    this.ensureOpen();
    let cleaned = 0;
    for (const record of this.options.journal.listUnfinished()) {
      if (record.expiresAt > this.now()) continue;
      await this.cleanupRecord(record, 'expired', 'expired');
      cleaned += 1;
    }
    return cleaned;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.journal.close();
  }

  private async denyAndCleanup(
    record: RelayEnrollmentRecord,
    reason: 'approval-denied',
  ): Promise<void> {
    const current = this.options.journal.get(record.enrollmentId);
    if (!current || !('enrollmentId' in current)) return;
    if (current.state === 'pairing-requested' && current.requestId) {
      try {
        this.options.pairing.denyRequest(current.requestId);
      } catch (error) {
        const latest = this.options.journal.get(record.enrollmentId);
        const cleanupAlreadyAdvanced =
          latest &&
          'enrollmentId' in latest &&
          latest.state !== 'pairing-requested';
        if (
          !cleanupAlreadyAdvanced &&
          (!(error instanceof DevicePairingError) ||
            ![
              'request_not_found',
              'offer_unavailable',
              'offer_expired',
            ].includes(error.code))
        )
          throw error;
      }
    }
    const cleaning = this.enterCleaning(record.enrollmentId, reason);
    if (!cleaning) return;
    await this.finishCleanup(cleaning, 'denied');
  }

  private async cleanupRecord(
    record: RelayEnrollmentRecord,
    terminalState: RelayEnrollmentTerminalState,
    reason:
      | 'expired'
      | 'recovery-required'
      | 'approval-denied'
      | 'provider-rejected',
  ): Promise<void> {
    const cleaning = this.enterCleaning(record.enrollmentId, reason);
    if (!cleaning) return;
    await this.finishCleanup(cleaning, terminalState);
  }

  private enterCleaning(
    enrollmentId: string,
    reason: RelayEnrollmentRecord['terminalReason'],
  ): RelayEnrollmentRecord | undefined {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const latest = this.options.journal.get(enrollmentId);
      if (!latest || !('enrollmentId' in latest)) return undefined;
      if (latest.state === 'committed') return undefined;
      if (latest.state === 'cleaning') return latest;
      const cleaning = this.options.journal.transition({
        enrollmentId,
        expectedStates: [latest.state],
        nextState: 'cleaning',
        patch: reason ? { terminalReason: reason } : undefined,
      });
      if (cleaning) return cleaning;
    }
    throw new RelayEnrollmentRefusal('unavailable');
  }

  private async finishCleanup(
    record: RelayEnrollmentRecord,
    terminalState: RelayEnrollmentTerminalState,
  ): Promise<void> {
    const errors: unknown[] = [];
    const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
    const authentication = this.options.authentication;
    if (authentication) {
      if (record.providerSessionId) {
        if (
          !record.issuer ||
          authentication.describe().issuer !== record.issuer
        ) {
          errors.push(new RelayEnrollmentRefusal('unavailable'));
        } else {
          try {
            if (authentication.pendingEnrollmentCapabilities().available)
              await authentication.discardPendingEnrollment(
                record.enrollmentId,
                record.providerSessionId,
                signal,
              );
          } catch (error) {
            errors.push(error);
          }
          try {
            await authentication.revokeSessionReference(
              record.providerSessionId,
              signal,
            );
          } catch (error) {
            errors.push(error);
          }
        }
      }
    } else if (
      record.providerSessionId ||
      (record.state === 'cleaning' && record.cleaningFrom !== 'challenge') ||
      (record.state !== 'challenge' && record.state !== 'cleaning')
    ) {
      errors.push(new RelayEnrollmentRefusal('unavailable'));
    }
    if (record.authorityKey) {
      try {
        if (!this.options.applicationSessions)
          throw new RelayEnrollmentRefusal('unavailable');
        this.options.applicationSessions.discardUncommittedAuthority(
          record.authorityKey,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (record.deviceId) {
      try {
        this.options.pairing.discardRelayEnrollmentDevice(
          record.deviceId,
          record.enrollmentId,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (record.offerId) {
      try {
        this.options.pairing.discardRelayEnrollmentOffer(
          record.offerId,
          record.enrollmentId,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        'Relay enrollment cleanup is unconfirmed.',
      );
    this.options.journal.markCleanupComplete(
      record.enrollmentId,
      terminalState,
    );
  }

  private ensureOpen(): void {
    if (this.closed) throw new RelayEnrollmentRefusal('unavailable');
  }

  private isTrustedOrigin(origin: string): boolean {
    return (
      origin === this.options.requestOrigin ||
      this.options.allowedClientOrigins.includes(origin)
    );
  }
}

export async function createRelayEnrollmentRuntime(input: {
  home: string;
  stationId: string;
  requestOrigin: string;
  allowedClientOrigins: readonly string[];
  authentication?: DeploymentAuthenticationService;
  applicationSessions?: ApplicationSessionService;
  pairing: DevicePairingService;
  now?: () => number;
}): Promise<RelayEnrollmentService | undefined> {
  const databasePath = join(
    input.home,
    'authentication',
    ENROLLMENT_DATABASE_NAME,
  );
  const supported =
    input.authentication?.pendingEnrollmentCapabilities().available === true;
  if (!supported && !existsSync(databasePath)) return undefined;
  const journal = openRelayEnrollmentJournal({
    dbPath: databasePath,
    stationId: input.stationId,
    ...(input.now ? { now: input.now } : {}),
  });
  const service = new RelayEnrollmentService({
    ...input,
    journal,
  });
  try {
    await service.recoverBeforeAdmission();
    return service;
  } catch (error) {
    service.close();
    throw error;
  }
}
