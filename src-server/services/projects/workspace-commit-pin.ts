import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { execGit } from '../../utils/git-exec.js';
import { repositoryArgs } from './git-directory-confinement.js';
import {
  openRepositorySnapshot,
  resolveProjectRepositoryForRead,
} from './git-read-repository.js';
import { judgeRepositoryConfigEntries } from './git-repository-config.js';

const GIT_TIMEOUT_MS = 10_000;

export class WorkspaceCommitPinError extends Error {
  constructor(
    readonly code:
      | 'not-a-repository'
      | 'repository-refused'
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
  clean: boolean;
  statusDigest: `sha256:${string}`;
};

/** Observes HEAD and porcelain status; it does not lock workspace writers. */
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
      const commit = (
        await git(['rev-parse', '--verify', 'HEAD^{commit}'])
      ).trim();
      const status = await git([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]);
      if (!(await repository.unchanged()))
        throw new WorkspaceCommitPinError('workspace-changed');
      return {
        commit,
        clean: status.length === 0,
        statusDigest: `sha256:${createHash('sha256').update(status).digest('hex')}`,
      };
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
