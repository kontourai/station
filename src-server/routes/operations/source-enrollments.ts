import type { UsageExportScope } from '@kontourai/station-contracts/usage-export';
import { Hono } from 'hono';
import {
  type EnrollmentActor,
  SourceEnrollmentRejected,
  type SourceEnrollmentStore,
  sourceEnrollmentInput,
} from '../../analytics/source-enrollment-store.js';
import { UsageExportRejected } from '../../analytics/usage-export-reader.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { requestFromPluginPane } from '../../security/plugin-pane-context.js';
import {
  AuthorityObservationRejected,
  type AuthorityObservationRequestContext,
  guardAuthorityObservationResponse,
} from '../../services/identity/authority-observation.js';

/** These endpoints save proposals; none accepts a credential or activates export. */
export function createSourceEnrollmentRoutes(deps: {
  store: SourceEnrollmentStore;
  capture(
    context: AuthorityObservationRequestContext,
    scope: UsageExportScope,
  ): Promise<EnrollmentActor>;
}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (requestMayBeAnAgent(c.req.raw) || requestFromPluginPane(c.req.raw))
      return c.json(
        { error: { code: 'source_enrollment_person_required' } },
        403,
      );
    await next();
  });
  app.onError((error, c) => {
    if (
      error instanceof SourceEnrollmentRejected ||
      error instanceof UsageExportRejected ||
      error instanceof AuthorityObservationRejected
    )
      return c.json({ error: { code: error.code } }, error.status);
    return c.json({ error: { code: 'source_enrollment_unavailable' } }, 503);
  });
  app.get('/', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req }, 'individual');
    return guardAuthorityObservationResponse(
      c.json({ data: await deps.store.list(actor) }),
      actor.assertCurrent,
    );
  });
  app.post('/', async (c) => {
    const body = await readBoundedRequestBody(c.req.raw, 4096);
    let input: ReturnType<typeof sourceEnrollmentInput.parse>;
    try {
      if (body.status !== 'ok') throw new Error('Invalid body');
      input = sourceEnrollmentInput.parse(JSON.parse(body.body));
    } catch {
      return c.json({ error: { code: 'source_enrollment_invalid' } }, 400);
    }
    const actor = await deps.capture({ env: c.env, req: c.req }, input.scope);
    return guardAuthorityObservationResponse(
      c.json({ data: await deps.store.prepare(actor, input) }),
      actor.assertCurrent,
    );
  });
  app.get('/:operationId', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req }, 'individual');
    return guardAuthorityObservationResponse(
      c.json({ data: await deps.store.get(actor, c.req.param('operationId')) }),
      actor.assertCurrent,
    );
  });
  app.delete('/:operationId', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req }, 'individual');
    return guardAuthorityObservationResponse(
      c.json({
        data: await deps.store.cancel(actor, c.req.param('operationId')),
      }),
      actor.assertCurrent,
    );
  });
  return app;
}
