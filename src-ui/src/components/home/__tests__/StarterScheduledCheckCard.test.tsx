/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { navigate, launch, statusQuery, observationQuery } = vi.hoisted(() => ({
  navigate: vi.fn(),
  launch: vi.fn(),
  statusQuery: vi.fn(),
  observationQuery: vi.fn(),
}));

vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useStarterWorkQuery: statusQuery,
  useStarterWorkObservationQuery: observationQuery,
  useLaunchScheduledCheckStarterMutation: () => ({
    mutateAsync: launch,
    isPending: false,
    isError: false,
  }),
}));

import { StarterScheduledCheckCard } from '../StarterScheduledCheckCard';

const query = (data: unknown) => ({
  data,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

describe('StarterScheduledCheckCard', () => {
  beforeEach(() => {
    navigate.mockReset();
    launch.mockReset();
    statusQuery.mockReset().mockReturnValue(query({ state: 'unbound' }));
    observationQuery.mockReset().mockReturnValue(query(undefined));
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(9).buffer),
      },
    });
  });

  test('launches only the canonical scheduled-check operation and opens its receipt', async () => {
    launch.mockResolvedValue({
      state: 'started',
      href: '/schedule?run=exact-run',
    });
    render(<StarterScheduledCheckCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Run check' }));
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    expect(launch).toHaveBeenCalledWith({
      starterId: 'run-scheduled-check',
      operationId: `scheduled-check:1:${'09'.repeat(32)}`,
    });
    expect(navigate).toHaveBeenCalledWith('/schedule', { run: 'exact-run' });
  });

  test.each(['failed', 'indeterminate'] as const)(
    'opens the exact %s receipt without launching a substitute',
    (completion) => {
      statusQuery.mockReturnValue(
        query({
          state: 'bound',
          binding: {
            starterId: 'run-scheduled-check',
            operationId: 'sdk-owned-operation',
          },
        }),
      );
      observationQuery.mockReturnValue(
        query({
          starterId: 'run-scheduled-check',
          href: '/schedule?run=exact-run',
          completion: { state: completion },
        }),
      );
      render(<StarterScheduledCheckCard />);
      fireEvent.click(screen.getByRole('button', { name: 'Inspect receipt' }));
      expect(navigate).toHaveBeenCalledWith('/schedule', { run: 'exact-run' });
      expect(launch).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['started', { state: 'started', href: '/schedule?run=exact-run' }],
    [
      'already running',
      {
        state: 'deferred',
        reason: 'A scheduled readiness check is already running.',
        retrySafe: true,
      },
    ],
  ] as const)(
    'reissues the same bound operation after remount when it is %s',
    async (_label, launchResult) => {
      statusQuery.mockReturnValue(
        query({
          state: 'bound',
          binding: {
            starterId: 'run-scheduled-check',
            operationId: 'sdk-owned-operation',
          },
        }),
      );
      observationQuery.mockReturnValue(
        query({
          starterId: 'run-scheduled-check',
          href: '/schedule?run=exact-run',
          completion: { state: 'running' },
        }),
      );
      launch.mockResolvedValue(launchResult);
      render(<StarterScheduledCheckCard />);
      fireEvent.click(
        screen.getByRole('button', { name: 'Resume exact check' }),
      );
      await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
      expect(launch).toHaveBeenCalledWith({
        starterId: 'run-scheduled-check',
        operationId: 'sdk-owned-operation',
      });
      expect(navigate).toHaveBeenCalledWith('/schedule', { run: 'exact-run' });
    },
  );

  test.each([
    ['conflict', 'The canonical job name is already in use.'],
    ['unavailable', 'Scheduled-check storage needs operator repair.'],
  ] as const)(
    'opens Schedule instead of retrying a non-retryable %s result',
    async (state, reason) => {
      launch.mockResolvedValue({ state, reason, retrySafe: false });
      render(<StarterScheduledCheckCard />);
      fireEvent.click(screen.getByRole('button', { name: 'Run check' }));
      await screen.findByText(reason);
      fireEvent.click(screen.getByRole('button', { name: 'Open Schedule' }));
      expect(navigate).toHaveBeenCalledWith('/schedule');
      expect(launch).toHaveBeenCalledTimes(1);
    },
  );
});
