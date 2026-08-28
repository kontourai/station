/**
 * @vitest-environment jsdom
 */

import type { DiffComment } from '@kontourai/station-contracts/diff-comment';
import type { ProposedChange } from '@kontourai/station-contracts/proposed-change';
import type {
  IndependentReviewReceipt,
  ReviewEvidenceUnavailableProject,
} from '@kontourai/station-contracts/review-evidence';
import type {
  SurveyFlowReviewItemVM,
  SurveyFlowReviewUnavailableReason,
} from '@kontourai/station-sdk';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';

const approve = vi.fn();
const reject = vi.fn();
const bulkApprove = vi.fn();
const bulkReject = vi.fn();
const resolve = vi.fn();
const runReview = vi.fn();
let changes: ProposedChange[] = [];
let comments: DiffComment[] = [];
let layouts: Array<{ type: string; slug: string }> = [];
let surveyReviews: SurveyFlowReviewItemVM[] = [];
let reviewReceipts: IndependentReviewReceipt[] = [];
let unavailableReviewProjects: ReviewEvidenceUnavailableProject[] = [];
let unavailableSurveyProjects: Array<{
  projectSlug: string;
  reason: SurveyFlowReviewUnavailableReason;
}> = [];

let proposedChangesErrored = false;

vi.mock('@kontourai/station-sdk', () => ({
  Button: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  LoadingState: ({ message }: { message: string }) => <div>{message}</div>,
  useAllDiffCommentsQuery: () => ({
    data: comments,
    isLoading: false,
  }),
  useAgentsQuery: () => ({
    data: [{ slug: 'station' }, { slug: 'sol' }, { slug: 'security' }],
    isLoading: false,
  }),
  useApproveProposedChangeMutation: () => ({
    isPending: false,
    mutate: approve,
  }),
  useBulkApproveProposedChangesMutation: () => ({
    isPending: false,
    mutate: bulkApprove,
  }),
  useBulkRejectProposedChangesMutation: () => ({
    isPending: false,
    mutate: bulkReject,
  }),
  useProjectLayoutsQuery: () => ({
    data: layouts,
    isLoading: false,
  }),
  useProjectsQuery: () => ({
    data: [{ slug: 'project-a', name: 'Project A' }],
    isLoading: false,
  }),
  useSurveyFlowReviewsQuery: () => ({
    data: {
      items: surveyReviews,
      unavailableProjects: unavailableSurveyProjects,
    },
    isLoading: false,
  }),
  useReviewEvidenceQuery: () => ({
    data: {
      receipts: reviewReceipts,
      unavailableProjects: unavailableReviewProjects,
    },
    isLoading: false,
  }),
  useProposedChangesQuery: () => ({
    data: proposedChangesErrored ? [] : changes,
    isLoading: false,
    isError: proposedChangesErrored,
  }),
  useRejectProposedChangeMutation: () => ({
    isPending: false,
    mutate: reject,
  }),
  useResolveDiffCommentMutation: () => ({
    isPending: false,
    mutate: resolve,
  }),
  useRunIndependentReviewMutation: () => ({
    isError: false,
    isPending: false,
    mutate: runReview,
  }),
}));

import { ReviewQueueView } from '../views/ReviewQueueView';

function makeChange(overrides: Partial<ProposedChange> = {}): ProposedChange {
  const now = new Date().toISOString();
  return {
    id: 'change-1',
    sessionId: 'session-1',
    projectId: 'project-a',
    path: 'src/index.ts',
    changeType: 'modify',
    contentKind: 'code',
    baseSnapshot: { content: 'const value = 1;' },
    proposedSnapshot: { content: 'const value = 2;' },
    createdAt: now,
    updatedAt: now,
    sourceRuntime: 'codex',
    status: 'pending',
    decisions: [],
    ...overrides,
  };
}

