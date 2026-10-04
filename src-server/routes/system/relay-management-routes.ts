import { encodeNativeRelayLink } from '@kontourai/station-connect/native-relay-link';
import type { RelayManagementView } from '@kontourai/station-contracts/relay-management';
import {
  formatStationConnectionKeyConfirmationCode,
  stationConnectionKeyConfirmationCode,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { Hono } from 'hono';
import { z } from 'zod';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  NativeSurfaceOperatorAuthority,
  type NativeSurfaceRegistry,
} from '../../services/connections/native-surface-registry.js';
import type { RelayInvitationOwner } from '../../services/connections/relay-invitation-owner.js';
import { guardAccountResponse } from '../../services/identity/account-response-guard.js';
import type { NativeRelayEnrollmentService } from '../../services/identity/native-relay-enrollment-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';

const approveSchema = z.object({ prepare: z.unknown() }).strict();
const invitationSchema = z
  .object({
    prepare: z.unknown(),
    lifetime: z.enum(['5m', '15m', '1h', '24h', 'never']),
    devScheme: z.string().max(128).optional(),
  })
  .strict();
const durations = {
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '24h': 86_400_000,
  never: null,
} as const;

export function createRelayManagementRoutes(deps: {
  owner: RelayInvitationOwner;
  registry: NativeSurfaceRegistry;
  enrollment?: NativeRelayEnrollmentService;
  isManager(request: Request): boolean;
  recordDecision?(request: Request, operation: string, subject: string): void;
}) {
  const app = new Hono();
  const authority = new NativeSurfaceOperatorAuthority();
  app.get('/capabilities', (c) =>
    c.json(
      { data: { canManage: deps.isManager(c.req.raw), configured: true } },
      200,
      { 'Cache-Control': 'no-store' },
    ),
  );
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.isManager(c.req.raw))
      return c.json({ error: { code: 'relay_management_required' } }, 403);
    await next();
    c.res = await guardAccountResponse(c.res, async () =>
      deps.isManager(c.req.raw) ? 'current' : 'invalid',
    );
  });
  app.get('/', async (c) => {
    try {
      const { route, trust } = await deps.owner.describe(
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
      );
      const link = (channel: 'stable' | 'beta' | 'nightly') =>
        encodeNativeRelayLink(
          {
            version: 'station-native-relay-link/v1',
            kind: 'route-intent',
            ...route,
          },
          { channel },
        );
      const view: RelayManagementView = {
        route,
        keyId: await stationConnectionSigningKeyId(trust),
        confirmationCode: formatStationConnectionKeyConfirmationCode(
          await stationConnectionKeyConfirmationCode(trust),
        ),
        setupLinks: {
          stable: link('stable'),
          beta: link('beta'),
          nightly: link('nightly'),
        },
        approvals: deps.registry
          .approvedSurfaces()
          .map(({ approvalId, revision, scope, surface }) => ({
            approvalId,
            revision,
            scope,
            surface,
          })),
        pendingDevices: deps.enrollment?.pendingApprovals(c.req.raw) ?? [],
      };
      return c.json({ data: view });
    } catch {
      return c.json({ error: { code: 'relay_unavailable' } }, 503);
    }
  });
  app.post('/approvals', async (c) => {
    try {
      const body = await readBoundedRequestBody(c.req.raw, 16 * 1024);
      if (body.status !== 'ok')
        return c.json({ error: { code: 'invalid_request' } }, 400);
      const { prepare } = approveSchema.parse(JSON.parse(body.body));
      const tuple = await deps.owner.prepare(prepare);
      await deps.owner.describe(
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
      );
      if (!deps.isManager(c.req.raw))
        return c.json({ error: { code: 'relay_management_required' } }, 403);
      deps.recordDecision?.(
        c.req.raw,
        'approve-setup',
        tuple.surface.clientInstanceId,
      );
      const result = deps.registry.approve(
        authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', tuple),
      );
      return c.json({
        data: {
          approvalId: result.approvalId,
          revision: result.revision,
          scope: result.scope,
          surface: result.surface,
        },
      });
    } catch (error) {
      return c.json(
        {
          error: {
            code:
              error instanceof z.ZodError || error instanceof SyntaxError
                ? 'invalid_request'
                : 'approval_unavailable',
          },
        },
        400,
      );
    }
  });
  app.post('/approvals/revoke', async (c) => {
    try {
      const bounded = await readBoundedRequestBody(c.req.raw, 4096);
      if (bounded.status !== 'ok')
        return c.json({ error: { code: 'invalid_request' } }, 400);
      const input = z
        .object({
          approvalId: z.string().uuid(),
          expectedRevision: z.number().int().positive(),
        })
        .strict()
        .parse(JSON.parse(bounded.body));
      const approved = deps.registry
        .approvedSurfaces()
        .find((entry) => entry.approvalId === input.approvalId);
      if (
        !approved ||
        approved.revision !== input.expectedRevision ||
        !approved.isCurrent()
      )
        return c.json({ error: { code: 'approval_changed' } }, 409);
      if (!deps.isManager(c.req.raw))
        return c.json({ error: { code: 'relay_management_required' } }, 403);
      deps.recordDecision?.(c.req.raw, 'revoke-setup', approved.approvalId);
      deps.registry.revoke(
        authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'revoke', {
          scope: approved.scope,
          surface: approved.surface,
        }),
      );
      return c.json({ data: { state: 'revoked' } });
    } catch {
      return c.json({ error: { code: 'revocation_unavailable' } }, 409);
    }
  });
  app.post('/invitations', async (c) => {
    let issued = false;
    try {
      const body = await readBoundedRequestBody(c.req.raw, 16 * 1024);
      if (body.status !== 'ok')
        return c.json({ error: { code: 'invalid_request' } }, 400);
      const input = invitationSchema.parse(JSON.parse(body.body));
      const tuple = await deps.owner.prepare(input.prepare);
      const approved = deps.registry
        .approvedSurfaces()
        .find(
          (entry) =>
            entry.scope.stationId === tuple.scope.stationId &&
            entry.scope.enrollmentId === tuple.scope.enrollmentId &&
            entry.scope.routingGeneration === tuple.scope.routingGeneration &&
            entry.surface.appIdentifier === tuple.surface.appIdentifier &&
            entry.surface.channel === tuple.surface.channel &&
            entry.surface.clientInstanceId === tuple.surface.clientInstanceId &&
            entry.surface.keyThumbprint === tuple.surface.keyThumbprint,
        );
      if (!approved?.isCurrent())
        return c.json({ error: { code: 'setup_approval_required' } }, 409);
      const options = {
        channel: tuple.surface.channel,
        ...(input.devScheme ? { devScheme: input.devScheme } : {}),
      };
      // Refuse an unsupported scheme before issuing a one-time invitation.
      const { route } = await deps.owner.describe(
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
      );
      encodeNativeRelayLink(
        {
          version: 'station-native-relay-link/v1',
          kind: 'route-intent',
          ...route,
        },
        options,
      );
      if (!approved.isCurrent() || !deps.isManager(c.req.raw))
        return c.json({ error: { code: 'relay_management_required' } }, 403);
      deps.recordDecision?.(
        c.req.raw,
        'create-invitation',
        tuple.surface.clientInstanceId,
      );
      issued = true;
      const invitation = await deps.owner.issueNativeInvitation(
        input.prepare,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
        durations[input.lifetime],
      );
      if (!approved.isCurrent() || !deps.isManager(c.req.raw))
        return c.json(
          { error: { code: 'invitation_delivery_uncertain' } },
          409,
        );
      const link = encodeNativeRelayLink(
        {
          version: 'station-native-relay-link/v1',
          kind: 'bound-invitation',
          applicationOrigin: route.applicationOrigin,
          invitation,
        },
        options,
      );
      return c.json({ data: { link, expiresAt: invitation.expiresAt } });
    } catch (error) {
      return c.json(
        {
          error: {
            code: issued
              ? 'invitation_delivery_uncertain'
              : error instanceof z.ZodError || error instanceof SyntaxError
                ? 'invalid_request'
                : 'invitation_unavailable',
          },
        },
        issued ? 409 : 400,
      );
    }
  });
  app.post('/devices/:enrollmentId/approve', async (c) => {
    if (!deps.enrollment)
      return c.json({ error: { code: 'enrollment_unavailable' } }, 503);
    try {
      const body = await readBoundedRequestBody(c.req.raw, 4096);
      if (body.status !== 'ok')
        return c.json({ error: { code: 'invalid_request' } }, 400);
      const input = z
        .object({ candidate: z.unknown() })
        .strict()
        .parse(JSON.parse(body.body));
      deps.recordDecision?.(
        c.req.raw,
        'approve-device',
        c.req.param('enrollmentId'),
      );
      await deps.enrollment.approve(
        c.req.raw,
        c.req.param('enrollmentId'),
        input.candidate,
      );
      return c.json({ data: { state: 'approved' } });
    } catch {
      return c.json({ error: { code: 'device_approval_unavailable' } }, 409);
    }
  });
  app.post('/devices/:enrollmentId/deny', async (c) => {
    if (!deps.enrollment)
      return c.json({ error: { code: 'enrollment_unavailable' } }, 503);
    try {
      const body = await readBoundedRequestBody(c.req.raw, 4096);
      if (body.status !== 'ok')
        return c.json({ error: { code: 'invalid_request' } }, 400);
      const input = z
        .object({ candidate: z.unknown() })
        .strict()
        .parse(JSON.parse(body.body));
      deps.recordDecision?.(
        c.req.raw,
        'deny-device',
        c.req.param('enrollmentId'),
      );
      await deps.enrollment.deny(
        c.req.raw,
        c.req.param('enrollmentId'),
        input.candidate,
      );
      return c.json({ data: { state: 'cancelled' } });
    } catch {
      return c.json({ error: { code: 'device_denial_unavailable' } }, 409);
    }
  });
  return app;
}
