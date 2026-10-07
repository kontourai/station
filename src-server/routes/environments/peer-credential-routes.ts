import { Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  PeerCredentialMutationAuthorizationError,
  type PeerCredentialStore,
} from '../../services/peers/peer-credential-store.js';
import type { PeerEnrollmentService } from '../../services/peers/peer-enrollment-service.js';
import {
  errorMessage,
  getBody,
  param,
  peerCredentialUpsertSchema,
  validate,
} from '../schemas/schemas.js';

/**
 * Outbound peer-credential admin routes (archive#1123). Mounted at
 * `/api/environments/peers`. The runtime credential boundary keeps mutations
 * operator-only; public mutations additionally require the request-principal
 * currentness predicate supplied at composition and recheck it under the
 * store's file-mutation lock. Metadata reads remain governed by global scope
 * authorization. Direct loopback and SSH callers must present a credential
 * too. No route here returns the raw credential. #2377 slice C2b deleted
 * the one leaf that did (`GET /:environmentId/credential`, read by the
 * station-control tools): the bearer is now read in-process, only by the
 * one remote seam runtime composition builds (`RemoteStationForwarder`).
 *
 * Provisioning UX (slice 2, explicit stopgap): these routes are the whole
 * provisioning mechanism for now — a `station environment peers add/list/
 * remove` CLI verb calls them directly against a loopback `--api-base`, the
 * same pattern `station environment access approve/deny` already uses for
 * other loopback-only operator actions. Slice 4's mutual pairing exchange
 * protocol supersedes this manual path entirely; do not build on top of it.
 */
