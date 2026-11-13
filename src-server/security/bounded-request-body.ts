export type BoundedBodyResult =
  | { status: 'ok'; body: string }
  | { status: 'too-large' }
  | { status: 'invalid' };

/** Reads a bounded HTTP body without replacing middleware-owned request identity. */
export async function readBoundedRequestBody(
  request: Pick<Request, 'headers' | 'body'>,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) {
      return { status: 'too-large' };
    }
  }
  const stream = request.body;
  if (!stream) return { status: 'invalid' };
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let body = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader
          .cancel('proof request body exceeded byte limit')
          .catch(() => {});
        return { status: 'too-large' };
      }
      body += decoder.decode(result.value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    await reader.cancel().catch(() => {});
    return { status: 'invalid' };
  } finally {
    reader.releaseLock();
  }
  return { status: 'ok', body };
}

export type BoundedBodyBytesResult =
  | { status: 'ok'; bytes: Uint8Array }
  | { status: 'too-large' }
  /** The body stream failed part-way (for example the client went away). */
  | { status: 'invalid' }
  /** The request carries no body stream at all. */
  | { status: 'no-body' };

/**
 * The byte-returning sibling of {@link readBoundedRequestBody}, for a caller
 * that verifies a signature over the exact bytes or re-wraps them into a new
 * Request.
 *
 * It owns only the streaming half, which three routes had each written out:
 * count while reading, cancel at the first byte past `maxBytes`, cancel when
 * a read fails, and always release the reader. It applies NO `Content-Length`
 * policy and decodes nothing. Those callers disagree on a declared length
 * (optional, ignored, or required and exact), so that rule stays with each of
 * them, as does what an absent body means.
 *
 * `signal` bounds the read in time: once it aborts, the stream is cancelled
 * (so its source stops, and the request's reader is released) and the read
 * answers `invalid`, never a partial body.
 */
export async function readBoundedRequestBodyBytes(
  request: Pick<Request, 'body'>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedBodyBytesResult> {
  const stream = request.body;
  if (!stream) return { status: 'no-body' };
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        cancel();
        return { status: 'invalid' };
      }
      const result = await reader.read();
      // A cancel on abort ends a pending read as `done`: not a whole body.
      if (signal?.aborted) return { status: 'invalid' };
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { status: 'too-large' };
      }
      chunks.push(result.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { status: 'invalid' };
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: 'ok', bytes };
}
