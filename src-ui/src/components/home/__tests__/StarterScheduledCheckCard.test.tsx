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

  test('#1582 C4: it is the shared page callout, with its copy unchanged', () => {
    // It rendered `.starter-work-card` — a class HomeView.css no longer
    // carries, because C4 replaced the card that owned it. Migrated, not
    // re-styled: the same three sentences, the same actions.
    render(<StarterScheduledCheckCard />);

    const callout = screen.getByLabelText('Run a scheduled readiness check');
    expect(callout.getAttribute('data-callout-id')).toBe(
      'starter-scheduled-check',
    );
    expect(callout.className).toBe('page-callout page-callout--info');
    expect(callout.querySelector('.page-callout__title')?.textContent).toBe(
      'Run a scheduled readiness check',
    );
    expect(callout.querySelector('.page-callout__body')?.textContent).toBe(
      'Create a disabled daily check and run it once through the real Scheduler.',
    );
    expect(
      callout.querySelector('.page-callout__action .button--primary')
        ?.textContent,
    ).toBe('Run check');
  });

  test('#1582 C4: a pending read is busy through the primitive, not a hand-passed class', () => {
    // The skeleton's flex sizing hangs off `--busy`; passing `aria-busy` and
    // the class separately is how a caller announces one without the other.
    statusQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    render(<StarterScheduledCheckCard />);

    const callout = screen.getByLabelText('Run a scheduled readiness check');
    expect(callout.className).toContain('page-callout--busy');
    expect(callout.getAttribute('aria-busy')).toBe('true');
  });

  test('#1582 C4: an unreachable receipt owner reads as a warning', () => {
    statusQuery.mockReturnValue({
      data: { state: 'unavailable' },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<StarterScheduledCheckCard />);

    const callout = screen.getByLabelText('Run a scheduled readiness check');
    expect(callout.className).toContain('page-callout--warning');
    expect(callout.querySelector('.page-callout__body')?.textContent).toBe(
      'The Scheduler receipt owner is unavailable.',
    );
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
