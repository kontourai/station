// @vitest-environment jsdom
import type { PullRequest } from '@kontourai/station-contracts/pull-request-provider';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PullRequestsPanel } from '../PullRequestsPanel';

const mutateAsync = vi.fn();
const refetch = vi.fn();
let contextQuery: any;
let listQuery: any;
const contextInputs: unknown[] = [];

vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestContextQuery: (input: unknown) => {
    contextInputs.push(input);
    return contextQuery;
  },
  usePullRequestsQuery: () => listQuery,
  useMergePullRequestMutation: () => ({ mutateAsync, error: null }),
}));

const pullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  provider: 'github',
  host: 'github.com',
  ref: '17',
  url: 'https://github.com/kontourai/station/pull/17',
  repository: { owner: 'kontourai', name: 'station' },
  title: 'Ship repository PR actions',
  body: null,
  state: 'open',
  author: { login: 'brian' },
  sourceBranch: 'feat/prs',
  targetBranch: 'main',
  commits: 2,
  reviewStatus: 'approved',
  comments: 1,
  nativeId: '17',
  mergeability: 'mergeable',
  ...overrides,
});

function result(
  requests: PullRequest[],
  overrides: Record<string, unknown> = {},
) {
  return {
    available: true,
    data: requests,
    effectiveCapabilities: {
      list: true,
      detail: true,
      open: false,
      comment: false,
      approve: false,
      merge: true,
      autoMerge: true,
    },
    effectiveMergeMethods: ['squash', 'rebase'],
    mergeMethodsSource: 'repository',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  contextInputs.length = 0;
  contextQuery = {
    isLoading: false,
    error: null,
    data: {
      available: true,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
    },
  };
  listQuery = {
    isLoading: false,
    error: null,
    data: result([pullRequest()]),
    refetch,
  };
});

