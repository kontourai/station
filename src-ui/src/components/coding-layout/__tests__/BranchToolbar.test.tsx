// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let reposData: unknown;
let reposLoading = false;
let reposError: Error | null = null;
const refetchRepos = vi.fn();
let branchesData: unknown[] = [];
let branchesLoading = false;
let branchesError: Error | null = null;
const refetchBranches = vi.fn();

vi.mock('../../../hooks/useGitActions', () => ({
  useReposQuery: () => ({
    data: reposData,
    isLoading: reposLoading,
    isError: reposError !== null,
    error: reposError,
    refetch: refetchRepos,
  }),
  useGitBranchesQuery: () => ({
    data: branchesData,
    isLoading: branchesLoading,
    isError: branchesError !== null,
    error: branchesError,
    refetch: refetchBranches,
  }),
  useGitCheckoutMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  useGitCommitMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  useGitPushMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

vi.mock('../../../hooks/useGitStatus', () => ({
  useGitStatus: () => ({ data: undefined, isLoading: false, isError: false }),
}));

import { BranchToolbar } from '../BranchToolbar';

/**
 * station#771 regression. Both `reposQuery.isLoading` and
 * `branchesQuery.isLoading` gates in this file were consulted without their
 * matching `isError` — a settled discovery/list failure rendered the
 * indistinguishable "No git repository in this folder" / "No branches"
 * fallback, with no error and no retry.
 */
describe('BranchToolbar (#771)', () => {
  beforeEach(() => {
    reposData = { workspace: '/repo', workspaceIsRepo: true, repos: [] };
    reposLoading = false;
    reposError = null;
    refetchRepos.mockReset();
    branchesData = [];
    branchesLoading = false;
    branchesError = null;
    refetchBranches.mockReset();
  });

  test('renders a discovery error with retry instead of "No git repository" when repo discovery fails', () => {
    reposData = undefined;
    reposError = new Error('repo discovery failed');

    render(<BranchToolbar workingDir="/repo" />);

    expect(screen.getByText(/Couldn.t discover git repositories/)).toBeTruthy();
    expect(screen.queryByText('No git repository in this folder')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchRepos).toHaveBeenCalledTimes(1);
  });

  test('still shows "No git repository" when discovery genuinely found none', () => {
    render(<BranchToolbar workingDir="/repo" />);
    expect(screen.getByText('No git repository in this folder')).toBeTruthy();
  });

  test('renders a branches error with retry inside the branch menu when the branch list fails', () => {
    reposData = {
      workspace: '/repo',
      workspaceIsRepo: true,
      repos: [{ root: '/repo', branch: 'main' }],
    };
    branchesData = undefined as unknown as unknown[];
    branchesError = new Error('branches unavailable');

    render(<BranchToolbar workingDir="/repo" activeFile="/repo/a.ts" />);

    fireEvent.click(screen.getByRole('button', { name: /No branch|main/ }));

    expect(screen.getByText(/Couldn.t load branches/)).toBeTruthy();
    expect(screen.queryByText('No branches')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchBranches).toHaveBeenCalledTimes(1);
  });
});
