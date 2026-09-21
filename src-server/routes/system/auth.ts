import { userInfo } from 'node:os';
import type { UserIdentity } from '@kontourai/station-contracts/auth';
import { Hono } from 'hono';
import {
  getAuthProvider,
  getUserDirectoryProvider,
  getUserIdentityProvider,
} from '../../providers/registries/registry.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundLocalGrantMintedOperator,
} from '../../security/runtime-request-security.js';
import { AuthorityObservationRejected } from '../../services/identity/authority-observation.js';
import { PrincipalUnresolvedError } from '../../services/identity/principal-resolver.js';
import { authOps } from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import { errorMessage, param } from '../schemas/schemas.js';

const logger = createLogger({ name: 'auth' });

// ── Cached User Identity ───────────────────────────────

let cachedUser: UserIdentity | null = null;

/** Get cached user identity (available to other modules) */
export function getCachedUser(): UserIdentity {
  if (!cachedUser) {
    // Synchronous fallback — kick off async resolution
    cachedUser = { alias: userInfo().username };
    resolveUser().catch((e) =>
      logger.error('resolveUser failed', { error: e }),
    );
  }
  return cachedUser;
}

async function resolveUser(): Promise<UserIdentity> {
  if (cachedUser?.name) return cachedUser; // already enriched
  const provider = getUserIdentityProvider();
  cachedUser = await provider.getIdentity();
  if (provider.enrichIdentity) {
    provider
      .enrichIdentity(cachedUser)
      .then((enriched) => {
        cachedUser = enriched;
      })
      .catch(() => {});
  }
  return cachedUser;
}

// ── Routes ─────────────────────────────────────────────

/**
 * Wiring for `GET /api/auth/authority` (#481 groundwork). Everything is
 * injected from `configureRuntimeRoutes` so the observation reads the SAME
 * auth boundary facts and resolves through the SAME canonical principal
 * owner as every orchestration route — never a parallel derivation. Without
 * the wiring the route is not registered at all (fail closed), so a bare
 * `createAuthRoutes()` (tests, `/status` probes) can never answer an
 * unwired observation.
 */
export interface AuthRoutesAuthorityObservationDeps {
  resolveRequestPrincipal: (context: {
    env: unknown;
    req: { raw: Request; header(name: string): string | undefined };
  }) => import('@kontourai/station-contracts/principal').PrincipalRef;
  security: import('../../services/identity/authority-observation.js').AuthorityObservationSecurity;
  deploymentAuthentication?: import('../../services/identity/authority-observation.js').AuthorityObservationDeploymentAuthentication;
}

