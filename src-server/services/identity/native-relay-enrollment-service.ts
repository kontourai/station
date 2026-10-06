import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  NATIVE_RELAY_ENROLLMENT_PROOF_TYPE,
  NATIVE_RELAY_ENROLLMENT_VERSION,
  type NativeRelayEnrollmentActivated,
  type NativeRelayEnrollmentChallenge,
  type NativeRelayEnrollmentDelivery,
  type NativeRelayEnrollmentPending,
  type NativeRelayEnrollmentStatus,
} from '@kontourai/station-contracts/native-relay-enrollment';
import { compactVerify, importJWK } from 'jose';
import { z } from 'zod';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import type { NativeSurfaceRegistry } from '../connections/native-surface-registry.js';
import {
  type NativeEnrollmentRecord,
  NativeRelayEnrollmentJournal,
} from '../relay/native-relay-enrollment-journal.js';
import type { ConnectionSigningKeyStore } from '../ssh/connection-signing-key-store.js';
import type { DevicePairingService } from '../ssh/device-pairing-service.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import {
  NativeDeviceProofBindingService,
  NativeDeviceProofOperatorAuthority,
} from '../ssh/native-device-proof-binding-service.js';
import type { DeploymentAuthenticationService } from './deployment-authentication-service.js';
import { NativeEnrollmentCapability } from './native-enrollment-capability.js';
import {
  nativeEnrollmentBindingSchema,
  nativeEnrollmentCandidateSchema,
  nativeEnrollmentCanonical,
  nativeEnrollmentOpaque,
  nativeEnrollmentPayloadDigest,
  nativeEnrollmentProofSchema,
  nativeEnrollmentRecipientSchema,
} from './native-relay-enrollment-schema.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from './principal-resolver.js';

const TTL = 300_000;
const opaque = () => randomBytes(32).toString('base64url');
const proof = z.string().min(1).max(8192);
const beginSchema = z
  .object({
    version: z.literal(NATIVE_RELAY_ENROLLMENT_VERSION),
    clientAttemptId: nativeEnrollmentOpaque,
    peerNonce: nativeEnrollmentOpaque,
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    recipient: nativeEnrollmentRecipientSchema,
  })
  .strict();
