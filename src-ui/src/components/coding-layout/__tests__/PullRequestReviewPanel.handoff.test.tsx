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
  act,
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
const sdkState = vi.hoisted(() => ({
  mergeMethodsSource: 'repository' as 'repository' | 'provider-default',
}));
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
    mergeMethodsSource: sdkState.mergeMethodsSource,
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

function mount(focusTitleOnOpen = false) {
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
        focusTitleOnOpen={focusTitleOnOpen}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  drafts.clear();
  sdkState.mergeMethodsSource = 'repository';
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
    const add = await screen.findByRole('button', { name: 'Add to chat' });
    // The live region is there before anything is said, and says nothing.
    // (By class: the lazily loaded diff's skeleton is a status too, briefly.)
    const live = document.querySelector(
      '.pull-request-review__status--live',
    ) as HTMLElement;
    expect(live.getAttribute('role')).toBe('status');
    expect(live.textContent).toBe('');
    expect(live.getAttribute('aria-live')).toBe('polite');
    fireEvent.click(add);
    expect(live.textContent).toBe('Added to draft');
    // The pressed icon answers next to the press: a check, for a moment.
    expect(add.getAttribute('title')).toBe('Added');
    expect(add.dataset.added).toBe('true');
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
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect(drafts.get('agent:123')?.split('\n\n')).toHaveLength(2);
  });

  test('says "That chat is gone" when the named chat is in no store entry', async () => {
    activeChatsStore.removeChat('agent:123');
    mount();
    const add = await screen.findByRole('button', { name: 'Add to chat' });
    fireEvent.click(add);
    expect(screen.getByText('That chat is gone').getAttribute('role')).toBe(
      'status',
    );
    expect(add.dataset.added).toBeUndefined();
    expect(drafts.size).toBe(0);
  });

  test('the message clears after a few seconds and the check icon sooner', async () => {
    mount();
    const add = await screen.findByRole('button', { name: 'Add to chat' });
    const live = () =>
      document.querySelector('.pull-request-review__status--live')?.textContent;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(add);
      expect(live()).toBe('Added to draft');
      act(() => {
        vi.advanceTimersByTime(2_100);
      });
      expect(add.dataset.added).toBeUndefined();
      expect(live()).toBe('Added to draft');
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(live()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  test('when asked, the review takes focus on its title once loaded', async () => {
    mount(true);
    const title = await screen.findByRole('heading', {
      level: 2,
      name: 'Open panes over Chat',
    });
    await waitFor(() => expect(document.activeElement).toBe(title));
  });
});

describe('merge is one menu', () => {
  test('Approve is the primary beside one Merge menu; Post comment is the comment field’s own; the method is a radio choice', async () => {
    mount();
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve.className).toContain('button--primary');
    const mergeTrigger = screen.getByRole('button', { name: 'Merge options' });
    // One row: Approve and the Merge trigger share a parent; Post comment
    // does not.
    expect(approve.parentElement).toBe(mergeTrigger.parentElement);
    expect(
      screen.getByRole('button', { name: 'Post comment' }).parentElement,
    ).not.toBe(approve.parentElement);
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
    // One of N: radio rows, the chosen one drawn with a check.
    const choices = within(menu).getAllByRole('menuitemradio');
    expect(
      choices.map((c) => [c.textContent, c.getAttribute('aria-checked')]),
    ).toEqual([
      ['Squash and merge', 'false'],
      ['Merge commit', 'true'],
    ]);
    expect(choices[1].querySelector('.menu-row__glyph svg')).toBeTruthy();
    expect(choices[0].querySelector('.menu-row__glyph svg')).toBeNull();
    // A separator stands between the choices and the commands.
    const mergeNow = within(menu).getByRole('menuitem', { name: 'Merge now' });
    expect(
      mergeNow.previousElementSibling?.classList.contains(
        'action-overflow__separator',
      ),
    ).toBe(true);
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
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

  test('default merge methods are said so inside the menu', async () => {
    sdkState.mergeMethodsSource = 'provider-default';
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Merge options' }),
    );
    const note = within(await screen.findByRole('menu')).getByRole('menuitem', {
      name: 'Default methods',
    });
    expect(note.getAttribute('aria-disabled')).toBe('true');
    expect(note.textContent).toContain('Repository settings could not be read');
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
