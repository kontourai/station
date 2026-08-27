import { GitTooltip } from './GitTooltip';

interface GitData {
  branch: string;
  changes: string[];
  staged: number;
  unstaged: number;
  untracked: number;
  lastCommit: {
    sha: string;
    author: string;
    relativeTime: string;
    message: string;
  } | null;
  ahead: number;
  behind: number;
}

export function GitBadge({
  git,
  className = '',
}: {
  git: GitData;
  className?: string;
}) {
  return (
    <GitTooltip git={git}>
      <span className={`git-badge ${className}`.trim()}>
        <span className="git-badge__branch">⎇ {git.branch}</span>
        {git.changes.length > 0 && (
          <span className="git-badge__dirty">+{git.changes.length}</span>
        )}
      </span>
    </GitTooltip>
  );
}
