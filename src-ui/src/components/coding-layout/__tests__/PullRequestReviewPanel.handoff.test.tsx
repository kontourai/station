/** @vitest-environment jsdom */

/**
 * The review's handoffs to the chat open beside it, against the REAL chat
 * store (design audit D2), and its merge menu.
 *
 * The navigation names the open chat by its conversation id; the store keys
 * the same chat by its session id. The pane used to look the navigation id
 * up as a store key and refuse with "no longer available" while the chat sat
 * open beside it. Reverting `addToChat` to a direct snapshot lookup fails the
 * first test here.
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
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { activeChatsStore } from '../../../contexts/active-chats-store';

beforeAll(() => {
  // jsdom lays nothing out; the outcome line's scroll-into-view is a no-op.
  Element.prototype.scrollIntoView = () => {};
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const drafts = new Map<string, string>();
const mergeReviewedPullRequest = vi.fn(async () => ({
  available: true,
  data: { status: 'merged' as const },
}));
const snapshot = vi.hoisted(() => ({
  current: undefined as unknown as PullRequestReviewSnapshot,
}));

vi.mock('../../../platform/openExternalLink', () => ({
  openExternalLink: vi.fn(async () => {}),
}));
vi.mock('@kontourai/station-sdk/pull-request-review', () => ({
  getPullRequestReview: async () => ({
    available: true,
    effectiveCapabilities: {
      list: true,
      detail: true,
      open: true,
      comment: true,
      approve: true,
      merge: true,
      autoMerge: true,
    },
    effectiveMergeMethods: ['squash', 'merge'],
    mergeMethodsSource: 'repository',
    data: snapshot.current,
  }),
  mergeReviewedPullRequest: (...args: unknown[]) =>
    mergeReviewedPullRequest(...(args as [])),
  submitPullRequestReview: vi.fn(),
}));
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
// The navigation holds the chat's CONVERSATION id (the `?chat=` parameter).
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: (select: (state: { activeChat: string }) => unknown) =>
    select({ activeChat: 'conv-1' }),
}));
// The real store; the draft actions keep a plain map, keyed as the context
// keys them (by the chat's store key).
vi.mock('../../../contexts/ActiveChatsContext', async () => {
  const { activeChatsStore: store } = await import(
    '../../../contexts/active-chats-store'
  );
  return {
    activeChatsStore: store,
    useActiveChatActions: () => ({
      getDraft: (id: string) => drafts.get(id) ?? '',
      setDraft: (id: string, text: string) => drafts.set(id, text),
      updateChat: (id: string, updates: { input?: string }) =>
        store.updateChat(id, updates),
    }),
  };
});
vi.mock('../../../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({
    guard: (action: () => void) => action(),
    DiscardModal: () => null,
  }),
}));

import { PullRequestReviewPanel } from '../PullRequestReviewPanel';

const HEAD = 'a'.repeat(40);
function base(): PullRequestReviewSnapshot {
  return {
    pullRequest: {
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
      ref: '2049',
      nativeId: '2049',
      url: 'https://github.com/kontourai/station/pull/2049',
      title: 'Open panes over Chat',
      body: null,
      state: 'OPEN',
      author: { login: 'author' },
      sourceBranch: 'fix',
      targetBranch: 'main',
      commits: 1,
      reviewStatus: 'NONE',
      comments: 0,
      mergeability: 'mergeable',
    },
    headSha: HEAD,
    baseSha: 'b'.repeat(40),
    observedAt: '2026-09-10T00:00:00Z',
    diff: {
      state: 'available',
      completeness: 'provider-output',
      patch:
        'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-1\n+2\n',
    },
    discussion: [],
    discussionPartial: false,
    checks: {
      state: 'available',
      partial: false,
      checks: [
        {
          name: 'Windows PR portable floor',
          state: 'failure',
          group: 'Windows PR Verification',
          url: 'https://github.com/kontourai/station/actions/runs/3/job/4',
        },
        { name: 'fast-checks', state: 'success', group: 'CI' },
      ],
    },
  };
}

function mount() {
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
        onBack={() => {}}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  drafts.clear();
  snapshot.current = base();
  // The chat open beside the pane: keyed by session id, named by the
  // navigation through its conversation id.
  activeChatsStore.removeChat('agent:123');
  activeChatsStore.initChat('agent:123', {
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'The chat',
    conversationId: 'conv-1',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('review handoffs to the open chat', () => {
  test('Add to chat reaches the chat the navigation names by conversation id (D2)', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add to chat', exact: true }),
    );
    expect(screen.getByText('Added to draft').getAttribute('role')).toBe(
      'status',
    );
    expect(screen.queryByText(/no longer available/)).toBeNull();
    // One line, under the chat's STORE key, where the composer reads it.
    expect(drafts.get('agent:123')).toBe(
      `Review kontourai/station #2049 at ${HEAD}: https://github.com/kontourai/station/pull/2049`,
    );
    expect(drafts.has('conv-1')).toBe(false);
    expect(activeChatsStore.getSnapshot()['agent:123']?.input).toBe(
      drafts.get('agent:123'),
    );
  });

  test('a check row adds that check — name, state and link — to the chat', async () => {
    mount();
    const row = (await screen.findByText('Windows PR portable floor')).closest(
      'li',
    ) as HTMLElement;
    const add = within(row).getByRole('button', {
      name: 'Add Windows PR portable floor to chat',
    });
    expect(add.textContent).toBe('');
    expect(add.getAttribute('title')).toBe('Add to chat');
    fireEvent.click(add);
    expect(drafts.get('agent:123')).toBe(
      'Check "Windows PR portable floor" failed on kontourai/station #2049: https://github.com/kontourai/station/actions/runs/3/job/4',
    );
    // A second add appends under a blank line rather than replacing.
    fireEvent.click(
      screen.getByRole('button', { name: 'Add to chat', exact: true }),
    );
    expect(drafts.get('agent:123')?.split('\n\n')).toHaveLength(2);
  });

  test('says "That chat is gone" when the named chat is in no store entry', async () => {
    activeChatsStore.removeChat('agent:123');
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add to chat', exact: true }),
    );
    expect(screen.getByText('That chat is gone').getAttribute('role')).toBe(
      'status',
    );
    expect(drafts.size).toBe(0);
  });
});

describe('merge is one menu', () => {
  test('the row holds Post comment and Approve; Merge is a menu with the method as a choice', async () => {
    mount();
    await screen.findByRole('button', { name: 'Approve', exact: true });
    // The old labelled trio and the select are gone.
    for (const name of [
      'Approve this head',
      'Merge inspected head',
      'Queue inspected head',
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('combobox')).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Merge options' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.textContent).toContain('Merge');
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Merge options' });
    const choices = within(menu).getAllByRole('menuitemcheckbox');
    expect(
      choices.map((c) => [c.textContent, c.getAttribute('aria-checked')]),
    ).toEqual([
      ['Squash and merge', 'false'],
      ['Merge commit', 'true'],
    ]);
    fireEvent.click(choices[0]);
    // The choice closes the menu; the command then uses it.
    fireEvent.click(trigger);
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', {
        name: 'Merge now',
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Merge pull request',
    });
    expect(dialog.textContent).toContain('with squash and merge');
    expect(dialog.textContent).toContain(HEAD);
    expect(dialog.textContent).not.toMatch(/forge operator|inspected head/);
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Merge', exact: true }),
    );
    await waitFor(() =>
      expect(mergeReviewedPullRequest).toHaveBeenCalledWith(
        'http://station.test',
        expect.objectContaining({ ref: '2049' }),
        { method: 'squash', autoMerge: false, expectedHeadSha: HEAD },
        expect.anything(),
      ),
    );
    expect(await screen.findByText('Merged.')).toBeTruthy();
  });

  test('auto-merge is the menu’s other command and confirms as such', async () => {
    mergeReviewedPullRequest.mockResolvedValueOnce({
      available: true,
      data: { status: 'queued-auto-merge' as const },
    } as never);
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Merge options' }),
    );
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', {
        name: 'Enable auto-merge',
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Enable auto-merge',
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Enable auto-merge' }),
    );
    await waitFor(() =>
      expect(mergeReviewedPullRequest).toHaveBeenCalledWith(
        'http://station.test',
        expect.anything(),
        { method: 'merge', autoMerge: true, expectedHeadSha: HEAD },
        expect.anything(),
      ),
    );
    expect(await screen.findByText('Auto-merge enabled.')).toBeTruthy();
  });
});
