import {
  httpDevelopmentOrigin,
  isCleartextNonLoopback,
} from '@kontourai/station-connect';
/**
 * Desktop's authenticated HTTP bridge.  The WebView receives response bytes
 * and status only; the selected Station's bearer is resolved by Rust for each
 * request and is deliberately absent from this module's API.
 */

import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { Channel, invoke } from '@tauri-apps/api/core';
import {
  type NativeHttpCapacitySnapshot,
  readNativeCommandError,
} from './nativeCommandError';

type ClientAuthenticatedTransport = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>;

type NativeAuthenticatedTransportInit = RequestInit & {
  /** SDK-owned, non-secret guard captured with this request's authority. */
  authorityGuard?: () => void;
  /** Opaque Rust-issued binding for a scoped request; never a credential. */
  expectedBindingId?: string;
  /**
   * station#2327 — RESERVED for the connection-health probe's identity read
   * (`probeServerConnection` in `lib/serverHealth.ts`). The broker admits a
   * flagged request into one reserved per-Station slot instead of the
   * ordinary-read queue, or refuses it immediately with
   * `transport_capacity`; it never waits. The broker also accepts it only
   * for `GET /api/system/identity`. Any other caller setting it would spend
   * the one slot that lets the app tell a busy Station from an unreachable
   * one, so it is deliberately absent from the SDK's request types.
   */
  livenessProbe?: boolean;
};

type BrokerMessage =
  | {
      type: 'response';
      status: number;
      headers: Record<string, string>;
      bodyLength?: number | null;
    }
  | { type: 'chunk'; bytes: number[] }
  | { type: 'end' }
  | { type: 'error'; code: string; detail?: string };

const encoder = new TextEncoder();
const CAPACITY_RETRY_LIMIT = 6;
const CAPACITY_RETRY_MAX_DELAY_MS = 4_000;

function waitForCapacityRetry(
  delayMs: number,
  signal?: AbortSignal | null,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

async function requestBody(
  body: BodyInit | null | undefined,
): Promise<number[] | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return [...encoder.encode(body)];
  if (body instanceof URLSearchParams)
    return [...encoder.encode(body.toString())];
  if (body instanceof ArrayBuffer) return [...new Uint8Array(body)];
  if (ArrayBuffer.isView(body))
    return [...new Uint8Array(body.buffer, body.byteOffset, body.byteLength)];
  if (body instanceof Blob)
    return [...new Uint8Array(await body.arrayBuffer())];
  throw new TypeError(
    'Native Station requests require a serializable request body.',
  );
}

