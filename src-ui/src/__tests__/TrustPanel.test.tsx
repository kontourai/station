/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const bundlesState: {
  data: unknown;
  isLoading: boolean;
  isPlaceholderData: boolean;
  error: Error | null;
} = {
  data: undefined,
  isLoading: false,
  isPlaceholderData: false,
  error: null,
};

const reportState: {
  data: unknown;
  isLoading: boolean;
  isPlaceholderData: boolean;
  error: Error | null;
} = {
  data: undefined,
  isLoading: false,
  isPlaceholderData: false,
  error: null,
};

const reportQueryArgs: Array<[unknown, unknown]> = [];

vi.mock('@kontourai/station-sdk', () => ({
  useTrustBundlesQuery: () => bundlesState,
  useTrustReportQuery: (projectSlug: unknown, bundleId: unknown) => {
    reportQueryArgs.push([projectSlug, bundleId]);
    return reportState;
  },
}));

import { TrustPanel } from '../components/trust/TrustPanel';

const VALID_SUMMARY = {
  id: 'survey-session',
  fileName: 'survey-session.json',
  path: '/ws/.station/trust-bundles/survey-session.json',
  source: 'workspace',
  modifiedAt: '2026-06-12T01:00:00.000Z',
  valid: true,
  bundleSource: 'survey-review-workbench',
  claimCount: 2,
  claimsByStatus: { verified: 1, proposed: 1 },
  transparencyGapCount: 1,
};

const OLDER_SUMMARY = {
  id: 'older-bundle',
  fileName: 'older-bundle.json',
  path: '/home/projects/dev/plugin-data/a-plugin/trust-bundles/older-bundle.json',
  source: 'station-home',
  plugin: 'a-plugin',
  modifiedAt: '2026-06-11T01:00:00.000Z',
  valid: true,
  claimCount: 1,
  claimsByStatus: { proposed: 1 },
  transparencyGapCount: 0,
};

const REPORT_RESULT = {
  id: 'survey-session',
  path: '/ws/.station/trust-bundles/survey-session.json',
  source: 'workspace',
  modifiedAt: '2026-06-12T01:00:00.000Z',
  valid: true,
  report: {
    id: 'report-1',
    generatedAt: '2026-06-12T01:00:00.000Z',
    claims: [
      {
        id: 'claim-1',
        status: 'verified',
        claimType: 'survey.review-outcome',
        fieldOrBehavior: 'candidate-12',
        subjectId: 'directory:entry-12',
      },
      {
        id: 'claim-2',
        status: 'proposed',
        claimType: 'survey.review-outcome',
        fieldOrBehavior: 'candidate-13',
        subjectId: 'directory:entry-13',
      },
    ],
    evidence: [
      {
        id: 'ev-1',
        claimId: 'claim-1',
        excerptOrSummary: 'Reviewer accepted the proposed value',
        sourceRef: 'review-session:demo',
        method: 'attestation',
        passing: true,
      },
    ],
    transparencyGaps: [
      {
        id: 'gap-1',
        claimId: 'claim-2',
        type: 'corroboration_absent',
        severity: 'medium',
        message: 'No corroborating evidence for the proposed value.',
      },
    ],
    summary: { totalClaims: 2, byStatus: { verified: 1, proposed: 1 } },
  },
};

beforeEach(() => {
  bundlesState.data = undefined;
  bundlesState.isLoading = false;
  bundlesState.isPlaceholderData = false;
  bundlesState.error = null;
  reportState.data = undefined;
  reportState.isLoading = false;
  reportState.isPlaceholderData = false;
  reportState.error = null;
  reportQueryArgs.length = 0;
});

function expandPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Show' }));
}

