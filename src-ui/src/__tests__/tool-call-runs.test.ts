import { describe, expect, test } from 'vitest';
import {
  isToolCallPart,
  splitToolCallRuns,
  type ToolCallLike,
} from '../components/chat/tool-call-runs';

function toolCall(overrides: Partial<ToolCallLike> = {}): ToolCallLike {
  return {
    type: 'tool-invocation',
    toolCallId: 'call-1',
    toolName: 'Read',
    ...overrides,
  };
}

describe('isToolCallPart', () => {
  test('matches the flat tool-invocation type and persisted tool-<name> variants', () => {
    expect(isToolCallPart({ type: 'tool-invocation' })).toBe(true);
    expect(isToolCallPart({ type: 'tool-shell_exec' })).toBe(true);
  });

  test('rejects non-tool parts and empty input', () => {
    expect(isToolCallPart({ type: 'text' })).toBe(false);
    expect(isToolCallPart(undefined)).toBe(false);
    expect(isToolCallPart(null)).toBe(false);
    expect(isToolCallPart({} as any)).toBe(false);
  });
});

describe('splitToolCallRuns', () => {
  test('returns an empty array for undefined/empty input', () => {
    expect(splitToolCallRuns(undefined)).toEqual([]);
    expect(splitToolCallRuns(null)).toEqual([]);
    expect(splitToolCallRuns([])).toEqual([]);
  });

  test('groups consecutive tool calls into one run, preserving original indices', () => {
    const parts = [
      toolCall({ toolCallId: 'a' }),
      toolCall({ toolCallId: 'b' }),
      toolCall({ toolCallId: 'c' }),
    ];
    const blocks = splitToolCallRuns(parts);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool-call-run');
    const run = blocks[0] as Extract<
      (typeof blocks)[0],
      { type: 'tool-call-run' }
    >;
    expect(run.calls.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(run.key).toBe('tool-call-run:a');
  });

  test('does not merge runs separated by a non-tool part', () => {
    const parts = [
      toolCall({ toolCallId: 'a' }),
      { type: 'text', content: 'hello' } as ToolCallLike,
      toolCall({ toolCallId: 'b' }),
    ];
    const blocks = splitToolCallRuns(parts);
    expect(blocks.map((b) => b.type)).toEqual([
      'tool-call-run',
      'content-part',
      'tool-call-run',
    ]);
  });

  test('falls back to a position-based key when the first call has no id', () => {
    const parts = [
      toolCall({ toolCallId: undefined }),
      toolCall({ toolCallId: undefined }),
    ];
    const blocks = splitToolCallRuns(parts);
    expect(blocks[0].type).toBe('tool-call-run');
    expect((blocks[0] as any).key).toBe('tool-call-run:0-1');
  });
});
