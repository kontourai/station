import { type Context, Hono } from 'hono';
import {
  ReviewedTariffConfigurationError,
  type ReviewedTariffConfigurationService,
} from '../../analytics/reviewed-tariff-config.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';

export function createReviewedTariffRoutes(deps: {
  service(): ReviewedTariffConfigurationService | undefined;
  enabled(): boolean;
  authorize(
    context: Context,
  ): Promise<{ actorId: string; assertCurrent(): void } | undefined>;
}) {
  const app = new Hono();
  app.all('/reviewed-tariffs', async (c) => {
    if (!deps.enabled())
      return c.json(
        {
          success: false,
          code: 'feature_preview_disabled',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
          error: 'Enable reviewed tariff sources in Feature previews.',
          previewId: 'reviewed-usage-tariffs',
        },
        404,
      );
    const authority = await deps.authorize(c);
    if (!authority)
      return c.json({ error: 'Local operator access required' }, 403);
    const service = deps.service();
    if (!service)
      return c.json({ error: 'Private tariff configuration unavailable' }, 503);
    const admission = {
      actorId: authority.actorId,
      assertCurrent() {
        try {
          authority.assertCurrent();
        } catch {
          throw new ReviewedTariffConfigurationError('restricted');
        }
      },
    };
    try {
      admission.assertCurrent();
      let data: unknown;
      if (c.req.method === 'GET') {
        const current = service.read();
        data =
          current.state === 'available'
            ? { state: 'available', configuration: current.configuration }
            : current;
      } else if (c.req.method === 'PUT') {
        const body = await readBoundedRequestBody(c.req.raw, 2 * 1024 * 1024);
        if (body.status !== 'ok')
          return c.json(
            { error: 'Invalid or oversized tariff review' },
            body.status === 'too-large' ? 413 : 400,
          );
        data = await service.review(JSON.parse(body.body), admission);
      } else return c.json({ error: 'Method not allowed' }, 405);
      admission.assertCurrent();
      return guardProjectResponse(c.json({ success: true, data }), async () => {
        try {
          authority.assertCurrent();
          return !c.req.raw.signal.aborted && deps.enabled();
        } catch {
          return false;
        }
      });
    } catch (error) {
      return c.json(
        {
          error: 'Tariff review not applied',
          code:
            error instanceof ReviewedTariffConfigurationError
              ? error.code
              : 'invalid',
        },
        error instanceof ReviewedTariffConfigurationError &&
          error.code === 'conflict'
          ? 409
          : error instanceof ReviewedTariffConfigurationError &&
              error.code === 'restricted'
            ? 403
            : 400,
      );
    }
  });
  return app;
}
