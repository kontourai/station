import type {
  LocalAccountActionResult,
  LocalAccountAdministrationView,
} from '@kontourai/station-contracts/local-accounts';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import type { LoadedDeploymentAuthentication } from '../../services/identity/deployment-authentication-loader.js';
import type { LoadedLocalAccounts } from '../../services/identity/local-account-runtime.js';

/** Private operator controls; a Project admin or a paired personal device is not an operator. */
export function createLocalAccountAdministrationRoutes(
  localAccounts: LoadedLocalAccounts | undefined,
  authentication: LoadedDeploymentAuthentication | undefined,
  requireOperator: (request: Request) => Promise<void>,
) {
  const app = new Hono();
  const run = async (
    c: Context,
    operation: () => Promise<
      LocalAccountAdministrationView | LocalAccountActionResult
    >,
  ) => {
    c.header('Cache-Control', 'no-store');
    try {
      await requireOperator(c.req.raw);
    } catch {
      return c.json({ error: { code: 'operator_required' } }, 403);
    }
    try {
      const data = await operation();
      await requireOperator(c.req.raw);
      return c.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json({ error: { code: 'invalid_request' } }, 400);
      return c.json({ error: { code: 'account_operation_unavailable' } }, 503);
    }
  };
  app.get('/', (c) =>
    run(c, async () =>
      localAccounts
        ? { kind: 'local', accounts: localAccounts.administration.list() }
        : authentication
          ? {
              kind: 'external',
              provider: authentication.service.describe().displayName,
            }
          : { kind: 'none' },
    ),
  );
  app.post('/:accountId/actions', (c) =>
    run(c, async () => {
      if (!localAccounts) throw new Error('Local accounts are not configured.');
      const accountId = z
        .string()
        .min(1)
        .max(256)
        .parse(c.req.param('accountId'));
      const text = await c.req.text();
      if (new TextEncoder().encode(text).byteLength > 4096)
        throw new z.ZodError([]);
      const input = z
        .object({
          action: z.enum([
            'disable',
            'enable',
            'revoke-sessions',
            'create-recovery',
          ]),
        })
        .strict()
        .parse(JSON.parse(text));
      await requireOperator(c.req.raw);
      if (input.action === 'create-recovery')
        return { recoveryUrl: await localAccounts.issueRecovery(accountId) };
      if (input.action === 'revoke-sessions')
        localAccounts.administration.revokeSessions(accountId);
      else
        localAccounts.administration.setDisabled(
          accountId,
          input.action === 'disable',
        );
      return { changed: true };
    }),
  );
  return app;
}
