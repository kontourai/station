import { isDeepStrictEqual } from 'node:util';
import type { ProjectS3Source } from '@kontourai/station-contracts/project';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { listAwsProfiles } from '../../providers/llm/aws-profiles.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  type ProjectS3Authority,
  ProjectS3SourceError,
  type ProjectS3Sources,
  projectS3SourcesEnabled,
} from '../../services/projects/project-s3-sources.js';
import { errorMessage } from '../schemas/schemas.js';

interface Dependencies {
  service: ProjectS3Sources;
  admit: (
    request: Request,
    slug: string,
    manage: boolean,
  ) => Promise<ProjectS3Authority & { projectId: string; actorId: string }>;
  canManage: (request: Request) => boolean;
  guard: (
    request: Request,
    projectId: string,
    sources: readonly ProjectS3Source[],
    response: Response,
  ) => Promise<Response>;
}
const attachSchema = z
  .object({
    id: z.string().uuid(),
    expectedProjectId: z.string().min(1),
    displayName: z.string(),
    accountId: z.string(),
    region: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    profile: z.string(),
    shareWithProject: z.literal(true),
  })
  .strict();

export function createProjectS3SourceRoutes(deps: Dependencies) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/s3-sources/capabilities', (c) =>
    c.json({
      success: true,
      data: {
        enabled: projectS3SourcesEnabled(),
        canManage: projectS3SourcesEnabled() && deps.canManage(c.req.raw),
      },
    }),
  );
  app.use('/s3-sources/*', async (c, next) => {
    if (!projectS3SourcesEnabled())
      return c.json(
        {
          success: false,
          error: 'S3 sources are disabled pending verification.',
        },
        404,
      );
    await next();
  });
  app.get('/s3-sources/profiles', async (c) => {
    if (!deps.canManage(c.req.raw))
      return c.json({ success: false, error: 'Operator required.' }, 403);
    const profiles = await listAwsProfiles();
    if (!deps.canManage(c.req.raw))
      return c.json({ success: false, error: 'Operator required.' }, 403);
    return c.json({ success: true, data: profiles });
  });
  const body = async (c: Context) => {
    const read = await readBoundedRequestBody(c.req.raw, 16 * 1024);
    if (read.status !== 'ok')
      throw new ProjectS3SourceError(
        'Invalid or oversized source request.',
        400,
      );
    return JSON.parse(read.body);
  };
  const failure = (c: Context, error: unknown) => {
    if (error instanceof ProjectS3SourceError)
      return c.json(
        { success: false, error: errorMessage(error) },
        error.status,
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json(
        { success: false, error: 'Invalid S3 source selection.' },
        400,
      );
    return c.json({ success: false, error: 'S3 source unavailable.' }, 503);
  };
  const source = (c: Context, projectId: string) => {
    const id = z.string().uuid().parse(c.req.param('sourceId'));
    const selected = deps.service.get(id);
    if (!selected || selected.projectId !== projectId)
      throw new ProjectS3SourceError('S3 source not found.', 404);
    return selected;
  };
  app.get('/s3-sources/projects/:projectSlug', async (c) => {
    try {
      const authority = await deps.admit(
        c.req.raw,
        c.req.param('projectSlug'),
        false,
      );
      const sources = deps.service.list(authority.projectId);
      return deps.guard(
        c.req.raw,
        authority.projectId,
        sources,
        c.json({ success: true, data: sources }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post('/s3-sources/projects/:projectSlug', async (c) => {
    try {
      const authority = await deps.admit(
        c.req.raw,
        c.req.param('projectSlug'),
        true,
      );
      const input = attachSchema.parse(await body(c));
      if (input.expectedProjectId !== authority.projectId)
        throw new ProjectS3SourceError(
          'Project changed. Refresh the source selection.',
          409,
        );
      const {
        expectedProjectId,
        shareWithProject: _shareWithProject,
        ...selection
      } = input;
      const selected = await deps.service.attach(
        { ...selection, projectId: expectedProjectId },
        authority.actorId,
        authority,
      );
      return deps.guard(
        c.req.raw,
        authority.projectId,
        [selected],
        c.json({ success: true, data: selected }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post(
    '/s3-sources/projects/:projectSlug/:sourceId/disconnect',
    async (c) => {
      try {
        const authority = await deps.admit(
          c.req.raw,
          c.req.param('projectSlug'),
          true,
        );
        const selected = source(c, authority.projectId);
        const input = z
          .object({ expectedSource: z.unknown() })
          .strict()
          .parse(await body(c));
        if (!isDeepStrictEqual(input.expectedSource, selected))
          throw new ProjectS3SourceError(
            'Source changed. Refresh before disconnecting.',
            409,
          );
        await deps.service.disconnect(selected, authority);
        authority.assertCurrent();
        return c.json({ success: true, data: { disconnected: true } });
      } catch (error) {
        return failure(c, error);
      }
    },
  );
  app.get('/s3-sources/projects/:projectSlug/:sourceId/objects', async (c) => {
    try {
      const authority = await deps.admit(
        c.req.raw,
        c.req.param('projectSlug'),
        false,
      );
      const selected = source(c, authority.projectId);
      const page = await deps.service.objects(
        selected,
        c.req.query('cursor'),
        authority,
      );
      return deps.guard(
        c.req.raw,
        authority.projectId,
        [selected],
        c.json({ success: true, data: page }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get('/s3-sources/projects/:projectSlug/:sourceId/object', async (c) => {
    try {
      const authority = await deps.admit(
        c.req.raw,
        c.req.param('projectSlug'),
        false,
      );
      const selected = source(c, authority.projectId);
      const input = z
        .object({
          key: z.string().min(1).max(1024),
          etag: z.string().min(1).max(200),
        })
        .parse(c.req.query());
      const result = await deps.service.read(selected, input, authority);
      return deps.guard(
        c.req.raw,
        authority.projectId,
        [selected],
        c.json({ success: true, data: result }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  return app;
}
