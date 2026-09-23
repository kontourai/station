import type { SavedConnection } from '@kontourai/station-connect';
import {
  RELAY_ENROLLMENT_ACTIVATE_PATH,
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_FINALIZE_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentActivatedResponse,
  type RelayEnrollmentChallenge,
  type RelayEnrollmentContinuationBundle,
  type RelayEnrollmentDeliveredResponse,
  type RelayEnrollmentFinalizeResponse,
  type RelayEnrollmentPendingResponse,
} from '@kontourai/station-contracts/relay-enrollment';
import {
  createRelayEnrollmentActivationProof,
  createRelayEnrollmentFinalizeProof,
  createRelayEnrollmentKey,
  createRelayEnrollmentLoginProof,
  digestRelayEnrollmentBundle,
  type RelayEnrollmentKey,
} from '@kontourai/station-sdk/relay-enrollment';

export type BrowserRelayEnrollmentState =
  | 'idle'
  | 'starting'
  | 'awaiting-approval'
  | 'activating'
  | 'enrolled'
  | 'failed'
  | 'cancelled';

export interface BrowserRelayEnrollmentRoute {
  connectionId: string;
  applicationOrigin: string;
  clientOrigin: string;
  route: NonNullable<SavedConnection['brokerRoute']>;
  /** The fetch-compatible encrypted VirtualApplication transport for this selection. */
  transport: typeof fetch;
  isCurrent(): boolean;
}

export interface BrowserRelayEnrollmentControllerOptions {
  route: BrowserRelayEnrollmentRoute;
  /** Durably stage the exact bundle and key without making them readable to SDK requests. */
  stageApprovedBundle(
    stageId: string,
    bundle: RelayEnrollmentContinuationBundle,
    key: RelayEnrollmentKey,
    signal: AbortSignal,
  ): Promise<void>;
  /** Publish staged authority only after Station's signed activation receipt is validated. */
  publishAuthority(
    stageId: string,
    bundle: RelayEnrollmentContinuationBundle,
    key: RelayEnrollmentKey,
    receipt: RelayEnrollmentActivatedResponse,
    isRouteCurrent: () => boolean,
    signal: AbortSignal,
  ): Promise<void>;
  /** Remove the exact staged or just-published authority, including partial writes. */
  removeProvisionalAuthority(stageId: string): Promise<void>;
  onState?(state: BrowserRelayEnrollmentState): void;
  pollIntervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface BrowserRelayEnrollmentCredentials {
  username: string;
  password: string;
}

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CEREMONY_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sameKey(left: unknown, right: RelayEnrollmentKey['publicKey']) {
  return (
    isRecord(left) &&
    left.kty === right.kty &&
    left.crv === right.crv &&
    left.x === right.x &&
    left.y === right.y
  );
}

function parseChallenge(
  value: unknown,
  route: BrowserRelayEnrollmentRoute,
  key: RelayEnrollmentKey,
  now: number,
): RelayEnrollmentChallenge {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'clientOrigin,enrollmentId,expiresAt,keyThumbprint,nonce,publicKey,purpose,requestOrigin,stationId,version' ||
    value.version !== RELAY_ENROLLMENT_VERSION ||
    value.purpose !== 'login' ||
    value.stationId !== route.route.scope.stationId ||
    value.requestOrigin !== route.applicationOrigin ||
    value.clientOrigin !== route.clientOrigin ||
    !OPAQUE.test(String(value.enrollmentId)) ||
    !OPAQUE.test(String(value.keyThumbprint)) ||
    !OPAQUE.test(String(value.nonce)) ||
    !sameKey(value.publicKey, key.publicKey) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= now
  )
    throw new Error(
      'Station returned a challenge for a different route or key.',
    );
  return value as unknown as RelayEnrollmentChallenge;
}

function parsePending(value: unknown, challenge: RelayEnrollmentChallenge) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'enrollmentId,expiresAt,requestId,state,version' ||
    value.version !== RELAY_ENROLLMENT_VERSION ||
    value.state !== 'pending' ||
    value.enrollmentId !== challenge.enrollmentId ||
    typeof value.requestId !== 'string' ||
    !value.requestId ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) > Date.parse(challenge.expiresAt)
  )
    throw new Error('Station returned an invalid Device approval request.');
  return value as unknown as RelayEnrollmentPendingResponse;
}

