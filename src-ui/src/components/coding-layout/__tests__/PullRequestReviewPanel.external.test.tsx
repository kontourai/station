/** @vitest-environment jsdom */

/**
 * The review pane's way to the forge: an action named for the forge the
 * pull request's URL points at, which hands that URL to the platform's
 * external opener (`openExternalLink`, whose native refusal is reported —
 * `openExternalLink.native-refusal.test.tsx`). The label is derived
 * from the URL the provider supplied, so it names where the click goes.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const openExternalLink = vi.fn(async (_url: string) => {});
let reviewUrl = 'https://github.com/kontourai/station/pull/2049';

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
    data: {
      pullRequest: {
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
        ref: '2049',
        nativeId: '2049',
        url: reviewUrl,
        title: 'Open panes over Chat',
        body: 'Body',
        state: 'open',
        author: { login: 'author' },
        sourceBranch: 'fix',
        targetBranch: 'main',
        commits: 1,
        reviewStatus: 'NONE',
        comments: 0,
        mergeability: 'mergeable',
      },
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      observedAt: '2026-09-10T00:00:00Z',
      diff: { state: 'unavailable', reason: 'Not supplied.' },
      discussion: [],
      discussionPartial: false,
    },
  }),
  mergeReviewedPullRequest: vi.fn(),
  submitPullRequestReview: vi.fn(),
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

import {
  PullRequestReviewPanel,
  pullRequestExternalLabel,
} from '../PullRequestReviewPanel';

function mount() {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
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
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  reviewUrl = 'https://github.com/kontourai/station/pull/2049';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('opening the pull request on its forge', () => {
  test('"Open on GitHub" hands the pull request’s own URL to the external opener', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open on GitHub' }),
    );
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://github.com/kontourai/station/pull/2049',
    );
  });

  test('a GitLab URL is named GitLab', async () => {
    reviewUrl = 'https://gitlab.com/team/repo/-/merge_requests/17';
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open on GitLab' }),
    );
    expect(openExternalLink).toHaveBeenCalledWith(reviewUrl);
  });

  test('the label names the forge only when the URL is that forge’s', () => {
    expect(pullRequestExternalLabel('https://github.com/o/r/pull/1')).toBe(
      'Open on GitHub',
    );
    // Only gitlab.com is named: a `gitlab.*` host is not GitLab's by name.
    expect(pullRequestExternalLabel('https://gitlab.example.org/o/r/-/1')).toBe(
      'Open in browser',
    );
    expect(pullRequestExternalLabel('https://www.gitlab.com/o/r/-/1')).toBe(
      'Open on GitLab',
    );
    expect(pullRequestExternalLabel('https://gitlab.com/o/r/-/1')).toBe(
      'Open on GitLab',
    );
    expect(pullRequestExternalLabel('https://forge.test/o/r/pull/1')).toBe(
      'Open in browser',
    );
    // A host that merely CONTAINS a forge's name is not that forge.
    expect(pullRequestExternalLabel('https://github.com.evil.test/x')).toBe(
      'Open in browser',
    );
    expect(pullRequestExternalLabel('not a url')).toBe('Open in browser');
  });
});
