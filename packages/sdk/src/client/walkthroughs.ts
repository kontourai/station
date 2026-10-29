import {
  parseWalkthrough,
  WALKTHROUGH_LIMITS,
  type Walkthrough,
  type WalkthroughImportStatus,
  type WalkthroughPage,
} from '@kontourai/station-contracts/walkthrough';
import {
  authenticatedFetch,
  type ClientRequestOptions,
  getJson,
  readEnvelopeOrThrow,
} from './http';

type BinaryOptions = Pick<
  ClientRequestOptions,
  'headers' | 'signal' | 'timeoutMs'
>;
function path(base: string, project: string) {
  return `${base}/api/projects/${encodeURIComponent(project)}/walkthroughs`;
}
async function unwrap<T>(response: Response): Promise<T> {
  const data = await readEnvelopeOrThrow<T>(response);
  if (data === undefined)
    throw new Error('Walkthrough response is missing data');
  return data;
}
export async function importWalkthrough(
  base: string,
  project: string,
  file: Blob,
  filename: string,
  requestId: string,
  opts?: BinaryOptions,
): Promise<WalkthroughImportStatus> {
  if (file.size < 1 || file.size > WALKTHROUGH_LIMITS.uploadBytes)
    throw new Error('Video must be between 1 byte and 512 MiB');
  const response = await authenticatedFetch(
    `${path(base, project)}/import?${new URLSearchParams({ filename })}`,
    {
      method: 'POST',
      body: file,
      headers: {
        ...opts?.headers,
        'Content-Type': 'application/octet-stream',
        'x-walkthrough-request-id': requestId,
      },
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? 2 * 60 * 60_000,
    },
  );
  return unwrap<WalkthroughImportStatus>(response);
}
export async function getWalkthroughImport(
  base: string,
  project: string,
  requestId: string,
  opts?: ClientRequestOptions,
): Promise<WalkthroughImportStatus> {
  return unwrap(
    await getJson(
      `${path(base, project)}/imports/${encodeURIComponent(requestId)}`,
      opts,
    ),
  );
}
export async function listWalkthroughs(
  base: string,
  project: string,
  page: { limit?: number; cursor?: string } = {},
  opts?: ClientRequestOptions,
): Promise<WalkthroughPage> {
  const query = new URLSearchParams();
  if (page.limit !== undefined) query.set('limit', String(page.limit));
  if (page.cursor) query.set('cursor', page.cursor);
  return unwrap(
    await getJson(
      `${path(base, project)}${query.size ? `?${query}` : ''}`,
      opts,
    ),
  );
}
export async function getWalkthrough(
  base: string,
  project: string,
  id: string,
  opts?: ClientRequestOptions,
): Promise<Walkthrough> {
  return parseWalkthrough(
    await unwrap(
      await getJson(`${path(base, project)}/${encodeURIComponent(id)}`, {
        maxResponseBytes: WALKTHROUGH_LIMITS.manifestBytes,
        ...opts,
      }),
    ),
  );
}
export function walkthroughFramePath(
  project: string,
  id: string,
  frameId: string,
): string {
  return `/api/projects/${encodeURIComponent(project)}/walkthroughs/${encodeURIComponent(id)}/frames/${encodeURIComponent(frameId)}`;
}

export async function getWalkthroughFrame(
  base: string,
  project: string,
  id: string,
  frameId: string,
  opts?: BinaryOptions,
): Promise<Uint8Array> {
  const response = await authenticatedFetch(
    `${base}${walkthroughFramePath(project, id, frameId)}`,
    {
      headers: opts?.headers,
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    },
  );
  if (!response.ok) await readEnvelopeOrThrow(response);
  if (response.headers.get('content-type') !== 'image/jpeg')
    throw new Error('Walkthrough frame unavailable');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Frame body missing');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > WALKTHROUGH_LIMITS.frameBytes)
        throw new Error('Frame exceeds read bound');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
