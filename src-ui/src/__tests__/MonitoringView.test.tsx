/**
 * @vitest-environment jsdom
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
import {
  COPY_TOAST_FAILURE,
  COPY_TOAST_SUCCESS,
} from '../hooks/useCopyToClipboardToast';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from './clipboard-stubs';

vi.mock(
  '@shared/monitoring-keys',
  async () => import('../../../src-shared/monitoring-keys'),
);

// fix-round : a mutable fixture (rather than a fixed return value) so one
// test below can flip `useFleetRoutingReceiptsQuery` into an error state —
// the exact case the bare-mock-factory bug in this file could not survive —
// and prove the `importOriginal`-and-spread fix below is load-bearing, not
// decorative.
const fleetRoutingReceiptsFixture = vi.hoisted(() => ({
  data: {
    schemaVersion: 'station.fleet-routing-receipt/v1',
    receipts: [] as unknown[],
    totalRecords: 0,
    chain: {
      status: 'intact' as const,
      brokenAtReceiptId: null,
      message: 'No fleet routing has been receipted on this Station yet.',
    },
  } as Record<string, unknown> | undefined,
  error: undefined as unknown,
  isLoading: false,
}));

const orchestrationSessionsFixture: {
  data: Array<{ lifecycleState?: string; hasActiveTurn?: boolean }> | undefined;
  status: 'pending' | 'error' | 'success';
  refetch: () => void;
} = { data: [], status: 'success', refetch: () => {} };

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  // fix-round : `FleetRoutingReceipts.tsx` imports `StationHttpError` as a
  // runtime value (`error instanceof StationHttpError`) — a bare mock
  // factory leaves that binding `undefined`, which throws on `instanceof`
  // the moment any fixture here becomes an error state. Keep the real module
  // for everything except the two hooks this file stubs.
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    // archive#1398: the view now renders `FleetRoutingReceipts`, which
    // reads this hook. Stubbed as a successful empty page by default — this
    // describe block is about the shell's page root, and a receipt panel
    // that threw would be caught by `MonitoringErrorBoundary` and blank the
    // whole assertion. One test below deliberately overrides this into an
    // error state.
    useFleetRoutingReceiptsQuery: () => fleetRoutingReceiptsFixture,
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
    // the view's Active/Running numbers are derived from this
    // read-model — the same one the chat dock reads — so it must be stubbed
    // here, not left to a QueryClient this shell test does not provide.
    useOrchestrationSessionsQuery: () => orchestrationSessionsFixture,
    useMonitoringMetricsQuery: () => ({
      data: [
        {
          agentSlug: 'planner-agent',
          messageCount: 12,
          conversationCount: 1,
          totalCost: 0.031,
        },
      ],
    }),
  };
});

vi.mock('../contexts/ModelsContext', () => ({
  useModels: () => [{ id: 'gpt-5.5', name: 'GPT 5.5', originalId: 'gpt-5.5' }],
}));

// Keep the real module and stub only the hook: the view and the log stream
// both read `monitoringEventIdentity` from here as a runtime value (the
// identity-based new-event highlight), and a bare factory leaves that binding
// undefined — the same fix-round trap this file documents for the SDK.
vi.mock('../contexts/MonitoringContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/MonitoringContext')>()),
  useMonitoring: () => ({
    stats: {
      agents: [
        {
          slug: 'planner-agent',
          name: 'Planner Agent',
          status: 'running',
          model: 'gpt-5.5',
          conversationCount: 1,
          messageCount: 12,
          cost: 0.031,
          healthy: true,
        },
      ],
      summary: {
        totalAgents: 1,
        activeAgents: 1,
        runningAgents: 1,
        totalMessages: 12,
        totalCost: 0.031,
      },
    },
    events: [
      {
        timestamp: '2026-04-26T16:00:00.100Z',
        'timestamp.ms': 100,
        'trace.id': 'trace-agent-start-0001',
        'gen_ai.operation.name': 'invoke_agent',
        'span.kind': 'start',
        'station.agent.slug': 'planner-agent',
        'gen_ai.conversation.id': 'conversation:alpha-123456',
        'station.input.chars': 420,
      },
      // Carries the tool result whose copy button archive#3341 migrates.
      {
        timestamp: '2026-04-26T16:00:01.100Z',
        'timestamp.ms': 1100,
        'trace.id': 'trace-tool-result-0001',
        'gen_ai.operation.name': 'execute_tool',
        'span.kind': 'end',
        'station.agent.slug': 'planner-agent',
        'gen_ai.conversation.id': 'conversation:alpha-123456',
        'gen_ai.tool.name': 'read_file',
        'gen_ai.tool.call.id': 'call-1',
        'gen_ai.tool.call.result': { ok: true },
      },
    ],
    connectionStatus: 'connected',
    isLoading: false,
    clearEvents: vi.fn(),
    setDateRange: vi.fn(),
    setTimeRange: vi.fn(),
  }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const { MonitoringViewWithBoundary } = await import('../views/MonitoringView');

describe('MonitoringView shell port', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    // Restore the default success fixture — see the error-state test below,
    // which deliberately mutates this module-level fixture.
    fleetRoutingReceiptsFixture.data = {
      schemaVersion: 'station.fleet-routing-receipt/v1',
      receipts: [],
      totalRecords: 0,
      chain: {
        status: 'intact',
        brokenAtReceiptId: null,
        message: 'No fleet routing has been receipted on this Station yet.',
      },
    };
    fleetRoutingReceiptsFixture.error = undefined;
    orchestrationSessionsFixture.data = [];
    orchestrationSessionsFixture.status = 'success';
    orchestrationSessionsFixture.refetch = vi.fn();
  });

  // review : `data` is undefined while the read is
  // pending and while it failed; defaulting that to `[]` reported an
  // authoritative `0 / 0` — the same false-zero discrepancy in a new costume.
  test('reports no count at all while the session read is pending', () => {
    orchestrationSessionsFixture.data = undefined;
    orchestrationSessionsFixture.status = 'pending';

    render(<MonitoringViewWithBoundary />);

    expect(screen.getByTestId('monitoring-active-sessions').textContent).toBe(
      '—',
    );
    expect(screen.getByTestId('monitoring-running-turns').textContent).toBe(
      '—',
    );
    expect(screen.getByText('Reading sessions…')).toBeTruthy();
  });

  test('a failed session read says so and offers a retry, never a zero', () => {
    orchestrationSessionsFixture.data = undefined;
    orchestrationSessionsFixture.status = 'error';

    render(<MonitoringViewWithBoundary />);

    expect(screen.getByTestId('monitoring-active-sessions').textContent).toBe(
      '—',
    );
    expect(screen.getByText('Session records unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(orchestrationSessionsFixture.refetch).toHaveBeenCalledTimes(1);
  });

  // Monitoring reported `Active: 0 / Running: 0` while a real
  // Claude Code turn was visibly running in the chat dock, because its
  // numbers came from the monitoring event store's own agent fold rather than
  // from the session projection the dock reads. Same projection now.
  test('counts a running orchestration session the dock can see', () => {
    orchestrationSessionsFixture.data = [
      { lifecycleState: 'running', hasActiveTurn: true },
      { lifecycleState: 'completed', hasActiveTurn: false },
    ];

    render(<MonitoringViewWithBoundary />);

    expect(screen.getByTestId('monitoring-active-sessions').textContent).toBe(
      '1',
    );
    expect(screen.getByTestId('monitoring-running-turns').textContent).toBe(
      '1',
    );
  });

  test('a Station with only finished sessions reports none active', () => {
    orchestrationSessionsFixture.data = [
      { lifecycleState: 'completed' },
      { lifecycleState: 'failed' },
      { lifecycleState: 'canceled' },
    ];

    render(<MonitoringViewWithBoundary />);

    expect(screen.getByTestId('monitoring-active-sessions').textContent).toBe(
      '0',
    );
  });

  test('renders inside the shared frame with contract-shaped monitoring data', () => {
    const { container } = render(<MonitoringViewWithBoundary />);

    // The page root is `PageFrame`'s now; this view hosts a full-height child
    // inside it (`.pane-host`) and renders no page header or root of its own.
    const root = container.firstElementChild;
    expect(Array.from(root?.classList ?? [])).toContain('pane-host');
    expect(Array.from(root?.classList ?? [])).toContain('monitoring-page');
    expect(root?.classList.contains('monitoring-view')).toBe(false);
    expect(container.querySelector('.page__header')).toBeNull();

    expect(screen.getByRole('heading', { name: 'Monitoring' })).toBeTruthy();
    expect(
      screen.getByLabelText('Monitoring connection connected'),
    ).toBeTruthy();
    expect(screen.getByText('Planner Agent')).toBeTruthy();
    expect(screen.getByText('AGENT-START')).toBeTruthy();
    expect(screen.getByText('METRICS')).toBeTruthy();
  });

  /**
   * fix-round : the bare `vi.mock('@kontourai/station-sdk',...)` factory
   * this file used to have does not export `StationHttpError`, so
   * `FleetRoutingReceipts.tsx`'s `error instanceof StationHttpError` check
   * throws the moment the fixture becomes an error state — a class of crash
   * only reachable once the fixture leaves the success shape every other
   * test here uses. Proves the `importOriginal`-and-spread fix is
   * load-bearing, not decorative: the panel renders its error copy instead
   * of throwing (which `MonitoringErrorBoundary` would otherwise mask as a
   * blanked assertion, not a passing one).
   */
  test('survives the fleet-routing-receipts panel entering an error state (StationHttpError must resolve)', async () => {
    fleetRoutingReceiptsFixture.data = undefined;
    fleetRoutingReceiptsFixture.error = new StationHttpError(
      500,
      'boom from the receipts route',
    );

    const { container } = render(<MonitoringViewWithBoundary />);

    // Did not fall into the error boundary's fallback — the panel itself
    // handled the error state.
    expect(container.textContent).not.toMatch(/something went wrong/i);
    expect(screen.getByRole('heading', { name: 'Fleet routing' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

// archive#3341: the tool-result copy called `navigator.clipboard.writeText`
// bare and toasted "Copied to clipboard" unconditionally — including on the
// insecure origins Station is routinely reached over from another device.
describe('MonitoringView tool-result copy (station#3341)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    showToastMock.mockReset();
    clipboardAbsent();
  });

  afterEach(() => {
    cleanup();
    clipboardAbsent();
  });

  function copyResultButton() {
    return screen.getByTitle('Copy to clipboard');
  }

  test('reports a copy only once the write resolved', async () => {
    const writeText = clipboardWrites();
    render(<MonitoringViewWithBoundary />);

    fireEvent.click(copyResultButton());

    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify({ ok: true }, null, 2),
    );
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(COPY_TOAST_SUCCESS),
    );
  });

  test('a refused write toasts the failure, never "Copied to clipboard"', async () => {
    clipboardRefuses();
    render(<MonitoringViewWithBoundary />);

    fireEvent.click(copyResultButton());

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(COPY_TOAST_FAILURE),
    );
    expect(showToastMock).not.toHaveBeenCalledWith(COPY_TOAST_SUCCESS);
  });

  test('an insecure origin with no clipboard API toasts the failure', async () => {
    clipboardAbsent();
    render(<MonitoringViewWithBoundary />);

    fireEvent.click(copyResultButton());

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(COPY_TOAST_FAILURE),
    );
    expect(showToastMock).not.toHaveBeenCalledWith(COPY_TOAST_SUCCESS);
  });
});
