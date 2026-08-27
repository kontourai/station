/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const queryState: {
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

const mutateMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useReadinessQuery: () => queryState,
  useRefreshReadinessMutation: () => ({
    mutate: mutateMock,
    isPending: false,
    error: null,
  }),
}));

import { ReadinessPanel } from '../components/readiness/ReadinessPanel';

const CONFIGURED_SNAPSHOT = {
  configured: true,
  generatedAt: '2026-06-12T00:00:00.000Z',
  overall: 'not-ready',
  cli: {
    runId: 'veritas-123',
    message: 'Evidence Check, report, and standards feedback draft completed.',
    reportArtifactPath: '.kontourai/veritas/evidence/veritas-123.json',
    sourceKind: 'working-tree',
    evidenceCheckLabels: ['npm test'],
    evidenceCheckFailure: null,
  },
  requirements: [
    {
      id: 'evidence-check:required-evidence-check',
      kind: 'evidence-check',
      label: 'npm test',
      status: 'satisfied',
      summary: 'Evidence checks passed',
      claimIds: ['fx.evidence-check.npm-test'],
    },
    {
      id: 'policy:policy-changes-require-attestation',
      kind: 'policy',
      label: 'policy-changes-require-attestation',
      status: 'advisory',
      summary: 'No active attestation found; readiness is advisory.',
      claimIds: [],
    },
    {
      id: 'policy:required-veritas-artifacts',
      kind: 'policy',
      label: 'required-veritas-artifacts',
      status: 'failing',
      summary: 'A required artifact is gone.',
      claimIds: [],
    },
    {
      id: 'governance:attestation',
      kind: 'governance',
      label: 'Governance attestation',
      status: 'missing',
      summary: 'Attestation state: missing',
      claimIds: [],
    },
    {
      id: 'exception:override-or-bypass',
      kind: 'exception',
      label: 'Override or bypass recorded',
      status: 'accepted',
      summary: 'A readiness override or bypass was recorded for this run.',
      claimIds: [],
    },
  ],
  counts: {
    satisfied: 1,
    missing: 1,
    stale: 0,
    failing: 1,
    advisory: 1,
    recheckable: 0,
    accepted: 1,
  },
  trustReport: {
    claims: [
      {
        id: 'fx.evidence-check.npm-test',
        status: 'verified',
        claimType: 'software-evidence-check',
        fieldOrBehavior: 'npm test',
        subjectId: 'fx:working-tree',
      },
    ],
    evidence: [
      {
        id: 'fx.evidence-check.npm-test.evidence',
        claimId: 'fx.evidence-check.npm-test',
        excerptOrSummary: 'npm test exited 0',
        sourceRef: 'command:npm test',
        method: 'validation',
        passing: true,
      },
    ],
    transparencyGaps: [
      {
        id: 'fx.gap.1',
        claimId: 'fx.evidence-check.npm-test',
        type: 'provenance_gap',
        severity: 'medium',
        message: 'Missing required evidence: policy_rule.',
      },
    ],
  },
};

beforeEach(() => {
  queryState.data = undefined;
  queryState.isLoading = false;
  queryState.isPlaceholderData = false;
  queryState.error = null;
  mutateMock.mockClear();
});

const OTHER_PROJECT_SNAPSHOT = {
  ...CONFIGURED_SNAPSHOT,
  overall: 'ready',
  cli: {
    ...CONFIGURED_SNAPSHOT.cli,
    message: 'other-project readiness message',
  },
};

