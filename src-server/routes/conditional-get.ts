import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/** Whether an `If-None-Match` header names `etag` (weak comparison, RFC 9110 §13.1.2). */
export function ifNoneMatchIncludes(
  header: string | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = opaque(etag);
  return header
    .split(',')
    .some(
      (candidate) => candidate.trim() === '*' || opaque(candidate) === target,
    );
}

const REVALIDATE = 'private, no-cache';
const CREDENTIAL_HEADERS = ['Authorization', 'Cookie'];

function varyByCredential(current: string | null): string {
  const names = (current ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.includes('*')) return '*';
  const present = new Set(names.map((name) => name.toLowerCase()));
  for (const name of CREDENTIAL_HEADERS)
    if (!present.has(name.toLowerCase())) names.push(name);
  return names.join(', ');
}

/**
 * Revalidation for GET JSON reads. The UI polls many reads on an interval,
 * from every 2 seconds for running work to every 30 on a constrained network,
 * and an answer is usually the one it already has. With a validator the
 * browser's own HTTP cache asks `If-None-Match`, and an unchanged read costs
 * a 304 instead of its body.
 *
 * The handler still runs, under the caller's own authority, before the
 * comparison: the tag is a digest of the body THIS caller would receive, so
 * a 304 confirms only bytes they were just authorized to read. `no-cache`
 * keeps every reuse a revalidation at the origin, and `Vary` keeps one
 * credential's copy from standing in for another's. Streams, binary bodies,
 * `no-store` responses and handlers with their own validator are left alone.
 */
export function jsonRevalidation(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.method !== 'GET' || c.res.status !== 200) return;
    if (!c.res.headers.get('Content-Type')?.startsWith('application/json'))
      return;
    if (c.res.headers.has('ETag')) return;
    const cacheControl = c.res.headers.get('Cache-Control');
    if (cacheControl && /no-store/i.test(cacheControl)) return;
    const body = new Uint8Array(await c.res.clone().arrayBuffer());
    const etag = `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"`;
    const vary = varyByCredential(c.res.headers.get('Vary'));
    if (ifNoneMatchIncludes(c.req.header('If-None-Match'), etag)) {
      c.res = new Response(null, { status: 304 });
      // Hono copies the replaced response's headers onto this one, so a 304
      // drops the length of a body it does not carry, and the validators
      // below are written after the copy rather than overwritten by it.
      c.header('Content-Length', undefined);
    }
    // `c.header` also re-creates a response whose headers are immutable,
    // such as one a handler passed through from `fetch`.
    c.header('ETag', etag);
    if (!cacheControl) c.header('Cache-Control', REVALIDATE);
    c.header('Vary', vary);
  };
}
