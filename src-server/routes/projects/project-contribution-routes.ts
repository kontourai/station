import { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../domain/project-file-transactions.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { ProjectContributionService } from '../../services/projects/project-contribution-service.js';
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
        data: await service.setExecutionOffer(getBody(c)),
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
    return c.json({ success: true, data: await service.query(getBody(c)) });
  });
  return app;
}
