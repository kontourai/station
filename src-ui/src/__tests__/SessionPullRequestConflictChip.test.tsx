/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

let contextQuery: any;
let pullRequestsQuery: any;
const contextInputs: unknown[] = [];

vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestContextQuery: (input: unknown) => {
    contextInputs.push(input);
    return contextQuery;
  },
  usePullRequestsQuery: () => pullRequestsQuery,
}));

const { SessionPullRequestConflictChip } = await import(
  '../components/session/SessionPullRequestConflictChip'
);

const session = {
  threadId: 'thread-produced-pr',
  projectSlug: 'station',
} as any;

function observed(mergeability: 'mergeable' | 'conflicting' | 'unknown') {
  return {
    available: true,
    data: [
      {
        sourceBranch: 'feat/produced-by-session',
        mergeability,
      },
    ],
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

    pullRequestsQuery = { data: observed('mergeable') };
    rendered.rerender(<SessionPullRequestConflictChip session={session} />);
    expect(screen.queryByText('PR conflict')).toBeNull();
  });

  test('renders nothing when the observed forge state is unavailable', () => {
    contextQuery = { data: { available: false } };
    pullRequestsQuery = { data: undefined };

    render(<SessionPullRequestConflictChip session={session} />);
    expect(screen.queryByText('PR conflict')).toBeNull();
  });
});
