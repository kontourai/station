import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { K, OP, SPAN } from '../../../../src-shared/monitoring-keys.js';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
import { AcpToolUpdateSupervisor } from '../../../providers/adapters/acp-tool-update-supervisor.js';
import { OrchestrationMonitoringBridge } from '../orchestration-monitoring-bridge.js';

const context = () => ({
  slug: 'codex',
  conversationId: 'conversation-1',
  userId: 'u1',
  model: 'gpt-5',
});
const runtimeEvent = (overrides: Record<string, unknown>) =>
  ({
    eventId: 'event-1',
    provider: 'codex',
    threadId: 'conversation-1',
    turnId: 'turn-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  }) as any;

describe('OrchestrationMonitoringBridge', () => {
  test('projects an external adapter turn, tools, and reported usage exactly once', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, context);

    bridge.onTurnDispatched({
      provider: 'codex',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    bridge.onRuntimeEvent(
      runtimeEvent({
        method: 'tool.started',
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'shell',
        arguments: { command: 'pwd' },
      }),
    );
    bridge.onRuntimeEvent(
      runtimeEvent({
        method: 'tool.completed',
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'shell',
        status: 'success',
        output: '/tmp',
      }),
    );
    bridge.onRuntimeEvent(
      runtimeEvent({
        method: 'token-usage.updated',
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
      }),
    );
    bridge.onRuntimeEvent(
      runtimeEvent({
        method: 'turn.completed',
        outputText: 'done',
        finishReason: 'stop',
      }),
    );
    await emitter.flush();

    expect(
      persisted.map((event) => [event[K.OP_NAME], event[K.SPAN_KIND]]),
    ).toEqual([
      [OP.INVOKE_AGENT, SPAN.START],
      [OP.EXECUTE_TOOL, SPAN.START],
      [OP.EXECUTE_TOOL, SPAN.END],
      [OP.INVOKE_AGENT, SPAN.END],
    ]);
    expect(persisted[0]).toMatchObject({
      [K.AGENT_SLUG]: 'codex',
      [K.TRACE_ID]: 'conversation-1',
    });
    // The engine must be ON the tool events (archive#3074), not only recoverable by
    // joining back to the start span — that join is exactly what does not
    // exist for every producer. This is the live half of the fix and had no
    // coverage: deleting the two `provider`/`model` lines in the bridge left
    // every suite green.
    expect(persisted[1]).toMatchObject({
      [K.TOOL_NAME]: 'shell',
      [K.PROVIDER]: 'codex',
    });
    expect(persisted[2]).toMatchObject({
      [K.TOOL_CALL_OUTCOME]: 'success',
      [K.PROVIDER]: 'codex',
    });
    // External engines get elapsed time too (archive#3077): a duration
    // present on Station-engine rows and silently absent on these would be
    // the same reader-can't-tell asymmetry the batch exists to remove.
    expect(typeof persisted[2]?.[K.TOOL_DURATION_MS]).toBe('number');
    // Monotonic clock on both producers, so a duration is never negative
    // even if the wall clock steps mid-turn.
    expect(persisted[2]?.[K.TOOL_DURATION_MS] as number).toBeGreaterThanOrEqual(
      0,
    );
  });

  test('maps canonical tool completion status to an explicit outcome only when reported', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, context);
    bridge.onTurnDispatched({
      provider: 'codex',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });

    for (const [toolCallId, status] of [
      ['error-tool', 'error'],
      ['success-tool', 'success'],
      ['unknown-tool', undefined],
      // station#1558: an explicitly REPORTED non-outcome. It must not read
      // as `error`, and it must not collapse into the `undefined` bucket
      // that means "the producer told us nothing" — insights counts the two
      // apart.
      ['unresolved-tool', 'unresolved'],
      ['cancelled-tool', 'cancelled'],
    ] as const) {
      bridge.onRuntimeEvent(
        runtimeEvent({
          method: 'tool.completed',
          itemId: toolCallId,
          toolCallId,
          toolName: 'shell',
          status,
        }),
      );
    }
    await emitter.flush();

    const results = persisted.filter(
      (event) => event[K.OP_NAME] === OP.EXECUTE_TOOL,
    );
    expect(results).toHaveLength(5);
    expect(results.map((event) => event[K.TOOL_CALL_OUTCOME])).toEqual([
      'error',
      'success',
      undefined,
      'unresolved',
      // Unchanged: the attribute has no member for a cancellation, so it
      // stays omitted exactly as before.
      undefined,
    ]);
  });

  /**
   * #463: Codex's `token-usage.updated` is a session-to-date total
   * (PROVIDER_USAGE_SCOPE). Stamping the last frame on each turn's end span
   * attributed the whole session to every turn: turn 2 below would carry
   * 250, not its own 150. Nothing here can derive turn 2's own figure
   * reliably, so its usage is absent, never the session total.
   */
  test('never stamps a session-cumulative total on a turn span', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, context);
    for (const [turnId, cumulative] of [
      ['turn-1', 100],
      ['turn-2', 250],
    ] as const) {
      bridge.onTurnDispatched({
        provider: 'codex',
        threadId: 'conversation-1',
        turnId,
        prompt: 'hello',
      });
      bridge.onRuntimeEvent(
        runtimeEvent({
          turnId,
          method: 'token-usage.updated',
          promptTokens: cumulative - 10,
          completionTokens: 10,
          totalTokens: cumulative,
        }),
      );
      bridge.onRuntimeEvent(
        runtimeEvent({ turnId, method: 'turn.completed', outputText: 'ok' }),
      );
    }
    await emitter.flush();

    const ends = persisted.filter(
      (event) =>
        event[K.OP_NAME] === OP.INVOKE_AGENT && event[K.SPAN_KIND] === SPAN.END,
    );
    expect(ends).toHaveLength(2);
    for (const end of ends) {
      expect(end[K.INPUT_TOKENS]).toBeUndefined();
      expect(end[K.OUTPUT_TOKENS]).toBeUndefined();
    }
  });

  test("sums a per-turn provider's own frames onto its turn, and keeps an undeclared one unknown", async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, context);
    bridge.onTurnDispatched({
      provider: 'claude',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    for (const [prompt, completion] of [
      [3, 5],
      [7, 11],
    ] as const) {
      bridge.onRuntimeEvent(
        runtimeEvent({
          provider: 'claude',
          method: 'token-usage.updated',
          promptTokens: prompt,
          completionTokens: completion,
        }),
      );
    }
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'claude',
        method: 'turn.completed',
        outputText: 'ok',
      }),
    );

    bridge.onTurnDispatched({
      provider: 'future-engine',
      threadId: 'conversation-1',
      turnId: 'turn-2',
      prompt: 'hello',
    });
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'future-engine',
        turnId: 'turn-2',
        method: 'token-usage.updated',
        promptTokens: 40,
        completionTokens: 2,
      }),
    );
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'future-engine',
        turnId: 'turn-2',
        method: 'turn.completed',
        outputText: 'ok',
      }),
    );
    await emitter.flush();

    const ends = persisted.filter(
      (event) =>
        event[K.OP_NAME] === OP.INVOKE_AGENT && event[K.SPAN_KIND] === SPAN.END,
    );
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({
      [K.INPUT_TOKENS]: 10,
      [K.OUTPUT_TOKENS]: 16,
    });
    expect(ends[1]?.[K.INPUT_TOKENS]).toBeUndefined();
    expect(ends[1]?.[K.OUTPUT_TOKENS]).toBeUndefined();
  });

  test('closes every open thread turn when an async runtime error has no turn id', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, context);
    bridge.onTurnDispatched({
      provider: 'claude',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'claude',
        method: 'token-usage.updated',
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
      }),
    );
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'claude',
        method: 'runtime.error',
        turnId: undefined,
        message: 'stream failed',
      }),
    );
    // A later terminal proves the entry was deleted, rather than merely ended.
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'claude',
        method: 'turn.completed',
        outputText: 'late',
      }),
    );
    await emitter.flush();
    expect(
      persisted.map((event) => [event[K.OP_NAME], event[K.SPAN_KIND]]),
    ).toEqual([
      [OP.INVOKE_AGENT, SPAN.START],
      [OP.INVOKE_AGENT, SPAN.END],
    ]);
    expect(persisted[1]).toMatchObject({
      'gen_ai.response.finish_reasons': ['stream failed'],
    });
  });

  test('omits the agent slug entirely when the session reported none (#3082)', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, () => ({
      conversationId: 'conversation-1',
    }));
    bridge.onTurnDispatched({
      provider: 'codex',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    await emitter.flush();

    expect(persisted).toHaveLength(1);
    expect(K.AGENT_SLUG in persisted[0]!).toBe(false);
    expect(K.USER_ID in persisted[0]!).toBe(false);
    expect(JSON.stringify(persisted[0])).not.toContain('unknown');
  });

  test('omits duration for a completion whose start was never seen', async () => {
    // The bridge-side analogue of the handler's orphan case: no tool.started
    // means no elapsed time to report, and inventing one would attribute a
    // fabricated latency to a tool nobody timed.
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, () => ({
      slug: 'codex',
      conversationId: 'conversation-1',
      userId: 'u1',
    }));
    bridge.onTurnDispatched({
      provider: 'codex',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    bridge.onRuntimeEvent(
      runtimeEvent({
        method: 'tool.completed',
        toolName: 'shell',
        toolCallId: 'never-started',
        status: 'success',
      }),
    );
    await emitter.flush();

    const result = persisted.find(
      (event) => event[K.TOOL_CALL_ID] === 'never-started',
    );
    expect(result).toBeDefined();
    expect(K.TOOL_DURATION_MS in result!).toBe(false);
  });

  test('records an agent genuinely NAMED unknown, and drops no-session turns', async () => {
    // Renamed and retargeted (archive#3082). This used to be called
    // "observes an agentless configured session as unknown" and pinned the
    // substitution: the service wrote the literal 'unknown' for a session
    // that reported no agent, so this asserted that literal as the contract.
    // An agentless session can no longer produce this context at all — it
    // yields undefined, and the sibling test below asserts the key is
    // absent. What remains worth pinning is the honest case: an agent
    // actually named `unknown` is recorded as such, and must stay
    // distinguishable from an absence.
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const unknownContext = () => ({
      slug: 'unknown',
      conversationId: 'conversation-1',
      userId: 'unknown',
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, unknownContext);
    bridge.onTurnDispatched({
      provider: 'codex',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    bridge.onRuntimeEvent(
      runtimeEvent({ method: 'turn.completed', outputText: 'done' }),
    );
    const noSession = new OrchestrationMonitoringBridge(emitter, () => null);
    expect(() =>
      noSession.onTurnDispatched({
        provider: 'codex',
        threadId: 'missing',
        turnId: 'turn-2',
        prompt: 'ignored',
      }),
    ).not.toThrow();
    await emitter.flush();
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ [K.AGENT_SLUG]: 'unknown' });
  });

  test('excludes station-agent because its relayed chat stream already emits monitoring', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const emitter = new MonitoringEmitter(new EventEmitter(), persist);
    const bridge = new OrchestrationMonitoringBridge(emitter, context);
    bridge.onTurnDispatched({
      provider: 'station-agent',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'station-agent',
        method: 'token-usage.updated',
        promptTokens: 1,
        completionTokens: 2,
      }),
    );
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'station-agent',
        method: 'turn.completed',
        outputText: 'done',
        finishReason: 'stop',
      }),
    );
    await emitter.flush();
    expect(persist).not.toHaveBeenCalled();
  });

  test('records one start span per ACP tool call although the supervisor re-publishes tool.started on metadata updates', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, () => ({
      slug: 'opencode',
      conversationId: 'conversation-1',
      userId: 'u1',
    }));
    bridge.onTurnDispatched({
      provider: 'acp',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    // The real supervisor, wired the way the ACP adapter stamps a call's turn.
    const published: string[] = [];
    const supervisor = new AcpToolUpdateSupervisor(
      {
        provider: 'acp',
        threadId: 'conversation-1',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      (event) => {
        published.push(event.method);
        bridge.onRuntimeEvent({ ...event, turnId: 'turn-1' });
      },
    );
    // OpenCode's shape: a pending call, then updates that fill in its title,
    // kind and input before the terminal update.
    supervisor.acceptStarted({
      toolCallId: 'call-1',
      title: 'bash',
      hasTitle: true,
      rawInput: {},
      hasRawInput: true,
      status: 'pending',
      hasStatus: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call-1',
      kind: 'execute',
      hasKind: true,
      rawInput: { command: 'ls' },
      hasRawInput: true,
      status: 'in_progress',
      hasStatus: true,
    });
    // OpenCode retitles the call with its description.
    supervisor.acceptUpdate({
      toolCallId: 'call-1',
      title: 'List files',
      hasTitle: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call-1',
      rawOutput: { output: 'a b' },
      hasRawOutput: true,
      status: 'completed',
      hasStatus: true,
    });
    supervisor.dispose();
    await emitter.flush();

    // Precondition: the supervisor really did re-publish the start.
    expect(
      published.filter((m) => m === 'tool.started').length,
    ).toBeGreaterThan(1);
    const toolRows = persisted.filter(
      (event) => event[K.OP_NAME] === OP.EXECUTE_TOOL,
    );
    expect(
      toolRows.map((event) => [event[K.SPAN_KIND], event[K.TOOL_CALL_ID]]),
    ).toEqual([
      [SPAN.START, 'call-1'],
      [SPAN.END, 'call-1'],
    ]);
    // The start row is what was known at first sight; the settled input is
    // on the result row, and both rows file the call under one tool name.
    expect(toolRows[0]?.[K.TOOL_NAME]).toBe('bash');
    expect(toolRows[0]?.[K.TOOL_CALL_ARGS]).toEqual({});
    expect(toolRows[1]?.[K.TOOL_NAME]).toBe('bash');
    expect(toolRows[1]?.[K.TOOL_CALL_ARGS]).toEqual({ command: 'ls' });
    expect(toolRows[1]?.[K.TOOL_CALL_RESULT]).toEqual({ output: 'a b' });
    expect(typeof toolRows[1]?.[K.TOOL_DURATION_MS]).toBe('number');
  });

  test('an ACP call first reported without a name or with settled input', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, () => ({
      slug: 'opencode',
      conversationId: 'conversation-1',
      userId: 'u1',
    }));
    bridge.onTurnDispatched({
      provider: 'acp',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    const supervisor = new AcpToolUpdateSupervisor(
      {
        provider: 'acp',
        threadId: 'conversation-1',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      (event) => bridge.onRuntimeEvent({ ...event, turnId: 'turn-1' }),
    );
    // No name at first sight: the supervisor labels the call with its id.
    supervisor.acceptStarted({ toolCallId: 'call-2' });
    supervisor.acceptUpdate({
      toolCallId: 'call-2',
      title: 'read',
      hasTitle: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call-2',
      status: 'completed',
      hasStatus: true,
    });
    // Input known from the start and re-sent unchanged on a retitle.
    supervisor.acceptStarted({
      toolCallId: 'call-3',
      title: 'grep',
      hasTitle: true,
      rawInput: { pattern: 'x' },
      hasRawInput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call-3',
      title: 'Search for x',
      hasTitle: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call-3',
      status: 'completed',
      hasStatus: true,
    });
    supervisor.dispose();
    await emitter.flush();

    const rows = persisted
      .filter((event) => event[K.OP_NAME] === OP.EXECUTE_TOOL)
      .map((event) => ({
        kind: event[K.SPAN_KIND],
        id: event[K.TOOL_CALL_ID],
        name: event[K.TOOL_NAME],
        hasArgs: K.TOOL_CALL_ARGS in event,
      }));
    expect(rows).toEqual([
      { kind: SPAN.START, id: 'call-2', name: 'call-2', hasArgs: true },
      { kind: SPAN.END, id: 'call-2', name: 'read', hasArgs: false },
      { kind: SPAN.START, id: 'call-3', name: 'grep', hasArgs: true },
      { kind: SPAN.END, id: 'call-3', name: 'grep', hasArgs: false },
    ]);
  });

  test('a completed call id that is reused starts a new span', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, context);
    bridge.onTurnDispatched({
      provider: 'codex',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    for (let round = 0; round < 2; round++) {
      bridge.onRuntimeEvent(
        runtimeEvent({
          method: 'tool.started',
          itemId: 'tool-1',
          toolCallId: 'tool-1',
          toolName: 'shell',
        }),
      );
      bridge.onRuntimeEvent(
        runtimeEvent({
          method: 'tool.completed',
          itemId: 'tool-1',
          toolCallId: 'tool-1',
          toolName: 'shell',
          status: 'success',
        }),
      );
    }
    await emitter.flush();
    expect(
      persisted
        .filter((event) => event[K.OP_NAME] === OP.EXECUTE_TOOL)
        .map((event) => event[K.SPAN_KIND]),
    ).toEqual([SPAN.START, SPAN.END, SPAN.START, SPAN.END]);
  });

  test('a re-published start with a task descriptor keeps the call input', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, context);
    bridge.onTurnDispatched({
      provider: 'claude',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    // Claude's tool_use carries the Agent call's real input; its later
    // task_started re-publishes the same call id with a task descriptor.
    const input = { subagent_type: 'general-purpose', prompt: 'do it' };
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'claude',
        method: 'tool.started',
        itemId: 'task-1',
        toolCallId: 'task-1',
        toolName: 'Agent',
        arguments: input,
      }),
    );
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'claude',
        method: 'tool.started',
        itemId: 'task-1',
        toolCallId: 'task-1',
        toolName: 'Task (general-purpose)',
        arguments: {
          description: 'd',
          task_type: 'local_agent',
          prompt: 'do it',
        },
      }),
    );
    bridge.onRuntimeEvent(
      runtimeEvent({
        provider: 'claude',
        method: 'tool.completed',
        itemId: 'task-1',
        toolCallId: 'task-1',
        toolName: 'Agent',
        status: 'success',
      }),
    );
    await emitter.flush();
    const rows = persisted.filter(
      (event) => event[K.OP_NAME] === OP.EXECUTE_TOOL,
    );
    expect(rows.map((event) => event[K.SPAN_KIND])).toEqual([
      SPAN.START,
      SPAN.END,
    ]);
    expect(rows[0]![K.TOOL_CALL_ARGS]).toEqual(input);
    expect(K.TOOL_CALL_ARGS in rows[1]!).toBe(false);
  });

  test('an ACP input backfilled after a partial start reaches the result span', async () => {
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), async (event) => {
      persisted.push(event);
    });
    const bridge = new OrchestrationMonitoringBridge(emitter, () => ({
      slug: 'grok',
      conversationId: 'conversation-1',
      userId: 'u1',
    }));
    bridge.onTurnDispatched({
      provider: 'acp',
      threadId: 'conversation-1',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    const supervisor = new AcpToolUpdateSupervisor(
      {
        provider: 'acp',
        threadId: 'conversation-1',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      (event) => bridge.onRuntimeEvent({ ...event, turnId: 'turn-1' }),
    );
    // Grok's tool_call carries a partial input; an update backfills fields.
    supervisor.acceptStarted({
      toolCallId: 'call-4',
      title: 'bash',
      hasTitle: true,
      rawInput: { command: 'ls' },
      hasRawInput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call-4',
      rawInput: { command: 'ls', description: 'list' },
      hasRawInput: true,
    });
    supervisor.acceptUpdate({
      toolCallId: 'call-4',
      status: 'completed',
      hasStatus: true,
    });
    supervisor.dispose();
    await emitter.flush();
    const rows = persisted.filter(
      (event) => event[K.OP_NAME] === OP.EXECUTE_TOOL,
    );
    expect(rows.map((event) => event[K.SPAN_KIND])).toEqual([
      SPAN.START,
      SPAN.END,
    ]);
    expect(rows[0]![K.TOOL_CALL_ARGS]).toEqual({ command: 'ls' });
    expect(rows[1]![K.TOOL_CALL_ARGS]).toEqual({
      command: 'ls',
      description: 'list',
    });
  });
});
