import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  execGit,
  type GitHardeningOptions,
  killGitProcessTree,
  spawnGit,
} from '../../utils/git-exec.js';
import {
  type GitDirectoryVerdict,
  gitDirectoryInsideProject,
  repositoryArgs,
} from './git-directory-confinement.js';
import {
  type GitRemoteRefusal,
  privateKeyInContent,
  redactRemoteUrl,
  secretLookingPathReason,
  validateGitRemoteUrl,
} from './git-guards.js';
import { checkRepositoryConfig } from './git-repository-config.js';

export type CodingGitRefusal =
  | { code: 'repository-config-refused'; keys: string[] }
  | { code: 'repository-config-unreadable' }
  | { code: 'git-dir-outside-project'; reason: string }
  | { code: 'secrets'; files: Array<{ path: string; reason: string }> }
  | { code: 'nothing-to-commit' }
  | { code: 'too-many-changes' }
  | { code: 'detached-head' }
  | { code: 'invalid-branch' }
  | { code: 'invalid-remote-name' }
  | { code: 'remote-missing'; remote: string }
  | { code: `remote-${GitRemoteRefusal}`; remote: string; url: string };

export type CodingGitOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: CodingGitRefusal };

/** A git command that ran and failed (a hook, a rejected push, …). */
class CodingGitCommandError extends Error {
  constructor(
    readonly command: string,
    readonly detail: string,
  ) {
    super(detail || `git ${command} failed`);
    this.name = 'CodingGitCommandError';
  }
}

/** More than this many changed paths is refused: commit those from a
 * terminal, where `.gitignore` mistakes are visible. */
const MAX_COMMIT_PATHS = 5000;
const MAX_DETAIL = 4000;
// git allows `/` in a remote name (`team/fork`).
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const BRANCH_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** git's own words for a failure (its stderr), never the command line. */
function failureDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text =
    typeof stderr === 'string' && stderr.trim()
      ? stderr.trim()
      : error instanceof Error
        ? error.message.split('\n').slice(1).join('\n').trim()
        : '';
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

async function git(
  root: string,
  args: string[],
  options: {
    timeout?: number;
    hardening?: GitHardeningOptions;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<string> {
  try {
    const { stdout } = await execGit([...repositoryArgs(root), ...args], {
      cwd: root,
      encoding: 'utf-8',
      timeout: options.timeout ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
      ...(options.env ? { env: options.env } : {}),
      ...(options.hardening ? { hardening: options.hardening } : {}),
    });
    return stdout;
  } catch (error) {
    throw new CodingGitCommandError(args[0] ?? 'git', failureDetail(error));
  }
}

/** `git config --get <key>`, or `undefined` when unset. */
async function configValue(
  root: string,
  key: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execGit(
      [...repositoryArgs(root), 'config', '--get', key],
      { cwd: root, encoding: 'utf-8', timeout: 10_000 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined; // exit 1: unset
  }
}

interface ChangedPath {
  path: string;
  /** Removed from the working tree, so the commit records its deletion. */
  deleted: boolean;
}

/** Every path `commit` would record: staged, unstaged and untracked. */
async function changedPaths(root: string): Promise<ChangedPath[]> {
  const output = await git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=all',
  ]);
  const tokens = output.split('\0');
  const changes: ChangedPath[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    // A rename or copy is followed by its source path. A renamed source
    // leaves the tree (a deletion); a copy's source stays as it is.
    if (status.includes('R')) {
      changes.push({ path: tokens[index + 1] ?? '', deleted: true });
      index += 1;
    } else if (status.includes('C')) {
      index += 1;
    }
    changes.push({
      path,
      deleted: status[1] === 'D' || (status[0] === 'D' && status[1] === ' '),
    });
  }
  // A path ending in `/` is an untracked folder git did not look inside: a
  // nested repository. `git add` would record that repository's HEAD commit
  // as a submodule entry, and a nested `.git` file can name any repository
  // on this computer, so its commit id would be published. Never added.
  return changes.filter(
    (change) => change.path !== '' && !change.path.endsWith('/'),
  );
}

async function containsPrivateKey(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let carry = '';
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return false;
      const text = carry + buffer.toString('latin1', 0, bytesRead);
      if (privateKeyInContent(text)) return true;
      // Long enough to hold a whole BEGIN line split across two reads.
      carry = text.slice(-100);
    }
  } finally {
    await handle.close();
  }
}

