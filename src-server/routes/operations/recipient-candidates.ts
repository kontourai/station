import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod/v3';
import {
  PrivateUsageClientRejected,
  type PrivateUsageTarget,
} from '../../analytics/private-usage-client.js';
import { recipientCandidateInput } from '../../analytics/recipient-candidate.js';
import { recipientSourceReadInput } from '../../analytics/recipient-source-read.js';
import {
  RecipientCandidateRejected,
  type RecipientStore,
  recipientSyncInput,
} from '../../analytics/recipient-store.js';
import { sourceCredentialDeliverySchema } from '../../analytics/source-credential.js';
import type { EnrollmentActor } from '../../analytics/source-enrollment-store.js';
import { UsageExportRejected } from '../../analytics/usage-export-reader.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { requestFromPluginPane } from '../../security/plugin-pane-context.js';
import { browserVisibleHost } from '../../security/runtime-request-security.js';
import {
  CONSENT_SESSION_COOKIE,
  type ConsentChannelService,
} from '../../services/consent/consent-channel.js';
import { ConsentCommitRefusedError } from '../../services/consent/consent-transactions.js';
import {
  AuthorityObservationRejected,
  type AuthorityObservationRequestContext,
  guardAuthorityObservationResponse,
} from '../../services/identity/authority-observation.js';

