/**
 * @vitest-environment jsdom
 */

import type { GitStatusResult } from '@kontourai/station-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// ── Mutable hook state, reset per test ──────────────────────────────────────

const checkoutMutate = vi.fn();
const commitMutate = vi.fn();
const pushMutate = vi.fn();

interface RepoLike {
  root: string;
  name: string;
  relativePath: string;
  branch: string;
}

interface ReposResultLike {
  workspace: string;
  workspaceIsRepo: boolean;
  repos: RepoLike[];
}

const state = {
  // The path the most recent useGitStatus call was made against — lets tests
  // assert which repo the toolbar is currently targeting.
  statusPath: null as string | null,
  // git-status keyed by repo root so different active repos resolve to the
  // right branch.
  statusByRoot: {} as Record<string, GitStatusResult | null>,
  repos: {
    data: undefined as ReposResultLike | undefined,
    isLoading: false,
    error: null as Error | null,
  },
  branches: {
    data: [] as Array<{
      name: string;
      sha: string;
      date: string;
      current: boolean;
    }>,
    isLoading: false,
    error: null as Error | null,
  },
  // Query-lifecycle flags for the git-status query itself, independent of
  // its resolved data — lets tests drive loading/errored states.
  status: {
    isLoading: false,
    isError: false,
    error: null as Error | null,
  },
};

vi.mock('../hooks/useGitStatus', () => ({
  useGitStatus: (path: string | null) => {
    state.statusPath = path;
    return {
      data: path ? (state.statusByRoot[path] ?? null) : null,
      isLoading: state.status.isLoading,
      isError: state.status.isError,
      error: state.status.error,
    };
  },
}));

vi.mock('../hooks/useGitActions', () => ({
  useReposQuery: () => state.repos,
  useGitBranchesQuery: () => state.branches,
  useGitCheckoutMutation: () => ({
    mutate: checkoutMutate,
    isPending: false,
    error: null,
  }),
  useGitCommitMutation: () => ({
    mutate: commitMutate,
    isPending: false,
    error: null,
  }),
  useGitPushMutation: () => ({
    mutate: pushMutate,
    isPending: false,
    error: null,
  }),
}));

import { BranchToolbar } from '../components/coding-layout/BranchToolbar';

function makeStatus(branch: string, dirty = true): GitStatusResult {
  return {
    isRepo: true,
    branch,
    changes: dirty ? ['M src/app.ts'] : [],
    staged: 0,
    unstaged: dirty ? 1 : 0,
    untracked: 0,
    lastCommit: null,
    ahead: 2,
    behind: 0,
  };
}

const SINGLE_REPO: ReposResultLike = {
  workspace: '/repo',
  workspaceIsRepo: true,
  repos: [{ root: '/repo', name: 'repo', relativePath: '.', branch: 'main' }],
};

const MULTI_REPO: ReposResultLike = {
  workspace: '/workspace',
  workspaceIsRepo: false,
  repos: [
    {
      root: '/workspace/repo-a',
      name: 'repo-a',
      relativePath: 'repo-a',
      branch: 'main',
    },
    {
      root: '/workspace/repo-b',
      name: 'repo-b',
      relativePath: 'repo-b',
      branch: 'develop',
    },
  ],
};

