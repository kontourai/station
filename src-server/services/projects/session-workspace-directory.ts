import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { expandTilde } from '../../utils/paths.js';
import { listVerifiedWorktrees } from './verified-worktrees.js';

interface SessionRecord {
  threadId: string;
  projectSlug?: string;
  cwd?: string;
}

const WORKTREE_LIST_TIMEOUT_MS = 5_000;

function canonical(path: string): string | undefined {
  try {
    return realpathSync(resolve(expandTilde(path)));
  } catch {
    return undefined;
  }
}

function isWithinOrSame(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * The directory a file read for one session targets (#2476): the session's own
 * working directory, when the server can vouch that it is this project's —
 * the checkout itself (answered `undefined`: read the checkout), a folder
 * inside it, or a git worktree registered to the checkout's repository.
 * Anything else, a session the caller may not read, or another project's
 * session is `null` — refused, never answered from the checkout, which would
 * show a different file under the name the model used.
 *
 * Nothing here trusts what the session was STARTED with: the directory is the
 * session's recorded `cwd`, realpath-resolved, and checked every time against
 * the checkout and against the worktrees that verifiably belong to its
 * repository (`listVerifiedWorktrees` — a listed worktree counts only when its
 * own `.git` leads back to the repository, since the listing itself is
 * writable by anyone who can write the checkout).
 */
export async function sessionWorkspaceDirectoryFor(
  deps: {
    canRead: (thread: string) => boolean;
    listSessions: () => Promise<readonly SessionRecord[]>;
    projectDirectory: (projectSlug: string) => Promise<string | undefined>;
    worktrees?: (projectDirectory: string) => Promise<readonly string[]>;
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
  const configured = await deps.projectDirectory(projectSlug);
  const project = configured ? canonical(configured) : undefined;
  if (!project) return null;
  if (!session.cwd) return undefined;
  const cwd = canonical(session.cwd);
  if (!cwd) return null;
  if (cwd === project) return undefined;
  if (isWithinOrSame(project, cwd)) return cwd;
  const worktrees = await (
    deps.worktrees ??
    ((root: string) => listVerifiedWorktrees(root, WORKTREE_LIST_TIMEOUT_MS))
  )(project);
  return worktrees.some((worktree) => canonical(worktree) === cwd) ? cwd : null;
}
