/** @vitest-environment jsdom */

/**
 * The review pane's status: mergeability, the provider's checks for the
 * observed head, and inline review comments on the changed-files diff.
 * The snapshot is the shape `readPullRequestReview` returns (its server
 * tests pin the forge-to-snapshot mapping against captured gh output); this
 * file proves the pane renders what that snapshot says and nothing it
 * does not.
 */

import type { PullRequestReviewSnapshot } from '@kontourai/station-contracts/pull-request-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const openExternalLink = vi.fn(async (_url: string) => {});
const snapshot = vi.hoisted(() => ({
  current: undefined as unknown as PullRequestReviewSnapshot,
}));

vi.mock('../../../platform/openExternalLink', () => ({
  openExternalLink: (url: string) => openExternalLink(url),
}));
vi.mock('@kontourai/station-sdk/pull-request-review', () => ({
  getPullRequestReview: async () => ({
    available: true,
    effectiveCapabilities: {
      list: true,
      detail: true,
      open: false,
      comment: false,
      approve: false,
      merge: false,
      autoMerge: false,
    },
    effectiveMergeMethods: [],
    mergeMethodsSource: 'provider-default',
    data: snapshot.current,
  }),
  mergeReviewedPullRequest: vi.fn(),
  submitPullRequestReview: vi.fn(),
}));
// ObservedDiffPanel reads local comments only for a Project; the review pane
// passes none, so these hooks stay disabled.
vi.mock('@kontourai/station-sdk', () => ({
  useDiffCommentsQuery: () => ({ data: [] }),
  useCreateDiffCommentMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteDiffCommentMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'test',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: (select: (state: { activeChat: null }) => unknown) =>
    select({ activeChat: null }),
}));
vi.mock('../../../contexts/ActiveChatsContext', () => ({
  activeChatsStore: { getSnapshot: () => ({}) },
  useActiveChatActions: () => ({
    getDraft: () => '',
    setDraft: () => {},
    updateChat: () => {},
  }),
}));
vi.mock('../../../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({
    guard: (action: () => void) => action(),
    DiscardModal: () => null,
  }),
}));

import { PullRequestReviewPanel } from '../PullRequestReviewPanel';

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

function base(
  overrides: Partial<PullRequestReviewSnapshot> = {},
): PullRequestReviewSnapshot {
  return {
    pullRequest: {
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
      ref: '2049',
      nativeId: '2049',
      url: 'https://github.com/kontourai/station/pull/2049',
      title: 'Open panes over Chat',
      body: 'Body',
      state: 'OPEN',
      author: { login: 'author' },
      sourceBranch: 'fix',
      targetBranch: 'main',
      commits: 1,
      reviewStatus: 'NONE',
      comments: 0,
      mergeability: 'conflicting',
    },
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    observedAt: '2026-09-10T00:00:00Z',
    diff: { state: 'available', patch: PATCH, completeness: 'provider-output' },
    discussion: [],
    discussionPartial: false,
    ...overrides,
  };
}

