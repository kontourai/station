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
      throw error;
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
    try {
      await assertCurrent();
      const prepared = copyPrepared(
        await raceOwnedLifetime(prepare(peer.peerHandle), signal),
        peer,
      );
      await assertCurrent();
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
      const value = await readBoundedResponse(response, signal);
      await assertCurrent();
      // Core closes its one-request channel at EOF. Host acceptance verifies
      // the retained request capture and current owners, not RTC liveness.
      const accepted = await raceOwnedLifetime(
        accept(prepared.requestHandle, value, response.status),
        signal,
      );
      await assertCurrent();
      return accepted;
    } finally {
      clearTimeout(timer);
      lifetime.abort();
      try {
        opened.channel.close();
      } finally {
        await opened.close();
      }
    }
  };
}
