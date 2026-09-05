import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type DiscoveredRepo,
  useGitBranchesQuery,
  useGitCheckoutMutation,
  useGitCommitMutation,
  useGitPushMutation,
  useReposQuery,
} from '../../hooks/useGitActions';
import { useGitStatus } from '../../hooks/useGitStatus';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { ArrowDownGlyph, CheckGlyph, PinGlyph } from '../icons/Glyph';
import { resolveActiveRepo } from './activeRepo';
import './BranchToolbar.css';
import { SkeletonList } from '../state';

/**
 * In-app git toolbar for the coding layout. It is multi-repo aware: it discovers
 * every git repo under the workspace and operates on the *active repo* —
 * (1) a repo pinned via the switcher, else (2) the repo containing the active
 * file (longest-prefix match), else (3) the workspace itself when it is a repo,
 * else (4) the first discovered repo.
 *
 * When the active file changes, the active repo auto-follows it (unless a repo
 * is pinned). Branch switching, status, commit, and push all target the active
 * repo's root. Every mutation invalidates the git-status query so the toolbar
 * reflects the new repository state.
 */
export function BranchToolbar({
  workingDir,
  activeFile,
  onActiveRepoChange,
}: {
  workingDir: string;
  activeFile?: string | null;
  // Reports the resolved active-repo root upward so sibling panels (e.g. the
  // diff view) operate on the same repo instead of the raw workspace.
  onActiveRepoChange?: (root: string | null) => void;
}) {
  const reposQuery = useReposQuery(workingDir || null);
  const reposResult = reposQuery.data;
  const repos = reposResult?.repos ?? [];

  // Pinned repo root (set via the repo switcher). Null = follow the active file.
  const [pinnedRoot, setPinnedRoot] = useState<string | null>(null);

  // If a pinned repo disappears from discovery (e.g. workspace changed), clear
  // the pin so we fall back to auto-follow.
  useEffect(() => {
    if (pinnedRoot && !repos.some((r) => r.root === pinnedRoot)) {
      setPinnedRoot(null);
    }
  }, [pinnedRoot, repos]);

  const activeRepo = useMemo(
    () => resolveActiveRepo(reposResult, activeFile, pinnedRoot),
    [reposResult, activeFile, pinnedRoot],
  );

  // Every git op targets the active repo's root, not the raw workingDir.
  const repoRoot = activeRepo?.root ?? null;

  // Surface the active repo so sibling panels (diff view) follow the same repo.
  useEffect(() => {
    onActiveRepoChange?.(repoRoot);
  }, [repoRoot, onActiveRepoChange]);

  const status = useGitStatus(repoRoot);
  const branchesQuery = useGitBranchesQuery(repoRoot);
  const checkout = useGitCheckoutMutation(repoRoot ?? '');
  const commit = useGitCommitMutation(repoRoot ?? '');
  const push = useGitPushMutation(repoRoot ?? '');

  const gitStatus = status.data?.isRepo ? status.data : null;
  const currentBranch = gitStatus?.branch ?? activeRepo?.branch ?? null;
  const dirtyCount = gitStatus
    ? gitStatus.staged + gitStatus.unstaged + gitStatus.untracked
    : 0;
  // "Clean" is a positive assertion the query must actually have resolved —
  // a loading or errored git-status query knows nothing about the tree, and
  // treating that as "clean" both lies to the user and (via the disabled
  // attributes below) silently takes away their ability to commit. Loading,
  // errored, and genuinely-clean are three distinct states; only the last one
  // may render as clean.
  const statusResolved = !status.isLoading && !status.isError;
  const isClean = statusResolved && !!gitStatus && dirtyCount === 0;
  const ahead = gitStatus?.ahead ?? 0;
  const behind = gitStatus?.behind ?? 0;

  const [message, setMessage] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [newBranchMode, setNewBranchMode] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const newBranchInputRef = useRef<HTMLInputElement>(null);

  // ── Repo switcher state ────────────────────────────────────────────────
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [repoActiveIndex, setRepoActiveIndex] = useState(0);
  const repoMenuId = useId();
  const repoTriggerRef = useRef<HTMLButtonElement>(null);
  const repoMenuRef = useRef<HTMLDivElement>(null);
  // The switcher is only meaningful when there is a genuine choice between
  // multiple discovered repos. A single repo (or a repo-rooted workspace)
  // renders a static label instead.
  const showSwitcher = repos.length > 1;

  const branches = branchesQuery.data ?? [];

  // Move focus into the branch menu when it opens so arrow keys work.
  useEffect(() => {
    if (menuOpen && !newBranchMode) menuRef.current?.focus();
  }, [menuOpen, newBranchMode]);

  // Focus the new-branch input when entering create mode.
  useEffect(() => {
    if (newBranchMode) newBranchInputRef.current?.focus();
  }, [newBranchMode]);

  // Move focus into the repo menu when it opens.
  useEffect(() => {
    if (repoMenuOpen) repoMenuRef.current?.focus();
  }, [repoMenuOpen]);

  // Close menus on outside click.
  useEffect(() => {
    if (!menuOpen && !repoMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setRepoMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen, repoMenuOpen]);

  const openMenu = () => {
    setNewBranchMode(false);
    setActiveIndex(
      Math.max(
        0,
        branches.findIndex((b) => b.name === currentBranch),
      ),
    );
    setMenuOpen(true);
  };

  const closeMenu = () => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  };

  const selectBranch = (name: string) => {
    setMenuOpen(false);
    if (name === currentBranch) return;
    checkout.mutate({ branch: name });
  };

  const createBranch = () => {
    const name = newBranchName.trim();
    if (!name) return;
    setMenuOpen(false);
    setNewBranchMode(false);
    setNewBranchName('');
    checkout.mutate({ branch: name, create: true });
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!menuOpen) openMenu();
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (newBranchMode) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(branches.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const branch = branches[activeIndex];
      if (branch) selectBranch(branch.name);
    }
  };

  // ── Repo switcher handlers ─────────────────────────────────────────────
  const openRepoMenu = () => {
    setRepoActiveIndex(
      Math.max(
        0,
        repos.findIndex((r) => r.root === repoRoot),
      ),
    );
    setRepoMenuOpen(true);
  };

  const closeRepoMenu = () => {
    setRepoMenuOpen(false);
    repoTriggerRef.current?.focus();
  };

  const selectRepo = (repo: DiscoveredRepo) => {
    setRepoMenuOpen(false);
    setPinnedRoot(repo.root);
  };

  const followActiveFile = () => {
    setRepoMenuOpen(false);
    setPinnedRoot(null);
  };

  const onRepoTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!repoMenuOpen) openRepoMenu();
    }
  };

  const onRepoMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeRepoMenu();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setRepoActiveIndex((i) => Math.min(repos.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setRepoActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const repo = repos[repoActiveIndex];
      if (repo) selectRepo(repo);
    }
  };

  const onCommit = () => {
    if (isClean || !message.trim()) return;
    commit.mutate(
      { message: message.trim() },
      { onSuccess: () => setMessage('') },
    );
  };

  const error =
    checkout.error || commit.error || push.error || branchesQuery.error;

  // No repos discovered. Subtle, non-error inline toolbar note — a short
  // status phrase inside a horizontal toolbar row, not a list/card placeholder,
  // so this deliberately stays a plain inline span rather than adopting the
  // canonical `Empty` component (which renders a framed, centered card even
  // in its `compact` variant — a poor visual fit for a toolbar strip). See
  // the state-primitives (#192) plan's Wave 2 "Workflow & connection-surface
  // convergence" task.
  // archive#771: an errored discovery query also settles with `repos = []`
  // (the `dataonly` fallback below), which used to read identically to
  // "no repository here" — a real read failure with no trace, and no way to
  // retry short of reloading the whole layout.
  if (!reposQuery.isLoading && reposQuery.isError && repos.length === 0) {
    return (
      <div className="branch-toolbar branch-toolbar--no-repo" ref={rootRef}>
        <span className="branch-toolbar__no-repo-text" role="alert">
          Couldn’t discover git repositories.{' '}
          <button
            type="button"
            className="button button--link"
            onClick={() => reposQuery.refetch()}
          >
            Retry
          </button>
        </span>
      </div>
    );
  }
  if (!reposQuery.isLoading && repos.length === 0) {
    return (
      <div className="branch-toolbar branch-toolbar--no-repo" ref={rootRef}>
        <span className="branch-toolbar__no-repo-text">
          No git repository in this folder
        </span>
      </div>
    );
  }

  const hasActions = !!repoRoot;

  return (
    <div className="branch-toolbar" ref={rootRef}>
      {/* ── Repo switcher / label ──────────────────────────────────────── */}
      <div className="branch-toolbar__repo">
        {showSwitcher ? (
          <>
            <button
              ref={repoTriggerRef}
              type="button"
              className="branch-toolbar__repo-trigger"
              aria-haspopup="menu"
              aria-expanded={repoMenuOpen}
              aria-controls={repoMenuOpen ? repoMenuId : undefined}
              aria-label={
                activeRepo
                  ? `Active repository: ${activeRepo.name}. Switch repository`
                  : 'Switch repository'
              }
              onClick={() =>
                repoMenuOpen ? setRepoMenuOpen(false) : openRepoMenu()
              }
              onKeyDown={onRepoTriggerKeyDown}
            >
              <span className="branch-toolbar__repo-icon" aria-hidden="true">
                ▦
              </span>
              <span className="branch-toolbar__repo-name">
                {activeRepo?.name ?? 'Select repo'}
              </span>
              {pinnedRoot && (
                <span
                  className="branch-toolbar__repo-pin"
                  title="Pinned — not following active file"
                  aria-hidden="true"
                >
                  <PinGlyph />
                </span>
              )}
              <ArrowDownGlyph className="choice-caret" />
            </button>

            {repoMenuOpen && (
              <div
                id={repoMenuId}
                ref={repoMenuRef}
                className="branch-toolbar__menu branch-toolbar__repo-menu"
                role="menu"
                aria-label="Repositories"
                tabIndex={-1}
                onKeyDown={onRepoMenuKeyDown}
              >
                {repos.map((repo, index) => (
                  <button
                    key={repo.root}
                    type="button"
                    role="menuitemradio"
                    aria-checked={repo.root === repoRoot}
                    className={`branch-toolbar__menu-item branch-toolbar__repo-item${
                      index === repoActiveIndex
                        ? ' branch-toolbar__menu-item--active'
                        : ''
                    }`}
                    onMouseEnter={() => setRepoActiveIndex(index)}
                    onClick={() => selectRepo(repo)}
                  >
                    <span
                      className="branch-toolbar__menu-item-check"
                      aria-hidden="true"
                    >
                      {repo.root === repoRoot ? <CheckGlyph /> : null}
                    </span>
                    <span className="branch-toolbar__repo-item-body">
                      <span className="branch-toolbar__menu-item-name">
                        {repo.name}
                      </span>
                      <span className="branch-toolbar__repo-item-meta">
                        <span className="branch-toolbar__repo-item-path">
                          {repo.relativePath}
                        </span>
                        <span className="branch-toolbar__repo-item-branch">
                          ⎇ {repo.branch}
                        </span>
                      </span>
                    </span>
                  </button>
                ))}

                <div className="branch-toolbar__menu-divider" />

                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={pinnedRoot === null}
                  className="branch-toolbar__menu-item branch-toolbar__menu-item--follow"
                  disabled={pinnedRoot === null}
                  onClick={followActiveFile}
                >
                  <span
                    className="branch-toolbar__menu-item-check"
                    aria-hidden="true"
                  >
                    {pinnedRoot === null ? <CheckGlyph /> : null}
                  </span>
                  <span className="branch-toolbar__menu-item-name">
                    Follow active file
                  </span>
                </button>
              </div>
            )}
          </>
        ) : (
          <span className="branch-toolbar__repo-label" title={activeRepo?.root}>
            <span className="branch-toolbar__repo-icon" aria-hidden="true">
              ▦
            </span>
            {activeRepo?.name ?? ''}
          </span>
        )}
      </div>

      {/* ── Branch switcher ────────────────────────────────────────────── */}
      <div className="branch-toolbar__switcher">
        <button
          ref={triggerRef}
          type="button"
          className="branch-toolbar__branch-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-label={
            currentBranch
              ? `Current branch: ${currentBranch}. Switch branch`
              : 'Switch branch'
          }
          disabled={checkout.isPending || !hasActions}
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
          onKeyDown={onTriggerKeyDown}
        >
          <span className="branch-toolbar__branch-icon" aria-hidden="true">
            ⎇
          </span>
          <span className="branch-toolbar__branch-name">
            {checkout.isPending ? 'Switching…' : (currentBranch ?? 'No branch')}
          </span>
          <ArrowDownGlyph className="choice-caret" />
        </button>

        {menuOpen && (
          <div
            id={menuId}
            ref={menuRef}
            className="branch-toolbar__menu"
            role="menu"
            aria-label="Branches"
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
          >
            {branchesQuery.isLoading && (
              <SkeletonList
                count={3}
                withIcon={false}
                label="Loading branches"
              />
            )}
            {/* archive#771: a failed branch list also settles as
                `branches = []`; say so instead of the indistinguishable
                "No branches" — the inline error banner below the toolbar
                already carries `branchesQuery.error`, but this is the
                surface a user opening the menu actually stares at. */}
            {!branchesQuery.isLoading && branchesQuery.isError && (
              <div className="branch-toolbar__menu-status" role="alert">
                Couldn’t load branches.{' '}
                <button
                  type="button"
                  className="button button--link"
                  onClick={() => branchesQuery.refetch()}
                >
                  Retry
                </button>
              </div>
            )}
            {!branchesQuery.isLoading &&
              !branchesQuery.isError &&
              branches.length === 0 && (
                <div className="branch-toolbar__menu-status">No branches</div>
              )}
            {branches.map((branch, index) => (
              <button
                key={branch.name}
                type="button"
                role="menuitemradio"
                aria-checked={branch.name === currentBranch}
                className={`branch-toolbar__menu-item${
                  index === activeIndex
                    ? ' branch-toolbar__menu-item--active'
                    : ''
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectBranch(branch.name)}
              >
                <span
                  className="branch-toolbar__menu-item-check"
                  aria-hidden="true"
                >
                  {branch.name === currentBranch ? <CheckGlyph /> : null}
                </span>
                <span className="branch-toolbar__menu-item-name">
                  {branch.name}
                </span>
              </button>
            ))}

            <div className="branch-toolbar__menu-divider" />

            {newBranchMode ? (
              <form
                className="branch-toolbar__new-branch"
                onSubmit={(e) => {
                  e.preventDefault();
                  createBranch();
                }}
              >
                <input
                  ref={newBranchInputRef}
                  type="text"
                  className="branch-toolbar__new-branch-input"
                  aria-label="New branch name"
                  placeholder="new-branch-name"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                />
                <button
                  type="submit"
                  className="branch-toolbar__new-branch-create"
                  disabled={!newBranchName.trim()}
                >
                  Create
                </button>
              </form>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="branch-toolbar__menu-item branch-toolbar__menu-item--new"
                onClick={() => setNewBranchMode(true)}
              >
                <span
                  className="branch-toolbar__menu-item-check"
                  aria-hidden="true"
                >
                  +
                </span>
                <span className="branch-toolbar__menu-item-name">
                  New branch…
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="branch-toolbar__commit">
        <input
          type="text"
          className="branch-toolbar__commit-input"
          aria-label="Commit message"
          placeholder={
            status.isLoading
              ? 'Checking git status…'
              : status.isError || !gitStatus
                ? 'Git status unavailable'
                : isClean
                  ? 'Working tree clean'
                  : `Commit message (${dirtyCount})`
          }
          value={message}
          disabled={isClean || commit.isPending || !hasActions}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isComposingKeyEvent(e)) {
              e.preventDefault();
              onCommit();
            }
          }}
        />
        <button
          type="button"
          className="branch-toolbar__commit-btn"
          aria-label="Commit changes"
          disabled={isClean || !message.trim() || commit.isPending}
          onClick={onCommit}
        >
          {commit.isPending ? 'Committing…' : 'Commit'}
        </button>
      </div>

      <button
        type="button"
        className="branch-toolbar__push-btn"
        aria-label={ahead > 0 ? `Push ${ahead} commit(s)` : 'Push to remote'}
        disabled={push.isPending || !hasActions}
        onClick={() => push.mutate({ setUpstream: true })}
      >
        {push.isPending ? 'Pushing…' : 'Push'}
        {(ahead > 0 || behind > 0) && (
          <span className="branch-toolbar__sync" aria-hidden="true">
            {ahead > 0 ? `↑${ahead}` : ''}
            {behind > 0 ? `↓${behind}` : ''}
          </span>
        )}
      </button>

      {error && (
        <span className="branch-toolbar__error" role="alert">
          {error.message}
        </span>
      )}
    </div>
  );
}
