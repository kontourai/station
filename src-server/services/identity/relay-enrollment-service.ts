import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  RELAY_ENROLLMENT_ACTIVATE_PATH,
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_FINALIZE_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_PROOF_AUDIENCE,
  RELAY_ENROLLMENT_PROOF_TYPE,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentActivatedResponse,
  type RelayEnrollmentBeginRequest,
  type RelayEnrollmentChallenge,
  type RelayEnrollmentFinalizeResponse,
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
const MAX_ANONYMOUS_FINALIZE_PER_WINDOW = 60;
const MAX_ANONYMOUS_ACTIVATE_PER_WINDOW = 60;
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

function canonicalRelayJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [
          key,
          normalize((input as Record<string, unknown>)[key]),
        ]),
    );
  };
  return JSON.stringify(normalize(value));
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
  private anonymousFinalizeCount = 0;
  private anonymousActivateCount = 0;

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
    let facts: NonNullable<
      ReturnType<typeof readVerifiedVirtualApplicationRequest>
    >;
    facts = this.requireVerifiedIngress(request, RELAY_ENROLLMENT_BEGIN_PATH);
    if (!this.options.authentication?.pendingEnrollmentCapabilities().available)
      throw new RelayEnrollmentRefusal('unsupported');
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
    try {
      this.requireFactsCurrent(request, facts);
    } catch {
      await this.cleanupRecord(requested, 'failed', 'recovery-required');
      throw new RelayEnrollmentRefusal('unavailable');
    }
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

  /** Persist one inert continuation under the exact reserved pending Device. */
  async issuePendingContinuation(
    enrollmentId: string,
    signal: AbortSignal,
  ): Promise<
    Awaited<
      ReturnType<ApplicationSessionService['issuePendingRelayContinuation']>
    >
  > {
    this.ensureOpen();
    const entry = this.options.journal.get(enrollmentId);
    if (
      !entry ||
      !('enrollmentId' in entry) ||
      entry.state !== 'device-pending' ||
      entry.expiresAt <= this.now() ||
      !entry.deviceId ||
      !entry.providerSessionId ||
      !entry.issuer ||
      !entry.subject ||
      !entry.requestOrigin ||
      !entry.approvalId ||
      !entry.approvalPrincipalId ||
      entry.issuedScope?.length !== 1 ||
      entry.issuedScope[0] !== PAIRING_SCOPE_ORCHESTRATION_READ ||
      !this.isTrustedOrigin(entry.clientOrigin)
    )
      throw new RelayEnrollmentRefusal('invalid');
    if (signal.aborted) throw new RelayEnrollmentRefusal('unavailable');
    const applicationSessions = this.options.applicationSessions;
    if (!applicationSessions) throw new RelayEnrollmentRefusal('unsupported');
    const authorityKey = randomUUID();
    const reserved = this.options.journal.transition({
      enrollmentId,
      expectedStates: ['device-pending'],
      nextState: 'continuation-pending',
      patch: { authorityKey },
    });
    if (!reserved) throw new RelayEnrollmentRefusal('unavailable');
    try {
      const continuation =
        await applicationSessions.issuePendingRelayContinuation({
          enrollmentId,
          deviceId: reserved.deviceId!,
          providerSessionId: reserved.providerSessionId!,
          issuer: reserved.issuer!,
          subject: reserved.subject!,
          approvalId: reserved.approvalId!,
          approvedBy: reserved.approvalPrincipalId!,
          authorityKey,
          stationId: reserved.stationId,
          clientOrigin: reserved.clientOrigin,
          key: reserved.publicKey,
          keyThumbprint: reserved.keyThumbprint,
          nonce: reserved.nonce,
          expiresAt: reserved.expiresAt,
          signal,
        });
      if (signal.aborted) throw new RelayEnrollmentRefusal('unavailable');
      return continuation;
    } catch (error) {
      await this.cleanupRecord(reserved, 'failed', 'recovery-required');
      throw error instanceof RelayEnrollmentRefusal
        ? error
        : new RelayEnrollmentRefusal('unavailable');
    }
  }

  /** Exchange only after operator approval, then deliver an inert secret bundle once. */
  async finalizeFreshClient(
    request: Request,
  ): Promise<RelayEnrollmentFinalizeResponse> {
    this.ensureOpen();
    const facts = this.requireVerifiedIngress(
      request,
      RELAY_ENROLLMENT_FINALIZE_PATH,
    );
    this.reserveAnonymousBudget('finalize');
    this.requireJsonPost(request);
    const bounded = await readBoundedRequestBody(request, 2 * 1024);
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
      Object.keys(body).sort().join(',') !== 'enrollmentId,proof' ||
      typeof body.enrollmentId !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.enrollmentId) ||
      typeof body.proof !== 'string' ||
      body.proof.length > 4096
    )
      throw new RelayEnrollmentRefusal('invalid');
    const entry = this.options.journal.get(body.enrollmentId);
    if (!entry || !('enrollmentId' in entry))
      throw new RelayEnrollmentRefusal('expired');
    if (entry.expiresAt <= this.now()) {
      await this.cleanupRecord(entry, 'expired', 'expired');
      throw new RelayEnrollmentRefusal('expired');
    }
    if (!this.entryMatchesIngress(entry, facts))
      throw new RelayEnrollmentRefusal('invalid');
    const proof = await this.verifyFreshPurposeProof(
      request,
      facts,
      entry,
      body.proof,
      'finalize',
      entry.nonce,
      RELAY_ENROLLMENT_FINALIZE_PATH,
      {},
    );
    if (!proof) throw new RelayEnrollmentRefusal('invalid');
    this.requireFactsCurrent(request, facts);
    if (entry.state === 'pairing-requested')
      return {
        version: RELAY_ENROLLMENT_VERSION,
        state: 'pending',
        enrollmentId: entry.enrollmentId,
        expiresAt: new Date(entry.expiresAt).toISOString(),
      };
    if (entry.state === 'awaiting-ack') {
      // The delivery secret is intentionally not stored for redelivery. A
      // repeated finalize means the previous bundle may have been lost; revoke
      // this inert attempt and require a new one instead of guessing whether
      // its secret reached the browser.
      await this.cleanupRecord(entry, 'failed', 'recovery-required');
      throw new RelayEnrollmentRefusal('unavailable');
    }
    if (entry.state !== 'approved')
      throw new RelayEnrollmentRefusal('unavailable');

    let exchanged: ReturnType<DevicePairingService['exchangeRelayEnrollment']>;
    try {
      exchanged = await this.exchangeApprovedDevice(
        entry.enrollmentId,
        request.signal,
      );
      this.requireFactsCurrent(request, facts);
    } catch (error) {
      await this.cleanupCurrentAttempt(
        entry.enrollmentId,
        'failed',
        'recovery-required',
      );
      throw error instanceof RelayEnrollmentRefusal
        ? error
        : new RelayEnrollmentRefusal('unavailable');
    }

    let continuation: Awaited<
      ReturnType<ApplicationSessionService['issuePendingRelayContinuation']>
    >;
    try {
      continuation = await this.issuePendingContinuation(
        entry.enrollmentId,
        request.signal,
      );
      this.requireFactsCurrent(request, facts);
      const current = this.options.journal.get(entry.enrollmentId);
      if (
        !current ||
        !('enrollmentId' in current) ||
        current.state !== 'continuation-pending'
      )
        throw new RelayEnrollmentRefusal('unavailable');
      await this.requireCurrentPendingProvider(current, request.signal);
      this.requirePendingDeviceBinding(current);
      if (
        !this.options.applicationSessions?.verifyPendingRelayContinuation({
          authorityKey: continuation.authorityKey,
          enrollmentId: current.enrollmentId,
          deviceId: current.deviceId!,
          issuer: current.issuer!,
          subject: current.subject!,
          approvalId: current.approvalId!,
          approvedBy: current.approvalPrincipalId!,
          clientOrigin: current.clientOrigin,
          keyThumbprint: current.keyThumbprint,
        })
      )
        throw new RelayEnrollmentRefusal('unavailable');
    } catch (error) {
      await this.cleanupCurrentAttempt(
        entry.enrollmentId,
        'failed',
        'recovery-required',
      );
      throw error instanceof RelayEnrollmentRefusal
        ? error
        : new RelayEnrollmentRefusal('unavailable');
    }

    const latest = this.options.journal.get(entry.enrollmentId);
    if (
      !latest ||
      !('enrollmentId' in latest) ||
      latest.state !== 'continuation-pending' ||
      latest.deviceId !== exchanged.device.id ||
      latest.authorityKey !== continuation.authorityKey
    ) {
      await this.cleanupCurrentAttempt(
        entry.enrollmentId,
        'failed',
        'recovery-required',
      );
      throw new RelayEnrollmentRefusal('unavailable');
    }
    const bundle = {
      stationId: latest.stationId,
      deviceId: exchanged.device.id,
      deviceCredential: exchanged.credential,
      continuation,
    };
    const bundleDigest = createHash('sha256')
      .update(canonicalRelayJson(bundle), 'utf8')
      .digest('base64url');
    const activationNonce = encodeOpaque(randomBytes(32));
    const expiresAt = Math.min(
      latest.expiresAt,
      Date.parse(continuation.expiresAt),
    );
    if (expiresAt <= this.now()) {
      await this.cleanupRecord(latest, 'expired', 'expired');
      throw new RelayEnrollmentRefusal('expired');
    }
    const awaiting = this.options.journal.transition({
      enrollmentId: entry.enrollmentId,
      expectedStates: ['continuation-pending'],
      nextState: 'awaiting-ack',
      patch: { activationNonce, bundleDigest },
    });
    if (!awaiting) {
      await this.cleanupCurrentAttempt(
        entry.enrollmentId,
        'failed',
        'recovery-required',
      );
      throw new RelayEnrollmentRefusal('unavailable');
    }
    try {
      this.requireFactsCurrent(request, facts);
      request.signal.throwIfAborted();
    } catch {
      await this.cleanupRecord(awaiting, 'failed', 'recovery-required');
      throw new RelayEnrollmentRefusal('unavailable');
    }
    return {
      version: RELAY_ENROLLMENT_VERSION,
      state: 'delivered',
      enrollmentId: awaiting.enrollmentId,
      activationNonce,
      bundleDigest,
      bundle,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** A signed receipt activates the exact provider, continuation and pending Device. */
  async activateFreshClient(
    request: Request,
  ): Promise<RelayEnrollmentActivatedResponse> {
    this.ensureOpen();
    const facts = this.requireVerifiedIngress(
      request,
      RELAY_ENROLLMENT_ACTIVATE_PATH,
    );
    this.reserveAnonymousBudget('activate');
    this.requireJsonPost(request);
    const bounded = await readBoundedRequestBody(request, 3 * 1024);
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
      Object.keys(body).sort().join(',') !==
        'activationNonce,authorityKey,bundleDigest,deviceId,enrollmentId,proof' ||
      typeof body.enrollmentId !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.enrollmentId) ||
      typeof body.activationNonce !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.activationNonce) ||
      typeof body.deviceId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(body.deviceId) ||
      typeof body.authorityKey !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(body.authorityKey) ||
      typeof body.bundleDigest !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.bundleDigest) ||
      typeof body.proof !== 'string' ||
      body.proof.length > 4096
    )
      throw new RelayEnrollmentRefusal('invalid');
    const entry = this.options.journal.get(body.enrollmentId);
    if (!entry || !('enrollmentId' in entry))
      throw new RelayEnrollmentRefusal('expired');
    if (entry.expiresAt <= this.now()) {
      await this.cleanupRecord(entry, 'expired', 'expired');
      throw new RelayEnrollmentRefusal('expired');
    }
    if (!this.entryMatchesIngress(entry, facts))
      throw new RelayEnrollmentRefusal('invalid');
    const proof = await this.verifyFreshPurposeProof(
      request,
      facts,
      entry,
      body.proof,
      'activate',
      body.activationNonce,
      RELAY_ENROLLMENT_ACTIVATE_PATH,
      {
        deviceId: body.deviceId,
        authorityKey: body.authorityKey,
        bundleDigest: body.bundleDigest,
      },
    );
    if (!proof) throw new RelayEnrollmentRefusal('invalid');
    const receiptDigest = createHash('sha256')
      .update(body.proof, 'utf8')
      .digest('base64url');
    if (entry.state === 'committed') {
      if (
        entry.deviceId !== body.deviceId ||
        entry.activationNonce !== body.activationNonce ||
        entry.bundleDigest !== body.bundleDigest ||
        entry.ackJti !== proof.jti ||
        entry.receiptDigest !== receiptDigest
      )
        throw new RelayEnrollmentRefusal('invalid');
      return this.currentCommittedActivationReceipt(
        entry,
        body.authorityKey,
        request,
        facts,
      );
    }
    if (entry.state === 'activating')
      throw new RelayEnrollmentRefusal('unavailable');
    if (
      entry.state !== 'awaiting-ack' ||
      entry.deviceId !== body.deviceId ||
      entry.authorityKey !== body.authorityKey ||
      entry.activationNonce !== body.activationNonce ||
      entry.bundleDigest !== body.bundleDigest
    )
      throw new RelayEnrollmentRefusal('invalid');
    const activating = this.options.journal.transition({
      enrollmentId: entry.enrollmentId,
      expectedStates: ['awaiting-ack'],
      nextState: 'activating',
      patch: { ackJti: proof.jti, receiptDigest },
    });
    if (!activating) {
      const latest = this.options.journal.get(entry.enrollmentId);
      if (
        latest &&
        'enrollmentId' in latest &&
        latest.state === 'committed' &&
        latest.deviceId === body.deviceId &&
        latest.activationNonce === body.activationNonce &&
        latest.bundleDigest === body.bundleDigest &&
        latest.ackJti === proof.jti &&
        latest.receiptDigest === receiptDigest
      )
        // Committed journal receipts scrub authorityKey; the signed body key is revalidated against the active continuation.
        return this.currentCommittedActivationReceipt(
          latest,
          body.authorityKey,
          request,
          facts,
        );
      throw new RelayEnrollmentRefusal('unavailable');
    }

    try {
      await this.requireCurrentPendingProvider(activating, request.signal);
      this.requirePendingDeviceBinding(activating);
      if (
        !this.options.applicationSessions?.verifyPendingRelayContinuation({
          authorityKey: activating.authorityKey!,
          enrollmentId: activating.enrollmentId,
          deviceId: activating.deviceId!,
          issuer: activating.issuer!,
          subject: activating.subject!,
          approvalId: activating.approvalId!,
          approvedBy: activating.approvalPrincipalId!,
          clientOrigin: activating.clientOrigin,
          keyThumbprint: activating.keyThumbprint,
        })
      )
        throw new RelayEnrollmentRefusal('unavailable');
      this.requireFactsCurrent(request, facts);
      request.signal.throwIfAborted();
      await this.options.authentication!.promotePendingEnrollment(
        activating.enrollmentId,
        activating.providerSessionId!,
        request.signal,
      );
      this.requireFactsCurrent(request, facts);
      request.signal.throwIfAborted();
      const active = await this.options.authentication!.verifySessionReference(
        activating.providerSessionId!,
        request.signal,
      );
      if (
        active.kind !== 'authenticated' ||
        active.issuer !== activating.issuer ||
        active.session.subject !== activating.subject
      )
        throw new RelayEnrollmentRefusal('unavailable');
      this.requirePendingDeviceBinding(activating);
      if (
        !this.options.applicationSessions?.verifyPendingRelayContinuation({
          authorityKey: activating.authorityKey!,
          enrollmentId: activating.enrollmentId,
          deviceId: activating.deviceId!,
          issuer: activating.issuer!,
          subject: activating.subject!,
          approvalId: activating.approvalId!,
          approvedBy: activating.approvalPrincipalId!,
          clientOrigin: activating.clientOrigin,
          keyThumbprint: activating.keyThumbprint,
        })
      )
        throw new RelayEnrollmentRefusal('unavailable');
      this.requireFactsCurrent(request, facts);
      request.signal.throwIfAborted();
      const activeDevice = this.options.pairing.activateRelayEnrollmentDevice(
        activating.deviceId!,
        activating.enrollmentId,
      );
      const binding = activeDevice.principalBinding;
      if (
        activeDevice.id !== activating.deviceId ||
        activeDevice.scope !== PAIRING_SCOPE_ORCHESTRATION_READ ||
        !binding ||
        !('kind' in binding) ||
        binding.kind !== 'account' ||
        binding.issuer !== activating.issuer ||
        binding.subject !== activating.subject ||
        binding.approvalId !== activating.approvalId ||
        binding.approvedBy !== activating.approvalPrincipalId
      )
        throw new RelayEnrollmentRefusal('unavailable');
      const committed = this.options.journal.transition({
        enrollmentId: activating.enrollmentId,
        expectedStates: ['activating'],
        nextState: 'committed',
      });
      if (!committed) throw new RelayEnrollmentRefusal('unavailable');
      return this.activationReceipt(committed);
    } catch (error) {
      await this.cleanupRecord(activating, 'failed', 'activation-failed');
      throw error instanceof RelayEnrollmentRefusal
        ? error
        : new RelayEnrollmentRefusal('unavailable');
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

  private reserveAnonymousBudget(
    kind: 'begin' | 'login' | 'finalize' | 'activate',
  ): void {
    const now = this.now();
    if (
      now < this.anonymousWindowStartedAt ||
      now - this.anonymousWindowStartedAt >= ANONYMOUS_WINDOW_MS
    ) {
      this.anonymousWindowStartedAt = now;
      this.anonymousBeginCount = 0;
      this.anonymousLoginCount = 0;
      this.anonymousFinalizeCount = 0;
      this.anonymousActivateCount = 0;
    }
    if (kind === 'begin') {
      if (this.anonymousBeginCount >= MAX_ANONYMOUS_BEGIN_PER_WINDOW)
        throw new RelayEnrollmentRefusal('rate_limited');
      this.anonymousBeginCount += 1;
    } else if (kind === 'login') {
      if (this.anonymousLoginCount >= MAX_ANONYMOUS_LOGIN_PER_WINDOW)
        throw new RelayEnrollmentRefusal('rate_limited');
      this.anonymousLoginCount += 1;
    } else if (kind === 'finalize') {
      if (this.anonymousFinalizeCount >= MAX_ANONYMOUS_FINALIZE_PER_WINDOW)
        throw new RelayEnrollmentRefusal('rate_limited');
      this.anonymousFinalizeCount += 1;
    } else {
      if (this.anonymousActivateCount >= MAX_ANONYMOUS_ACTIVATE_PER_WINDOW)
        throw new RelayEnrollmentRefusal('rate_limited');
      this.anonymousActivateCount += 1;
    }
  }

  private entryMatchesIngress(
    entry: RelayEnrollmentRecord,
    facts: NonNullable<
      ReturnType<typeof readVerifiedVirtualApplicationRequest>
    >,
  ): boolean {
    return (
      entry.stationId === facts.stationId &&
      entry.requestOrigin === facts.requestOrigin &&
      entry.clientOrigin === facts.clientOrigin &&
      (entry.connectionEnrollmentId === undefined ||
        entry.connectionEnrollmentId === facts.connectionEnrollmentId) &&
      (entry.routingGeneration === undefined ||
        entry.routingGeneration === facts.routingGeneration) &&
      (entry.connectionId === undefined ||
        entry.connectionId === facts.connectionId)
    );
  }

  private async requireCurrentPendingProvider(
    entry: RelayEnrollmentRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const authentication = this.options.authentication;
    if (!authentication?.pendingEnrollmentCapabilities().available)
      throw new RelayEnrollmentRefusal('unsupported');
    if (!entry.providerSessionId || !entry.issuer || !entry.subject)
      throw new RelayEnrollmentRefusal('invalid');
    const verified = await authentication.verifyPendingEnrollment(
      entry.enrollmentId,
      entry.providerSessionId,
      signal,
    );
    if (verified.kind === 'unavailable')
      throw new RelayEnrollmentRefusal('unavailable');
    if (
      verified.kind !== 'pending' ||
      verified.session.enrollmentId !== entry.enrollmentId ||
      verified.session.sessionId !== entry.providerSessionId ||
      verified.session.subject !== entry.subject ||
      authentication.describe().issuer !== entry.issuer
    )
      throw new RelayEnrollmentRefusal('invalid');
  }

  private requirePendingDeviceBinding(entry: RelayEnrollmentRecord): void {
    if (
      !entry.deviceId ||
      !entry.issuer ||
      !entry.subject ||
      !entry.approvalId ||
      !entry.approvalPrincipalId ||
      entry.issuedScope?.length !== 1 ||
      entry.issuedScope[0] !== PAIRING_SCOPE_ORCHESTRATION_READ
    )
      throw new RelayEnrollmentRefusal('invalid');
    const assertion = this.options.pairing.resolvePendingRelayDevice(
      entry.deviceId,
      entry.enrollmentId,
    );
    if (
      !assertion ||
      assertion.deviceId !== entry.deviceId ||
      assertion.enrollmentId !== entry.enrollmentId ||
      assertion.issuer !== entry.issuer ||
      assertion.subject !== entry.subject ||
      assertion.approvalId !== entry.approvalId ||
      assertion.approvedBy !== entry.approvalPrincipalId ||
      assertion.scope.length !== 1 ||
      assertion.scope[0] !== PAIRING_SCOPE_ORCHESTRATION_READ
    )
      throw new RelayEnrollmentRefusal('invalid');
  }

  private async cleanupCurrentAttempt(
    enrollmentId: string,
    terminalState: RelayEnrollmentTerminalState,
    reason:
      | 'expired'
      | 'recovery-required'
      | 'provider-rejected'
      | 'provider-unavailable'
      | 'login-proof-rejected'
      | 'activation-failed',
  ): Promise<void> {
    const latest = this.options.journal.get(enrollmentId);
    if (!latest || !('enrollmentId' in latest)) return;
    await this.cleanupRecord(latest, terminalState, reason);
  }

  private activationReceipt(
    record: RelayEnrollmentRecord,
  ): RelayEnrollmentActivatedResponse {
    if (
      record.state !== 'committed' ||
      !record.deviceId ||
      !record.receiptDigest ||
      !record.receiptExpiresAt
    )
      throw new RelayEnrollmentRefusal('unavailable');
    return {
      version: RELAY_ENROLLMENT_VERSION,
      state: 'active',
      enrollmentId: record.enrollmentId,
      deviceId: record.deviceId,
      receiptDigest: record.receiptDigest,
      receiptExpiresAt: new Date(record.receiptExpiresAt).toISOString(),
    };
  }

  private async currentCommittedActivationReceipt(
    record: RelayEnrollmentRecord,
    authorityKey: string,
    request: Request,
    facts: NonNullable<
      ReturnType<typeof readVerifiedVirtualApplicationRequest>
    >,
  ): Promise<RelayEnrollmentActivatedResponse> {
    if (!record.deviceId || !/^[0-9a-f-]{36}$/i.test(authorityKey))
      throw new RelayEnrollmentRefusal('unavailable');
    const activeDevice =
      this.options.pairing.resolveActiveRelayEnrollmentDevice(
        record.deviceId,
        record.enrollmentId,
      );
    if (
      activeDevice?.scope.length !== 1 ||
      activeDevice.scope[0] !== PAIRING_SCOPE_ORCHESTRATION_READ
    )
      throw new RelayEnrollmentRefusal('unavailable');
    const current =
      await this.options.applicationSessions?.verifyActiveRelayContinuation({
        authorityKey,
        enrollmentId: record.enrollmentId,
        deviceId: record.deviceId,
        clientOrigin: record.clientOrigin,
        keyThumbprint: record.keyThumbprint,
        signal: request.signal,
      });
    if (!current) throw new RelayEnrollmentRefusal('unavailable');
    this.requireFactsCurrent(request, facts);
    request.signal.throwIfAborted();
    const latest = this.options.journal.get(record.enrollmentId);
    if (
      !latest ||
      !('enrollmentId' in latest) ||
      latest.state !== 'committed' ||
      latest.deviceId !== record.deviceId ||
      latest.activationNonce !== record.activationNonce ||
      latest.bundleDigest !== record.bundleDigest ||
      latest.ackJti !== record.ackJti ||
      latest.receiptDigest !== record.receiptDigest
    )
      throw new RelayEnrollmentRefusal('unavailable');
    return this.activationReceipt(latest);
  }

  private async verifyFreshLoginProof(
    request: Request,
    facts: NonNullable<
      ReturnType<typeof readVerifiedVirtualApplicationRequest>
    >,
    entry: RelayEnrollmentRecord,
    token: string,
  ): Promise<{ jti: string } | undefined> {
    const verified = await this.verifyFreshPurposeProof(
      request,
      facts,
      entry,
      token,
      'login',
      entry.nonce,
      RELAY_ENROLLMENT_LOGIN_PATH,
      {},
    );
    return verified ? { jti: verified.jti } : undefined;
  }

  private async verifyFreshPurposeProof(
    request: Request,
    facts: NonNullable<
      ReturnType<typeof readVerifiedVirtualApplicationRequest>
    >,
    entry: RelayEnrollmentRecord,
    token: string,
    purpose: 'login' | 'finalize' | 'activate',
    nonce: string,
    path: string,
    bindings: Record<string, string>,
  ): Promise<{ jti: string; payload: JWTPayload } | undefined> {
    try {
      if (token.length > 4096 || token.split('.').length !== 3)
        return undefined;
      const key = await importJWK(entry.publicKey, 'ES256');
      const verified = await jwtVerify(token, key, {
        algorithms: ['ES256'],
        audience: RELAY_ENROLLMENT_PROOF_AUDIENCE,
        clockTolerance: 0,
      });
      this.requireFactsCurrent(request, facts);
      const header = verified.protectedHeader;
      const payload: JWTPayload = verified.payload;
      const expectedClaimNames = [...PROOF_CLAIM_KEYS, ...Object.keys(bindings)]
        .sort()
        .join(',');
      if (
        header.alg !== 'ES256' ||
        header.typ !== RELAY_ENROLLMENT_PROOF_TYPE ||
        Object.keys(payload).sort().join(',') !== expectedClaimNames ||
        payload.aud !== RELAY_ENROLLMENT_PROOF_AUDIENCE ||
        payload.v !== RELAY_ENROLLMENT_VERSION ||
        payload.stationId !== entry.stationId ||
        payload.enrollmentId !== entry.enrollmentId ||
        payload.clientOrigin !== entry.clientOrigin ||
        payload.keyThumbprint !== entry.keyThumbprint ||
        payload.nonce !== nonce ||
        payload.purpose !== purpose ||
        payload.htm !== 'POST' ||
        payload.htu !== `${facts.requestOrigin}${path}` ||
        typeof payload.jti !== 'string' ||
        !/^[A-Za-z0-9_-]{22}$/.test(payload.jti) ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp)
      )
        return undefined;
      for (const [name, value] of Object.entries(bindings))
        if (payload[name] !== value) return undefined;
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
      return { jti: payload.jti, payload };
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
      | 'login-proof-rejected'
      | 'activation-failed',
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
          record.enrollmentId,
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
