import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Global git options that bind a command to `root`'s OWN repository
 * (`<root>/.git`), or null when `root` has no `.git` entry.
 *
 * Run from a directory without them, git searches upward for a repository.
 * A directory with no `.git`, or with one git cannot use (an empty directory,
 * say), is then answered for by whatever checkout encloses it — the one a
 * Station home may live inside. With an explicit `--git-dir` git never
 * searches: an unusable `.git` is an error, not a fall-through. The working
 * tree stays the command's cwd, which callers set to `root`.
 */
export function ownGitRepositoryArgs(root: string): string[] | null {
  const gitDir = join(root, '.git');
  return existsSync(gitDir) ? ['--git-dir', gitDir] : null;
}
