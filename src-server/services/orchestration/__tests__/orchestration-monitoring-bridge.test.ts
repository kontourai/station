import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { K, OP, SPAN } from '../../../../src-shared/monitoring-keys.js';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
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

  test('carries no lifetime-analytics ingress at all (station#3245)', () => {
    // This bridge used to be a SECOND fold of the same events into
    // `analytics/stats.json`, and a wrong one — it kept the last
    // `token-usage.updated` frame per turn believing every engine reports
    // cumulatively, which re-added Codex's whole running total once per turn,
    // and it published cost as `0` because it had none to give. The one
    // derivation is now `foldUsageEvents`, reached by `UsageAggregator`
    // through `OrchestrationService.listSessionUsage`.
    //
    // Asserted structurally, not by a "was not called" spy: the constructor
    // takes no analytics collaborator, so no call site can reintroduce one
    // without failing to compile. A dropped-argument regression would leave
    // this test passing but the arity assertion below red.
    expect(OrchestrationMonitoringBridge.length).toBe(2);
    const bridge = new OrchestrationMonitoringBridge(undefined, context);
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
    // Completing the turn must not throw now that the ingress is gone, and
    // must still clear the turn entry (a later terminal emits nothing).
    expect(() =>
      bridge.onRuntimeEvent(
        runtimeEvent({
          provider: 'claude',
          method: 'turn.completed',
          outputText: 'done',
          finishReason: 'stop',
        }),
      ),
    ).not.toThrow();
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
});
