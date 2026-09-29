// A completed independent-review receipt in the shape the review routes
// return; shared by the CLI surface tests that answer those routes.
export const reviewReceipt = {
  schemaVersion: 1,
  receiptId: 'a'.repeat(64),
  requestId: 'request-1',
  mode: 'initial',
  target: {
    kind: 'git-range',
    projectSlug: 'demo',
    baseRevision: 'origin/main',
    headRevision: 'HEAD',
    repositoryId: 'github.com/kontourai/station',
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    diffSha256: '3'.repeat(64),
  },
  requestedBy: { actorId: 'operator' },
  implementer: { actorId: 'agent:terra' },
  startedAt: '2026-08-16T00:00:00.000Z',
  completedAt: '2026-08-16T00:01:00.000Z',
  executions: [
    {
      reviewerId: 'reviewer-1',
      executorAgentSlug: 'station',
      actor: { actorId: 'agent:sol' },
      lens: { id: 'architecture', instructions: 'Review exact seams.' },
      status: 'completed',
      startedAt: '2026-08-16T00:00:00.000Z',
      completedAt: '2026-08-16T00:01:00.000Z',
      findings: [],
      deltaAssessments: [],
    },
  ],
  findings: [],
  deltaAssessments: [],
  interpretation: {
    kind: 'review-findings',
    decision: 'input-only',
    gateVerdict: null,
  },
} as const;

/** The request-status reply for a review that completed with that receipt. */
export const completedReviewRequest = {
  requestId: 'request-1',
  projectSlug: 'demo',
  state: 'completed',
  startedAt: reviewReceipt.startedAt,
  updatedAt: reviewReceipt.completedAt,
  result: {
    receipt: reviewReceipt,
    attachment: { status: 'not-requested' },
    cleanup: { status: 'completed' },
  },
} as const;