describe('TrustPanel', () => {
  test('renders collapsed by default with the bundle count', () => {
    bundlesState.data = [VALID_SUMMARY];
    render(<TrustPanel projectSlug="dev" />);
    expect(screen.getByText('Trust bundles (1)')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Show' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    // Report body only renders after expansion.
    expect(screen.queryByText('survey.review-outcome')).toBeNull();
  });

  test('renders the trust report with status summary, claims, evidence drill-down, and gaps', () => {
    bundlesState.data = [VALID_SUMMARY];
    reportState.data = REPORT_RESULT;
    render(<TrustPanel projectSlug="dev" />);
    expandPanel();

    // Claim summary by status.
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(screen.getByText('Proposed')).toBeTruthy();

    // Claims list.
    expect(screen.getAllByText('survey.review-outcome')).toHaveLength(2);
    expect(screen.getByText(/candidate-12/)).toBeTruthy();

    // Evidence drill-down.
    const evidenceButtons = screen.getAllByRole('button', {
      name: 'Evidence',
    });
    expect(evidenceButtons).toHaveLength(2);
    fireEvent.click(evidenceButtons[0]);
    expect(
      screen.getByText('Reviewer accepted the proposed value'),
    ).toBeTruthy();

    // Transparency gaps called out.
    expect(screen.getByText('Transparency gaps (1)')).toBeTruthy();
    expect(
      screen.getByText('No corroborating evidence for the proposed value.'),
    ).toBeTruthy();
  });

  test('shows the empty state when the project has no bundles', () => {
    bundlesState.data = [];
    render(<TrustPanel projectSlug="dev" />);
    expandPanel();
    expect(screen.getByText('No trust bundles yet')).toBeTruthy();
  });

  test('shows the invalid-bundle state with the validation error', () => {
    bundlesState.data = [{ ...VALID_SUMMARY, valid: false }];
    reportState.data = {
      ...REPORT_RESULT,
      valid: false,
      error: 'Trust bundle is missing required schemaVersion',
      report: null,
    };
    render(<TrustPanel projectSlug="dev" />);
    expandPanel();
    expect(screen.getByRole('alert').textContent).toContain(
      'missing required schemaVersion',
    );
  });

  test('offers a selector when multiple bundles exist, most recent first', () => {
    bundlesState.data = [OLDER_SUMMARY, VALID_SUMMARY];
    reportState.data = REPORT_RESULT;
    render(<TrustPanel projectSlug="dev" />);
    expandPanel();

    const selector = screen.getByRole('combobox', {
      name: 'Trust bundle',
    }) as HTMLSelectElement;
    expect(selector.options[0].value).toBe('survey-session');
    expect(selector.options[1].textContent).toContain('a-plugin');
    expect(selector.value).toBe('survey-session');

    fireEvent.change(selector, { target: { value: 'older-bundle' } });
    expect(
      reportQueryArgs.some(([, bundleId]) => bundleId === 'older-bundle'),
    ).toBe(true);
  });

  test('shows the error state when the bundle list fails', () => {
    bundlesState.error = new Error('scan failed');
    render(<TrustPanel projectSlug="dev" />);
    expandPanel();
    expect(screen.getByRole('alert').textContent).toContain('scan failed');
  });

  // archive#3092 — a project (or bundle) switch must not blank a populated
  // panel, and the held content must be unmistakably marked as belonging to
  // the OUTGOING subject while the new one loads.
  describe('key change: holding previous data honestly', () => {
    test('does not blank to a loading state when the project key changes', () => {
      bundlesState.data = [VALID_SUMMARY];
      reportState.data = REPORT_RESULT;
      const { rerender } = render(<TrustPanel projectSlug="proj-a" />);
      expandPanel();
      expect(screen.getByText(/candidate-12/)).toBeTruthy();

      // Simulate the SDK holding proj-a's bundles/report as placeholderData
      // while proj-b's are in flight.
      bundlesState.isPlaceholderData = true;
      reportState.isPlaceholderData = true;
      rerender(<TrustPanel projectSlug="proj-b" />);

      expect(screen.getByText(/candidate-12/)).toBeTruthy();
      expect(screen.queryByText('Scanning trust bundles…')).toBeNull();
      expect(screen.queryByText('Building trust report…')).toBeNull();
    });

    test('marks the held render as refreshing (status text + aria-busy) and it cannot be mistaken for the new subject', () => {
      bundlesState.data = [VALID_SUMMARY];
      reportState.data = REPORT_RESULT;
      const { rerender, container } = render(
        <TrustPanel projectSlug="proj-a" />,
      );
      expandPanel();
      expect(screen.queryByRole('status')).toBeNull();
      expect(
        container.querySelector('.trust-panel')?.getAttribute('aria-busy'),
      ).toBeNull();

      // React keeps this component instance (and its local `expanded`
      // state) across the rerender — this simulates the project prop
      // changing under an already-expanded panel.
      bundlesState.isPlaceholderData = true;
      reportState.isPlaceholderData = true;
      rerender(<TrustPanel projectSlug="proj-b" />);

      const status = screen.getByRole('status');
      expect(status.textContent).toMatch(/updating/i);
      expect(status.textContent).toMatch(/previous selection/i);
      expect(
        container.querySelector('.trust-panel')?.getAttribute('aria-busy'),
      ).toBe('true');
      expect(container.querySelector('.trust-panel--stale')).toBeTruthy();
    });

    test('a genuine first load (no previous data) still shows a normal loading state, not the stale marker', () => {
      bundlesState.data = undefined;
      bundlesState.isLoading = true;
      bundlesState.isPlaceholderData = false;
      render(<TrustPanel projectSlug="proj-a" />);
      expandPanel();
      expect(screen.getByLabelText('Scanning trust bundles')).toBeTruthy();
      // See the matching ReadinessPanel note: assert the absence of the stale
      // marker by its own copy, not by the absence of any status region.
      expect(screen.queryByText(/showing the previous/i)).toBeNull();
    });
  });
});
