import { resolve } from 'node:path';
import { type Context, Hono, type Next } from 'hono';
import { z } from 'zod/v3';
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import {
  inspectPluginPublish,
  type PluginPublishRefusalCode,
  publishPlugin,
} from '../../services/projects/plugin-publish-service.js';
import { createLogger } from '../../utils/logger.js';
import {
  operatorOnly,
  type PluginPrincipalResolution,
} from '../plugins/plugin-identity-enumeration.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const publishRequestSchema = z
  .object({
    message: z.string().min(1).max(5000),
    remoteName: z.string().min(1).max(64),
    remoteUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();

/** One fixed sentence per refusal: the route never echoes git's output,
 * which can carry paths, hostnames or a credential helper's chatter. */
const REFUSAL_MESSAGES: Record<PluginPublishRefusalCode, string> = {
  'not-a-plugin':
    "The Project's folder has no plugin.json, so it is not a plugin",
  'invalid-manifest':
    "The Project's plugin.json is not a valid plugin manifest. Fix it before publishing",
  'nested-repository':
    "The Project's folder is inside another git repository. Publishing would push that whole repository, so move the plugin into a folder of its own first",
  'detached-head':
    'The folder is not on a branch (detached HEAD). Check out a branch, then publish',
  'invalid-remote-name':
    'Remote names are letters, digits, dots, hyphens and underscores, starting with a letter or digit',
  'invalid-message': 'Write a commit message (up to 5000 characters)',
  'remote-missing':
    'That remote does not exist here yet. Give its address to add it',
  'remote-mismatch':
    'A remote with that name already points somewhere else. Station does not change an existing remote: choose it as it is, or use a new name',
  empty: 'Give the remote address',
  'unsupported-transport':
    'Only https:// and SSH remotes can be published to. Local paths, file://, http:// and git remote helpers (such as ext::) are refused',
  'credentials-in-url':
    'The remote address contains a password or token. Remove it: Station pushes with this computer’s own git credentials',
  malformed: 'That is not a remote address Station can publish to',
  secrets:
    'Some files that would be committed look like secrets. Add them to .gitignore or remove them, then publish again',
  'too-many-changes':
    'More than 1000 files would be committed. Add build output and dependencies (such as node_modules) to .gitignore, then publish again',
  'nothing-to-publish':
    'There is nothing to publish: the folder has no files to commit',
  'push-rejected':
    'The remote has commits this folder does not. Station never force-pushes: bring those commits in (pull or merge) and publish again',
  'push-auth-failed':
    'The remote refused this computer’s git credentials. Check that you can push to it with git from this computer',
  'git-identity-missing':
    'git has no author name and email on this computer. Set user.name and user.email, then publish again',
  'git-timeout': 'git took too long and was stopped. Try again',
  'git-failed':
    'git could not complete the publish. The Station log has the details',
};

const CLIENT_REFUSALS = new Set<PluginPublishRefusalCode>([
  'invalid-remote-name',
  'invalid-message',
  'empty',
  'unsupported-transport',
  'credentials-in-url',
  'malformed',
]);

const logger = createLogger({ name: 'plugin-publish-routes' });

export interface PluginPublishRouteDeps {
  getWorkspacePath: (slug: string) => string | undefined;
  /**
   * The request's own principal. Required for the operator check; absent
   * means the composition serves no authenticated caller and both routes
   * refuse (`operatorOnly`'s contract).
   */
  visibility?: PluginPrincipalResolution;
}

/**
 * `/api/projects/:slug/plugin-publish` (epic #2323 S6).
 *
 * OPERATOR-ONLY, which is stricter than plugin authoring (any Project
 * member): publishing pushes to an external system with this computer's own
 * git credentials, so it is the host's owner's act. The read twin is gated
 * the same way, because what it reports (remote addresses, the file list)
 * exists only to drive that act.
 *
 * The folder is always the one the Project names; no request can point
 * this at another path.
 */
export function createPluginPublishRoutes(deps: PluginPublishRouteDeps) {
  const app = new Hono();
  // The operator check runs before body validation so a non-operator learns
  // nothing about the request shape either.
  const requireOperator =
    (what: string) =>
    (c: Context, next: Next): Response | Promise<Response> =>
      operatorOnly(
        deps.visibility,
        what,
      )(async () => {
        await next();
        return c.res;
      })(c);

  const folderFor = (c: Context): string | Response => {
    let slug: string;
    try {
      slug = param(c, 'slug');
      assertSafeLayoutPathSegment('project slug', slug);
    } catch {
      return c.json({ success: false, error: 'Invalid project slug' }, 400);
    }
    const configured = deps.getWorkspacePath(slug)?.trim();
    if (!configured) {
      return c.json(
        {
          success: false,
          error: 'This Project has no folder to publish',
          code: 'no-working-directory',
        },
        409,
      );
    }
    return resolve(configured);
  };

  app.get(
    '/',
    requireOperator('inspect a plugin for publishing'),
    async (c) => {
      const folder = folderFor(c);
      if (folder instanceof Response) return folder;
      try {
        return c.json({
          success: true,
          data: await inspectPluginPublish(folder),
        });
      } catch (error) {
        logger.warn('Plugin publish inspection failed', {
          project: param(c, 'slug'),
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          {
            success: false,
            error: REFUSAL_MESSAGES['git-failed'],
            code: 'git-failed',
          },
          500,
        );
      }
    },
  );

  app.post(
    '/',
    requireOperator('publish a plugin'),
    validate(publishRequestSchema, { maxBodyBytes: 16 * 1024 }),
    async (c) => {
      const folder = folderFor(c);
      if (folder instanceof Response) return folder;
      const body = getBody(c) as z.infer<typeof publishRequestSchema>;
      const outcome = await publishPlugin(folder, body, { logger });
      if (!outcome.ok) {
        const { code, secrets } = outcome.refusal;
        logger.info('Plugin publish refused', {
          project: param(c, 'slug'),
          code,
        });
        return c.json(
          {
            success: false,
            error: REFUSAL_MESSAGES[code],
            code,
            ...(secrets ? { secrets } : {}),
          },
          CLIENT_REFUSALS.has(code) ? 400 : 409,
        );
      }
      logger.info('Plugin published', {
        project: param(c, 'slug'),
        pluginName: outcome.result.plugin.name,
        branch: outcome.result.branch,
        committed: outcome.result.commit !== null,
      });
      return c.json({ success: true, data: outcome.result }, 201);
    },
  );

  return app;
}
