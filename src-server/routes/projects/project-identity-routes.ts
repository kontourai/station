import type {
  ProjectAttachResult,
  ProjectIdentityView,
} from '@kontourai/station-contracts/project-identity';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
  ProjectIdentityNotPreparedError,
} from '../../domain/project-file-transactions.js';
import { ProjectIdentityValidationError } from '../../domain/project-identity-record.js';
import { InvalidPathSegmentError } from '../../knowledge-index/path-safety.js';
import type { ProjectIdentityService } from '../../services/projects/project-identity-service.js';
import { createLogger } from '../../utils/logger.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const logger = createLogger({ name: 'project-identity-routes' });
const attachSchema = z
  .object({
    name: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    workingDirectory: z.string().optional(),
    identity: z.unknown(),
  })
  .strict();
const executionRootMutationSchema = z
  .object({
    expectedIdentity: z.record(z.string(), z.unknown()),
    expectedLocalProjectId: z.string().min(1),
    executionRoot: z
      .object({ repoId: z.string(), path: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

/** Mounted under the existing Project read/write authorization boundary. */
export function createProjectIdentityRoutes(
  service: ProjectIdentityService | undefined,
) {
  const app = new Hono();
  async function run(
    c: Context,
    action: (
      service: ProjectIdentityService,
    ) => Promise<ProjectIdentityView | ProjectAttachResult>,
  ) {
    if (!service)
      return c.json(
        {
          success: false,
          error: 'Portable Project identity is unavailable on this server.',
        },
        501,
      );
    try {
      const data = await action(service);
      return c.json(
        { success: true, data },
        'outcome' in data && data.outcome === 'created' ? 201 : 200,
      );
    } catch (error) {
      if (error instanceof ProjectIdentityValidationError)
        return c.json(
          {
            success: false,
            error:
              'Project identity is invalid or uses unsupported resource fields.',
            code: error.code,
          },
          400,
        );
      if (error instanceof InvalidPathSegmentError)
        return c.json(
          {
            success: false,
            error: 'The local Project slug must be a single safe path segment.',
          },
          400,
        );
      if (error instanceof FileStorageConflictError)
        return c.json(
          {
            success: false,
            error:
              'Project state changed or conflicts with this attachment. Inspect the current Project before retrying.',
            code: error.code,
          },
          409,
        );
      // Subclass first: a VERIFIED not-prepared Project (found, no identity
      // record) carries the discriminated seam code, while a removed Project
      // falls through to the generic 404 below. Clients must only offer
      // prepare guidance on the discriminated code — never on a bare 404,
      // which also covers old servers without this endpoint and proxies.
      if (error instanceof ProjectIdentityNotPreparedError)
        return c.json(
          {
            success: false,
            error:
              'This Project has no prepared portable identity. Prepare it explicitly before placing it elsewhere.',
            code: error.code,
          },
          404,
        );
      if (error instanceof FileStorageNotFoundError)
        return c.json(
          {
            success: false,
            error: 'Project identity was not found.',
            code: error.code,
          },
          404,
        );
      logger.error('Portable Project identity operation failed', { error });
      return c.json(
        {
          success: false,
          error: 'Project identity storage or verification is unavailable.',
        },
        503,
      );
    }
  }
  app.get('/:slug/identity', (c) =>
    run(c, (owner) => owner.read(param(c, 'slug'))),
  );
  app.post('/:slug/identity/prepare', (c) =>
    run(c, (owner) => owner.prepare(param(c, 'slug'))),
  );
  app.put(
    '/:slug/identity/execution-root',
    validate(executionRootMutationSchema),
    (c) => {
      const input: z.infer<typeof executionRootMutationSchema> = getBody(c);
      return run(c, (owner) =>
        owner.updateExecutionRoot(param(c, 'slug'), input),
      );
    },
  );
  app.post('/attach', validate(attachSchema), (c) => {
    const input: z.infer<typeof attachSchema> = getBody(c);
    return run(c, (owner) =>
      owner.attach({ ...input, identity: input.identity }),
    );
  });
  return app;
}