function makeReviewReceipt(): IndependentReviewReceipt {
  const finding = {
    findingId: 'f'.repeat(64),
    reviewerId: 'sol-1',
    lensId: 'failure-totality',
    location: { file: 'src/module.ts', line: 42 },
    scenario: {
      stateOrInput: 'the write commits and an observer throws',
      wrongOutcome: 'the caller is invited to retry the committed effect',
    },
    severity: 'high' as const,
    confidence: 'high' as const,
    basis: 'reasoned-from-code' as const,
    summary: 'Observer fault overturns committed truth.',
  };
  return {
    schemaVersion: 1,
    receiptId: 'a'.repeat(64),
    requestId: 'request-1',
    mode: 'initial',
    target: {
      kind: 'git-range',
      projectSlug: 'project-a',
      baseRevision: 'origin/main',
      headRevision: 'HEAD',
      repositoryId: 'github.com/kontourai/station',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
      diffSha256: '3'.repeat(64),
    },
    requestedBy: { actorId: 'user:operator' },
    implementer: { actorId: 'agent:terra' },
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    executions: [
      {
        reviewerId: 'sol-1',
        executorAgentSlug: 'reviewer-agent',
        actor: { actorId: 'agent:sol' },
        lens: {
          id: 'failure-totality',
          instructions: 'Review exact outcomes.',
        },
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:01:00.000Z',
        findings: [finding],
        deltaAssessments: [],
      },
    ],
    findings: [finding],
    deltaAssessments: [],
    interpretation: {
      kind: 'review-findings',
      decision: 'input-only',
      gateVerdict: null,
    },
  };
}

