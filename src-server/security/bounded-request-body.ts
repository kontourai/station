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