/** Receiving keys stay on this Station under the verified person; wire results remain candidates. */
export function createRecipientCandidateRoutes(deps: {
  store: RecipientStore;
  channel?: ConsentChannelService;
  captureSyncTarget?(
    request: Request,
    assertPerson: () => Promise<void>,
  ): Promise<PrivateUsageTarget>;
  capture(
    context: AuthorityObservationRequestContext,
  ): Promise<EnrollmentActor>;
}) {
  const app = new Hono();
  const partition = (actor: EnrollmentActor) =>
    `analytics-receiver:${createHash('sha256')
      .update(
        JSON.stringify([
          actor.sourceStationId,
          actor.userId,
          actor.mode,
          actor.tenantId,
        ]),
      )
      .digest('hex')}`;

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (requestMayBeAnAgent(c.req.raw) || requestFromPluginPane(c.req.raw))
      return c.json({ error: { code: 'recipient_person_required' } }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (
      error instanceof PrivateUsageClientRejected ||
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
  app.post('/:recipientId/source-confirmation', async (c) => {
    const channel = deps.channel;
    if (!channel)
      return c.json(
        { error: { code: 'recipient_candidate_unavailable' } },
        503,
      );
    const body = await readBoundedRequestBody(c.req.raw, 1024);
    try {
      if (body.status !== 'ok') throw new Error('Invalid body');
      z.object({}).strict().parse(JSON.parse(body.body));
    } catch {
      return c.json({ error: { code: 'recipient_candidate_invalid' } }, 400);
    }
    const actor = await deps.capture({ env: c.env, req: c.req });
    const recipientId = c.req.param('recipientId');
    const review = await deps.store.reviewSource(actor, recipientId);
    const scope = partition(actor);
    const host = browserVisibleHost({
      environment: c.env,
      header: (name) => c.req.header(name),
    });
    const prospective = channel.reviewUrlFor(host, recipientId, scope);
    if (
      !host ||
      !prospective ||
      new URL(prospective).hostname !== new URL(`http://${host}`).hostname
    )
      return c.json(
        { error: { code: 'recipient_candidate_unavailable' } },
        503,
      );
    const target = {
      kind: 'analytics-source-transport',
      subject: recipientId,
      fingerprint: review.fingerprint,
    };
    let id = '';
    const created = channel.store.create({
      tenantId: scope,
      decisionPolicy: 'requester-session',
      target,
      requester: { kind: 'verified-person', id: actor.userId },
      rateKey: actor.userId,
      ttlMs: 300_000,
      description: {
        title: 'Confirm your analytics source address?',
        summary:
          'Permit this receiving Station to send its narrow analytics credential only to this HTTPS source address.',
        items: [
          { label: 'Receiving person', detail: actor.userId },
          { label: 'Source address', detail: review.origin },
          { label: 'Expected source Station', detail: review.sourceStationId },
          { label: 'Usage scope', detail: review.scope },
          { label: 'Expiry', detail: review.expiresAt },
        ],
        warning:
          'Open this HTTPS address as your source Station and check its identity before approving. A supplied address or encrypted envelope alone does not authenticate the source. No provider or operator credential is shared.',
        approveLabel: 'Confirm this source address',
        denyLabel: 'Deny',
      },
      revalidateTarget: async () => {
        try {
          const current = await deps.store.reviewSource(actor, recipientId);
          return { ...target, fingerprint: current.fingerprint };
        } catch {
          throw new ConsentCommitRefusedError(
            'Source credential or receiving person changed. Nothing was enabled.',
            false,
          );
        }
      },
      commitApproval: async () => {
        try {
          await deps.store.confirmSource(
            actor,
            recipientId,
            review.fingerprint,
            id,
          );
        } catch {
          throw new ConsentCommitRefusedError(
            'Source credential or receiving person changed. Nothing was enabled.',
            false,
          );
        }
      },
    });
    if (!created.ok)
      return c.json(
        { error: { code: 'recipient_candidate_unavailable' } },
        503,
      );
    id = created.transaction.id;
    const secret = channel.store.decisionSessionSecretFor(scope, id);
    if (!secret)
      return c.json(
        { error: { code: 'recipient_candidate_unavailable' } },
        503,
      );
    setCookie(c, CONSENT_SESSION_COOKIE, secret, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/consent',
      maxAge: 300,
    });
    return guardAuthorityObservationResponse(
      c.json({
        approval: {
          id,
          status: created.transaction.status,
          reviewUrl: channel.reviewUrlFor(host, id, scope),
        },
      }),
      actor.assertCurrent,
    );
  });
  app.get(
    '/:recipientId/source-confirmation/requests/:requestId',
    async (c) => {
      const actor = await deps.capture({ env: c.env, req: c.req });
      const transaction = deps.channel?.store.get(
        partition(actor),
        c.req.param('requestId'),
      );
      if (
        transaction?.target.kind !== 'analytics-source-transport' ||
        transaction.target.subject !== c.req.param('recipientId')
      )
        return c.json(
          { error: { code: 'recipient_candidate_not_found' } },
          404,
        );
      return guardAuthorityObservationResponse(
        c.json({
          approval: { id: transaction.id, status: transaction.status },
        }),
        actor.assertCurrent,
      );
    },
  );
  app.post('/:recipientId/sync', async (c) => {
    if (!deps.captureSyncTarget)
      return c.json({ error: { code: 'private_usage_unavailable' } }, 503);
    const body = await readBoundedRequestBody(c.req.raw, 2048);
    let input: ReturnType<typeof recipientSyncInput.parse>;
    try {
      if (body.status !== 'ok') throw new Error('Invalid body');
      input = recipientSyncInput.parse(JSON.parse(body.body));
    } catch {
      return c.json({ error: { code: 'recipient_candidate_invalid' } }, 400);
    }
    const actor = await deps.capture({ env: c.env, req: c.req });
    await deps.store.get(actor, c.req.param('recipientId'));
    const target = await deps.captureSyncTarget(c.req.raw, actor.assertCurrent);
    const result = await deps.store.syncPage(
      actor,
      c.req.param('recipientId'),
      input,
      target,
      c.req.raw.signal,
    );
    return guardAuthorityObservationResponse(
      c.json({ data: result }),
      actor.assertCurrent,
    );
  });
  app.post('/:recipientId/read', async (c) => {
    const body = await readBoundedRequestBody(c.req.raw, 8192);
    let query: z.infer<typeof recipientSourceReadInput>;
    try {
      if (body.status !== 'ok') throw new Error('Invalid body');
      query = recipientSourceReadInput.parse(JSON.parse(body.body));
    } catch {
      return c.json({ error: { code: 'recipient_candidate_invalid' } }, 400);
    }
    const actor = await deps.capture({ env: c.env, req: c.req });
    const selected = await deps.store.readSourcePage(
      actor,
      c.req.param('recipientId'),
      query,
      c.req.raw.signal,
    );
    return guardAuthorityObservationResponse(
      c.json({ data: selected.page }),
      selected.assertCurrent,
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
