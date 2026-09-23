import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPLICATION_SESSION_HEADER,
  APPLICATION_SESSION_PROOF_HEADER,
} from '@kontourai/station-contracts/application-session';
import { DEPLOYMENT_AUTHENTICATION_BASE_PATH } from '@kontourai/station-contracts/deployment-authentication';
import {
  type DevicePairingConfirmation,
  PAIRING_SCOPE_ORCHESTRATION_READ,
} from '@kontourai/station-contracts/environment-security';
import {
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_PROOF_AUDIENCE,
  RELAY_ENROLLMENT_PROOF_TYPE,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentBeginRequest,
  type RelayEnrollmentChallenge,
  type RelayEnrollmentPendingResponse,
} from '@kontourai/station-contracts/relay-enrollment';
import {
  calculateJwkThumbprint,
  importJWK,
  type JWTPayload,
  jwtVerify,
} from 'jose';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { readVerifiedVirtualApplicationRequest } from '../connections/virtual-application.js';
import {
  openRelayEnrollmentJournal,
  RelayEnrollmentCapacityError,
  type RelayEnrollmentJournal,
  type RelayEnrollmentRecord,
  type RelayEnrollmentTerminalState,
} from '../relay/relay-enrollment-journal.js';
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
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_BEGIN_BODY_BYTES = 2 * 1024;
const MAX_LOGIN_BODY_BYTES = 4 * 1024;
const MAX_CREDENTIAL_BYTES = 128;
const ANONYMOUS_WINDOW_MS = 60_000;
const MAX_ANONYMOUS_BEGIN_PER_WINDOW = 120;
const MAX_ANONYMOUS_LOGIN_PER_WINDOW = 30;
const STRICT_P256_JWK_KEYS = ['crv', 'kty', 'x', 'y'];
const PROOF_CLAIM_KEYS = [
  'aud',
  'clientOrigin',
  'enrollmentId',
  'exp',
  'htm',
  'htu',
  'iat',
  'jti',
  'keyThumbprint',
  'nonce',
  'purpose',
  'stationId',
  'v',
];