describe('ReviewQueueView', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/review');
    approve.mockReset();
    reject.mockReset();
    bulkApprove.mockReset();
    bulkReject.mockReset();
    resolve.mockReset();
    runReview.mockReset();
    changes = [makeChange()];
    comments = [];
    layouts = [];
    surveyReviews = [];
    reviewReceipts = [];
    unavailableReviewProjects = [];
    unavailableSurveyProjects = [];
    proposedChangesErrored = false;
    vi.restoreAllMocks();
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    }));
  });

  // archive#4463: the nav item is 'Review',
  // so the page title is 'Review' too — 'Review Queue' disagreed with its own
  // nav noun. The subtitle keeps the fuller queue description.
  test('titles the page "Review", matching its nav item — not "Review Queue"', () => {
    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );

    expect(
      screen.getByRole('heading', { name: 'Review', level: 2 }),
    ).toBeTruthy();
    expect(screen.queryByText('Review Queue')).toBeNull();
    expect(
      screen.getByText(
        'Pending changes, review comments, and attributable review evidence',
      ),
    ).toBeTruthy();
  });

  test('deep-links by exact Project and receipt tuple despite duplicate ids and search', () => {
    changes = [];
    const first = makeReviewReceipt();
    const second = {
      ...makeReviewReceipt(),
      target: { ...makeReviewReceipt().target, projectSlug: 'project-b' },
    };
    reviewReceipts = [first, second];
    window.history.replaceState(
      {},
      '',
      `/review-queue?receipt=${second.receiptId}&project=project-b&q=does-not-match`,
    );
    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );
    fireEvent.change(
      screen.getByPlaceholderText('Search changes, comments, and evidence...'),
      { target: { value: 'does-not-match' } },
    );
    const detail = screen.getByTestId('independent-review-receipt-detail');
    expect(
      within(detail).getByRole('heading', { name: 'project-b' }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(detail);
    window.history.pushState(
      {},
      '',
      `/review-queue?receipt=${first.receiptId}&project=project-a`,
    );
    fireEvent(window, new PopStateEvent('popstate'));
    expect(
      within(screen.getByTestId('independent-review-receipt-detail')).getByRole(
        'heading',
        { name: 'project-a' },
      ),
    ).toBeTruthy();
  });

  test('does not substitute a different receipt for a missing exact tuple', () => {
    changes = [];
    reviewReceipts = [makeReviewReceipt()];
    window.history.replaceState(
      {},
      '',
      `/review-queue?receipt=${'a'.repeat(64)}&project=project-b`,
    );
    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );
    expect(
      screen.getByText(/That review receipt isn’t available/i),
    ).toBeTruthy();
    // The promise this message exists for: no substitution (archive#3965).
    expect(
      screen.getByText(/won’t open a different one in its place/i),
    ).toBeTruthy();
    expect(
      screen.queryByTestId('independent-review-receipt-detail'),
    ).toBeNull();
  });

  test('renders proposal details and single decision controls', () => {
    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /src\/index\.ts/i }));

    const detail = screen.getByTestId('review-queue-detail');
    expect(within(detail).getByText('const value = 1;')).toBeTruthy();
    expect(within(detail).getByText('const value = 2;')).toBeTruthy();

    fireEvent.click(within(detail).getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledWith({
      id: 'change-1',
      decision: { reason: 'Approved from review queue' },
    });
  });

  test('confirms bulk rejection for pending changes', () => {
    changes = [
      makeChange({ id: 'change-1' }),
      makeChange({ id: 'change-2', path: 'README.md' }),
    ];

    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject All' }));

    expect(bulkReject).toHaveBeenCalledWith({
      ids: ['change-1', 'change-2'],
      reason: 'Bulk rejected from review queue',
    });
  });

  test('launches multiple independent reviewers through the canonical mutation', () => {
    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Run independent review' }),
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Project'), {
      target: { value: 'project-a' },
    });
    fireEvent.change(within(dialog).getByLabelText('Implementing Agent'), {
      target: { value: 'station' },
    });
    fireEvent.change(within(dialog).getByLabelText('Reviewer Agent slugs'), {
      target: { value: 'sol, security' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run review' }));

    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'initial',
        requestId: expect.any(String),
        implementerAgentSlug: 'station',
        target: expect.objectContaining({ projectSlug: 'project-a' }),
        reviewers: [
          expect.objectContaining({ executorAgentSlug: 'sol' }),
          expect.objectContaining({ executorAgentSlug: 'security' }),
        ],
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  test('surfaces a diff comment and resolves it from the queue', () => {
    changes = [];
    const now = new Date().toISOString();
    comments = [
      {
        id: 'c-1',
        projectId: 'project-b',
        filePath: 'src/api.ts',
        side: 'additions',
        lineNumber: 42,
        body: 'Needs a null guard here',
        createdAt: now,
        updatedAt: now,
      },
    ];

    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /src\/api\.ts/i }));

    const detail = screen.getByTestId('review-comment-detail');
    expect(within(detail).getByText('Needs a null guard here')).toBeTruthy();

    fireEvent.click(within(detail).getByRole('button', { name: 'Resolve' }));
    expect(resolve).toHaveBeenCalledWith(
      { projectSlug: 'project-b', id: 'c-1' },
      expect.anything(),
    );
  });

  test('jumps to the project coding layout from a comment', () => {
    changes = [];
    const now = new Date().toISOString();
    comments = [
      {
        id: 'c-1',
        projectId: 'project-b',
        filePath: 'src/api.ts',
        side: 'additions',
        lineNumber: 42,
        body: 'Needs a null guard here',
        createdAt: now,
        updatedAt: now,
      },
    ];
    // The project exposes a coding layout the action can resolve and navigate to.
    layouts = [
      { type: 'chat', slug: 'overview' },
      { type: 'coding', slug: 'workspace' },
    ];
    const setLayoutSpy = vi
      .spyOn(navigationStore, 'setLayout')
      .mockImplementation(() => {});

    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /src\/api\.ts/i }));
    const detail = screen.getByTestId('review-comment-detail');
    fireEvent.click(
      within(detail).getByRole('button', { name: 'Open in coding' }),
    );

    expect(setLayoutSpy).toHaveBeenCalledWith('project-b', 'workspace', {
      openFilePreviewIntent: {
        projectSlug: 'project-b',
        path: 'src/api.ts',
        lineRange: { start: 42, end: 42 },
      },
    });
  });

  test('hides the open-in-coding action when the project has no coding layout', () => {
    changes = [];
    const now = new Date().toISOString();
    comments = [
      {
        id: 'c-1',
        projectId: 'project-b',
        filePath: 'src/api.ts',
        side: 'additions',
        lineNumber: 42,
        body: 'Needs a null guard here',
        createdAt: now,
        updatedAt: now,
      },
    ];
    layouts = [{ type: 'chat', slug: 'overview' }];

    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /src\/api\.ts/i }));
    const detail = screen.getByTestId('review-comment-detail');
    expect(
      within(detail).queryByRole('button', { name: 'Open in coding' }),
    ).toBeNull();
  });

  test('presents canonical Survey review work with its Flow subject binding', () => {
    changes = [];
    surveyReviews = [
      {
        reviewSessionRef: 'review:example:1',
        projectSlug: 'example',
        projectionSource: 'example.harvest',
        workflowSubjectRef: 'public-record:entity-123',
        sessionName: 'Domain-neutral review',
        updatedAt: '2026-07-22T12:00:00.000Z',
        summary: {
          accepted: 0,
          keptCurrent: 0,
          rejected: 0,
          escalated: 0,
          unresolved: 1,
        },
        items: [
          {
            target: 'availabilityStatus',
            targetLabel: 'Availability Status',
            statusLabel: 'Needs Review',
            candidates: [
              {
                roleLabel: 'Proposed value',
                valueText: 'WAITLIST',
                sourceText: 'https://example.test/source',
              },
            ],
          },
        ],
      },
    ];

    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Domain-neutral review/i }),
    );
    const detail = screen.getByTestId('survey-flow-review-detail');
    expect(within(detail).getByText('public-record:entity-123')).toBeTruthy();
    expect(within(detail).getByText('Availability Status')).toBeTruthy();
    expect(within(detail).getByText(/Proposed value: WAITLIST/)).toBeTruthy();
  });

  test('renders attributable independent-review findings without verdict controls', () => {
    changes = [];
    reviewReceipts = [makeReviewReceipt()];
    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /1 independent finding/i }),
    );
    const detail = screen.getByTestId('independent-review-receipt-detail');
    expect(within(detail).getByText(/input only/i)).toBeTruthy();
    expect(
      within(detail).getByText('Observer fault overturns committed truth.'),
    ).toBeTruthy();
    expect(within(detail).getByText(/src\/module.ts:42/)).toBeTruthy();
    expect(within(detail).getByText(/does not approve, reject/i)).toBeTruthy();
    expect(
      within(detail).queryByRole('button', { name: /approve/i }),
    ).toBeNull();
  });

  test('renders failed reviewer evidence as incomplete rather than a clean zero-finding review', () => {
    changes = [];
    const receipt = makeReviewReceipt();
    receipt.findings = [];
    receipt.executions[0] = {
      ...receipt.executions[0],
      status: 'timed-out',
      findings: [],
      failureReason:
        'The reviewer did not finish within the bounded review window.',
    };
    reviewReceipts = [receipt];
    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /0 independent findings/i }),
    );
    const detail = screen.getByTestId('independent-review-receipt-detail');
    expect(within(detail).getByText(/timed-out/)).toBeTruthy();
    expect(within(detail).getByText(/evidence is incomplete/i)).toBeTruthy();
    expect(within(detail).queryByText(/All reviewers completed/)).toBeNull();
  });
});

