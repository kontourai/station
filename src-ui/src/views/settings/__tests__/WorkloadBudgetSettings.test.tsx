/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { formatDateTime } from '../../../utils/relativeTime';

const MIB = 1024 * 1024;
const state = vi.hoisted(() => ({
  previews: [] as Array<{ id: string; enabled: boolean }>,
  status: undefined as unknown,
  error: undefined as unknown,
  loading: false,
  refetch: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => {
  class WorkloadBudgetsUnsupportedError extends Error {}
  return {
    WorkloadBudgetsUnsupportedError,
    useFeaturePreviewsQuery: () => ({ data: state.previews }),
    useWorkloadBudgetsQuery: () => ({
      data: state.status,
      error: state.error,
      isLoading: state.loading,
      refetch: state.refetch,
    }),
    useUpdateWorkloadBudgetSettingsMutation: () => ({
      mutate: state.mutate,
      isPending: false,
      error: null,
    }),
  };
});
vi.mock('../../../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({ DiscardModal: () => null, guard: vi.fn() }),
}));

import { WorkloadBudgetsUnsupportedError } from '@kontourai/station-sdk';
import { WorkloadBudgetSettings } from '../WorkloadBudgetSettings';

function status(overrides: Record<string, unknown> = {}) {
  return {
    enforcement: { state: 'ready', platform: 'linux' },
    hostMemoryBytes: 16 * 1024 * MIB,
    limits: {
      memoryMaxBytes: 4915 * MIB,
      totalMemoryMaxBytes: 8192 * MIB,
      swapMaxBytes: 256 * MIB,
      tasksMax: 512,
    },
    sources: { memory: 'default', totalMemory: 'default' },
    settings: {},
    settingsWritable: true,
    applies: 'new-scopes',
    activeScopes: 1,
    ...overrides,
  };
}