function encodeOpaque(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function strictPublicKey(
  value: unknown,
): RelayEnrollmentBeginRequest['publicKey'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const key = value as Record<string, unknown>;
  if (
    Object.keys(key).sort().join(',') !== STRICT_P256_JWK_KEYS.join(',') ||
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    typeof key.x !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.x) ||
    typeof key.y !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.y)
  )
    return undefined;
  return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class RelayEnrollmentRefusal extends Error {
  constructor(
    readonly code:
      | 'unsupported'
      | 'invalid'
      | 'unavailable'
      | 'expired'
      | 'approval_required'
      | 'rate_limited',
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
  private anonymousWindowStartedAt = 0;
  private anonymousBeginCount = 0;
  private anonymousLoginCount = 0;

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

  /** Allocate a key-bound challenge without contacting the account provider. */
  async beginFreshClient(request: Request): Promise<RelayEnrollmentChallenge> {
    this.ensureOpen();
    const facts = this.requireVerifiedIngress(
      request,
      RELAY_ENROLLMENT_BEGIN_PATH,
    );
    this.reserveAnonymousBudget('begin');
    this.requireJsonPost(request);
    const bounded = await readBoundedRequestBody(request, MAX_BEGIN_BODY_BYTES);
    this.requireFactsCurrent(request, facts);
    if (bounded.status !== 'ok') throw new RelayEnrollmentRefusal('invalid');
    let body: unknown;
    try {
      body = JSON.parse(bounded.body);
    } catch {
      throw new RelayEnrollmentRefusal('invalid');
    }
    if (!isRecord(body) || Object.keys(body).join(',') !== 'publicKey')
      throw new RelayEnrollmentRefusal('invalid');
    const publicKey = strictPublicKey(body.publicKey);
    if (!publicKey) throw new RelayEnrollmentRefusal('invalid');
    let keyThumbprint: string;
    try {
      keyThumbprint = await calculateJwkThumbprint(publicKey);
    } catch {
      throw new RelayEnrollmentRefusal('invalid');
    }
    this.requireFactsCurrent(request, facts);
    const now = this.now();
    const enrollmentId = encodeOpaque(randomBytes(32));
    const nonce = encodeOpaque(randomBytes(32));
    const expiresAt = now + CHALLENGE_TTL_MS;
    try {
      this.options.journal.reserveChallenge({
        enrollmentId,
        stationId: this.options.stationId,
        clientOrigin: facts.clientOrigin,
        requestOrigin: facts.requestOrigin,
        connectionEnrollmentId: facts.connectionEnrollmentId,
        routingGeneration: facts.routingGeneration,
        connectionId: facts.connectionId,
        keyThumbprint,
        publicKey,
        nonce,
        expiresAt,
      });
    } catch (error) {
      if (error instanceof RelayEnrollmentCapacityError)
        throw new RelayEnrollmentRefusal('unavailable');
      throw error;
    }
    this.requireFactsCurrent(request, facts);
    return {
      version: RELAY_ENROLLMENT_VERSION,
      stationId: this.options.stationId,
      requestOrigin: facts.requestOrigin,
      clientOrigin: facts.clientOrigin,
      enrollmentId,
      publicKey,
      keyThumbprint,
      nonce,
      purpose: 'login',
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Consume key proof durably before creating an isolated pending provider session. */
  async loginFreshClient(
    request: Request,
  ): Promise<RelayEnrollmentPendingResponse> {
    this.ensureOpen();
    const facts = this.requireVerifiedIngress(
      request,
      RELAY_ENROLLMENT_LOGIN_PATH,
    );
    this.reserveAnonymousBudget('login');
    this.requireJsonPost(request);
    const bounded = await readBoundedRequestBody(request, MAX_LOGIN_BODY_BYTES);
    this.requireFactsCurrent(request, facts);
    if (bounded.status !== 'ok') throw new RelayEnrollmentRefusal('invalid');
    let body: unknown;
    try {
      body = JSON.parse(bounded.body);
    } catch {
      throw new RelayEnrollmentRefusal('invalid');
    }
    if (
      !isRecord(body) ||
      Object.keys(body).sort().join(',') !== 'credentials,enrollmentId,proof' ||
      typeof body.enrollmentId !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.enrollmentId) ||
      typeof body.proof !== 'string' ||
      body.proof.length > 4096 ||
      !isRecord(body.credentials) ||
      Object.keys(body.credentials).sort().join(',') !== 'password,username' ||
      typeof body.credentials.username !== 'string' ||
      body.credentials.username.length < 3 ||
      body.credentials.username.length > 32 ||
      typeof body.credentials.password !== 'string' ||
      body.credentials.password.length < 1 ||
      body.credentials.password.length > MAX_CREDENTIAL_BYTES
    )
      throw new RelayEnrollmentRefusal('invalid');

    const entry = this.options.journal.get(body.enrollmentId);
    if (
      !entry ||
      !('enrollmentId' in entry) ||
      entry.state !== 'challenge' ||
      entry.expiresAt <= this.now()
    )
      throw new RelayEnrollmentRefusal('expired');
    if (
      entry.stationId !== facts.stationId ||
      entry.requestOrigin !== facts.requestOrigin ||
      entry.clientOrigin !== facts.clientOrigin ||
      entry.connectionEnrollmentId !== facts.connectionEnrollmentId ||
      entry.routingGeneration !== facts.routingGeneration ||
      entry.connectionId !== facts.connectionId ||
      entry.expiresAt <= this.now()
    ) {
      await this.cleanupRecord(entry, 'failed', 'login-proof-rejected');
      throw new RelayEnrollmentRefusal('invalid');
    }
    const proof = await this.verifyFreshLoginProof(
      request,
      facts,
      entry,
      body.proof,
    );
    this.requireFactsCurrent(request, facts);
    if (!proof) {
      await this.cleanupRecord(entry, 'failed', 'login-proof-rejected');
      throw new RelayEnrollmentRefusal('invalid');
    }
    const authentication = this.options.authentication;
    const descriptor = authentication?.describe();
    if (
      !authentication ||
      !descriptor ||
      descriptor.login?.kind !== 'username-password' ||
      !descriptor.login.signInPath.startsWith('/') ||
      descriptor.login.signInPath.startsWith('//') ||
      descriptor.login.signInPath.includes('?') ||
      descriptor.login.signInPath.includes('#') ||
      !authentication.pendingEnrollmentCapabilities().available
    ) {
      await this.cleanupRecord(entry, 'failed', 'provider-unavailable');
      throw new RelayEnrollmentRefusal('unsupported');
    }
    const creating = this.options.journal.transition({
      enrollmentId: entry.enrollmentId,
      expectedStates: ['challenge'],
      nextState: 'provider-creating',
      patch: { issuer: descriptor.issuer, loginJti: proof.jti },
    });
    if (!creating) throw new RelayEnrollmentRefusal('unavailable');

    let pendingResult: Awaited<
      ReturnType<DeploymentAuthenticationService['createPendingEnrollment']>
    >;
    try {
      this.requireFactsCurrent(request, facts);
      const target = new URL(
        `${DEPLOYMENT_AUTHENTICATION_BASE_PATH}${descriptor.login.signInPath}`,
        facts.requestOrigin,
      );
      const providerRequest = new Request(target, {
        method: 'POST',
        headers: new Headers({
          'Content-Type': 'application/json',
          Origin: facts.clientOrigin,
        }),
        body: JSON.stringify(body.credentials),
        signal: request.signal,
      });
      pendingResult = await authentication.createPendingEnrollment(
        entry.enrollmentId,
        providerRequest,
      );
      this.requireFactsCurrent(request, facts);
      request.signal.throwIfAborted();
    } catch (error) {
      await this.cleanupRecord(creating, 'failed', 'provider-unavailable');
      throw error instanceof RelayEnrollmentRefusal
        ? error
        : new RelayEnrollmentRefusal('unavailable');
    }
    if (pendingResult.kind !== 'pending') {
      await this.cleanupRecord(
        creating,
        'failed',
        pendingResult.kind === 'invalid'
          ? 'provider-rejected'
          : 'provider-unavailable',
      );
      throw new RelayEnrollmentRefusal(
        pendingResult.kind === 'invalid' ? 'invalid' : 'unavailable',
      );
    }
    if (
      pendingResult.session.enrollmentId !== entry.enrollmentId ||
      descriptor.issuer !== creating.issuer
    ) {
      await this.cleanupRecord(creating, 'failed', 'provider-rejected');
      throw new RelayEnrollmentRefusal('invalid');
    }
    const pending = this.options.journal.transition({
      enrollmentId: entry.enrollmentId,
      expectedStates: ['provider-creating'],
      nextState: 'provider-pending',
      patch: {
        providerSessionId: pendingResult.session.sessionId,
        issuer: descriptor.issuer,
        subject: pendingResult.session.subject,
        displayName: pendingResult.session.displayName,
      },
    });
    if (!pending) {
      await authentication.discardPendingEnrollment(
        entry.enrollmentId,
        pendingResult.session.sessionId,
        AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      );
      throw new RelayEnrollmentRefusal('unavailable');
    }
    const candidate = {
      issuer: descriptor.issuer,
      subject: pendingResult.session.subject,
      displayName: pendingResult.session.displayName,
    };
    let access: ReturnType<
      DevicePairingService['requestRelayEnrollmentAccess']
    >;
    try {
      this.requireFactsCurrent(request, facts);
      access = this.options.pairing.requestRelayEnrollmentAccess({
        enrollmentId: entry.enrollmentId,
        endpoint: facts.requestOrigin,
        candidate,
        sessionId: pendingResult.session.sessionId,
      });
    } catch {
      await this.cleanupRecord(pending, 'failed', 'recovery-required');
      throw new RelayEnrollmentRefusal('unavailable');
    }
    const requested = this.options.journal.transition({
      enrollmentId: entry.enrollmentId,
      expectedStates: ['provider-pending'],
      nextState: 'pairing-requested',
      patch: {
        offerId: access.offerId,
        requestId: access.requestId,
        offerProof: access.proof,
      },
    });
    if (!requested) {
      this.options.pairing.discardRelayEnrollmentOffer(
        access.offerId,
        entry.enrollmentId,
      );
      await this.cleanupRecord(pending, 'failed', 'recovery-required');
      throw new RelayEnrollmentRefusal('unavailable');
    }
    this.requireFactsCurrent(request, facts);
    return {
      version: RELAY_ENROLLMENT_VERSION,
      state: 'pending',
      enrollmentId: entry.enrollmentId,
      requestId: requested.requestId!,
      expiresAt: new Date(requested.expiresAt).toISOString(),
    };
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

  private requireVerifiedIngress(request: Request, path: string) {
    const facts = readVerifiedVirtualApplicationRequest(request);
    const target = new URL(request.url);
    if (
      !facts?.isCurrent() ||
      facts.stationId !== this.options.stationId ||
      facts.requestOrigin !== this.options.requestOrigin ||
      !this.isTrustedOrigin(facts.clientOrigin) ||
      request.method !== 'POST' ||
      target.origin !== facts.requestOrigin ||
      target.pathname !== path ||
      target.search ||
      target.hash ||
      request.headers.get('origin') !== facts.clientOrigin
    )
      throw new RelayEnrollmentRefusal('invalid');
    return facts;
  }

  private requireFactsCurrent(
    request: Request,
    expected: NonNullable<
      ReturnType<typeof readVerifiedVirtualApplicationRequest>
    >,
  ): void {
    const current = readVerifiedVirtualApplicationRequest(request);
    if (
      !current ||
      request.signal.aborted ||
      !current.isCurrent() ||
      current.stationId !== expected.stationId ||
      current.connectionEnrollmentId !== expected.connectionEnrollmentId ||
      current.routingGeneration !== expected.routingGeneration ||
      current.connectionId !== expected.connectionId ||
      current.requestOrigin !== expected.requestOrigin ||
      current.clientOrigin !== expected.clientOrigin
    )
      throw new RelayEnrollmentRefusal('unavailable');
  }

  private requireJsonPost(request: Request): void {
    if (
      request.method !== 'POST' ||
      request.headers.get('content-type') !== 'application/json' ||
      request.headers.has('cookie') ||
      request.headers.has('cookie2') ||
      request.headers.has('authorization') ||
      request.headers.has(APPLICATION_SESSION_HEADER) ||
      request.headers.has(APPLICATION_SESSION_PROOF_HEADER)
    )
      throw new RelayEnrollmentRefusal('invalid');
  }

  private reserveAnonymousBudget(kind: 'begin' | 'login'): void {
    const now = this.now();
    if (
      now < this.anonymousWindowStartedAt ||
      now - this.anonymousWindowStartedAt >= ANONYMOUS_WINDOW_MS
    ) {
      this.anonymousWindowStartedAt = now;
      this.anonymousBeginCount = 0;
      this.anonymousLoginCount = 0;
    }
    if (kind === 'begin') {
      if (this.anonymousBeginCount >= MAX_ANONYMOUS_BEGIN_PER_WINDOW)
        throw new RelayEnrollmentRefusal('rate_limited');
      this.anonymousBeginCount += 1;
    } else {
      if (this.anonymousLoginCount >= MAX_ANONYMOUS_LOGIN_PER_WINDOW)
        throw new RelayEnrollmentRefusal('rate_limited');
      this.anonymousLoginCount += 1;
    }
  }

  private async verifyFreshLoginProof(
    request: Request,
    facts: NonNullable<
      ReturnType<typeof readVerifiedVirtualApplicationRequest>
    >,
    entry: RelayEnrollmentRecord,
    token: string,
  ): Promise<{ jti: string } | undefined> {
    try {
      if (token.split('.').length !== 3) return undefined;
      const key = await importJWK(entry.publicKey, 'ES256');
      const verified = await jwtVerify(token, key, {
        algorithms: ['ES256'],
        audience: RELAY_ENROLLMENT_PROOF_AUDIENCE,
        clockTolerance: 0,
      });
      this.requireFactsCurrent(request, facts);
      const header = verified.protectedHeader;
      const payload: JWTPayload = verified.payload;
      if (
        header.alg !== 'ES256' ||
        header.typ !== RELAY_ENROLLMENT_PROOF_TYPE ||
        Object.keys(payload).sort().join(',') !== PROOF_CLAIM_KEYS.join(',') ||
        payload.aud !== RELAY_ENROLLMENT_PROOF_AUDIENCE ||
        payload.v !== RELAY_ENROLLMENT_VERSION ||
        payload.stationId !== entry.stationId ||
        payload.enrollmentId !== entry.enrollmentId ||
        payload.clientOrigin !== entry.clientOrigin ||
        payload.keyThumbprint !== entry.keyThumbprint ||
        payload.nonce !== entry.nonce ||
        payload.purpose !== 'login' ||
        payload.htm !== 'POST' ||
        payload.htu !==
          `${facts.requestOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}` ||
        typeof payload.jti !== 'string' ||
        !/^[A-Za-z0-9_-]{22}$/.test(payload.jti) ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp)
      )
        return undefined;
      const nowSeconds = Math.floor(this.now() / 1000);
      if (
        payload.iat > nowSeconds + 5 ||
        payload.iat < nowSeconds - 30 ||
        payload.exp <= nowSeconds ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > 30 ||
        payload.exp * 1000 > entry.expiresAt
      )
        return undefined;
      if (
        (await calculateJwkThumbprint(entry.publicKey)) !== entry.keyThumbprint
      )
        return undefined;
      return { jti: payload.jti };
    } catch {
      return undefined;
    }
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
      | 'provider-rejected'
      | 'provider-unavailable'
      | 'login-proof-rejected',
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
    const providerCleanupRequired =
      !!record.providerSessionId ||
      (record.state === 'cleaning' && record.cleaningFrom !== 'challenge');
    if (authentication) {
      if (providerCleanupRequired) {
        if (
          !record.issuer ||
          authentication.describe().issuer !== record.issuer
        ) {
          errors.push(new RelayEnrollmentRefusal('unavailable'));
        } else if (!authentication.pendingEnrollmentCapabilities().available) {
          errors.push(new RelayEnrollmentRefusal('unsupported'));
        } else {
          try {
            await authentication.discardPendingEnrollment(
              record.enrollmentId,
              record.providerSessionId,
              signal,
            );
          } catch (error) {
            errors.push(error);
          }
          if (record.providerSessionId) {
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
      }
    } else if (providerCleanupRequired) {
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