async function secretFiles(
  root: string,
  changes: readonly ChangedPath[],
): Promise<Array<{ path: string; reason: string }>> {
  const found: Array<{ path: string; reason: string }> = [];
  for (const change of changes) {
    // Removing a secret from the repository is never refused.
    if (change.deleted) continue;
    const byName = secretLookingPathReason(change.path);
    if (byName) {
      found.push({ path: change.path, reason: byName });
      continue;
    }
    const file = join(root, change.path);
    let isFile = false;
    try {
      // lstat: a symbolic link is committed as its link text, not the file
      // it points at.
      isFile = (await lstat(file)).isFile();
    } catch {
      continue; // gone since status: its deletion is what gets committed
    }
    if (isFile && (await containsPrivateKey(file))) {
      found.push({ path: change.path, reason: 'contains a private key' });
    }
  }
  return found;
}

/** `git add -A` for exactly `paths`, taken literally, fed on stdin. */
function addPaths(root: string, paths: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnGit(
      [
        ...repositoryArgs(root),
        'add',
        '-A',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      {
        cwd: root,
        env: { GIT_LITERAL_PATHSPECS: '1' },
        stdio: ['pipe', 'ignore', 'pipe'],
        // Part of the operator's Commit: `git add` runs the index hook in a
        // terminal too.
        hardening: { operatorHooks: true },
      },
    );
    let stderr = '';
    let killed = false;
    // Bounded like every other call here: a hook or filter that never
    // returns must not hold the request open.
    const timer = setTimeout(() => {
      killed = true;
      killGitProcessTree(child, 'SIGKILL');
    }, 120_000);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_DETAIL) stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !killed) resolve();
      else
        reject(
          new CodingGitCommandError(
            'add',
            killed
              ? 'git add did not finish in time and was stopped'
              : stderr.trim(),
          ),
        );
    });
    child.stdin?.end(`${paths.join('\0')}\0`);
  });
}

/**
 * The refusals both actions make before running anything: a git directory
 * outside the Project (a `.git` file pointing elsewhere), then repository
 * config Station will not run git with.
 */
async function refuseByConfig(
  root: string,
  projectRoot: string | undefined,
): Promise<
  | { refusal: CodingGitRefusal }
  | { location: Exclude<GitDirectoryVerdict, { verdict: 'outside' }> }
> {
  if (typeof projectRoot !== 'string') {
    return {
      refusal: { code: 'git-dir-outside-project', reason: 'no Project folder' },
    };
  }
  const location = await gitDirectoryInsideProject(root, projectRoot);
  if (location.verdict === 'outside') {
    return {
      refusal: { code: 'git-dir-outside-project', reason: location.reason },
    };
  }
  const verdict = await checkRepositoryConfig(
    root,
    'write',
    repositoryArgs(root),
  );
  if (verdict.ok) return { location };
  return {
    refusal:
      verdict.code === 'repository-config-refused'
        ? { code: verdict.code, keys: verdict.keys }
        : { code: verdict.code },
  };
}

/**
 * What both actions answer when the repository is not the one that was
 * checked any more. Asked immediately before the step that writes: the
 * checks take several git calls, and a `.git` (or a folder above it)
 * swapped meanwhile would otherwise be followed. A swap in the moment
 * between this and git opening the path is still followed.
 */
const CHANGED_WHILE_CHECKING: CodingGitRefusal = {
  code: 'git-dir-outside-project',
  reason: '.git changed while Station was checking it',
};

/**
 * Commits every change in `root` with `message`, after the refusals in the
 * header. Returns the new commit's id.
 */
export async function commitRepository(
  root: string,
  message: string,
  /** The Project's folder, symlink-resolved; `root` is it or inside it. */
  scope: { projectRoot: string },
): Promise<CodingGitOutcome<{ sha: string }>> {
  const checked = await refuseByConfig(root, scope?.projectRoot);
  if ('refusal' in checked) return { ok: false, refusal: checked.refusal };

  const changes = await changedPaths(root);
  if (changes.length === 0) {
    return { ok: false, refusal: { code: 'nothing-to-commit' } };
  }
  if (changes.length > MAX_COMMIT_PATHS) {
    return { ok: false, refusal: { code: 'too-many-changes' } };
  }
  const secrets = await secretFiles(root, changes);
  if (secrets.length > 0) {
    return { ok: false, refusal: { code: 'secrets', files: secrets } };
  }

  if (!(await checked.location.unchanged())) {
    return { ok: false, refusal: CHANGED_WHILE_CHECKING };
  }
  await addPaths(
    root,
    changes.map((change) => change.path),
  );
  // `add` changed the index and the object store; what must still hold is
  // that they are the same files.
  if (!(await checked.location.sameIdentity())) {
    return { ok: false, refusal: CHANGED_WHILE_CHECKING };
  }
  await git(root, ['commit', '-q', '-m', message], {
    timeout: 120_000,
    // As in the operator's terminal: the repository's hooks run, and the
    // operator's own signing applies (`gpg.*` in the repository's config
    // was refused above).
    hardening: { operatorSigning: true, operatorHooks: true },
  });
  const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  return { ok: true, value: { sha } };
}

