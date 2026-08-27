import type { DiscoveredRepo, ReposResult } from '../../hooks/useGitActions';

/**
 * Normalize a path for prefix comparison: strip a trailing slash so that
 * `/a/b` and `/a/b/` compare equal, while preserving the root `/`.
 */
function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

/**
 * True when `repoRoot` is a path-segment prefix of `filePath` (or equal). Uses
 * a boundary check so `/foo/bar` does not match `/foo/barbaz`.
 */
function isPathPrefix(repoRoot: string, filePath: string): boolean {
  const root = stripTrailingSlash(repoRoot);
  const file = stripTrailingSlash(filePath);
  if (file === root) return true;
  return file.startsWith(`${root}/`);
}

/**
 * Find the discovered repo that contains `filePath` — the repo whose `root` is
 * the longest path-prefix of the file path. Returns null when no repo contains
 * the file (or no file is provided).
 */
export function repoForFile(
  repos: DiscoveredRepo[],
  filePath: string | null | undefined,
): DiscoveredRepo | null {
  if (!filePath) return null;
  let best: DiscoveredRepo | null = null;
  for (const repo of repos) {
    if (isPathPrefix(repo.root, filePath)) {
      if (!best || repo.root.length > best.root.length) {
        best = repo;
      }
    }
  }
  return best;
}

/**
 * Resolve the active repo for the toolbar, in priority order:
 *   1. A repo pinned via the switcher (matched by `root`).
 *   2. The repo containing the active file (longest-prefix match).
 *   3. The workspace itself when `workspaceIsRepo`.
 *   4. The first discovered repo.
 *   5. None.
 */
export function resolveActiveRepo(
  reposResult: ReposResult | undefined | null,
  activeFile: string | null | undefined,
  pinnedRoot: string | null,
): DiscoveredRepo | null {
  if (!reposResult) return null;
  const { repos, workspace, workspaceIsRepo } = reposResult;

  if (pinnedRoot) {
    const pinned = repos.find((r) => r.root === pinnedRoot);
    if (pinned) return pinned;
  }

  const byFile = repoForFile(repos, activeFile);
  if (byFile) return byFile;

  if (workspaceIsRepo) {
    const workspaceRepo = repos.find((r) => r.root === workspace);
    if (workspaceRepo) return workspaceRepo;
    if (repos.length > 0) return repos[0];
  }

  return repos[0] ?? null;
}