describe('WorkloadBudgetSettings', () => {
  beforeEach(() => {
    state.previews = [];
    state.status = status();
    state.error = undefined;
    state.loading = false;
    state.mutate.mockReset();
    state.refetch.mockReset();
  });

  test('renders nothing while its Feature Preview is off', () => {
    state.previews = [{ id: 'workload-budget-settings', enabled: false }];
    const { container } = render(<WorkloadBudgetSettings />);
    expect(container.innerHTML).toBe('');
  });

  test('shows enforcement, host memory and effective budgets, and saves new values', async () => {
    state.previews = [{ id: 'workload-budget-settings', enabled: true }];
    render(<WorkloadBudgetSettings />);
    expect(screen.getByText(/This host has 16.0\s+GiB of memory/)).toBeTruthy();
    expect(screen.getByText(/^Enforced:/)).toBeTruthy();
    expect(screen.getByText('In effect: 4915 MiB (default).')).toBeTruthy();
    expect(
      screen.getByText(/The total applies now and can’t go below current use/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Per-engine memory (MiB)'), {
      target: { value: '6144' },
    });
    const save = screen.getByRole('button', { name: 'Save budgets' });
    // Both actions share the responsive action row (wrap, 44px, focus order).
    const row = save.closest('.responsive-surface-actions');
    expect(row).not.toBeNull();
    expect(
      row?.contains(screen.getByRole('button', { name: 'Discard changes' })),
    ).toBe(true);
    fireEvent.click(save);
    await waitFor(() =>
      expect(state.mutate).toHaveBeenCalledWith({
        memoryMiB: 6144,
        totalMemoryMiB: null,
      }),
    );
  });

  test('an environment override locks its field and a non-enforcing host says restart', () => {
    state.previews = [{ id: 'workload-budget-settings', enabled: true }];
    state.status = status({
      enforcement: { state: 'unmanaged', platform: 'darwin' },
      sources: { memory: 'environment', totalMemory: 'default' },
      applies: 'restart',
    });
    render(<WorkloadBudgetSettings />);
    expect(
      (screen.getByLabelText('Per-engine memory (MiB)') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Set by STATION_WORKLOAD_MEMORY_MIB/)).toBeTruthy();
    expect(screen.getByText('Resolves to: 8192 MiB (default).')).toBeTruthy();
    expect(
      screen.getByText(/Not enforced on this host \(darwin\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Restart Station to apply them/)).toBeTruthy();
  });

  describe('engine workloads Station couldn’t stop', () => {
    const abandonedAt = '2026-11-10T12:00:00.000Z';
    const cleanup = {
      pending: [
        {
          unit: 'station-engine-pending.scope',
          attempts: 1,
          errorKind: 'other',
          lastError: 'timeout',
          firstFailedAt: abandonedAt,
          nextAttemptAt: abandonedAt,
        },
      ],
      abandoned: [
        {
          unit: 'station-engine-0123456789abcdef.scope',
          sessionId: 'session-1',
          attempts: 6,
          errorKind: 'bus_unavailable',
          lastError: 'Failed to connect to bus',
          firstFailedAt: '2026-11-10T11:00:00.000Z',
          abandonedAt,
        },
      ],
      abandonedDropped: 2,
    };

    function expectAbandonedListed() {
      expect(screen.getByText('Workloads Station couldn’t stop')).toBeTruthy();
      expect(
        screen.getByText(/may still be running.*Restart Station to clear/),
      ).toBeTruthy();
      expect(
        screen.getByText('station-engine-0123456789abcdef.scope'),
      ).toBeTruthy();
      const detail = screen.getByText(
        /^Couldn’t reach the service manager · 6 attempts · /,
      );
      expect(detail.textContent).toContain(
        formatDateTime(abandonedAt, abandonedAt),
      );
      expect(screen.getByText('2 more not listed.')).toBeTruthy();
      expect(
        screen.getByText('Station is still retrying 1 more.'),
      ).toBeTruthy();
      // A pending scope is counted, not listed.
      expect(screen.queryByText('station-engine-pending.scope')).toBeNull();
    }

    test('lists them with attempts, error kind and time while the budget preview is off', () => {
      state.previews = [{ id: 'workload-budget-settings', enabled: false }];
      state.status = status({ cleanup });
      render(<WorkloadBudgetSettings />);
      expectAbandonedListed();
      expect(screen.queryByLabelText('Per-engine memory (MiB)')).toBeNull();
    });

    test('lists them inside the budget editor while its preview is on', () => {
      state.previews = [{ id: 'workload-budget-settings', enabled: true }];
      state.status = status({ cleanup });
      render(<WorkloadBudgetSettings />);
      expectAbandonedListed();
      expect(screen.getByLabelText('Per-engine memory (MiB)')).toBeTruthy();
    });

    test.each([
      [
        'none are abandoned',
        { pending: cleanup.pending, abandoned: [], abandonedDropped: 0 },
      ],
      ['an older host omits cleanup', undefined],
    ])('renders nothing extra when %s', (_name, value) => {
      state.status = status(value ? { cleanup: value } : {});
      const off = render(<WorkloadBudgetSettings />);
      expect(off.container.innerHTML).toBe('');
      off.unmount();
      state.previews = [{ id: 'workload-budget-settings', enabled: true }];
      render(<WorkloadBudgetSettings />);
      expect(screen.queryByText('Workloads Station couldn’t stop')).toBeNull();
      expect(screen.queryByText(/still retrying/)).toBeNull();
    });

    test('a host without workload status, or a pending read, renders nothing', () => {
      state.status = undefined;
      state.error = new WorkloadBudgetsUnsupportedError();
      const unsupported = render(<WorkloadBudgetSettings />);
      expect(unsupported.container.innerHTML).toBe('');
      unsupported.unmount();
      state.error = undefined;
      state.loading = true;
      const { container } = render(<WorkloadBudgetSettings />);
      expect(container.innerHTML).toBe('');
    });

    test('a failed read offers a retry', () => {
      state.status = undefined;
      state.error = new Error('HTTP 500');
      render(<WorkloadBudgetSettings />);
      expect(screen.getByText('Couldn’t check engine workloads')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(state.refetch).toHaveBeenCalledTimes(1);
    });
  });
});
