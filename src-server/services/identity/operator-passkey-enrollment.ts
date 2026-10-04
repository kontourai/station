/**
 * Operator passkey ENROLLMENT (#3257, S2b; design decisions D5, D7, D10).
 *
 * The ceremony, in order. Nothing is stored before the host confirms.
 *
 *  1. The operator's paired browser, on the HTTPS consent origin, asks for
 *     enrollment. The service returns a short CODE that only that browser
 *     sees, and a request id that only that browser holds.
 *  2. On the host, the operator types the code the browser displays
 *     (`station environment operator passkeys approve <code>`). The host
 *     never sees the code in a listing, so confirming means comparing it
 *     with the browser, not copying it from the host.
 *  3. Only a confirmed request may start the WebAuthn registration
 *     ceremony; the challenge is single-use and short-lived.
 *  4. The verified credential's PUBLIC key is stored. The request is
 *     consumed: one confirmation enrolls one passkey.
 *
 * State is process-local on purpose. A pending request lives minutes, and a
 * restart that drops one only makes the browser ask again; nothing here is
 * worth a durable store, and a durable pending-code table would be one more
 * secret on disk.
 *
 * Nothing in logs or metrics carries a code, request id, challenge, or any
 * credential bytes.
 */
import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import {
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { operatorPasskeyEnrollmentOps } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import type {
  OperatorPasskey,
  OperatorPasskeyRegistry,
} from './operator-passkey-registry.js';

/** How long the browser has to get the host to confirm. */
export const ENROLLMENT_REQUEST_TTL_MS = 5 * 60_000;
/** After confirmation, how long the registration ceremony may take. */
export const ENROLLMENT_CEREMONY_TTL_MS = 5 * 60_000;
/** One registration challenge is valid this long, and for one verification. */
export const ENROLLMENT_CHALLENGE_TTL_MS = 2 * 60_000;
export const ENROLLMENT_CODE_DIGITS = 6;
/** Live requests at once. A larger pool would make a blind code guess likelier. */
export const ENROLLMENT_MAX_LIVE_REQUESTS = 5;
/** Option mints and failed verifications one confirmation may spend. */
export const ENROLLMENT_MAX_CEREMONY_ATTEMPTS = 3;
/** Wrong or malformed host-side codes tolerated per window before a lockout. */
export const ENROLLMENT_CODE_FAILURE_LIMIT = 5;
export const ENROLLMENT_CODE_FAILURE_WINDOW_MS = 5 * 60_000;
export const OPERATOR_PASSKEY_LABEL_MAX = 64;

const SUPPORTED_ALGORITHMS = [-8, -7, -257]; // EdDSA, ES256, RS256
const KNOWN_TRANSPORTS = new Set([
  'ble',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

export type EnrollmentErrorCode =
  | 'enrollment_unavailable'
  | 'too_many_requests'
  | 'request_not_found'
  | 'request_not_confirmed'
  | 'request_closed'
  | 'invalid_code'
  | 'rate_limited'
  | 'challenge_invalid'
  | 'verification_failed'
  | 'invalid_label'
  | 'passkey_not_found';

export class OperatorPasskeyEnrollmentError extends Error {
  constructor(
    readonly code: EnrollmentErrorCode,
    message: string,
    /** Milliseconds until a `rate_limited` caller may retry. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'OperatorPasskeyEnrollmentError';
  }
}

export type EnrollmentRequestState =
  | 'pending'
  | 'confirmed'
  | 'denied'
  | 'consumed'
  | 'expired';

interface EnrollmentRequest {
  readonly id: string;
  readonly code: string;
  /** SHA-256 of the requesting browser's credential; never the credential. */
  readonly binding: Buffer;
  readonly deviceLabel: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: 'pending' | 'confirmed' | 'denied' | 'consumed';
  ceremonyExpiresAt: number;
  ceremonyAttempts: number;
  challenge: { value: string; expiresAt: number } | null;
}

export interface PendingEnrollmentSummary {
  /** Short, non-secret handle for correlation in the host's own listing. */
  readonly reference: string;
  readonly deviceLabel: string;
  readonly rpId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface EnrollmentAvailability {
  readonly available: boolean;
  /** Present when unavailable: the sentence the operator reads. */
  readonly reason?: string;
  readonly rpId?: string;
  readonly origin?: string;
}

export interface OperatorPasskeyEnrollmentOptions {
  readonly registry: OperatorPasskeyRegistry;
  /** `STATION_TRUSTED_CONSENT_ORIGIN`, already validated; null when unset. */
  readonly origin: string | null;
  readonly now?: () => number;
  readonly logger?: Logger;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function equalDigests(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class OperatorPasskeyEnrollmentService {
  readonly #registry: OperatorPasskeyRegistry;
  readonly #origin: string | null;
  readonly #rpId: string | null;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  readonly #requests = new Map<string, EnrollmentRequest>();
  #codeFailures: number[] = [];

  constructor(options: OperatorPasskeyEnrollmentOptions) {
    this.#registry = options.registry;
    this.#origin = options.origin;
    // The RP ID derives from the CONFIGURED origin's host, never from a
    // request's Host header, so a request cannot choose which domain a
    // passkey is scoped to.
    this.#rpId =
      options.origin === null ? null : new URL(options.origin).hostname;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  availability(): EnrollmentAvailability {
    if (this.#origin === null || this.#rpId === null) {
      return {
        available: false,
        reason:
          'Operator passkey enrollment needs STATION_TRUSTED_CONSENT_ORIGIN, an HTTPS origin on a DNS name. A Station reachable only by IP address has no remote operator sign-in.',
      };
    }
    return { available: true, rpId: this.#rpId, origin: this.#origin };
  }

  /** The configured RP ID, for display. Null when enrollment is unavailable. */
  get rpId(): string | null {
    return this.#rpId;
  }

  // ---- browser side -------------------------------------------------------

  /**
   * Opens a pending request for the browser holding `credential` (a paired
   * device's or the operator's own session credential).
   */
  createRequest(input: { credential: string; deviceLabel: string }): {
    requestId: string;
    code: string;
    expiresAt: number;
    rpId: string;
  } {
    const rpId = this.#requireAvailable();
    this.#sweep();
    const binding = digest(input.credential);
    // One live request per browser: asking again replaces the earlier one,
    // so a page reload does not strand a code the host could still confirm.
    for (const request of this.#requests.values()) {
      if (
        request.state !== 'consumed' &&
        request.state !== 'denied' &&
        equalDigests(request.binding, binding)
      ) {
        this.#requests.delete(request.id);
      }
    }
    const live = [...this.#requests.values()].filter(
      (request) => request.state === 'pending' || request.state === 'confirmed',
    );
    if (live.length >= ENROLLMENT_MAX_LIVE_REQUESTS) {
      operatorPasskeyEnrollmentOps.add(1, {
        step: 'refused',
        reason: 'too_many_requests',
      });
      throw new OperatorPasskeyEnrollmentError(
        'too_many_requests',
        'Too many enrollment requests are waiting. Deny or let them expire, then try again.',
      );
    }
    const now = this.#now();
    let code: string;
    do {
      code = randomInt(0, 10 ** ENROLLMENT_CODE_DIGITS)
        .toString()
        .padStart(ENROLLMENT_CODE_DIGITS, '0');
    } while (live.some((request) => request.code === code));
    const request: EnrollmentRequest = {
      id: randomBytes(32).toString('base64url'),
      code,
      binding,
      deviceLabel: sanitizeLabel(input.deviceLabel) ?? 'Paired browser',
      createdAt: now,
      expiresAt: now + ENROLLMENT_REQUEST_TTL_MS,
      state: 'pending',
      ceremonyExpiresAt: 0,
      ceremonyAttempts: 0,
      challenge: null,
    };
    this.#requests.set(request.id, request);
    operatorPasskeyEnrollmentOps.add(1, { step: 'requested' });
    this.#logger?.info('Operator passkey enrollment requested', {
      reference: referenceOf(request),
    });
    return {
      requestId: request.id,
      code: request.code,
      expiresAt: request.expiresAt,
      rpId,
    };
  }

  status(
    requestId: string,
    credential: string,
  ): { state: EnrollmentRequestState; expiresAt: number } {
    const request = this.#ownedRequest(requestId, credential);
    return {
      state: this.#effectiveState(request),
      expiresAt: request.expiresAt,
    };
  }

  /** Mints single-use registration options for a CONFIRMED request. */
  async beginRegistration(
    requestId: string,
    credential: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const rpId = this.#requireAvailable();
    const request = this.#ownedRequest(requestId, credential);
    this.#requireConfirmed(request);
    if (request.ceremonyAttempts >= ENROLLMENT_MAX_CEREMONY_ATTEMPTS) {
      this.#close(request);
      throw refuse('request_closed', 'This enrollment request is used up.');
    }
    request.ceremonyAttempts += 1;
    // A new challenge replaces any earlier one: only the latest is valid.
    request.challenge = null;
    const options = await generateRegistrationOptions({
      rpName: 'Station operator',
      rpID: rpId,
      userName: 'station-operator',
      userDisplayName: 'Station operator',
      userID: this.#registry.userHandle(),
      attestationType: 'none',
      timeout: ENROLLMENT_CHALLENGE_TTL_MS,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
      excludeCredentials: this.#registry
        .activeCredentialIds()
        .map(({ id, transports }) => ({ id, transports })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    request.challenge = {
      value: options.challenge,
      expiresAt: Math.min(
        this.#now() + ENROLLMENT_CHALLENGE_TTL_MS,
        request.ceremonyExpiresAt,
      ),
    };
    return options;
  }

  /**
   * Verifies the browser's registration response against the single-use
   * challenge, then stores the PUBLIC key and consumes the request.
   */
  async finishRegistration(
    requestId: string,
    credential: string,
    response: RegistrationResponseJSON,
    label: unknown,
  ): Promise<OperatorPasskey> {
    const origin = this.#origin;
    const rpId = this.#requireAvailable();
    const request = this.#ownedRequest(requestId, credential);
    this.#requireConfirmed(request);
    // Single use: the challenge is taken BEFORE verification, so a failed
    // attempt, a replay, and a concurrent duplicate all find it gone.
    const challenge = request.challenge;
    request.challenge = null;
    if (challenge === null || challenge.expiresAt <= this.#now()) {
      throw refuse(
        'challenge_invalid',
        'The registration challenge is missing, used or expired. Start again.',
      );
    }
    const cleanLabel =
      label === undefined || label === null || label === ''
        ? `Passkey ${this.#registry.listActive().length + 1}`
        : sanitizeLabel(label);
    if (cleanLabel === null) {
      throw refuse(
        'invalid_label',
        `The label must be 1 to ${OPERATOR_PASSKEY_LABEL_MAX} printable characters.`,
      );
    }
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      if (hasCrossOriginClientData(response)) {
        throw new Error('cross-origin ceremony');
      }
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.value,
        expectedOrigin: origin as string,
        expectedRPID: rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
      });
    } catch {
      return this.#failedVerification(request);
    }
    if (!verification.verified || !verification.registrationInfo) {
      return this.#failedVerification(request);
    }
    const info = verification.registrationInfo;
    let stored: OperatorPasskey;
    try {
      stored = this.#registry.add({
        credentialId: info.credential.id,
        publicKey: info.credential.publicKey,
        counter: info.credential.counter,
        transports: (info.credential.transports ?? []).filter((transport) =>
          KNOWN_TRANSPORTS.has(transport),
        ),
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        label: cleanLabel,
        rpId,
        origin: origin as string,
      });
    } catch {
      // The credential id is already registered (excludeCredentials is advice
      // to the authenticator, not a guarantee), or the store refused.
      return this.#failedVerification(request);
    }
    request.state = 'consumed';
    operatorPasskeyEnrollmentOps.add(1, { step: 'enrolled' });
    this.#logger?.info('Operator passkey enrolled', { passkeyId: stored.id });
    return stored;
  }

  // ---- host side ----------------------------------------------------------

  /** Waiting requests WITHOUT their codes: the host compares, it does not copy. */
  listPending(): PendingEnrollmentSummary[] {
    this.#sweep();
    const rpId = this.#rpId ?? '';
    return [...this.#requests.values()]
      .filter((request) => request.state === 'pending')
      .map((request) => ({
        reference: referenceOf(request),
        deviceLabel: request.deviceLabel,
        rpId,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      }));
  }

  /** Confirms the pending request whose browser displays `code`. */
  confirm(code: unknown): { deviceLabel: string; rpId: string } {
    const request = this.#matchCode(code);
    request.state = 'confirmed';
    request.ceremonyExpiresAt = this.#now() + ENROLLMENT_CEREMONY_TTL_MS;
    operatorPasskeyEnrollmentOps.add(1, { step: 'confirmed' });
    this.#logger?.info('Operator passkey enrollment confirmed', {
      reference: referenceOf(request),
    });
    return { deviceLabel: request.deviceLabel, rpId: this.#rpId ?? '' };
  }

  deny(code: unknown): { deviceLabel: string } {
    const request = this.#matchCode(code);
    request.state = 'denied';
    operatorPasskeyEnrollmentOps.add(1, { step: 'denied' });
    this.#logger?.info('Operator passkey enrollment denied', {
      reference: referenceOf(request),
    });
    return { deviceLabel: request.deviceLabel };
  }

  listPasskeys(): OperatorPasskey[] {
    return this.#registry.listActive();
  }

  revokePasskey(id: unknown): OperatorPasskey {
    if (typeof id !== 'string' || !this.#registry.revoke(id)) {
      throw new OperatorPasskeyEnrollmentError(
        'passkey_not_found',
        'No active operator passkey has that id.',
      );
    }
    operatorPasskeyEnrollmentOps.add(1, { step: 'revoked' });
    this.#logger?.info('Operator passkey revoked', { passkeyId: id });
    return this.#registry.get(id) as OperatorPasskey;
  }

  // ---- internals ----------------------------------------------------------

  #requireAvailable(): string {
    if (this.#rpId === null || this.#origin === null) {
      operatorPasskeyEnrollmentOps.add(1, {
        step: 'refused',
        reason: 'enrollment_unavailable',
      });
      throw new OperatorPasskeyEnrollmentError(
        'enrollment_unavailable',
        this.availability().reason as string,
      );
    }
    return this.#rpId;
  }

  /**
   * Constant-time match of `code` against EVERY pending request (no early
   * exit, fixed-size digests), under a failure budget that also locks out the
   * right code: otherwise the lockout would only slow a guesser who has not
   * yet guessed correctly.
   */
  #matchCode(code: unknown): EnrollmentRequest {
    this.#requireAvailable();
    this.#sweep();
    const now = this.#now();
    this.#codeFailures = this.#codeFailures.filter(
      (at) => now - at < ENROLLMENT_CODE_FAILURE_WINDOW_MS,
    );
    if (this.#codeFailures.length >= ENROLLMENT_CODE_FAILURE_LIMIT) {
      const retryAfterMs =
        (this.#codeFailures[0] as number) +
        ENROLLMENT_CODE_FAILURE_WINDOW_MS -
        now;
      operatorPasskeyEnrollmentOps.add(1, {
        step: 'refused',
        reason: 'rate_limited',
      });
      throw new OperatorPasskeyEnrollmentError(
        'rate_limited',
        'Too many wrong codes. Wait before trying again.',
        retryAfterMs,
      );
    }
    const wellFormed =
      typeof code === 'string' &&
      new RegExp(`^[0-9]{${ENROLLMENT_CODE_DIGITS}}$`).test(code);
    const candidate = digest(wellFormed ? (code as string) : '');
    let matched: EnrollmentRequest | null = null;
    for (const request of this.#requests.values()) {
      const equal = equalDigests(candidate, digest(request.code));
      if (equal && wellFormed && request.state === 'pending') {
        matched = request;
      }
    }
    if (matched === null) {
      this.#codeFailures.push(now);
      operatorPasskeyEnrollmentOps.add(1, {
        step: 'refused',
        reason: 'invalid_code',
      });
      throw new OperatorPasskeyEnrollmentError(
        'invalid_code',
        'No pending enrollment request has that code. Check the code shown in the browser; it expires after 5 minutes and works once.',
      );
    }
    return matched;
  }

  #ownedRequest(requestId: string, credential: string): EnrollmentRequest {
    this.#sweep();
    const request =
      typeof requestId === 'string' ? this.#requests.get(requestId) : undefined;
    // Same answer for "unknown" and "someone else's": the id is a bearer
    // capability and its existence is not information to give away.
    if (!request || !equalDigests(request.binding, digest(credential))) {
      throw refuse('request_not_found', 'No such enrollment request.');
    }
    return request;
  }

  #requireConfirmed(request: EnrollmentRequest): void {
    const state = this.#effectiveState(request);
    if (state === 'confirmed') return;
    if (state === 'pending') {
      throw refuse(
        'request_not_confirmed',
        'The host has not confirmed this request yet.',
      );
    }
    throw refuse('request_closed', `This enrollment request is ${state}.`);
  }

  #effectiveState(request: EnrollmentRequest): EnrollmentRequestState {
    const now = this.#now();
    if (request.state === 'pending' && now >= request.expiresAt)
      return 'expired';
    if (request.state === 'confirmed' && now >= request.ceremonyExpiresAt) {
      return 'expired';
    }
    return request.state;
  }

  #failedVerification(request: EnrollmentRequest): never {
    operatorPasskeyEnrollmentOps.add(1, {
      step: 'refused',
      reason: 'verification_failed',
    });
    if (request.ceremonyAttempts >= ENROLLMENT_MAX_CEREMONY_ATTEMPTS) {
      this.#close(request);
    }
    throw refuse(
      'verification_failed',
      'The passkey could not be verified for this Station. Nothing was saved.',
    );
  }

  #close(request: EnrollmentRequest): void {
    request.state = 'consumed';
    request.challenge = null;
  }

  /** Drops finished and expired requests so the map cannot grow unbounded. */
  #sweep(): void {
    const now = this.#now();
    for (const [id, request] of this.#requests) {
      const ended = request.state === 'consumed' || request.state === 'denied';
      const lapsed = this.#effectiveState(request) === 'expired';
      // Keep ended requests briefly so a replay says "closed", not "unknown".
      if (lapsed || (ended && now >= request.expiresAt)) {
        this.#requests.delete(id);
      }
    }
  }
}

function refuse(code: EnrollmentErrorCode, message: string) {
  return new OperatorPasskeyEnrollmentError(code, message);
}

/** A short digest of the request id: stable for correlation, useless as a key. */
function referenceOf(request: EnrollmentRequest): string {
  return createHash('sha256').update(request.id).digest('hex').slice(0, 8);
}

/**
 * `clientDataJSON.crossOrigin` / `topOrigin` mean the ceremony ran inside a
 * frame of another origin. The library compares `origin`; this refuses a
 * framed ceremony outright.
 */
function hasCrossOriginClientData(response: RegistrationResponseJSON): boolean {
  try {
    const parsed = JSON.parse(
      Buffer.from(response.response.clientDataJSON, 'base64url').toString(
        'utf8',
      ),
    ) as { crossOrigin?: unknown; topOrigin?: unknown };
    return parsed.crossOrigin === true || parsed.topOrigin !== undefined;
  } catch {
    return true;
  }
}

function sanitizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\p{Cc}/gu, '').trim();
  if (cleaned.length === 0 || cleaned.length > OPERATOR_PASSKEY_LABEL_MAX) {
    return null;
  }
  return cleaned;
}