const loginSchema = z
  .object({
    enrollmentId: nativeEnrollmentOpaque,
    candidate: nativeEnrollmentCandidateSchema,
    proof,
    credentials: z
      .object({
        username: z.string().min(3).max(32),
        password: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();
const registerSchema = loginSchema
  .extend({
    invitation: nativeEnrollmentOpaque,
    name: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
const purposeSchema = z
  .object({ enrollmentId: nativeEnrollmentOpaque, proof })
  .strict();
const statusSchema = purposeSchema
  .extend({ candidate: nativeEnrollmentCandidateSchema.optional() })
  .strict();
const activateSchema = purposeSchema
  .extend({
    deviceId: z.string().uuid(),
    bindingId: z.string().uuid(),
    activationNonce: nativeEnrollmentOpaque,
    bundleDigest: nativeEnrollmentOpaque,
  })
  .strict();
type Approval = ReturnType<NativeDeviceProofOperatorAuthority['approve']>;
type NativeRefusalCode =
  | 'invalid'
  | 'expired'
  | 'unsupported'
  | 'unavailable'
  | 'approval_required'
  | 'operator_required'
  | 'replayed'
  | 'busy';

export class NativeRelayEnrollmentRefusal extends Error {
  constructor(readonly code: NativeRefusalCode) {
    super(`native_enrollment_${code}`);
  }
}
export interface NativeRelayEnrollmentServiceOptions {
  stationId: string;
  origin: string;
  registry: NativeSurfaceRegistry;
  journal: NativeRelayEnrollmentJournal;
  pairing: DevicePairingService;
  bindings: NativeDeviceProofBindingService;
  authentication: DeploymentAuthenticationService;
  signing: ConnectionSigningKeyStore;
  operatorSecurity: Pick<
    EnvironmentSecurityService,
    'verifyOperatorCredential' | 'authorizeCredential' | 'resolveGrantedScope'
  >;
  now?: () => number;
}

/** Candidate-only native lifecycle; transport approval never becomes person or Device authority. */
export class NativeRelayEnrollmentService {
  readonly #now: () => number;
  readonly #credentials = new Map<string, Buffer>();
  readonly #bindingApprovals = new Map<string, Approval>();
  readonly #busy = new Set<string>();
  #closed = false;
  constructor(private readonly options: NativeRelayEnrollmentServiceOptions) {
    this.#now = options.now ?? Date.now;
  }
  capability(request: Request): NativeEnrollmentCapability {
    if (this.#closed) throw new NativeRelayEnrollmentRefusal('unavailable');
    try {
      return NativeEnrollmentCapability.forRequest(request, this.options);
    } catch {
      throw new NativeRelayEnrollmentRefusal('invalid');
    }
  }
  async #body<T>(
    cap: NativeEnrollmentCapability,
    schema: z.ZodType<T>,
  ): Promise<T> {
    cap.assertCurrent();
    const raw = await readBoundedRequestBody(cap.request, 16384);
    cap.assertCurrent();
    if (raw.status !== 'ok') throw new NativeRelayEnrollmentRefusal('invalid');
    try {
      const value: unknown = JSON.parse(raw.body);
      if (nativeEnrollmentCanonical(value) !== raw.body)
        throw new Error('noncanonical');
      return schema.parse(value);
    } catch {
      throw new NativeRelayEnrollmentRefusal('invalid');
    }
  }
  #matches(
    record: NativeEnrollmentRecord,
    cap: NativeEnrollmentCapability,
    terminalRecovery = false,
  ): void {
    const f = cap.facts;
    if (
      record.binding.stationId !== f.stationId ||
      record.binding.stationAudience !== f.requestOrigin ||
      record.binding.scope.enrollmentId !== f.connectionEnrollmentId ||
      (record.binding.scope.routingGeneration !== f.routingGeneration &&
        !(
          terminalRecovery &&
          record.binding.scope.routingGeneration < f.routingGeneration
        )) ||
      nativeEnrollmentCanonical(record.binding.surface) !==
        nativeEnrollmentCanonical(f.surface)
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
    cap.assertCurrent();
  }
  #generation(): number {
    const trust = this.options.signing.readDescriptor();
    if (!trust || trust.stationId !== this.options.stationId)
      throw new NativeRelayEnrollmentRefusal('unavailable');
    return trust.generation;
  }
  async begin(
    cap: NativeEnrollmentCapability,
  ): Promise<NativeRelayEnrollmentChallenge> {
    if (!this.options.authentication.pendingEnrollmentCapabilities().available)
      throw new NativeRelayEnrollmentRefusal('unsupported');
    const body = await this.#body(cap, beginSchema);
    if (
      body.expiresAt <= this.#now() ||
      body.expiresAt > this.#now() + TTL + 5000
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
    let record = this.options.journal.byClientAttempt(body.clientAttemptId);
    if (record) {
      this.#matches(record, cap);
      if (
        nativeEnrollmentCanonical(record.binding.recipient) !==
          nativeEnrollmentCanonical(body.recipient) ||
        record.binding.peerNonce !== body.peerNonce ||
        record.recipientExpiresAt !== body.expiresAt ||
        record.state !== 'challenge'
      )
        throw new NativeRelayEnrollmentRefusal('invalid');
      if (record.expiresAt <= this.#now()) {
        await this.#cleanup(record, 'expired');
        throw new NativeRelayEnrollmentRefusal('expired');
      }
    } else {
      const now = this.#now();
      const f = cap.facts;
      record = {
        binding: nativeEnrollmentBindingSchema.parse({
          stationId: f.stationId,
          stationAudience: f.requestOrigin,
          scope: {
            stationId: f.stationId,
            enrollmentId: f.connectionEnrollmentId,
            routingGeneration: f.routingGeneration,
          },
          surface: f.surface,
          peerNonce: body.peerNonce,
          enrollmentId: opaque(),
          reservedDeviceId: randomUUID(),
          recipient: body.recipient,
        }),
        clientAttemptId: body.clientAttemptId,
        recipientExpiresAt: body.expiresAt,
        nonce: opaque(),
        state: 'challenge',
        createdAt: now,
        expiresAt: Math.min(now + TTL, body.expiresAt),
      };
      this.options.journal.reserve(record);
    }
    const result = await this.options.signing.signNativeEnrollmentChallenge({
      ...record.binding,
      version: NATIVE_RELAY_ENROLLMENT_VERSION,
      nonce: record.nonce,
      expiresAt: record.expiresAt,
      clientAttemptId: record.clientAttemptId,
      responsePeerNonce: cap.facts.peerNonce,
      requestedScope: 'orchestration:read',
      registrationAvailable:
        this.options.authentication.pendingEnrollmentRegistrationAvailable(),
      stationSigningGeneration: this.#generation(),
    });
    const current = this.options.journal.get(record.binding.enrollmentId);
    if (
      current?.state !== 'challenge' ||
      current.nonce !== record.nonce ||
      current.expiresAt <= this.#now()
    )
      throw new NativeRelayEnrollmentRefusal('unavailable');
    cap.assertCurrent();
    return result;
  }
  #candidateMatches(
    record: NativeEnrollmentRecord,
    candidate: NonNullable<NativeEnrollmentRecord['candidate']>,
  ): void {
    const key = candidate.deviceProofJwk;
    const point = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(key.x, 'base64url'),
      Buffer.from(key.y, 'base64url'),
    ]).toString('base64url');
    if (
      candidate.stationId !== record.binding.stationId ||
      candidate.deviceId !== record.binding.reservedDeviceId ||
      nativeEnrollmentCanonical(candidate.surface) !==
        nativeEnrollmentCanonical(record.binding.surface) ||
      point === record.binding.recipient.publicKey ||
      (!record.candidate &&
        this.options.bindings.bindingById({ bindingId: candidate.bindingId }))
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
  }
  async #verify(
    cap: NativeEnrollmentCapability,
    record: NativeEnrollmentRecord,
    body: { proof: string },
    purpose:
      | 'login'
      | 'register'
      | 'finalize'
      | 'activate'
      | 'status'
      | 'cancel',
    candidate = record.candidate,
  ): Promise<void> {
    const terminalRecovery =
      (purpose === 'status' || purpose === 'cancel') &&
      record.expiresAt <= this.#now() &&
      !['device-pending', 'awaiting-ack', 'activating', 'committed'].includes(
        record.state,
      ) &&
      record.bundleDigest === undefined &&
      record.ackDigest === undefined;
    this.#matches(record, cap, terminalRecovery);
    if (!candidate) throw new NativeRelayEnrollmentRefusal('invalid');
    const { proof: compact, ...payload } = body;
    let proofIdentity: { jti: string; expiresAt: number };
    try {
      const verified = await compactVerify(
        compact,
        await importJWK(candidate.deviceProofJwk, 'ES256'),
        { algorithms: ['ES256'] },
      );
      if (
        verified.protectedHeader.alg !== 'ES256' ||
        verified.protectedHeader.typ !== NATIVE_RELAY_ENROLLMENT_PROOF_TYPE ||
        Object.keys(verified.protectedHeader).sort().join(',') !== 'alg,typ'
      )
        throw new Error('header');
      const claims = nativeEnrollmentProofSchema.parse(
        JSON.parse(Buffer.from(verified.payload).toString('utf8')),
      );
      const expected = { ...record.binding, peerNonce: cap.facts.peerNonce };
      const {
        version: _,
        purpose: __,
        candidate: ___,
        nonce: ____,
        htm: _____,
        htu: ______,
        payloadSha256: _______,
        jti,
        iat,
        exp,
        requestedScope: ________,
        ...binding
      } = claims;
      const now = Math.floor(this.#now() / 1000);
      if (
        nativeEnrollmentCanonical(binding) !==
          nativeEnrollmentCanonical(expected) ||
        claims.purpose !== purpose ||
        claims.htm !== 'POST' ||
        claims.htu !== new URL(cap.request.url).pathname ||
        claims.nonce !==
          (purpose === 'activate' ? record.activationNonce : record.nonce) ||
        nativeEnrollmentCanonical(claims.candidate) !==
          nativeEnrollmentCanonical(candidate) ||
        claims.payloadSha256 !== nativeEnrollmentPayloadDigest(payload) ||
        iat > now + 5 ||
        exp <= now ||
        exp <= iat ||
        exp - iat > 30
      )
        throw new Error('proof');
      proofIdentity = { jti, expiresAt: exp * 1000 };
    } catch {
      throw new NativeRelayEnrollmentRefusal('invalid');
    }
    try {
      this.options.journal.consumeProof(
        record.binding.enrollmentId,
        proofIdentity.jti,
        proofIdentity.expiresAt,
        this.#now(),
      );
    } catch (error) {
      throw new NativeRelayEnrollmentRefusal(
        error instanceof Error &&
          error.message === 'native_enrollment_proof_replayed'
          ? 'replayed'
          : 'unavailable',
      );
    }

    cap.assertCurrent();
  }
  async login(
    cap: NativeEnrollmentCapability,
    register = false,
  ): Promise<NativeRelayEnrollmentPending> {
    const body = register
      ? await this.#body(cap, registerSchema)
      : await this.#body(cap, loginSchema);
    const record = this.options.journal.get(body.enrollmentId);
    if (
      !record ||
      ['cancelled', 'expired', 'failed', 'cleaning'].includes(record.state) ||
      record.expiresAt <= this.#now()
    )
      throw new NativeRelayEnrollmentRefusal('expired');
    const candidate = body.candidate;
    this.#candidateMatches(record, candidate);
    await this.#verify(
      cap,
      record,
      body,
      register ? 'register' : 'login',
      candidate,
    );
    const loginIdentity = nativeEnrollmentCanonical({
      username: body.credentials.username,
      registration: register,
      ...('name' in body ? { name: body.name } : {}),
      ...('invitation' in body && typeof body.invitation === 'string'
        ? {
            invitationDigest: createHash('sha256')
              .update(body.invitation)
              .digest('base64url'),
          }
        : {}),
    });
    if (record.state !== 'challenge') {
      if (
        record.loginIdentity !== loginIdentity ||
        nativeEnrollmentCanonical(record.candidate) !==
          nativeEnrollmentCanonical(candidate) ||
        !record.requestId ||
        !record.providerSessionId
      )
        throw new NativeRelayEnrollmentRefusal('busy');
      if (record.state === 'committed') {
        const account =
          await this.options.authentication.verifySessionReference(
            record.providerSessionId,
            cap.request.signal,
          );
        if (
          account.kind !== 'authenticated' ||
          account.issuer !== record.issuer ||
          account.session.subject !== record.subject
        )
          throw new NativeRelayEnrollmentRefusal('invalid');
      } else await this.#pendingCurrent(record, cap.request.signal);
      const current = this.options.journal.get(body.enrollmentId);
      if (
        current?.loginIdentity !== loginIdentity ||
        current.providerSessionId !== record.providerSessionId ||
        ['cleaning', 'cancelled', 'expired', 'failed'].includes(current.state)
      )
        throw new NativeRelayEnrollmentRefusal('unavailable');
      cap.assertCurrent();
      return {
        version: NATIVE_RELAY_ENROLLMENT_VERSION,
        state: 'pending',
        enrollmentId: body.enrollmentId,
        requestId: record.requestId,
        expiresAt: record.expiresAt,
      };
    }
    if (
      !this.options.authentication.pendingEnrollmentCapabilities().available ||
      (register &&
        !this.options.authentication.pendingEnrollmentRegistrationAvailable())
    )
      throw new NativeRelayEnrollmentRefusal('unsupported');
    const descriptor = this.options.authentication.describe();
    const pending = this.options.journal.transition(
      body.enrollmentId,
      ['challenge'],
      'provider-creating',
      { candidate, loginIdentity },
    );
    try {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const nativeCredentials = {
        ...body.credentials,
        ...('name' in body ? { name: body.name } : {}),
      };
      if ('invitation' in body && typeof body.invitation === 'string')
        headers.set('x-station-invitation', body.invitation);
      const request = new Request(
        `${this.options.origin}/api/account-auth/native-pending-provider`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(nativeCredentials),
          signal: cap.request.signal,
        },
      );
      const account = register
        ? await this.options.authentication.registerPendingEnrollment(
            body.enrollmentId,
            request,
          )
        : await this.options.authentication.createPendingEnrollment(
            body.enrollmentId,
            request,
          );
      cap.assertCurrent();
      if (
        account.kind !== 'pending' ||
        account.session.enrollmentId !== body.enrollmentId
      )
        throw new NativeRelayEnrollmentRefusal('invalid');
      this.options.journal.transition(
        body.enrollmentId,
        ['provider-creating'],
        'provider-pending',
        {
          providerSessionId: account.session.sessionId,
          issuer: descriptor.issuer,
          subject: account.session.subject,
          displayName: account.session.displayName,
        },
      );
      const offer = this.options.pairing.requestRelayEnrollmentAccess({
        enrollmentId: body.enrollmentId,
        endpoint: this.options.origin,
        candidate: {
          issuer: descriptor.issuer,
          subject: account.session.subject,
          displayName: account.session.displayName,
        },
        sessionId: account.session.sessionId,
      });
      let requested: NativeEnrollmentRecord;
      try {
        requested = this.options.journal.transition(
          body.enrollmentId,
          ['provider-pending'],
          'requested',
          {
            offerId: offer.offerId,
            offerProof: offer.proof,
            requestId: offer.requestId,
          },
        );
      } catch (error) {
        this.options.pairing.discardRelayEnrollmentOffer(
          offer.offerId,
          body.enrollmentId,
        );
        throw error;
      }
      cap.assertCurrent();
      return {
        version: NATIVE_RELAY_ENROLLMENT_VERSION,
        state: 'pending',
        enrollmentId: body.enrollmentId,
        requestId: offer.requestId,
        expiresAt: requested.expiresAt,
      };
    } catch (error) {
      await this.#cleanup(
        this.options.journal.get(body.enrollmentId) ?? pending,
        'failed',
      );
      throw error;
    }
  }
  #operator(request: Request): boolean {
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    return (
      principal?.authority === 'operator-credential' &&
      this.options.operatorSecurity.verifyOperatorCredential(
        principal.credential,
      ) &&
      isRuntimeRequestPrincipalCurrent(request, this.options.operatorSecurity)
    );
  }
  pendingApprovals(request: Request) {
    this.assertOperator(request);
    return this.options.journal
      .list()
      .filter(
        (record) =>
          record.state === 'requested' && record.expiresAt > this.#now(),
      )
      .map((record) => ({
        enrollmentId: record.binding.enrollmentId,
        requestId: record.requestId,
        candidate: record.candidate,
        account: {
          issuer: record.issuer,
          subject: record.subject,
          displayName: record.displayName,
        },
        requestedScope: 'orchestration:read' as const,
        expiresAt: record.expiresAt,
      }));
  }
  assertOperator(request: Request): void {
    if (!this.#operator(request))
      throw new NativeRelayEnrollmentRefusal('operator_required');
  }
  async approve(
    request: Request,
    enrollmentId: string,
    candidate: unknown,
  ): Promise<void> {
    this.assertOperator(request);
    const record = this.options.journal.get(enrollmentId);
    if (
      !record ||
      record.state !== 'requested' ||
      !record.candidate ||
      !record.providerSessionId ||
      !record.issuer ||
      !record.subject ||
      !record.requestId ||
      record.expiresAt <= this.#now() ||
      nativeEnrollmentCanonical(candidate) !==
        nativeEnrollmentCanonical(record.candidate)
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
    const provider = await this.options.authentication.verifyPendingEnrollment(
      enrollmentId,
      record.providerSessionId,
      request.signal,
    );
    const current = this.options.journal.get(enrollmentId);
    const transport = this.options.registry
      .approvedSurfaces()
      .find(
        (value) =>
          nativeEnrollmentCanonical(value.scope) ===
            nativeEnrollmentCanonical(record.binding.scope) &&
          nativeEnrollmentCanonical(value.surface) ===
            nativeEnrollmentCanonical(record.binding.surface),
      );
    if (
      !this.#operator(request) ||
      !transport?.isCurrent() ||
      current?.state !== 'requested' ||
      nativeEnrollmentCanonical(current.candidate) !==
        nativeEnrollmentCanonical(record.candidate) ||
      provider.kind !== 'pending' ||
      provider.session.subject !== record.subject ||
      provider.session.enrollmentId !== enrollmentId ||
      record.issuer !== this.options.authentication.describe().issuer
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
    const confirmation = this.options.pairing.confirmRelayEnrollmentRequest(
      record.requestId,
      { kind: 'presented-credential' },
      LOCAL_OPERATOR_PRINCIPAL_ID,
      {
        enrollmentId,
        sessionId: record.providerSessionId,
        issuer: record.issuer,
        subject: record.subject,
      },
    );
    if (
      !confirmation.principalBinding ||
      !('kind' in confirmation.principalBinding) ||
      confirmation.principalBinding.kind !== 'account' ||
      confirmation.principalBinding.issuer !== record.issuer ||
      confirmation.principalBinding.subject !== record.subject ||
      confirmation.principalBinding.approvedBy !== LOCAL_OPERATOR_PRINCIPAL_ID
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
    const approval = new NativeDeviceProofOperatorAuthority().approve({
      operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
      tuple: {
        operation: 'create',
        stationId: record.binding.stationId,
        deviceId: record.binding.reservedDeviceId,
        bindingId: record.candidate.bindingId,
        surface: record.candidate.surface,
        jwk: record.candidate.deviceProofJwk,
      },
    });
    this.#bindingApprovals.set(enrollmentId, approval);
    this.options.journal.transition(enrollmentId, ['requested'], 'approved', {
      approvalId: confirmation.principalBinding?.approvalId,
    });
  }
  async #pendingCurrent(
    record: NativeEnrollmentRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      !record.providerSessionId ||
      !record.subject ||
      !record.issuer ||
      record.issuer !== this.options.authentication.describe().issuer
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
    const current = await this.options.authentication.verifyPendingEnrollment(
      record.binding.enrollmentId,
      record.providerSessionId,
      signal,
    );
    if (
      current.kind !== 'pending' ||
      current.session.subject !== record.subject ||
      current.session.enrollmentId !== record.binding.enrollmentId
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
  }
  async finalize(
    cap: NativeEnrollmentCapability,
  ): Promise<NativeRelayEnrollmentPending | NativeRelayEnrollmentDelivery> {
    const body = await this.#body(cap, purposeSchema);
    let record = this.options.journal.get(body.enrollmentId);
    if (!record || !record.candidate || record.expiresAt <= this.#now())
      throw new NativeRelayEnrollmentRefusal('expired');
    await this.#verify(cap, record, body, 'finalize');
    if (record.state === 'requested')
      return {
        version: NATIVE_RELAY_ENROLLMENT_VERSION,
        state: 'pending',
        enrollmentId: body.enrollmentId,
        requestId: record.requestId!,
        expiresAt: record.expiresAt,
      };
    if (this.#busy.has(body.enrollmentId))
      throw new NativeRelayEnrollmentRefusal('busy');
    this.#busy.add(body.enrollmentId);
    try {
      await this.#pendingCurrent(record, cap.request.signal);
      cap.assertCurrent();
      if (record.state === 'approved') {
        record = this.options.journal.transition(
          body.enrollmentId,
          ['approved'],
          'device-pending',
        );
        const exchanged = this.options.pairing.exchangeRelayEnrollment({
          enrollmentId: body.enrollmentId,
          deviceId: record.binding.reservedDeviceId,
          offerId: record.offerId!,
          proof: record.offerProof!,
          requestId: record.requestId!,
        });
        this.#credentials.set(
          body.enrollmentId,
          Buffer.from(exchanged.credential),
        );
        record = this.options.journal.transition(
          body.enrollmentId,
          ['device-pending'],
          'awaiting-ack',
          { activationNonce: opaque() },
        );
      }
      const credential = this.#credentials.get(body.enrollmentId);
      if (
        record.state !== 'awaiting-ack' ||
        !credential ||
        !record.activationNonce
      )
        throw new NativeRelayEnrollmentRefusal('unavailable');
      const delivered = await this.options.signing.sealNativeEnrollmentDelivery(
        {
          version: NATIVE_RELAY_ENROLLMENT_VERSION,
          state: 'delivered',
          binding: record.binding,
          candidate: record.candidate!,
          activationNonce: record.activationNonce,
          expiresAt: record.expiresAt,
          responsePeerNonce: cap.facts.peerNonce,
          stationSigningGeneration: this.#generation(),
        },
        {
          version: NATIVE_RELAY_ENROLLMENT_VERSION,
          stationId: record.binding.stationId,
          deviceId: record.binding.reservedDeviceId,
          deviceCredential: credential.toString(),
        },
      );
      if (record.bundleDigest && record.bundleDigest !== delivered.bundleDigest)
        throw new NativeRelayEnrollmentRefusal('invalid');
      if (!record.bundleDigest)
        this.options.journal.transition(
          body.enrollmentId,
          ['awaiting-ack'],
          'awaiting-ack',
          { bundleDigest: delivered.bundleDigest },
        );
      const current = this.options.journal.get(body.enrollmentId);
      if (
        current?.state !== 'awaiting-ack' ||
        current.activationNonce !== delivered.activationNonce ||
        current.bundleDigest !== delivered.bundleDigest
      )
        throw new NativeRelayEnrollmentRefusal('unavailable');
      cap.assertCurrent();
      return delivered;
    } finally {
      this.#busy.delete(body.enrollmentId);
    }
  }
  async activate(
    cap: NativeEnrollmentCapability,
  ): Promise<NativeRelayEnrollmentActivated> {
    const body = await this.#body(cap, activateSchema);
    let record = this.options.journal.get(body.enrollmentId);
    if (
      !record ||
      !record.candidate ||
      record.state !== 'awaiting-ack' ||
      record.expiresAt <= this.#now() ||
      body.deviceId !== record.binding.reservedDeviceId ||
      body.bindingId !== record.candidate.bindingId ||
      body.activationNonce !== record.activationNonce ||
      body.bundleDigest !== record.bundleDigest
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
    await this.#verify(cap, record, body, 'activate');
    if (this.#busy.has(body.enrollmentId))
      throw new NativeRelayEnrollmentRefusal('busy');
    this.#busy.add(body.enrollmentId);
    try {
      await this.#pendingCurrent(record, cap.request.signal);
      cap.assertCurrent();
      const approval = this.#bindingApprovals.get(body.enrollmentId);
      if (!approval || !record.providerSessionId)
        throw new NativeRelayEnrollmentRefusal('unavailable');
      const providerSessionId = record.providerSessionId;
      record = this.options.journal.transition(
        body.enrollmentId,
        ['awaiting-ack'],
        'activating',
        {
          ackDigest: createHash('sha256')
            .update(body.proof)
            .digest('base64url'),
        },
      );
      await this.options.authentication.promotePendingEnrollment(
        body.enrollmentId,
        providerSessionId,
        cap.request.signal,
      );
      cap.assertCurrent();
      const account = await this.options.authentication.verifySessionReference(
        providerSessionId,
        cap.request.signal,
      );
      cap.assertCurrent();
      const pendingDevice = this.options.pairing.resolvePendingRelayDevice(
        record.binding.reservedDeviceId,
        body.enrollmentId,
      );
      if (
        account.kind !== 'authenticated' ||
        account.issuer !== record.issuer ||
        account.session.subject !== record.subject ||
        pendingDevice?.issuer !== record.issuer ||
        pendingDevice.subject !== record.subject ||
        pendingDevice.approvalId !== record.approvalId ||
        pendingDevice.approvedBy !== LOCAL_OPERATOR_PRINCIPAL_ID
      )
        throw new NativeRelayEnrollmentRefusal('invalid');
      const device = this.options.pairing.activateRelayEnrollmentDevice(
        record.binding.reservedDeviceId,
        body.enrollmentId,
      );
      if (device.id !== record.binding.reservedDeviceId)
        throw new NativeRelayEnrollmentRefusal('invalid');
      this.options.bindings.createBinding({
        bindingId: record.candidate!.bindingId,
        deviceId: device.id,
        surface: record.candidate!.surface,
        jwk: record.candidate!.deviceProofJwk,
        approval,
      });
      record = this.options.journal.transition(
        body.enrollmentId,
        ['activating'],
        'committed',
        { receiptExpiresAt: this.#now() + TTL },
      );
      this.#bindingApprovals.delete(body.enrollmentId);
      this.#credentials.get(body.enrollmentId)?.fill(0);
      this.#credentials.delete(body.enrollmentId);
      return await this.#receipt(record, cap);
    } catch (error) {
      await this.#cleanup(
        this.options.journal.get(body.enrollmentId) ?? record,
        'failed',
      );
      throw error;
    } finally {
      this.#busy.delete(body.enrollmentId);
    }
  }
  async #receipt(
    record: NativeEnrollmentRecord,
    cap: NativeEnrollmentCapability,
  ): Promise<NativeRelayEnrollmentActivated> {
    if (!this.#active(record) || !record.candidate || !record.ackDigest)
      throw new NativeRelayEnrollmentRefusal('invalid');
    const actual = this.options.bindings.currentBinding({
      deviceId: record.binding.reservedDeviceId,
      surface: record.binding.surface,
    });
    if (!actual) throw new NativeRelayEnrollmentRefusal('unavailable');
    const deviceBinding = actual.binding;
    const result = await this.options.signing.signNativeEnrollmentReceipt({
      version: NATIVE_RELAY_ENROLLMENT_VERSION,
      state: 'active',
      enrollmentId: record.binding.enrollmentId,
      deviceId: record.binding.reservedDeviceId,
      bindingId: record.candidate.bindingId,
      receiptDigest: record.ackDigest,
      receiptExpiresAt: this.#now() + 30000,
      binding: record.binding,
      candidate: record.candidate,
      deviceReceipt: {
        version: 'station-native-device-proof-self-receipt/v1',
        currentDeviceBinding: true,
        binding: {
          stationId: deviceBinding.stationId,
          deviceId: deviceBinding.deviceId,
          bindingId: deviceBinding.bindingId,
          surface: deviceBinding.surface,
          deviceProofJwk: deviceBinding.deviceProof.jwk,
          deviceProofKeyThumbprint: deviceBinding.deviceProof.thumbprint,
          state: 'active',
          createdAt: deviceBinding.createdAt,
          approvedAt: deviceBinding.approvedAt,
        },
      },
      responsePeerNonce: cap.facts.peerNonce,
      stationSigningGeneration: this.#generation(),
    });
    const current = this.options.journal.get(record.binding.enrollmentId);
    if (
      current?.state !== 'committed' ||
      current.ackDigest !== record.ackDigest ||
      !this.#active(current)
    )
      throw new NativeRelayEnrollmentRefusal('unavailable');
    cap.assertCurrent();
    return result;
  }
  #active(record: NativeEnrollmentRecord): boolean {
    const device = this.options.pairing.resolveActiveRelayEnrollmentDevice(
      record.binding.reservedDeviceId,
      record.binding.enrollmentId,
    );
    const binding = this.options.bindings.currentBinding({
      deviceId: record.binding.reservedDeviceId,
      surface: record.binding.surface,
    });
    return (
      !!record.candidate &&
      !!device &&
      device.issuer === record.issuer &&
      device.subject === record.subject &&
      device.approvalId === record.approvalId &&
      device.approvedBy === LOCAL_OPERATOR_PRINCIPAL_ID &&
      binding?.binding.bindingId === record.candidate.bindingId &&
      nativeEnrollmentCanonical(binding.binding.deviceProof.jwk) ===
        nativeEnrollmentCanonical(record.candidate.deviceProofJwk)
    );
  }
  async status(
    cap: NativeEnrollmentCapability,
    cancel = false,
  ): Promise<NativeRelayEnrollmentStatus> {
    const body = await this.#body(cap, statusSchema);
    let record = this.options.journal.get(body.enrollmentId);
    if (!record) throw new NativeRelayEnrollmentRefusal('invalid');
    if (!record.candidate && !cancel && record.expiresAt > this.#now())
      throw new NativeRelayEnrollmentRefusal('invalid');
    const candidate = record.candidate ?? body.candidate;
    if (
      !candidate ||
      (record.candidate &&
        body.candidate &&
        nativeEnrollmentCanonical(record.candidate) !==
          nativeEnrollmentCanonical(body.candidate))
    )
      throw new NativeRelayEnrollmentRefusal('invalid');
    this.#candidateMatches(record, candidate);
    await this.#verify(
      cap,
      record,
      body,
      cancel ? 'cancel' : 'status',
      candidate,
    );
    // A pre-login candidate can authorize only signed status and terminal cleanup.
    if (!record.candidate)
      record = this.options.journal.transition(
        body.enrollmentId,
        [record.state],
        record.state,
        { candidate },
      );
    if (cancel) {
      if (record.state === 'committed')
        record = this.options.journal.transition(
          body.enrollmentId,
          ['committed'],
          'cleaning',
        );
      await this.#cleanup(record, 'cancelled');
      record = this.options.journal.get(body.enrollmentId)!;
    }
    if (record.state === 'committed') {
      if (!record.candidate)
        throw new NativeRelayEnrollmentRefusal('unavailable');
      if (this.#active(record)) return await this.#receipt(record, cap);
      const revoked = await this.options.signing.signNativeEnrollmentStatus({
        version: NATIVE_RELAY_ENROLLMENT_VERSION,
        state: 'revoked',
        binding: record.binding,
        candidate: record.candidate,
        responsePeerNonce: cap.facts.peerNonce,
        observedAt: this.#now(),
        stationSigningGeneration: this.#generation(),
      });
      const current = this.options.journal.get(body.enrollmentId);
      if (
        current?.state !== 'committed' ||
        current.ackDigest !== record.ackDigest ||
        this.#active(current)
      )
        throw new NativeRelayEnrollmentRefusal('unavailable');
      cap.assertCurrent();
      return revoked;
    }
    if (
      record.expiresAt <= this.#now() &&
      !['cancelled', 'expired', 'failed'].includes(record.state)
    ) {
      await this.#cleanup(record, 'expired');
      record = this.options.journal.get(body.enrollmentId)!;
    }
    const result = await this.options.signing.signNativeEnrollmentStatus({
      version: NATIVE_RELAY_ENROLLMENT_VERSION,
      state:
        record.state === 'cancelled'
          ? 'cancelled'
          : record.state === 'expired' || record.state === 'failed'
            ? 'expired'
            : 'pending',
      binding: record.binding,
      candidate: record.candidate!,
      responsePeerNonce: cap.facts.peerNonce,
      observedAt: this.#now(),
      stationSigningGeneration: this.#generation(),
    });
    if (this.options.journal.get(body.enrollmentId)?.state !== record.state)
      throw new NativeRelayEnrollmentRefusal('unavailable');
    cap.assertCurrent();
    return result;
  }
  async #cleanup(
    record: NativeEnrollmentRecord,
    state: 'expired' | 'cancelled' | 'failed',
  ): Promise<void> {
    const id = record.binding.enrollmentId;
    if (record.state === 'committed') return;
    if (record.state !== 'cleaning')
      record = this.options.journal.transition(id, [record.state], 'cleaning');
    this.#bindingApprovals.delete(id);
    this.#credentials.get(id)?.fill(0);
    this.#credentials.delete(id);
    this.options.pairing.discardRelayEnrollmentDevice(
      record.binding.reservedDeviceId,
      id,
    );
    const signal = AbortSignal.timeout(10000);
    await this.options.authentication.discardPendingEnrollment(
      id,
      record.providerSessionId,
      signal,
    );
    if (record.providerSessionId)
      await this.options.authentication.revokeSessionReference(
        record.providerSessionId,
        signal,
      );
    if (record.offerId)
      this.options.pairing.discardRelayEnrollmentOffer(record.offerId, id);
    this.options.journal.transition(id, ['cleaning'], state);
  }
  async recoverBeforeAdmission(): Promise<void> {
    for (const record of this.options.journal.list())
      if (
        !['committed', 'expired', 'cancelled', 'failed'].includes(record.state)
      )
        await this.#cleanup(record, 'expired');
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.recoverBeforeAdmission();
    for (const value of this.#credentials.values()) value.fill(0);
    this.#credentials.clear();
    this.#bindingApprovals.clear();
    this.options.journal.close();
  }
}
