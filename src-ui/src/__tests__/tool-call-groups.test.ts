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
