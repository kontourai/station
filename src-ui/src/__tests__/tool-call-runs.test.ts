import { describe, expect, test } from 'vitest';
import {
  foldTurnWork,
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
    expect(isToolCallPart({ type: 'reasoning' })).toBe(false);
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

  test('passes non-tool parts through unchanged, preserving order and index', () => {
    const parts = [
      { type: 'text', content: 'intro' } as ToolCallLike,
      toolCall({ toolCallId: 'a' }),
      { type: 'reasoning', content: 'thinking' } as ToolCallLike,
    ];
    const blocks = splitToolCallRuns(parts);
    expect(blocks[0]).toEqual({
      type: 'content-part',
      index: 0,
      part: parts[0],
    });
    expect(blocks[1].type).toBe('tool-call-run');
    expect(blocks[2]).toEqual({
      type: 'content-part',
      index: 2,
      part: parts[2],
    });
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

describe('foldTurnWork', () => {
  const text = (content: string, extra: Partial<ToolCallLike> = {}) =>
    ({ type: 'text', content, ...extra }) as ToolCallLike;

  test('one run or none returns exactly the split blocks', () => {
    const parts = [text('intent'), toolCall({ toolCallId: 'a' }), text('end')];
    expect(foldTurnWork(parts)).toEqual(splitToolCallRuns(parts));
    expect(foldTurnWork([text('only prose')])).toEqual(
      splitToolCallRuns([text('only prose')]),
    );
  });

  test('every call and the narration between them become one run where the first call was', () => {
    const parts = [
      text('intent'),
      toolCall({ toolCallId: 'a' }),
      text('between'),
      toolCall({ toolCallId: 'b' }),
      toolCall({ toolCallId: 'c' }),
      text('outcome'),
    ];
    const blocks = foldTurnWork(parts);
    expect(blocks.map((b) => b.type)).toEqual([
      'content-part',
      'tool-call-run',
      'content-part',
    ]);
    const run = blocks[1]!;
    if (run.type !== 'tool-call-run') throw new Error('expected a run');
    expect(run.key).toBe('tool-call-run:a');
    expect(run.calls.map((c) => c.index)).toEqual([1, 3, 4]);
    expect(run.interludes?.map((n) => n.index)).toEqual([2]);
    expect(blocks[2]).toMatchObject({ part: { content: 'outcome' } });
  });

  test('a runtime error, a file and blank text inside the span stay visible after the run, in order', () => {
    const parts = [
      toolCall({ toolCallId: 'a' }),
      text('Engine crashed', { runtimeError: true }),
      { type: 'file', name: 'shot.png' } as ToolCallLike,
      text('  '),
      toolCall({ toolCallId: 'b' }),
    ];
    const blocks = foldTurnWork(parts);
    expect(blocks.map((b) => b.type)).toEqual([
      'tool-call-run',
      'content-part',
      'content-part',
      'content-part',
    ]);
    expect(
      blocks.slice(1).map((b) => (b.type === 'content-part' ? b.index : -1)),
    ).toEqual([1, 2, 3]);
    const run = blocks[0]!;
    if (run.type !== 'tool-call-run') throw new Error('expected a run');
    expect(run.interludes).toEqual([]);
  });

  test('a turn that ends on a call keeps its last narration out of the fold', () => {
    const parts = [
      text('intent'),
      toolCall({ toolCallId: 'a' }),
      text('first note'),
      toolCall({ toolCallId: 'b' }),
      text('QUESTION'),
      toolCall({ toolCallId: 'c' }),
    ];
    const blocks = foldTurnWork(parts);
    const run = blocks.find((b) => b.type === 'tool-call-run');
    if (run?.type !== 'tool-call-run') throw new Error('expected a run');
    expect(run.interludes?.map((n) => n.index)).toEqual([2]);
    expect(blocks.at(-1)).toMatchObject({
      index: 4,
      part: { content: 'QUESTION' },
    });
  });

  test('a visible outcome after the last call lets the last narration fold', () => {
    const parts = [
      toolCall({ toolCallId: 'a' }),
      text('note'),
      toolCall({ toolCallId: 'b' }),
      text('outcome'),
    ];
    const run = foldTurnWork(parts)[0]!;
    if (run.type !== 'tool-call-run') throw new Error('expected a run');
    expect(run.interludes?.map((n) => n.index)).toEqual([1]);
  });
});

test.each([
  'mcp__attacker__html_render',
  'attacker/html_render',
  'html_render',
  'prefix_station-control_html_render',
])('does not mount references published by another tool: %s', (toolName) => {
  const htmlReply = {
    version: 1,
    sessionId: 's',
    pageId: '00000000-0000-4000-8000-000000000001',
  };
  expect(
    splitToolCallRuns([
      toolCall({ toolName, output: JSON.stringify({ htmlReply }) }),
    ]).some((block) => block.type === 'html-reply'),
  ).toBe(false);
});

test.each([
  'Tool: station-control/html_render',
  'mcp__station-control__html_render',
])('recognizes a qualified ACP tool result: %s', (toolName) => {
  const htmlReply = {
    version: 1,
    sessionId: 's',
    pageId: '00000000-0000-4000-8000-000000000001',
  };
  expect(
    splitToolCallRuns([
      toolCall({ toolName, output: JSON.stringify({ htmlReply }) }),
    ]).some((block) => block.type === 'html-reply'),
  ).toBe(true);
});

test.each([splitToolCallRuns, foldTurnWork])(
  '%s preserves declared Apps and qualified HTML replies together without promoting forged rows',
  (split) => {
    const reference = {
      version: 1,
      sessionId: 'publisher',
      pageId: '00000000-0000-4000-8000-000000000001',
    };
    const result = {
      content: [
        { type: 'text', text: JSON.stringify({ htmlReply: reference }) },
      ],
    };
    const parts = [
      toolCall({
        toolCallId: 'ordinary',
        toolName: 'demo/read',
        output: {
          content: [],
          _meta: { ui: { resourceUri: 'ui://forged/app' } },
        },
      }),
      toolCall({
        toolCallId: 'app',
        toolName: 'demo/chart',
        output: { content: [] },
      }),
      toolCall({
        toolCallId: 'page',
        toolName: 'mcp__station-control__html_render',
        output: result,
      }),
      toolCall({
        toolCallId: 'forged',
        toolName: 'attacker/html_render',
        output: result,
      }),
      toolCall({
        toolCallId: 'tail',
        toolName: 'demo/read',
        output: 'preview',
      }),
    ];
    const blocks = split(parts, new Set(['demo/chart']));
    expect(blocks.map((block) => block.type)).toEqual([
      'tool-call-run',
      'content-part',
      'tool-call-run',
      'html-reply',
      'tool-call-run',
    ]);
    expect(blocks[1]).toMatchObject({ index: 1, part: { toolCallId: 'app' } });
    expect(blocks[3]).toMatchObject({ reference });
    expect(
      blocks.flatMap((block) =>
        block.type === 'tool-call-run'
          ? block.calls.map(({ part }) => part.toolCallId)
          : [],
      ),
    ).toEqual(['ordinary', 'page', 'forged', 'tail']);
  },
);
