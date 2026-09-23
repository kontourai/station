import { resolve } from 'node:path';
import { type Context, Hono, type Next } from 'hono';
import { z } from 'zod/v3';
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import {
  inspectPluginPublish,
  type PluginPublishRefusalCode,
  publishPlugin,
  summarizePluginPublish,
} from '../../services/projects/plugin-publish-service.js';
import { createLogger } from '../../utils/logger.js';
import {
  operatorOnly,
  type PluginPrincipalResolution,
} from '../plugins/plugin-identity-enumeration.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const publishRequestSchema = z
  .object({
    remoteUrl: z.string().min(1).max(2048),
    branch: z.string().min(1).max(200),
    message: z.string().min(1).max(5000),
  })
  .strict();

/** One fixed sentence per refusal: the route never echoes git's output,
 * which can carry paths, hostnames or a credential helper's chatter. */
const REFUSAL_MESSAGES: Record<PluginPublishRefusalCode, string> = {
  'not-a-plugin':
    "The Project's folder has no plugin.json, so it is not a plugin",
  'invalid-manifest':
    "The Project's plugin.json is not a valid plugin manifest. Fix it before publishing",
  'folder-unreadable':
    "Station could not read the Project's folder. Check that it exists and is a folder",
  'unsafe-path':
    'Some file or folder names cannot be published safely (control characters, names git reserves, or names that are not valid text). Rename them (they are listed), then publish again',
  'linked-file':
    'Some files have other hard links, so their content may live outside this folder. Replace them with plain copies (they are listed), then publish again',
  'folder-changed':
    'The folder changed while Station was reading it (a file or folder was replaced or turned into a link). Nothing was published. Try again once it is settled',
  'too-many-files':
    'More than 1000 files would be published, or the folders nest too deeply. Add build output and dependencies (such as node_modules) to .gitignore, then publish again',
  'too-large':
    'The files to publish add up to more than 50 MB. Add build output and large assets to .gitignore, then publish again',
  secrets:
    'Some files that would be published look like secrets. Add them to .gitignore or remove them, then publish again',
  'filter-attributes':
    'A .gitattributes file assigns a git filter (such as Git LFS). Station publishes the files as they are on disk and cannot run filters, so it will not publish this folder (the files are listed)',
  'nothing-to-publish': 'There is nothing to publish: the folder has no files',
  'invalid-branch':
    'Branch names are letters, digits, dots, hyphens, underscores and slashes, starting with a letter or digit',
  'invalid-message': 'Write a commit message (up to 5000 characters)',
  empty: 'Give the repository address',
  'unsupported-transport':
    'Only https:// and SSH repository addresses can be published to. Local paths, file://, http:// and git remote helpers (such as ext::) are refused',
  'credentials-in-url':
    'The address contains a password or token. Remove it: Station pushes with this computer’s own git credentials',
  'local-host':
    'That address is on this computer or a local-only address. Publish to a git host other people can reach',
  malformed: 'That is not a repository address Station can publish to',
  'git-identity-missing':
    'git has no name and email on this computer. Set user.name and user.email in your global git config, then publish again',
  'remote-moved':
    'The branch on the remote changed while publishing, so nothing was pushed. Publish again to build on its new tip',
  'remote-auth-failed':
    'The remote refused this computer’s git credentials. Check that you can push to it with git from this computer',
  'remote-unreachable':
    'Station could not reach that repository. Check the address, and that it exists',
  'git-timeout': 'git took too long and was stopped. Try again',
  'git-failed':
    'git could not complete the publish. The Station log has the details',
};

const CLIENT_REFUSALS = new Set<PluginPublishRefusalCode>([
  'invalid-branch',
  'invalid-message',
  'empty',
  'unsupported-transport',
  'credentials-in-url',
  'malformed',
  'local-host',
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
  /**
   * TEST ONLY: let git use its `file` transport, so a test's global
   * `insteadOf` can route an https remote to a bare repository on disk.
   * Construction throws outside Vitest, so production cannot enable it.
   */
  testOnlyAllowFileTransport?: true;
}

/**
 * `/api/projects/:slug/plugin-publish` (#2374, epic #2323 S6).
 *
 * OPERATOR-ONLY, which is stricter than plugin authoring (any Project
 * member): publishing pushes to an external system with this computer's own
 * git credentials, so it is the host's owner's act. The read twin is gated
 * the same way, because what it reports (the file list) exists only to drive
 * that act.
 *
 * The folder is always the one the Project names; no request can point this
 * at another path. Nothing here runs git in that folder or reads its `.git`.
 */
export function createPluginPublishRoutes(deps: PluginPublishRouteDeps) {
  if (deps.testOnlyAllowFileTransport && process.env.VITEST !== 'true') {
    throw new Error(
      'testOnlyAllowFileTransport is for tests and cannot be enabled here',
    );
  }
  const serviceOptions = {
    allowFileProtocol: deps.testOnlyAllowFileTransport === true,
  };
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
        // `?view=summary` is what the Project page asks on mount: is this
        // folder a plugin? It reads plugin.json and runs no git at all. The
        // full view walks the folder and runs git only in Station's own
        // temporary repository (for `.gitignore`), never in the folder.
        if (c.req.query('view') === 'summary') {
          return c.json({
            success: true,
            data: await summarizePluginPublish(folder),
          });
        }
        const data = await inspectPluginPublish(folder, serviceOptions);
        // A refusal as the folder stands carries the same sentence a publish
        // would answer with.
        const refusal =
          data.plugin && data.refusal
            ? {
                ...data.refusal,
                message: REFUSAL_MESSAGES[data.refusal.code],
              }
            : undefined;
        return c.json({
          success: true,
          data: refusal ? { ...data, refusal } : data,
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
      const outcome = await publishPlugin(folder, body, {
        logger,
        ...serviceOptions,
      });
      if (!outcome.ok) {
        const { code, secrets, paths } = outcome.refusal;
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
            ...(paths ? { paths } : {}),
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
