import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { type Context, Hono } from 'hono';
import {
  AccountPreferencesConflictError,
  AccountPreferencesStore,
  InvalidAccountPreferencesError,
} from '../../services/identity/account-preferences.js';
import { connectedAccountOwnerId } from '../../services/identity/connected-account-owner.js';
import type { PersonalLayoutPrincipalContext } from './personal-layouts.js';

export function createAccountPreferencesRoutes(deps: {
  store: AccountPreferencesStore;
  resolvePrincipal(c: PersonalLayoutPrincipalContext): PrincipalRef;
  tenantId(request: Request): string | undefined;
  isInternal(request: Request): boolean;
}) {
  const app = new Hono();
  const handle = async (c: Context, write: boolean) => {
    c.header('Cache-Control', 'no-store');
    let principalId: string | undefined;
    try {
      if (!deps.isInternal(c.req.raw))
        principalId = connectedAccountOwnerId(deps.resolvePrincipal(c));
    } catch {
      return c.json(
        { error: { code: 'account_preferences_identity_required' } },
        403,
      );
    }
    if (!principalId)
      return c.json(
        { error: { code: 'account_preferences_identity_required' } },
        403,
      );
    const owner = { principalId, tenantId: deps.tenantId(c.req.raw) };
    try {
      if (!write)
        return c.json({ success: true, data: deps.store.read(owner) });
      const text = await c.req.text();
      if (Buffer.byteLength(text) > 128 * 1024)
        return c.json({ error: { code: 'preferences_too_large' } }, 413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: { code: 'invalid_account_preferences' } }, 400);
      }
      const data = await deps.store.patch(
        owner,
        body,
        c.req.query('onlyMissing') === 'true',
        c.req.header('If-Match'),
      );
      return c.json({ success: true, data });
    } catch (error) {
      if (error instanceof AccountPreferencesConflictError)
        return c.json({ error: { code: 'account_preferences_changed' } }, 409);
      if (error instanceof InvalidAccountPreferencesError)
        return c.json({ error: { code: 'invalid_account_preferences' } }, 400);
      return c.json(
        { error: { code: 'account_preferences_unavailable' } },
        503,
      );
    }
  };
  app.get('/preferences', (c) => handle(c, false));
  app.patch('/preferences', (c) => handle(c, true));
  return app;
}
