/**
 * @vitest-environment jsdom
 *
 * A settled turn's calls with no outcome read "no result" — unless this
 * Station's live tool record still holds them as running (the Agents pane
 * lists them as running). Then the batch must say they are running.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ToolCallBatch } from '../components/chat/ToolCallBatch';
import type {
  ToolCallLike,
  ToolCallRun,
} from '../components/chat/tool-call-runs';
import { backgroundTasksStore } from '../contexts/background-tasks-store';

const THREAD = 'observed-running-thread';

function call(id: string, extra: Partial<ToolCallLike> = {}): ToolCallLike {
  return {
    type: 'tool-invocation',
    toolCallId: id,
    toolName: 'Bash',
    args: { command: `npm run gate:for -- ${id}` },
    // The durable projection's shape for a started call in a turn that is
    // no longer live: no terminal observed.
    state: 'call',
    ...extra,
  };
}

const run: ToolCallRun = {
  type: 'tool-call-run',
  key: 'run',
  calls: [
    call('done-1', { state: 'completed', result: 'ok' }),
    call('bg-1'),
    call('bg-2'),
    call('bg-3'),
  ].map((part, index) => ({ part, index })),
};

function toolStarted(id: string) {
  backgroundTasksStore.ingest({
    provider: 'claude',
    threadId: THREAD,
    createdAt: '2026-11-16T10:00:00.000Z',
    method: 'tool.started',
    toolCallId: id,
    toolName: 'Bash',
    arguments: { command: `npm run gate:for -- ${id}` },
  } as never);
}

describe('ToolCallBatch — calls the live record still runs', () => {
  beforeEach(() => backgroundTasksStore.reset());
  afterEach(() => {
    cleanup();
    backgroundTasksStore.reset();
  });

  test('calls with no outcome and no live record read "no result"', () => {
    render(<ToolCallBatch run={run} renderCall={() => null} />);
    expect(screen.getByText('3 with no result')).toBeTruthy();
    expect(screen.queryByText(/running/)).toBeNull();
  });

  test('calls the live record holds as running are counted as running', () => {
    for (const id of ['bg-1', 'bg-2', 'bg-3']) toolStarted(id);
    render(<ToolCallBatch run={run} renderCall={() => null} />);
    const summary = screen.getByRole('button', { name: /running/ });
    expect(summary.textContent).toContain('1 done · 3 running');
    expect(screen.queryByText(/no result/)).toBeNull();
  });

  test('a call the turn end closed goes back to "no result"', () => {
    for (const id of ['bg-1', 'bg-2', 'bg-3']) toolStarted(id);
    render(<ToolCallBatch run={run} renderCall={() => null} />);
    expect(screen.queryByText(/no result/)).toBeNull();
    act(() => {
      backgroundTasksStore.ingest({
        provider: 'claude',
        threadId: THREAD,
        createdAt: '2026-11-16T10:05:00.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
      } as never);
    });
    expect(screen.getByText('3 with no result')).toBeTruthy();
  });
});
