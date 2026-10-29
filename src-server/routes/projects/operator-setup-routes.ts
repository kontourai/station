import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  OperatorSetupConflict,
  OperatorSetupService,
  operatorSetupPreviewSchema,
  operatorSetupRefusalMessage,
} from '../../services/projects/operator-setup-service.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import { createProjectSessionDirectoryResolver } from '../../services/projects/project-session-directory.js';
import { getBody, param, validate } from '../schemas/schemas.js';

export function createOperatorSetupRoutes(
  home: string,
  storage: IStorageAdapter,
  isCurrent: (request: Request) => boolean = isOperatorInPersonNotAgent,
) {
  const resolveDirectory = createProjectSessionDirectoryResolver(home, storage);
  const service = new OperatorSetupService(
    home,
    async (slug) => {
      const project = storage.getProject(slug);
      const cwd = await resolveDirectory(slug);
      if (!cwd || storage.getProject(slug).id !== project.id)
        throw new OperatorSetupConflict('execution_root_unavailable');
      return { projectId: project.id, cwd };
    },
    (slug) => storage.getProject(slug).id,
  );
  const app = new Hono();
  app.use('/:slug/operator-setup/*', async (c, next) => {
    if (!isOperatorInPersonNotAgent(c.req.raw) || !isCurrent(c.req.raw))
      return c.json(
        {
          success: false,
          error: 'Only the operator on this Station may review or run setup.',
        },
        403,
      );
    return next();
  });
  async function run(
    c: Context,
    action: (current: () => void) => Promise<unknown>,
  ) {
    const current = () => {
      if (
        c.req.raw.signal.aborted ||
        !isOperatorInPersonNotAgent(c.req.raw) ||
        !isCurrent(c.req.raw)
      )
        throw new OperatorSetupConflict('authority_ended');
    };
    try {
      current();
      const data = await action(current);
      current();
      return guardProjectResponse(c.json({ success: true, data }), async () => {
        try {
          current();
          return true;
        } catch {
          return false;
        }
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error:
            error instanceof OperatorSetupConflict
              ? operatorSetupRefusalMessage(error.code)
              : 'Setup could not be verified. Existing files were preserved; inspect the retained operation before retrying.',
        },
        error instanceof OperatorSetupConflict ? 409 : 503,
      );
    }
  }
  app.post(
    '/:slug/operator-setup/preview',
    validate(operatorSetupPreviewSchema),
    (c) =>
      run(c, (current) =>
        service.preview(param(c, 'slug'), getBody(c), current),
      ),
  );
  app.get('/:slug/operator-setup/:id', (c) =>
    run(c, (current) => service.get(param(c, 'slug'), param(c, 'id'), current)),
  );
  app.post(
    '/:slug/operator-setup/:id/run',
    validate(z.object({ authorize: z.literal(true) }).strict()),
    (c) =>
      run(c, (current) =>
        service.run(param(c, 'slug'), param(c, 'id'), current),
      ),
  );
  return app;
}
