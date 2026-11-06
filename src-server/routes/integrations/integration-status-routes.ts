import type { IntegrationStatus } from '@kontourai/station-contracts/integration-status';
import { Hono } from 'hono';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';

export function createIntegrationStatusRoutes(deps: {
  readStatus: (options?: {
    includeGithubAuthentication?: boolean;
  }) => Promise<IntegrationStatus>;
  mayRead: (request: Request) => boolean;
  githubAuthenticationEnabled?: () => boolean;
}) {
  const app = new Hono();
  app.get('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    const current = () => !c.req.raw.signal.aborted && deps.mayRead(c.req.raw);
    const denied = () => c.json({ success: false, code: 'access-denied' }, 403);
    const includeGithubAuthentication =
      c.req.query('include') === 'github-authentication';
    const enabled = () =>
      !includeGithubAuthentication ||
      deps.githubAuthenticationEnabled?.() === true;
    const disabled = () =>
      c.json(
        {
          success: false,
          code: 'feature_preview_disabled',
          previewId: 'repository-auth-details',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
          error:
            'Enable Repository sign-in details in Settings → Advanced → Feature previews.',
        },
        404,
      );
    if (!current()) return denied();
    if (!enabled()) return disabled();
    const data = await deps.readStatus({
      includeGithubAuthentication,
    });
    if (!current()) return denied();
    if (!enabled()) return disabled();
    return guardProjectResponse(
      c.json({ success: true, data }),
      async () => current() && enabled(),
    );
  });
  return app;
}
