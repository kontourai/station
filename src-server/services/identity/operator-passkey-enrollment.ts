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
import {
  LazyOperatorPasskeyRegistry,
  type OperatorPasskey,
  OperatorPasskeyRegistry,
} from './operator-passkey-registry.js';

/** How long the browser has to get the host to confirm. */
export const ENROLLMENT_REQUEST_TTL_MS = 5 * 60_000;
/** After confirmation, how long the registration ceremony may take. */
export const ENROLLMENT_CEREMONY_TTL_MS = 5 * 60_000;
/** One registration challenge is valid this long, and for one verification. */
export const ENROLLMENT_CHALLENGE_TTL_MS = 2 * 60_000;
const ENROLLMENT_CODE_DIGITS = 6;
/** Live requests at once. A larger pool would make a blind code guess likelier. */
export const ENROLLMENT_MAX_LIVE_REQUESTS = 5;
/** Option mints and failed verifications one confirmation may spend. */
const ENROLLMENT_MAX_CEREMONY_ATTEMPTS = 3;
/** Wrong or malformed host-side codes tolerated per window before a lockout. */
export const ENROLLMENT_CODE_FAILURE_LIMIT = 5;
export const ENROLLMENT_CODE_FAILURE_WINDOW_MS = 5 * 60_000;
const OPERATOR_PASSKEY_LABEL_MAX = 64;

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
  | 'store_unavailable'
  | 'too_many_requests'
  | 'request_not_found'
  | 'request_not_confirmed'
  | 'request_closed'
  | 'invalid_code'
  | 'rate_limited'
  | 'challenge_invalid'
  | 'verification_failed'
  | 'invalid_label'
  | 'passkey_not_found'
  | 'device_mismatch'
  | 'device_gone';

/**
 * The ONLY text a route may send for a typed enrollment error: one fixed
 * sentence per code. `error.message` is for logs and tests; routes never echo
 * it, so a future change to how a message is built cannot leak through a
 * response.
 */
const PUBLIC_MESSAGES: Record<EnrollmentErrorCode, string> = {
  enrollment_unavailable:
    'Operator passkey enrollment needs STATION_TRUSTED_CONSENT_ORIGIN, an HTTPS origin on a DNS name. A Station reachable only by IP address has no remote operator sign-in.',
  store_unavailable:
    'The operator passkey store could not be opened privately, so passkeys are unavailable.',
  too_many_requests:
    'Too many enrollment requests are waiting. Deny or let them expire, then try again.',
  request_not_found: 'No such enrollment request.',
  request_not_confirmed: 'The host has not confirmed this request yet.',
  request_closed: 'This enrollment request is closed. Start again.',
  invalid_code:
    'No pending enrollment request has that code. Check the code shown in the browser; it expires after 5 minutes and works once.',
  rate_limited: 'Too many wrong codes. Wait before trying again.',
  challenge_invalid:
    'The registration challenge is missing, used, expired or replaced. Start again.',
  verification_failed:
    'The passkey could not be verified for this Station. Nothing was saved.',
  invalid_label: 'The label must be 1 to 64 printable characters.',
  passkey_not_found: 'No active operator passkey has that id.',
  device_mismatch:
    'The request with that code was not opened by the device you named. Nothing was confirmed; run `station environment operator passkeys` to see who asked.',
  device_gone:
    'The device that opened this request is no longer paired. Nothing was confirmed.',
};

/** Every code a typed enrollment error can carry. */
export const ENROLLMENT_ERROR_CODES = Object.keys(
  PUBLIC_MESSAGES,
) as EnrollmentErrorCode[];

/** The fixed public sentence for a typed enrollment error. */
export function publicEnrollmentMessage(
  error: OperatorPasskeyEnrollmentError,
): string {
  return PUBLIC_MESSAGES[error.code];
}

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
  readonly requester: EnrollmentRequester;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: 'pending' | 'confirmed' | 'denied' | 'consumed';
  ceremonyExpiresAt: number;
  ceremonyAttempts: number;
  challenge: { value: string; expiresAt: number } | null;
}

/**
 * Who opened a request, as the SERVER knows them. The label is chosen by the
 * device and proves nothing; the id, pairing date and scope come from the
 * pairing registry and are what the host operator should weigh.
 */
export interface EnrollmentRequester {
  readonly kind: 'operator-credential' | 'paired-device';
  readonly deviceId: string;
  readonly pairedAt: number | null;
  readonly scope: string;
}

/** Eight characters: enough to tell devices apart, short enough to retype. */
const SHORT_DEVICE_ID_LENGTH = 8;
/** A `--device` prefix shorter than this is not a selector. */
const MIN_DEVICE_SELECTOR_LENGTH = 4;
/** The label Station gives the operator's own credential; a device cannot borrow it. */
export const OPERATOR_BROWSER_LABEL = 'Station operator browser';

