/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

let contextQuery: any;
let mergeabilityQuery: any;
const contextInputs: unknown[] = [];
let mergeabilityOptions: { enabled?: boolean } | undefined;

vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestContextQuery: (input: unknown) => {
    contextInputs.push(input);
    return contextQuery;
  },
  usePullRequestMergeabilityQuery: (...args: unknown[]) => {
    mergeabilityOptions = args[5] as { enabled?: boolean };
    return mergeabilityQuery;
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
    data: [{ ref: '7', sourceBranch, mergeability }],
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
    mergeabilityQuery = { data: observed('conflicting') };

    const rendered = render(
      <SessionPullRequestConflictChip session={session} />,
    );
    expect(screen.getByText('PR conflict')).toBeTruthy();
    expect(contextInputs).toContainEqual({
      project: 'station',
      thread: 'thread-produced-pr',
    });
    expect(mergeabilityOptions?.enabled).toBe(true);

    // Another branch's conflict in the same repository is not this session's.
    mergeabilityQuery = {
      data: observed('conflicting', 'feat/someone-else'),
    };
    rendered.rerender(<SessionPullRequestConflictChip session={session} />);
    expect(screen.queryByText('PR conflict')).toBeNull();

    mergeabilityQuery = { data: observed('mergeable') };
    rendered.rerender(<SessionPullRequestConflictChip session={session} />);
    expect(screen.queryByText('PR conflict')).toBeNull();
  });

  test('does not observe the forge while the checkout context is unavailable', () => {
    contextQuery = { data: { available: false } };
    mergeabilityQuery = { data: undefined };

    render(<SessionPullRequestConflictChip session={session} />);
    expect(mergeabilityOptions?.enabled).toBe(false);
    expect(screen.queryByText('PR conflict')).toBeNull();
  });
  test("a fork pull request sharing the branch name is not this session's", () => {
    const identity = {
      available: true,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
      branch: 'feat/produced-by-session',
    };
    const conflict = (sourceOwner: string, sourceBranch = identity.branch) => ({
      data: {
        available: true,
        data: [
          { ref: '9', sourceBranch, sourceOwner, mergeability: 'conflicting' },
        ],
      },
    });
    contextQuery = { data: identity };
    mergeabilityQuery = conflict('someone-else');
    const rendered = render(
      <SessionPullRequestConflictChip session={session} />,
    );
    expect(screen.queryByText('PR conflict')).toBeNull();

    // Owners compare as the forge does, case-insensitively.
    mergeabilityQuery = conflict('KontourAI');
    rendered.rerender(<SessionPullRequestConflictChip session={session} />);
    expect(screen.getByText('PR conflict')).toBeTruthy();

    // A session pushed to its own fork under another branch name matches
    // that fork's pull request, and no longer this repository's.
    contextQuery = {
      data: {
        ...identity,
        head: { branch: 'feat/upstream', owner: 'my-fork' },
      },
    };
    mergeabilityQuery = conflict('my-fork', 'feat/upstream');
    rendered.rerender(<SessionPullRequestConflictChip session={session} />);
    expect(screen.getByText('PR conflict')).toBeTruthy();
    mergeabilityQuery = conflict('kontourai');
    rendered.rerender(<SessionPullRequestConflictChip session={session} />);
    expect(screen.queryByText('PR conflict')).toBeNull();
  });
});
