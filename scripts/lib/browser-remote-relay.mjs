// Fixture-only bridge into the already verified encrypted browser transport.
export async function browserRemoteApplicationFetch(input) {
  const transport = window.stationBrokerLabTransport?.transport;
  if (!transport || new URL(input.url).origin !== input.origin)
    throw new Error('Remote fixture transport unavailable');
  const headers = new Headers(input.headers);
  if (headers.get('Origin') !== location.origin)
    throw new Error('Remote fixture Origin mismatch');
  const response = await transport(input.url, {
    method: input.method,
    headers,
    body: input.body,
    signal: AbortSignal.timeout(15000),
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let length = 0;
  try {
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 256 * 1024)
          throw new Error('Remote fixture response exceeded bound');
        chunks.push(next.value);
      }
  } finally {
    await reader?.cancel();
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    status: response.status,
    headers: [...response.headers],
    body: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  };
}