describe('ReadinessPanel', () => {
  test('renders requirement statuses, chips, and the why-detail for a configured workspace', () => {
    queryState.data = CONFIGURED_SNAPSHOT;
    render(<ReadinessPanel projectSlug="dev" />);

    expect(screen.getByText('Merge readiness')).toBeTruthy();
    expect(screen.getByText('Not ready')).toBeTruthy();

    // Status chips with counts for every non-zero status.
    const chips = document.querySelectorAll('.readiness-panel__chip');
    expect(chips).toHaveLength(5);
    expect(screen.getAllByText('Satisfied').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Failing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Advisory').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Accepted').length).toBeGreaterThan(0);

    // Requirements list.
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('policy-changes-require-attestation')).toBeTruthy();
    expect(screen.getByText('Governance attestation')).toBeTruthy();

    // Expand "why is this allowed to merge?" on the evidence-check row.
    const whyButtons = screen.getAllByRole('button', {
      name: 'Why is this allowed to merge?',
    });
    expect(whyButtons).toHaveLength(5);
    fireEvent.click(whyButtons[0]);
    expect(screen.getByText('software-evidence-check')).toBeTruthy();
    expect(screen.getByText('npm test exited 0')).toBeTruthy();
    expect(screen.getByText('Transparency gaps')).toBeTruthy();
    expect(
      screen.getByText('Missing required evidence: policy_rule.'),
    ).toBeTruthy();
  });

  test('shows the not-configured empty state', () => {
    queryState.data = { configured: false, reason: 'no-veritas-dir' };
    render(<ReadinessPanel projectSlug="dev" />);
    expect(screen.getByText('Veritas not configured')).toBeTruthy();
    expect(screen.queryByText('Ready to merge')).toBeNull();
  });

  test('shows a distinct no-working-directory empty state (no error)', () => {
    queryState.data = { configured: false, reason: 'no-workspace' };
    render(<ReadinessPanel projectSlug="dev" />);
    expect(screen.getByText('No working directory')).toBeTruthy();
    // Must not surface as an error or the generic Veritas-init copy.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Veritas not configured')).toBeNull();
  });

  test('shows the error state when readiness fails', () => {
    queryState.error = new Error('veritas readiness exited with code 2');
    render(<ReadinessPanel projectSlug="dev" />);
    expect(screen.getByRole('alert').textContent).toContain(
      'veritas readiness exited with code 2',
    );
  });

  test('refresh button triggers the refresh mutation', () => {
    queryState.data = CONFIGURED_SNAPSHOT;
    render(<ReadinessPanel projectSlug="dev" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  // station#3092 — a project switch must not blank a populated panel, and
  // the held content must be unmistakably marked as belonging to the
  // OUTGOING project while the new one loads.
  describe('key change: holding previous data honestly', () => {
    test('does not blank to a loading state when the project key changes', () => {
      queryState.data = CONFIGURED_SNAPSHOT;
      queryState.isLoading = false;
      queryState.isPlaceholderData = false;
      const { rerender } = render(<ReadinessPanel projectSlug="proj-a" />);
      expect(screen.getByText('Not ready')).toBeTruthy();

      // Simulate the SDK holding proj-a's data (placeholderData) while
      // proj-b's readiness is in flight: react-query reports isLoading
      // false (data is present) and isPlaceholderData true.
      queryState.isLoading = false;
      queryState.isPlaceholderData = true;
      rerender(<ReadinessPanel projectSlug="proj-b" />);

      // Not blanked: the previous content is still rendered, not the
      // "Running checks…" loading line.
      expect(screen.getByText('Not ready')).toBeTruthy();
      expect(screen.queryByText('Running checks…')).toBeNull();
    });

    test('marks the held render as refreshing (status text + aria-busy)', () => {
      queryState.data = CONFIGURED_SNAPSHOT;
      queryState.isLoading = false;
      queryState.isPlaceholderData = false;
      const { rerender, container } = render(
        <ReadinessPanel projectSlug="proj-a" />,
      );
      // No marker while data genuinely belongs to the current key.
      expect(screen.queryByRole('status')).toBeNull();
      expect(
        container.querySelector('.readiness-panel')?.getAttribute('aria-busy'),
      ).toBeNull();

      queryState.isPlaceholderData = true;
      rerender(<ReadinessPanel projectSlug="proj-b" />);

      // A user (sighted or screen-reader) cannot miss that this is a held,
      // refreshing render: an explicit status message, aria-busy on the
      // section, and the CSS hook that dims the body.
      const status = screen.getByRole('status');
      expect(status.textContent).toMatch(/updating/i);
      expect(status.textContent).toMatch(/previous project/i);
      expect(
        container.querySelector('.readiness-panel')?.getAttribute('aria-busy'),
      ).toBe('true');
      expect(container.querySelector('.readiness-panel--stale')).toBeTruthy();
    });

    test('cannot be mistaken for the new subject: switching projects with different data proves the marker is load-bearing, not decorative', () => {
      // proj-a's data is held (isPlaceholderData) while proj-b's request is
      // in flight — the panel must show BOTH proj-a's actual content AND an
      // explicit marker; without the marker a reader would misattribute
      // proj-a's "ready" verdict to proj-b.
      queryState.data = OTHER_PROJECT_SNAPSHOT;
      queryState.isLoading = false;
      queryState.isPlaceholderData = true;
      render(<ReadinessPanel projectSlug="proj-b" />);

      // The held (stale) content from proj-a is visible…
      expect(screen.getByText('Ready to merge')).toBeTruthy();
      // …but ALWAYS accompanied by the refreshing marker while
      // isPlaceholderData is true, so it can never read as proj-b's own,
      // fresh verdict.
      expect(screen.getByRole('status').textContent).toMatch(/updating/i);
    });

    test('a genuine first load (no previous data) still shows a normal loading state, not the stale marker', () => {
      queryState.data = undefined;
      queryState.isLoading = true;
      queryState.isPlaceholderData = false;
      render(<ReadinessPanel projectSlug="proj-a" />);
      expect(screen.getByLabelText('Running readiness checks')).toBeTruthy();
      // Names the stale marker itself rather than probing for `role="status"`:
      // the shared loading skeleton is also a status region, so the old proxy
      // would now match the very thing it was meant to prove absent.
      expect(screen.queryByText(/showing the previous/i)).toBeNull();
    });
  });
});
