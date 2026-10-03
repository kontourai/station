import {
  NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH,
  NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_CANCEL_PATH,
  NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH,
  NATIVE_RELAY_ENROLLMENT_LOGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_REGISTER_PATH,
  NATIVE_RELAY_ENROLLMENT_STATUS_PATH,
  type NativeRelayEnrollmentPeerPrepared,
  type NativeRelayEnrollmentPreparedRequest,
} from '@kontourai/station-contracts/native-relay-enrollment';
import {
  type ApplicationChannel,
  createApplicationChannelFetch,
} from './applicationChannel.js';
import {
  captureNativeEnrollmentFailure,
  type NativeEnrollmentFailureDiagnostic,
  type NativeEnrollmentFailureStage,
  nativeEnrollmentCleanupCode,
} from './nativeEnrollmentFailure.js';

export {
  captureNativeEnrollmentFailure,
  type NativeEnrollmentFailureDiagnostic,
  type NativeEnrollmentFailureStage,
  nativeEnrollmentFailureDiagnostic,
} from './nativeEnrollmentFailure.js';

import { raceOwnedLifetime } from './browserTransportWait.js';

const PATHS = new Set<string>([
  NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_LOGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_REGISTER_PATH,
  NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH,
  NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH,
  NATIVE_RELAY_ENROLLMENT_STATUS_PATH,
  NATIVE_RELAY_ENROLLMENT_CANCEL_PATH,
]);
const HANDLE = /^[A-Za-z0-9_-]{43}$/u;
const BODY_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const REFUSAL_CODES = new Set([
  'native_enrollment_invalid',
  'native_enrollment_expired',
  'native_enrollment_unsupported',
  'native_enrollment_unavailable',
  'native_enrollment_approval_required',
  'native_enrollment_replayed',
  'native_enrollment_busy',
  'operator_required',
]);

function responseRefusalCode(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !('error' in value)
  )
    return 'native_enrollment_application_refused';
  const error = value.error;
  if (
    typeof error !== 'object' ||
    error === null ||
    Object.keys(error).length !== 1 ||
    !('code' in error) ||
    typeof error.code !== 'string' ||
    !REFUSAL_CODES.has(error.code)
  )
    return 'native_enrollment_application_refused';
  return error.code;
}

/** The native bridge owns peer admission and retained response-operation captures. */
export interface NativeEnrollmentOpenedPeer {
  readonly peer: Pick<
    NativeRelayEnrollmentPeerPrepared,
    'peerHandle' | 'stationAudience' | 'expiresAt'
  >;
  readonly channel: ApplicationChannel;
  assertCurrent(): Promise<void>;
  close(): Promise<void>;
}

export interface NativeEnrollmentExchangeInput {
  readonly signal: AbortSignal;
  open(signal: AbortSignal): Promise<NativeEnrollmentOpenedPeer>;
}

function validatePrepared(
  request: NativeRelayEnrollmentPreparedRequest,
  peer: NativeEnrollmentOpenedPeer['peer'],
): void {
  const keys = Object.keys(request);
  const expected = [
    'version',
    'requestHandle',
    'peerHandle',
    'method',
    'path',
    'headers',
    'body',
    ...(request.enrollmentHandle === undefined ? [] : ['enrollmentHandle']),
  ];
  if (
    keys.length !== expected.length ||
    !expected.every((key) => Object.hasOwn(request, key)) ||
    request.version !== 'station-native-enrollment-request/v1' ||
    !HANDLE.test(request.requestHandle) ||
    request.peerHandle !== peer.peerHandle ||
    (request.enrollmentHandle !== undefined &&
      !HANDLE.test(request.enrollmentHandle)) ||
    request.method !== 'POST' ||
    !PATHS.has(request.path) ||
    Object.keys(request.headers).length !== 1 ||
    request.headers['Content-Type'] !== 'application/json' ||
    typeof request.body !== 'string' ||
    new TextEncoder().encode(request.body).byteLength > BODY_LIMIT
  )
    throw new Error('native_enrollment_request_invalid');
}