export function createPeerCredentialRoutes(
  store: PeerCredentialStore,
  /**
   * archive#1123 review fix (MEDIUM, PR archive#1178): optional SSH-profile
   * lookup, mirroring the CLI's `warnIfSshProfileTakesPrecedence`.
   * `RemoteStationForwarder.resolve` tries SSH first and
   * only ever falls back to this store's `'peer'`-kind target resolution
   * (a different apiBase, a different connection) when no SSH profile
   * matches. When provided, a matching environmentId adds a non-blocking
   * `warning` to the 201 response rather than refusing the write
   * (SSH-then-peer precedence is a disclosed, deliberate ordering that may
   * change in slice 8).
   *
   * archive#1123 update: this credential is NOT unenforced in that
   * case anymore. The SSH-tunneled target also carries this same store entry
   * and attaches its `Authorization: Bearer` header to requests over the SSH
   * tunnel, so the credential's scope IS what governs access there (see
   * `runtime-http.ts`'s credential requirement). What SSH precedence
   * still means: connection routing (the `apiBase`/tunnel actually used)
   * always comes from the SSH profile, never from this credential's own
   * `apiBase` field — that field is simply ignored whenever an SSH profile
   * also matches. The warning below is retargeted to that narrower, still-
   * true nuance rather than retracted outright.
   */
  hasSshProfile?: (environmentId: string) => boolean,
  authorize?: (request: Request) => boolean,
  enrollments?: PeerEnrollmentService,
) {
  const app = new Hono();

  const mutationAuthorized = (request: Request): boolean => {
    try {
      const decision: unknown = authorize?.(request);
      if (decision === true) return true;
      void Promise.resolve(decision).catch(() => {});
      return false;
    } catch {
      return false;
    }
  };

  app.post('/enrollments', async (c) => {
    const request = c.req.raw;
    if (!mutationAuthorized(request))
      return c.json({ success: false, error: 'Forbidden' }, 403);
    if (!enrollments)
      return c.json({ success: false, error: 'Enrollment unavailable' }, 503);
    const body = await readBoundedRequestBody(request, 2048);
    if (body.status !== 'ok')
      return c.json({ success: false, error: 'Invalid enrollment' }, 400);
    try {
      const parsed: unknown = JSON.parse(body.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Invalid enrollment');
      const value = parsed as Record<string, unknown>;
      if (
        Object.keys(value).some(
          (key) => !['id', 'apiBase', 'environmentId', 'label'].includes(key),
        ) ||
        typeof value.id !== 'string' ||
        typeof value.apiBase !== 'string' ||
        typeof value.environmentId !== 'string' ||
        (value.label !== undefined && typeof value.label !== 'string')
      )
        throw new Error('Invalid enrollment');
      const data = await enrollments.start(
        {
          id: value.id,
          apiBase: value.apiBase,
          environmentId: value.environmentId,
          ...(typeof value.label === 'string' ? { label: value.label } : {}),
        },
        () => mutationAuthorized(request),
      );
      return c.json({ success: true, data }, 201);
    } catch (error) {
      return c.json(
        {
          success: false,
          error:
            error instanceof PeerCredentialMutationAuthorizationError
              ? 'Forbidden'
              : errorMessage(error),
        },
        error instanceof PeerCredentialMutationAuthorizationError ? 403 : 400,
      );
    }
  });
  app.get('/enrollments/:id', (c) => {
    const request = c.req.raw;
    if (!mutationAuthorized(request))
      return c.json({ success: false, error: 'Forbidden' }, 403);
    if (!enrollments)
      return c.json({ success: false, error: 'Enrollment unavailable' }, 503);
    try {
      return c.json({
        success: true,
        data: enrollments.get(param(c, 'id'), () =>
          mutationAuthorized(request),
        ),
      });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 404);
    }
  });
  app.post('/enrollments/:id/complete', async (c) => {
    const request = c.req.raw;
    if (!mutationAuthorized(request))
      return c.json({ success: false, error: 'Forbidden' }, 403);
    if (!enrollments)
      return c.json({ success: false, error: 'Enrollment unavailable' }, 503);
    try {
      return c.json({
        success: true,
        data: await enrollments.complete(param(c, 'id'), () =>
          mutationAuthorized(request),
        ),
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error:
            error instanceof PeerCredentialMutationAuthorizationError
              ? 'Forbidden'
              : errorMessage(error),
        },
        error instanceof PeerCredentialMutationAuthorizationError ? 403 : 400,
      );
    }
  });
  app.delete('/enrollments/:id', (c) => {
    const request = c.req.raw;
    if (!mutationAuthorized(request))
      return c.json({ success: false, error: 'Forbidden' }, 403);
    if (!enrollments)
      return c.json({ success: false, error: 'Enrollment unavailable' }, 503);
    try {
      return c.json({
        success: true,
        data: enrollments.cancel(param(c, 'id'), () =>
          mutationAuthorized(request),
        ),
      });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.get('/', (c) => c.json({ success: true, data: store.list() }));

  app.post('/', validate(peerCredentialUpsertSchema), async (c) => {
    const request = c.req.raw;
    if (!mutationAuthorized(request)) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    try {
      const body = getBody(c) as {
        environmentId: string;
        apiBase: string;
        credential: string;
        scope: string;
        label?: string;
      };
      const data = await store.upsert(body, () => mutationAuthorized(request));
      const warning = hasSshProfile?.(body.environmentId)
        ? `Environment '${body.environmentId}' already has a saved SSH profile. delegate_task connects via the SSH tunnel, not this credential's apiBase — but the credential IS attached to and scope-enforced on that SSH-tunneled connection (station#1123 slice 3). Only the apiBase you set here is ignored while the SSH profile exists.`
        : undefined;
      return c.json(
        { success: true, data, ...(warning ? { warning } : {}) },
        201,
      );
    } catch (error) {
      if (error instanceof PeerCredentialMutationAuthorizationError) {
        return c.json({ success: false, error: 'Forbidden' }, 403);
      }
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.delete('/:environmentId', async (c) => {
    const request = c.req.raw;
    if (!mutationAuthorized(request)) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    try {
      const removed = await store.remove(param(c, 'environmentId'), () =>
        mutationAuthorized(request),
      );
      return removed
        ? c.json({ success: true })
        : c.json({ success: false, error: 'Peer credential not found' }, 404);
    } catch (error) {
      if (error instanceof PeerCredentialMutationAuthorizationError) {
        return c.json({ success: false, error: 'Forbidden' }, 403);
      }
      throw error;
    }
  });

  return app;
}