describe('the double-empty rule (station#4463 slice 2)', () => {
  // The 2026-08-26 shell audit: with an empty queue, Review rendered TWO
  // empty states at once — the list pane's "Nothing to review" beside the
  // detail pane's "Select an item" (select from what?). This pins Review as
  // the proving case for `SplitPaneLayout`'s single-empty-message rule,
  // exercised through the real view rather than hand-built props.
  test('an empty queue renders exactly one empty message, not a second "Select an item"', () => {
    changes = [];
    comments = [];
    surveyReviews = [];
    reviewReceipts = [];
    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );

    expect(screen.getByText('Nothing to review')).toBeTruthy();
    expect(screen.queryByText('Select an item')).toBeNull();
    expect(
      screen.queryByText(
        'Review a proposed change, or read and resolve a diff comment.',
      ),
    ).toBeNull();
  });

  test("a non-empty queue with nothing selected keeps the detail pane's own guidance", () => {
    changes = [makeChange()];
    render(
      <NavigationProvider>
        <ReviewQueueView />
      </NavigationProvider>,
    );

    expect(screen.queryByText('Nothing to review')).toBeNull();
    expect(screen.getByText('Select an item')).toBeTruthy();
  });
});

describe('failed sources never read as an empty queue', () => {
  test('a failing proposed-changes fetch names itself instead of "Nothing to review"', () => {
    // `data = []` on error rendered the queue as empty — absence-as-success
    // on the surface whose job is surfacing pending approvals. The empty
    // state must say WHICH source failed, scoped, without breaking the
    // healthy sources (their items would still render).
    // Module-level fixtures leak between tests; pin this test's world.
    changes = [];
    comments = [];
    surveyReviews = [];
    reviewReceipts = [];
    proposedChangesErrored = true;
    try {
      render(
        <NavigationProvider>
          <ReviewQueueView />
        </NavigationProvider>,
      );
      expect(screen.getByRole('alert').textContent).toContain(
        'Failed to load: proposed changes',
      );
      expect(screen.getByText('Some reviews could not load')).toBeTruthy();
    } finally {
      proposedChangesErrored = false;
    }
  });

  test('a partial failure stays visible while healthy sources still render items', () => {
    // The discriminating case: the alert must not live only in the empty
    // state — with a healthy comment present, the list renders items AND the
    // failed source stays named.
    const now = new Date().toISOString();
    changes = [];
    surveyReviews = [];
    reviewReceipts = [];
    comments = [
      {
        id: 'c-1',
        projectId: 'project-b',
        filePath: 'src/api.ts',
        side: 'additions',
        lineNumber: 42,
        body: 'Needs a null guard here',
        createdAt: now,
        updatedAt: now,
      },
    ];
    proposedChangesErrored = true;
    try {
      render(
        <NavigationProvider>
          <ReviewQueueView />
        </NavigationProvider>,
      );
      expect(screen.getByText('src/api.ts')).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toContain(
        'Failed to load: proposed changes',
      );
      expect(screen.queryByText('Some reviews could not load')).toBeNull();
    } finally {
      proposedChangesErrored = false;
    }
  });

  test('unavailable review-evidence projects are named with their reason while readable receipts still render', () => {
    // Per-project isolation (archive#3303): one unreadable project must not blank
    // the whole independent-review section, and must not be invisible either.
    // The partial case is NOT phrased as a failed load — the source loaded —
    // and each project carries its reason (the operator remedy differs).
    changes = [];
    comments = [];
    surveyReviews = [];
    reviewReceipts = [makeReviewReceipt()];
    unavailableReviewProjects = [
      { projectSlug: 'broken-project', reason: 'workspace-unreadable' },
      { projectSlug: 'contended-project', reason: 'lock-unavailable' },
    ];
    try {
      render(
        <NavigationProvider>
          <ReviewQueueView />
        </NavigationProvider>,
      );
      expect(
        screen.getByRole('button', { name: /1 independent finding/i }),
      ).toBeTruthy();
      const alert = screen.getByRole('alert').textContent ?? '';
      expect(alert).toContain(
        'Independent review evidence is partial — 2 projects unavailable',
      );
      expect(alert).toContain('broken-project (workspace path unreadable)');
      // A lock timeout is not proof of a second process — a long index repair
      // reads the same way — so the copy must not send the operator hunting.
      expect(alert).toContain(
        'contended-project (contended — another Station process or a long repair)',
      );
      expect(alert).not.toContain('Failed to load');
    } finally {
      unavailableReviewProjects = [];
      reviewReceipts = [];
    }
  });

  test('unavailable flow-review projects are named without failing the flow-reviews source (#3322)', () => {
    changes = [];
    comments = [];
    surveyReviews = [];
    reviewReceipts = [];
    unavailableSurveyProjects = [
      { projectSlug: 'broken-survey', reason: 'sessions-unreadable' },
    ];
    try {
      render(
        <NavigationProvider>
          <ReviewQueueView />
        </NavigationProvider>,
      );
      const alert = screen.getByRole('alert').textContent ?? '';
      expect(alert).toContain(
        'Flow reviews are partial — 1 project unavailable',
      );
      expect(alert).toContain('broken-survey (review sessions unreadable)');
      expect(alert).not.toContain('Failed to load');
    } finally {
      unavailableSurveyProjects = [];
    }
  });

  test('each flow-review unavailability reason gets its own remedy copy (#3322)', () => {
    changes = [];
    comments = [];
    surveyReviews = [];
    reviewReceipts = [];
    unavailableSurveyProjects = [
      { projectSlug: 'no-path', reason: 'workspace-unreadable' },
      { projectSlug: 'bad-file', reason: 'sessions-unreadable' },
      { projectSlug: 'defective', reason: 'projection-failed' },
    ];
    try {
      render(
        <NavigationProvider>
          <ReviewQueueView />
        </NavigationProvider>,
      );
      const alert = screen.getByRole('alert').textContent ?? '';
      expect(alert).toContain(
        'Flow reviews are partial — 3 projects unavailable',
      );
      expect(alert).toContain('no-path (workspace path unreadable)');
      expect(alert).toContain('bad-file (review sessions unreadable)');
      expect(alert).toContain('defective (review list could not be built)');
    } finally {
      unavailableSurveyProjects = [];
    }
  });
});
