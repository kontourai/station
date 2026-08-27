/**
 * @vitest-environment jsdom
 *
 * station#3507 sibling sweep — `EventEntrySections.tsx`'s `ToolResultSection`
 * had the identical double-encode defect `ToolCallDisplay.tsx` was fixed for:
 * `JSON.stringify(event[K.TOOL_CALL_RESULT], null, 2)` unconditionally, even
 * though the OTLP agent-telemetry ingest route (`otlp-receiver.ts`) and a
 * tool whose own return value is a plain string can both report an
 * already-string `gen_ai.tool.call.result`. Re-stringifying a string wraps it
 * in an extra layer of quotes/escapes.
 *
 * Fix round: `resultPre()` originally picked "the only classless `<pre>` in
 * the component," which was true of every fixture here (none set
 * `TOOL_CALL_ARGS`) and false of the component — `ToolInputSection` renders
 * an equally classless `<pre>` earlier in DOM order whenever args are
 * present. Re-anchored on the "Result" `<summary>` instead; the last test
 * below proves the fix by adding args to the fixture and confirming the
 * result text is still what comes back.
 */

import { K } from '@shared/monitoring-keys';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MonitoringEvent } from '../../../../contexts/MonitoringContext';
import { EventEntrySections } from '../EventEntrySections';

afterEach(cleanup);

function baseEvent(
  result: unknown,
  extra: Partial<MonitoringEvent> = {},
): MonitoringEvent {
  return {
    timestamp: '2026-08-18T00:00:00.000Z',
    'timestamp.ms': 0,
    'trace.id': 'trace-1',
    'gen_ai.operation.name': 'execute_tool',
    [K.TOOL_CALL_RESULT]: result,
    ...extra,
  } as unknown as MonitoringEvent;
}

/**
 * Anchored on the "Result" `<summary>`, not on class-name absence —
 * `ToolInputSection`'s `<pre>{input.text}</pre>` (`EventEntrySections.tsx:119`)
 * is ALSO classless and renders earlier in DOM order whenever the event
 * carries `TOOL_CALL_ARGS`. An earlier version of this helper picked "the
 * first classless `<pre>`", which was true of every fixture in this file
 * (none set `TOOL_CALL_ARGS`) and false of the component — it would have
 * silently started reading the args block instead of the result block the
 * moment a fixture grew one. `'renders the result pre even when the args
 * section also renders a classless <pre>'` below proves this selector
 * survives that case.
 */
function resultPre(): string | null | undefined {
  const resultDetails = Array.from(
    document.querySelectorAll('details.log-details'),
  ).find(
    (details) => details.querySelector('summary')?.textContent === 'Result',
  );
  return resultDetails?.querySelector('pre')?.textContent;
}

describe('EventEntrySections tool result rendering (station#3507)', () => {
  test('an object result renders as pretty-printed JSON', () => {
    const structuredResult = [{ type: 'text', text: 'total 24' }];
    render(
      <EventEntrySections
        event={baseEvent(structuredResult)}
        onCopyResult={vi.fn()}
      />,
    );
    // <details> content is present in the DOM even when closed.
    expect(resultPre()).toBe(JSON.stringify(structuredResult, null, 2));
  });

  test('an already-serialized string result renders as-is, not double-encoded', () => {
    const preSerialized = JSON.stringify([{ type: 'text', text: 'total 24' }]);
    render(
      <EventEntrySections
        event={baseEvent(preSerialized)}
        onCopyResult={vi.fn()}
      />,
    );
    expect(resultPre()).toBe(preSerialized);
    expect(resultPre()).not.toContain('\\"');
  });

  test('the copy button copies the same unescaped text for a string result', () => {
    const onCopyResult = vi.fn();
    render(
      <EventEntrySections
        event={baseEvent('hello world')}
        onCopyResult={onCopyResult}
      />,
    );
    fireEvent.click(screen.getByTitle('Copy to clipboard'));
    expect(onCopyResult).toHaveBeenCalledWith('hello world');
  });

  test('renders the result pre even when the args section also renders a classless <pre>', () => {
    render(
      <EventEntrySections
        event={baseEvent('hello world', {
          [K.TOOL_CALL_ARGS]: { path: '/tmp' },
        })}
        onCopyResult={vi.fn()}
      />,
    );
    // ToolInputSection's classless <pre> renders first in DOM order; a
    // selector keyed on "first classless <pre>" would return its JSON here,
    // not the result string below.
    expect(resultPre()).toBe('hello world');
  });
});
