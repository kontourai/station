/** @vitest-environment jsdom */
import type { ActionOperation } from '@kontourai/station-sdk/action-operations';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const navigate = vi.fn();
const mutate = vi.fn();
const useActionOperationsQuery = vi.hoisted(() => vi.fn());
const useCancelActionOperationMutation = vi.hoisted(() => vi.fn());

// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it. This harness mounts a fragment of that tree, and nothing
// here asserts a surface reveal, so the command hook is supplied directly.
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../../../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));

vi.mock('@kontourai/station-sdk/action-operations', () => ({
  useActionOperationsQuery,
  useCancelActionOperationMutation,
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));

import { ActionOperationsSection } from '../ActionOperationsSection';

const base = {
  schemaVersion: 'station.action-operation/v1' as const,
  sequence: 1,
  changeSequence: 1,
  revision: 1,
  scope: { accountId: 'account-a' },
  title: 'Fork conversation',
  progress: { kind: 'indeterminate' as const },
  cancellation: 'supported' as const,
  domain: {
    kind: 'conversation-fork' as const,
    sourceConversationId: 'source',
    targetConversationId: 'target',
  },
  reentry: {
    kind: 'conversation' as const,
    agentId: 'codex',
    conversationId: 'target',
  },
  acceptedAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:01.000Z',
} satisfies Omit<ActionOperation, 'id' | 'status'>;

function openOperations() {
  const summary = screen.getByText(/^Platform actions/);
  if (!summary.closest('details')?.open) fireEvent.click(summary);
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: true,
  });
  useCancelActionOperationMutation.mockReturnValue({
    mutate,
    isPending: false,
    error: null,
  });
});

