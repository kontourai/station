/**
 * @vitest-environment jsdom
 *
 * A settled turn's calls with no outcome read "no result" — unless this
 * Station's live tool record still holds them as running (the Agents pane
 * lists them as running). Then the batch must say they are running.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The browser activity card's own chrome needs a Station; its summary line is
// what this file checks, so the card renders just that line.
vi.mock('../components/browser-activity/InlineBrowserActivity', () => ({
  InlineBrowserActivity: ({ status }: { status: string }) => (
    <p data-testid="browser-activity-status">{status}</p>
  ),
}));

import BrowserActivityContent from '../components/browser-activity/BrowserActivityContent';
import { ToolCallBatch } from '../components/chat/ToolCallBatch';
import type {
  ToolCallLike,
  ToolCallRun,
} from '../components/chat/tool-call-runs';
import { ConversationConnectionProvider } from '../components/conversation/ConversationConnectionContext';
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

function toolStarted(id: string, partition?: string) {
  backgroundTasksStore.ingest(
    {
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-11-16T10:00:00.000Z',
      method: 'tool.started',
      toolCallId: id,
      toolName: 'Bash',
      arguments: { command: `npm run gate:for -- ${id}` },
    } as never,
    partition,
  );
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

  test('a chat without a Station reads the partition its events land in (its API base)', () => {
    const apiBase = 'http://127.0.0.1:4311';
    // The event handler ingests under `station ?? apiBase`.
    for (const id of ['bg-1', 'bg-2', 'bg-3']) toolStarted(id, apiBase);
    render(
      <ConversationConnectionProvider value={{ apiBase }}>
        <ToolCallBatch run={run} renderCall={() => null} />
      </ConversationConnectionProvider>,
    );
    expect(
      screen.getByRole('button', { name: /running/ }).textContent,
    ).toContain('1 done · 3 running');
    expect(screen.queryByText(/no result/)).toBeNull();
  });

  test('the browser activity summary counts a still-running call as running', () => {
    const browserRun: ToolCallRun = {
      type: 'tool-call-run',
      key: 'browser',
      calls: [call('nav-1', { toolName: 'browser_navigate' })].map(
        (part, index) => ({ part, index }),
      ),
    };
    const view = () => (
      <BrowserActivityContent
        scope={{} as never}
        browserSessionId={null}
        run={browserRun}
        active={false}
        summaryCalls={browserRun.calls.map(({ part }) => part)}
        renderRow={() => null}
      />
    );
    const { rerender } = render(view());
    expect(screen.getByTestId('browser-activity-status').textContent).toBe(
      '1 with no result',
    );
    act(() => toolStarted('nav-1'));
    rerender(view());
    expect(screen.getByTestId('browser-activity-status').textContent).toBe('');
  });
});