function validateDelivery(
  value: unknown,
  challenge: RelayEnrollmentChallenge,
  route: BrowserRelayEnrollmentRoute,
  now: number,
): RelayEnrollmentDeliveredResponse {
  if (!isRecord(value) || value.state !== 'delivered')
    throw new Error('Station did not deliver approved Device authority.');
  const delivery = value as unknown as RelayEnrollmentDeliveredResponse;
  const bundle = delivery.bundle;
  if (
    Object.keys(value).sort().join(',') !==
      'activationNonce,bundle,bundleDigest,enrollmentId,expiresAt,state,version' ||
    !isRecord(bundle) ||
    Object.keys(bundle).sort().join(',') !==
      'continuation,deviceCredential,deviceId,stationId' ||
    !isRecord(bundle.continuation) ||
    Object.keys(bundle.continuation).sort().join(',') !==
      'authorityKey,clientOrigin,credential,deviceId,expiresAt,keyThumbprint,nonce,principal,requestOrigin,stationId,version' ||
    delivery.version !== RELAY_ENROLLMENT_VERSION ||
    delivery.enrollmentId !== challenge.enrollmentId ||
    !OPAQUE.test(delivery.activationNonce) ||
    !OPAQUE.test(delivery.bundleDigest) ||
    !Number.isFinite(Date.parse(delivery.expiresAt)) ||
    Date.parse(delivery.expiresAt) <= now ||
    bundle?.stationId !== challenge.stationId ||
    bundle?.deviceId !== bundle?.continuation?.deviceId ||
    !UUID.test(bundle.deviceId) ||
    !OPAQUE.test(bundle.deviceCredential) ||
    bundle.continuation?.version !== 'station.application-session/v1' ||
    !OPAQUE.test(bundle.continuation.credential) ||
    !bundle.continuation.authorityKey ||
    bundle.continuation.stationId !== challenge.stationId ||
    bundle.continuation.requestOrigin !== route.applicationOrigin ||
    bundle.continuation.clientOrigin !== route.clientOrigin ||
    bundle.continuation.keyThumbprint !== challenge.keyThumbprint ||
    !OPAQUE.test(bundle.continuation.nonce) ||
    !Number.isFinite(Date.parse(bundle.continuation.expiresAt)) ||
    Date.parse(bundle.continuation.expiresAt) <= now ||
    Date.parse(delivery.expiresAt) > Date.parse(challenge.expiresAt)
  )
    throw new Error(
      'Station returned authority for a different route or Device.',
    );
  if (!delivery.bundleDigest || !route.isCurrent())
    throw new Error(
      'The selected encrypted Station route is no longer current.',
    );
  return delivery;
}

async function defaultWait(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function boundedJson(response: Response, signal: AbortSignal) {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Station relay enrollment response is too large.');
  }
  if (!response.body)
    throw new Error('Station relay enrollment returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error('Station relay enrollment response is too large.');
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  }
  try {
    reader.releaseLock();
  } catch {
    // A cancelled pending read may still own the lock; this reader is discarded.
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error('Station relay enrollment returned invalid JSON.');
  }
}

