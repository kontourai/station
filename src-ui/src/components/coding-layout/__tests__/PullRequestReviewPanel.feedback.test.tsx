/** @vitest-environment jsdom */

/**
 * Agent feedback in the pull request panel: one strip under the head saying
 * which chat gets it (only "another chat" to a reader who may not read it),
 * a gear to the existing dialog, "Off · Turn on…" only when the open chat
 * holds the pull request, and nothing otherwise. A failing check the agent
 * was sent says "Sent 3m", on the head it was sent about only. The feedback
 * answers are the shapes `GET /api/pull-request-feedback/by-pull-request`
 * and `/conversations/:id` return (their route tests pin them).
 */

import type {
  PullRequestFeedbackByPullRequest,
  PullRequestFeedbackView,
} from '@kontourai/station-contracts/pull-request-feedback';
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

const HEAD = 'a'.repeat(40);
const IDENTITY = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'kontourai', name: 'station' },
  ref: '2049',
};
const UNIT_URL = 'https://github.com/kontourai/station/actions/runs/3/job/4';
const state = vi.hoisted(() => ({
  snapshot: undefined as unknown as PullRequestReviewSnapshot,
  byPullRequest: undefined as unknown,
  views: {} as Record<string, unknown>,
  activeChat: null as string | null,
  byPullRequestReads: 0,
  conversationReads: [] as string[],
}));
const openConversation = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../../../platform/openExternalLink', () => ({
  openExternalLink: vi.fn(async () => {}),
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
    data: state.snapshot,
  }),
  mergeReviewedPullRequest: vi.fn(),
  submitPullRequestReview: vi.fn(),
}));
vi.mock('@kontourai/station-sdk/pull-request-feedback', () => ({
  readPullRequestFeedbackCapability: vi.fn(async () => true),
  getPullRequestFeedbackByPullRequest: vi.fn(async () => {
    state.byPullRequestReads += 1;
    return state.byPullRequest;
  }),
  getConversationPullRequestFeedback: vi.fn(async (_base, id: string) => {
    state.conversationReads.push(id);
    return {
      conversationId: id,
      pullRequests: state.views[id] ? [state.views[id]] : [],
    };
  }),
  pullRequestFeedbackOwnerOf: () => undefined,
  pullRequestHeadReviewRefusal: () => undefined,
  writePullRequestFeedback: vi.fn(),
  sendPullRequestFeedbackAgain: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useDiffCommentsQuery: () => ({ data: [] }),
  useCreateDiffCommentMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteDiffCommentMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useFeaturePreviewsQuery: () => ({
    data: [{ id: 'pull-request-agent-feedback', enabled: true }],
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'test',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: (select: (value: { activeChat: string | null }) => unknown) =>
    select({ activeChat: state.activeChat }),
}));
vi.mock('../../../contexts/ActiveChatsContext', () => ({
  activeChatsStore: {
    getSnapshot: () => ({ 'session-1': { conversationId: 'chat-here' } }),
    getChatKeyForExecutionSession: (id: string) =>
      id === 'session-1' ? 'session-1' : undefined,
  },
  useActiveChatActions: () => ({
    getDraft: () => '',
    setDraft: () => {},
    updateChat: () => {},
  }),
}));
vi.mock('../../../contexts/open-chats-store', () => ({
  openChatsStore: { openConversation },
}));
vi.mock('../../../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({
    guard: (action: () => void) => action(),
    DiscardModal: () => null,
  }),
}));

import { PullRequestReviewPanel } from '../PullRequestReviewPanel';

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function snapshot(): PullRequestReviewSnapshot {
  return {
    pullRequest: {
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
      ref: '2049',
      nativeId: '2049',
      url: 'https://github.com/kontourai/station/pull/2049',
      title: 'Open panes over Chat',
      body: '',
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
    diff: { state: 'unavailable', reason: 'No diff.' },
    discussion: [],
    discussionPartial: false,
    checks: {
      state: 'available',
      partial: false,
      checks: [
        // Matched by its link.
        { name: 'unit-tests', state: 'failure', group: 'ci', url: UNIT_URL },
        // Matched by "workflow / job" (no link).
        { name: 'lint', state: 'failure', group: 'ci' },
        // Failing, never sent.
        { name: 'e2e', state: 'failure', group: 'ci' },
        // Sent by name, but not failing now.
        { name: 'types', state: 'pending', group: 'ci' },
      ],
    },
  } as PullRequestReviewSnapshot;
}

function readable(
  overrides: Partial<PullRequestFeedbackByPullRequest> = {},
): PullRequestFeedbackByPullRequest {
  return {
    identity: IDENTITY,
    owner: {
      readable: true,
      conversationId: 'chat-owner',
      title: 'Fix the parser',
    },
    status: { state: 'watching' },
    settings: {
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: false,
    },
    last: {
      id: 'b1',
      at: minutesAgo(3),
      headSha: HEAD,
      categories: [{ category: 'failing-checks', count: 2 }],
      state: 'sent',
    },
    sentChecks: {
      headSha: HEAD,
      checks: [
        { name: 'ci / unit-tests', url: UNIT_URL, at: minutesAgo(3) },
        { name: 'ci / lint', at: minutesAgo(3) },
        { name: 'ci / types', at: minutesAgo(3) },
      ],
    },
    ...overrides,
  };
}

function view(conversationId: string): PullRequestFeedbackView {
  return {
    identity: IDENTITY,
    ownedHere: conversationId === 'chat-owner',
    owner: null,
    settings: {
      fixFailingChecks: conversationId === 'chat-owner',
      addressReviewComments: false,
      reviewEachHead: false,
    },
    status: { state: conversationId === 'chat-owner' ? 'watching' : 'off' },
    history: [],
  };
}

function mount() {
  state.snapshot = snapshot();
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
      />
    </QueryClientProvider>,
  );
}

