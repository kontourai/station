import { resolve } from 'node:path';
import {
  buildPluginScaffold,
  PLUGIN_SCAFFOLD_TEMPLATES,
  type PluginScaffold,
  type PluginScaffoldDependencies,
  PluginScaffoldInputError,
} from '@kontourai/station-shared/plugin-scaffold';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import pluginScaffoldDependencies from '../../../config/plugin-scaffold-dependencies.json' with {
  type: 'json',
};
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import {
  inspectPluginScaffoldFolder,
  type PluginScaffoldWriteRefusal,
  writePluginScaffold,
} from '../../services/projects/plugin-scaffold-writer.js';
import type { ProjectService } from '../../services/projects/project-service.js';
import { createLogger } from '../../utils/logger.js';
import { expandTilde } from '../../utils/paths.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const pluginScaffoldRequestSchema = z
  .object({
    name: z.string().min(1).max(64),
    template: z.enum(PLUGIN_SCAFFOLD_TEMPLATES).optional(),
    displayName: z.string().max(128).optional(),
  })
  .strict();

const INPUT_REFUSAL_MESSAGES: Record<PluginScaffoldInputError['code'], string> =
  {
    'invalid-name':
      'Plugin name must be 1-64 lowercase letters, digits, hyphens or periods, starting and ending with a letter or digit',
    'invalid-template': `Unknown plugin template; expected ${PLUGIN_SCAFFOLD_TEMPLATES.join(', ')}`,
    'invalid-display-name':
      'Plugin title must be one line of visible text, at most 128 characters',
  };

const REFUSAL_MESSAGES: Record<PluginScaffoldWriteRefusal['code'], string> = {
  'working-directory-missing': "The Project's folder does not exist",
  'working-directory-not-a-directory': "The Project's folder is not a folder",
  'working-directory-not-empty':
    "The Project's folder is not empty. A new plugin needs an empty folder (a .git folder is fine)",
  'path-escapes-working-directory':
    "A scaffold file would land outside the Project's folder",
  'partial-scaffold':
    "Part of this plugin is already in the Project's folder from an earlier attempt. Open the Project to continue, or empty the folder and try again",
  'file-exists': 'A scaffold file appeared in the folder while writing',
};

const logger = createLogger({ name: 'plugin-scaffold-routes' });

/**
 * What a refusal may say about the folder. Any Project member may call this
 * route, and the folder is the operator's: a refusal must not become a way
 * to list it. So entries found in the folder are reported only as counts.
 * Paths named here come from the scaffold itself (its own file list), never
 * from what is on disk.
 */
function publicRefusalDetail(
  refusal: PluginScaffoldWriteRefusal,
): Record<string, unknown> {
  switch (refusal.code) {
    case 'working-directory-not-empty':
      return { entryCount: refusal.entryCount };
    case 'partial-scaffold':
      return {
        presentCount: refusal.present.length,
        missingCount: refusal.missingCount,
      };
    case 'path-escapes-working-directory':
      return { path: refusal.path };
    case 'file-exists':
      return { path: refusal.path, writtenCount: refusal.written.length };
    default:
      return {};
  }
}

