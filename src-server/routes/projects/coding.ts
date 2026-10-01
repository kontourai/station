import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { type Context, Hono, type Next } from 'hono';
import {
  isOperatorInPersonNotAgent,
  mayRunCommandsOnHost,
} from '../../security/coding-authority.js';
import {
  grantedPairingScope,
  type PairingScopeContextStore,
} from '../../security/pairing-route-scopes.js';
import {
  type CheckoutRemoteReader,
  readCheckoutRemotes,
} from '../../services/projects/checkout-remote-reader.js';
import {
  type CodingGitRefusal,
  commitRepository,
  pushRepository,
} from '../../services/projects/coding-git-actions.js';
import type { FileTreeService } from '../../services/projects/file-tree-service.js';
import {
  type LiveRepository,
  openLiveRepository,
  type ProjectRepositoryReadOptions,
  type ReadRepository,
  readProjectRepository,
} from '../../services/projects/git-read-repository.js';
import { listVerifiedWorktrees } from '../../services/projects/verified-worktrees.js';
import { codingOps } from '../../telemetry/metrics.js';
import { execGit } from '../../utils/git-exec.js';
import { expandTilde } from '../../utils/paths.js';
import {
  operatorOnly,
  type PluginPrincipalResolution,
} from '../plugins/plugin-identity-enumeration.js';
import {
  errorMessage,
  execCommandSchema,
  fileCreateSchema,
  fileDeleteSchema,
  fileRenameSchema,
  getBody,
  gitCheckoutSchema,
  gitCommitSchema,
  gitPushSchema,
  validate,
} from '../schemas/schemas.js';

/**
 * #2412, owner decision: `POST /exec` stays at the operate tier, and a
 * paired device additionally needs `coding:exec`, which the operator grants
 * once per device (the device access editor, `operator-promotion`) and can
 * take away there. The operator in person is always allowed.
 */
function codingExecAllowed(c: Context): boolean {
  return mayRunCommandsOnHost(
    c.req.raw,
    grantedPairingScope(c as unknown as PairingScopeContextStore),
  );
}

/** The stable refusal a device without the exec grant receives. */
const CODING_EXEC_NOT_GRANTED = {
  success: false as const,
  code: 'coding-exec-not-granted' as const,
  error:
    "This device is not allowed to run commands on this Station's computer. The Station's operator can allow it: on the Station's host, run: station environment access devices, then station environment access scope <this device> --add coding:exec; or in the Station desktop app on its host, select the Station name (top right) → Paired devices → this device → Change access → Run commands → Apply.",
};

/**
 * Bounds on every git call these routes make (#2363 review round 2). A
 * repository's own config can make git wait forever (an `include.path` of
 * a named pipe blocked status, log and branches indefinitely); on the
 * deadline `execFile` kills the child and the route answers 504 instead of
 * holding the request open. Quick: rev-parse and ref checks. Read: status,
 * log, branches. Diff reads every changed file. Checkout writes the tree.
 */
const GIT_QUICK_TIMEOUT_MS = 10_000;
const GIT_READ_TIMEOUT_MS = 20_000;
const GIT_DIFF_TIMEOUT_MS = 30_000;
const GIT_CHECKOUT_TIMEOUT_MS = 60_000;

const GIT_TIMEOUT_MESSAGE =
  'git did not answer in time and was stopped. The repository may be very large, or its configuration names something that never answers (such as an include of a pipe)';

/** `execFile` marks a child it killed on its deadline. */
function timedOut(error: unknown): boolean {
  const failure = error as { killed?: unknown; signal?: unknown };
  return failure?.killed === true || failure?.signal === 'SIGTERM';
}

/** The route answer for a git call that failed: 504 on a deadline. */
function gitFailure(c: Context, error: unknown): Response {
  if (timedOut(error)) {
    return c.json(
      {
        success: false,
        error: GIT_TIMEOUT_MESSAGE,
        code: 'git-timeout',
      },
      504,
    );
  }
  if (objectNotFetched(error)) {
    return c.json(
      {
        success: false,
        error:
          'This repository is a partial clone, and this needs an object that has not been fetched. Station does not fetch on a read; fetch it from a terminal (for example `git fetch --refetch`, or run the same git command there), then try again',
        code: 'object-not-available',
      },
      409,
    );
  }
  return c.json({ success: false, error: errorMessage(error) }, 400);
}

/**
 * git's words when a partial clone needs an object it does not have and the
 * runner would not let it fetch (`utils/git-exec.ts`): the lazy-fetch
 * notice on git 2.45 and later, the refused transport or promisor failure
 * before that.
 */
function objectNotFetched(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown })?.stderr;
  return (
    typeof stderr === 'string' &&
    /lazy fetching disabled|from promisor remote|transport '[^']*' not allowed/.test(
      stderr,
    )
  );
}

