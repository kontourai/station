import { userInfo } from 'node:os';
import type { UserIdentity } from '@kontourai/station-contracts/auth';
import { Hono } from 'hono';
import {
  getAuthProvider,
  getUserDirectoryProvider,
  getUserIdentityProvider,
} from '../../providers/registries/registry.js';
import { isBoundLocalGrantMintedOperator } from '../../security/runtime-request-security.js';
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

export function createAuthRoutes() {
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
