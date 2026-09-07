/** Native, credential-free transport for Station's one public handshake. */

import { readNativeCommandError } from './nativeCommandError';
import { invokeTauri } from './tauriInvoke';

interface NativePublicHandshakeResponse {
  status: number;
  body: string;
}

export const nativePublicHandshakeTransport: typeof fetch = async (
  input,
  init,
) => {
  const signal =
    init?.signal ?? (input instanceof Request ? input.signal : null);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const url = input instanceof Request ? input.url : String(input);
  const request = invokeTauri<NativePublicHandshakeResponse>(
    'station_native_public_handshake',
    { url },
  ).catch((error) => {
    const native = readNativeCommandError(error);
    throw Object.assign(new TypeError(native.message), {
      ...(native.code ? { code: native.code } : {}),
    });
  });
  let response: NativePublicHandshakeResponse;
  if (signal) {
    response = await new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      void request.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', abort);
      });
    });
  } else {
    response = await request;
  }
  return new Response(response.body, {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
};
