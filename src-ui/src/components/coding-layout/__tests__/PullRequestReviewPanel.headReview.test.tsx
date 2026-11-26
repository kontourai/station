/** @vitest-environment jsdom */

/**
 * "Station review" in the pull request panel: Station's newest review of a
 * head under the Agent feedback strip, for a reader of the owning chat
 * while "Review each new head" is on. Each state's badge and line, the
 * findings folded past 8, Review again (the one primary action) and Send to
 * agent posting to the owning chat, and the dialog's third switch only
 * while the head review preview is on. The answers are the shapes
 * `GET /api/pull-request-feedback/by-pull-request` returns.
 */

import type {
  PullRequestFeedbackByPullRequest,
  PullRequestFeedbackView,
  PullRequestHeadReview,
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
  previews: [
    { id: 'pull-request-agent-feedback', enabled: true },
    { id: 'pull-request-head-review', enabled: true },
  ],
}));
const actions = vi.hoisted(() => ({
  reviewAgain: vi.fn(async () => {}),
  sendFindings: vi.fn(async () => {}),
  write: vi.fn(async () => ({})),
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
  // The SDK's own test pins which refusals count; here, one that does.
  pullRequestHeadReviewRefusal: (error: unknown) =>
    error instanceof Error && error.name === 'Refusal'
      ? error.message
      : undefined,
  writePullRequestFeedback: actions.write,
  sendPullRequestFeedbackAgain: vi.fn(),
  reviewPullRequestHeadAgain: actions.reviewAgain,
  sendPullRequestHeadReviewFindings: actions.sendFindings,
  turnOffPullRequestFeedback: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useDiffCommentsQuery: () => ({ data: [] }),
  useCreateDiffCommentMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteDiffCommentMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useFeaturePreviewsQuery: () => ({ data: state.previews }),
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.views = {};
  state.activeChat = null;
  state.previews = [
    { id: 'pull-request-agent-feedback', enabled: true },
    { id: 'pull-request-head-review', enabled: true },
  ];
});

const finding = (index: number, required: boolean) => ({
  file: `src/file-${index}.ts`,
  line: index + 1,
  severity: required ? ('high' as const) : ('low' as const),
  confidence: 'high' as const,
  summary: `Finding ${index}.`,
  required,
});

function withReview(
  headReview?: Omit<PullRequestHeadReview, 'current'> & { current?: boolean },
  headReviewWaiting?: PullRequestFeedbackByPullRequest['headReviewWaiting'],
) {
  state.byPullRequest = readable({
    settings: {
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: true,
    },
    ...(headReview ? { headReview: { current: true, ...headReview } } : {}),
    ...(headReviewWaiting ? { headReviewWaiting } : {}),
  });
  state.views['chat-owner'] = {
    ...view('chat-owner'),
    settings: {
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: true,
    },
  };
}

const section = async () =>
  (await screen.findByRole('region', {
    name: 'Station review',
  })) as HTMLElement;

describe('Station review in the pull request panel', () => {
  test('reviewed: badge with the head, required findings sent, the others folded', async () => {
    withReview({
      headSha: HEAD,
      state: 'reviewed',
      at: minutesAgo(2),
      mode: 'initial',
      findings: [
        finding(0, true),
        finding(1, true),
        ...Array.from({ length: 8 }, (_, index) => finding(index + 2, false)),
      ],
      required: 2,
      others: 8,
      delivery: { state: 'sent', at: minutesAgo(1) },
    });
    mount();
    const region = await section();
    expect(within(region).getByText('Reviewed aaaaaaa')).toBeTruthy();
    expect(region.textContent).toContain('2 required findings · Sent 1m');
    // Required only; the others wait behind their own disclosure.
    expect(within(region).getAllByRole('listitem')).toHaveLength(2);
    expect(region.textContent).toContain('src/file-0.ts:1[high]Finding 0.');
    fireEvent.click(within(region).getByRole('button', { name: '8 others' }));
    expect(within(region).getAllByRole('listitem')).toHaveLength(10);
    // Sent already: Review again is the only action, and not a primary
    // beside the panel's own tabs.
    expect(
      within(region).queryByRole('button', { name: 'Send to agent' }),
    ).toBeNull();
    const again = within(region).getByRole('button', { name: 'Review again' });
    expect(again.className).not.toContain('button--primary');
    fireEvent.click(again);
    await waitFor(() =>
      expect(actions.reviewAgain).toHaveBeenCalledWith(
        'http://station.test',
        'chat-owner',
        IDENTITY,
        expect.anything(),
      ),
    );
  });

  test('required findings not sent offer Send to agent to the owning chat', async () => {
    withReview({
      headSha: HEAD,
      state: 'reviewed',
      at: minutesAgo(2),
      findings: [finding(0, true)],
      required: 1,
      others: 0,
    });
    mount();
    const region = await section();
    expect(region.textContent).toContain('1 required finding');
    // Send is the one primary; Review again stays secondary.
    const send = within(region).getByRole('button', { name: 'Send to agent' });
    expect(send.className).toContain('button--primary');
    expect(
      within(region).getByRole('button', { name: 'Review again' }).className,
    ).not.toContain('button--primary');
    fireEvent.click(send);
    await waitFor(() =>
      expect(actions.sendFindings).toHaveBeenCalledWith(
        'http://station.test',
        'chat-owner',
        IDENTITY,
        expect.anything(),
      ),
    );
  });

  test.each([
    [{ state: 'reviewing' as const }, 'Reviewing aaaaaaa', undefined],
    [
      {
        state: 'head-not-local' as const,
        failureReason: "Head aaaaaaa isn't on this Station yet.",
      },
      'Head not local',
      "Head aaaaaaa isn't on this Station yet.",
    ],
    [
      {
        state: 'no-reviewer' as const,
        failureReason:
          'No reviewer can read this Project read-only. Connect Codex to review.',
      },
      'No reviewer',
      'No reviewer can read this Project read-only. Connect Codex to review.',
    ],
    [
      { state: 'unknown' as const },
      'Result unknown',
      "Station doesn't know how this review ended.",
    ],
    [
      {
        state: 'not-verified' as const,
        failureReason:
          'Prior review coverage is unavailable for automatic delta review.',
      },
      'Not reviewed',
      'Prior review coverage is unavailable for automatic delta review.',
    ],
  ])('%o reads %s', async (review, badge, line) => {
    withReview({ headSha: HEAD, at: minutesAgo(1), ...review });
    mount();
    const region = await section();
    expect(within(region).getByText(badge)).toBeTruthy();
    if (line) expect(within(region).getByText(line)).toBeTruthy();
    else expect(region.querySelector('.pr-head-review__line')).toBeNull();
    const again = within(region).getByRole('button', { name: 'Review again' });
    expect((again as HTMLButtonElement).disabled).toBe(
      review.state === 'reviewing',
    );
  });

  test.each([
    ['settling' as const, 'Head aaaaaaa · waiting for the push to settle'],
    ['agent-busy' as const, 'Head aaaaaaa · the agent is working'],
    [
      'feedback-waiting' as const,
      'Head aaaaaaa · feedback is waiting for the agent',
    ],
    [
      'project-busy' as const,
      'Head aaaaaaa · reviewing another pull request in this Project',
    ],
    [
      'daily-limit' as const,
      'Head aaaaaaa · 10 reviews ran in this Project today',
    ],
    ['draft' as const, 'Head aaaaaaa · the pull request is a draft'],
  ])(
    'no review yet (%s) says why, never "Waiting for a push"',
    async (reason, line) => {
      withReview(undefined, { headSha: HEAD, reason });
      mount();
      const region = await section();
      expect(within(region).getByText('Not reviewed yet')).toBeTruthy();
      expect(within(region).getByText(line)).toBeTruthy();
      expect(within(region).queryByText('Waiting for a push')).toBeNull();
    },
  );

  test('an earlier push keeps its review, labelled, with nothing to send', async () => {
    withReview(
      {
        headSha: 'b'.repeat(40),
        current: false,
        state: 'reviewed',
        at: minutesAgo(9),
        findings: [finding(0, true)],
        required: 1,
        others: 0,
      },
      { headSha: HEAD, reason: 'agent-busy' },
    );
    mount();
    const region = await section();
    expect(within(region).getByText('Not reviewed yet')).toBeTruthy();
    expect(
      within(region).getByText(
        'Reviewed bbbbbbb · an earlier push · 1 required finding',
      ),
    ).toBeTruthy();
    expect(
      within(region).queryByRole('button', { name: 'Send to agent' }),
    ).toBeNull();
  });

  test('"Waiting for a push" only before Station has read the pull request', async () => {
    withReview();
    mount();
    const region = await section();
    expect(within(region).getByText('Waiting for a push')).toBeTruthy();
  });

  test("a refused Review again shows the server's reason and reads again", async () => {
    withReview({
      headSha: HEAD,
      state: 'reviewed',
      at: minutesAgo(2),
      findings: [],
      required: 0,
      others: 0,
    });
    actions.reviewAgain.mockRejectedValueOnce(
      Object.assign(
        new Error('Station already ran 10 reviews in this Project today.'),
        { name: 'Refusal' },
      ),
    );
    mount();
    const region = await section();
    const reads = state.byPullRequestReads;
    fireEvent.click(
      within(region).getByRole('button', { name: 'Review again' }),
    );
    expect(
      await within(region).findByText(
        'Station already ran 10 reviews in this Project today.',
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(state.byPullRequestReads).toBeGreaterThan(reads),
    );
  });

  test('a closed pull request keeps its review but offers no Review again', async () => {
    withReview({
      headSha: HEAD,
      state: 'reviewed',
      at: minutesAgo(2),
      findings: [finding(0, true)],
      required: 1,
      others: 0,
    });
    state.byPullRequest = {
      ...(state.byPullRequest as PullRequestFeedbackByPullRequest),
      status: { state: 'closed' },
    };
    mount();
    const region = await section();
    expect(within(region).getByText('Reviewed aaaaaaa')).toBeTruthy();
    expect(within(region).queryByRole('button')).toBeNull();
  });

  test('nothing for a reader who may not read the owning chat, or with the preview off', async () => {
    withReview({ headSha: HEAD, state: 'reviewing', at: minutesAgo(1) });
    state.previews = [{ id: 'pull-request-agent-feedback', enabled: true }];
    mount();
    await screen.findByText('Agent feedback', {
      selector: '.pr-feedback-strip__label',
    });
    expect(screen.queryByRole('region', { name: 'Station review' })).toBeNull();
    cleanup();
    state.previews = [
      { id: 'pull-request-agent-feedback', enabled: true },
      { id: 'pull-request-head-review', enabled: true },
    ];
    state.byPullRequest = { identity: IDENTITY, owner: { readable: false } };
    mount();
    await screen.findByText('goes to another chat');
    expect(screen.queryByRole('region', { name: 'Station review' })).toBeNull();
  });

  test('the dialog offers "Review each new head" only with its preview, and keeps it on writes', async () => {
    withReview();
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Agent feedback settings' }),
    );
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        within(dialog)
          .getByRole('switch', { name: 'Review each new head' })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
    fireEvent.click(
      within(dialog).getByRole('switch', {
        name: 'Address review comments automatically',
      }),
    );
    await waitFor(() =>
      expect(actions.write).toHaveBeenCalledWith(
        'http://station.test',
        'chat-owner',
        {
          identity: IDENTITY,
          settings: {
            fixFailingChecks: true,
            addressReviewComments: true,
            reviewEachHead: true,
          },
          move: false,
        },
        expect.anything(),
      ),
    );
    cleanup();
    state.previews = [{ id: 'pull-request-agent-feedback', enabled: true }];
    withReview();
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Agent feedback settings' }),
    );
    const without = await screen.findByRole('dialog');
    expect(
      within(without).queryByRole('switch', { name: 'Review each new head' }),
    ).toBeNull();
  });
});
