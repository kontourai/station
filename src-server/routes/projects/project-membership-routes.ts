import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../domain/project-file-transactions.js';
import type {
  ProjectMembershipAuthority,
  ProjectMembershipService,
} from '../../services/projects/project-membership-service.js';
import { ProjectMembershipRefusal } from '../../services/projects/project-membership-store.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import { createLogger } from '../../utils/logger.js';

const scopeSchema = z
  .object({
    stationId: z.string().min(1).max(512),
    localProjectId: z.string().min(1).max(512),
    localProjectSlug: z.string().min(1).max(128),
    portableProjectId: z.string().min(1).max(512),
  })
  .strict();
const roleSchema = z.enum(['viewer', 'contributor', 'admin']);
/**
 * Caller-captured mutation intent: the principal id the page was rendered
 * for. The service compares it against freshly authenticated authority
 * before committing; a client claim grants nothing. Optional so existing
 * operator callers keep working unchanged.
 */
const intentSchema = z
  .object({ expectedActor: z.string().min(1).max(2048).optional() })
  .strict();
const logger = createLogger({ name: 'project-membership-routes' });
class ProjectAccessBodyTooLarge extends Error {}

async function membershipBody(c: Context): Promise<unknown> {
  // Runtime admission has already bounded and authenticated this Request.
  // A second body-limit middleware would replace it and discard that identity.
  const text = await c.req.text();
  if (Buffer.byteLength(text, 'utf8') > 16 * 1024)
    throw new ProjectAccessBodyTooLarge();
  return JSON.parse(text);
}

/**
 * Delivery admission for a response the service check already authorized.
 *
 * The service check authorizes the EFFECT (or the read); the guard below
 * authorizes DELIVERY — `guardProjectResponse` re-resolves a FRESH
 * authority before the first byte and before every queued chunk, comparing
 * the captured actor id and the exact captured Project scope against
 * current management authority. A `c.json` after the service check is NOT
 * delivery guarding: an invitation created before its inviter's revocation
 * would otherwise still release its token afterwards.
 *
 * - `management: true` (the `GET .../access` administration view, the
 *   `POST .../invitations` token response, the operator-only `enable`
 *   view): the same principal must still hold `manage-members` on the
 *   unchanged Project incarnation at release time.
 * - `management: false` (contentless `{ changed: true }` for `members`,
 *   `invitations/:id/revoke`, `transfer`): an authorized self-demotion or
 *   self-revocation removes the actor's own `manage-members`, so the guard
 *   retains only the current credential/actor comparison and the
 *   exact-scope incarnation comparison — no old permission, no protected
 *   content in the payload.
 *
 * The mutation runs exactly once, before the guard; a guard refusal never
 * retries the committed effect. Each recheck is a short fresh read — no
 * store mutex is held through response consumption.
 */
interface DeliveryAdmission {
  scope: ProjectMembershipScope;
  principalId: string;
  management: boolean;
}

