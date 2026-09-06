import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import {
  type CheckoutRemoteReader,
  readCheckoutRemotes,
} from '../../services/projects/checkout-remote-reader.js';
import type { FileTreeService } from '../../services/projects/file-tree-service.js';
import { codingOps } from '../../telemetry/metrics.js';
import { execGit } from '../../utils/git-exec.js';
import { expandTilde } from '../../utils/paths.js';
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

function validatePath(raw: string | undefined): string {
  if (!raw) throw new Error('path required');
  const resolved = resolve(expandTilde(raw));
  if (!existsSync(resolved))
    throw new Error(`Directory not found: ${resolved}`);
  return resolved;
}

/**
 * Fast-path detect whether `dir` is inside a git work tree. Returns false for
 * non-repos instead of letting `git` reject with "fatal: not a git repository"
 * (which the UI would surface as a 400 error). `git rev-parse` is cheap and
 * never mutates.
 */
async function isInsideWorkTree(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execGit(['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    return stdout.trim() === 'true';
  } catch {
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
  } = {},
) {
  const readRemotes = deps.readRemotes ?? readCheckoutRemotes;
  const app = new Hono();

  app.get('/files', (c) => {
    codingOps.add(1, { operation: 'files' });
    try {
      const dir = validatePath(c.req.query('path'));
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

  app.get('/files/search', (c) => {
    codingOps.add(1, { operation: 'search' });
    try {
      const dir = validatePath(c.req.query('path'));
      const query = c.req.query('query');
      if (!query)
        return c.json({ success: false, error: 'query required' }, 400);
      const data = fileTreeService.searchFiles(dir, query);
      return c.json({ success: true, data });
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
      const root = validatePath(c.req.query('path'));
      const content = fileTreeService.readFileWithin(root, file);
      return c.json({ success: true, data: { path: file, content } });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  app.post('/files/create', validate(fileCreateSchema), (c) => {
    codingOps.add(1, { operation: 'file-create' });
    try {
      const { path, target, type } = getBody(c);
      const root = validatePath(path);
      const entry = fileTreeService.createEntry(root, target, type);
      return c.json({ success: true, data: entry });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/files/rename', validate(fileRenameSchema), (c) => {
    codingOps.add(1, { operation: 'file-rename' });
    try {
      const { path, from, to } = getBody(c);
      const root = validatePath(path);
      const entry = fileTreeService.renameEntry(root, from, to);
      return c.json({ success: true, data: entry });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/files/delete', validate(fileDeleteSchema), (c) => {
    codingOps.add(1, { operation: 'file-delete' });
    try {
      const { path, target } = getBody(c);
      const root = validatePath(path);
      fileTreeService.deleteEntry(root, target);
      return c.json({ success: true });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.get('/git/status', async (c) => {
    codingOps.add(1, { operation: 'git-status' });
    try {
      const dir = validatePath(c.req.query('path'));

      if (!(await isInsideWorkTree(dir))) {
        return c.json({ success: true, data: { isRepo: false } });
      }

      const opts = {
        cwd: dir,
        encoding: 'utf-8' as const,
        windowsHide: true,
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
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.get('/git/log', async (c) => {
    try {
      const dir = validatePath(c.req.query('path'));

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
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.get('/git/diff', async (c) => {
    try {
      const dir = validatePath(c.req.query('path'));
      // A multi-repo workspace root isn't itself a repo; return an empty diff
      // instead of letting `git diff` fail with "not a git repository".
      if (!(await isInsideWorkTree(dir))) {
        return c.json({ success: true, data: { diff: '' } });
      }
      const diff = (
        await execGit(['diff'], {
          cwd: dir,
          encoding: 'utf-8',
        })
      ).stdout;
      return c.json({ success: true, data: { diff } });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.get('/git/branches', async (c) => {
    try {
      const dir = validatePath(c.req.query('path'));
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
          { cwd: dir, encoding: 'utf-8' },
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
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.get('/repos', async (c) => {
    codingOps.add(1, { operation: 'repos' });
    try {
      // realpath so discovered roots line up with git's --show-toplevel (which
      // resolves symlinks); lets the UI match the active file's repo to a row.
      const workspace = realpathSync(validatePath(c.req.query('path')));
      const roots = await discoverRepos(workspace);
      const repos = await Promise.all(
        roots.map(async (root) => {
          let branch = '';
          try {
            const { stdout } = await execGit(
              ['rev-parse', '--abbrev-ref', 'HEAD'],
              { cwd: root, encoding: 'utf-8' },
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
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/git/checkout', validate(gitCheckoutSchema), async (c) => {
    codingOps.add(1, { operation: 'git-checkout' });
    try {
      const { path, branch, create } = getBody(c);
      const dir = validatePath(path);
      const opts = { cwd: dir, encoding: 'utf-8' as const, windowsHide: true };
      await execGit(
        create ? ['checkout', '-b', branch] : ['checkout', branch],
        opts,
      );
      const { stdout } = await execGit(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        opts,
      );
      return c.json({ success: true, data: { branch: stdout.trim() } });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/git/commit', validate(gitCommitSchema), async (c) => {
    codingOps.add(1, { operation: 'git-commit' });
    try {
      const { path, message } = getBody(c);
      const dir = validatePath(path);
      const opts = { cwd: dir, encoding: 'utf-8' as const, windowsHide: true };
      await execGit(['add', '-A'], opts);
      await execGit(['commit', '-m', message], opts);
      const { stdout } = await execGit(['rev-parse', 'HEAD'], opts);
      return c.json({ success: true, data: { sha: stdout.trim() } });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/git/push', validate(gitPushSchema), async (c) => {
    codingOps.add(1, { operation: 'git-push' });
    try {
      const { path, remote, branch, setUpstream } = getBody(c);
      const dir = validatePath(path);
      const opts = { cwd: dir, encoding: 'utf-8' as const, windowsHide: true };
      const args = ['push'];
      if (setUpstream) args.push('-u');
      if (remote) args.push(remote);
      if (branch) args.push(branch);
      const { stdout, stderr } = await execGit(args, opts);
      return c.json({
        success: true,
        data: {
          output: stdout.trim(),
          diagnostics: stderr ? 'suppressed' : 'none',
        },
      });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 400);
    }
  });

  app.post('/exec', validate(execCommandSchema), async (c) => {
    codingOps.add(1, { operation: 'exec' });
    try {
      const { command, cwd } = getBody(c);
      const dir = validatePath(cwd);
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
