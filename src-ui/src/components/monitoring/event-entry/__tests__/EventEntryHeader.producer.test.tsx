/**
 * @vitest-environment jsdom
 *
 * A row a telemetry producer delivered names that producer, so the operator
 * can tell an external program's report from what Station observed.
 */

import { K } from '@shared/monitoring-keys';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MonitoringEvent } from '../../../../contexts/MonitoringContext';
import { EventEntryHeader } from '../EventEntryHeader';

afterEach(cleanup);

const row = (extra: Record<string, unknown> = {}) =>
  ({
    timestamp: '2026-10-19T00:00:00.000Z',
    'timestamp.ms': 0,
    'gen_ai.operation.name': 'execute_tool',
    [K.TOOL_NAME]: 'shell',
    ...extra,
  }) as unknown as MonitoringEvent;

const renderHeader = (event: MonitoringEvent) =>
  render(
    <EventEntryHeader
      event={event}
      selectedTraceId={null}
      selectedConversation={null}
      selectedToolCallId={null}
      onTraceClick={vi.fn()}
      onConversationClick={vi.fn()}
      onToolCallClick={vi.fn()}
    />,
  );

describe('EventEntryHeader producer label', () => {
  test('names the telemetry producer on a producer row', () => {
    renderHeader(row({ [K.TELEMETRY_PRODUCER]: 'flow-agents-codex' }));
    expect(screen.getByText('Producer:')).toBeTruthy();
    expect(screen.getByText('flow-agents-codex').getAttribute('title')).toBe(
      'flow-agents-codex: reported by an external telemetry producer; not observed by Station',
    );
  });

  test("shows the producer's own agent and session, with the full ids as tooltips", () => {
    renderHeader(
      row({
        [K.TELEMETRY_PRODUCER]: 'flow-agents-codex',
        [K.AGENT_SLUG]: 'producer:flow-agents-codex:codex',
        [K.TRACE_ID]: 'producer:flow-agents-codex:codex-session-2',
      }),
    );
    const agent = screen.getByText('codex');
    expect(agent.getAttribute('title')).toBe(
      'producer:flow-agents-codex:codex',
    );
    const trace = screen.getByText('codex-session-2');
    expect(trace.getAttribute('title')).toContain(
      'producer:flow-agents-codex:codex-session-2',
    );
    expect(screen.queryByText(/^producer:/)).toBeNull();
    // One line, ellipsis: the single-line pill class carries it.
    expect(screen.getByText('flow-agents-codex').className).toContain(
      'pill-badge--single-line',
    );
  });

  test('a producer-looking slug on a row with no producer is shown as sent', () => {
    renderHeader(row({ [K.AGENT_SLUG]: 'producer:flow-agents:codex' }));
    expect(screen.getByText('producer:flow-agents:codex')).toBeTruthy();
    expect(screen.queryByText('codex')).toBeNull();
  });

  test('shows no producer label on a row Station wrote', () => {
    renderHeader(row());
    expect(screen.queryByText('Producer:')).toBeNull();
  });
});