function copyPrepared(
  request: NativeRelayEnrollmentPreparedRequest,
  peer: NativeEnrollmentOpenedPeer['peer'],
): NativeRelayEnrollmentPreparedRequest {
  const copy = { ...request, headers: { ...request.headers } };
  validatePrepared(copy, peer);
  return Object.freeze({ ...copy, headers: Object.freeze(copy.headers) });
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new Error('native_enrollment_response_missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await raceOwnedLifetime(reader.read(), signal);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > RESPONSE_LIMIT)
        throw new Error('native_enrollment_response_too_large');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One freshly admitted peer per fixed host operation; never an HTTP fallback. */
export function createNativeEnrollmentExchange(
  input: NativeEnrollmentExchangeInput,
) {
  return async <T>(
    prepare: (
      peerHandle: string,
    ) => Promise<NativeRelayEnrollmentPreparedRequest>,
    accept: (
      requestHandle: string,
      response: unknown,
      status: number,
    ) => Promise<T>,
  ): Promise<T> => {
    input.signal.throwIfAborted();
    const opening = input.open(input.signal);
    let opened: NativeEnrollmentOpenedPeer;
    try {
      opened = await raceOwnedLifetime(opening, input.signal);
    } catch (error) {
      if (input.signal.aborted)
        void opening.then((late) => late.close()).catch(() => {});
      throw captureNativeEnrollmentFailure(error, 'peer-open');
    }
    const lifetime = new AbortController();
    const peer = Object.freeze({ ...opened.peer });
    const signal = AbortSignal.any([input.signal, lifetime.signal]);
    const timer = setTimeout(() => lifetime.abort(), 45_000);
    const assertCurrent = async () => {
      signal.throwIfAborted();
      if (peer.expiresAt <= Date.now())
        throw new Error('native_enrollment_peer_expired');
      await raceOwnedLifetime(opened.assertCurrent(), signal);
      signal.throwIfAborted();
    };
    let stage: NativeEnrollmentFailureStage = 'currentness';
    let httpStatus: number | undefined;
    let failed = false;
    let primary: unknown;
    let acceptedResult!: T;
    try {
      await assertCurrent();
      stage = 'host-prepare';
      const prepared = copyPrepared(
        await raceOwnedLifetime(prepare(peer.peerHandle), signal),
        peer,
      );
      stage = 'currentness';
      await assertCurrent();
      stage = 'application-request';
      const fetch = createApplicationChannelFetch({
        origin: peer.stationAudience,
        signal,
        open: async () => opened.channel,
        assertCurrent,
      });
      const response = await fetch(
        new URL(prepared.path, peer.stationAudience),
        {
          method: prepared.method,
          headers: prepared.headers,
          body: prepared.body,
          signal,
        },
      );
      httpStatus = response.status;
      stage = 'application-response';
      const value = await readBoundedResponse(response, signal);
      if (!response.ok) throw new Error(responseRefusalCode(value));
      stage = 'currentness';
      await assertCurrent();
      stage = 'host-accept';
      // Core closes its one-request channel at EOF. Host acceptance verifies
      // the retained request capture and current owners, not RTC liveness.
      const accepted = await raceOwnedLifetime(
        accept(prepared.requestHandle, value, response.status),
        signal,
      );
      stage = 'currentness';
      await assertCurrent();
      acceptedResult = accepted;
    } catch (cause) {
      failed = true;
      primary = captureNativeEnrollmentFailure(cause, stage, httpStatus);
    } finally {
      clearTimeout(timer);
      lifetime.abort();
      const cleanup: NonNullable<
        NativeEnrollmentFailureDiagnostic['cleanup']
      >[number][] = [];
      let cleanupFailure: Error | undefined;
      try {
        opened.channel.close();
      } catch (cause) {
        cleanup.push({
          stage: 'channel-close',
          code: nativeEnrollmentCleanupCode(cause),
        });
        cleanupFailure = captureNativeEnrollmentFailure(
          cause,
          'channel-close',
          httpStatus,
        );
      }
      try {
        await opened.close();
      } catch (cause) {
        cleanup.push({
          stage: 'peer-close',
          code: nativeEnrollmentCleanupCode(cause),
        });
        cleanupFailure ??= captureNativeEnrollmentFailure(
          cause,
          'peer-close',
          httpStatus,
        );
      }
      if (cleanupFailure) {
        if (failed)
          captureNativeEnrollmentFailure(primary, stage, httpStatus, cleanup);
        else {
          failed = true;
          primary = captureNativeEnrollmentFailure(
            cleanupFailure,
            'peer-close',
            httpStatus,
            cleanup,
          );
        }
      }
    }
    if (failed) throw primary;
    return acceptedResult;
  };
}
