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
  ) {
    c.header('Cache-Control', 'no-store');
    if (!service)
      return c.json({ error: { code: 'project_sharing_unavailable' } }, 501);
    try {
      return c.json({
        success: true,
        data: await operation(service, authority(c.req.raw)),
      });
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
  app.get('/:slug/access', (c) =>
    perform(c, async (owner, access) => ({
      ...(await owner.administration(c.req.param('slug'), access)),
      ...(invitationOrigin ? { invitationOrigin } : {}),
    })),
  );
  app.post('/:slug/access/enable', (c) =>
    perform(c, async (owner, access) => {
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
    }),
  );
  app.post('/:slug/access/invitations', (c) =>
    perform(c, async (owner, access) => {
      const body = z
        .object({
          scope: scopeSchema,
          email: z.string().email().max(320).nullable(),
          role: roleSchema,
          expiresAt: z.string().datetime(),
        })
        .strict()
        .parse(await membershipBody(c));
      return owner.invite(scoped(c, body.scope), body, access);
    }),
  );
  app.post('/:slug/access/invitations/:invitationId/revoke', (c) =>
    perform(c, async (owner, access) => {
      const body = z
        .object({ scope: scopeSchema })
        .strict()
        .parse(await membershipBody(c));
      return owner.revokeInvitation(
        scoped(c, body.scope),
        c.req.param('invitationId'),
        access,
      );
    }),
  );
  app.post('/:slug/access/members', (c) =>
    perform(c, async (owner, access) => {
      const body = z
        .object({
          scope: scopeSchema,
          principalId: z.string().min(1).max(2048),
          revision: z.number().int().positive(),
          role: roleSchema,
          status: z.enum(['active', 'revoked']),
        })
        .strict()
        .parse(await membershipBody(c));
      return owner.changeMember(
        scoped(c, body.scope),
        body.principalId,
        body.revision,
        { role: body.role, status: body.status },
        access,
      );
    }),
  );
  app.post('/:slug/access/transfer', (c) =>
    perform(c, async (owner, access) => {
      const body = z
        .object({
          scope: scopeSchema,
          recipientId: z.string().min(1).max(2048),
        })
        .strict()
        .parse(await membershipBody(c));
      return owner.transferOwnership(
        scoped(c, body.scope),
        body.recipientId,
        access,
      );
    }),
  );
  return app;
}
