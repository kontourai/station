import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execGit } from '../../utils/git-exec.js';
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
    common = realpathSync(
      (
        await execGit(
          [
            ...repository.repoArgs,
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ],
          opts,
        )
      ).stdout.trim(),
    );
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
    const checkout = leadsBackTo(line.slice('worktree '.length), common);
    if (checkout) verified.push(checkout);
  }
  return verified;
}

/** `path`'s realpath when its `.git` leads back to `common`, else null. */
function leadsBackTo(path: string, common: string): string | null {
  try {
    const checkout = realpathSync(path);
    const dotGit = join(checkout, '.git');
    if (statSync(dotGit).isDirectory())
      return realpathSync(dotGit) === common ? checkout : null;
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf-8'));
    if (!pointer) return null;
    const gitdir = realpathSync(resolve(checkout, pointer[1].trim()));
    return dirname(gitdir) === join(common, 'worktrees') ? checkout : null;
  } catch {
    return null;
  }
}
