/**
 * @vitest-environment jsdom
 *
 * #2065 (D4): the `review` layout kind is the project-scoped successor to the
 * retired global `/review-queue`. These tests prove the home of every action
 * the mapping on the issue assigns to this layout, and the one property the
 * global queue could not have: everything here belongs to the layout's owner.
 */

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

const approve = vi.fn();
const reject = vi.fn();
const bulkApprove = vi.fn();
const bulkReject = vi.fn();
const runReview = vi.fn();
let changes: ProposedChange[] = [];
let surveyReviews: SurveyFlowReviewItemVM[] = [];
let reviewReceipts: IndependentReviewReceipt[] = [];
let unavailableReviewProjects: ReviewEvidenceUnavailableProject[] = [];
let unavailableSurveyProjects: Array<{
  projectSlug: string;
  reason: SurveyFlowReviewUnavailableReason;
}> = [];
let proposedChangesErrored = false;

vi.mock('@kontourai/station-sdk', () => ({
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
  useProjectsQuery: () => ({
    data: [
      { slug: 'project-a', name: 'Project A' },
      { slug: 'project-b', name: 'Project B' },
    ],
    isLoading: false,
  }),
  useProposedChangesQuery: () => ({
    data: proposedChangesErrored ? [] : changes,
    isLoading: false,
    isError: proposedChangesErrored,
  }),
  useRejectProposedChangeMutation: () => ({ isPending: false, mutate: reject }),
  useReviewEvidenceQuery: () => ({
    data: {
      receipts: reviewReceipts,
      unavailableProjects: unavailableReviewProjects,
    },
    isLoading: false,
  }),
  useRunIndependentReviewMutation: () => ({
    isError: false,
    isPending: false,
    mutate: runReview,
  }),
  useSurveyFlowReviewsQuery: () => ({
    data: {
      items: surveyReviews,
      unavailableProjects: unavailableSurveyProjects,
    },
    isLoading: false,
  }),
}));

import { NavigationProvider } from '../../../contexts/NavigationContext';
import { ReviewLayout } from '../ReviewLayout';

function renderLayout(projectSlug = 'project-a') {
  return render(
    <NavigationProvider>
      <ReviewLayout projectSlug={projectSlug} layoutSlug="review" config={{}} />
    </NavigationProvider>,
  );
}

function makeChange(overrides: Partial<ProposedChange> = {}): ProposedChange {
  const now = '2026-01-01T00:00:00.000Z';
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

function makeSurveyReview(
  overrides: Partial<SurveyFlowReviewItemVM> = {},
): SurveyFlowReviewItemVM {
  return {
    reviewSessionRef: 'review-session-1',
    projectSlug: 'project-a',
    projectionSource: 'flow:gate',
    workflowSubjectRef: 'run-1#gate-review',
    sessionName: 'Gate review for run-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    pendingDecisions: 2,
    summary: {
      accepted: 0,
      keptCurrent: 0,
      rejected: 0,
      escalated: 2,
      unresolved: 0,
    },
    items: [
      {
        target: 'claim-1',
        targetLabel: 'Claim 1',
        statusLabel: 'Escalated',
        traceRefs: [],
        candidates: [
          {
            roleLabel: 'Proposed',
            valueLabel: 'value',
            valueText: 'two',
            sourceLabel: 'source',
            sourceText: 'extraction',
            traceRefs: [],
          },
        ],
      },
    ],
    ...overrides,
  } as SurveyFlowReviewItemVM;
}

function makeReceipt(
  overrides: Partial<IndependentReviewReceipt> = {},
): IndependentReviewReceipt {
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
        lens: { id: 'failure-totality', instructions: 'Review exact outcomes.' },
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
    ...overrides,
  } as IndependentReviewReceipt;
}

