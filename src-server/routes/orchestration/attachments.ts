import { Hono } from 'hono';
import { isAttachmentBlobRef } from '../../services/orchestration/attachment-blob-store.js';
import { attachmentBlobRequests } from '../../telemetry/metrics.js';
import { param } from '../schemas/schemas.js';

export interface AttachmentRouteDeps {
  /**
   * One attachment's bytes by content reference, or `undefined` when they are
   * no longer stored. Deliberately not the blob store: this route reads, and
   * has no business writing or reclaiming.
   */
  readAttachment: (ref: string) => Buffer | undefined;
  /**
   * Bounded, owner-narrowed candidate threads bound to this blob. Narrowed in
   * SQL rather than filtered here so that "bound to threads you cannot read"
   * and "not bound at all" cost the same — otherwise response time answers
   * the question the 404 refuses to.
   */
  threadsForAttachment: (ref: string, request: Request) => string[];
  /**
   * The SAME session-read predicate every other event read goes through, not
   * a second derivation of it. A route that re-derives an authorization check
   * is a route that eventually gets one wrong.
   */
  canReadSession: (threadId: string, request: Request) => boolean;
}

/**
 * `GET /api/attachments/:ref` — the bytes behind an attachment a transcript is
 * showing (station#3385).
 *
 * Since #3374 the event log stores a content reference rather than the image,
 * and the byte-budgeted reads the transcript actually uses hand that reference
 * on unresolved. Without this route those chips can never show a picture, blob
 * on disk or not. `<img src>` cannot carry a bearer token, so the client
 * fetches here and wraps the result in an object URL.
 *
 * **The response deliberately does not name the image's type.** The store is
 * addressed by bytes alone and holds no MIME type — there is no "stored" type
 * to serve, and two attachments with different declared names can share one
 * digest, so no single type belongs to a blob. The declared type lives on the
 * attachment metadata in the event, which the client already has; it applies
 * that when it builds the Blob — and that metadata was itself validated
 * against the attachment mime allowlist on the way in, so the client can only
 * re-apply a type the contract already accepted. Serving inert
 * `application/octet-stream` under `nosniff` defends the other direction: a
 * direct navigation to this URL downloads bytes rather than rendering
 * attacker-influenced content as a document.
 */
export function createAttachmentRoutes(deps: AttachmentRouteDeps) {
  const app = new Hono();

  app.get('/:ref', (c) => {
    let ref: string;
    try {
      ref = param(c, 'ref');
    } catch {
      attachmentBlobRequests.add(1, { outcome: 'rejected' });
      return c.body(null, 400, {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    }
    // Shape-check BEFORE the reference reaches anything that touches a path.
    // This is the same anchored pattern the store itself validates with, not a
    // second, looser copy of it — a `..` segment is not a digest and never
    // becomes one here.
    if (!isAttachmentBlobRef(ref)) {
      attachmentBlobRequests.add(1, { outcome: 'rejected' });
      return c.body(null, 400, {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    }

    // Authorize BEFORE reading. A reference is not an authorization: the blob
    // store is content-addressed and deduped across every user, and a digest
    // is a function of the CONTENT, so anyone holding the same bytes computes
    // the reference offline. Answering on the reference alone would make this
    // a cross-user existence-and-content oracle — "does anyone on this Station
    // have this exact file".
    //
    // Dedup is why this asks "ANY thread the caller can read", not "the"
    // thread: one blob legitimately belongs to several conversations, and each
    // owner must pass through their own.
    //
    // The candidate set is owner-narrowed and capped before it gets here, so
    // the number of predicate calls — and therefore the response time — does
    // not vary with how many threads reference the blob. An unbound digest and
    // a digest bound only to other people's threads both cost zero.
    //
    // Blobs with no binding authorize nobody. The binding table and the blob
    // store land together and neither has ever shipped, so no released
    // Station's home holds a blob without rows here; a backfill-on-read would
    // be a per-request scan of the event log defending a population that does
    // not exist.
    const authorized = deps
      .threadsForAttachment(ref, c.req.raw)
      .some((threadId) => deps.canReadSession(threadId, c.req.raw));
    if (!authorized) {
      // 404, not 403: a caller who cannot read any thread referencing these
      // bytes must not learn whether they exist.
      attachmentBlobRequests.add(1, { outcome: 'not_found' });
      return c.body(null, 404, {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    }

    const bytes = deps.readAttachment(ref);
    if (!bytes) {
      // Absent and reclaimed are the same answer to a caller: these bytes are
      // not here. The transcript renders its chip without a preview.
      attachmentBlobRequests.add(1, { outcome: 'not_found' });
      return c.body(null, 404, {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    }

    attachmentBlobRequests.add(1, { outcome: 'served' });
    return c.body(Uint8Array.from(bytes), 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      // The reference IS the digest of the body, so it is an exact validator.
      ETag: `"${ref}"`,
      // Every use of this URL must be re-authorized at the origin.
      //
      // `max-age` plus `Vary: Authorization` was not enough, and the gap is
      // not theoretical: Station accepts a device-session COOKIE whenever an
      // Authorization header is absent (`runtime-http.ts`), so for every
      // cookie client the Vary key is identical across all cookie values AND
      // across cookie-absent. One cached 200 would replay to a different
      // session, a rotated one, and a revoked one. `Vary: Authorization,
      // Cookie` would still replay to a revoked session whose cookie value
      // had not changed.
      //
      // `no-cache` stores but always revalidates, so authorization is
      // re-derived on every use. There is no conditional-request path here
      // that could answer a revalidation with a 304 before the auth layer
      // runs — the ETag is served for future use, and validated by nothing
      // in this handler.
      'Cache-Control': 'private, no-cache',
      Vary: 'Authorization, Cookie',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  });

  return app;
}
