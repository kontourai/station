import { createHash } from 'node:crypto';
import { PAIRING_SCOPE_ORCHESTRATION_READ } from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import { createAttachmentRoutes } from '../attachments.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  attachmentBlobRequests: { add: vi.fn() },
}));

const pixels = Buffer.from('the bytes of a pasted screenshot', 'utf8');
const digest = createHash('sha256').update(pixels).digest('hex');
const ref = `sha256-${digest}`;

const OWNER = 'owner-token';

function appFor(
  readAttachment: (ref: string) => Buffer | undefined,
  options: {
    threadsForAttachment?: (ref: string, request: Request) => string[];
    readableBy?: Record<string, string[]>;
  } = {},
) {
  const app = new Hono();
  const readable = options.readableBy ?? { [OWNER]: ['thread-owned'] };
  app.route(
    '/api/attachments',
    createAttachmentRoutes({
      readAttachment,
      // Stands in for the owner-narrowed SQL: the candidate set the route
      // receives already excludes threads this principal cannot read.
      threadsForAttachment:
        options.threadsForAttachment ??
        ((_ref, request) => {
          const principal = (
            request.headers.get('authorization') ?? ''
          ).replace(/^Bearer /, '');
          return readable[principal] ?? [];
        }),
      // Stands in for `canUserReadSession(threadId, authority)`: the principal
      // comes from the request, the answer from what that principal may read.
      canReadSession: (threadId, request) => {
        const principal = (request.headers.get('authorization') ?? '').replace(
          /^Bearer /,
          '',
        );
        return (readable[principal] ?? []).includes(threadId);
      },
    }),
  );
  return app;
}

const asOwner = { headers: { Authorization: `Bearer ${OWNER}` } };