export interface EnrollmentRequesterSummary {
  /** False when the pairing registry no longer holds this device live. */
  readonly active: boolean;
  readonly kind: EnrollmentRequester['kind'];
  readonly deviceId: string;
  readonly pairedAt: number | null;
  readonly scope: string;
}

export interface PendingEnrollmentSummary {
  /** Short, non-secret handle for correlation in the host's own listing. */
  readonly reference: string;
  readonly deviceLabel: string;
  readonly requester: EnrollmentRequesterSummary;
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
  /** A registry, or a provider that opens it only when first needed. */
  readonly registry: OperatorPasskeyRegistry | LazyOperatorPasskeyRegistry;
  /** `STATION_TRUSTED_CONSENT_ORIGIN`, already validated; null when unset. */
  readonly origin: string | null;
  /**
   * Re-resolves a paired device by id at approval time: null when it is gone
   * or revoked. Without it the request's snapshot is trusted (tests only).
   */
  readonly resolveDevice?: (deviceId: string) => { scope: string } | null;
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
  readonly #registry: LazyOperatorPasskeyRegistry;
  readonly #origin: string | null;
  readonly #rpId: string | null;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  readonly #resolveDevice: OperatorPasskeyEnrollmentOptions['resolveDevice'];
  readonly #requests = new Map<string, EnrollmentRequest>();
  #codeFailures: number[] = [];

  constructor(options: OperatorPasskeyEnrollmentOptions) {
    this.#registry =
      options.registry instanceof OperatorPasskeyRegistry
        ? LazyOperatorPasskeyRegistry.of(options.registry)
        : options.registry;
    this.#origin = options.origin;
    // The RP ID derives from the CONFIGURED origin's host, never from a
    // request's Host header, so a request cannot choose which domain a
    // passkey is scoped to.
    this.#rpId =
      options.origin === null ? null : new URL(options.origin).hostname;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
    this.#resolveDevice = options.resolveDevice;
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
  createRequest(input: {
    credential: string;
    deviceLabel: string;
    requester: EnrollmentRequester;
  }): {
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
      deviceLabel: requesterLabel(input),
      requester: input.requester,
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
    const registry = this.#openRegistry();
    // A new challenge replaces any earlier one: only the latest is valid.
    request.challenge = null;
    const options = await generateRegistrationOptions({
      rpName: 'Station operator',
      rpID: rpId,
      userName: 'station-operator',
      userDisplayName: 'Station operator',
      userID: registry.userHandle(),
      attestationType: 'none',
      timeout: ENROLLMENT_CHALLENGE_TTL_MS,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
      excludeCredentials: registry
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
    const registry = this.#openRegistry();
    const cleanLabel =
      label === undefined || label === null || label === ''
        ? `Passkey ${registry.listActive().length + 1}`
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
    // The await above is a window: the host may have denied (withdrawn) this
    // request, it may have lapsed, or a newer challenge may have been minted.
    // None of those may still enroll a passkey.
    this.#requireConfirmed(request);
    if (request.challenge !== null) {
      throw refuse(
        'challenge_invalid',
        'A newer registration challenge replaced this one. Start again.',
      );
    }
    const info = verification.registrationInfo;
    let stored: OperatorPasskey;
    try {
      stored = registry.add({
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
        requester: this.#summaryOf(request),
        rpId,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      }));
  }

  /**
   * Looks up the pending request that shows `code` WITHOUT confirming it, so
   * the host can show who asked before the operator commits. It spends the
   * same failure budget as a confirmation.
   */
  inspect(code: unknown): {
    deviceLabel: string;
    requester: EnrollmentRequesterSummary;
    rpId: string;
    expiresAt: number;
  } {
    const request = this.#matchCode(code, ['pending']);
    return {
      deviceLabel: request.deviceLabel,
      requester: this.#summaryOf(request),
      rpId: this.#rpId ?? '',
      expiresAt: request.expiresAt,
    };
  }

  /**
   * Confirms the pending request whose browser displays `code`. When
   * `device` is given it must be a prefix of the requesting device's id,
   * otherwise nothing is confirmed.
   */
  confirm(
    code: unknown,
    device?: unknown,
  ): { deviceLabel: string; rpId: string } {
    const request = this.#matchCode(code, ['pending']);
    this.#requireDeviceLive(request);
    if (device !== undefined) {
      const selector = typeof device === 'string' ? device.toLowerCase() : '';
      if (
        selector.length < MIN_DEVICE_SELECTOR_LENGTH ||
        !request.requester.deviceId.toLowerCase().startsWith(selector)
      ) {
        operatorPasskeyEnrollmentOps.add(1, {
          step: 'refused',
          reason: 'device_mismatch',
        });
        throw new OperatorPasskeyEnrollmentError(
          'device_mismatch',
          'The request with that code was not opened by the device you named. Nothing was confirmed; run `station environment operator passkeys` to see who asked.',
        );
      }
    }
    request.state = 'confirmed';
    request.ceremonyExpiresAt = this.#now() + ENROLLMENT_CEREMONY_TTL_MS;
    operatorPasskeyEnrollmentOps.add(1, { step: 'confirmed' });
    this.#logger?.info('Operator passkey enrollment confirmed', {
      reference: referenceOf(request),
    });
    return { deviceLabel: request.deviceLabel, rpId: this.#rpId ?? '' };
  }

  /**
   * Rejects a pending request, or withdraws a confirmed one whose passkey has
   * not been created yet (a mistaken approve). A passkey already stored is
   * revoked, not denied.
   */
  deny(code: unknown): { deviceLabel: string } {
    const request = this.#matchCode(code, ['pending', 'confirmed']);
    request.state = 'denied';
    request.challenge = null;
    operatorPasskeyEnrollmentOps.add(1, { step: 'denied' });
    this.#logger?.info('Operator passkey enrollment denied', {
      reference: referenceOf(request),
    });
    return { deviceLabel: request.deviceLabel };
  }