/** Member administration only. Existing personal/device admission and current member authority both apply. */
export function createProjectMembershipRoutes(
  service: ProjectMembershipService | undefined,
  authority: (request: Request) => ProjectMembershipAuthority,
  invitationOrigin?: string,
) {
  const app = new Hono();
  async function perform<T>(
    c: Context,
    operation: (
      owner: ProjectMembershipService,
      access: ProjectMembershipAuthority,
    ) => Promise<T>,
    release?: (data: T) => DeliveryAdmission | undefined,
  ) {
    c.header('Cache-Control', 'no-store');
    if (!service)
      return c.json({ error: { code: 'project_sharing_unavailable' } }, 501);
    try {
      const data = await operation(service, authority(c.req.raw));
      const admission = release?.(data);
      // The delivery descriptor is transport-internal: strip it so the
      // captured scope and actor id never ship in the API payload.
      const payload =
        admission &&
        typeof data === 'object' &&
        data !== null &&
        'guard' in data
          ? (({ guard: _deliveryGuard, ...rest }) => rest)(
              data as { guard: unknown },
            )
          : data;
      if (!admission) return c.json({ success: true, data: payload });
      return await guardProjectResponse(
        c.json({ success: true, data: payload }),
        async () => {
          // FRESH per check — resolved anew before the first byte and every
          // queued chunk, never the mutation-time authority object.
          const fresh = authority(c.req.raw);
          return admission.management
            ? service.currentManagementAdmission(
                admission.scope,
                fresh,
                admission.principalId,
              )
            : service.currentScopeAdmission(
                admission.scope,
                fresh,
                admission.principalId,
              );
        },
      );
    } catch (error) {
      if (error instanceof ProjectAccessBodyTooLarge)
        return c.json({ error: { code: 'request_body_too_large' } }, 413);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json(
          { error: { code: 'invalid_project_access_request' } },
          400,
        );
      if (error instanceof ProjectMembershipRefusal)
        return c.json(
          { error: { code: `project_access_${error.code}` } },
          error.code === 'forbidden'
            ? 403
            : error.code === 'unavailable'
              ? 503
              : 409,
        );
      if (
        error instanceof FileStorageConflictError ||
        error instanceof FileStorageNotFoundError
      )
        return c.json({ error: { code: 'project_access_conflict' } }, 409);
      logger.error('Project access operation unavailable', { error });
      return c.json({ error: { code: 'project_access_unavailable' } }, 503);
    }
  }
  const scoped = (c: Context, scope: z.infer<typeof scopeSchema>) => {
    if (c.req.param('slug') !== scope.localProjectSlug)
      throw new ProjectMembershipRefusal('conflict');
    return scope;
  };
  const managementRelease = (
    scope: ProjectMembershipScope,
    principalId: string,
  ): DeliveryAdmission => ({ scope, principalId, management: true });
  const acknowledgementRelease = (
    scope: ProjectMembershipScope,
    principalId: string,
  ): DeliveryAdmission => ({ scope, principalId, management: false });
  app.get('/:slug/access', (c) =>
    perform(
      c,
      async (owner, access) => ({
        ...(await owner.administration(c.req.param('slug'), access)),
        ...(invitationOrigin ? { invitationOrigin } : {}),
      }),
      (data) => managementRelease(data.scope, data.actingPrincipal.id),
    ),
  );
  app.post('/:slug/access/enable', (c) =>
    perform(
      c,
      async (owner, access) => {
        const body = z
          .object({ localProjectId: z.string().min(1).max(512) })
          .strict()
          .parse(await membershipBody(c));
        return {
          ...(await owner.enable(
            c.req.param('slug'),
            body.localProjectId,
            access,
          )),
          ...(invitationOrigin ? { invitationOrigin } : {}),
        };
      },
      (data) => managementRelease(data.scope, data.actingPrincipal.id),
    ),
  );
  app.post('/:slug/access/invitations', (c) =>
    perform(
      c,
      async (owner, access) => {
        const body = z
          .object({
            scope: scopeSchema,
            email: z.string().email().max(320).nullable(),
            role: roleSchema,
            expiresAt: z.string().datetime(),
          })
          .strict()
          .merge(intentSchema)
          .parse(await membershipBody(c));
        const scope = structuredClone(scoped(c, body.scope));
        const actor = await access.current();
        const data = await owner.invite(
          scope,
          {
            email: body.email,
            role: body.role,
            expiresAt: body.expiresAt,
          },
          access,
          {
            expectedActorId: body.expectedActor,
          },
        );
        return { ...data, guard: managementRelease(scope, actor.principal.id) };
      },
      (data) => data.guard,
    ),
  );
  app.post('/:slug/access/invitations/:invitationId/revoke', (c) =>
    perform(
      c,
      async (owner, access) => {
        const body = z
          .object({ scope: scopeSchema })
          .strict()
          .merge(intentSchema)
          .parse(await membershipBody(c));
        const scope = structuredClone(scoped(c, body.scope));
        const actor = await access.current();
        const data = await owner.revokeInvitation(
          scope,
          c.req.param('invitationId'),
          access,
          { expectedActorId: body.expectedActor },
        );
        return {
          ...data,
          guard: acknowledgementRelease(scope, actor.principal.id),
        };
      },
      (data) => data.guard,
    ),
  );
  app.post('/:slug/access/members', (c) =>
    perform(
      c,
      async (owner, access) => {
        const body = z
          .object({
            scope: scopeSchema,
            principalId: z.string().min(1).max(2048),
            revision: z.number().int().positive(),
            role: roleSchema,
            status: z.enum(['active', 'revoked']),
          })
          .strict()
          .merge(intentSchema)
          .parse(await membershipBody(c));
        const scope = structuredClone(scoped(c, body.scope));
        const actor = await access.current();
        const data = await owner.changeMember(
          scope,
          body.principalId,
          body.revision,
          { role: body.role, status: body.status },
          access,
          { expectedActorId: body.expectedActor },
        );
        return {
          ...data,
          guard: acknowledgementRelease(scope, actor.principal.id),
        };
      },
      (data) => data.guard,
    ),
  );
  app.post('/:slug/access/transfer', (c) =>
    perform(
      c,
      async (owner, access) => {
        const body = z
          .object({
            scope: scopeSchema,
            recipientId: z.string().min(1).max(2048),
          })
          .strict()
          .merge(intentSchema)
          .parse(await membershipBody(c));
        const scope = structuredClone(scoped(c, body.scope));
        const actor = await access.current();
        const data = await owner.transferOwnership(
          scope,
          body.recipientId,
          access,
          { expectedActorId: body.expectedActor },
        );
        return {
          ...data,
          guard: acknowledgementRelease(scope, actor.principal.id),
        };
      },
      (data) => data.guard,
    ),
  );
  return app;
}
