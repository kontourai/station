import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { describe, expect, test } from 'vitest';
import {
  classifyToolName,
  groupToolCallParts,
  isToolCallPart,
  type ToolCallGroup,
  type ToolCallLike,
} from '../components/chat/tool-call-groups';

function toolCall(overrides: Partial<ToolCallLike> = {}): ToolCallLike {
  return {
    type: 'tool-invocation',
    toolCallId: 'call-1',
    toolName: 'Read',
    args: { file_path: '/repo/src/App.tsx' },
    state: 'completed',
    ...overrides,
  };
}

function textPart(content: string): ToolCallLike {
  return { type: 'text', content } as ToolCallLike;
}

describe('isToolCallPart', () => {
  test('matches the flat tool-invocation type', () => {
    expect(isToolCallPart({ type: 'tool-invocation' })).toBe(true);
  });

  test('matches persisted tool-<name> variants', () => {
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

describe('classifyToolName', () => {
  test('classifies known Claude Code tool names', () => {
    expect(classifyToolName('Read')).toBe('read');
    expect(classifyToolName('Write')).toBe('write');
    expect(classifyToolName('Edit')).toBe('write');
    expect(classifyToolName('Bash')).toBe('exec');
    expect(classifyToolName('Grep')).toBe('search');
    expect(classifyToolName('Glob')).toBe('search');
  });

  test('classifies Codex-style tool names', () => {
    expect(classifyToolName('shell_exec')).toBe('exec');
    expect(classifyToolName('apply_patch')).toBe('write');
  });

  test('classifies on the tool half of a server/tool MCP name', () => {
    expect(classifyToolName('jira/create_issue')).toBe('other');
    expect(classifyToolName('fs/read_file')).toBe('read');
  });

  test('falls back to other for unrecognized and empty names', () => {
    expect(classifyToolName('create_issue')).toBe('other');
    expect(classifyToolName(undefined)).toBe('other');
    expect(classifyToolName('')).toBe('other');
    expect(classifyToolName('   ')).toBe('other');
  });
});

describe('groupToolCallParts', () => {
  test('returns an empty array for undefined/empty input', () => {
    expect(groupToolCallParts(undefined)).toEqual([]);
    expect(groupToolCallParts(null)).toEqual([]);
    expect(groupToolCallParts([])).toEqual([]);
  });

  test('groups consecutive tool calls into a single batch', () => {
    const parts = [
      toolCall({ toolCallId: 'a', toolName: 'Read' }),
      toolCall({ toolCallId: 'b', toolName: 'Bash' }),
      toolCall({ toolCallId: 'c', toolName: 'Bash' }),
    ];
    const blocks = groupToolCallParts(parts);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool-call-group');
    const group = blocks[0] as ToolCallGroup;
    expect(group.calls).toHaveLength(3);
    expect(group.calls.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  test('does NOT merge tool calls separated by prose', () => {
    const parts = [
      toolCall({ toolCallId: 'a', toolName: 'Read' }),
      textPart('Now let me run the tests.'),
      toolCall({ toolCallId: 'b', toolName: 'Bash' }),
    ];
    const blocks = groupToolCallParts(parts);
    expect(blocks.map((b) => b.type)).toEqual([
      'tool-call-group',
      'content-part',
      'tool-call-group',
    ]);
    expect((blocks[0] as ToolCallGroup).calls).toHaveLength(1);
    expect((blocks[2] as ToolCallGroup).calls).toHaveLength(1);
  });

  test('passes non-tool parts through unchanged, preserving order and index', () => {
    const parts = [
      textPart('intro'),
      toolCall({ toolCallId: 'a' }),
      { type: 'reasoning', content: 'thinking' } as ToolCallLike,
    ];
    const blocks = groupToolCallParts(parts);
    expect(blocks[0]).toEqual({
      type: 'content-part',
      index: 0,
      part: parts[0],
    });
    expect(blocks[1].type).toBe('tool-call-group');
    expect(blocks[2]).toEqual({
      type: 'content-part',
      index: 2,
      part: parts[2],
    });
  });

  test('mixed kinds summarize as "Read 2 files, ran 2 commands"', () => {
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Read',
        args: { file_path: 'b.ts' },
      }),
      toolCall({
        toolCallId: 'c',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
      toolCall({
        toolCallId: 'd',
        toolName: 'Bash',
        args: { command: 'npm build' },
      }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.summary).toBe('Read 2 files, ran 2 commands');
  });

  test('single-kind batch summarizes as "Ran 3 commands"', () => {
    const parts = [
      toolCall({ toolCallId: 'a', toolName: 'Bash', args: { command: 'a' } }),
      toolCall({ toolCallId: 'b', toolName: 'Bash', args: { command: 'b' } }),
      toolCall({
        toolCallId: 'c',
        toolName: 'shell_exec',
        args: { command: 'c' },
      }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.summary).toBe('Ran 3 commands');
  });

  test('singular vs plural nouns within one summary', () => {
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
      }),
      toolCall({ toolCallId: 'b', toolName: 'Bash', args: { command: 'a' } }),
      toolCall({ toolCallId: 'c', toolName: 'Bash', args: { command: 'b' } }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.summary).toBe('Read 1 file, ran 2 commands');
  });

  test('a single call still groups sanely, labeled by its own target', () => {
    const parts = [
      toolCall({
        toolCallId: 'solo',
        toolName: 'Read',
        args: { file_path: 'src/ApprovalModeChip.tsx' },
      }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.calls).toHaveLength(1);
    expect(group.summary).toBe('Read ApprovalModeChip.tsx');
    expect(group.inProgress).toBe(false);
  });

  test('reflects in-progress state with a progressive verb and ellipsis', () => {
    const parts = [
      toolCall({ toolCallId: 'a', toolName: 'Read', state: 'completed' }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm test' },
        state: 'running',
      }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.inProgress).toBe(true);
    expect(group.summary).toBe('Reading 1 file, running 1 command…');
  });

  test('a solo in-progress call gets a progressive label and trailing ellipsis', () => {
    const parts = [
      toolCall({
        toolCallId: 'solo',
        toolName: 'Bash',
        args: { command: 'npm run build' },
        state: 'running',
      }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.summary).toBe('Running npm run build…');
  });

  // station#1558 (fix round, M6): the collapsed header is what a reader sees
  // first, and it used to say "Ran npm test" for a call whose session ended
  // before it reported — contradicting the row it expands into, which
  // `ToolCallDisplay` already refuses to put in the past tense.
  test('a solo unresolved call keeps the bare verb, not the past tense', () => {
    const parts = [
      toolCall({
        toolCallId: 'solo',
        toolName: 'Bash',
        args: { command: 'npm test' },
        state: 'unresolved',
      }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.summary).toBe('Run npm test');
    // Not running either: no ellipsis, no failure claim.
    expect(group.inProgress).toBe(false);
    expect(group.failedCount).toBe(0);
  });

  // station#1569 (item 3): the same defect one level up. The BATCH header
  // derived its verb from `inProgress` alone, so a run containing an
  // unresolved call still read "Ran 2 commands" — past tense for work that
  // may never have happened, contradicting the very rows it expands into.
  describe('a batch containing an unresolved call (station#1569 item 3)', () => {
    const unresolvedBatch = (extra: Partial<ToolCallLike> = {}) => [
      toolCall({
        toolCallId: 'a',
        toolName: 'Bash',
        args: { command: 'npm test' },
        state: 'completed',
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm run build' },
        state: 'unresolved',
        ...extra,
      }),
    ];

    test('takes the bare verb, never the past tense', () => {
      const [group] = groupToolCallParts(unresolvedBatch()) as ToolCallGroup[];
      expect(group.summary).toBe('Run 2 commands');
      expect(group.unresolvedCount).toBe(1);
      // Not a failure claim either: nothing observed the tool fail.
      expect(group.failedCount).toBe(0);
    });

    test('counts every unresolved call in the run', () => {
      const [group] = groupToolCallParts([
        toolCall({ toolCallId: 'a', toolName: 'Bash', state: 'unresolved' }),
        toolCall({ toolCallId: 'b', toolName: 'Read', state: 'unresolved' }),
        toolCall({ toolCallId: 'c', toolName: 'Read', state: 'completed' }),
      ]) as ToolCallGroup[];
      expect(group.unresolvedCount).toBe(2);
      expect(group.calls.map((call) => call.unresolved)).toEqual([
        true,
        true,
        false,
      ]);
    });

    test('does not claim flight either when a sibling call is still running', () => {
      const [group] = groupToolCallParts([
        toolCall({ toolCallId: 'a', toolName: 'Bash', state: 'running' }),
        toolCall({ toolCallId: 'b', toolName: 'Bash', state: 'unresolved' }),
      ]) as ToolCallGroup[];
      // "Running 2 commands…" would be as false for the unresolved call as
      // "Ran" was; the bare verb is the only form true of both, and the
      // ellipsis (which means "still going") is dropped with it.
      expect(group.summary).toBe('Run 2 commands');
      expect(group.inProgress).toBe(true);
      expect(group.unresolvedCount).toBe(1);
    });

    test('leaves an ordinary finished batch in the past tense', () => {
      // The discriminating control: the bare verb is conditional on an
      // unresolved call being present, not the new default.
      const [group] = groupToolCallParts([
        toolCall({ toolCallId: 'a', toolName: 'Bash', state: 'completed' }),
        toolCall({ toolCallId: 'b', toolName: 'Bash', state: 'completed' }),
      ]) as ToolCallGroup[];
      expect(group.summary).toBe('Ran 2 commands');
      expect(group.unresolvedCount).toBe(0);
    });

    /**
     * station#1569 (H1): the composition the reviewer caught. The header
     * counts what the FOLD produced, so a fold that left the stale
     * `unresolved` row standing beside the real result made this read
     * "Run 2 commands · 1 with no result" for one call that succeeded.
     * Driven through the real projection rather than a hand-written part —
     * a literal `state: 'completed'` would only assert the classifier's own
     * `===`, and could not have caught this.
     */
    test('does not count a row the real result superseded', () => {
      const base = {
        provider: 'claude',
        threadId: 't1',
        createdAt: '2026-09-05T00:00:00.000Z',
      };
      const messages = projectRuntimeEventsToMessages([
        { ...base, eventId: 'e1', method: 'turn.started', turnId: 'turn-a' },
        {
          ...base,
          eventId: 'e2',
          method: 'tool.started',
          turnId: 'turn-a',
          itemId: 'i1',
          toolCallId: 'call-1',
          toolName: 'Bash',
          arguments: { command: 'npm test' },
        },
        {
          ...base,
          eventId: 'e3',
          method: 'tool.completed',
          turnId: 'turn-a',
          itemId: 'i1',
          toolCallId: 'call-1',
          toolName: 'Bash',
          status: 'unresolved',
          output:
            'No result was reported before the session ended; whether the tool ran is unknown.',
        },
        {
          ...base,
          eventId: 'e4',
          method: 'tool.completed',
          turnId: 'turn-a',
          itemId: 'i1',
          toolCallId: 'call-1',
          toolName: 'Bash',
          status: 'success',
          output: 'real output',
        },
        {
          ...base,
          eventId: 'e5',
          method: 'turn.completed',
          turnId: 'turn-a',
          finishReason: 'stop',
        },
      ] as never);

      const assistant = messages.find(
        (message) => message.role === 'assistant',
      )!;
      const [group] = groupToolCallParts(
        assistant.parts as unknown as ToolCallLike[],
      ) as ToolCallGroup[];
      expect(group.unresolvedCount).toBe(0);
      expect(group.summary).toBe('Ran npm test');
    });

    test('a mixed-kind batch takes the bare verb in every segment', () => {
      const [group] = groupToolCallParts([
        toolCall({
          toolCallId: 'a',
          toolName: 'Read',
          args: { file_path: '/repo/a.ts' },
          state: 'completed',
        }),
        toolCall({
          toolCallId: 'b',
          toolName: 'Read',
          args: { file_path: '/repo/b.ts' },
          state: 'completed',
        }),
        toolCall({
          toolCallId: 'c',
          toolName: 'Bash',
          args: { command: 'npm test' },
          state: 'unresolved',
        }),
      ]) as ToolCallGroup[];
      expect(group.summary).toBe('Read 2 files, run 1 command');
    });
  });

  test('extracts a truncated command label for exec calls', () => {
    const longCommand = 'a'.repeat(120);
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Bash',
        args: { command: longCommand },
      }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.summary.startsWith('Ran ')).toBe(true);
    expect(group.summary.length).toBeLessThan(longCommand.length);
    expect(group.summary.endsWith('…')).toBe(true);
  });

  test('falls back to the formatted tool name when no target is extractable', () => {
    const parts = [
      toolCall({ toolCallId: 'a', toolName: 'search_files', args: undefined }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.summary).toBe('Searched search files');
  });

  test('group key is stable and derived from the first call id', () => {
    const parts = [
      toolCall({ toolCallId: 'first-id' }),
      toolCall({ toolCallId: 'second-id' }),
    ];
    const [group] = groupToolCallParts(parts) as ToolCallGroup[];
    expect(group.key).toBe('tool-call-run:first-id');
  });
});