async function digestProof(proof: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Runs a fresh browser-client ceremony over one already selected, trusted
 * encrypted route. Staged custody is removed on every failure; callers may
 * expose protected requests only after the signed activation receipt arrives.
 */
export class BrowserRelayEnrollmentController {
  private stateValue: BrowserRelayEnrollmentState = 'idle';
  private activeController: AbortController | null = null;

  constructor(
    private readonly options: BrowserRelayEnrollmentControllerOptions,
  ) {}

  get state() {
    return this.stateValue;
  }

  async enroll(
    credentials: BrowserRelayEnrollmentCredentials,
    outerSignal?: AbortSignal,
  ): Promise<RelayEnrollmentActivatedResponse> {
    if (this.activeController)
      throw new Error('Enrollment is already running.');
    const controller = new AbortController();
    this.activeController = controller;
    const abortFromOuter = () => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener('abort', abortFromOuter, { once: true });
    if (outerSignal?.aborted) abortFromOuter();
    let provisionalStageId: string | null = null;
    let deadlineExpired = false;
    const now = this.options.now ?? Date.now;
    let expiresAtMs = now() + MAX_CEREMONY_MS;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let state: BrowserRelayEnrollmentState = 'failed';
    const setState = (next: BrowserRelayEnrollmentState) => {
      this.stateValue = next;
      this.options.onState?.(next);
    };
    const assertCurrent = () => {
      if (now() >= expiresAtMs) {
        deadlineExpired = true;
        controller.abort(
          new DOMException('Relay enrollment expired.', 'TimeoutError'),
        );
      }
      controller.signal.throwIfAborted();
      if (!this.options.route.isCurrent())
        throw new Error('The selected encrypted Station route changed.');
    };
    const armDeadline = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(
        () => {
          deadlineExpired = true;
          controller.abort(
            new DOMException('Relay enrollment expired.', 'TimeoutError'),
          );
        },
        Math.max(0, expiresAtMs - now()),
      );
    };
    armDeadline();
    const post = async (
      path: string,
      body: unknown,
      expectedStatus: number,
    ) => {
      assertCurrent();
      const url = new URL(path, this.options.route.applicationOrigin);
      const response = await abortable(
        this.options.route.transport(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: this.options.route.clientOrigin,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        controller.signal,
      );
      assertCurrent();
      const responseBody = await boundedJson(response, controller.signal);
      assertCurrent();
      if (!response.ok) {
        let code = `HTTP ${response.status}`;
        if (
          isRecord(responseBody) &&
          isRecord(responseBody.error) &&
          typeof responseBody.error.code === 'string'
        )
          code = responseBody.error.code;
        throw new Error(`Station relay enrollment refused: ${code}.`);
      }
      if (response.status !== expectedStatus)
        throw new Error(
          'Station returned an unexpected relay enrollment status.',
        );
      return responseBody;
    };

    try {
      assertCurrent();
      setState('starting');
      if (
        credentials.username.length < 3 ||
        credentials.username.length > 32 ||
        credentials.password.length < 1 ||
        credentials.password.length > 128
      )
        throw new Error('Enter valid Station account credentials.');
      const key = await createRelayEnrollmentKey();
      assertCurrent();
      const challenge = parseChallenge(
        await post(
          RELAY_ENROLLMENT_BEGIN_PATH,
          { publicKey: key.publicKey },
          201,
        ),
        this.options.route,
        key,
        now(),
      );
      expiresAtMs = Math.min(expiresAtMs, Date.parse(challenge.expiresAt));
      armDeadline();
      const loginProof = await createRelayEnrollmentLoginProof(
        key,
        challenge,
        {
          method: 'POST',
          url: new URL(
            RELAY_ENROLLMENT_LOGIN_PATH,
            challenge.requestOrigin,
          ).toString(),
          clientOrigin: challenge.clientOrigin,
        },
        now(),
      );
      assertCurrent();
      const submittedCredentials = {
        username: credentials.username,
        password: credentials.password,
      };
      credentials.password = '';
      credentials.username = '';
      const pending = parsePending(
        await post(
          RELAY_ENROLLMENT_LOGIN_PATH,
          {
            enrollmentId: challenge.enrollmentId,
            proof: loginProof,
            credentials: submittedCredentials,
          },
          202,
        ),
        challenge,
      );
      setState('awaiting-approval');

      const wait = this.options.wait ?? defaultWait;
      const interval = Math.max(250, this.options.pollIntervalMs ?? 1500);
      let result: RelayEnrollmentFinalizeResponse;
      while (true) {
        assertCurrent();
        const proof = await createRelayEnrollmentFinalizeProof(
          key,
          challenge,
          {
            method: 'POST',
            url: new URL(
              RELAY_ENROLLMENT_FINALIZE_PATH,
              challenge.requestOrigin,
            ).toString(),
            clientOrigin: challenge.clientOrigin,
          },
          now(),
        );
        result = (await post(
          RELAY_ENROLLMENT_FINALIZE_PATH,
          { enrollmentId: challenge.enrollmentId, proof },
          200,
        )) as RelayEnrollmentFinalizeResponse;
        if (
          result.version !== RELAY_ENROLLMENT_VERSION ||
          result.enrollmentId !== pending.enrollmentId
        )
          throw new Error('Station returned an invalid approval response.');
        if (result.state === 'delivered') break;
        if (
          !isRecord(result) ||
          Object.keys(result).sort().join(',') !==
            'enrollmentId,expiresAt,state,version' ||
          result.state !== 'pending' ||
          !Number.isFinite(Date.parse(result.expiresAt)) ||
          Date.parse(result.expiresAt) <= now() ||
          Date.parse(result.expiresAt) > Date.parse(challenge.expiresAt)
        )
          throw new Error('Station returned an invalid approval response.');
        await wait(
          Math.min(interval, Date.parse(result.expiresAt) - now()),
          controller.signal,
        );
      }

      const delivery = validateDelivery(
        result,
        challenge,
        this.options.route,
        now(),
      );
      const digest = await digestRelayEnrollmentBundle(delivery.bundle);
      assertCurrent();
      if (digest !== delivery.bundleDigest)
        throw new Error('Station delivered a bundle with an invalid digest.');
      provisionalStageId = challenge.enrollmentId;
      await abortable(
        this.options.stageApprovedBundle(
          provisionalStageId,
          delivery.bundle,
          key,
          controller.signal,
        ),
        controller.signal,
      );
      assertCurrent();
      setState('activating');
      const activationProof = await createRelayEnrollmentActivationProof(
        key,
        challenge,
        delivery,
        {
          method: 'POST',
          url: new URL(
            RELAY_ENROLLMENT_ACTIVATE_PATH,
            challenge.requestOrigin,
          ).toString(),
          clientOrigin: challenge.clientOrigin,
        },
        now(),
      );
      const expectedReceiptDigest = await digestProof(activationProof);
      const activatedValue = await post(
        RELAY_ENROLLMENT_ACTIVATE_PATH,
        {
          enrollmentId: challenge.enrollmentId,
          activationNonce: delivery.activationNonce,
          deviceId: delivery.bundle.deviceId,
          authorityKey: delivery.bundle.continuation.authorityKey,
          bundleDigest: delivery.bundleDigest,
          proof: activationProof,
        },
        200,
      );
      assertCurrent();
      if (
        !isRecord(activatedValue) ||
        Object.keys(activatedValue).sort().join(',') !==
          'deviceId,enrollmentId,receiptDigest,receiptExpiresAt,state,version' ||
        activatedValue.version !== RELAY_ENROLLMENT_VERSION ||
        activatedValue.state !== 'active' ||
        activatedValue.enrollmentId !== challenge.enrollmentId ||
        activatedValue.deviceId !== delivery.bundle.deviceId ||
        activatedValue.receiptDigest !== expectedReceiptDigest ||
        !Number.isFinite(Date.parse(String(activatedValue.receiptExpiresAt))) ||
        Date.parse(String(activatedValue.receiptExpiresAt)) <= now()
      )
        throw new Error('Station did not confirm Device activation.');
      const receipt =
        activatedValue as unknown as RelayEnrollmentActivatedResponse;
      assertCurrent();
      await abortable(
        this.options.publishAuthority(
          provisionalStageId!,
          delivery.bundle,
          key,
          receipt,
          () => this.options.route.isCurrent() && !controller.signal.aborted,
          controller.signal,
        ),
        controller.signal,
      );
      assertCurrent();
      state = 'enrolled';
      setState(state);
      provisionalStageId = null;
      return receipt;
    } catch (error) {
      if (provisionalStageId) {
        try {
          await this.options.removeProvisionalAuthority(provisionalStageId);
        } catch {
          // The failed state still refuses protected requests; caller can retry cleanup.
        }
      }
      state =
        controller.signal.aborted && !deadlineExpired ? 'cancelled' : 'failed';
      setState(state);
      throw error;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      outerSignal?.removeEventListener('abort', abortFromOuter);
      if (this.activeController === controller) this.activeController = null;
    }
  }
}
