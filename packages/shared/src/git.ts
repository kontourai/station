import { execFileSync, execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

/**
 * Return a copy of `process.env` with `GIT_DIR`/`GIT_WORK_TREE` removed so an
 * inherited value can't silently retarget the spawned git at the wrong repo
 * (issue #104). Mirrors `src-server/utils/git-exec.ts#gitEnv`; kept local to
 * avoid a cross-package dependency from this leaf shared module.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/** Run a git command in `cwd` and return its trimmed stdout. */
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: gitEnv(),
  }).trim();
}

/**
 * The full HEAD sha of the checkout at `cwd`, bounded by `timeoutMs` so a
 * wedged git (credential helper, lock, network filesystem) cannot stall a
 * caller that runs unattended, such as a service supervisor. Uses the same
 * GIT_DIR/GIT_WORK_TREE-scrubbed environment as the helpers above. Throws when
 * git fails, times out, or answers with something that is not a sha.
 */
export function readGitHeadSha(cwd: string, timeoutMs = 5_000): string {
  const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: gitEnv(),
    timeout: timeoutMs,
  }).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new Error(`git rev-parse HEAD returned ${JSON.stringify(sha)}`);
  }
  return sha;
}

/**
 * Resolve git info from a hint directory. Falls back through process.argv
 * for bundled environments where import.meta.url may not resolve correctly.
 */
export function resolveGitInfo(hint?: string): {
  gitRoot: string;
  branch: string;
  hash: string;
  remote?: string;
} {
  const candidates = [hint, process.cwd()].filter(Boolean) as string[];
  const serverEntry = process.argv.find(
    (arg) => arg.includes('src-server') || arg.includes('dist-server'),
  );
  if (serverEntry) candidates.splice(1, 0, dirname(resolve(serverEntry)));

  let gitRoot: string | undefined;
  for (const directory of candidates) {
    try {
      gitRoot = git('rev-parse --show-toplevel', directory);
      break;
    } catch {}
  }
  if (!gitRoot) throw new Error('Not a git repository');

  const branch = git('rev-parse --abbrev-ref HEAD', gitRoot);
  const hash = git('rev-parse HEAD', gitRoot).substring(0, 7);

  let remote: string | undefined;
  try {
    remote = git('remote get-url origin', gitRoot);
  } catch {}

  return { gitRoot, branch, hash, remote };
}
