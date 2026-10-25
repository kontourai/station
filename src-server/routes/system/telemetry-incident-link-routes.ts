import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { requestFromPluginPane } from '../../security/plugin-pane-context.js';
import {
  IncidentLinkRefused,
  type IncidentLinkScope,
  incidentLinkInput,
  incidentWindow,
  type TelemetryIncidentLinks,
} from '../../services/telemetry-incident-links.js';

export function createTelemetryIncidentLinkRoutes(deps: {
  store: TelemetryIncidentLinks;
  requireOperator(request: Request): Promise<void>;
  capture(
    request: Request,
    window: { from: string; to: string },
  ): Promise<IncidentLinkScope>;
}) {
  const app = new Hono();
  const requireIncidentOperator: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (requestMayBeAnAgent(c.req.raw) || requestFromPluginPane(c.req.raw))
      return c.json({ error: { code: 'operator_required' } }, 403);
    try {
      await deps.requireOperator(c.req.raw);
    } catch {
      return c.json({ error: { code: 'operator_required' } }, 403);
    }
    await next();
  };
  app.on(
    ['GET', 'POST'],
    '/product-incidents/:groupId/links',
    requireIncidentOperator,
  );
  app.on(
    'DELETE',
    '/product-incidents/:groupId/links/:linkId',
    requireIncidentOperator,
  );
  app.onError(async (error, c) => {
    try {
      await deps.requireOperator(c.req.raw);
    } catch {
      return c.json({ error: { code: 'operator_required' } }, 403);
    }
    return error instanceof IncidentLinkRefused
      ? c.json({ error: { code: error.code } }, error.status)
      : c.json({ error: { code: 'incident_links_unavailable' } }, 503);
  });
  async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
    const raw = await readBoundedRequestBody(request, 4096);
    if (raw.status !== 'ok')
      throw new IncidentLinkRefused(400, 'incident_link_invalid');
    try {
      return schema.parse(JSON.parse(raw.body));
    } catch {
      throw new IncidentLinkRefused(400, 'incident_link_invalid');
    }
  }
  app.get('/product-incidents/:groupId/links', async (c) => {
    const query = c.req.queries();
    if (
      Object.keys(query).some((key) => !['from', 'to'].includes(key)) ||
      query.from?.length !== 1 ||
      query.to?.length !== 1
    )
      throw new IncidentLinkRefused(400, 'incident_link_invalid');
    const parsed = incidentWindow.safeParse({
      from: query.from[0],
      to: query.to[0],
    });
    if (!parsed.success)
      throw new IncidentLinkRefused(400, 'incident_link_invalid');
    const scope = await deps.capture(c.req.raw, parsed.data);
    const data = await deps.store.list(scope, c.req.param('groupId'));
    await deps.requireOperator(c.req.raw);
    return c.json({ data });
  });
  app.post('/product-incidents/:groupId/links', async (c) => {
    const input = await body(c.req.raw, incidentLinkInput);
    const scope = await deps.capture(c.req.raw, input.window);
    const data = await deps.store.link(scope, c.req.param('groupId'), input);
    await deps.requireOperator(c.req.raw);
    return c.json({ data });
  });
  app.delete('/product-incidents/:groupId/links/:linkId', async (c) => {
    const input = await body(
      c.req.raw,
      z.object({ window: incidentWindow }).strict(),
    );
    const scope = await deps.capture(c.req.raw, input.window);
    const data = await deps.store.unlink(
      scope,
      c.req.param('groupId'),
      c.req.param('linkId'),
    );
    await deps.requireOperator(c.req.raw);
    return c.json({ data });
  });
  return app;
}
