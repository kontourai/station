import { resolve } from 'node:path';
import {
  buildPluginScaffold,
  PLUGIN_SCAFFOLD_TEMPLATES,
  type PluginScaffold,
  type PluginScaffoldDependencies,
  PluginScaffoldInputError,
} from '@kontourai/station-shared/plugin-scaffold';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import pluginScaffoldDependencies from '../../../config/plugin-scaffold-dependencies.json' with {
  type: 'json',
};
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import {
  type PluginScaffoldWriteRefusal,
  writePluginScaffold,
} from '../../services/projects/plugin-scaffold-writer.js';
import type { ProjectService } from '../../services/projects/project-service.js';
import { expandTilde } from '../../utils/paths.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const pluginScaffoldRequestSchema = z
  .object({
    name: z.string().min(1).max(64),
    template: z.enum(PLUGIN_SCAFFOLD_TEMPLATES).optional(),
    displayName: z.string().max(128).optional(),
  })
  .strict();

const REFUSAL_MESSAGES: Record<PluginScaffoldWriteRefusal['code'], string> = {
  'working-directory-missing': "The Project's folder does not exist",
  'working-directory-not-a-directory': "The Project's folder is not a folder",
  'working-directory-not-empty':
    "The Project's folder is not empty. A new plugin needs an empty folder (a .git folder is fine)",
  'path-escapes-working-directory':
    "A scaffold file would land outside the Project's folder",
  'file-exists': 'A scaffold file appeared in the folder while writing',
};

/**
 * `POST /api/projects/:slug/plugin-scaffold`: writes a starter plugin into
 * the Project's own folder.
 *
 * Authority is the `/api/projects/:slug/*` family's, unchanged: the pairing
 * scope table maps this leaf to the family operate tier, and the runtime's
 * project guard applies to it like every sibling. The route writes only
 * inside the folder the Project already names, only when that folder is
 * empty, and never overwrites. It installs nothing: installing stays with a
 * person through the existing preview and consent path.
 */
export function createPluginScaffoldRoutes(
  projectService: Pick<ProjectService, 'getProject'>,
  dependencies: PluginScaffoldDependencies = pluginScaffoldDependencies,
) {
  const app = new Hono();

  app.post(
    '/',
    validate(pluginScaffoldRequestSchema, { maxBodyBytes: 4096 }),
    async (c) => {
      let slug: string;
      try {
        slug = param(c, 'slug');
        assertSafeLayoutPathSegment('project slug', slug);
      } catch {
        return c.json({ success: false, error: 'Invalid project slug' }, 400);
      }
      const body = getBody(c) as z.infer<typeof pluginScaffoldRequestSchema>;

      let scaffold: PluginScaffold;
      try {
        scaffold = buildPluginScaffold({
          name: body.name,
          template: body.template,
          displayName: body.displayName,
          dependencies,
        });
      } catch (error) {
        if (error instanceof PluginScaffoldInputError) {
          return c.json(
            { success: false, error: error.message, code: error.code },
            400,
          );
        }
        throw error;
      }

      let configured: string | undefined;
      try {
        configured = (await projectService.getProject(slug)).workingDirectory;
      } catch {
        return c.json({ success: false, error: 'Project not found' }, 404);
      }
      if (!configured?.trim()) {
        return c.json(
          {
            success: false,
            error: 'This Project has no folder to write the plugin into',
            code: 'no-working-directory',
          },
          409,
        );
      }

      const result = await writePluginScaffold(
        resolve(expandTilde(configured.trim())),
        scaffold.files,
      );
      if (!result.ok) {
        const { code, ...detail } = result.refusal;
        return c.json(
          {
            success: false,
            error: REFUSAL_MESSAGES[code],
            code,
            ...detail,
          },
          409,
        );
      }
      // Relative paths only: the Project read already discloses its folder,
      // and this answer has no reason to repeat it.
      return c.json(
        {
          success: true,
          data: {
            name: scaffold.name,
            template: scaffold.template,
            displayName: scaffold.displayName,
            files: result.written,
          },
        },
        201,
      );
    },
  );

  return app;
}