export interface PushRequest {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
}

/**
 * Pushes a branch (the current one by default) to its remote's validated
 * URL. See the header.
 */
export async function pushRepository(
  root: string,
  request: PushRequest,
  options: {
    /** The Project's folder, symlink-resolved; `root` is it or inside it. */
    projectRoot: string;
    /** TEST ONLY (see `createCodingRoutes`): a validated https address
     * that a test's global `insteadOf` routes to a bare repository on disk. */
    allowFileProtocol?: boolean;
  },
): Promise<CodingGitOutcome<{ output: string; remote: string }>> {
  const checked = await refuseByConfig(root, options?.projectRoot);
  if ('refusal' in checked) return { ok: false, refusal: checked.refusal };

  let branch = request.branch;
  if (branch === undefined) {
    try {
      branch = (
        await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      ).trim();
    } catch {
      return { ok: false, refusal: { code: 'detached-head' } };
    }
  }
  if (!BRANCH_NAME.test(branch) || branch.includes('..')) {
    return { ok: false, refusal: { code: 'invalid-branch' } };
  }
  let commit: string;
  try {
    commit = (
      await git(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}^{commit}`,
      ])
    ).trim();
  } catch {
    return { ok: false, refusal: { code: 'invalid-branch' } };
  }

  // The remote plain `git push` would pick for this branch.
  const remote =
    request.remote ??
    (await configValue(root, `branch.${branch}.pushRemote`)) ??
    (await configValue(root, 'remote.pushDefault')) ??
    (await configValue(root, `branch.${branch}.remote`)) ??
    'origin';
  if (
    !REMOTE_NAME.test(remote) ||
    remote.includes('..') ||
    remote.endsWith('/')
  ) {
    return { ok: false, refusal: { code: 'invalid-remote-name' } };
  }
  // The address as the repository configures it. Not `remote get-url`,
  // which applies `insteadOf` rewrites: the repository's own rewrites are
  // refused above, and the operator's global ones apply at push time by
  // design (and only ever reach https or ssh).
  const url =
    (await configValue(root, `remote.${remote}.pushurl`)) ??
    (await configValue(root, `remote.${remote}.url`));
  if (url === undefined) {
    return { ok: false, refusal: { code: 'remote-missing', remote } };
  }
  const verdict = validateGitRemoteUrl(url);
  if (!verdict.ok) {
    return {
      ok: false,
      refusal: {
        code: `remote-${verdict.code}`,
        remote,
        url: redactRemoteUrl(url),
      },
    };
  }

  if (!(await checked.location.unchanged())) {
    return { ok: false, refusal: CHANGED_WHILE_CHECKING };
  }
  const output = await git(
    root,
    ['push', '--porcelain', '--', url, `${commit}:refs/heads/${branch}`],
    {
      timeout: 120_000,
      // The operator's Push runs `pre-push` as in a terminal.
      hardening: {
        operatorHooks: true,
        ...(options.allowFileProtocol === true
          ? { allowFileProtocol: true }
          : {}),
      },
    },
  );

  // What `git push <remote>` would have recorded: the remote-tracking ref,
  // and, when asked and not already set, the branch's upstream.
  await git(root, ['update-ref', `refs/remotes/${remote}/${branch}`, commit]);
  if (
    request.setUpstream &&
    (await configValue(root, `branch.${branch}.remote`)) === undefined
  ) {
    await git(root, ['config', `branch.${branch}.remote`, remote]);
    await git(root, [
      'config',
      `branch.${branch}.merge`,
      `refs/heads/${branch}`,
    ]);
  }
  return { ok: true, value: { output: output.trim(), remote } };
}