describe('GET /api/attachments/:ref (station#3385)', () => {
  test('serves the stored bytes, and they still match their digest', async () => {
    const response = await appFor(() => pixels).request(
      `/api/attachments/${ref}`,
      asOwner,
    );

    expect(response.status).toBe(200);
    const served = Buffer.from(await response.arrayBuffer());
    // The reference IS the digest, so this is the whole contract: what came
    // back is the attachment the transcript asked for, not merely 200 bytes.
    expect(createHash('sha256').update(served).digest('hex')).toBe(digest);
    expect(response.headers.get('etag')).toBe(`"${ref}"`);
  });

  test('never names a content type, and marks the bytes inert', async () => {
    const response = await appFor(() => pixels).request(
      `/api/attachments/${ref}`,
      asOwner,
    );

    // The store is addressed by bytes and holds no MIME type; the client
    // applies the type the event declared. A route that guessed one would be
    // asserting something nothing derives.
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(response.headers.get('cross-origin-resource-policy')).toBe(
      'same-origin',
    );
    // Authorization must be re-derived on every use. Station accepts a
    // device-session cookie whenever Authorization is absent, so a cached
    // response keyed only on Authorization replays across sessions — and any
    // freshness window at all replays to a revoked one.
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get('vary')).toBe('Authorization, Cookie');
  });

  test('rejects anything that is not a digest before it reaches the store', async () => {
    const readAttachment = vi.fn(() => pixels);
    const app = appFor(readAttachment);

    for (const candidate of [
      '..%2F..%2Fetc%2Fpasswd',
      'sha256-..%2F..%2Fsecret',
      `sha256-${'z'.repeat(64)}`,
      `sha256-${digest.toUpperCase()}`,
      `sha256-${digest.slice(0, 63)}`,
      digest,
    ]) {
      const response = await app.request(
        `/api/attachments/${candidate}`,
        asOwner,
      );
      expect(response.status, candidate).toBe(400);
    }

    // The point is not the status — it is that a malformed reference never
    // became a filesystem lookup at all.
    expect(readAttachment).not.toHaveBeenCalled();
  });

  test('404s honestly when the blob has been reclaimed', async () => {
    const response = await appFor(() => undefined).request(
      `/api/attachments/${ref}`,
      asOwner,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer()).byteLength).toBe(0);
  });

  test('refuses a caller who cannot read any thread referencing the blob', async () => {
    const readAttachment = vi.fn(() => pixels);
    const app = appFor(readAttachment, {
      readableBy: { [OWNER]: ['thread-owned'], intruder: [] },
    });

    const response = await app.request(`/api/attachments/${ref}`, {
      headers: { Authorization: 'Bearer intruder' },
    });

    // 404, not 403: the digest is a function of the CONTENT, so a caller
    // holding the same bytes can compute this reference offline. Confirming
    // it exists would make the route a cross-user content oracle.
    expect(response.status).toBe(404);
    expect(Buffer.from(await response.arrayBuffer()).byteLength).toBe(0);
    // And authorization runs BEFORE the read: an unauthorized caller must not
    // even cause the bytes to be loaded.
    expect(readAttachment).not.toHaveBeenCalled();
  });

  test('a blob no thread references authorizes nobody', async () => {
    const readAttachment = vi.fn(() => pixels);
    const app = appFor(readAttachment, { threadsForAttachment: () => [] });

    const response = await app.request(`/api/attachments/${ref}`, asOwner);

    expect(response.status).toBe(404);
    expect(readAttachment).not.toHaveBeenCalled();
  });

  test('one deduped blob reaches each owner through their own thread', async () => {
    // The case a "the thread" check would get wrong: content addressing means
    // two people who attach the same image share one blob.
    const app = appFor(() => pixels, {
      threadsForAttachment: () => ['thread-a', 'thread-b'],
      readableBy: { alice: ['thread-a'], bob: ['thread-b'], mallory: [] },
    });

    for (const principal of ['alice', 'bob']) {
      const response = await app.request(`/api/attachments/${ref}`, {
        headers: { Authorization: `Bearer ${principal}` },
      });
      expect(response.status, principal).toBe(200);
    }
    const refused = await app.request(`/api/attachments/${ref}`, {
      headers: { Authorization: 'Bearer mallory' },
    });
    expect(refused.status).toBe(404);
  });

  test('a foreign digest costs the same as an unbound one (#3385 review)', async () => {
    // The timing oracle: if the route put every BOUND thread through the
    // predicate, a digest bound to a hundred unreadable threads would cost a
    // hundred synchronous owner folds while an unbound digest cost none —
    // and response time would answer "does anyone on this Station hold these
    // bytes", which is exactly what the 404 refuses to say.
    const canReadSession = vi.fn(() => false);
    const app = new Hono();
    app.route(
      '/api/attachments',
      createAttachmentRoutes({
        readAttachment: () => pixels,
        // The narrowing already dropped the foreign bindings.
        threadsForAttachment: () => [],
        canReadSession,
      }),
    );

    const response = await app.request(`/api/attachments/${ref}`, asOwner);

    expect(response.status).toBe(404);
    expect(canReadSession).not.toHaveBeenCalled();
  });

  test('an authorized read is not O(bindings) either', async () => {
    const canReadSession = vi.fn(() => true);
    const app = new Hono();
    app.route(
      '/api/attachments',
      createAttachmentRoutes({
        readAttachment: () => pixels,
        threadsForAttachment: () => ['t1', 't2', 't3', 't4'],
        canReadSession,
      }),
    );

    const response = await app.request(`/api/attachments/${ref}`, asOwner);

    expect(response.status).toBe(200);
    // `.some` stops at the first thread that authorizes.
    expect(canReadSession).toHaveBeenCalledTimes(1);
  });

  test('requires authentication at the pairing boundary', () => {
    // A blob route that resolved to no scope would be treated as public by
    // the runtime's fail-closed classifier, which is how an unlisted route
    // becomes an unauthenticated one.
    expect(requiredPairingScope('GET', `/api/attachments/${ref}`)).toBe(
      PAIRING_SCOPE_ORCHESTRATION_READ,
    );
  });
});
