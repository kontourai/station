import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  PAIRING_SCOPE_CODING_EXEC,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import { type Context, Hono, type Next } from 'hono';
import {
  grantedPairingScope,
  type PairingScopeContextStore,
} from '../../security/pairing-route-scopes.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundRuntimeLocalOperator,
} from '../../security/runtime-request-security.js';
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
import { checkRepositoryConfig } from '../../services/projects/git-repository-config.js';
import { defaultWorktreeBaseDir } from '../../services/projects/worktree-provisioning-service.js';
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
 * #2412: the operator in person, as opposed to a paired device. True for
 * the operator credential and for a credential minted by proving possession
 * of this Station's home (the desktop app's local grant, the host browser's
 * bootstrap, Station's own internal token), which the auth boundary binds
 * once per request. A paired device, a LAN browser admitted through an
 * access request, and a collaborator's browser are all NOT in person, and
 * neither is a request no auth boundary saw.
 */
function isOperatorInPerson(request: Request): boolean {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (!principal) return false;
  return (
    principal.authority === 'operator-credential' ||
    isBoundRuntimeLocalOperator(request)
  );
}

/**
 * #2412, owner decision: `POST /exec` stays at the operate tier, and a
 * paired device additionally needs `coding:exec`, which the operator grants
 * once per device (the device access editor, `operator-promotion`) and can
 * take away there. The operator in person is always allowed.
 */
function codingExecAllowed(c: Context): boolean {
  if (isOperatorInPerson(c.req.raw)) return true;
  if (!getRuntimeAuthenticatedRequestPrincipal(c.req.raw)) return false;
  const scope = grantedPairingScope(c as unknown as PairingScopeContextStore);
  return (
    scope !== undefined &&
    pairingScopeIncludes(scope, PAIRING_SCOPE_CODING_EXEC)
  );
}

