/**
 * The git half of plugin publishing (#2374, epic #2323 S6): build one commit
 * from bytes Station already read, in a repository Station owns, and push it.
 *
 * Every git process here runs in a FRESH bare repository inside a private
 * temporary directory (`mkdtemp`, mode 0700), made with an empty template so
 * not even the operator's template hooks are copied in, and removed
 * afterwards. None of them is started in, pointed at, or given a path inside
 * the Project folder: the folder's files reach git only as bytes on stdin
 * (`hash-object --stdin`), and its `.gitignore` rules only as bytes this
 * module writes into its own skeleton tree. So nothing in the folder (its
 * `.git/config`, hooks, index, attributes, planted links) can configure,
 * redirect or run anything in these processes.
 *
 * Every call goes through `execGit`, so it carries the #2363 hardening (no
 * hooks, no fsmonitor, protocol allow-list, scrubbed environment). The three
 * network calls (`ls-remote`, `fetch`, `push`) get the operator's own
 * credential helpers and ssh settings, read from THIS repository, whose
 * config Station wrote.
 *
 * History (owner decision, #2374): the new commit's parent is the remote
 * branch's tip as fetched, and the push names that tip as the only value it
 * may replace (`--force-with-lease=<ref>:<tip>`, or "must not exist" for a
 * new branch). The refspec has no `+`: the commit is a child of the tip, so
 * the update is a fast-forward by construction, and the lease turns "the
 * remote moved during the publish" (forward, backward, or a branch created
 * meanwhile) into a refusal instead of an overwrite.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../../utils/git-exec.js';
import type { IgnoreOracle, SnapshotFile } from './plugin-publish-snapshot.js';
import { unsafeRelativePathReason } from './plugin-publish-snapshot.js';

const LOCAL_TIMEOUT_MS = 15_000;
const NETWORK_TIMEOUT_MS = 120_000;
const HASH_CONCURRENCY = 8;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface ExportGitOptions {
  /**
   * Also allow git's `file` transport. TEST ONLY: a test's global
   * `insteadOf` routes a validated https address to a bare repository on
   * disk. The route refuses to enable it outside Vitest.
   */
  allowFileProtocol?: boolean;
}

export interface ExportWorkspace {
  /** The private temporary directory; every git call's cwd. */
  root: string;
  gitDir: string;
  indexFile: string;
  /** Where the `.gitignore` bytes are laid out for `check-ignore`. */
  skeleton: string;
  options: ExportGitOptions;
}

