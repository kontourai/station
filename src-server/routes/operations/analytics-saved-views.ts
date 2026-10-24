import {
  type AnalyticsViewDefinition,
  parseAnalyticsViewDefinition,
} from '@kontourai/station-contracts/analytics-views';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  AnalyticsSavedViews,
  SavedViewRejected,
} from '../../analytics/saved-views.js';
import { enrollmentOperationId } from '../../analytics/source-enrollment-protocol.js';
import type { EnrollmentActor } from '../../analytics/source-enrollment-store.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { requestFromPluginPane } from '../../security/plugin-pane-context.js';
import {
  AuthorityObservationRejected,
  type AuthorityObservationRequestContext,
  guardAuthorityObservationResponse,
} from '../../services/identity/authority-observation.js';

const definition = z.custom<AnalyticsViewDefinition>((value) => {
  try {
    parseAnalyticsViewDefinition(value);
    return true;
  } catch {
    return false;
  }
});
const revision = z.number().int().positive().refine(Number.isSafeInteger);
const create = z
  .object({ operationId: enrollmentOperationId, definition })
  .strict();
const update = z.object({ expectedRevision: revision, definition }).strict();
const remove = z.object({ expectedRevision: revision }).strict();
export function createAnalyticsSavedViewRoutes(deps: {
  store: AnalyticsSavedViews;
  capture(
    context: AuthorityObservationRequestContext,
  ): Promise<EnrollmentActor>;
}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (requestMayBeAnAgent(c.req.raw) || requestFromPluginPane(c.req.raw))
      return c.json({ error: { code: 'saved_view_person_required' } }, 403);
    await next();
  });
  app.onError((error, c) =>
    error instanceof SavedViewRejected ||
    error instanceof AuthorityObservationRejected
      ? c.json({ error: { code: error.code } }, error.status)
      : c.json({ error: { code: 'saved_view_unavailable' } }, 503),
  );
  const id = (value: string) => {
    if (!enrollmentOperationId.safeParse(value).success)
      throw new SavedViewRejected(400, 'saved_view_invalid');
    return value;
  };
  async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
    const raw = await readBoundedRequestBody(request, 8192);
    try {
      if (raw.status !== 'ok') throw new Error();
      return schema.parse(JSON.parse(raw.body));
    } catch {
      throw new SavedViewRejected(400, 'saved_view_invalid');
    }
  }
  app.get('/', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({ data: await deps.store.list(actor) }),
      actor.assertCurrent,
    );
  });
  app.get('/:id', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({ data: await deps.store.get(actor, id(c.req.param('id'))) }),
      actor.assertCurrent,
    );
  });
  app.get('/:id/export', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({ data: await deps.store.get(actor, id(c.req.param('id'))) }),
      actor.assertCurrent,
    );
  });
  app.post('/', async (c) => {
    const input = await body(c.req.raw, create);
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json(
        {
          data: await deps.store.create(
            actor,
            input.operationId,
            input.definition,
          ),
        },
        201,
      ),
      actor.assertCurrent,
    );
  });
  app.put('/:id', async (c) => {
    const input = await body(c.req.raw, update);
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({
        data: await deps.store.update(
          actor,
          id(c.req.param('id')),
          input.expectedRevision,
          input.definition,
        ),
      }),
      actor.assertCurrent,
    );
  });
  app.delete('/:id', async (c) => {
    const input = await body(c.req.raw, remove);
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({
        data: await deps.store.remove(
          actor,
          id(c.req.param('id')),
          input.expectedRevision,
        ),
      }),
      actor.assertCurrent,
    );
  });
  return app;
}
