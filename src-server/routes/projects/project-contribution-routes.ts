import { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../domain/project-file-transactions.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { ProjectContributionService } from '../../services/projects/project-contribution-service.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import { getBody, validate } from '../schemas/schemas.js';

const querySchema = z
  .object({
    portableProjectId: z.string().min(1),
    resourceId: z.string().min(1),
  })
  .strict();
const offerSchema = z
  .object({
    portableProjectId: z.string().min(1),
    localProjectId: z.string().min(1),
    resourceId: z.string().min(1),
    expected: z.record(z.string(), z.unknown()).nullable(),
    enabled: z.boolean(),
  })
  .strict();

export function delegationContributionQueryAuthorized(
  request: Request,
  deps: {
    current(request: Request): boolean;
    identify(credential: string): { id: string; kind: string } | null;
  },
): boolean {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (
    principal?.authority !== 'device-credential' ||
    !principal.deviceId ||
    !deps.current(request)
  )
    return false;
  const device = deps.identify(principal.credential);
  return device?.id === principal.deviceId && device.kind === 'delegation';
}

export function createProjectContributionRoutes(
  service: ProjectContributionService,
  authority: {
    canManage(request: Request): boolean;
    canQuery(request: Request): boolean;
  },
) {
  const app = new Hono();
  app.put('/offer', validate(offerSchema), async (c) => {
    if (!authority.canManage(c.req.raw))
      return c.json({ success: false, error: 'Forbidden' }, 403);
    try {
      return c.json({
        success: true,
        data: await service.setExecutionOffer(getBody(c), () =>
          authority.canManage(c.req.raw),
        ),
      });
    } catch (error) {
      if (error instanceof FileStorageConflictError)
        return c.json(
          { success: false, error: 'Project execution offer changed.' },
          409,
        );
      if (error instanceof FileStorageNotFoundError)
        return c.json(
          { success: false, error: 'Project contribution is unavailable.' },
          404,
        );
      throw error;
    }
  });
  app.post('/query', validate(querySchema), async (c) => {
    if (!authority.canQuery(c.req.raw))
      return c.json({ success: false, error: 'Forbidden' }, 403);
    try {
      const projection = await service.query(getBody(c), () =>
        authority.canQuery(c.req.raw),
      );
      // The projection is released through the EXISTING project-response
      // guard, the same boundary every other Project-family read uses: it
      // rechecks the current delegation credential BEFORE the first byte
      // and before every queued chunk, and forces `Cache-Control: no-store`.
      // The service's own post-resolver check is an admission decision, not
      // the release boundary — a credential revoked while the projection sat
      // ready must not reach the wire through ANY outcome branch
      // (contributing, contributed-unavailable, disabled,
      // nothing-contributed).
      return guardProjectResponse(
        c.json({ success: true, data: projection }),
        async () => authority.canQuery(c.req.raw),
      );
    } catch (error) {
      if (error instanceof FileStorageConflictError)
        return c.json(
          { success: false, error: 'Query authority changed.' },
          403,
        );
      throw error;
    }
  });
  return app;
}