/** The stable refusal a device without the exec grant receives. */
const CODING_EXEC_NOT_GRANTED = {
  success: false as const,
  code: 'coding-exec-not-granted' as const,
  error:
    "This device is not allowed to run commands on this Station's computer. The Station's operator can allow it: Devices, this device's access, Run commands.",
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

class GitTimeoutError extends Error {
  constructor() {
    super(GIT_TIMEOUT_MESSAGE);
    this.name = 'GitTimeoutError';
  }
}

/** `execFile` marks a child it killed on its deadline. */
function timedOut(error: unknown): boolean {
  const failure = error as { killed?: unknown; signal?: unknown };
  return failure?.killed === true || failure?.signal === 'SIGTERM';
}

/** The route answer for a git call that failed: 504 on a deadline. */
function gitFailure(c: Context, error: unknown): Response {
  if (error instanceof GitTimeoutError || timedOut(error)) {
    return c.json(
      {
        success: false,
        error: GIT_TIMEOUT_MESSAGE,
        code: 'git-timeout',
      },
      504,
    );
  }
  return c.json({ success: false, error: errorMessage(error) }, 400);
}

/**
 * Fast-path detect whether `dir` is inside a git work tree. Returns false for
 * non-repos instead of letting `git` reject with "fatal: not a git repository"
 * (which the UI would surface as a 400 error). `git rev-parse` is cheap and
 * never mutates. A deadline is NOT "not a repository": it throws.
 */
async function isInsideWorkTree(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execGit(['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: GIT_QUICK_TIMEOUT_MS,
    });
    return stdout.trim() === 'true';
  } catch (error) {
    if (timedOut(error)) throw new GitTimeoutError();
    return false;
  }
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

const CONFIG_REFUSED_MESSAGE =
  "This repository's own .git/config sets options that run programs or redirect a push, and Station runs git here with this computer's credentials. Remove them (listed in `keys`), or use git from a terminal";

/**
 * The read-side refusal (#2363): a repository whose own config defines a
 * filter or diff driver is not run `status`, `diff` or `checkout` against,
 * because those commands run the driver. `null` means go ahead.
 */
async function readRefusal(dir: string) {
  const verdict = await checkRepositoryConfig(dir, 'read');
  if (verdict.ok) return null;
  return verdict.code === 'repository-config-refused'
    ? {
        success: false as const,
        error: CONFIG_REFUSED_MESSAGE,
        code: verdict.code,
        keys: verdict.keys,
      }
    : {
        success: false as const,
        error: "git could not read this repository's configuration",
        code: verdict.code,
      };
}

/** One sentence per refusal; the route never words git's own output. */
function refusalMessage(refusal: CodingGitRefusal): string {
  switch (refusal.code) {
    case 'repository-config-refused':
      return CONFIG_REFUSED_MESSAGE;
    case 'repository-config-unreadable':
      return "git could not read this repository's configuration";
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

export function createCodingRoutes(
  fileTreeService: FileTreeService,
  deps: {
    /**
     * How this route observes a checkout's remotes (#1536 G5, review L10).
     * Injectable for the same reason `PullRequestRepositoryContextResolver`
     * takes it: the reader's REFUSAL path decides whether Push is disabled on
     * evidence or on a guess, and no filesystem state reaches it through this
     * route — every way of breaking `.git/config` also fails the
     * `isInsideWorkTree` gate above it, so the branch is only executable with
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
   * route that takes a client path): the Project's own folder or a folder
   * INSIDE it, resolved through symlinks on both sides, so neither `..` nor
   * a link inside the Project leads outside it. `includeWorktrees` also
   * admits the `<project>-worktrees` folder beside it, where Station puts
   * a worktree session's checkout (`defaultWorktreeBaseDir`); that path is
   * derived from the Project's folder, never from anything the request or
   * the repository says. Anything else is refused.
   *
   * What this does NOT stop: a caller who may edit the Project may point
   * its working directory somewhere else, and the containment follows. It
   * binds a read to a Project the caller names, not to a folder the
   * operator approved.
   */
  const projectLocation = (
    c: Context,
    slug: string | undefined,
    requested: string | undefined,
    options: { includeWorktrees: boolean },
  ): { target: string; projectRoot: string } | Response => {
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
    const within = (root: string) =>
      target === root || target.startsWith(root + sep);
    if (
      !within(projectRoot) &&
      !(options.includeWorktrees && within(defaultWorktreeBaseDir(projectRoot)))
    ) {
      return c.json(
        {
          success: false,
          error: "That folder is not part of this Project's working directory",
          code: 'outside-project',
        },
        403,
      );
    }
    return { target, projectRoot };
  };

  /** A coding read or edit: the Project's folder or one of its worktrees. */
  const readLocation = (
    c: Context,
    slug: string | undefined,
    requested: string | undefined,
  ) => projectLocation(c, slug, requested, { includeWorktrees: true });

  /**
   * The repository a commit or push acts on: the Project's folder, or a
   * repository INSIDE it that the toolbar selected (a multi-repo
   * workspace). Not a worktree beside it: commit and push stay where they
   * were confined by #2363.
   */
  const projectRepository = (
    c: Context,
    slug: string,
    requested: string | undefined,
  ): { root: string; projectRoot: string } | Response => {
    const location = projectLocation(c, slug, requested, {
      includeWorktrees: false,
    });
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

  app.get('/files', (c) => {
    codingOps.add(1, { operation: 'files' });
    try {
      const location = readLocation(
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
      const location = readLocation(
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

  app.get('/files/content', (c) => {
    codingOps.add(1, { operation: 'content' });
    const file = c.req.query('file');
    if (!file) return c.json({ success: false, error: 'file required' }, 400);
    try {
      // `path` is the workspace root; `file` is relative to it. The file tree
      // emits workspace-relative paths, so resolving against the root (not the
      // server cwd) is what makes the preview/attach actually read the right
      // file — and keeps the read inside the workspace.
      const location = readLocation(
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

  app.post('/files/create', validate(fileCreateSchema), (c) => {
    codingOps.add(1, { operation: 'file-create' });
    try {
      const { projectSlug, path, target, type } = getBody(c);
      const location = readLocation(c, projectSlug, path);
      if (location instanceof Response) return location;
      const entry = fileTreeService.createEntry(location.target, target, type);
      return c.json({ success: true, data: entry });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/files/rename', validate(fileRenameSchema), (c) => {
    codingOps.add(1, { operation: 'file-rename' });
    try {
      const { projectSlug, path, from, to } = getBody(c);
      const location = readLocation(c, projectSlug, path);
      if (location instanceof Response) return location;
      const entry = fileTreeService.renameEntry(location.target, from, to);
      return c.json({ success: true, data: entry });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/files/delete', validate(fileDeleteSchema), (c) => {
    codingOps.add(1, { operation: 'file-delete' });
    try {
      const { projectSlug, path, target } = getBody(c);
      const location = readLocation(c, projectSlug, path);
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
      const location = readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;
      const dir = location.target;

      if (!(await isInsideWorkTree(dir))) {
        return c.json({ success: true, data: { isRepo: false } });
      }
      // #2363: `status` runs a repository-defined clean filter.
      const refusal = await readRefusal(dir);
      if (refusal) return c.json(refusal, 409);

      const opts = {
        cwd: dir,
        encoding: 'utf-8' as const,
        windowsHide: true,
        timeout: GIT_READ_TIMEOUT_MS,
      };

      const [branchOut, statusOut, logOut, trackingOut, topLevelOut, remotes] =
        await Promise.all([
          execGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts),
          execGit(['status', '--porcelain'], opts),
          execGit(['log', '-1', '--format=%H|%an|%ar|%s'], opts).catch(() => ({
            stdout: '',
          })),
          execGit(
            ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
            opts,
          ).catch(() => ({ stdout: '' })),
          // The repo that actually contains `dir` — for a path inside a nested
          // repo this is that nested repo's root, not the workspace. Lets the
          // UI know which repo the active path belongs to.
          execGit(['rev-parse', '--show-toplevel'], opts).catch(() => ({
            stdout: '',
          })),
          // #1536 G5: whether Push has anywhere to go. Through the shared
          // reader, which is the one place that keeps "this checkout has no
          // remotes" and "git could not be run" apart — collapsing them would
          // disable Push over an unreadable config, which is a different fact.
          readRemotes(dir),
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

      return c.json({
        success: true,
        data: {
          isRepo: true,
          repoRoot: topLevelOut.stdout.trim() || dir,
          branch: branchOut.stdout.trim(),
          changes,
          staged,
          unstaged,
          untracked,
          lastCommit,
          ahead,
          behind,
          // Three states, never two: `unknown` is a read that could not answer,
          // and a surface that treated it as `absent` would take Push away on
          // no evidence (#1536 G5).
          remote: remotes.ok
            ? remotes.remotes.length > 0
              ? ('present' as const)
              : ('absent' as const)
            : ('unknown' as const),
        },
      });
    } catch (e: unknown) {
      return gitFailure(c, e);
    }
  });

  app.get('/git/log', async (c) => {
    try {
      const location = readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;
      const dir = location.target;

      if (!(await isInsideWorkTree(dir))) {
        // Non-repo: no commits. git/status drives the "not a git repository"
        // empty state; keep this shape an array for a stable contract.
        return c.json({ success: true, data: [] });
      }

      const count = Math.min(parseInt(c.req.query('count') || '5', 10), 20);
      const raw = (
        await execGit(['log', `-${count}`, '--format=%H|%an|%ar|%s'], {
          cwd: dir,
          encoding: 'utf-8',
          timeout: GIT_READ_TIMEOUT_MS,
        })
      ).stdout;
      const commits = raw
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
      return c.json({ success: true, data: commits });
    } catch (e: unknown) {
      return gitFailure(c, e);
    }
  });

  app.get('/git/diff', async (c) => {
    try {
      const location = readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;
      const dir = location.target;
      // A multi-repo workspace root isn't itself a repo; return an empty diff
      // instead of letting `git diff` fail with "not a git repository".
      if (!(await isInsideWorkTree(dir))) {
        return c.json({ success: true, data: { diff: '' } });
      }
      // #2363: `diff` runs repository-defined filters and diff drivers.
      const refusal = await readRefusal(dir);
      if (refusal) return c.json(refusal, 409);
      const diff = (
        await execGit(['diff'], {
          cwd: dir,
          encoding: 'utf-8',
          timeout: GIT_DIFF_TIMEOUT_MS,
        })
      ).stdout;
      return c.json({ success: true, data: { diff } });
    } catch (e: unknown) {
      return gitFailure(c, e);
    }
  });

  app.get('/git/branches', async (c) => {
    try {
      const location = readLocation(
        c,
        c.req.query('projectSlug'),
        c.req.query('path'),
      );
      if (location instanceof Response) return location;
      const dir = location.target;
      if (!(await isInsideWorkTree(dir))) {
        return c.json({ success: true, data: [] });
      }
      const raw = (
        await execGit(
          [
            'branch',
            '-a',
            '--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)|%(HEAD)',
          ],
          { cwd: dir, encoding: 'utf-8', timeout: GIT_READ_TIMEOUT_MS },
        )
      ).stdout;
      const branches = raw
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
      return c.json({ success: true, data: branches });
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
      // and is answered for the operator in person only.
      const slug = c.req.query('projectSlug');
      let workspace: string;
      if (!slug && isOperatorInPerson(c.req.raw)) {
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
      } else {
        const location = readLocation(c, slug, c.req.query('path'));
        if (location instanceof Response) return location;
        workspace = location.target;
      }
      const roots = await discoverRepos(workspace);
      const repos = await Promise.all(
        roots.map(async (root) => {
          let branch = '';
          try {
            const { stdout } = await execGit(
              ['rev-parse', '--abbrev-ref', 'HEAD'],
              { cwd: root, encoding: 'utf-8', timeout: GIT_QUICK_TIMEOUT_MS },
            );
            branch = stdout.trim();
          } catch {
            // Detached HEAD / mid-rebase repos still list; branch stays ''.
          }
          return {
            root,
            name: basename(root),
            relativePath: relative(workspace, root) || '.',
            branch,
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
      const location = readLocation(c, projectSlug, path);
      if (location instanceof Response) return location;
      const dir = location.target;
      // #2363: a branch name only. `.` would discard every change, and `-f`
      // or `--orphan=…` would be read as options.
      if (!(await isBranchName(dir, branch))) {
        return c.json(
          {
            success: false,
            error: 'That is not a valid branch name',
            code: 'invalid-branch',
          },
          400,
        );
      }
      // #2363: `checkout` runs repository-defined smudge filters.
      const refusal = await readRefusal(dir);
      if (refusal) return c.json(refusal, 409);
      const opts = {
        cwd: dir,
        encoding: 'utf-8' as const,
        windowsHide: true,
        timeout: GIT_CHECKOUT_TIMEOUT_MS,
      };
      await execGit(
        create
          ? ['checkout', '-b', branch, '--end-of-options']
          : ['checkout', '--end-of-options', branch, '--'],
        opts,
      );
      const { stdout } = await execGit(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        opts,
      );
      return c.json({ success: true, data: { branch: stdout.trim() } });
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
      const repository = projectRepository(c, projectSlug, path);
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
      const repository = projectRepository(c, projectSlug, path);
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
      const location = readLocation(c, projectSlug, cwd);
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
