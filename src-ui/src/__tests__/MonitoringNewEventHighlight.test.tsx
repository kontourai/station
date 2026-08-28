/**
 * @vitest-environment jsdom
 *
 * archive#3658, and — the two view-side
 * consequences of placing events by timestamp instead of prepending them.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock(
  '@shared/monitoring-keys',
  async () => import('../../../src-shared/monitoring-keys'),
);

const monitoring = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('../contexts/MonitoringContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/MonitoringContext')>()),
  useMonitoring: () => ({
    stats: null,
    events: monitoring.events,
    connectionStatus: 'connected' as const,
    isLoading: false,
    readError: null,
    retryRead: vi.fn(),
    clearEvents: vi.fn(),
    setDateRange: vi.fn(),
    setTimeRange: vi.fn(),
  }),
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
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
      chain: { status: 'intact', brokenAtReceiptId: null, message: 'none' },
    },
    error: undefined,
    isLoading: false,
  }),
  useFleetServeReceiptsQuery: () => ({
    data: {
      schemaVersion: 'station.fleet-serve-receipt/v1',
      receipts: [],
      totalRecords: 0,
      chain: { status: 'intact', brokenAtReceiptId: null, message: 'none' },
    },
    isLoading: false,
  }),
}));

vi.mock('../contexts/ModelsContext', () => ({ useModels: () => [] }));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const { MonitoringViewWithBoundary } = await import('../views/MonitoringView');

const row = (name: string, iso: string) => ({
  timestamp: name,
  'timestamp.ms': Date.parse(iso),
  'trace.id': name,
  'gen_ai.operation.name': 'invoke_agent',
  'span.kind': 'start',
  'station.agent.slug': 'planner-agent',
});

/** Which rendered rows carry the arrival highlight. */
function highlighted(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.log-entry.new-event')).map(
    (node) => node.textContent ?? '',
  );
}

describe('Monitoring new-event highlight (delta2 MEDIUM-3)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    monitoring.events = [];
  });

  test('the first list is history, not a burst of arrivals', async () => {
    monitoring.events = [
      row('10:00', '2026-08-21T10:00:00.000Z'),
      row('10:01', '2026-08-21T10:01:00.000Z'),
    ];
    const { container } = render(<MonitoringViewWithBoundary />);
    await waitFor(() =>
      expect(container.querySelectorAll('.log-entry')).toHaveLength(2),
    );
    expect(highlighted(container)).toEqual([]);
  });

/*
* The count-based effect highlighted indices `prevLength → length`, so a
* late row inserted BEFORE an existing one highlighted the old last row
* instead of the one that actually arrived.
*/
  test('a late arrival inserted mid-list highlights itself, not the last row', async () => {
    monitoring.events = [
      row('10:00', '2026-08-21T10:00:00.000Z'),
      row('10:03', '2026-08-21T10:03:00.000Z'),
    ];
    const { container, rerender } = render(<MonitoringViewWithBoundary />);
    await waitFor(() =>
      expect(container.querySelectorAll('.log-entry')).toHaveLength(2),
    );

// 10:02 arrives late and is placed between them.
    monitoring.events = [
      row('10:00', '2026-08-21T10:00:00.000Z'),
      row('10:02', '2026-08-21T10:02:00.000Z'),
      row('10:03', '2026-08-21T10:03:00.000Z'),
    ];
    act(() => rerender(<MonitoringViewWithBoundary />));

    await waitFor(() => expect(highlighted(container)).toHaveLength(1));
    expect(highlighted(container)[0]).toContain('10:02');
  });

/*
* At the retention cap every arrival replaces a row without changing
* `length`, so a count-based effect highlighted nothing at all.
*/
  test('an arrival at the retention cap is still highlighted', async () => {
    const base = Date.parse('2026-08-21T00:00:00.000Z');
    const full = Array.from({ length: 1000 }, (_, index) =>
      row(`row-${index}`, new Date(base + index * 1000).toISOString()),
    );
    monitoring.events = full;
    const { container, rerender } = render(<MonitoringViewWithBoundary />);
    await waitFor(() =>
      expect(container.querySelectorAll('.log-entry')).toHaveLength(1000),
    );

// One arrives; the oldest falls off. Length is unchanged.
    monitoring.events = [
      ...full.slice(1),
      row('arrival', new Date(base + 1_000_000).toISOString()),
    ];
    act(() => rerender(<MonitoringViewWithBoundary />));

    await waitFor(() => expect(highlighted(container)).toHaveLength(1));
    expect(highlighted(container)[0]).toContain('arrival');
  });
});

describe('Monitoring auto-follow (delta2 MEDIUM-2)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    monitoring.events = [];
  });

  test('an appended event scrolls the log to the bottom', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    monitoring.events = [row('10:00', '2026-08-21T10:00:00.000Z')];
    const { rerender } = render(<MonitoringViewWithBoundary />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

    scrollIntoView.mockClear();
    monitoring.events = [
      row('10:00', '2026-08-21T10:00:00.000Z'),
      row('10:01', '2026-08-21T10:01:00.000Z'),
    ];
    act(() => rerender(<MonitoringViewWithBoundary />));

// Auto Follow is on by default; the new row is below the viewport and the
// scroll button stays suppressed, so the view has to follow it.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });
});
