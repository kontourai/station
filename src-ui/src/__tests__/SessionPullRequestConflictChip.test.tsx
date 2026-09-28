/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

let contextQuery: any;
let pullRequestsQuery: any;
const contextInputs: unknown[] = [];
let pullRequestsOptions: { enabled?: boolean } | undefined;

vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestContextQuery: (input: unknown) => {
    contextInputs.push(input);
    return contextQuery;
  },
  usePullRequestsQuery: (...args: unknown[]) => {
    pullRequestsOptions = args[6] as { enabled?: boolean };
    return pullRequestsQuery;
  },
}));

const { SessionPullRequestConflictChip } = await import(
  '../components/session/SessionPullRequestConflictChip'
);

const session = {
  threadId: 'thread-produced-pr',
  projectSlug: 'station',
} as any;

function observed(
  mergeability: 'mergeable' | 'conflicting' | 'unknown',
  sourceBranch = 'feat/produced-by-session',
) {
  return {
    available: true,
    data: [{ sourceBranch, mergeability }],
  };
}

describe('SessionPullRequestConflictChip', () => {
  test('renders only an observed conflict on the session worktree branch and clears when it resolves', () => {
    contextQuery = {
      data: {
        available: true,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
        branch: 'feat/produced-by-session',
      },
    };
    pullRequestsQuery = { data: observed('conflicting') };

    const rendered = render(
      <SessionPullRequestConflictChip session={session} />,
    );
    expect(screen.getByText('PR conflict')).toBeTruthy();
    expect(contextInputs).toContainEqual({
      project: 'station',
      thread: 'thread-produced-pr',
    });
    expect(pullRequestsOptions?.enabled).toBe(true);

    // Another branch's conflict in the same repository is not this session's.
    pullRequestsQuery = { data: observed('conflicting', 'feat/someone-else') };
    rendered.rerender(<SessionPullRequestConflictChip session={session} />);
    expect(screen.queryByText('PR conflict')).toBeNull();

    pullRequestsQuery = { data: observed('mergeable') };
    rendered.rerender(<SessionPullRequestConflictChip session={session} />);
    expect(screen.queryByText('PR conflict')).toBeNull();
  });

  test('does not observe the forge while the checkout context is unavailable', () => {
    contextQuery = { data: { available: false } };
    pullRequestsQuery = { data: undefined };

    render(<SessionPullRequestConflictChip session={session} />);
    expect(pullRequestsOptions?.enabled).toBe(false);
    expect(screen.queryByText('PR conflict')).toBeNull();
  });
});
