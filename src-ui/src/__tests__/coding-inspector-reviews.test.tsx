/**
 * @vitest-environment jsdom
 */

import type { IndependentReviewReceipt } from '@kontourai/station-contracts/review-evidence';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * #2064 (D4): independent-review receipts and the "Run independent review"
 * action live in the project's Coding layout, next to the Git range they
 * judge — not on the global Review page that mixed them with three unrelated
 * sources.
 *
 * The section is project-scoped, and that scoping is the property under test:
 * `GET /api/review-evidence` is a cross-project aggregate, so a section that
 * forgot to filter would show another project's receipts under this project's
 * layout. It also asserts the per-project unavailability path, because a
 * project Station could not read must not render as a project with no
 * receipts.
 */
const state = {
  reviewEvidence: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
  },
};

vi.mock('@kontourai/station-sdk', () => ({
  useReviewEvidenceQuery: () => state.reviewEvidence,
}));

import { IndependentReviewInspectorContent } from '../components/coding-layout/IndependentReviewInspectorContent';

function receipt(
  projectSlug: string,
  receiptId: string,
): IndependentReviewReceipt {
  return {
    receiptId,
    requestId: `request-${receiptId}`,
    mode: 'initial',
    target: {
      kind: 'git-range',
      projectSlug,
      baseRevision: 'origin/main',
      headRevision: 'HEAD',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    },
    implementerActor: { actorId: 'station', actorType: 'agent' },
    executions: [],
    findings: [],
    completedAt: '2026-09-13T12:00:00.000Z',
  } as unknown as IndependentReviewReceipt;
}

describe('independent reviews in the Coding layout', () => {
  beforeEach(() => {
    state.reviewEvidence = {
      data: { receipts: [], unavailableProjects: [] },
      isLoading: false,
      isError: false,
    };
  });

  test('offers the run action even with no receipts, so the tab is never a dead end', () => {
    render(<IndependentReviewInspectorContent projectSlug="campfit" />);
    expect(
      screen.getByRole('button', { name: 'Run independent review' }),
    ).toBeTruthy();
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
  });

  test("lists only this project's receipts, never the aggregate's", () => {
    state.reviewEvidence = {
      data: {
        receipts: [
          receipt('campfit', 'receipt-mine'),
          receipt('ferry', 'receipt-theirs'),
        ],
        unavailableProjects: [],
      },
      isLoading: false,
      isError: false,
    };
    render(<IndependentReviewInspectorContent projectSlug="campfit" />);
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(within(list).getByRole('button').textContent).toContain(
      '0 independent findings',
    );
  });

  test('a project Station could not read says so, rather than reading as no receipts', () => {
    state.reviewEvidence = {
      data: {
        receipts: [],
        unavailableProjects: [
          { projectSlug: 'campfit', reason: 'lock-unavailable' },
        ],
      },
      isLoading: false,
      isError: false,
    };
    render(<IndependentReviewInspectorContent projectSlug="campfit" />);
    expect(screen.getByRole('alert').textContent).toContain(
      'contended — another Station process or a long repair',
    );
    expect(screen.queryByText('Nothing here yet')).toBeNull();
  });

  test("another project's unavailability is not reported here", () => {
    state.reviewEvidence = {
      data: {
        receipts: [],
        unavailableProjects: [
          { projectSlug: 'ferry', reason: 'receipts-unreadable' },
        ],
      },
      isLoading: false,
      isError: false,
    };
    render(<IndependentReviewInspectorContent projectSlug="campfit" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
  });
});
