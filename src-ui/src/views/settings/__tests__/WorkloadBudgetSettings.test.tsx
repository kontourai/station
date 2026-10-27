/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const MIB = 1024 * 1024;
const state = vi.hoisted(() => ({
  previews: [] as Array<{ id: string; enabled: boolean }>,
  status: undefined as unknown,
  error: undefined as unknown,
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
      isLoading: false,
      refetch: vi.fn(),
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
    state.mutate.mockReset();
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
      screen.getByText(/apply to engines started after saving/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Per-engine memory (MiB)'), {
      target: { value: '6144' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save budgets' }));
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
    expect(
      screen.getByText(/Not enforced on this host \(darwin\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Restart Station to apply them/)).toBeTruthy();
  });
});
