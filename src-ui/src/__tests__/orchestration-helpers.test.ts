import { describe, expect, test } from 'vitest';
import type { ChatContentPart } from '../contexts/active-chats-state';
import {
  buildAssistantTurnContent,
  upsertTextPart,
  upsertToolPart,
} from '../hooks/orchestration/messageParts';

describe('orchestration helpers', () => {
  test('upsertTextPart appends without mutating the original array', () => {
    const parts: ChatContentPart[] = [{ type: 'text', content: 'Hello' }];

    const next = upsertTextPart(parts, 'text', ' world');

    expect(next).toEqual([{ type: 'text', content: 'Hello world' }]);
    expect(parts).toEqual([{ type: 'text', content: 'Hello' }]);
  });

  // archive#3690: text streamed AFTER a tool call must not be folded back into
  // the text part that preceded it. Appending to the first same-type part
  // rewrites the turn's reading order — and only on the live path, so the same
  // turn reordered itself on reload once durable replay rebuilt it correctly.
  test('upsertTextPart starts a new segment when a tool part is the tail', () => {
    const beforeTool = upsertTextPart(undefined, 'text', 'Before');
    const withTool = upsertToolPart(beforeTool, 'tool-1', {
      toolName: 'run_command',
      state: 'running',
    });

    const afterTool = upsertTextPart(withTool, 'text', 'After');

    expect(afterTool.map((part) => part.type)).toEqual([
      'text',
      'tool-invocation',
      'text',
    ]);
    expect(afterTool[0].content).toBe('Before');
    expect(afterTool[2].content).toBe('After');
  });

  // The same divergence for reasoning, which streams through the identical
  // helper and interleaves with tool calls the same way.
  test('upsertTextPart keeps reasoning after a tool call in reading order', () => {
    const parts = upsertToolPart(
      upsertTextPart(undefined, 'reasoning', 'Thinking first'),
      'tool-2',
      { toolName: 'read_file', state: 'running' },
    );

    const next = upsertTextPart(parts, 'reasoning', 'Thinking again');

    expect(next.map((part) => part.type)).toEqual([
      'reasoning',
      'tool-invocation',
      'reasoning',
    ]);
    expect(next[0].content).toBe('Thinking first');
    expect(next[2].content).toBe('Thinking again');
  });

  // Consecutive deltas with nothing between them still coalesce — segmenting
  // is driven by what the tail IS, not by how many deltas arrive.
  test('upsertTextPart still coalesces consecutive deltas into one part', () => {
    const next = upsertTextPart(
      upsertTextPart(upsertTextPart(undefined, 'text', 'a'), 'text', 'b'),
      'text',
      'c',
    );

    expect(next).toEqual([{ type: 'text', content: 'abc' }]);
  });

  test('upsertToolPart creates and updates the matching tool part', () => {
    const created = upsertToolPart(undefined, 'tool-1', {
      toolName: 'Search',
      args: { query: 'alpha' },
      state: 'running',
    });

    expect(created).toEqual([
      {
        type: 'tool-invocation',
        toolCallId: 'tool-1',
        toolName: 'Search',
        args: { query: 'alpha' },
        state: 'running',
      },
    ]);

    const updated = upsertToolPart(created, 'tool-1', {
      state: 'completed',
      result: { ok: true },
    });

    expect(updated).toEqual([
      {
        type: 'tool-invocation',
        toolCallId: 'tool-1',
        toolName: 'Search',
        args: { query: 'alpha' },
        state: 'completed',
        result: { ok: true },
      },
    ]);
  });

  test('buildAssistantTurnContent prefers explicit content, then parts, then fallback text', () => {
    expect(
      buildAssistantTurnContent(
        {
          role: 'assistant',
          content: 'Direct content',
          contentParts: [{ type: 'text', content: 'ignored' }],
        },
        'fallback',
      ),
    ).toBe('Direct content');

    expect(
      buildAssistantTurnContent(
        {
          role: 'assistant',
          content: '',
          contentParts: [
            { type: 'text', content: 'First line' },
            { type: 'reasoning', content: 'Second line' },
          ],
        },
        'fallback',
      ),
    ).toBe('First line\nSecond line');

    expect(
      buildAssistantTurnContent(
        {
          role: 'assistant',
          content: '',
          contentParts: [],
        },
        'fallback',
      ),
    ).toBe('fallback');
  });
});
