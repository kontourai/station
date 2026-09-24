import type { WorkspaceIsolationMetadata } from '@kontourai/station-contracts/workspace-isolation';

interface SessionRecord {
  threadId: string;
  projectSlug?: string;
  workspaceIsolation?: WorkspaceIsolationMetadata;
}

/**
 * The directory a file read for one session targets (#2476): its isolated
 * worktree, `undefined` when it runs in the project checkout, or `null` —
 * refused — when the caller may not read the session or the session is not
 * this project's. Authority is checked first, so a session the caller cannot
 * read and one that does not exist answer the same.
 */
export async function sessionWorkspaceDirectoryFor(
  deps: {
    canRead: (thread: string) => boolean;
    listSessions: () => Promise<readonly SessionRecord[]>;
  },
  projectSlug: string,
  thread: string,
): Promise<string | undefined | null> {
  if (!deps.canRead(thread)) return null;
  const session = (await deps.listSessions()).find(
    (candidate) =>
      candidate.threadId === thread && candidate.projectSlug === projectSlug,
  );
  if (!session) return null;
  const isolation = session.workspaceIsolation;
  return isolation?.mode === 'worktree' && isolation.path
    ? isolation.path
    : undefined;
}