const strip = () =>
  screen.getByText('Agent feedback', { selector: '.pr-feedback-strip__label' })
    .parentElement as HTMLElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.views = {};
  state.activeChat = null;
  state.byPullRequestReads = 0;
  state.conversationReads = [];
});

describe('the agent feedback strip', () => {
  test('a readable owner: status, its chat, the last send, and a gear to the dialog', async () => {
    state.byPullRequest = readable();
    state.views = { 'chat-owner': view('chat-owner') };
    mount();
    await screen.findByText('Agent feedback', {
      selector: '.pr-feedback-strip__label',
    });
    const line = within(strip());
    expect(line.getByText('Auto-fix on')).toBeTruthy();
    expect(line.getByText('Sent 2 failing checks')).toBeTruthy();
    expect(line.getByText('3m')).toBeTruthy();
    fireEvent.click(line.getByRole('button', { name: 'Fix the parser' }));
    expect(openConversation).toHaveBeenCalledWith('chat-owner');
    fireEvent.click(
      line.getByRole('button', { name: 'Agent feedback settings' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: /Agent feedback/,
    });
    // The owner's own switches, read from the owner's chat.
    await waitFor(() =>
      expect(
        within(dialog)
          .getByRole('switch', { name: 'Fix failing checks automatically' })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(state.conversationReads).toContain('chat-owner');
    // Opened from another chat, the switches name the chat they belong to.
    expect(
      within(dialog).getByText(
        'Sends failing checks and merge conflicts to the agent in “Fix the parser”.',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/this chat's agent/)).toBeNull();
  });

  test('an owner the reader may not read is only "another chat": no title, status or settings', async () => {
    state.byPullRequest = { identity: IDENTITY, owner: { readable: false } };
    state.activeChat = 'session-1';
    state.views = { 'chat-here': view('chat-here') };
    mount();
    await screen.findByText('goes to another chat');
    const line = within(strip());
    expect(line.queryByRole('button')).toBeNull();
    expect(line.queryByText('Auto-fix on')).toBeNull();
    expect(strip().textContent).toBe('Agent feedback·goes to another chat');
  });

  test('off, but linked to the open chat: "Off · Turn on…" opens that chat\'s switches', async () => {
    state.byPullRequest = { identity: IDENTITY, owner: null };
    state.activeChat = 'session-1';
    state.views = { 'chat-here': view('chat-here') };
    mount();
    const turnOn = await screen.findByRole('button', { name: 'Turn on…' });
    expect(within(strip()).getByText('Off')).toBeTruthy();
    // Read as the open chat's conversation, not its session id.
    expect(state.conversationReads).toContain('chat-here');
    fireEvent.click(turnOn);
    expect(
      await screen.findByRole('dialog', { name: /Agent feedback/ }),
    ).toBeTruthy();
  });

  test('no owner and not linked to the open chat: no strip at all', async () => {
    state.byPullRequest = { identity: IDENTITY, owner: null };
    state.activeChat = 'session-1';
    mount();
    await screen.findByText('Open panes over Chat', { selector: 'h2' });
    await waitFor(() => expect(state.conversationReads).toContain('chat-here'));
    await waitFor(() => expect(state.byPullRequestReads).toBeGreaterThan(0));
    expect(document.querySelector('.pr-feedback-strip')).toBeNull();
  });
});

describe('"Sent" on a failing check', () => {
  const sentOn = (name: string) =>
    within(
      screen
        .getByText(name, { selector: '.pull-request-review__check-name' })
        .closest('li') as HTMLElement,
    ).queryByText(/^Sent/);

  test('only on failing rows the agent was sent, matched by link or by "workflow / job"', async () => {
    state.byPullRequest = readable();
    mount();
    await screen.findByText('Auto-fix on');
    await waitFor(() =>
      expect(sentOn('unit-tests')?.textContent).toBe('Sent 3m'),
    );
    expect(sentOn('lint')?.textContent).toBe('Sent 3m');
    expect(sentOn('e2e')).toBeNull();
    expect(sentOn('types')).toBeNull();
  });

  test('never for checks sent about another head', async () => {
    const sent = readable();
    state.byPullRequest = {
      ...sent,
      sentChecks: { ...sent.sentChecks!, headSha: 'c'.repeat(40) },
    };
    mount();
    await screen.findByText('Auto-fix on');
    expect(sentOn('unit-tests')).toBeNull();
    expect(sentOn('lint')).toBeNull();
  });
});
