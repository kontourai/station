/**
 * @vitest-environment jsdom
 *
 * station#3658: `MonitoringContext.fetchHistoricalEvents` caught a failed
 * `/monitoring/events` read, logged it, and dropped it — so a Station whose
 * event read had just been REFUSED rendered "No events yet · Waiting for
 * agent activity…", a confident claim about that Station's activity made on
 * the strength of a request that never succeeded.
 *
 * These tests run the real store and the real view together (only the
 * transport is stubbed), because the defect lived in the seam between them:
 * a store-only test would have proved a field is set, not that the empty
 * state stops being drawn.
 */

import { StationHttpError } from '@kontourai/station-sdk';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

vi.mock(
  '@shared/monitoring-keys',
  async () => import('../../../src-shared/monitoring-keys'),
);

const fetchHistorical = vi.hoisted(() => vi.fn());
const fetchSSE = vi.hoisted(() => vi.fn(() => ({ close: vi.fn() })));
const apiBaseBox = vi.hoisted(() => ({ apiBase: '' }));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: apiBaseBox.apiBase }),
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  // Keep the real module (see MonitoringView.test.tsx's fix-round L-4 note):
  // `StationHttpError` is imported as a runtime value elsewhere in this tree,
  // and this file deliberately throws one.
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    // The one transport under test. The store's own hydration logic — the
    // abort/generation guards, the loading flag, the new error slot — is the
    // real thing.
    fetchMonitoringEvents: fetchHistorical,
    fetchSSE,
    useMonitoringStatsQuery: () => ({ data: undefined }),
    useOrchestrationSessionsQuery: () => ({
      data: [],
      status: 'success' as const,
      refetch: vi.fn(),
    }),
    useMonitoringMetricsQuery: () => ({ data: [] }),
    useFleetRoutingReceiptsQuery: () => ({
      data: {
        schemaVersion: 'station.fleet-routing-receipt/v1',
        receipts: [],
        totalRecords: 0,
        chain: {
          status: 'intact',
          brokenAtReceiptId: null,
          message: 'No fleet routing has been receipted on this Station yet.',
        },
      },
      error: undefined,
      isLoading: false,
    }),
    useFleetServeReceiptsQuery: () => ({
      data: {
        schemaVersion: 'station.fleet-serve-receipt/v1',
        receipts: [],
        totalRecords: 0,
        chain: {
          status: 'intact',
          brokenAtReceiptId: null,
          message: 'This Station has not served any fleet inference yet.',
        },
      },
      isLoading: false,
    }),
  };
});

vi.mock('../contexts/ModelsContext', () => ({
  useModels: () => [],
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const { MonitoringViewWithBoundary } = await import('../views/MonitoringView');

const AGENT_START_EVENT = {
  timestamp: '2026-04-26T16:00:00.100Z',
  'timestamp.ms': 100,
  'trace.id': 'trace-agent-start-0001',
  'gen_ai.operation.name': 'invoke_agent',
  'span.kind': 'start',
  'station.agent.slug': 'planner-agent',
  'gen_ai.conversation.id': 'conversation:alpha-123456',
  'station.input.chars': 420,
};

/**
 * Mounting the view hydrates more than once — `useMonitoringTimeRange` sets
 * the live 5-minute window on mount, and each `setTimeRange` re-hydrates —
 * so a `…Once` stub would leave the LAST read succeeding with `undefined`
 * and prove nothing. Every attempt fails, exactly as a down endpoint does.
 */
function everyReadFails(error: unknown) {
  fetchHistorical.mockReset();
  fetchHistorical.mockRejectedValue(error);
}

function everyReadReturns(events: unknown[]) {
  fetchHistorical.mockReset();
  fetchHistorical.mockResolvedValue(events);
}

describe('Monitoring historical read failure (station#3658)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    // The store cache is keyed by apiBase and lives for the module's
    // lifetime; a fresh key per test is a fresh store.
    apiBaseBox.apiBase = `https://monitoring-read-failure-${Math.random()}.example.test`;
  });

  afterEach(() => {
    cleanup();
  });

  test('a rejected read renders the failure and a retry, never "No events yet"', async () => {
    everyReadFails(
      new StationHttpError(
        500,
        'Monitoring events request rejected with HTTP 500',
      ),
    );

    render(<MonitoringViewWithBoundary />);

    await waitFor(() =>
      expect(screen.getByText('Unable to load event history')).toBeTruthy(),
    );
    // The server's own sentence, not a shrug — `describeReadFailure`.
    expect(
      screen.getByText('Monitoring events request rejected with HTTP 500'),
    ).toBeTruthy();
    // The defect itself: the empty state is withheld, not merely joined.
    expect(screen.queryByText('No events yet')).toBeNull();
    expect(screen.queryByText('Waiting for agent activity...')).toBeNull();
    // Announced, not just drawn — `ErrorState` carries `role="alert"`.
    expect(
      screen
        .getAllByRole('alert')
        .some((node) =>
          node.textContent?.includes('Unable to load event history'),
        ),
    ).toBe(true);
  });

  test('retrying a failed read replaces the failure with the events it returns', async () => {
    everyReadFails(new Error('monitoring store unreachable'));

    render(<MonitoringViewWithBoundary />);

    await waitFor(() =>
      expect(screen.getByText('monitoring store unreachable')).toBeTruthy(),
    );

    everyReadReturns([AGENT_START_EVENT]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByText('AGENT-START')).toBeTruthy());
    expect(screen.queryByText('Unable to load event history')).toBeNull();
    expect(screen.queryByText('monitoring store unreachable')).toBeNull();
  });

  test('a read that genuinely came back empty still says so', async () => {
    everyReadReturns([]);

    render(<MonitoringViewWithBoundary />);

    await waitFor(() => expect(screen.getByText('No events yet')).toBeTruthy());
    expect(screen.queryByText('Unable to load event history')).toBeNull();
  });
});