function mount(onBack?: () => void) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PullRequestReviewPanel
        target={{
          provider: 'github',
          host: 'github.com',
          owner: 'kontourai',
          repository: 'station',
          ref: '2049',
          project: 'station',
        }}
        onBack={onBack}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('pull request status', () => {
  test('states conflicts and lists checks failures first, with counts from the list', async () => {
    snapshot.current = base({
      checks: {
        state: 'available',
        partial: false,
        checks: [
          { name: 'classify', state: 'success', group: 'iOS' },
          {
            name: 'Windows PR portable floor',
            state: 'failure',
            group: 'Windows PR Verification',
            url: 'https://github.com/kontourai/station/actions/runs/3/job/4',
          },
          { name: 'fast-checks', state: 'pending', group: 'CI' },
          { name: 'gallery', state: 'skipped' },
        ],
      },
    });
    mount();
    expect(
      (await screen.findByText(/Has conflicts with/)).textContent,
    ).toContain('Has conflicts with main.');
    expect(
      screen.getByText('1 failed · 1 pending · 1 passed · 1 skipped'),
    ).toBeTruthy();
    const items = screen
      .getAllByRole('listitem')
      .filter((item) => item.hasAttribute('data-check-state'));
    expect(items.map((item) => item.getAttribute('data-check-state'))).toEqual([
      'failure',
      'pending',
      'success',
      'skipped',
    ]);
    // The state is a word, not only a colour.
    expect(within(items[0]).getByText('Failed')).toBeTruthy();
    // Failed and pending stay open; settled checks fold behind a counted
    // disclosure.
    expect(items[0].closest('details')).toBeNull();
    expect(items[1].closest('details')).toBeNull();
    const settled = screen
      .getByText('Show the other 2 passed, neutral or skipped checks')
      .closest('details');
    expect(settled?.open).toBe(false);
    expect(items[2].closest('details')).toBe(settled);
    expect(items[3].closest('details')).toBe(settled);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Windows PR portable floor details',
      }),
    );
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://github.com/kontourai/station/actions/runs/3/job/4',
    );
    // A check without a link offers no button to nowhere.
    expect(
      screen.queryByRole('button', { name: 'Open classify details' }),
    ).toBeNull();
  });

  test.each([
    [undefined, 'This Station did not report checks for this pull request.'],
    [
      { state: 'unavailable', reason: 'The provider did not report checks.' },
      'The provider did not report checks.',
    ],
    [
      { state: 'available', checks: [], partial: false },
      'The provider reports no checks for this head.',
    ],
  ] as const)(
    'says what an absent or empty rollup means (%o)',
    async (checks, text) => {
      snapshot.current = base({
        checks: checks as PullRequestReviewSnapshot['checks'],
        pullRequest: { ...base().pullRequest, mergeability: 'unknown' },
      });
      mount();
      expect(await screen.findByText(text)).toBeTruthy();
      expect(
        screen.getByText(/has not yet reported whether it merges cleanly/),
      ).toBeTruthy();
    },
  );

  test('places an inline comment on its diff line and lists the outdated one', async () => {
    snapshot.current = base({
      reviewComments: {
        state: 'available',
        partial: false,
        comments: [
          {
            id: '11',
            author: 'reviewer',
            body: 'Why three?',
            createdAt: '2026-09-04T16:43:39Z',
            path: 'src/app.ts',
            side: 'additions',
            line: 2,
          },
          {
            id: '12',
            author: 'reviewer',
            body: 'This moved.',
            createdAt: '2026-09-03T10:00:00Z',
            path: 'src/gone.ts',
            side: 'deletions',
            line: null,
          },
        ],
      },
    });
    mount();
    const placed = await waitFor(
      () => {
        const body = screen.getByText('Why three?');
        const thread = body.closest('[data-provider-comment]');
        if (!thread) throw new Error('not rendered as a diff annotation');
        return thread as HTMLElement;
      },
      { timeout: 5_000 },
    );
    expect(placed.getAttribute('data-provider-comment')).toBe('11');
    expect(within(placed).getByText('reviewer')).toBeTruthy();
    // Read-only: no reply or delete on a forge comment.
    expect(within(placed).queryByRole('button')).toBeNull();
    const unplaced = screen.getByText(
      '1 inline comment not on the current diff',
    );
    expect(unplaced.closest('details')?.textContent).toContain('This moved.');
    expect(unplaced.closest('details')?.textContent).toContain('(outdated)');
  });

  test('one quiet row: icon back, the title, icon refresh and forge link', async () => {
    snapshot.current = base();
    const onBack = vi.fn();
    mount(onBack);
    const title = await screen.findByRole('heading', {
      level: 2,
      name: 'Open panes over Chat',
    });
    const bar = title.parentElement as HTMLElement;
    const controls = within(bar).getAllByRole('button');
    expect(controls.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Back to pull requests',
      'Refresh',
      'Open on GitHub',
    ]);
    for (const control of controls) {
      // Icon-only, named and tooltipped: no visible words on the bar.
      expect(control.textContent).toBe('');
      expect(control.getAttribute('title')).toBeTruthy();
      expect(control.querySelector('svg')).toBeTruthy();
    }
    fireEvent.click(controls[0]);
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(controls[2]);
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://github.com/kontourai/station/pull/2049',
    );
  });
});