describe('ActionOperationsSection', () => {
  test('terminal status owns the row copy and placement even when progress was retained', () => {
    const items: ActionOperation[] = [
      { ...base, id: 'a', title: 'Running action', status: 'running' },
      {
        ...base,
        id: 'stale',
        title: 'Unresolved action',
        status: 'running',
        progress: {
          kind: 'phase',
          code: 'reconciliation-required',
        },
      },
      {
        ...base,
        id: 'b',
        title: 'Failed action',
        status: 'failed',
        progress: {
          kind: 'determinate',
          completed: 1,
          total: 2,
          unit: 'steps',
        },
        errorSummary: 'Could not continue.',
        completedAt: base.updatedAt,
      },
      {
        ...base,
        id: 'c',
        title: 'Succeeded action',
        status: 'succeeded',
        completedAt: base.updatedAt,
      },
      {
        ...base,
        id: 'd',
        title: 'Cancelled action',
        status: 'cancelled',
        completedAt: base.updatedAt,
      },
      {
        ...base,
        id: 'e',
        title: 'Settled action',
        status: 'succeeded',
        progress: { kind: 'phase', code: 'reconciliation-required' },
        completedAt: base.updatedAt,
      },
    ];
    useActionOperationsQuery.mockReturnValue({
      data: { schemaVersion: base.schemaVersion, items },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    render(<ActionOperationsSection />);
    expect(
      screen.getByText('2 need attention · 1 in progress · 3 recent'),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'Needs attention' }),
    ).toBeTruthy();
    expect(
      screen.getByText('Recent history (3)').closest('details')?.open,
    ).toBe(false);
    fireEvent.click(screen.getByText('Recent history (3)'));
    openOperations();
    const inProgress = screen.getByRole('region', { name: 'In progress' });
    expect(within(inProgress).getAllByRole('listitem')).toHaveLength(1);
    expect(inProgress.textContent).toContain('Running · Working');
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(within(attention).getAllByRole('listitem')).toHaveLength(2);
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(within(recent).getAllByRole('listitem')).toHaveLength(3);
    expect(recent.textContent).not.toMatch(/Working|reconciliation/);
    expect(
      within(attention).getByText('Failed action').closest('li')?.textContent,
    ).not.toContain('1/2 steps');
    expect(
      within(recent).getByText('Cancelled action').closest('li')?.textContent,
    ).toContain('Cancelled ·');
    expect(screen.getAllByText('Settled action')).toHaveLength(1);
  });

  test('keeps unfiltered platform actions in a separate collapsed disclosure', () => {
    useActionOperationsQuery.mockReturnValue({
      data: {
        schemaVersion: base.schemaVersion,
        items: [{ ...base, id: 'action', status: 'running' }],
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    render(<ActionOperationsSection />);
    expect(screen.getByText('1 in progress')).toBeTruthy();
    expect(screen.getByText('Platform actions').closest('details')?.open).toBe(
      false,
    );
    openOperations();
    expect(
      screen.getByText('All platform actions. Session filters do not apply.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    expect(navigate).toHaveBeenCalledWith('/agents/codex/conversations/target');
  });

  test('renders re-entry once, cancellation only when supported, and reconnect truthfully', () => {
    useActionOperationsQuery.mockReturnValue({
      data: {
        schemaVersion: base.schemaVersion,
        items: [
          { ...base, id: 'running', status: 'running' },
          {
            ...base,
            id: 'finished',
            status: 'succeeded',
            cancellation: 'unsupported',
            completedAt: base.updatedAt,
          },
        ],
      },
      isLoading: false,
      isFetching: true,
      error: null,
    });
    useCancelActionOperationMutation.mockReturnValue({
      mutate,
      isPending: false,
      error: null,
    });
    render(<ActionOperationsSection />);
    openOperations();
    fireEvent.click(screen.getByText('Recent history (1)'));
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Refreshing');
    expect(
      screen.getAllByRole('button', { name: 'Open conversation' }),
    ).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Open conversation' })[0]!,
    );
    expect(navigate).toHaveBeenCalledWith('/agents/codex/conversations/target');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mutate).toHaveBeenCalledWith('running');
  });

  /**
   * Audit F5 / SHELL-13: the initial read used to render a bare
   * "Connecting…" sentence — the exact one-off-loading-string shape
   * SHELL-13 banned in favor of SkeletonList/SkeletonBlock. Not covered by
   * any existing test (the reconnecting case below only exercises the
   * HEADER's "Reconnecting…" chip, which requires cached `data`) — this
   * pins the fix.
   *
   * #1960 later gave SkeletonList an aria-hidden `.skeleton-status-label`
   * span so reduced-motion users see a status when shimmer is clamped away,
   * which broke this test's original `queryByText(...)` null assertion —
   * text queries ignore aria-hidden, so they cannot distinguish the
   * skeleton's own status label from a bespoke sentence. The contract is
   * restated as what it always meant: placeholder rows plus status
   * semantics, with the sentence allowed ONLY as the skeleton's own
   * aria-hidden label (never as visible bespoke content).
   */
  test('renders a skeleton, not a bespoke sentence, for the initial read', () => {
    useActionOperationsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      error: null,
    });
    useCancelActionOperationMutation.mockReturnValue({
      mutate,
      isPending: false,
      error: null,
    });
    render(<ActionOperationsSection />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.getAttribute('aria-label')).toBe(
      'Connecting to operation status',
    );
    expect(status.querySelectorAll('.skeleton-list__item')).toHaveLength(2);
    for (const node of screen.queryAllByText(
      /Connecting to operation status/,
    )) {
      expect(status.contains(node)).toBe(true);
      expect(node.getAttribute('aria-hidden')).toBe('true');
    }
  });

  /**
   * archive#4474: a SECOND skeleton for "error, no cached
   * data, isFetching" used to alternate with the static "unavailable" line
   * on the query's 5s `refetchInterval`, oscillating indefinitely and
   * displacing every row below the pane — a real-Chromium geometry test
   * (ActionOperationsSection.reflow.test.tsx) pins the zero-displacement
   * property directly; this pins the simpler, cheaper invariant at the
   * component level: the SAME static line renders regardless of
   * `isFetching`, so there is nothing left to oscillate between. An
   * automatic background retry is not news (archive#3297's stance for
   * ConnectionBannerSource, applied here too).
   */
  test.each([true, false])(
    'renders the same static "unavailable" line regardless of isFetching (isFetching=%s)',
    (isFetching) => {
      useActionOperationsQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        isFetching,
        error: new Error('network'),
      });
      useCancelActionOperationMutation.mockReturnValue({
        mutate,
        isPending: false,
        error: null,
      });
      render(<ActionOperationsSection />);
      expect(screen.queryByRole('status')).toBeNull();
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toBe('Operation status unavailable.');
    },
  );

  test('does not masquerade unavailable status as an empty action list', () => {
    useActionOperationsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error('offline'),
    });
    useCancelActionOperationMutation.mockReturnValue({
      mutate,
      isPending: false,
      error: null,
    });
    render(<ActionOperationsSection />);
    expect(screen.getByRole('alert').textContent).toContain('unavailable');
  });

  test('distinguishes offline and reconnecting and renders cancellation errors', () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    useActionOperationsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error('network'),
    });
    useCancelActionOperationMutation.mockReturnValue({
      mutate,
      isPending: false,
      error: null,
    });
    const { unmount } = render(<ActionOperationsSection />);
    expect(screen.getByRole('status').textContent).toContain('Offline');
    unmount();

    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    useActionOperationsQuery.mockReturnValue({
      data: {
        schemaVersion: base.schemaVersion,
        items: [{ ...base, id: 'a', status: 'running' }],
      },
      isLoading: false,
      isFetching: true,
      error: new Error('network'),
    });
    useCancelActionOperationMutation.mockReturnValue({
      mutate,
      isPending: false,
      error: new Error('Cancellation was refused by the operation owner'),
    });
    render(<ActionOperationsSection />);
    openOperations();
    expect(screen.getByRole('status').textContent).toContain('Reconnecting');
    expect(screen.getByRole('alert').textContent).toContain(
      'Cancellation was refused',
    );
  });
});