export async function withExportWorkspace<T>(
  options: ExportGitOptions,
  run: (workspace: ExportWorkspace) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'station-plugin-publish-'));
  try {
    const workspace: ExportWorkspace = {
      root,
      gitDir: join(root, 'repo.git'),
      indexFile: join(root, 'index'),
      skeleton: join(root, 'tree'),
      options,
    };
    await mkdir(workspace.skeleton);
    await execGit(
      ['init', '--quiet', '--bare', '--template=', workspace.gitDir],
      { cwd: root, timeout: LOCAL_TIMEOUT_MS },
    );
    return await run(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function git(
  workspace: ExportWorkspace,
  args: string[],
  extra: {
    input?: Buffer | string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {},
) {
  return execGit([`--git-dir=${workspace.gitDir}`, ...args], {
    cwd: workspace.root,
    input: extra.input,
    env: extra.env,
    timeout: extra.timeout ?? LOCAL_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    hardening: { allowFileProtocol: workspace.options.allowFileProtocol },
  });
}

/**
 * `.gitignore` as git reads it, answered by `check-ignore --no-index` over a
 * skeleton tree holding only the directories the walk saw and the
 * `.gitignore` bytes it read. The operator's own `core.excludesFile` applies,
 * as in their terminal; the folder's `.git/info/exclude` is never read.
 */
export function ignoreOracle(workspace: ExportWorkspace): IgnoreOracle {
  const inSkeleton = (path: string) => {
    if (unsafeRelativePathReason(path) !== null) {
      throw new Error('unsafe path reached the ignore skeleton');
    }
    return join(workspace.skeleton, path);
  };
  return {
    async directory(path) {
      await mkdir(inSkeleton(path), { recursive: true });
    },
    async ignoreFile(directory, bytes) {
      const target =
        directory === ''
          ? join(workspace.skeleton, '.gitignore')
          : join(inSkeleton(directory), '.gitignore');
      await writeFile(target, bytes, { mode: 0o600 });
    },
    async ignored(paths) {
      if (paths.length === 0) return new Set();
      try {
        const { stdout } = await git(
          workspace,
          [
            `--work-tree=${workspace.skeleton}`,
            'check-ignore',
            '--no-index',
            '--stdin',
            '-z',
          ],
          { input: `${paths.join('\0')}\0` },
        );
        return new Set(stdout.split('\0').filter(Boolean));
      } catch (error) {
        // Exit 1 is "none of them is ignored".
        if ((error as { code?: unknown }).code === 1) return new Set();
        throw error;
      }
    },
  };
}

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * The operator's own git identity: `user.name`/`user.email` as git reads
 * them in Station's repository, whose local config holds neither, so they
 * come from the operator's global (or system) config. The Project folder's
 * config is never consulted. `null` when either is missing.
 */
export async function operatorIdentity(
  workspace: ExportWorkspace,
): Promise<GitIdentity | null> {
  const read = async (key: string) => {
    try {
      const { stdout } = await git(workspace, ['config', '--get', key]);
      const value = stdout.trim();
      return value === '' || /[\r\n<>]/.test(value) ? null : value;
    } catch {
      return null;
    }
  };
  const name = await read('user.name');
  const email = await read('user.email');
  return name && email ? { name, email } : null;
}

/** The remote branch's tip, or `null` when the branch does not exist. */
export async function remoteBranchTip(
  workspace: ExportWorkspace,
  url: string,
  branch: string,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const { stdout } = await git(workspace, ['ls-remote', '--', url, ref], {
    timeout: NETWORK_TIMEOUT_MS,
  });
  for (const line of stdout.split('\n')) {
    const [oid, name] = line.split('\t');
    // `ls-remote` matches patterns by suffix; only the exact ref counts.
    if (name === ref && OID.test(oid)) return oid;
  }
  return null;
}

/**
 * Fetches the branch's tip (depth 1: its parent history is not needed to
 * build a child of it) and returns what arrived.
 */
export async function fetchBranchTip(
  workspace: ExportWorkspace,
  url: string,
  branch: string,
): Promise<string> {
  await git(
    workspace,
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--depth=1',
      '--',
      url,
      `+refs/heads/${branch}:refs/station/base`,
    ],
    { timeout: NETWORK_TIMEOUT_MS },
  );
  const { stdout } = await git(workspace, [
    'rev-parse',
    '--verify',
    'refs/station/base^{commit}',
  ]);
  return stdout.trim();
}

async function hashBlobs(
  workspace: ExportWorkspace,
  files: readonly SnapshotFile[],
): Promise<string[]> {
  const oids = new Array<string>(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next;
      next += 1;
      // `--stdin` reads the bytes as given: no path, so no attribute, filter
      // or end-of-line conversion is looked up for it (and `--no-filters`
      // says so explicitly).
      const { stdout } = await git(
        workspace,
        ['hash-object', '-w', '--no-filters', '--stdin'],
        { input: files[index].bytes },
      );
      const oid = stdout.trim();
      if (!OID.test(oid)) throw new Error('hash-object returned no id');
      oids[index] = oid;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, worker),
  );
  return oids;
}

export interface BuiltCommit {
  commit: string;
  /** True when the tree equals the parent's: there is nothing to push. */
  unchanged: boolean;
}

/**
 * Writes the files as blobs, a tree of exactly those paths, and a commit
 * whose parent is `parent` (none for a new branch). Author and committer are
 * both `identity`.
 */
export async function buildCommit(
  workspace: ExportWorkspace,
  input: {
    files: readonly SnapshotFile[];
    parent: string | null;
    message: string;
    identity: GitIdentity;
  },
): Promise<BuiltCommit> {
  for (const file of input.files) {
    if (unsafeRelativePathReason(file.path) !== null) {
      throw new Error('unsafe path reached the commit');
    }
  }
  const oids = await hashBlobs(workspace, input.files);
  const indexEnv = { GIT_INDEX_FILE: workspace.indexFile };
  const entries = input.files
    .map(
      (file, index) =>
        `${file.executable ? '100755' : '100644'} ${oids[index]}\t${file.path}\0`,
    )
    .join('');
  await git(workspace, ['update-index', '--add', '-z', '--index-info'], {
    input: entries,
    env: indexEnv,
  });
  const tree = (
    await git(workspace, ['write-tree'], { env: indexEnv })
  ).stdout.trim();
  if (input.parent) {
    const parentTree = (
      await git(workspace, ['rev-parse', `${input.parent}^{tree}`])
    ).stdout.trim();
    if (parentTree === tree) return { commit: input.parent, unchanged: true };
  }
  const who = input.identity;
  const { stdout } = await git(
    workspace,
    [
      'commit-tree',
      tree,
      ...(input.parent ? ['-p', input.parent] : []),
      '-F',
      '-',
    ],
    {
      input: `${input.message}\n`,
      env: {
        GIT_AUTHOR_NAME: who.name,
        GIT_AUTHOR_EMAIL: who.email,
        GIT_COMMITTER_NAME: who.name,
        GIT_COMMITTER_EMAIL: who.email,
      },
    },
  );
  const commit = stdout.trim();
  if (!OID.test(commit)) throw new Error('commit-tree returned no id');
  return { commit, unchanged: false };
}

/**
 * Pushes `commit` to `refs/heads/<branch>` at `url`, replacing only
 * `expected` (the fetched tip; `null` = the branch must not exist yet).
 */
export async function pushCommit(
  workspace: ExportWorkspace,
  input: {
    url: string;
    commit: string;
    branch: string;
    expected: string | null;
  },
): Promise<void> {
  const ref = `refs/heads/${input.branch}`;
  await git(
    workspace,
    [
      'push',
      '--porcelain',
      '--no-verify',
      `--force-with-lease=${ref}:${input.expected ?? ''}`,
      '--',
      input.url,
      `${input.commit}:${ref}`,
    ],
    { timeout: NETWORK_TIMEOUT_MS },
  );
}

/** Why a network or plumbing step failed, from git's own words. */
export type ExportFailureCode =
  | 'remote-moved'
  | 'remote-auth-failed'
  | 'remote-unreachable'
  | 'git-timeout'
  | 'git-failed';

export function exportFailureCode(error: unknown): ExportFailureCode {
  const failure = error as {
    killed?: boolean;
    signal?: string;
    stdout?: unknown;
    stderr?: unknown;
  };
  if (failure.killed || failure.signal === 'SIGTERM') return 'git-timeout';
  // `push --porcelain` reports a rejected ref on stdout, the hint on stderr.
  const output = [failure.stdout, failure.stderr]
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
  if (
    /\[rejected\]|stale info|non-fast-forward|fetch first|updates were rejected|couldn't find remote ref/i.test(
      output,
    )
  ) {
    return 'remote-moved';
  }
  if (
    /authentication failed|permission denied|could not read (username|password)|terminal prompts disabled|access denied|\b403\b/i.test(
      output,
    )
  ) {
    return 'remote-auth-failed';
  }
  if (
    /could not resolve host|repository .*not found|does not appear to be a git repository|could not read from remote repository|connection (refused|timed out)/i.test(
      output,
    )
  ) {
    return 'remote-unreachable';
  }
  return 'git-failed';
}

/**
 * The address `station plugin install` accepts for the repository at `url`
 * (already validated by `validateGitRemoteUrl`): always
 * `https://…/<path>.git`, the form the install path classifies as a git
 * source. For an SSH remote this is DERIVED (same host and path over HTTPS),
 * which assumes the host also serves it over HTTPS; `derived` says so.
 */
export function pluginInstallSource(
  url: string,
  transport: 'https' | 'ssh',
): { source: string; derived: boolean } {
  const withGitSuffix = (path: string) => {
    const trimmed = path.replace(/\/+$/, '');
    return trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
  };
  const trimmed = url.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    const parsed = new URL(trimmed);
    const path = withGitSuffix(parsed.pathname);
    return transport === 'https'
      ? { source: `https://${parsed.host}${path}`, derived: false }
      : // The SSH port is not the HTTPS port, so it is dropped with the user.
        { source: `https://${parsed.hostname}${path}`, derived: true };
  }
  const scp = /^(?:[^@/:\s]+@)?([^@/:\s]+):(.+)$/.exec(trimmed);
  const host = scp?.[1] ?? '';
  const path = (scp?.[2] ?? '').replace(/^\/+/, '');
  return { source: `https://${host}/${withGitSuffix(path)}`, derived: true };
}
