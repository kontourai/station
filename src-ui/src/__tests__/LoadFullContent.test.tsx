/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * docs/design/event-content-spill.md: tool arguments and output stored out
 * of line show as marked previews until the person asks for the rest. The
 * SDK query is replaced by a controllable state; the card is real.
 */
const query = vi.hoisted(() => ({
  data: undefined as unknown,
  calls: 0,
}));
vi.mock('@kontourai/station-sdk/runtime-event-content', () => ({
  useApprovalContentQuery: () => ({
    data: undefined,
    isError: false,
    refetch: vi.fn(),
  }),
  useResolvedRuntimeEventValueQuery: () => {
    query.calls += 1;
    return { data: query.data, isError: false, refetch: vi.fn() };
  },
}));

const { ToolCallDisplay } = await import('../components/chat/ToolCallDisplay');

const FULL = 'line of the document\n'.repeat(2_000);
const ref = {
  $stationContent: 1,
  ref: `sha256-${'f'.repeat(64)}`,
  kind: 'string',
  bytes: FULL.length,
  length: FULL.length,
  preview: FULL.slice(0, 80),
};

describe('loading spilled tool content on demand', () => {
  beforeEach(() => {
    query.data = undefined;
    query.calls = 0;
  });

  test('a nested reference shows as a marked preview, and loads only on request', () => {
    const output = { content: [{ type: 'text', text: ref }] };
    query.data = {
      args: { path: 'doc.md' },
      output: { content: [{ type: 'text', text: FULL }] },
    };
    const view = render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'mcp__docs__read',
          args: { path: 'doc.md' },
          output,
          state: 'result',
          contentThreadId: 'thread-1',
        }}
      />,
    );
    fireEvent.click(view.container.querySelector('button.tool-call__line')!);
    const details = () => view.container.querySelector('.tool-call__details')!;
    expect(details().textContent).not.toContain('$stationContent');
    expect(details().textContent).toContain('bytes of content not inlined');
    expect(query.calls).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Load full content' }));
    expect(query.calls).toBeGreaterThan(0);
    expect(details().textContent).not.toContain('bytes of content not inlined');
    expect(
      screen.queryByRole('button', { name: 'Load full content' }),
    ).toBeNull();
  });

  test('a row with nothing stored out of line offers no load action', () => {
    const view = render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't2',
          toolName: 'read_file',
          args: { path: 'a.txt' },
          output: 'short',
          state: 'result',
        }}
      />,
    );
    fireEvent.click(view.container.querySelector('button.tool-call__line')!);
    expect(
      screen.queryByRole('button', { name: 'Load full content' }),
    ).toBeNull();
  });
});
