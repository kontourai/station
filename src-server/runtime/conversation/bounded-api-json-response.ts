import { createHash } from 'node:crypto';

class BoundedApiRawResponseUnavailable extends Error {
  readonly code = 'usage_unknown';
  constructor() {
    super('Complete provider response is unavailable.');
  }
}

/** Non-streaming response observation before any SDK usage normalization. */
export async function observeBoundedApiJsonResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{
  response: Response;
  raw: unknown;
  rawBodySha256: string;
  byteLength: number;
}> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new BoundedApiRawResponseUnavailable();
  const contentType = response.headers
    .get('Content-Type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  const reader = response.body?.getReader();
  if (!reader) throw new BoundedApiRawResponseUnavailable();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    if (response.status !== 200) throw new BoundedApiRawResponseUnavailable();
    if (contentType !== 'application/json')
      throw new BoundedApiRawResponseUnavailable();
    while (true) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) throw new BoundedApiRawResponseUnavailable();
      chunks.push(item.value.slice());
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
    const raw: unknown = JSON.parse(text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new BoundedApiRawResponseUnavailable();
    return {
      raw,
      rawBodySha256: createHash('sha256').update(body).digest('hex'),
      byteLength: bytes,
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  } catch {
    throw new BoundedApiRawResponseUnavailable();
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
