import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execGit } from '../../utils/git-exec.js';
import { readSmallRegularFile } from './git-directory-confinement.js';
import { resolveProjectRepositoryForRead } from './git-read-repository.js';

/** Enough for any real set of session worktrees; bounds a hostile one. */
const WORKTREE_LIST_LIMIT = 256;

/**
 * The checkouts git reports as worktrees of the repository containing
 * `projectRoot` (the main checkout included), each realpath-resolved, bounded
 * by a deadline and {@link WORKTREE_LIST_LIMIT} (#2412 review).
 *
 * `git worktree list` reads `.git/worktrees/<name>/gitdir`, which the
 * repository's own writers control, so a listing alone would let them name
 * any folder. A listed checkout counts only when its own `.git` leads back
 * to this repository: the main checkout's `.git` IS the common directory,
 * and a linked one's `.git` file names a `gitdir` inside
 * `<common>/worktrees/`. Claiming a folder that way takes writing into that
 * folder, which the claimant could then already do. Anything unreadable is
 * left out.
 *
 * "The repository containing `projectRoot`" is itself only trusted when it
 * is the Project's own (`resolveProjectRepositoryForRead`): a `.git` planted
 * at the Project's root naming another repository would otherwise make that
 * repository's checkouts "worktrees of the Project". Such a Project has no
 * worktrees. git is then asked with that repository named, not discovered,
 * and the listing is dropped if the repository changed while it was read.
 */
export async function listVerifiedWorktrees(
  projectRoot: string,
  timeoutMs: number,
): Promise<readonly string[]> {
  let common: string;
  let listing: string;
  try {
    const repository = await resolveProjectRepositoryForRead(
      projectRoot,
      projectRoot,
      { timeoutMs },
    );
    if (!repository.ok) return [];
    const opts = {
      cwd: repository.top,
      encoding: 'utf-8' as const,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    };
    // The common directory the check validated, not one asked for again.
    common = repository.commonDir;
    listing = (
      await execGit(
        [...repository.repoArgs, 'worktree', 'list', '--porcelain'],
        opts,
      )
    ).stdout;
    if (!(await repository.unchanged())) return [];
  } catch {
    return [];
  }
  const verified: string[] = [];
  for (const line of listing.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    if (verified.length >= WORKTREE_LIST_LIMIT) break;
    const checkout = await leadsBackTo(line.slice('worktree '.length), common);
    if (checkout) verified.push(checkout);
  }
  return verified;
}

/**
 * `path`'s realpath when its `.git` leads back to `common`, else null.
 * `path` is whatever the repository's writers registered, so its `.git` is
 * read as a member-controlled file: not followed if it is a link, not
 * waited on if it is a FIFO, not read if it is not small.
 */
async function leadsBackTo(
  path: string,
  common: string,
): Promise<string | null> {
  try {
    const checkout = await realpath(path);
    const dotGit = join(checkout, '.git');
    const stats = await lstat(dotGit);
    if (stats.isDirectory()) {
      return (await realpath(dotGit)) === common ? checkout : null;
    }
    if (!stats.isFile()) return null;
    const pointer = /^gitdir: ([^\r\n]+)/.exec(
      (await readSmallRegularFile(dotGit, 8 * 1024))?.toString('utf8') ?? '',
    );
    if (!pointer) return null;
    const gitdir = await realpath(resolve(checkout, pointer[1].trim()));
    return dirname(gitdir) === join(common, 'worktrees') ? checkout : null;
  } catch {
    return null;
  }
}
