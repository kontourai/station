import { createHash } from 'node:crypto';
import type { UsageExportScope } from '@kontourai/station-contracts/usage-export';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { recipientConfirmationCode } from '../../analytics/recipient-candidate.js';
import {
  SourceEnrollmentRejected,
  type SourceEnrollmentStore,
} from '../../analytics/source-enrollment-store.js';
import {
  type SourceApprovalActor,
  SourceApprovalRejected,
  type SourceGrantApprovalStore,
  sourceApprovalInput,
  sourceApprovalTarget,
  sourceCredentialRotationInput,
} from '../../analytics/source-grant-store.js';
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

export function createSourceGrantApprovalRoutes(deps: {
  channel: ConsentChannelService;
  enrollments: SourceEnrollmentStore;
  approvals: SourceGrantApprovalStore;
  capture(
    context: AuthorityObservationRequestContext,
    scope: UsageExportScope,
  ): Promise<SourceApprovalActor>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const partition = (actor: SourceApprovalActor) =>
    `analytics:${createHash('sha256')
      .update(
        JSON.stringify([
          actor.sourceStationId,
          actor.userId,
          actor.mode,
          actor.tenantId,
        ]),
      )
      .digest('hex')}`;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (requestMayBeAnAgent(c.req.raw) || requestFromPluginPane(c.req.raw))
      return c.json(
        { error: { code: 'source_approval_person_required' } },
        403,
      );
    await next();
  });
  app.onError((error, c) => {
    if (
      error instanceof SourceApprovalRejected ||
      error instanceof SourceEnrollmentRejected ||
      error instanceof UsageExportRejected ||
      error instanceof AuthorityObservationRejected
    )
      return c.json({ error: { code: error.code } }, error.status);
    return c.json({ error: { code: 'source_approval_unavailable' } }, 503);
  });
  app.post('/', async (c) => {
    let input: ReturnType<typeof sourceApprovalInput.parse>;
    try {
      const body = await readBoundedRequestBody(c.req.raw, 16 * 1024);
      if (body.status !== 'ok') throw new Error('Invalid body');
      input = sourceApprovalInput.parse(JSON.parse(body.body));
    } catch {
      return c.json({ error: { code: 'source_approval_invalid' } }, 400);
    }
    const requestContext = { env: c.env, req: c.req };
    const reader = await deps.capture(requestContext, 'individual');
    const proposed = await deps.enrollments.get(
      reader,
      input.sourceOperationId,
    );
    const actor = await deps.capture(requestContext, proposed.scope);
    const intent = await deps.enrollments.forApproval(
      actor,
      proposed.operationId,
    );
    const fingerprint = sourceApprovalTarget(actor, intent, input, now());
    const scope = partition(actor);
    const host = browserVisibleHost({
      environment: c.env,
      header: (name) => c.req.header(name),
    });
    if (deps.channel.reviewUrlFor(host, input.operationId, scope) === null)
      return c.json({ error: { code: 'source_approval_unavailable' } }, 503);
    const prospectiveReview = deps.channel.reviewUrlFor(
      host,
      input.operationId,
      scope,
    );
    if (
      !prospectiveReview ||
      !host ||
      new URL(prospectiveReview).hostname !== new URL(`http://${host}`).hostname
    )
      return c.json({ error: { code: 'source_approval_unavailable' } }, 503);
    const existing = await deps.approvals.get(
      actor,
      input.operationId,
      fingerprint,
    );
    if (existing)
      return guardAuthorityObservationResponse(
        c.json({ data: existing }),
        actor.assertCurrent,
      );
    const target = {
      kind: 'analytics-source-export',
      subject: input.operationId,
      fingerprint,
    };
    let id = '';
    const created = deps.channel.store.create({
      tenantId: scope,
      decisionPolicy: 'requester-session',
      target,
      requester: { kind: 'verified-person', id: actor.userId },
      rateKey: actor.approvalCredentialId,
      ttlMs: Math.min(
        300_000,
        input.recipientCandidate.claims.expiresAt - now(),
        Date.parse(intent.expiresAt) - now(),
      ),
      description: {
        title: 'Approve a personal analytics source?',
        summary:
          'Approve this exact usage scope and receiving key. No source credential or synchronization is activated yet.',
        items: [
          { label: 'Source person', detail: actor.userId },
          { label: 'Source Station', detail: actor.sourceStationId },
          {
            label: 'Scope',
            detail: `${intent.scope}; ${actor.ownerIds.length} source owners`,
          },
          {
            label: 'Receiving Station',
            detail: `${intent.proposedDestination.stationId} at ${intent.proposedDestination.origin}`,
          },
          {
            label: 'Receiving person claim',
            detail: input.recipientCandidate.claims.recipientPrincipalId,
          },
          {
            label: 'Receiving key',
            detail: input.recipientCandidate.claims.proofKey.x,
          },
          {
            label: 'Confirmation code',
            detail: recipientConfirmationCode(input.recipientCandidate),
          },
          { label: 'Expiry', detail: intent.expiresAt },
          {
            label: 'Retention choice',
            detail:
              intent.retention.mode === 'live-mirror'
                ? 'Live mirror'
                : `Retained copy for ${intent.retention.days} days`,
          },
        ],
        warning:
          'A self-signed key is not remote identity authentication. Compare the receiving key with the authenticated receiving Station before approving. Installation and telemetry disclosure remain separate.',
        approveLabel: 'Approve this source and key',
        denyLabel: 'Deny',
      },
      revalidateTarget: async () => {
        try {
          await actor.assertCurrent();
          const current = await deps.enrollments.forApproval(
            actor,
            input.sourceOperationId,
          );
          if (await deps.approvals.get(actor, input.operationId)) return null;
          return {
            ...target,
            fingerprint: sourceApprovalTarget(actor, current, input, now()),
          };
        } catch (error) {
          if (error instanceof SourceEnrollmentRejected && error.status === 409)
            return null;
          throw new ConsentCommitRefusedError(
            'Source access or receiving-key eligibility could not be revalidated. Nothing was granted.',
            false,
          );
        }
      },
      guardDecision: (apply) => deps.enrollments.guardApproval(actor, apply),
      commitApproval: async () => {
        try {
          await deps.approvals.approve(
            actor,
            await deps.enrollments.forApproval(actor, input.sourceOperationId),
            input,
            id,
          );
        } catch {
          throw new ConsentCommitRefusedError(
            'The source, person or receiving key is no longer eligible. Nothing was activated.',
            false,
          );
        }
      },
    });
    if (!created.ok)
      return c.json({ error: { code: 'source_approval_unavailable' } }, 503);
    id = created.transaction.id;
    const secret = deps.channel.store.decisionSessionSecretFor(scope, id);
    if (!secret)
      return c.json({ error: { code: 'source_approval_unavailable' } }, 503);
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
          reviewUrl: deps.channel.reviewUrlFor(host, id, scope),
        },
      }),
      actor.assertCurrent,
    );
  });
  app.get('/requests/:id', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req }, 'individual');
    const transaction = deps.channel.store.get(
      partition(actor),
      c.req.param('id'),
    );
    if (transaction?.target.kind !== 'analytics-source-export')
      return c.json({ error: { code: 'source_approval_not_found' } }, 404);
    return guardAuthorityObservationResponse(
      c.json({
        approval: { id: transaction.id, status: transaction.status },
        data: await deps.approvals.get(actor, transaction.target.subject),
      }),
      actor.assertCurrent,
    );
  });
  app.post('/:operationId/delivery', async (c) => {
    const context = { env: c.env, req: c.req };
    const reader = await deps.capture(context, 'individual');
    const approval = await deps.approvals.get(
      reader,
      c.req.param('operationId'),
    );
    if (!approval)
      return c.json({ error: { code: 'source_approval_not_found' } }, 404);
    const actor = await deps.capture(context, approval.scope);
    return guardAuthorityObservationResponse(
      c.json({
        data: await deps.approvals.prepareDelivery(actor, approval.operationId),
      }),
      actor.assertCurrent,
    );
  });
  app.post('/:operationId/rotate', async (c) => {
    const body = await readBoundedRequestBody(c.req.raw, 1024);
    let rotation: ReturnType<typeof sourceCredentialRotationInput.parse>;
    try {
      if (body.status !== 'ok') throw new Error('Invalid body');
      rotation = sourceCredentialRotationInput.parse(JSON.parse(body.body));
    } catch {
      return c.json({ error: { code: 'source_approval_invalid' } }, 400);
    }
    const context = { env: c.env, req: c.req };
    const reader = await deps.capture(context, 'individual');
    const approval = await deps.approvals.get(
      reader,
      c.req.param('operationId'),
    );
    if (!approval)
      return c.json({ error: { code: 'source_approval_not_found' } }, 404);
    const actor = await deps.capture(context, approval.scope);
    return guardAuthorityObservationResponse(
      c.json({
        data: await deps.approvals.prepareDelivery(
          actor,
          approval.operationId,
          rotation,
        ),
      }),
      actor.assertCurrent,
    );
  });
  app.get('/:operationId', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req }, 'individual');
    const approval = await deps.approvals.get(
      actor,
      c.req.param('operationId'),
    );
    if (!approval)
      return c.json({ error: { code: 'source_approval_not_found' } }, 404);
    return guardAuthorityObservationResponse(
      c.json({ data: approval }),
      actor.assertCurrent,
    );
  });
  app.delete('/:operationId', async (c) => {
    const actor = await deps.capture({ env: c.env, req: c.req }, 'individual');
    return guardAuthorityObservationResponse(
      c.json({
        data: await deps.approvals.revoke(actor, c.req.param('operationId')),
      }),
      actor.assertCurrent,
    );
  });
  return app;
}
