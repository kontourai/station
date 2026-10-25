import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { execGit, killGitProcessTree, spawnGit } from '../../utils/git-exec.js';
import { repositoryArgs } from './git-directory-confinement.js';
import {
  openRepositorySnapshot,
  resolveProjectRepositoryForRead,
} from './git-read-repository.js';
import { judgeRepositoryConfigEntries } from './git-repository-config.js';

const GIT_TIMEOUT_MS = 10_000;

function hasGitlinks(root: string, repoArgs: string[]): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawnGit([...repoArgs, 'ls-files', '--stage', '-z'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let found = false;
    let prefix = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGitProcessTree(child, 'SIGKILL');
    }, GIT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (found) return;
      let start = 0;
      while (start < chunk.length) {
        const nul = chunk.indexOf(0, start);
        const end = nul === -1 ? chunk.length : nul;
        // Only the mode prefix is retained, even across pipe chunk boundaries.
        prefix += chunk
          .subarray(start, Math.min(end, start + 7 - prefix.length))
          .toString('ascii');
        if (prefix === '160000 ') {
          found = true;
          return;
        }
        if (nul === -1) break;
        prefix = '';
        start = nul + 1;
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve(found);
      else reject(new WorkspaceCommitPinError('workspace-unavailable'));
    });
  });
}

export class WorkspaceCommitPinError extends Error {
  constructor(
    readonly code:
      | 'not-a-repository'
      | 'repository-refused'
      | 'unborn'
      | 'workspace-changed'
      | 'workspace-unavailable',
    options?: ErrorOptions,
  ) {
    super(`Workspace commit pin refused: ${code}`, options);
    this.name = 'WorkspaceCommitPinError';
  }
}

export type WorkspaceCommitPin = {
  commit: string;
  statusDigest: `sha256:${string}`;
} & (
  | { submodules: 'none'; clean: boolean }
  | { submodules: 'unobserved'; clean: false }
);

/**
 * Observes HEAD and status together; it does not lock workspace writers.
 * Hardened Git never enters submodules. An index containing gitlinks returns
 * submodules: 'unobserved' and clean: false, even if parent status is empty.
 * Capture callers must refuse that pin rather than claim a clean capture.
 */
// UNWIRED(#4149): capture routes check this pin in the next lane.
export async function pinWorkspace(dir: string): Promise<WorkspaceCommitPin> {
  try {
    const root = await realpath(dir);
    const repository = await resolveProjectRepositoryForRead(root, root, {
      timeoutMs: GIT_TIMEOUT_MS,
      storage: 'read',
    });
    if (!repository.ok) {
      throw new WorkspaceCommitPinError(
        repository.state === 'not-a-repository'
          ? 'not-a-repository'
          : 'repository-refused',
      );
    }
    // A folder without its own repository must never pin an ancestor's HEAD.
    if (repository.top !== root)
      throw new WorkspaceCommitPinError('not-a-repository');
    const opened = await openRepositorySnapshot(
      { ...repository, repoArgs: repositoryArgs(root) },
      { index: true, timeoutMs: GIT_TIMEOUT_MS },
    );
    if (!opened.ok) throw new WorkspaceCommitPinError('repository-refused');
    const { snapshot } = opened;
    try {
      if (!judgeRepositoryConfigEntries(snapshot.config, 'read').ok)
        throw new WorkspaceCommitPinError('repository-refused');
      const git = async (args: string[]) =>
        (
          await execGit([...snapshot.repoArgs, ...args], {
            cwd: root,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          })
        ).stdout;
      const records = (
        await git([
          'status',
          '--porcelain=v2',
          '--branch',
          '--no-ahead-behind',
          '-z',
          '--untracked-files=all',
        ])
      ).split('\0');
      let commit: string | undefined;
      while (records[0]?.startsWith('# ')) {
        const header = records.shift()!;
        if (header.startsWith('# branch.oid '))
          commit = header.slice('# branch.oid '.length);
      }
      if (commit === '(initial)') throw new WorkspaceCommitPinError('unborn');
      if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
        throw new WorkspaceCommitPinError('workspace-unavailable');
      const status = records.join('\0');
      const gitlinks = await hasGitlinks(root, snapshot.repoArgs);
      if (!(await repository.unchanged()))
        throw new WorkspaceCommitPinError('workspace-changed');
      const pin = {
        commit,
        statusDigest:
          `sha256:${createHash('sha256').update(status).digest('hex')}` as const,
      };
      return gitlinks
        ? { ...pin, submodules: 'unobserved', clean: false }
        : { ...pin, submodules: 'none', clean: status.length === 0 };
    } finally {
      await snapshot.dispose();
    }
  } catch (error) {
    if (error instanceof WorkspaceCommitPinError) throw error;
    throw new WorkspaceCommitPinError('workspace-unavailable', {
      cause: error,
    });
  }
}
