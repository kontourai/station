import { type ReactNode, useRef, useState } from 'react';
import { CheckGlyph } from '../icons/Glyph';

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

export function GitTooltip({
  git,
  children,
}: {
  git: GitData;
  children: ReactNode;
}) {
  const [show, setShow] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const enter = () => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setShow(true), 300);
  };
  const leave = () => {
    clearTimeout(timeout.current);
    setShow(false);
  };

  return (
    <span
      className="git-tooltip-anchor"
      onPointerEnter={enter}
      onPointerLeave={leave}
      style={{ position: 'relative' }}
    >
      {children}
      {show && (
        <div className="git-tooltip">
          {git.lastCommit && (
            <div className="git-tooltip__section">
              <div className="git-tooltip__label">Last commit</div>
              <div className="git-tooltip__commit-msg">
                {git.lastCommit.message}
              </div>
              <div className="git-tooltip__commit-meta">
                {git.lastCommit.author} · {git.lastCommit.relativeTime} ·{' '}
                {git.lastCommit.sha}
              </div>
            </div>
          )}
          {git.changes.length > 0 && (
            <div className="git-tooltip__section">
              <div className="git-tooltip__label">Changes</div>
              <div className="git-tooltip__changes">
                {git.staged > 0 && (
                  <span className="git-tooltip__stat git-tooltip__stat--staged">
                    {git.staged} staged
                  </span>
                )}
                {git.unstaged > 0 && (
                  <span className="git-tooltip__stat git-tooltip__stat--unstaged">
                    {git.unstaged} modified
                  </span>
                )}
                {git.untracked > 0 && (
                  <span className="git-tooltip__stat git-tooltip__stat--untracked">
                    {git.untracked} untracked
                  </span>
                )}
              </div>
            </div>
          )}
          {(git.ahead > 0 || git.behind > 0) && (
            <div className="git-tooltip__section">
              <div className="git-tooltip__label">Remote</div>
              <div className="git-tooltip__changes">
                {git.ahead > 0 && (
                  <span className="git-tooltip__stat">↑{git.ahead} ahead</span>
                )}
                {git.behind > 0 && (
                  <span className="git-tooltip__stat">
                    ↓{git.behind} behind
                  </span>
                )}
              </div>
            </div>
          )}
          {git.changes.length === 0 && git.ahead === 0 && git.behind === 0 && (
            <div className="git-tooltip__section">
              <div className="git-tooltip__clean">
                <CheckGlyph /> Clean working tree
              </div>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
