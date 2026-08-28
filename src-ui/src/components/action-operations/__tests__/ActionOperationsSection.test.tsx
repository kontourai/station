/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const navigate = vi.fn();
const mutate = vi.fn();
const useActionOperationsQuery = vi.hoisted(() => vi.fn());
const useCancelActionOperationMutation = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk/action-operations', () => ({
  useActionOperationsQuery,
  useCancelActionOperationMutation,
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));

import {
  ActionOperationsSection,
  groupActionOperations,
} from '../ActionOperationsSection';

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
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: true,
  });
});

describe('ActionOperationsSection', () => {
  test('derives Activity groups from canonical lifecycle rather than separate labels', () => {
    const groups = groupActionOperations([
      { ...base, id: 'a', status: 'running' },
      {
        ...base,
        id: 'stale',
        status: 'running',
        progress: {
          kind: 'phase',
          code: 'reconciliation-required',
        },
      },
      {
        ...base,
        id: 'b',
        status: 'failed',
        errorSummary: 'Could not continue.',
        completedAt: base.updatedAt,
      },
      { ...base, id: 'c', status: 'succeeded', completedAt: base.updatedAt },
    ]);
    expect(groups.inProgress.map((item) => item.id)).toEqual(['a']);
    expect(groups.needsAttention.map((item) => item.id)).toEqual([
      'stale',
      'b',
    ]);
    expect(groups.recent.map((item) => item.id)).toEqual(['c']);
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
   * Audit / : the initial read used to render a bare
   * "Connecting…" sentence — the exact one-off-loading-string shape
   *  banned in favor of SkeletonList/SkeletonBlock. Not covered by
   * any existing test (the reconnecting case below only exercises the
   * HEADER's "Reconnecting…" chip, which requires cached `data`) — this
   * pins the fix.
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
    expect(screen.queryByText(/Connecting to operation status/)).toBeNull();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.getAttribute('aria-label')).toBe(
      'Connecting to operation status',
    );
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
    expect(screen.getByRole('status').textContent).toContain('Reconnecting');
    expect(screen.getByRole('alert').textContent).toContain(
      'Cancellation was refused',
    );
  });
});