describe('PullRequestsPanel', () => {
  test('uses normalized filter vocabulary and renders LOCKED as a chip', () => {
    listQuery.data = result([
      pullRequest(),
      pullRequest({ ref: '18', title: 'Closed PR', state: 'closed' }),
      pullRequest({ ref: '19', title: 'Locked PR', state: 'locked' }),
    ]);
    render(<PullRequestsPanel projectSlug="station" />);

    const filter = screen.getByRole('combobox', { name: 'Pull request state' });
    expect(
      within(filter)
        .getAllByRole('option')
        .map((x) => x.textContent),
    ).toEqual(['All', 'Open', 'Closed', 'Merged']);
    fireEvent.change(filter, { target: { value: 'ALL' } });
    expect(screen.getByText('LOCKED')).toBeTruthy();
  });

  test.each([
    [false, 'mergeable', false],
    [true, 'conflicting', false],
    [true, 'unknown', true],
  ])(
    'gates merge for capability=%s mergeability=%s',
    (merge, mergeability, visible) => {
      listQuery.data = result(
        [pullRequest({ mergeability: mergeability as any })],
        {
          effectiveCapabilities: {
            ...result([]).effectiveCapabilities,
            merge,
            autoMerge: false,
          },
        },
      );
      render(<PullRequestsPanel projectSlug="station" />);
      expect(screen.queryByRole('button', { name: 'Merge' }) !== null).toBe(
        visible,
      );
      if (mergeability === 'conflicting') {
        expect(
          screen.getByText(/unavailable because.*conflicts/i),
        ).toBeTruthy();
      }
    },
  );

  test('narrows the picker and discloses provider-default methods', () => {
    listQuery.data = result([pullRequest()], {
      effectiveMergeMethods: ['rebase'],
      mergeMethodsSource: 'provider-default',
    });
    render(<PullRequestsPanel projectSlug="station" />);
    const picker = screen.getByRole('combobox', {
      name: 'Merge method for Ship repository PR actions',
    });
    expect(within(picker).getAllByRole('option')).toHaveLength(1);
    expect(within(picker).getByRole('option', { name: 'rebase' })).toBeTruthy();
    expect(screen.getByText(/provider defaults/i)).toBeTruthy();
  });

  test('keeps auto-merge as a distinct capability and confirms before dispatch', async () => {
    listQuery.data = result([pullRequest()], {
      effectiveCapabilities: {
        ...result([]).effectiveCapabilities,
        merge: false,
        autoMerge: true,
      },
    });
    mutateAsync.mockResolvedValue({
      available: true,
      data: { status: 'queued-auto-merge' },
    });
    render(<PullRequestsPanel projectSlug="station" />);
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enable auto-merge' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Enable auto-merge',
      }),
    );
    expect(await screen.findByText('Auto-merge armed.')).toBeTruthy();
    expect(mutateAsync).toHaveBeenCalledWith({
      method: 'squash',
      autoMerge: true,
    });
  });

  test.each([
    [
      {
        status: 'refused',
        reason: 'Protected branch policy denied this merge',
      },
      /Protected branch policy/,
    ],
    [
      {
        status: 'indeterminate',
        reason: 'Forge response was interrupted',
        observed: { merged: null, sha: 'abc' },
      },
      /Forge response was interrupted/,
    ],
  ])('renders honest operation outcome %#', async (outcome, expected) => {
    mutateAsync.mockResolvedValue({ available: true, data: outcome });
    render(<PullRequestsPanel projectSlug="station" />);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Merge' }),
    );
    expect(await screen.findByText(expected)).toBeTruthy();
    if (outcome.status === 'indeterminate') {
      fireEvent.click(screen.getByText(expected));
      expect(screen.getByText(/"sha": "abc"/)).toBeTruthy();
    }
  });

  test('refreshes the list after a confirmed merge', async () => {
    mutateAsync.mockResolvedValue({
      available: true,
      data: { status: 'merged' },
    });
    render(<PullRequestsPanel projectSlug="station" />);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Merge' }),
    );
    expect(await screen.findByText('Pull request merged.')).toBeTruthy();
    expect(refetch).toHaveBeenCalledOnce();
  });

  test('latches a rapid double confirmation and disables the pending control', async () => {
    let resolve!: (value: unknown) => void;
    mutateAsync.mockImplementation(
      () => new Promise((done) => (resolve = done)),
    );
    render(<PullRequestsPanel projectSlug="station" />);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    const confirm = within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Merge',
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await act(async () =>
      resolve({ available: true, data: { status: 'merged' } }),
    );
  });

  test('re-keys repository context when the active repo changes', () => {
    const rendered = render(
      <PullRequestsPanel projectSlug="station" activeRepoRoot="/repos/a" />,
    );
    rendered.rerender(
      <PullRequestsPanel projectSlug="station" activeRepoRoot="/repos/b" />,
    );

    expect(contextInputs).toContainEqual({
      project: 'station',
      workingDirectory: '/repos/a',
    });
    expect(contextInputs.at(-1)).toEqual({
      project: 'station',
      workingDirectory: '/repos/b',
    });
  });

  test('re-derives a merge method removed by a live capability narrowing', () => {
    const rendered = render(<PullRequestsPanel projectSlug="station" />);
    const picker = screen.getByRole('combobox', {
      name: 'Merge method for Ship repository PR actions',
    });
    fireEvent.change(picker, { target: { value: 'rebase' } });
    listQuery.data = result([pullRequest()], {
      effectiveMergeMethods: ['squash'],
    });
    rendered.rerender(<PullRequestsPanel projectSlug="station" />);

    expect((picker as HTMLSelectElement).value).toBe('squash');
  });

  test('distinguishes availability failure from a successful empty list', () => {
    listQuery.data = {
      ...result([]),
      available: false,
      reason: 'gh authentication expired',
    };
    const rendered = render(<PullRequestsPanel projectSlug="station" />);
    expect(screen.getByRole('alert').textContent).toContain(
      'gh authentication expired',
    );
    expect(screen.queryByText('No open pull requests')).toBeNull();

    listQuery.data = result([]);
    rendered.rerender(<PullRequestsPanel projectSlug="station" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('No open pull requests')).toBeTruthy();
  });
  test('a context-level unavailability renders its own reason even with stale list data', () => {
    // Layered guards: the list layer also catches unavailability (proven by
    // bypassing the context guard still rendered an
    // ErrorState), but only the CONTEXT guard carries the context's reason.
    // Pin it with the list still holding data, so this test discriminates
    // the context layer alone.
    contextQuery.data = {
      available: false,
      reason: 'repository context could not be resolved',
    };
    render(<PullRequestsPanel projectSlug="station" />);
    expect(screen.getByRole('alert').textContent).toContain(
      'repository context could not be resolved',
    );
    expect(screen.queryByText('Ship repository PR actions')).toBeNull();
  });
  /**
   * #1536 G5: an ordinary local repository is not a failure. It rendered a
   * warning-triangle "Pull requests unavailable" card, presented identically
   * to a forge that refused, and the panel cannot tell the two apart by
   * reading the sentence — the server's own cause classifies it.
   */
  describe('a checkout with no remote', () => {
    test('states the fact quietly, with no alert and no warning card', () => {
      contextQuery.data = {
        available: false,
        reason: 'Checkout has no remote',
        cause: 'no-remote',
      };
      render(<PullRequestsPanel projectSlug="station" />);

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText('Pull requests unavailable')).toBeNull();
      expect(screen.getByText('Pull requests need a remote')).toBeTruthy();
      expect(
        screen.getByText(/This checkout has no remote configured/),
      ).toBeTruthy();
    });

    test('a reason with no cause is still a failure, not a quiet state', () => {
      // Same sentence, no cause: an older server, or a genuinely different
      // problem. Classifying by prose is what this must never do.
      contextQuery.data = {
        available: false,
        reason: 'Checkout has no remote',
      };
      render(<PullRequestsPanel projectSlug="station" />);

      expect(screen.getByRole('alert').textContent).toContain(
        'Checkout has no remote',
      );
      expect(screen.queryByText('Pull requests need a remote')).toBeNull();
    });
  });
});
