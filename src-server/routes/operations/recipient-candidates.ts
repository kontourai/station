import { Hono } from 'hono';
import { recipientCandidateInput } from '../../analytics/recipient-candidate.js';
import {
  RecipientCandidateRejected,
  type RecipientStore,
} from '../../analytics/recipient-store.js';
import { sourceCredentialDeliverySchema } from '../../analytics/source-credential.js';
import type { EnrollmentActor } from '../../analytics/source-enrollment-store.js';
import { UsageExportRejected } from '../../analytics/usage-export-reader.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { requestFromPluginPane } from '../../security/plugin-pane-context.js';
import {
  AuthorityObservationRejected,
  type AuthorityObservationRequestContext,
  guardAuthorityObservationResponse,
} from '../../services/identity/authority-observation.js';

/** Receiving keys stay on this Station under the verified person; wire results remain candidates. */
export function createRecipientCandidateRoutes(deps: {
  store: RecipientStore;
  capture(
    context: AuthorityObservationRequestContext,
  ): Promise<EnrollmentActor>;
}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (requestMayBeAnAgent(c.req.raw) || requestFromPluginPane(c.req.raw))
      return c.json({ error: { code: 'recipient_person_required' } }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (
      error instanceof RecipientCandidateRejected ||
      error instanceof AuthorityObservationRejected ||
      error instanceof UsageExportRejected
    )
      return c.json({ error: { code: error.code } }, error.status);
    return c.json({ error: { code: 'recipient_candidate_unavailable' } }, 503);
  });
  app.get('/', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({ data: await deps.store.list(actor) }),
      actor.assertCurrent,
    );
  });
  app.post('/', async (c) => {
    const body = await readBoundedRequestBody(c.req.raw, 8192);
    let input: ReturnType<typeof recipientCandidateInput.parse>;
    try {
      if (body.status !== 'ok') throw new Error('Invalid body');
      input = recipientCandidateInput.parse(JSON.parse(body.body));
    } catch {
      return c.json({ error: { code: 'recipient_candidate_invalid' } }, 400);
    }
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({ data: await deps.store.prepare(actor, input) }),
      actor.assertCurrent,
    );
  });
  app.get('/:recipientId', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({ data: await deps.store.get(actor, c.req.param('recipientId')) }),
      actor.assertCurrent,
    );
  });
  app.post('/:recipientId/credentials', async (c) => {
    let delivery: ReturnType<typeof sourceCredentialDeliverySchema.parse>;
    try {
      const body = await readBoundedRequestBody(c.req.raw, 24 * 1024);
      if (body.status !== 'ok') throw new Error('Invalid body');
      delivery = sourceCredentialDeliverySchema.parse(JSON.parse(body.body));
    } catch {
      return c.json({ error: { code: 'recipient_candidate_invalid' } }, 400);
    }
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({
        data: await deps.store.materialize(
          actor,
          c.req.param('recipientId'),
          delivery,
        ),
      }),
      actor.assertCurrent,
    );
  });
  app.delete('/:recipientId', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req });
    return guardAuthorityObservationResponse(
      c.json({
        data: await deps.store.cancel(actor, c.req.param('recipientId')),
      }),
      actor.assertCurrent,
    );
  });
  return app;
}