export function createAuthRoutes(
  authorityObservation?: AuthRoutesAuthorityObservationDeps,
) {
  const app = new Hono();

  app.get('/status', async (c) => {
    authOps.add(1, { operation: 'status' });
    const [authStatus, user] = await Promise.all([
      getAuthProvider().getStatus(),
      resolveUser(),
    ]);
    return c.json({ ...authStatus, user });
  });

  /**
   * The desktop shell asks this bounded, authenticated read before deciding
   * whether a readable saved bearer can continue to act as this Station's
   * local operator.  The answer is the auth boundary's already-bound
   * mint-time fact, not an inference from loopback, source, or the bearer
   * text.  In particular, a pre-#3677 paired credential can be accepted by
   * `/status` while still answering `eligible: false` here.
   *
   * This endpoint deliberately mints, changes, and reveals no credential
   * metadata.  The desktop alone may respond to `false` by presenting the
   * owner-only local-grant secret to the public exchange route; paired and
   * remote clients cannot turn this observation into an elevation.
   */
  app.get('/local-grant-eligibility', (c) =>
    c.json({
      eligible: isBoundLocalGrantMintedOperator(c.req.raw),
    }),
  );

  // #481 groundwork: the closed, credential-bound authority observation.
  // Flows the SAME runtime auth middleware as every protected route (bearer,
  // device-session cookie, native continuation) and resolves through the
  // canonical principal owner injected above. Authorization-neutral: it
  // describes the caller's authority, grants nothing, and contains no
  // credential material. Captured once, then published ONLY through the
  // delivery guard, which revalidates FRESH facts (credential currency,
  // device binding, grant, home identity, re-`authenticate`d account
  // session — not the cached per-request result) before the first body byte
  // and before every queued chunk; drift fails closed with the boundary's
  // own codes, never a stale observation. A bare `c.json` after capture is
  // NOT a release guard — the body can sit queued while authority changes.
  if (authorityObservation) {
    app.get('/authority', async (c) => {
      const {
        captureAuthorityObservation,
        guardAuthorityObservationResponse,
        revalidateAuthorityObservation,
      } = await import('../../services/identity/authority-observation.js');
      const revalidateInput = async (
        captured: import('../../services/identity/authority-observation.js').CapturedAuthorityObservation,
      ): Promise<void> =>
        revalidateAuthorityObservation({
          request: c.req.raw,
          captured,
          security: authorityObservation.security,
          deploymentAuthentication:
            authorityObservation.deploymentAuthentication,
        });
      try {
        const captured = await captureAuthorityObservation({
          context: { env: c.env, req: c.req },
          request: c.req.raw,
          runtimePrincipal: getRuntimeAuthenticatedRequestPrincipal(c.req.raw),
          security: authorityObservation.security,
          deploymentAuthentication:
            authorityObservation.deploymentAuthentication,
          resolveRequestPrincipal: authorityObservation.resolveRequestPrincipal,
        });
        const response = c.json(captured.envelope);
        response.headers.set('Cache-Control', 'no-store');
        return await guardAuthorityObservationResponse(response, () =>
          revalidateInput(captured),
        );
      } catch (error) {
        // Early refusals carry the same `no-store` as the guarded body:
        // a fail-closed error must never become a cacheable response.
        if (error instanceof AuthorityObservationRejected) {
          return Response.json(
            { error: { code: error.code } },
            {
              status: error.status,
              headers: { 'Cache-Control': 'no-store' },
            },
          );
        }
        if (error instanceof PrincipalUnresolvedError) {
          return Response.json(
            { error: { code: 'authentication_required' } },
            {
              status: 401,
              headers: { 'Cache-Control': 'no-store' },
            },
          );
        }
        throw error;
      }
    });
  }

  app.post('/renew', async (c) => {
    authOps.add(1, { operation: 'renew' });
    try {
      const result = await getAuthProvider().renew();
      return c.json(result);
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/terminal', async (c) => {
    try {
      const result = await getAuthProvider().renew();
      return c.json(result);
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/badge-photo/:id', async (c) => {
    const id = param(c, 'id');
    const provider = getAuthProvider();
    if (!provider.getBadgePhoto) {
      return c.body(null, 404);
    }
    try {
      const data = await provider.getBadgePhoto(id);
      if (!data) return c.body(null, 404);
      c.header('Content-Type', 'image/jpeg');
      c.header('Cache-Control', 'public, max-age=86400');
      return c.body(data);
    } catch (e) {
      logger.debug('Failed to fetch badge photo', { id, error: e });
      return c.body(null, 502);
    }
  });

  return app;
}

export function createUserRoutes() {
  const app = new Hono();

  app.get('/search', async (c) => {
    authOps.add(1, { operation: 'search' });
    const q = c.req.query('q') || '';
    if (!q) return c.json([]);
    try {
      return c.json(await getUserDirectoryProvider().searchPeople(q));
    } catch (e) {
      logger.debug('Failed to search people directory', { q, error: e });
      return c.json([]);
    }
  });

  app.get('/:alias', async (c) => {
    const alias = param(c, 'alias');
    try {
      return c.json(await getUserDirectoryProvider().lookupPerson(alias));
    } catch (error: unknown) {
      return c.json({ alias, name: alias, error: errorMessage(error) }, 404);
    }
  });

  return app;
}
