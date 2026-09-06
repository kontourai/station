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
  const chunks: Uint8Array[] = [];
  let total = 0;
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
      chunks.push(result.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { status: 'invalid' };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      status: 'ok',
      body: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    return { status: 'invalid' };
  }
}
