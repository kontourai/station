import type { NativePairingExchangeTransport } from '@kontourai/station-connect/device-pairing';
import { invoke } from '@tauri-apps/api/core';
import { readNativeCommandError } from './nativeCommandError';

type NativePairingEnvelope =
  | ({ ok: true } & Awaited<ReturnType<NativePairingExchangeTransport>>)
  | { ok: false; status: number; error: string };

async function awaitNativePairingExchange<T>(
  request: Promise<T>,
  signal: AbortSignal | undefined,
  operationId: string,
): Promise<T> {
  if (!signal) return request;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        abort = () => {
          // Cancellation is best effort at the IPC boundary. The operation id
          // remains host-owned, so this cannot cancel an unrelated exchange.
          void invoke('station_native_pairing_exchange_cancel', {
            operationId,
          }).catch(() => undefined);
          reject(
            Object.assign(new Error('pairing_exchange_cancelled'), {
              code: 'cancelled',
            }),
          );
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/**
 * archive#1818 (owner scope-growth) — brings the native pairing bridge to
 * the same structured-error contract `authenticatedTransport.ts` already
 * uses (`readNativeCommandError`). A rejected
 * `invoke('station_native_pairing_exchange')` is a DIFFERENT failure shape
 * than the `{ ok: false, status, error }` envelope handled below: the
 * envelope is a genuine server answer (a denied request, an expired offer)
 * that `station_native_pairing_exchange_blocking` returns as `Ok(...)`; a
 * rejection is the invoke call itself refusing before ever producing that
 * envelope — a malformed request, a local resource limit, or (this is the
 * one that matters for parity with the HTTP path) the request never
 * reaching the Station at all.
 *
 * `code: 'network_unreachable'` is the exact code the HTTP pairing path
 * already uses for that last case
 * (`packages/connect/src/core/devicePairing.ts`'s `pairingFetch`, and now
 * `station_native_pairing_exchange_blocking`'s own `transport` failure,
 * converted to this same code — see `src-desktop/src/lib.rs`). Marking
 * `transport: true` here too is what makes `isTransportFailure` (the same
 * function `JoinDevicePairingPanel` already branches on for the HTTP path)
 * recognize it identically regardless of which transport delivered it —
 * without this, a native-side network failure fell through to the panel's
 * generic "Pairing failed" dead end instead of the retry-with-backoff
 * treatment a dropped connection deserves.
 */
function toPairingTransportError(error: unknown): Error {
  const { code, message } = readNativeCommandError(error);
  // archive#1818: `code` stays `undefined` for an
  // uncoded (not-yet-converted, or legacy) rejection rather than falling
  // back to the raw message text — putting prose in `.code` would let a
  // future `.code`-switching consumer accidentally match on a sentence,
  // reopening the FFI-boundary prose-matching this mechanism replaced.
  const wrapped = Object.assign(
    new Error(message),
    code === undefined ? {} : { code },
  );
  if (code === 'network_unreachable') {
    return Object.assign(wrapped, { transport: true });
  }
  return wrapped;
}

/** The sole native pairing exchange path: Rust captures and redacts bearer. */
export const nativePairingExchangeTransport: NativePairingExchangeTransport =
  async (input) => {
    let result: NativePairingEnvelope;
    try {
      result = await awaitNativePairingExchange(
        invoke<NativePairingEnvelope>('station_native_pairing_exchange', {
          request: {
            endpoint: input.endpoint,
            offerId: input.offerId,
            proof: input.proof,
            requestId: input.requestId,
            clientInstanceId: input.clientInstanceId,
            operationId: input.operationId,
            browserSession: input.browserSession === true,
          },
        }),
        input.signal,
        input.operationId,
      );
    } catch (error) {
      throw toPairingTransportError(error);
    }
    if (!result.ok) {
      throw Object.assign(new Error(result.error), {
        code: result.error,
        status: result.status,
      });
    }
    const { ok: _ok, ...response } = result;
    return response;
  };
