import { Hono } from 'hono';
import type { PeerCredentialStore } from '../../services/peers/peer-credential-store.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  isTrustedInternalApiToken,
} from '../../utils/internal-api-token.js';
import {
  errorMessage,
  getBody,
  param,
  peerCredentialUpsertSchema,
  validate,
} from '../schemas/schemas.js';

/**
 * Outbound peer-credential admin routes (station#1123 slice 2). Mounted at
 * `/api/environments/peers`, gated to `access:manage` in
 * `src-server/security/pairing-route-scopes.ts` — the same tier
 * `/api/pairing/**` uses, so only the operator's own local/full credential
 * (or Station's exact internal-token attestation) can reach it. Direct
 * loopback and SSH callers must present a credential too. `GET`/`POST`/`DELETE` never return the raw credential —
 * only `GET /:environmentId/credential` does, and that leaf has an
 * additional, unconditional in-handler check: it 403s any request that
 * isn't carrying this Station's own internal API token, regardless of
 * pairing scope. `station-control-delegation.ts` is the only intended
 * caller of that leaf (see `connectPeerTarget`).
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
   * station#1123 slice 2 review fix (MEDIUM, PR #1178): optional SSH-profile
   * lookup, mirroring the CLI's `warnIfSshProfileTakesPrecedence`.
   * `resolveTarget` (`station-control-delegation.ts`) tries SSH first and
   * only ever falls back to this store's `'peer'`-kind target resolution
   * (a different apiBase, a different connection) when no SSH profile
   * matches. When provided, a matching environmentId adds a non-blocking
   * `warning` to the 201 response rather than refusing the write
   * (SSH-then-peer precedence is a disclosed, deliberate ordering that may
   * change in slice 8).
   *
   * station#1123 slice 3 update: this credential is NOT unenforced in that
   * case anymore. `connectSshTarget` now also fetches this same store entry
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
) {
  const app = new Hono();

  app.get('/', (c) => c.json({ success: true, data: store.list() }));

  app.post('/', validate(peerCredentialUpsertSchema), async (c) => {
    try {
      const body = getBody(c) as {
        environmentId: string;
        apiBase: string;
        credential: string;
        scope: string;
        label?: string;
      };
      const data = await store.upsert(body);
      const warning = hasSshProfile?.(body.environmentId)
        ? `Environment '${body.environmentId}' already has a saved SSH profile. delegate_task connects via the SSH tunnel, not this credential's apiBase — but the credential IS attached to and scope-enforced on that SSH-tunneled connection (station#1123 slice 3). Only the apiBase you set here is ignored while the SSH profile exists.`
        : undefined;
      return c.json(
        { success: true, data, ...(warning ? { warning } : {}) },
        201,
      );
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.delete('/:environmentId', async (c) => {
    const removed = await store.remove(param(c, 'environmentId'));
    return removed
      ? c.json({ success: true })
      : c.json({ success: false, error: 'Peer credential not found' }, 404);
  });

  // Internal-only: the raw credential this Station presents to the peer.
  // Defense in depth beyond the route-scope table — never trust the scope
  // check alone for a secret-bearing leaf. A remote pairing credential
  // (even one somehow carrying access:manage) is refused here regardless.
  app.get('/:environmentId/credential', (c) => {
    if (!isTrustedInternalApiToken(c.req.header(INTERNAL_API_TOKEN_HEADER))) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    const record = store.get(param(c, 'environmentId'));
    return record
      ? c.json({
          success: true,
          data: {
            environmentId: record.environmentId,
            apiBase: record.apiBase,
            scope: record.scope,
            credential: record.credential,
            label: record.label,
          },
        })
      : c.json({ success: false, error: 'Peer credential not found' }, 404);
  });

  return app;
}
