// @vitest-environment jsdom
import type { ConversationPullRequestLinkObservation } from '@kontourai/station-contracts/conversation-pull-request-links';
import type { PullRequest } from '@kontourai/station-contracts/pull-request-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CurrentBranchPullRequestLine,
  PullRequestsPanel,
} from '../PullRequestsPanel';

const refetch = vi.fn();
let contextQuery: any;
let listQuery: any;
const contextInputs: unknown[] = [];
const listQueries: unknown[] = [];
let activeChat: string | null = 'conv-1';
let links: ConversationPullRequestLinkObservation[] = [];
const linkConversationPullRequest = vi.fn(async () => ({}));
const unlinkConversationPullRequest = vi.fn(async () => ({}));
const openExternalLink = vi.fn(async (_url: string) => {});

vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestContextQuery: (input: unknown) => {
    contextInputs.push(input);
    return contextQuery;
  },
  usePullRequestsQuery: (
    _p: string,
    _h: string,
    _o: string,
    _r: string,
    _c: unknown,
    query: unknown,
  ) => {
    listQueries.push(query);
    return listQuery;
  },
}));
vi.mock('@kontourai/station-sdk/conversation-pull-request-links', () => ({
  getConversationPullRequestLinks: async () => ({
    conversationId: 'conv-1',
    observedAt: '2026-10-01T00:00:00Z',
    links,
  }),
  linkConversationPullRequest: (...args: unknown[]) =>
    linkConversationPullRequest(...(args as [])),
  unlinkConversationPullRequest: (...args: unknown[]) =>
    unlinkConversationPullRequest(...(args as [])),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: (select: (state: { activeChat: string | null }) => unknown) =>
    select({ activeChat }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'k',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../platform/openExternalLink', () => ({
  openExternalLink: (url: string) => openExternalLink(url),
}));
vi.mock('../PullRequestReviewPanel', () => ({
  PullRequestReviewPanel: ({
    target,
    onBack,
    focusTitleOnOpen,
  }: {
    target: { host: string; ref: string; repositoryRootHint?: string };
    onBack?: () => void;
    focusTitleOnOpen?: boolean;
  }) => (
    <section
      aria-label="Pull request review"
      data-focus-title={String(focusTitleOnOpen)}
    >
      Reviewing {target.host} #{target.ref}
      {target.repositoryRootHint ? ` in ${target.repositoryRootHint}` : ''}
      {onBack && (
        <button type="button" onClick={onBack}>
          Back to pull requests
        </button>
      )}
    </section>
  ),
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
  author: { login: 'casey' },
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

function mount(props: Partial<Parameters<typeof PullRequestsPanel>[0]> = {}) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PullRequestsPanel
        projectSlug="station"
        activeRepoRoot="/repos/station"
        {...props}
      />
    </QueryClientProvider>,
  );
}

/** The rows of the pull request list (not the stack's ordered list). */
const rows = () =>
  screen
    .getAllByRole('listitem')
    .filter((item) => item.className.includes('pull-request-row'));

beforeEach(() => {
  vi.clearAllMocks();
  contextInputs.length = 0;
  listQueries.length = 0;
  activeChat = 'conv-1';
  links = [];
  contextQuery = {
    isLoading: false,
    error: null,
    refetch,
    data: {
      available: true,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
      branch: 'feat/prs',
    },
  };
  listQuery = {
    isLoading: false,
    isFetching: false,
    error: null,
    data: result([pullRequest()]),
    dataUpdatedAt: Date.now(),
    refetch,
  };
});

afterEach(() => cleanup());

describe('PullRequestsPanel', () => {
  test('a row is the title as its one action; everything else is behind the row menu', async () => {
    listQuery.data = result([
      pullRequest(),
      pullRequest({
        ref: '18',
        title: 'Conflicting one',
        sourceBranch: 'fix/x',
        mergeability: 'conflicting',
        reviewStatus: 'CHANGES_REQUESTED',
      }),
    ]);
    mount();
    const [first, second] = rows();
    // One labelled control per row: the title. The `⋯` is icon-only.
    const buttons = within(first).getAllByRole('button');
    expect(
      buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ).toEqual(['Ship repository PR actions', 'More actions for #17']);
    expect(buttons[1].textContent).toBe('⋯');
    // Merge left the list for the review: no bordered actions, no select.
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Enable auto-merge' }),
    ).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    // State as words in chips; conflicts as a chip, not a sentence.
    expect(within(first).getByText('Open')).toBeTruthy();
    expect(within(first).getByText('Approved')).toBeTruthy();
    expect(within(second).getByText('Has conflicts')).toBeTruthy();
    expect(within(second).getByText('Changes requested')).toBeTruthy();
    expect(screen.queryByText(/unavailable because/)).toBeNull();
    // The checked-out branch's pull request is marked.
    expect(within(first).getByText('current branch')).toBeTruthy();
    expect(within(second).queryByText('current branch')).toBeNull();
    // The row menu opens the pull request on its site.
    fireEvent.click(
      within(first).getByRole('button', { name: 'More actions for #17' }),
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Open on GitHub' }),
    );
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://github.com/kontourai/station/pull/17',
    );
  });

  test('opening a row shows the review in the whole pane, and Back returns to the list with focus on that row', async () => {
    listQuery.data = result([
      pullRequest({ ref: '16', title: 'Other one', sourceBranch: 'other' }),
      pullRequest(),
    ]);
    mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Ship repository PR actions' }),
    );
    const review = await screen.findByRole('region', {
      name: 'Pull request review',
    });
    expect(review.textContent).toContain(
      'Reviewing github.com #17 in /repos/station',
    );
    // Opened from a row: the review keeps focus where the click left it.
    expect(review.dataset.focusTitle).toBe('false');
    // The list is gone: nothing shares the pane with the review.
    expect(screen.queryByRole('region', { name: 'Pull requests' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Back to pull requests' }),
    );
    const row = await screen.findByRole('button', {
      name: 'Ship repository PR actions',
    });
    expect(
      screen.queryByRole('region', { name: 'Pull request review' }),
    ).toBeNull();
    // Focus returns to the row the review was opened from, not <body>.
    expect(document.activeElement).toBe(row);
  });

  test('mounts on a review when asked, and Back still returns to the list', async () => {
    mount({
      initialSelected: {
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
        ref: '17',
      },
    });
    const review = await screen.findByRole('region', {
      name: 'Pull request review',
    });
    expect(review.textContent).toContain('Reviewing github.com #17');
    // Nothing on this pane had focus to keep: the review takes it.
    expect(review.dataset.focusTitle).toBe('true');
    fireEvent.click(
      screen.getByRole('button', { name: 'Back to pull requests' }),
    );
    const row = await screen.findByRole('button', {
      name: 'Ship repository PR actions',
    });
    expect(document.activeElement).toBe(row);
  });

  test('the state filter is a choice, pressed and sent to the list read; a word, not a select', () => {
    listQuery.data = result([
      pullRequest(),
      pullRequest({ ref: '18', title: 'Closed PR', state: 'closed' }),
      pullRequest({ ref: '19', title: 'Locked PR', state: 'locked' }),
    ]);
    mount();
    const group = screen.getByRole('group', { name: 'Pull request state' });
    const options = within(group).getAllByRole('button');
    expect(options.map((o) => o.textContent)).toEqual([
      'Open',
      'Merged',
      'Closed',
      'All',
    ]);
    expect(options[0].getAttribute('aria-pressed')).toBe('true');
    expect(listQueries.at(-1)).toEqual({ state: 'OPEN' });
    fireEvent.click(options[3]);
    expect(options[3].getAttribute('aria-pressed')).toBe('true');
    expect(options[0].getAttribute('aria-pressed')).toBe('false');
    expect(listQueries.at(-1)).toEqual({ state: 'ALL' });
    // An enum the pane does not know is still a word, never raw.
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(screen.queryByText('LOCKED')).toBeNull();
  });

  test('the chat’s links elsewhere list above the repository’s rows; Unlink is in the row menu', async () => {
    links = [
      {
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'docs' },
        ref: '7',
        source: 'explicit',
        linkedAt: '2026-10-01T00:00:00Z',
        linkedBy: 'operator',
        observedAt: '2026-10-01T00:00:00Z',
        status: {
          state: 'current',
          title: 'Document the thing',
          pullRequestState: 'OPEN',
        },
      },
      {
        // The listed pull request, linked explicitly: it is the listed row,
        // which gains Unlink; it is not listed twice.
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
        ref: '17',
        source: 'explicit',
        linkedAt: '2026-10-01T00:00:00Z',
        linkedBy: 'operator',
        observedAt: '2026-10-01T00:00:00Z',
        status: {
          state: 'current',
          title: 'Ship repository PR actions',
          pullRequestState: 'OPEN',
        },
      },
    ];
    mount();
    await screen.findByText('Linked to this chat');
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all[0].textContent).toContain('Document the thing');
    expect(all[0].textContent).toContain('github.com/kontourai/docs #7');
    expect(all[1].textContent).toContain('Ship repository PR actions');
    fireEvent.click(
      within(all[1]).getByRole('button', { name: 'More actions for #17' }),
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Unlink from chat' }),
    );
    await waitFor(() =>
      expect(unlinkConversationPullRequest).toHaveBeenCalledWith(
        'http://station.test',
        'conv-1',
        links[1],
        expect.anything(),
      ),
    );
  });

  test('linking is one field behind a plus: a number reads against the checkout’s repository', async () => {
    mount();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Link a pull request' }),
    );
    const field = screen.getByRole('textbox', { name: 'Pull request' });
    const link = screen.getByRole('button', { name: 'Link' });
    expect((link as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: '#42' } });
    expect((link as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(link);
    await waitFor(() =>
      expect(linkConversationPullRequest).toHaveBeenCalledWith(
        'http://station.test',
        'conv-1',
        {
          provider: 'github',
          host: 'github.com',
          repository: { owner: 'kontourai', name: 'station' },
          ref: '42',
        },
        expect.anything(),
      ),
    );
    // Linked: the field closes.
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  test('without an open chat there is nothing to link to, so no plus', () => {
    activeChat = null;
    mount();
    expect(
      screen.queryByRole('button', { name: 'Link a pull request' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  test('re-keys repository context when the active repo changes', () => {
    const rendered = mount({ activeRepoRoot: '/repos/a' });
    rendered.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <PullRequestsPanel projectSlug="station" activeRepoRoot="/repos/b" />
      </QueryClientProvider>,
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

  test('distinguishes availability failure from a successful empty list, each one line', () => {
    listQuery.data = {
      ...result([]),
      available: false,
      reason: 'gh authentication expired',
    };
    const rendered = mount();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('gh authentication expired');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByText('No open pull requests')).toBeNull();

    listQuery.data = result([]);
    rendered.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <PullRequestsPanel projectSlug="station" />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('No open pull requests')).toBeTruthy();
  });

  test('a context-level unavailability renders its own reason even with stale list data', () => {
    contextQuery.data = {
      available: false,
      reason: 'repository context could not be resolved',
    };
    mount();
    expect(screen.getByRole('alert').textContent).toContain(
      'repository context could not be resolved',
    );
    expect(screen.queryByText('Ship repository PR actions')).toBeNull();
  });

  /**
   * #1536 G5: an ordinary local repository is not a failure. The server's
   * own cause classifies it; the panel never reads the sentence.
   */
  describe('a checkout with no remote', () => {
    test('states the fact in one quiet line, naming the sites it understands', () => {
      contextQuery.data = {
        available: false,
        reason: 'Checkout has no remote',
        cause: 'no-remote',
      };
      mount();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(
        screen.getByText(
          'No remote. Add a GitHub or GitLab remote to see pull requests.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/forge/i)).toBeNull();
    });

    test('a reason with no cause is still a failure, not a quiet state', () => {
      contextQuery.data = {
        available: false,
        reason: 'Checkout has no remote',
      };
      mount();
      expect(screen.getByRole('alert').textContent).toContain(
        'Checkout has no remote',
      );
      expect(screen.queryByText(/No remote\. Add/)).toBeNull();
    });
  });
});

describe('CurrentBranchPullRequestLine', () => {
  test('renders only the checked-out branch’s open pull request, and opens it', () => {
    const onOpen = vi.fn();
    listQuery.data = result([
      pullRequest({ ref: '16', title: 'Other branch', sourceBranch: 'other' }),
      pullRequest(),
    ]);
    render(
      <CurrentBranchPullRequestLine
        projectSlug="station"
        activeRepoRoot="/repos/station"
        onOpen={onOpen}
      />,
    );
    const line = screen.getByRole('button', {
      name: 'Open pull request #17: Ship repository PR actions',
    });
    expect(line.textContent).toContain('PR #17');
    expect(screen.queryByText('Other branch')).toBeNull();
    fireEvent.click(line);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ ref: '17', host: 'github.com' }),
    );
  });

  test('renders nothing when the branch has no open pull request, or there is no remote', () => {
    listQuery.data = result([
      pullRequest({ ref: '16', title: 'Other branch', sourceBranch: 'other' }),
    ]);
    const { container, rerender } = render(
      <CurrentBranchPullRequestLine projectSlug="station" onOpen={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
    contextQuery.data = { available: false, cause: 'no-remote', reason: '' };
    rerender(
      <CurrentBranchPullRequestLine projectSlug="station" onOpen={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
  });
});
