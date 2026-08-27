import { describe, expect, it } from 'vitest';
import {
  parseIndependentReviewRequest,
  parseIndependentReviewRequestStatus,
  parseReviewEvidenceAggregate,
  parseReviewerOutput,
} from '../review-evidence.js';

const request = {
  requestId: 'request-1',
  mode: 'initial',
  target: {
    kind: 'git-range',
    projectSlug: 'station',
    baseRevision: 'origin/main',
    headRevision: 'HEAD',
  },
  implementerAgentSlug: 'terra',
  reviewers: [
    {
      reviewerId: 'reviewer-1',
      executorAgentSlug: 'reviewer-agent',
      lens: {
        id: 'failure-totality',
        instructions:
          'Look for effects whose authoritative result can be overturned.',
      },
    },
  ],
} as const;

describe('independent review evidence contract', () => {
  it('accepts an independent initial review request', () => {
    expect(parseIndependentReviewRequest(request)).toEqual(request);
  });

  it('accepts repo-map selection without caller-selected reviewers', () => {
    const selected = {
      ...request,
      reviewers: [],
      selection: { kind: 'repo-map' },
    };
    expect(parseIndependentReviewRequest(selected)).toEqual({
      requestId: request.requestId,
      mode: request.mode,
      target: request.target,
      implementerAgentSlug: request.implementerAgentSlug,
      reviewers: [],
      selection: { kind: 'repo-map' },
    });
    expect(() =>
      parseIndependentReviewRequest({
        ...request,
        selection: { kind: 'repo-map' },
      }),
    ).toThrow('cannot mix reviewers');
    expect(
      parseIndependentReviewRequestStatus({
        requestId: 'request-1',
        projectSlug: 'station',
        state: 'not-verified',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        failureReason: 'Human review required.',
        unavailableLenses: ['runtime'],
      }),
    ).toMatchObject({ state: 'not-verified', unavailableLenses: ['runtime'] });
  });

  it('rejects self-review and duplicate reviewer occurrences', () => {
    expect(() =>
      parseIndependentReviewRequest({
        ...request,
        reviewers: [{ ...request.reviewers[0], executorAgentSlug: 'terra' }],
      }),
    ).toThrow('implementer cannot review');

    expect(() =>
      parseIndependentReviewRequest({
        ...request,
        reviewers: [request.reviewers[0], request.reviewers[0]],
      }),
    ).toThrow('reviewer ids must be unique');

    expect(() =>
      parseIndependentReviewRequest({
        ...request,
        reviewers: [
          request.reviewers[0],
          { ...request.reviewers[0], reviewerId: 'reviewer-2' },
        ],
      }),
    ).toThrow('reviewer actors must be independent and unique');
  });

  it('requires delta identity exactly in delta mode', () => {
    expect(() =>
      parseIndependentReviewRequest({ ...request, mode: 'delta' }),
    ).toThrow('delta input must be present exactly');

    expect(
      parseIndependentReviewRequest({
        ...request,
        mode: 'delta',
        delta: {
          priorReceiptId: 'a'.repeat(64),
          claimedFindingIds: ['finding-1'],
        },
      }).delta,
    ).toEqual({
      priorReceiptId: 'a'.repeat(64),
      claimedFindingIds: ['finding-1'],
    });

    expect(() =>
      parseIndependentReviewRequest({
        ...request,
        mode: 'delta',
        delta: {
          priorReceiptId: 'a'.repeat(64),
          claimedFindingIds: Array.from(
            { length: 101 },
            (_, index) => `finding-${index}`,
          ),
        },
      }),
    ).toThrow('one to 100');
  });

  it('parses fixed, triageable finding facts without treating them as verdicts', () => {
    expect(
      parseReviewerOutput({
        findings: [
          {
            location: { file: 'src/module.ts', line: 42 },
            scenario: {
              stateOrInput: 'the durable write commits and its observer throws',
              wrongOutcome: 'the caller receives a retryable failure',
            },
            severity: 'high',
            confidence: 'high',
            basis: 'reproduced',
            summary: 'Observer failure overturns committed truth.',
          },
        ],
        deltaAssessments: [],
      }).findings[0],
    ).toMatchObject({
      location: { file: 'src/module.ts', line: 42 },
      severity: 'high',
      confidence: 'high',
      basis: 'reproduced',
    });
  });

  it('rejects unsafe locations, prose-only findings, and unknown evidence bases', () => {
    const finding = {
      location: { file: '../outside.ts', line: 1 },
      scenario: { stateOrInput: 'state', wrongOutcome: 'wrong result' },
      severity: 'high',
      confidence: 'high',
      basis: 'reproduced',
      summary: 'bad',
    };
    expect(() =>
      parseReviewerOutput({ findings: [finding], deltaAssessments: [] }),
    ).toThrow('location.file is unsafe');
    expect(() =>
      parseReviewerOutput({
        findings: [
          { ...finding, location: { file: 'src/a.ts', line: 1 }, scenario: {} },
        ],
        deltaAssessments: [],
      }),
    ).toThrow('stateOrInput');
    expect(() =>
      parseReviewerOutput({
        findings: [
          {
            ...finding,
            location: { file: 'src/a.ts', line: 1 },
            basis: 'reviewer-opinion',
          },
        ],
        deltaAssessments: [],
      }),
    ).toThrow('basis is invalid');
  });

  it('fails the aggregate closed on unknown keys and unknown reasons', () => {
    expect(
      parseReviewEvidenceAggregate({
        receipts: [],
        unavailableProjects: [
          { projectSlug: 'station', reason: 'lock-unavailable' },
        ],
      }),
    ).toEqual({
      receipts: [],
      unavailableProjects: [
        { projectSlug: 'station', reason: 'lock-unavailable' },
      ],
    });
    // Unknown top-level keys never widen the aggregate silently.
    expect(() =>
      parseReviewEvidenceAggregate({
        receipts: [],
        unavailableProjects: [],
        totalCount: 0,
      }),
    ).toThrow('contains unknown field: totalCount');
    // A reason outside the vocabulary is a fabricated state, not data.
    expect(() =>
      parseReviewEvidenceAggregate({
        receipts: [],
        unavailableProjects: [
          { projectSlug: 'station', reason: 'quantum-flux' },
        ],
      }),
    ).toThrow('unavailableProjects[0].reason is invalid');
    // Unknown per-entry keys are rejected too.
    expect(() =>
      parseReviewEvidenceAggregate({
        receipts: [],
        unavailableProjects: [
          {
            projectSlug: 'station',
            reason: 'lock-unavailable',
            detail: 'extra',
          },
        ],
      }),
    ).toThrow('contains unknown field: detail');
  });
});