export interface PluginScaffoldRouteDeps {
  dependencies?: PluginScaffoldDependencies;
  /**
   * Who is asking, for the audit line. Any Project member may scaffold into
   * an empty Project folder (owner decision, epic #2323), so the record
   * names the person, not just the Project.
   */
  requestPrincipalId?: (c: Context) => string | undefined;
}

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
  projectService: Pick<ProjectService, 'getProject' | 'workspaceIsolationFor'>,
  deps: PluginScaffoldRouteDeps = {},
) {
  const dependencies = deps.dependencies ?? pluginScaffoldDependencies;
  const principalOf = (c: Context): string => {
    try {
      return deps.requestPrincipalId?.(c) ?? 'unresolved';
    } catch {
      return 'unresolved';
    }
  };
  const app = new Hono();

  /**
   * Whether a plugin could be scaffolded into this Project's folder right
   * now. Read-only; it names no files and no path. The Project page offers
   * "Start a plugin in this folder" only when this says yes.
   */
  app.get('/', async (c) => {
    let slug: string;
    try {
      slug = param(c, 'slug');
      assertSafeLayoutPathSegment('project slug', slug);
    } catch {
      return c.json({ success: false, error: 'Invalid project slug' }, 400);
    }
    let workingDirectory: string | undefined;
    let isolation: 'shared' | 'worktree';
    try {
      isolation = await projectService.workspaceIsolationFor(slug);
      const configured = (
        await projectService.getProject(slug)
      ).workingDirectory?.trim();
      workingDirectory = configured
        ? resolve(expandTilde(configured))
        : undefined;
    } catch {
      return c.json({ success: false, error: 'Project not found' }, 404);
    }
    const answer = (reason?: string) =>
      c.json({
        success: true,
        data: reason ? { eligible: false, reason } : { eligible: true },
      });
    if (!workingDirectory) return answer('no-working-directory');
    if (isolation === 'worktree') return answer('worktree-isolation');
    const state = await inspectPluginScaffoldFolder(workingDirectory);
    if (state === 'occupied') return answer('working-directory-not-empty');
    if (state !== 'empty') return answer(state);
    return answer();
  });

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
          // A fixed sentence per code, never the thrown text: a route answer
          // states only what this module wrote down.
          return c.json(
            {
              success: false,
              error: INPUT_REFUSAL_MESSAGES[error.code],
              code: error.code,
            },
            400,
          );
        }
        throw error;
      }

      let workingDirectory: string | undefined;
      let isolation: 'shared' | 'worktree';
      try {
        isolation = await projectService.workspaceIsolationFor(slug);
        // Stored verbatim (`~/...` included), so expand at the read.
        const configured = (
          await projectService.getProject(slug)
        ).workingDirectory?.trim();
        workingDirectory = configured
          ? resolve(expandTilde(configured))
          : undefined;
      } catch {
        return c.json({ success: false, error: 'Project not found' }, 404);
      }
      if (!workingDirectory) {
        return c.json(
          {
            success: false,
            error: 'This Project has no folder to write the plugin into',
            code: 'no-working-directory',
          },
          409,
        );
      }

      // Under worktree isolation each chat runs in its own checkout, which
      // never holds these uncommitted files: the Agent the flow hands off to
      // would be told the scaffold exists and find nothing. Refused up
      // front with the fix, rather than written where no chat can see it.
      if (isolation === 'worktree') {
        return c.json(
          {
            success: false,
            error:
              "This Project's chats run in separate worktrees, so an Agent would not see the new plugin's files. Set the Project's workspace isolation to Shared, then try again",
            code: 'worktree-isolation',
          },
          409,
        );
      }

      const result = await writePluginScaffold(
        workingDirectory,
        scaffold.files,
      );
      if (!result.ok) {
        const { code } = result.refusal;
        logger.info('Plugin scaffold refused', {
          project: slug,
          pluginName: scaffold.name,
          code,
          principal: principalOf(c),
        });
        return c.json(
          {
            success: false,
            error: REFUSAL_MESSAGES[code],
            code,
            ...publicRefusalDetail(result.refusal),
          },
          409,
        );
      }
      logger.info('Plugin scaffold written', {
        project: slug,
        pluginName: scaffold.name,
        template: scaffold.template,
        files: result.written.length,
        alreadyPresent: result.alreadyPresent,
        principal: principalOf(c),
      });
      // Relative paths only: the Project read already discloses its folder,
      // and this answer has no reason to repeat it. A retry into a folder
      // that already holds exactly this scaffold is the same success, so a
      // lost answer never strands the person.
      return c.json(
        {
          success: true,
          data: {
            name: scaffold.name,
            template: scaffold.template,
            displayName: scaffold.displayName,
            files: result.alreadyPresent
              ? scaffold.files.map((file) => file.path)
              : result.written,
            alreadyPresent: result.alreadyPresent,
          },
        },
        result.alreadyPresent ? 200 : 201,
      );
    },
  );

  return app;
}
