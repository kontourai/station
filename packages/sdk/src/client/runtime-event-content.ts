/**
 * Out-of-line runtime event content (docs/design/event-content-spill.md).
 *
 * `GET /api/orchestration/sessions/:threadId/content/:ref` returns the raw
 * body behind a `RuntimeEventContentRef`. A client that allows a request
 * whose content was spilled must load every reference first and send
 * `viewedContentDigest`; {@link loadRuntimeEventContent} does both.
 */
import {
  collectRuntimeEventContentRefs,
  type RuntimeEventContentBody,
  resolveRuntimeEventContent,
  viewedContentPreimage,
} from '@kontourai/station-contracts/runtime-event-content';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson, readJsonBody } from './http';

export interface RuntimeEventContentRead extends RuntimeEventContentBody {
  bytes: number;
  /** False only for a `maxChars` prefix read of a longer body. */
  complete: boolean;
}

export async function fetchRuntimeEventContent(
  apiBase: string,
  threadId: string,
  ref: string,
  opts?: ClientRequestOptions & { maxChars?: number },
): Promise<RuntimeEventContentRead> {
  const query =
    opts?.maxChars === undefined ? '' : `?maxChars=${opts.maxChars}`;
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/content/${encodeURIComponent(ref)}${query}`,
    opts,
  );
  if (!response.ok)
    throw envelopeError(
      response,
      await readJsonBody(response),
      'Event content unavailable',
      { message: 'Event content unavailable' },
    );
  const kind = response.headers.get('X-Station-Content-Kind');
  if (kind !== 'string' && kind !== 'json')
    throw new Error('Event content response has no content kind');
  const bytes = Number(response.headers.get('X-Station-Content-Bytes'));
  return {
    kind,
    body: await response.text(),
    bytes: Number.isSafeInteger(bytes) ? bytes : 0,
    complete: response.headers.get('X-Station-Content-Complete') !== 'false',
  };
}

/**
 * The `viewedContentDigest` for a stored event: `sha256-` plus the hex
 * SHA-256 of its stored text (WebCrypto, so it runs in browsers, native
 * shells and Node alike).
 */
export async function computeViewedContentDigest(
  event: unknown,
  bound?: unknown,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('This client cannot compute a content digest');
  const hash = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(viewedContentPreimage(event, bound)),
  );
  return `sha256-${Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

/**
 * Load every reference in a stored event and return the resolved event and
 * the digest that proves the load. Rejects if any body could not be read,
 * so a caller never allows a request on partial content.
 */
export async function loadRuntimeEventContent<T>(
  apiBase: string,
  threadId: string,
  event: T,
  opts?: ClientRequestOptions,
): Promise<{ resolved: T; viewedContentDigest: string }> {
  const refs = collectRuntimeEventContentRefs(event);
  const bodies = new Map<string, RuntimeEventContentBody>();
  await Promise.all(
    refs.map(async (ref) => {
      const read = await fetchRuntimeEventContent(
        apiBase,
        threadId,
        ref.ref,
        opts,
      );
      if (!read.complete || read.kind !== ref.kind)
        throw new Error('Event content did not load completely');
      bodies.set(ref.ref, { kind: read.kind, body: read.body });
    }),
  );
  return {
    resolved: resolveRuntimeEventContent(event, (ref) => bodies.get(ref)),
    viewedContentDigest: await computeViewedContentDigest(event),
  };
}

/** What the server's gate checks for an allow of one request. */
export interface ApprovalContentBinding {
  requestEventId: string;
  request: CanonicalRuntimeEvent;
  bound: CanonicalRuntimeEvent[];
  required: boolean;
  viewedContentDigest: string;
}

export async function fetchApprovalContentBinding(
  apiBase: string,
  threadId: string,
  requestId: string,
  opts?: ClientRequestOptions,
): Promise<ApprovalContentBinding> {
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/requests/${encodeURIComponent(requestId)}/content-binding`,
    opts,
  );
  const body = await readJsonBody(response);
  if (!response.ok)
    throw envelopeError(response, body, 'Request content unavailable', {
      message: 'Request content unavailable',
    });
  const data = (body as { data?: ApprovalContentBinding } | undefined)?.data;
  if (!data || typeof data.viewedContentDigest !== 'string')
    throw new Error('Request content binding is invalid');
  return data;
}

/**
 * docs/design/event-content-spill.md: load everything an allow of this
 * request must load, as the server defines it (the request and the tool
 * calls bound to it), and return the digest to send. The digest is checked
 * against this client's own computation over the same events, so a server
 * and client that disagree on the definition fail here rather than at the
 * gate. Rejects if any body could not be read.
 */
export async function loadApprovalContent(
  apiBase: string,
  threadId: string,
  requestId: string,
  opts?: ClientRequestOptions,
): Promise<{
  binding: ApprovalContentBinding;
  request: CanonicalRuntimeEvent;
  bound: CanonicalRuntimeEvent[];
  viewedContentDigest: string;
}> {
  const binding = await fetchApprovalContentBinding(
    apiBase,
    threadId,
    requestId,
    opts,
  );
  const request = await loadRuntimeEventContent(
    apiBase,
    threadId,
    binding.request,
    opts,
  );
  const bound = await loadRuntimeEventContent(
    apiBase,
    threadId,
    binding.bound,
    opts,
  );
  const computed = await computeViewedContentDigest(
    binding.request,
    binding.bound,
  );
  if (computed !== binding.viewedContentDigest)
    throw new Error('Request content binding does not match its events');
  return {
    binding,
    request: request.resolved,
    bound: bound.resolved,
    viewedContentDigest: computed,
  };
}
