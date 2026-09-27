import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Global git options that bind a command to `root`'s OWN repository
 * (`<root>/.git`) and working tree (`root`), or null when `root` has no
 * `.git` entry.
 *
 * Run from a directory without them, git searches upward for a repository.
 * A directory with no `.git`, or with one git cannot use (an empty directory,
 * say), is then answered for by whatever checkout encloses it — the one a
 * Station home may live inside. With an explicit `--git-dir` git never
 * searches: an unusable `.git` is an error, not a fall-through. The explicit
 * `--work-tree` keeps a pull's checkout at `root` whatever the caller's cwd
 * or the repository's `core.worktree` says.
 *
 * A `.git` gitfile is accepted, as git itself accepts it: a plugin the
 * operator installed from a worktree or submodule checkout has one, and its
 * update pulls through it. Sources Station does not trust never carry one:
 * dependency copies leave every `.git` spelling out, and local registry
 * sources holding one are refused.
 */
export function ownGitRepositoryArgs(root: string): string[] | null {
  const gitDir = join(root, '.git');
  return existsSync(gitDir) ? ['--git-dir', gitDir, '--work-tree', root] : null;
}
