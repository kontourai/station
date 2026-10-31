import {
  PROJECT_WORKING_CONFIGURATION_PREVIEW,
  type ProjectWorkingConfiguration,
  type ProjectWorkingConfigurationView,
} from '@kontourai/station-contracts/project-working-configuration';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import {
  ProjectWorkingConfigurationRefusal,
  type ProjectWorkingConfigurationService,
  projectWorkingApplySchema,
} from '../../services/projects/project-working-configuration.js';
import { errorMessage } from '../schemas/schemas.js';

export interface ProjectWorkingConfigurationAdmission {
  projectId: string;
  actorId: string;
  isCurrent(): boolean | Promise<boolean>;
}

/** The runtime supplies the canonical Project read/configuration authority. */
export function createProjectWorkingConfigurationRoutes(deps: {
  service: ProjectWorkingConfigurationService;
  enabled(): boolean;
  authorize(
    request: Request,
    slug: string,
    action: 'read' | 'configure',
  ): Promise<ProjectWorkingConfigurationAdmission | undefined>;
}) {
  const app = new Hono();
  const run = async (c: Context, action: 'read' | 'configure') => {
    if (!deps.enabled())
      return c.json(
        {
          success: false,
          error:
            'Enable Project working configuration in Settings → Advanced → Feature previews.',
          code: 'feature_preview_disabled',
          previewId: PROJECT_WORKING_CONFIGURATION_PREVIEW,
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
        },
        404,
      );
    const slug = c.req.param('slug');
    if (!slug)
      return c.json({ success: false, error: 'Project not found' }, 404);
    const admission = await deps.authorize(c.req.raw, slug, action);
    if (!admission)
      return c.json({ success: false, error: 'Project not found' }, 404);
    const isCurrent = async () =>
      !c.req.raw.signal.aborted &&
      deps.enabled() &&
      (await admission.isCurrent());
    try {
      if (!(await isCurrent()))
        return c.json({ success: false, error: 'Project not found' }, 404);
      let data: ProjectWorkingConfiguration | ProjectWorkingConfigurationView;
      if (action === 'configure') {
        const read = await readBoundedRequestBody(c.req.raw, 192 * 1024);
        if (read.status === 'too-large')
          return c.json(
            { success: false, error: 'Working configuration is too large.' },
            413,
          );
        if (read.status !== 'ok')
          return c.json(
            { success: false, error: 'Invalid working configuration.' },
            400,
          );
        const parsed = projectWorkingApplySchema.safeParse(
          JSON.parse(read.body),
        );
        if (!parsed.success)
          return c.json(
            { success: false, error: 'Invalid working configuration.' },
            400,
          );
        if (parsed.data.expectedProjectId !== admission.projectId)
          return c.json({ success: false, error: 'Project not found' }, 404);
        data = await deps.service.apply(
          slug,
          parsed.data,
          admission.actorId,
          isCurrent,
        );
      } else {
        data = await deps.service.discover(slug, isCurrent);
      }
      if (data.projectId !== admission.projectId)
        return c.json({ success: false, error: 'Project not found' }, 404);
      return guardProjectResponse(c.json({ success: true, data }), isCurrent);
    } catch (error) {
      if (error instanceof SyntaxError)
        return c.json(
          { success: false, error: 'Invalid working configuration.' },
          400,
        );
      if (error instanceof ProjectWorkingConfigurationRefusal)
        return c.json(
          { success: false, error: errorMessage(error), code: error.code },
          error.code === 'unavailable' ? 404 : 409,
        );
      return c.json(
        {
          success: false,
          error:
            'Project working configuration could not be read. Reload and inspect the repository.',
        },
        503,
      );
    }
  };
  app.get('/:slug/working-configuration', (c) => run(c, 'read'));
  app.put('/:slug/working-configuration', (c) => run(c, 'configure'));
  return app;
}
