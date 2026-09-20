import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { execGit } from '../../utils/git-exec.js';

const RESOLVE_TIMEOUT_MS = 5_000;

export type WorkspaceIdentity =
  | { kind: 'git'; key: string; root: string }
  | { kind: 'directory'; key: string; root: string }
  | { kind: 'remote' };

/** Bounded canonical identity shared by turn admission and checkpoint restore. */
export async function resolveWorkspaceIdentity(
  cwd: string,
): Promise<WorkspaceIdentity> {
  // A path foreign to this host belongs to the remote execution owner.
  if (
    !isAbsolute(cwd) &&
    (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\'))
  )
    return { kind: 'remote' };
  const root = await realpath(cwd);
  try {
    const gitRoot = (
      await execGit(['rev-parse', '--show-toplevel'], {
        cwd: root,
        timeout: RESOLVE_TIMEOUT_MS,
        encoding: 'utf-8',
      })
    ).stdout.trim();
    const canonicalGitRoot = await realpath(gitRoot);
    return {
      kind: 'git',
      key: `git:${canonicalGitRoot}`,
      root: canonicalGitRoot,
    };
  } catch {
    return { kind: 'directory', key: `directory:${root}`, root };
  }
}
