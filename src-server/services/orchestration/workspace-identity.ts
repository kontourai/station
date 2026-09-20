import { realpath } from 'node:fs/promises';
import { execGit } from '../../utils/git-exec.js';

const RESOLVE_TIMEOUT_MS = 5_000;

export type WorkspaceIdentity =
  | { kind: 'git'; key: string; root: string }
  | { kind: 'directory'; key: string; root: string }
  | { kind: 'remote' };

/** Bounded canonical identity shared by turn admission and checkpoint restore. */
export async function resolveWorkspaceIdentity(
  cwd: string,
  executionOwner: 'local' | 'remote' = 'local',
): Promise<WorkspaceIdentity> {
  if (executionOwner === 'remote') return { kind: 'remote' };
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message))
      return { kind: 'directory', key: `directory:${root}`, root };
    throw new Error('workspace_identity_unavailable', { cause: error });
  }
}