/** A Fetch-compatible transport backed by the host-owned profile authority. */
export const nativeAuthenticatedTransport: ClientAuthenticatedTransport =
  async (input, init) => {
    const authorityGuard = (
      init as NativeAuthenticatedTransportInit | undefined
    )?.authorityGuard;
    const expectedBindingId = (
      init as NativeAuthenticatedTransportInit | undefined
    )?.expectedBindingId;
    const livenessProbe =
      (init as NativeAuthenticatedTransportInit | undefined)?.livenessProbe ===
      true;
    authorityGuard?.();
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    if (isCleartextNonLoopback(url) && !httpDevelopmentOrigin(url)) {
      throw new Error(
        'HTTP permission was removed for this Station. Use HTTPS or allow this address in connection settings.',
      );
    }
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const requestId = randomCorrelationId();
    const signal = init?.signal ?? request?.signal;
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let settled = false;
    let finished = false;
    let resolveResponse: ((response: Response) => void) | undefined;
    let rejectResponse: ((error: unknown) => void) | undefined;
    let expectedBodyLength: number | undefined;
    let receivedBodyLength = 0;
    const responseReady = new Promise<Response>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        finished = true;
        signal?.removeEventListener('abort', abort);
        void invoke('station_native_http_cancel', { requestId });
      },
    });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    // Android WebViews can throw if a controller has already become terminal
    // between broker messages. The broker's typed transport error is the
    // useful contract, never that DOM implementation detail.
    const completeStream = (error?: Error) => {
      try {
        if (error) streamController?.error(error);
        else streamController?.close();
      } catch {
        // The controller was already terminal.
      }
    };
    // archive#1818: `code` is the stable machine contract
    // (`classifyNativeTransportRefusal` reads it), while `detail` is
    // human/log text only. `fail` builds the SAME kind of `Error` shape for
    // both the channel's out-of-band codes ('cancelled', 'transport',
    // 'response_too_large', the vestigial 'credential_missing') and a
    // structured `NativeCommandError` rejection unwrapped below — one seam,
    // one shape, so `classifyNativeTransportRefusal` never has to guess
    // which path produced the `Error` it is given.
    //
    // archive#1818: `code` is `string | undefined`,
    // not defaulted to the raw message text, on purpose. A command not yet
    // converted to `NativeCommandError` rejects with a bare, uncoded
    // string — passing THAT string through as `.code` would let arbitrary
    // English prose masquerade as a code, reopening exactly the
    // FFI-boundary prose-matching this whole mechanism replaced (a future
    // `switch (error.code)` consumer could accidentally match on a
    // sentence). Leaving `.code` unset for the uncoded case is what keeps
    // `classifyNativeTransportRefusal`'s "no code" path — the one it
    // already falls back to conservatively — honest.
    const fail = (
      code: string | undefined,
      detail?: string,
      capacity?: NativeHttpCapacitySnapshot,
    ) => {
      if (finished) return;
      finished = true;
      cleanup();
      const error = Object.assign(
        new Error(`Native Station request failed: ${detail ?? code}`),
        code === undefined ? {} : { code },
        capacity ? { capacity } : {},
      );
      if (!settled) {
        settled = true;
        rejectResponse?.(error);
      }
      completeStream(error);
    };
    const channel = new Channel<BrokerMessage>((message) => {
      if (message.type === 'response') {
        expectedBodyLength =
          typeof message.bodyLength === 'number' &&
          Number.isSafeInteger(message.bodyLength) &&
          message.bodyLength >= 0
            ? message.bodyLength
            : undefined;
        if (!settled) {
          settled = true;
          resolveResponse?.(
            new Response(
              [204, 205, 304].includes(message.status) ? null : stream,
              {
                status: message.status,
                headers: message.headers,
              },
            ),
          );
        }
      } else if (message.type === 'chunk') {
        if (!finished) {
          receivedBodyLength += message.bytes.length;
          streamController?.enqueue(new Uint8Array(message.bytes));
        }
      } else if (message.type === 'end') {
        if (!finished) {
          if (
            expectedBodyLength !== undefined &&
            receivedBodyLength !== expectedBodyLength
          ) {
            fail('transport', 'incomplete response body');
            return;
          }
          finished = true;
          cleanup();
          completeStream();
        }
      } else {
        fail(message.code, message.detail);
      }
    });
    const abort = () => {
      void invoke('station_native_http_cancel', { requestId });
      fail('cancelled');
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let body: number[] | undefined;
    try {
      body = await requestBody(
        init?.body ?? (request ? await request.clone().blob() : undefined),
      );
    } catch (error) {
      cleanup();
      throw error;
    }
    // Body serialization can await a Blob read; never dispatch a stale
    // authority after that wait.
    authorityGuard?.();
    const nativeRequest = {
      requestId,
      url,
      method: init?.method ?? request?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      body,
      ...(expectedBindingId ? { expectedBindingId } : {}),
      ...(livenessProbe ? { livenessProbe: true } : {}),
    };
    const isStreamRequest = headers
      .get('accept')
      ?.split(',')
      .some(
        (media) =>
          media.split(';')[0]?.trim().toLowerCase() === 'text/event-stream',
      );
    const dispatch = async () => {
      for (let retry = 0; !finished; retry += 1) {
        try {
          if (retry > 0) authorityGuard?.();
          await invoke('station_native_http_request', {
            request: nativeRequest,
            channel,
          });
          return;
        } catch (error) {
          const { code, message, capacity } = readNativeCommandError(error);
          // Only this host-issued snapshot proves queue rejection before HTTP
          // dispatch. Channel failures and legacy capacity errors are not replayed.
          if (finished) return;
          if (
            settled ||
            livenessProbe ||
            isStreamRequest ||
            !capacity ||
            capacity.pendingRequests < capacity.pendingLimit
          ) {
            fail(code, message, capacity);
            return;
          }
          if (retry >= CAPACITY_RETRY_LIMIT) {
            fail(
              code,
              `${message} Automatic retries could not find space after ${retry} retries.`,
              capacity,
            );
            return;
          }
          const delay = Math.min(
            CAPACITY_RETRY_MAX_DELAY_MS,
            Math.max(250, capacity.retryAfterMs) * 2 ** retry,
          );
          await waitForCapacityRetry(
            delay + Math.random() * delay * 0.25,
            signal,
          );
        }
      }
    };
    void dispatch();
    return await responseReady;
  };