  listPasskeys(): OperatorPasskey[] {
    return this.#existingRegistry()?.listActive() ?? [];
  }

  revokePasskey(id: unknown): OperatorPasskey {
    const registry = this.#existingRegistry();
    if (typeof id !== 'string' || !registry?.revoke(id)) {
      throw new OperatorPasskeyEnrollmentError(
        'passkey_not_found',
        'No active operator passkey has that id.',
      );
    }
    operatorPasskeyEnrollmentOps.add(1, { step: 'revoked' });
    this.#logger?.info('Operator passkey revoked', { passkeyId: id });
    return registry.get(id) as OperatorPasskey;
  }

  // ---- internals ----------------------------------------------------------

  /** The requester as the pairing registry holds it NOW, not as it was snapshotted. */
  #summaryOf(request: EnrollmentRequest): EnrollmentRequesterSummary {
    const { requester } = request;
    if (requester.kind !== 'paired-device' || !this.#resolveDevice) {
      return summarizeRequester(requester, true, requester.scope);
    }
    const current = this.#resolveDevice(requester.deviceId);
    return summarizeRequester(
      requester,
      current !== null,
      current?.scope ?? requester.scope,
    );
  }

  /** A device that was revoked or unpaired after asking cannot be approved. */
  #requireDeviceLive(request: EnrollmentRequest): void {
    if (!this.#summaryOf(request).active) {
      operatorPasskeyEnrollmentOps.add(1, {
        step: 'refused',
        reason: 'device_gone',
      });
      throw new OperatorPasskeyEnrollmentError(
        'device_gone',
        'The device that opened this request is no longer paired. Nothing was confirmed.',
      );
    }
  }

  /** Reads of an existing store fail closed and typed, never as a raw 500. */
  #existingRegistry(): OperatorPasskeyRegistry | null {
    try {
      return this.#registry.existing();
    } catch {
      throw new OperatorPasskeyEnrollmentError(
        'store_unavailable',
        'The operator passkey store could not be opened privately, so passkeys cannot be read or changed.',
      );
    }
  }

  /** Creates the database on first real use; a store that cannot open fails closed. */
  #openRegistry(): OperatorPasskeyRegistry {
    try {
      return this.#registry.ensure();
    } catch {
      throw new OperatorPasskeyEnrollmentError(
        'store_unavailable',
        'The operator passkey store could not be opened privately, so enrollment is unavailable.',
      );
    }
  }

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
  #matchCode(
    code: unknown,
    states: readonly EnrollmentRequest['state'][],
  ): EnrollmentRequest {
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
      if (equal && wellFormed && states.includes(request.state)) {
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

function summarizeRequester(
  requester: EnrollmentRequester,
  active: boolean,
  scope: string,
): EnrollmentRequesterSummary {
  return {
    active,
    kind: requester.kind,
    deviceId: requester.deviceId.slice(0, SHORT_DEVICE_ID_LENGTH),
    pairedAt: requester.pairedAt,
    scope,
  };
}

/**
 * The display label. A paired device names itself, so a device that borrows
 * the label Station gives the operator's own credential is shown as exactly
 * that, never as the operator.
 */
function requesterLabel(input: {
  deviceLabel: string;
  requester: EnrollmentRequester;
}): string {
  const label = sanitizeLabel(input.deviceLabel) ?? 'Paired browser';
  if (
    input.requester.kind !== 'operator-credential' &&
    label.toLowerCase() === OPERATOR_BROWSER_LABEL.toLowerCase()
  ) {
    return `Paired device that calls itself "${label}" (not the operator)`;
  }
  return label;
}
