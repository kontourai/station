/** @vitest-environment jsdom */
import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { MonitoringEvent } from '../contexts/MonitoringContext';
import { ToolLatencyPanel } from '../views/monitoring/ToolLatencyPanel';

test('latency distinguishes zero duration, missing duration, and unreported outcome', () => {
  const result = (
    tool: string,
    duration?: number,
    outcome?: string,
  ): MonitoringEvent => ({
    timestamp: '2026-10-07T12:00:00Z',
    'timestamp.ms': 1791374400000,
    'trace.id': 'latency-test',
    'gen_ai.operation.name': 'execute_tool',
    'span.kind': 'end',
    'gen_ai.tool.name': tool,
    ...(duration === undefined ? {} : { 'station.tool.duration_ms': duration }),
    ...(outcome === undefined ? {} : { 'gen_ai.tool.call.outcome': outcome }),
  });
  render(
    <ToolLatencyPanel
      events={[
        result('measured', 0, 'success'),
        result('unmeasured'),
        result('failed', 80, 'error'),
        result('unresolved', undefined, 'unresolved'),
      ]}
      isLoading={false}
      readError={null}
      onRetry={() => {}}
    />,
  );
  const measured = screen.getByRole('row', {
    name: /measured 1 1 0 ms 0 ms 0 0/,
  });
  expect(within(measured).getAllByText('0 ms')).toHaveLength(2);
  expect(
    screen.getByRole('row', {
      name: /unmeasured 1 0 Not reported Not reported 0 1/,
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole('row', { name: /failed 1 1 80 ms 80 ms 1 0/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole('row', {
      name: /unresolved 1 0 Not reported Not reported 0 0/,
    }),
  ).toBeTruthy();
});