describe('the review layout kind', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/projects/project-a/layouts/review');
    approve.mockReset();
    reject.mockReset();
    bulkApprove.mockReset();
    bulkReject.mockReset();
    runReview.mockReset();
    changes = [makeChange()];
    surveyReviews = [makeSurveyReview()];
    reviewReceipts = [makeReceipt()];
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

  /**
   * The property the global queue could not have. Every source Station exposes
   * is a cross-project aggregate, so a layout that did not narrow them would
   * render another Project's pending work under this Project's name — and a
   * bulk decision here would then apply to it.
   */
  test('shows only the owning Project’s work, from three cross-project sources', () => {
    changes = [
      makeChange(),
      makeChange({
        id: 'change-other',
        projectId: 'project-b',
        path: 'other/file.ts',
      }),
    ];
    surveyReviews = [
      makeSurveyReview(),
      makeSurveyReview({
        reviewSessionRef: 'review-session-other',
        projectSlug: 'project-b',
        sessionName: 'Gate review for another project',
      }),
    ];
    reviewReceipts = [
      makeReceipt(),
      makeReceipt({
        receiptId: 'b'.repeat(64),
        target: { ...makeReceipt().target, projectSlug: 'project-b' },
      }),
    ];

    renderLayout('project-a');

    expect(screen.getByText('src/index.ts')).toBeTruthy();
    expect(screen.getByText('Gate review for run-1')).toBeTruthy();
    expect(screen.queryByText('other/file.ts')).toBeNull();
    expect(
      screen.queryByText('Gate review for another project'),
    ).toBeNull();
    // One receipt row, not two: both receipts render the same headline, so a
    // name assertion could not tell one Project's from the other's.
    expect(screen.getAllByText('1 independent finding')).toHaveLength(1);
  });

  /**
   * The paused Survey gate's workbench content — the item, its status and its
   * candidate set. The attention inbox carries the count and the link only, so
   * this is the only place a gate decision can be informed.
   */
  test('opens the exact paused gate session a ?review= deep link names', () => {
    window.history.replaceState(
      {},
      '',
      '/projects/project-a/layouts/review?review=review-session-1',
    );

    renderLayout();

    const detail = screen.getByTestId('survey-flow-review-detail');
    expect(within(detail).getByText('Gate review for run-1')).toBeTruthy();
    expect(within(detail).getByText('run-1#gate-review')).toBeTruthy();
    expect(within(detail).getByText('2 awaiting a decision')).toBeTruthy();
    expect(within(detail).getByText('Claim 1')).toBeTruthy();
    expect(
      within(detail).getByText('Proposed: two · extraction'),
    ).toBeTruthy();
  });

  /** The before/after snapshots, and the two single-change decision controls. */
  test('opens a ?change= deep link on its snapshots and decides it', () => {
    window.history.replaceState(
      {},
      '',
      '/projects/project-a/layouts/review?change=change-1',
    );

    renderLayout();

    const detail = screen.getByTestId('review-queue-detail');
    expect(within(detail).getByText('const value = 1;')).toBeTruthy();
    expect(within(detail).getByText('const value = 2;')).toBeTruthy();

    fireEvent.click(within(detail).getByRole('button', { name: 'Approve' }));
    // The recorded reason names the surface that decided, the same way the
    // inbox's own test pins "from notifications" — two surfaces, one payload
    // builder, distinguishable in the audit record.
    expect(approve).toHaveBeenCalledWith({
      id: 'change-1',
      decision: { reason: 'Approved from review layout' },
    });
    expect(reject).not.toHaveBeenCalled();
  });

  test('opens a ?receipt= deep link on that receipt’s findings', () => {
    window.history.replaceState(
      {},
      '',
      `/projects/project-a/layouts/review?receipt=${'a'.repeat(64)}`,
    );

    renderLayout();

    expect(
      screen.getByText('Observer fault overturns committed truth.'),
    ).toBeTruthy();
  });

  /**
   * A stale link must not open a different item. The queue this replaces had
   * the same rule; keeping it is what makes "opens the exact one" above a
   * property rather than a coincidence of the fixture.
   */
  test('refuses to substitute a different item for a stale deep link', () => {
    window.history.replaceState(
      {},
      '',
      '/projects/project-a/layouts/review?change=change-decided',
    );

    renderLayout();

    expect(screen.getByRole('status').textContent).toContain(
      'no longer pending in project-a',
    );
    expect(screen.queryByTestId('review-queue-detail')).toBeNull();
  });

  /**
   * Bulk is the one action the inbox deliberately refuses (it decides one row
   * at a time). Its home is here, and it is narrowed from the global queue's
   * every-Project reach to this Project's pending ids.
   */
  test('bulk approval applies to the owning Project’s pending changes only', () => {
    changes = [
      makeChange(),
      makeChange({ id: 'change-2', path: 'src/two.ts' }),
      makeChange({ id: 'change-other', projectId: 'project-b' }),
    ];

    renderLayout('project-a');

    fireEvent.click(screen.getByRole('button', { name: 'Approve All' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Approve All',
      }),
    );

    expect(bulkApprove).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['change-1', 'change-2'] }),
    );
    expect(bulkReject).not.toHaveBeenCalled();
  });

  /** The run action, with no project picker to contradict the layout's owner. */
  test('runs an independent review locked to the owning Project', () => {
    renderLayout('project-b');

    fireEvent.click(
      screen.getByRole('button', { name: 'Run independent review' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Project')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Implementing Agent'), {
      target: { value: 'station' },
    });
    fireEvent.change(within(dialog).getByLabelText('Reviewer Agent slugs'), {
      target: { value: 'sol, security' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run review' }));

    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ projectSlug: 'project-b' }),
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  /**
   * A failed fetch defaults its list to `[]`. Without the error gate this
   * surface would announce "Nothing to review" for a Project that has pending
   * decisions Station simply could not read.
   */
  test('a failed source is named instead of reading as an empty queue', () => {
    proposedChangesErrored = true;
    surveyReviews = [];
    reviewReceipts = [];

    renderLayout();

    expect(screen.queryByText('Nothing to review')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'Failed to load: proposed changes',
    );
  });

  /**
   * A partial result is not a failed source — the source DID load. It gets its
   * own copy naming this Project's reason, because the remedy differs.
   */
  test('an unreadable Project is named with its reason while its siblings render', () => {
    unavailableSurveyProjects = [
      { projectSlug: 'project-a', reason: 'workspace-unreadable' },
      // project-b's failure belongs to project-b's layout, not this one.
      { projectSlug: 'project-b', reason: 'projection-failed' },
    ];

    renderLayout('project-a');

    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).toContain('workspace path unreadable');
    expect(alert).not.toContain('review list could not be built');
    expect(screen.getByText('src/index.ts')).toBeTruthy();
  });
});