beforeEach(() => {
  state.statusPath = null;
  state.statusByRoot = { '/repo': makeStatus('main') };
  state.repos = { data: SINGLE_REPO, isLoading: false, error: null };
  state.branches = {
    data: [
      { name: 'main', sha: 'aaa', date: '1 day ago', current: true },
      { name: 'feature/x', sha: 'bbb', date: '2 hours ago', current: false },
    ],
    isLoading: false,
    error: null,
  };
  state.status = { isLoading: false, isError: false, error: null };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BranchToolbar', () => {
  test('shows the current branch from git status', () => {
    render(<BranchToolbar workingDir="/repo" />);
    expect(screen.getByText('main')).toBeTruthy();
  });

  test('renders branches in the switcher menu', () => {
    render(<BranchToolbar workingDir="/repo" />);
    fireEvent.click(screen.getByRole('button', { name: /Switch branch/ }));
    expect(screen.getByRole('menu', { name: 'Branches' })).toBeTruthy();
    expect(
      screen.getByRole('menuitemradio', { name: /feature\/x/ }),
    ).toBeTruthy();
  });

  test('selecting a branch fires checkout', () => {
    render(<BranchToolbar workingDir="/repo" />);
    fireEvent.click(screen.getByRole('button', { name: /Switch branch/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /feature\/x/ }));
    expect(checkoutMutate).toHaveBeenCalledWith({ branch: 'feature/x' });
  });

  test('Commit fires commit with the message', () => {
    render(<BranchToolbar workingDir="/repo" />);
    const input = screen.getByLabelText('Commit message');
    fireEvent.change(input, { target: { value: 'wip: changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));
    expect(commitMutate).toHaveBeenCalledWith(
      { message: 'wip: changes' },
      expect.anything(),
    );
  });

  test('IME Enter does not commit, then plain Enter commits', () => {
    render(<BranchToolbar workingDir="/repo" />);
    const input = screen.getByLabelText('Commit message');
    fireEvent.change(input, { target: { value: 'IME commit message' } });
    fireEvent.keyDown(input, {
      key: 'Enter',
      isComposing: true,
      keyCode: 229,
    });
    expect(commitMutate).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(commitMutate).toHaveBeenCalledWith(
      { message: 'IME commit message' },
      expect.anything(),
    );
  });

  test('Commit is disabled when the tree is clean', () => {
    state.statusByRoot = { '/repo': makeStatus('main', false) };
    render(<BranchToolbar workingDir="/repo" />);
    const button = screen.getByRole('button', {
      name: 'Commit changes',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const input = screen.getByLabelText('Commit message') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    // Happy path: a genuinely resolved, genuinely clean tree still reads as
    // clean — the tri-state fix must not regress this case.
    expect(input.placeholder).toBe('Working tree clean');
  });

  test('a loading git-status query does not claim the tree is clean, and does not disable commit', () => {
    // The fixture MUST be clean. With a dirty one, `dirtyCount === 0` is false
    // whatever the query state, so the boolean collapse this test exists to
    // forbid is unobservable and the test passes against the bug. Verified by
    // injection: with the default dirty fixture, reverting isClean to
    // `dirtyCount === 0` left all 14 tests green.
    state.statusByRoot = { '/repo': makeStatus('main', false) };
    state.status = { isLoading: true, isError: false, error: null };
    render(<BranchToolbar workingDir="/repo" />);
    const input = screen.getByLabelText('Commit message') as HTMLInputElement;
    expect(input.placeholder).not.toMatch(/clean/i);
    expect(input.disabled).toBe(false);
    const button = screen.getByRole('button', {
      name: 'Commit changes',
    }) as HTMLButtonElement;
    // Still gated on having a message to type, not on the unresolved status.
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'wip' } });
    expect(
      (
        screen.getByRole('button', {
          name: 'Commit changes',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test('an errored git-status query does not claim the tree is clean, and does not disable commit', () => {
    // Clean fixture, for the same reason as the loading case above.
    state.statusByRoot = { '/repo': makeStatus('main', false) };
    state.status = {
      isLoading: false,
      isError: true,
      error: new Error('status failed'),
    };
    render(<BranchToolbar workingDir="/repo" />);
    const input = screen.getByLabelText('Commit message') as HTMLInputElement;
    expect(input.placeholder).not.toMatch(/clean/i);
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'wip: recover' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));
    expect(commitMutate).toHaveBeenCalledWith(
      { message: 'wip: recover' },
      expect.anything(),
    );
  });

  test('Push fires push', () => {
    render(<BranchToolbar workingDir="/repo" />);
    fireEvent.click(screen.getByRole('button', { name: /Push/ }));
    expect(pushMutate).toHaveBeenCalledWith({ setUpstream: true });
  });

  // ── Multi-repo awareness ────────────────────────────────────────────────

  test('single repo renders a static repo label, no switcher dropdown', () => {
    render(<BranchToolbar workingDir="/repo" />);
    // The repo label text is present...
    expect(screen.getByText('repo')).toBeTruthy();
    // ...but there is no "Switch repository" combobox.
    expect(
      screen.queryByRole('button', { name: /Switch repository/ }),
    ).toBeNull();
  });

  test('multiple repos render a switcher listing names and branches', () => {
    state.repos = { data: MULTI_REPO, isLoading: false, error: null };
    state.statusByRoot = {
      '/workspace/repo-a': makeStatus('main'),
      '/workspace/repo-b': makeStatus('develop'),
    };
    render(<BranchToolbar workingDir="/workspace" />);

    const trigger = screen.getByRole('button', {
      name: /Switch repository/,
    });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'Repositories' });
    expect(menu).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /repo-a/ })).toBeTruthy();
    const repoB = screen.getByRole('menuitemradio', { name: /repo-b/ });
    expect(repoB).toBeTruthy();
    // Branch names are surfaced in the list.
    expect(screen.getByText(/develop/)).toBeTruthy();
  });

  test('selecting a repo pins it as the active context', () => {
    state.repos = { data: MULTI_REPO, isLoading: false, error: null };
    state.statusByRoot = {
      '/workspace/repo-a': makeStatus('main'),
      '/workspace/repo-b': makeStatus('develop'),
    };
    render(<BranchToolbar workingDir="/workspace" />);

    // Default (no active file, not workspaceIsRepo) → first repo, repo-a.
    expect(state.statusPath).toBe('/workspace/repo-a');

    fireEvent.click(screen.getByRole('button', { name: /Switch repository/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /repo-b/ }));

    // Active git status now targets repo-b's root.
    expect(state.statusPath).toBe('/workspace/repo-b');
    // And its branch is reflected.
    expect(
      screen
        .getByRole('button', { name: /Current branch/ })
        .textContent?.includes('develop'),
    ).toBe(true);
  });

  test('auto-follows the active file to the longest-prefix repo', () => {
    state.repos = { data: MULTI_REPO, isLoading: false, error: null };
    state.statusByRoot = {
      '/workspace/repo-a': makeStatus('main'),
      '/workspace/repo-b': makeStatus('develop'),
    };
    const { rerender } = render(
      <BranchToolbar
        workingDir="/workspace"
        activeFile="/workspace/repo-a/src/index.ts"
      />,
    );
    expect(state.statusPath).toBe('/workspace/repo-a');

    // Changing the active file to a path under repo-b switches the active repo.
    rerender(
      <BranchToolbar
        workingDir="/workspace"
        activeFile="/workspace/repo-b/lib/util.ts"
      />,
    );
    expect(state.statusPath).toBe('/workspace/repo-b');
  });

  test('empty repos render a subtle no-repository state', () => {
    state.repos = {
      data: { workspace: '/empty', workspaceIsRepo: false, repos: [] },
      isLoading: false,
      error: null,
    };
    render(<BranchToolbar workingDir="/empty" />);
    expect(screen.getByText(/No git repository in this folder/)).toBeTruthy();
    // No branch switcher in the empty state.
    expect(screen.queryByRole('button', { name: /Switch branch/ })).toBeNull();
  });
});
