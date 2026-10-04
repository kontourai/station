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
  act,
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

import { PaneHeadSlotsContext } from '../../../workspace-panes/PaneHeadSlots';
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
    // Small toned counts, failures first; the paragraph is static (no live
    // region for a value that does not change under the reader).
    const counts = screen.getByText('1 failed').parentElement as HTMLElement;
    expect(counts.getAttribute('role')).toBeNull();
    expect(
      Array.from(counts.querySelectorAll('.pull-request-review__count')).map(
        (count) => [count.textContent, count.getAttribute('data-tone')],
      ),
    ).toEqual([
      ['1 failed', 'failure'],
      ['1 pending', 'pending'],
      ['1 passed', 'success'],
      ['1 skipped', 'neutral'],
    ]);
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
    // The disclosure names only the states it holds, and is a native
    // summary with a visible caret.
    const label = screen.getByText('Show the other 2 passed or skipped checks');
    const summary = label.closest('summary') as HTMLElement;
    expect(summary.tagName).toBe('SUMMARY');
    expect(
      summary.querySelector('svg.pull-request-review__caret'),
    ).toBeTruthy();
    const settled = summary.closest('details');
    expect(settled?.open).toBe(false);
    expect(items[2].closest('details')).toBe(settled);
    expect(items[3].closest('details')).toBe(settled);
    fireEvent.click(summary);
    expect(settled?.open).toBe(true);
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

  test('when every check passed it says so in one line and the disclosure names only "passed"', async () => {
    snapshot.current = base({
      checks: {
        state: 'available',
        partial: false,
        checks: [
          { name: 'a', state: 'success' },
          { name: 'b', state: 'success' },
          { name: 'c', state: 'success' },
        ],
      },
    });
    mount();
    expect(await screen.findByText('3 checks passed')).toBeTruthy();
    expect(screen.queryByText(/3 passed$/)).toBeNull();
    expect(
      screen.getByText('Show 3 passed checks').closest('summary'),
    ).toBeTruthy();
  });

  test('the head is two scannable lines: chips, branches, short id and relative time', async () => {
    snapshot.current = base({
      pullRequest: {
        ...base().pullRequest,
        state: 'OPEN',
        reviewStatus: 'CHANGES_REQUESTED',
        commits: 2,
      },
      observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    mount();
    const state = await screen.findByText('Open');
    expect(state.className).toContain('pull-request-chip');
    expect(state.getAttribute('data-tone')).toBe('success');
    const decision = screen.getByText('Changes requested');
    expect(decision.className).toContain('pull-request-chip');
    expect(decision.getAttribute('data-tone')).toBe('failure');
    // Never the raw enum.
    expect(screen.queryByText(/CHANGES_REQUESTED/)).toBeNull();
    expect(screen.queryByText(/\bOPEN\b/)).toBeNull();
    const short = screen.getByText('aaaaaaa');
    expect(short.tagName).toBe('CODE');
    expect(short.getAttribute('title')).toBe(`Head ${'a'.repeat(40)}`);
    expect(screen.queryByText('a'.repeat(40))).toBeNull();
    const observed = screen.getByText('5m');
    expect(observed.tagName).toBe('TIME');
    expect(observed.getAttribute('title')).toBeTruthy();
    expect(screen.getByText('2 commits')).toBeTruthy();
    expect(screen.getByText('kontourai/station #2049')).toBeTruthy();
  });

  test.each([
    ['MERGED', 'Merged'],
    ['closed', 'Closed'],
    ['opened', 'Open'],
  ])('state %s reads as %s', async (state, label) => {
    snapshot.current = base({
      pullRequest: { ...base().pullRequest, state },
    });
    mount();
    expect(
      (await screen.findByText(label)).getAttribute('data-tone'),
    ).toBeTruthy();
  });

  test.each([
    ['requested_changes', 'Changes requested', 'failure'],
    ['PENDING', 'Review pending', 'neutral'],
    ['not_approved', 'Review required', 'pending'],
    ['ci_must_pass', 'CI must pass', 'neutral'],
    ['discussions_not_resolved', 'Discussions not resolved', 'neutral'],
  ])(
    'review status %s is the chip "%s" with %s tone',
    async (reviewStatus, label, tone) => {
      snapshot.current = base({
        pullRequest: { ...base().pullRequest, reviewStatus },
      });
      mount();
      const chip = await screen.findByText(label);
      expect(chip.className).toContain('pull-request-chip');
      expect(chip.getAttribute('data-tone')).toBe(tone);
      expect(screen.queryByText(reviewStatus)).toBeNull();
    },
  );

  test.each(['mergeable', 'checking', 'unchecked', 'NONE'])(
    'review status %s shows no decision chip (the mergeability sentence covers it)',
    async (reviewStatus) => {
      snapshot.current = base({
        pullRequest: { ...base().pullRequest, reviewStatus },
      });
      mount();
      await screen.findByText('Open');
      expect(document.querySelectorAll('.pull-request-chip')).toHaveLength(1);
      expect(screen.queryByText(/mergeable|checking|unchecked/i)).toBeNull();
    },
  );

  test('the relative time keeps up with the clock every 30 s and stops on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const start = Date.parse('2026-10-01T12:00:00Z');
      vi.setSystemTime(start);
      snapshot.current = base({
        observedAt: new Date(start - 5 * 60_000).toISOString(),
      });
      mount();
      expect(await screen.findByText('5m')).toBeTruthy();
      vi.setSystemTime(start + 61_000);
      // Nothing moves until the tick.
      expect(screen.getByText('5m')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(screen.getByText('6m')).toBeTruthy();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      cleanup();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the description gets its own heading, and none when the body is empty', async () => {
    snapshot.current = base({
      pullRequest: { ...base().pullRequest, body: 'Keeps the last error.' },
    });
    mount();
    const heading = await screen.findByRole('heading', {
      level: 3,
      name: 'Description',
    });
    expect(heading.nextElementSibling?.textContent).toBe(
      'Keeps the last error.',
    );
    cleanup();
    snapshot.current = base({
      pullRequest: { ...base().pullRequest, body: '  ' },
    });
    mount();
    await screen.findByText('Open');
    expect(
      screen.queryByRole('heading', { level: 3, name: 'Description' }),
    ).toBeNull();
  });

  test.each([
    [undefined, 'Checks not reported'],
    [
      { state: 'unavailable', reason: 'The provider did not report checks.' },
      'The provider did not report checks.',
    ],
    [{ state: 'available', checks: [], partial: false }, 'No checks'],
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
        screen.getByText(/Mergeability not yet reported for/),
      ).toBeTruthy();
    },
  );

  test('inside a host head the changed-files diff keeps its own row: the head is left to the Diff pane', async () => {
    snapshot.current = base();
    const leading = document.createElement('div');
    const trailing = document.createElement('div');
    document.body.append(leading, trailing);
    try {
      const view = render(
        <QueryClientProvider client={new QueryClient()}>
          <PaneHeadSlotsContext.Provider value={{ leading, trailing }}>
            <PullRequestReviewPanel
              target={{
                provider: 'github',
                host: 'github.com',
                owner: 'kontourai',
                repository: 'station',
                ref: '2049',
                project: 'station',
              }}
            />
          </PaneHeadSlotsContext.Provider>
        </QueryClientProvider>,
      );
      const wrap = await screen.findByRole('button', { name: 'Wrap lines' });
      const bar = view.container.querySelector(
        '.pull-request-review__diff .diff-panel__bar',
      );
      expect(bar?.contains(wrap)).toBe(true);
      expect(bar?.querySelector('.diff-stat')?.textContent).toMatch(
        /^1 file\+1−1$/,
      );
      expect(leading.childNodes.length).toBe(0);
      expect(trailing.childNodes.length).toBe(0);
    } finally {
      cleanup();
      leading.remove();
      trailing.remove();
    }
  });

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
            subject: 'line',
            line: 2,
          },
          {
            id: '12',
            author: 'reviewer',
            body: 'This moved.',
            createdAt: '2026-09-03T10:00:00Z',
            path: 'src/gone.ts',
            side: 'deletions',
            subject: 'line',
            line: null,
          },
          {
            id: '13',
            author: 'reviewer',
            body: 'Rename this file.',
            createdAt: '2026-09-03T11:00:00Z',
            path: 'README.md',
            side: 'additions',
            subject: 'file',
            line: null,
            url: 'https://github.com/kontourai/station/pull/2049#discussion_r13',
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
    expect(
      screen.getByRole('heading', { level: 3, name: 'Inline comments' }),
    ).toBeTruthy();
    const unplaced = screen.getByText('2 comments not on the current diff');
    expect(unplaced.closest('summary')).toBeTruthy();
    const list = unplaced.closest('details') as HTMLElement;
    // Each forge comment is a named article, apart from a local comment.
    const outdated = within(list).getByRole('article', {
      name: 'Comment by reviewer on an outdated line of src/gone.ts',
    });
    expect(outdated.textContent).toContain('This moved.');
    expect(outdated.textContent).toContain('on an outdated line of');
    // A file-level comment is on the file; it is not "outdated".
    const onFile = within(list).getByRole('article', {
      name: 'Comment by reviewer on the file of README.md',
    });
    expect(onFile.textContent).toContain('on the file of');
    expect(onFile.textContent).not.toContain('outdated');
    fireEvent.click(
      within(onFile).getByRole('button', {
        name: 'Open on GitHub',
      }),
    );
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://github.com/kontourai/station/pull/2049#discussion_r13',
    );
  });

  test('three settled states read as a list: "passed, neutral or skipped"', async () => {
    snapshot.current = base({
      checks: {
        state: 'available',
        partial: false,
        checks: [
          { name: 'a', state: 'failure' },
          { name: 'b', state: 'success' },
          { name: 'c', state: 'neutral' },
          { name: 'd', state: 'skipped' },
        ],
      },
    });
    mount();
    expect(
      await screen.findByText(
        'Show the other 3 passed, neutral or skipped checks',
      ),
    ).toBeTruthy();
  });

  test('a CRLF patch keeps clean paths, and a "diff --git" line ends a hunk whose counts lied', async () => {
    // The first hunk claims 5 new lines but shows 1; without the section
    // boundary, b.ts's lines would be credited to a.ts.
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,5 @@',
      '+only one',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,2 @@',
      ' kept',
      '+added',
      '',
    ].join('\r\n');
    snapshot.current = base({
      diff: { state: 'available', patch, completeness: 'provider-output' },
      reviewComments: {
        state: 'available',
        partial: false,
        comments: [
          {
            id: '41',
            author: 'reviewer',
            body: 'On b, line 2.',
            createdAt: '2026-09-04T16:43:39Z',
            path: 'src/b.ts',
            side: 'additions',
            subject: 'line',
            line: 2,
          },
          {
            id: '42',
            author: 'reviewer',
            body: 'On a, a line it never showed.',
            createdAt: '2026-09-04T16:44:00Z',
            path: 'src/a.ts',
            side: 'additions',
            subject: 'line',
            line: 2,
          },
        ],
      },
    });
    mount();
    const unplaced = await screen.findByText(
      '1 comment not on the current diff',
    );
    const list = unplaced.closest('details') as HTMLElement;
    // b.ts line 2 is a real added line under a clean (no `\r`) path.
    expect(list.textContent).not.toContain('On b, line 2.');
    // a.ts line 2 was never shown: the lying hunk must not reach into b.ts.
    expect(list.textContent).toContain('On a, a line it never showed.');
    expect(list.textContent).toContain('line 2 of src/a.ts');
  });

  test('places a comment on a deleted file, and an added line starting with "++ " is not a file header', async () => {
    const patch = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const gone = 1;
-export default gone;
diff --git a/src/inc.ts b/src/inc.ts
--- a/src/inc.ts
+++ b/src/inc.ts
@@ -1,2 +1,3 @@
 let n = 0;
+++ n;
 export { n };
`;
    snapshot.current = base({
      diff: { state: 'available', patch, completeness: 'provider-output' },
      reviewComments: {
        state: 'available',
        partial: false,
        comments: [
          {
            id: '31',
            author: 'reviewer',
            body: 'Why delete this?',
            createdAt: '2026-09-04T16:43:39Z',
            path: 'src/gone.ts',
            side: 'deletions',
            subject: 'line',
            line: 2,
          },
          {
            id: '32',
            author: 'reviewer',
            body: 'Still exported.',
            createdAt: '2026-09-04T16:44:00Z',
            path: 'src/inc.ts',
            side: 'additions',
            subject: 'line',
            line: 3,
          },
        ],
      },
    });
    mount();
    await waitFor(
      () => expect(screen.getByText('Why delete this?')).toBeTruthy(),
      { timeout: 5_000 },
    );
    // Both place on the diff: nothing is listed as unplaced.
    expect(screen.queryByText(/not on the current diff/)).toBeNull();
    expect(
      screen.queryByRole('heading', { level: 3, name: 'Inline comments' }),
    ).toBeNull();
  });

  test('says when only part of the checks could be read', async () => {
    snapshot.current = base({
      checks: {
        state: 'available',
        partial: true,
        checks: [{ name: 'build', state: 'success' }],
      },
    });
    mount();
    const caveat = await screen.findByText(
      /Some checks not shown — see GitHub/,
    );
    // The count and the caveat share one static line; a partial read is
    // never "all passed".
    expect(caveat.parentElement?.getAttribute('role')).toBeNull();
    expect(caveat.parentElement?.textContent).toContain('1 passed');
    expect(screen.queryByText('1 check passed')).toBeNull();
  });

  test('lists an inline comment on a changed file but outside its hunks as not on the current diff', async () => {
    snapshot.current = base({
      reviewComments: {
        state: 'available',
        partial: false,
        comments: [
          {
            id: '21',
            author: 'reviewer',
            body: 'Inside the hunk.',
            createdAt: '2026-09-04T16:43:39Z',
            path: 'src/app.ts',
            side: 'additions',
            subject: 'line',
            line: 3,
          },
          {
            id: '22',
            author: 'reviewer',
            body: 'Far below the hunk.',
            createdAt: '2026-09-04T16:44:00Z',
            path: 'src/app.ts',
            side: 'additions',
            subject: 'line',
            line: 40,
          },
          {
            id: '23',
            author: 'reviewer',
            body: 'On the old side, outside.',
            createdAt: '2026-09-04T16:45:00Z',
            path: 'src/app.ts',
            side: 'deletions',
            subject: 'line',
            line: 9,
          },
        ],
      },
    });
    mount();
    await waitFor(
      () => expect(screen.getByText('Inside the hunk.')).toBeTruthy(),
      { timeout: 5_000 },
    );
    const unplaced = screen.getByText('2 comments not on the current diff');
    const list = unplaced.closest('details');
    expect(list?.textContent).toContain('Far below the hunk.');
    expect(list?.textContent).toContain('line 40 of');
    expect(list?.textContent).toContain('On the old side, outside.');
    expect(list?.textContent).not.toContain('Inside the hunk.');
    expect(list?.textContent).not.toContain('outdated');
  });

  test('says when merging is not permitted instead of hiding the control', async () => {
    snapshot.current = base({
      pullRequest: { ...base().pullRequest, mergeability: 'mergeable' },
    });
    mount();
    await screen.findByRole('button', { name: 'Approve' });
    expect(screen.queryByRole('button', { name: 'Merge options' })).toBeNull();
    expect(screen.getByText('Merging is not permitted here.')).toBeTruthy();
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
    expect(
      controls.map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ).toEqual([
      'Back to pull requests',
      'Add to chat',
      'Refresh',
      'Open on GitHub',
    ]);
    // Add to chat acts on the whole review and is disabled without an open
    // chat to add to; each check row carries its own, so the bar's is an
    // icon like its neighbours and the bar stays one row at any width.
    const handoff = controls[1];
    expect((handoff as HTMLButtonElement).disabled).toBe(true);
    for (const control of controls) {
      // Icon-only, named and tooltipped: no visible words on the bar.
      expect(control.textContent).toBe('');
      expect(control.getAttribute('title')).toBeTruthy();
      expect(control.querySelector('svg')).toBeTruthy();
    }
    // The old labelled row between Status and the body is gone.
    expect(
      screen.queryByRole('button', { name: 'Add review context to open chat' }),
    ).toBeNull();
    fireEvent.click(controls[0]);
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(controls[3]);
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://github.com/kontourai/station/pull/2049',
    );
  });
});