// Directories that never contain a user's repos but are expensive to walk.
const REPO_SCAN_SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  '.cache',
  '.next',
  '.turbo',
]);

/**
 * Discover the git repos within a workspace. Handles the multi-root case where
 * the folder a user opens is not itself a repo but contains several (e.g.
 * `~/dev/github/org` holding `repo-a`, `repo-b`). Stops descending at a repo
 * boundary and skips heavy directories so the scan stays cheap.
 */
async function discoverRepos(
  workspace: string,
  maxDepth = 4,
): Promise<string[]> {
  const roots: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (existsSync(join(dir, '.git'))) {
      roots.push(dir);
      return; // a repo owns its whole subtree; don't descend further
    }
    if (depth >= maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true }).then(
      (e) => e,
      () => null,
    );
    if (!entries) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || REPO_SCAN_SKIP.has(entry.name))
        continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }
  await walk(workspace, 0);
  return roots;
}

/** Letters, digits, `.`, `_`, `-` and `/`, not starting with `-` or `.`,
 * and a valid ref by git's own rules (no `..`, no `.lock`, …). */
const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

async function isBranchName(dir: string, branch: string): Promise<boolean> {
  if (!BRANCH_NAME.test(branch)) return false;
  try {
    await execGit(['check-ref-format', `refs/heads/${branch}`], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: GIT_QUICK_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * What a repository-config refusal says: which keys, and what the operator
 * can do about them. The keys come from `git-repository-config.ts`.
 */
function configRefusedMessage(keys: readonly string[]): string {
  const named = keys.length > 0 ? keys.join(', ') : 'options';
  // `git lfs install --local` is the common way to end up here; the global
  // install is the operator's own configuration, which applies by design.
  const lfs = keys.some((key) => key.toLowerCase().startsWith('filter.lfs.'))
    ? " For Git LFS, install its filters for this computer's user instead (`git lfs install`, without `--local`)"
    : '';
  return `This repository's own .git/config sets ${named}. Station runs git here as this computer's user, and does not while a repository's own configuration names a program to run, an address to connect to, or a file outside the repository to read. To use Station's git panel here, remove ${keys.length === 1 ? 'it' : 'them'} (\`git config --local --unset <key>\`; an included file from outside the repository is \`include.path\`)${lfs ? `.${lfs}` : ''}, or use git from a terminal`;
}

const CONFIG_UNREADABLE_MESSAGE =
  "git could not read this repository's configuration";

/**
 * The answer for a folder whose repository is not the Project's own (see
 * `git-read-repository.ts`): the read refusal's shape and status. `reason`
 * names entries relative to `.git`, never a host path.
 */
function repositoryRefused(c: Context, reason: string): Response {
  return c.json(
    {
      success: false,
      error: `That folder's .git leads outside this Project (${reason}), so Station does not read it`,
      code: 'git-dir-outside-project',
    },
    409,
  );
}

/** One sentence per refusal; the route never words git's own output. */
function refusalMessage(refusal: CodingGitRefusal): string {
  switch (refusal.code) {
    case 'repository-config-refused':
      return configRefusedMessage(refusal.keys);
    case 'repository-config-unreadable':
      return CONFIG_UNREADABLE_MESSAGE;
    case 'git-dir-outside-project':
      return `That folder's .git leads outside this Project (${refusal.reason}), so Station will not commit or push from it`;
    case 'secrets':
      return `Not committed: ${refusal.files
        .map((file) => `${file.path} (${file.reason})`)
        .join(
          ', ',
        )} look${refusal.files.length === 1 ? 's' : ''} like secrets. Add them to .gitignore or remove them, then commit again`;
    case 'nothing-to-commit':
      return 'There is nothing to commit';
    case 'too-many-changes':
      return 'More than 5000 files would be committed. Add build output and dependencies to .gitignore, or commit from a terminal';
    case 'detached-head':
      return 'The repository is not on a branch (detached HEAD). Check out a branch, then push';
    case 'invalid-branch':
      return 'That is not a branch Station can push';
    case 'invalid-remote-name':
      return 'That is not a valid remote name';
    case 'remote-missing':
      return `This repository has no remote named ${refusal.remote}`;
    case 'remote-local-host':
      return `Not pushed: ${refusal.remote} (${refusal.url}) is on this computer or a local-only address`;
    case 'remote-credentials-in-url':
      return `Not pushed: ${refusal.remote}'s address contains a password or token. Remove it; Station pushes with this computer's own git credentials`;
    case 'remote-unsupported-transport':
      return `Not pushed: ${refusal.remote} (${refusal.url}) is not an https:// or SSH address. Local paths, file://, http:// and git remote helpers (such as ext::) are refused`;
    default:
      return `Not pushed: ${refusal.remote}'s address is not one Station can push to`;
  }
}

/** Refusals that describe the request rather than the repository's state. */
const REQUEST_REFUSALS = new Set<CodingGitRefusal['code']>([
  'invalid-branch',
  'invalid-remote-name',
]);

function refusalResponse(c: Context, refusal: CodingGitRefusal): Response {
  const { code } = refusal;
  const status =
    code === 'git-dir-outside-project'
      ? 403
      : REQUEST_REFUSALS.has(code)
        ? 400
        : 409;
  return c.json(
    {
      success: false,
      error: refusalMessage(refusal),
      code,
      ...('keys' in refusal ? { keys: refusal.keys } : {}),
      ...('files' in refusal ? { files: refusal.files } : {}),
    },
    status,
  );
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

const worktreesByRequest = new WeakMap<
  Request,
  Map<string, Promise<readonly string[]>>
>();

/**
 * The verified worktrees of the repository containing `projectRoot`
 * (`listVerifiedWorktrees`, #2412 review), once per request and Project.
 */
function registeredWorktrees(
  c: Context,
  projectRoot: string,
): Promise<readonly string[]> {
  let perRequest = worktreesByRequest.get(c.req.raw);
  if (!perRequest) {
    perRequest = new Map();
    worktreesByRequest.set(c.req.raw, perRequest);
  }
  let pending = perRequest.get(projectRoot);
  if (!pending) {
    pending = listVerifiedWorktrees(projectRoot, GIT_QUICK_TIMEOUT_MS);
    perRequest.set(projectRoot, pending);
  }
  return pending;
}

export function createCodingRoutes(
  fileTreeService: FileTreeService,
  deps: {
    /**
     * How this route observes a checkout's remotes (#1536 G5, review L10).
     * Injectable for the same reason `PullRequestRepositoryContextResolver`
     * takes it: the reader's REFUSAL path decides whether Push is disabled on
     * evidence or on a guess, and no filesystem state reaches it through this
     * route — every way of breaking `.git/config` also fails the
     * repository resolution above it, so the branch is only executable with
     * the reader supplied.
     */
    readRemotes?: CheckoutRemoteReader;
    /**
     * A Project's working directory, by slug (#2363). Commit and push run
     * only in the Project's own folder or a repository inside it; a request
     * path outside it is refused. Absent means no composition supplied it,
     * and both routes refuse.
     */
    resolveProjectFolder?: (slug: string) => string | undefined;
    /** The request's principal, for the operator check on commit and push.
     * Absent means both routes refuse (`operatorOnly`'s contract). */
    visibility?: PluginPrincipalResolution;
    /**
     * TEST ONLY: let the push use git's `file` transport, so a test's
     * global `insteadOf` can route a validated https remote to a bare
     * repository on disk. Construction throws outside Vitest.
     */
    testOnlyAllowFileTransport?: true;
  } = {},
) {
  if (deps.testOnlyAllowFileTransport && process.env.VITEST !== 'true') {
    throw new Error(
      'testOnlyAllowFileTransport is for tests and cannot be enabled here',
    );
  }
  const readRemotes = deps.readRemotes ?? readCheckoutRemotes;
  const app = new Hono();

  // #2363: commit and push run with this computer's git credentials and
  // signing, so they are the host owner's act. The check runs before body
  // validation, so a non-operator learns nothing about the request shape.
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

  /**
   * The folder a coding request acts on (#2363 commit/push, #2412 every
   * route that takes a client path), resolved through symlinks on both
   * sides so neither `..` nor a link leads anywhere the rule below did not
   * admit:
   *
   * - `project` (commit, push): the Project's own folder or inside it.
   * - `write` (file edits, checkout, exec): that, or a checkout git reports
   *   as a registered worktree of the Project's repository (a worktree
   *   session, wherever its policy put it), except one that CONTAINS the
   *   Project from above.
   * - `read` (listings, file reads, status, log, diff, branches, repos):
   *   that, and also the repository's checkout that contains the Project
   *   from above. A Project that is one folder of a larger repository is
   *   still that repository's work: git already reports the whole
   *   repository's status and diff from inside the Project, and a Task's
   *   workspace names the repository root. Reading it adds no git the
   *   Project could not already run; editing or running commands above the
   *   Project would, so those stay refused there.
   *
   * A registered worktree is admitted only when its own `.git` leads back to
   * the Project's repository (`registeredWorktrees`), so a repository cannot
   * claim an arbitrary folder by writing `.git/worktrees/<x>/gitdir`.
   * Anything else is refused.
   *
   * What this does NOT stop: whoever may choose a Project's folder decides
   * where these routes act; that is reserved for the operator in person and
   * devices allowed to run commands (the project routes' working-directory
   * gate).
   */
  const projectLocation = async (
    c: Context,
    slug: string | undefined,
    requested: string | undefined,
    reach: 'project' | 'write' | 'read',
  ): Promise<{ target: string; projectRoot: string } | Response> => {
    if (!slug) {
      return c.json(
        {
          success: false,
          error: 'Name the Project this request is for (projectSlug)',
          code: 'project-required',
        },
        400,
      );
    }
    const configured = deps.resolveProjectFolder?.(slug)?.trim();
    if (!configured) {
      return c.json(
        {
          success: false,
          error: 'This Project has no working directory',
          code: 'no-working-directory',
        },
        409,
      );
    }
    let projectRoot: string;
    let target: string;
    try {
      projectRoot = realpathSync(resolve(expandTilde(configured)));
      target = requested
        ? realpathSync(resolve(expandTilde(requested)))
        : projectRoot;
    } catch {
      return c.json(
        {
          success: false,
          error: 'That folder does not exist',
          code: 'folder-missing',
        },
        409,
      );
    }
    if (isWithin(target, projectRoot)) return { target, projectRoot };
    if (reach !== 'project') {
      for (const worktree of await registeredWorktrees(c, projectRoot)) {
        if (!isWithin(target, worktree)) continue;
        const aboveProject =
          worktree !== projectRoot && isWithin(projectRoot, worktree);
        if (!aboveProject || reach === 'read') return { target, projectRoot };
      }
    }
    return c.json(
      {
        success: false,
        error: "That folder is not part of this Project's working directory",
        code: 'outside-project',
      },
      403,
    );
  };

  /** A coding read: the Project, its worktrees, the repository above it. */
  const readLocation = (
    c: Context,
    slug: string | undefined,
    requested: string | undefined,
  ) => projectLocation(c, slug, requested, 'read');

  /**
   * One git read of a folder `readLocation` admitted. That folder is
   * member-writable, so the repository git would discover from it is not
   * trusted: `read` gets the repository that was resolved and checked, and
   * every git call it makes names it (`repoArgs`). The repository's own
   * config is judged first (#2363), on every read: a filter or diff driver
   * runs on status and diff, and a partial clone makes ANY read fetch.
   * `notRepository` is the route's answer for a folder with no repository.
   */
  const gitRead = async <T>(
    c: Context,
    location: { target: string; projectRoot: string },
    notRepository: unknown,
    read: (repository: ReadRepository) => Promise<T>,
  ): Promise<Response> => {
    const outcome = await readProjectRepository(
      location.projectRoot,
      location.target,
      {
        registeredWorktrees: () => registeredWorktrees(c, location.projectRoot),
        timeoutMs: GIT_QUICK_TIMEOUT_MS,
      },
      read,
    );
    if (outcome.ok) return c.json({ success: true, data: outcome.value });
    switch (outcome.state) {
      case 'not-a-repository':
        return c.json({ success: true, data: notRepository });
      case 'refused':
        return repositoryRefused(c, outcome.reason);
      case 'config-refused':
        return c.json(
          {
            success: false,
            error: configRefusedMessage(outcome.keys),
            code: 'repository-config-refused',
            keys: outcome.keys,
          },
          409,
        );
      case 'config-unreadable':
        return c.json(
          {
            success: false,
            error: CONFIG_UNREADABLE_MESSAGE,
            code: 'repository-config-unreadable',
          },
          409,
        );
      default:
        // Not a refusal: the repository was being written (a commit
        // landing, objects being added) each time Station read it, and a
        // read is only answered from a repository that held still.
        c.header('Retry-After', '1');
        return c.json(
          {
            success: false,
            error:
              'The repository was being changed while Station read it. Nothing is wrong with it; try again in a moment',
            code: 'repository-busy',
            retryable: true,
          },
          503,
        );
    }
  };

  /** A coding edit, checkout or command: the Project or its worktrees. */
  const writeLocation = (
    c: Context,
    slug: string | undefined,
    requested: string | undefined,
  ) => projectLocation(c, slug, requested, 'write');

  /**
   * The repository a commit or push acts on: the Project's folder, or a
   * repository INSIDE it that the toolbar selected (a multi-repo
   * workspace). Not a worktree beside it: commit and push stay where they
   * were confined by #2363.
   */
  const projectRepository = async (
    c: Context,
    slug: string,
    requested: string | undefined,
  ): Promise<{ root: string; projectRoot: string } | Response> => {
    const location = await projectLocation(c, slug, requested, 'project');
    if (location instanceof Response) return location;
    if (!existsSync(join(location.target, '.git'))) {
      return c.json(
        {
          success: false,
          error: 'That folder is not the root of a git repository',
          code: 'not-a-repository',
        },
        409,
      );
    }
    // Where its `.git` leads is checked by the actions themselves.
    return { root: location.target, projectRoot: location.projectRoot };
  };

  // git's own output (a hook's refusal, a rejected push) reaches the operator
  // through the route-seam sanitizer, as every route-catch message does.
  const commandFailure = (c: Context, error: unknown) =>
    c.json({ success: false, error: errorMessage(error) }, 400);

  app.get('/files', async (c) => {
    codingOps.add(1, { operation: 'files' });
    try {
      const location = await readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;
      const dir = location.target;
      const depth = c.req.query('depth')
        ? Number(c.req.query('depth'))
        : undefined;
      const maxEntries = c.req.query('maxEntries')
        ? Number(c.req.query('maxEntries'))
        : undefined;
      const data = fileTreeService.listDirectory(dir, { depth, maxEntries });
      return c.json({ success: true, data });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.get('/files/search', async (c) => {
    codingOps.add(1, { operation: 'search' });
    try {
      const location = await readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;
      const dir = location.target;
      const query = c.req.query('query');
      if (query === undefined)
        return c.json({ success: false, error: 'query required' }, 400);
      const requestedMax = Number(c.req.query('maxResults') ?? 50);
      const maxResults = Number.isInteger(requestedMax)
        ? Math.min(Math.max(requestedMax, 1), 201)
        : 50;
      const result = await fileTreeService.searchFiles(dir, query, maxResults);
      return c.json({
        success: true,
        data: result.entries,
        scanTruncated: result.scanTruncated,
      });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.get('/files/content', async (c) => {
    codingOps.add(1, { operation: 'content' });
    const file = c.req.query('file');
    if (!file) return c.json({ success: false, error: 'file required' }, 400);
    try {
      // `path` is the workspace root; `file` is relative to it. The file tree
      // emits workspace-relative paths, so resolving against the root (not the
      // server cwd) is what makes the preview/attach actually read the right
      // file — and keeps the read inside the workspace.
      const location = await readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;
      const content = fileTreeService.readFileWithin(location.target, file);
      return c.json({ success: true, data: { path: file, content } });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  app.post('/files/create', validate(fileCreateSchema), async (c) => {
    codingOps.add(1, { operation: 'file-create' });
    try {
      const { projectSlug, path, target, type } = getBody(c);
      const location = await writeLocation(c, projectSlug, path);
      if (location instanceof Response) return location;
      const entry = fileTreeService.createEntry(location.target, target, type);
      return c.json({ success: true, data: entry });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/files/rename', validate(fileRenameSchema), async (c) => {
    codingOps.add(1, { operation: 'file-rename' });
    try {
      const { projectSlug, path, from, to } = getBody(c);
      const location = await writeLocation(c, projectSlug, path);
      if (location instanceof Response) return location;
      const entry = fileTreeService.renameEntry(location.target, from, to);
      return c.json({ success: true, data: entry });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/files/delete', validate(fileDeleteSchema), async (c) => {
    codingOps.add(1, { operation: 'file-delete' });
    try {
      const { projectSlug, path, target } = getBody(c);
      const location = await writeLocation(c, projectSlug, path);
      if (location instanceof Response) return location;
      fileTreeService.deleteEntry(location.target, target);
      return c.json({ success: true });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.get('/git/status', async (c) => {
    codingOps.add(1, { operation: 'git-status' });
    try {
      const location = await readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;

      return await gitRead(
        c,
        location,
        { isRepo: false },
        // #2363: `status` runs a repository-defined clean filter.
        async (repository) => {
          const opts = {
            cwd: repository.top,
            encoding: 'utf-8' as const,
            windowsHide: true,
            timeout: GIT_READ_TIMEOUT_MS,
          };
          const git = (args: string[]) =>
            execGit([...repository.repoArgs, ...args], opts);

          const [branchOut, statusOut, logOut, trackingOut, remotes] =
            await Promise.all([
              git(['rev-parse', '--abbrev-ref', 'HEAD']),
              git(['status', '--porcelain']),
              git(['log', '-1', '--format=%H|%an|%ar|%s']).catch(() => ({
                stdout: '',
              })),
              git([
                'rev-list',
                '--left-right',
                '--count',
                'HEAD...@{upstream}',
              ]).catch(() => ({ stdout: '' })),
              // #1536 G5: whether Push has anywhere to go. Through the shared
              // reader, which is the one place that keeps "this checkout has
              // no remotes" and "git could not be run" apart — collapsing
              // them would disable Push over an unreadable config, which is
              // a different fact.
              readRemotes(repository.top, { gitArgs: repository.repoArgs }),
            ]);

          const changes = statusOut.stdout
            .split('\n')
            .filter((l) => l.trim().length > 0);

          // Change breakdown
          let staged = 0,
            unstaged = 0,
            untracked = 0;
          for (const line of changes) {
            const x = line[0],
              y = line[1];
            if (x === '?') {
              untracked++;
            } else {
              if (x !== ' ' && x !== '?') staged++;
              if (y !== ' ' && y !== '?') unstaged++;
            }
          }

          // Last commit
          let lastCommit = null;
          const logParts = logOut.stdout.trim().split('|');
          if (logParts.length >= 4) {
            lastCommit = {
              sha: logParts[0].slice(0, 8),
              author: logParts[1],
              relativeTime: logParts[2],
              message: logParts.slice(3).join('|'),
            };
          }

          // Ahead/behind
          let ahead = 0,
            behind = 0;
          const trackParts = trackingOut.stdout.trim().split(/\s+/);
          if (trackParts.length === 2) {
            ahead = parseInt(trackParts[0], 10) || 0;
            behind = parseInt(trackParts[1], 10) || 0;
          }

          return {
            isRepo: true,
            // The repo that actually contains the folder: for a path inside
            // a nested repo this is that nested repo's root, not the
            // workspace. Lets the UI know which repo the active path
            // belongs to.
            repoRoot: repository.top,
            branch: branchOut.stdout.trim(),
            changes,
            staged,
            unstaged,
            untracked,
            lastCommit,
            ahead,
            behind,
            // Three states, never two: `unknown` is a read that could not
            // answer, and a surface that treated it as `absent` would take
            // Push away on no evidence (#1536 G5).
            remote: remotes.ok
              ? remotes.remotes.length > 0
                ? ('present' as const)
                : ('absent' as const)
              : ('unknown' as const),
          };
        },
      );
    } catch (e: unknown) {
      return gitFailure(c, e);
    }
  });

  app.get('/git/log', async (c) => {
    try {
      const location = await readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;

      const count = Math.min(parseInt(c.req.query('count') || '5', 10), 20);
      // Non-repo: no commits. git/status drives the "not a git repository"
      // empty state; keep this shape an array for a stable contract.
      return await gitRead(c, location, [], async (repository) => {
        const raw = (
          await execGit(
            [
              ...repository.repoArgs,
              'log',
              `-${count}`,
              '--format=%H|%an|%ar|%s',
            ],
            {
              cwd: repository.top,
              encoding: 'utf-8',
              timeout: GIT_READ_TIMEOUT_MS,
            },
          )
        ).stdout;
        return raw
          .split('\n')
          .filter((l) => l.trim())
          .map((line) => {
            const parts = line.split('|');
            return {
              sha: parts[0].slice(0, 8),
              author: parts[1],
              relativeTime: parts[2],
              message: parts.slice(3).join('|'),
            };
          });
      });
    } catch (e: unknown) {
      return gitFailure(c, e);
    }
  });

  app.get('/git/diff', async (c) => {
    try {
      const location = await readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;
      // A multi-repo workspace root isn't itself a repo; return an empty diff
      // instead of letting `git diff` fail with "not a git repository".
      // #2363: `diff` runs repository-defined filters and diff drivers.
      return await gitRead(c, location, { diff: '' }, async (repository) => ({
        diff: (
          await execGit([...repository.repoArgs, 'diff'], {
            cwd: repository.top,
            encoding: 'utf-8',
            timeout: GIT_DIFF_TIMEOUT_MS,
          })
        ).stdout,
      }));
    } catch (e: unknown) {
      return gitFailure(c, e);
    }
  });

  app.get('/git/branches', async (c) => {
    try {
      const location = await readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;
      return await gitRead(c, location, [], async (repository) => {
        const raw = (
          await execGit(
            [
              ...repository.repoArgs,
              'branch',
              '-a',
              '--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)|%(HEAD)',
            ],
            {
              cwd: repository.top,
              encoding: 'utf-8',
              timeout: GIT_READ_TIMEOUT_MS,
            },
          )
        ).stdout;
        return raw
          .split('\n')
          .filter((l) => l.trim())
          .map((line) => {
            const [name, sha, date, head] = line.split('|');
            return {
              name: name.trim(),
              sha,
              date,
              current: head?.trim() === '*',
            };
          });
      });
    } catch (e: unknown) {
      return gitFailure(c, e);
    }
  });

  app.get('/repos', async (c) => {
    codingOps.add(1, { operation: 'repos' });
    try {
      // realpath so discovered roots line up with git's --show-toplevel (which
      // resolves symlinks); lets the UI match the active file's repo to a row.
      // #2412: confined like every read. The one exception is the New
      // Project form, which asks whether a folder it is ABOUT to make a
      // Project holds repositories: that question has no Project to name,
      // and is answered for the operator in person only, never for a
      // request that may be an agent's (Station's internal principal reads
      // as the operator to `isOperatorInPerson` alone).
      const slug = c.req.query('projectSlug');
      let workspace: string;
      // The Project a found root must belong to for its branch to be read.
      // Without one (the New Project form) the folder being asked about
      // stands in for it: a repository found there must be that folder's own.
      let projectRoot: string;
      let worktrees: ProjectRepositoryReadOptions['registeredWorktrees'];
      if (!slug && isOperatorInPersonNotAgent(c.req.raw)) {
        const raw = c.req.query('path');
        if (!raw)
          return c.json({ success: false, error: 'path required' }, 400);
        try {
          workspace = realpathSync(resolve(expandTilde(raw)));
        } catch {
          return c.json(
            {
              success: false,
              error: 'That folder does not exist',
              code: 'folder-missing',
            },
            409,
          );
        }
        projectRoot = workspace;
      } else {
        const location = await readLocation(c, slug, c.req.query('path'));
        if (location instanceof Response) return location;
        workspace = location.target;
        projectRoot = location.projectRoot;
        worktrees = () => registeredWorktrees(c, location.projectRoot);
      }
      const roots = await discoverRepos(workspace);
      const repos = await Promise.all(
        roots.map(async (root) => {
          // A root whose `.git` is not the Project's own still lists (its
          // status then says why it is not read), but its branch is another
          // repository's, so it stays ''.
          const read = await readProjectRepository(
            projectRoot,
            root,
            { registeredWorktrees: worktrees, timeoutMs: GIT_QUICK_TIMEOUT_MS },
            (repository) =>
              execGit(
                [...repository.repoArgs, 'rev-parse', '--abbrev-ref', 'HEAD'],
                {
                  cwd: repository.top,
                  encoding: 'utf-8',
                  timeout: GIT_QUICK_TIMEOUT_MS,
                },
              ).then(
                ({ stdout }) => stdout.trim(),
                // Detached HEAD / mid-rebase repos still list; branch stays ''.
                () => '',
              ),
          );
          return {
            root,
            name: basename(root),
            relativePath: relative(workspace, root) || '.',
            branch: read.ok ? read.value : '',
          };
        }),
      );
      return c.json({
        success: true,
        data: {
          workspace,
          workspaceIsRepo: existsSync(join(workspace, '.git')),
          repos,
        },
      });
    } catch (e: unknown) {
      return gitFailure(c, e);
    }
  });

  app.post('/git/checkout', validate(gitCheckoutSchema), async (c) => {
    codingOps.add(1, { operation: 'git-checkout' });
    try {
      const { projectSlug, path, branch, create } = getBody(c);
      const location = await writeLocation(c, projectSlug, path);
      if (location instanceof Response) return location;
      // #2363: a branch name only. `.` would discard every change, and `-f`
      // or `--orphan=…` would be read as options.
      if (!(await isBranchName(location.target, branch))) {
        return c.json(
          {
            success: false,
            error: 'That is not a valid branch name',
            code: 'invalid-branch',
          },
          400,
        );
      }
      // The folder is member-writable: the repository git would discover
      // from it is not trusted (see `gitRead`), and a checkout through a
      // planted `.git` would move ANOTHER repository's HEAD and write its
      // files here. A write cannot be discarded as a read's output can, so
      // the repository is checked again immediately before git starts (the
      // checks themselves take several git calls), and its identity is
      // compared afterwards. A `.git` swapped in the moment between that
      // last check and git opening it is still followed.
      //
      // #2363: `checkout` runs smudge filters the repository's config
      // defines. git runs with Station's copy of that config as its common
      // directory (`git-read-repository.ts`), the copy that was judged, so
      // a config rewritten in place after the judgement is never read.
      let repository: LiveRepository | undefined;
      for (let attempt = 0; attempt < 3 && !repository; attempt += 1) {
        const opened = await openLiveRepository(
          location.projectRoot,
          location.target,
          {
            registeredWorktrees: () =>
              registeredWorktrees(c, location.projectRoot),
            timeoutMs: GIT_QUICK_TIMEOUT_MS,
          },
        );
        if (!opened.ok) {
          switch (opened.state) {
            case 'refused':
              return repositoryRefused(c, opened.reason);
            case 'config-refused':
              return c.json(
                {
                  success: false,
                  error: configRefusedMessage(opened.keys),
                  code: 'repository-config-refused',
                  keys: opened.keys,
                },
                409,
              );
            case 'config-unreadable':
              return c.json(
                {
                  success: false,
                  error: CONFIG_UNREADABLE_MESSAGE,
                  code: 'repository-config-unreadable',
                },
                409,
              );
            default:
              return c.json(
                {
                  success: false,
                  error: 'That folder is not in a git repository',
                  code: 'not-a-repository',
                },
                409,
              );
          }
        }
        if (await opened.repository.unchanged()) repository = opened.repository;
        else await opened.repository.dispose();
      }
      if (!repository) {
        return repositoryRefused(
          c,
          '.git kept changing while Station was checking it',
        );
      }
      try {
        const opts = {
          cwd: repository.top,
          encoding: 'utf-8' as const,
          windowsHide: true,
          timeout: GIT_CHECKOUT_TIMEOUT_MS,
          env: repository.env,
        };
        await execGit(
          [
            ...repository.repoArgs,
            ...(create
              ? ['checkout', '-b', branch, '--end-of-options']
              : ['checkout', '--end-of-options', branch, '--']),
          ],
          opts,
        );
        // A write cannot be discarded, but it can be reported: if what was
        // checked is no longer the same files, the checkout may have landed
        // somewhere else, and nothing about it is echoed back.
        if (!(await repository.sameIdentity())) {
          return c.json(
            {
              success: false,
              error:
                'The repository changed while Station was checking out. The checkout may not have applied here; check the branch from a terminal',
              code: 'repository-changed-during-write',
            },
            409,
          );
        }
        const { stdout } = await execGit(
          [...repository.repoArgs, 'rev-parse', '--abbrev-ref', 'HEAD'],
          opts,
        );
        return c.json({ success: true, data: { branch: stdout.trim() } });
      } finally {
        await repository.dispose();
      }
    } catch (e: unknown) {
      return gitFailure(c, e);
    }
  });

  app.post(
    '/git/commit',
    requireOperator('commit from Station'),
    validate(gitCommitSchema),
    async (c) => {
      codingOps.add(1, { operation: 'git-commit' });
      const { projectSlug, path, message } = getBody(c);
      const repository = await projectRepository(c, projectSlug, path);
      if (repository instanceof Response) return repository;
      try {
        const outcome = await commitRepository(repository.root, message, {
          projectRoot: repository.projectRoot,
        });
        if (!outcome.ok) return refusalResponse(c, outcome.refusal);
        return c.json({ success: true, data: outcome.value });
      } catch (e: unknown) {
        return commandFailure(c, e);
      }
    },
  );

  app.post(
    '/git/push',
    requireOperator('push from Station'),
    validate(gitPushSchema),
    async (c) => {
      codingOps.add(1, { operation: 'git-push' });
      const { projectSlug, path, remote, branch, setUpstream } = getBody(c);
      const repository = await projectRepository(c, projectSlug, path);
      if (repository instanceof Response) return repository;
      try {
        const outcome = await pushRepository(
          repository.root,
          { remote, branch, setUpstream },
          {
            projectRoot: repository.projectRoot,
            allowFileProtocol: deps.testOnlyAllowFileTransport === true,
          },
        );
        if (!outcome.ok) return refusalResponse(c, outcome.refusal);
        return c.json({
          success: true,
          data: { output: outcome.value.output, remote: outcome.value.remote },
        });
      } catch (e: unknown) {
        return commandFailure(c, e);
      }
    },
  );

  /**
   * Runs a shell command as the operator (#2412). Threat model: whoever
   * reaches this runs anything this computer's account can, with its keys.
   * So besides the operate tier, a paired device needs the `coding:exec`
   * grant the operator gives it once (checked BEFORE the body is read, so a
   * refused caller learns nothing about the request shape), and the command
   * runs in the named Project's folder or one of its worktrees.
   */
  app.post('/exec', async (c, next) => {
    if (codingExecAllowed(c)) return next();
    codingOps.add(1, { operation: 'exec-refused' });
    return c.json(CODING_EXEC_NOT_GRANTED, 403);
  });
  app.post('/exec', validate(execCommandSchema), async (c) => {
    codingOps.add(1, { operation: 'exec' });
    try {
      const { projectSlug, command, cwd } = getBody(c);
      const location = await writeLocation(c, projectSlug, cwd);
      if (location instanceof Response) return location;
      const dir = location.target;
      const result = await exec(command, {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return c.json({
        success: true,
        data: { stdout: result.stdout, stderr: result.stderr, exitCode: 0 },
      });
    } catch (e: unknown) {
      const execErr = e as {
        code?: number;
        status?: number;
      };
      return c.json({
        success: false,
        error: {
          code: 'command_failed',
          exitCode:
            typeof execErr.status === 'number'
              ? execErr.status
              : typeof execErr.code === 'number'
                ? execErr.code
                : 1,
        },
        // Do not send raw CLI stderr to a browser. It may contain absolute
        // paths, provider credentials, or the command's own secret output.
      });
    }
  });

  return app;
}
