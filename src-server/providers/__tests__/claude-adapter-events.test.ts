import type {
  PermissionUpdate,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import { describe, expect, test, vi } from 'vitest';
import { getConversationStats } from '../../runtime/conversation/conversation-manager.js';
import type { SessionAnswerabilityObservation } from '../../services/orchestration/open-requests.js';
import { buildAgentRunSummary } from '../../services/orchestration/orchestration-session-state.js';
import { projectSessionLifecycle } from '../../services/orchestration/session-lifecycle-service.js';
import {
  CLAUDE_EXTENSION_NAMESPACE,
  CLAUDE_UNRESOLVED_TOOL_OUTPUT,
  type ClaudeMessageState,
  claudeToolResultOutputReceipt,
  mapClaudeDecisionToPermissionResult,
  mapClaudeSdkMessage,
  mapClaudeSessionState,
  mapClaudeTaskStatus,
  settleUnresolvedClaudeToolCalls,
  summarizeClaudeToolResult,
} from '../adapters/claude-adapter-events.js';
import {
  recordClaudeTurnDispatched,
  recordClaudeTurnStopRequested,
} from '../adapters/claude-sdk-turns.js';
import {
  CLAUDE_BASH_DEFERRED_RESULT,
  CLAUDE_BASH_END_TURN_RESULT,
  CLAUDE_BASH_FINAL_TEXT_ASSISTANT,
  CLAUDE_BASH_TEXT_ASSISTANT,
  CLAUDE_BASH_TOOL_RESULT_USER,
  CLAUDE_BASH_TOOL_USE_ASSISTANT,
} from './claude-adapter-tool-cycle-fixtures.js';

const ANSWERABILITY: SessionAnswerabilityObservation = {
  threadAttachment: 'detached',
  providerRegistered: true,
  observedBy: 'claude-adapter-events-test',
  observedAt: '2026-08-10T00:00:00.000Z',
};

/**
 * A record whose SDK holds `dispatched` in order (the first running), each
 * listed in `stopped` marked the way `interruptTurn` marks it — built through
 * the ledger's own entry points, never by writing its fields.
 */
function makeRecord(
  overrides?: Partial<ClaudeMessageState>,
  turns: { dispatched?: string[]; stopped?: string[] } = {
    dispatched: ['turn-1'],
  },
): ClaudeMessageState {
  const record: ClaudeMessageState = {
    session: {
      provider: 'claude' as const,
      threadId: 'thread-activity',
      status: 'running' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    lastSessionState: 'running' as const,
    ...overrides,
  };
  return withClaudeTurns(record, turns);
}

function withClaudeTurns<T extends ClaudeMessageState>(
  record: T,
  turns: { dispatched?: string[]; stopped?: string[] },
): T {
  for (const turnId of turns.dispatched ?? []) {
    recordClaudeTurnDispatched(record, turnId);
    if (turns.stopped?.includes(turnId)) {
      recordClaudeTurnStopRequested(record, turnId);
    }
  }
  return record;
}

describe('claude-adapter-events', () => {
  test('captures the SDK init cursor and configuration on the Station child', () => {
    const publish = vi.fn();
    const record = {
      session: {
        provider: 'claude' as const,
        threadId: 'station-child',
        status: 'connecting' as const,
        resumeCursor: 'forked-child',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      lastSessionState: 'idle' as const,
    };

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'init',
        session_id: 'forked-child',
        cwd: '/workspace/project',
        model: 'claude-sonnet-4-6',
        uuid: 'init-1',
      } as any,
    });

    expect(record.session).toMatchObject({
      resumeCursor: 'forked-child',
      cwd: '/workspace/project',
      model: 'claude-sonnet-4-6',
      status: 'ready',
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.configured',
        threadId: 'station-child',
        cwd: '/workspace/project',
      }),
    );
  });

  test('maps session state changes into canonical lifecycle events', () => {
    const publish = vi.fn();
    const record = {
      session: {
        provider: 'claude' as const,
        threadId: 'thread-1',
        status: 'connecting' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      lastSessionState: 'idle' as const,
    };

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'requires_action',
        uuid: 'msg-1',
        session_id: 'thread-1',
      } as any,
    });

    expect(record.lastSessionState).toBe('requires_action');
    expect(record.session.status).toBe('ready');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.state-changed',
        from: 'idle',
        to: 'awaiting-approval',
      }),
    );
  });

  test('maps streaming and result messages into canonical events', () => {
    const publish = vi.fn();
    const record = {
      session: {
        provider: 'claude' as const,
        threadId: 'thread-2',
        status: 'running' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      lastSessionState: 'running' as const,
    } as ClaudeMessageState;
    withClaudeTurns(record, { dispatched: ['turn-1'] });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'plan' },
        },
        uuid: 'msg-2',
        session_id: 'thread-2',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        is_error: false,
        result: 'done',
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
        uuid: 'msg-3',
        session_id: 'thread-2',
      } as any,
    });

    expect(publish.mock.calls.map(([event]) => event.method)).toEqual([
      'content.reasoning-delta',
      'token-usage.updated',
      'turn.completed',
    ]);
    expect(publish.mock.calls[2][0]).toMatchObject({
      method: 'turn.completed',
      finishReason: 'tool-calls',
      outputText: 'done',
    });
  });

  test('drops a resume-style result with no local turn while retaining usage and a tripwire', () => {
    const publish = vi.fn();
    const logInfo = vi.fn();
    const record = {
      session: {
        provider: 'claude' as const,
        threadId: 'thread-resume',
        status: 'ready' as const,
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
      },
      lastSessionState: 'idle' as const,
    };

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      logInfo,
      message: {
        type: 'result',
        is_error: false,
        result: '',
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
        uuid: 'resume-result',
        session_id: 'thread-resume',
      } as any,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'token-usage.updated',
        promptTokens: 3,
        completionTokens: 0,
      }),
    );
    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'turn.completed' }),
    );
    expect(logInfo).toHaveBeenCalledWith(
      'Dropped Claude result without a dispatched local turn',
      expect.objectContaining({
        threadId: 'thread-resume',
        resultKind: 'non-dispatched-terminal',
      }),
    );
  });

  test('drops an after-turn-started handshake with an inherited active id before every completion consumer', () => {
    const publish = vi.fn();
    const logInfo = vi.fn();
    const record = makeRecord(undefined, { dispatched: ['turn-real'] });
    const started = {
      eventId: 'turn-started',
      provider: 'claude' as const,
      threadId: record.session.threadId,
      createdAt: '2026-08-10T00:00:00.000Z',
      method: 'turn.started' as const,
      turnId: 'turn-real',
    };

    // This is the production race: a local turn is already running, then
    // Claude's resume/init result inherits that in-memory ID.
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      logInfo,
      message: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 0,
        result: '',
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
        uuid: 'resume-after-start',
        session_id: record.session.threadId,
      } as any,
    });

    const mapped = publish.mock.calls.map(([event]) => event);
    expect(mapped.map((event) => event.method)).toEqual([
      'token-usage.updated',
    ]);
    expect(record.activeTurnId).toBe('turn-real');
    expect(record.sdkTurns?.running).toMatchObject({ turnId: 'turn-real' });
    expect(logInfo).toHaveBeenCalledWith(
      'Dropped Claude handshake result before lifecycle mapping',
      expect.objectContaining({
        inheritedActiveTurnId: 'turn-real',
        numTurns: 0,
      }),
    );

    // No canonical completion leaves this mapper, so it cannot be persisted,
    // published/receipted, or folded into the independent agent-run view.
    const events = [started, ...mapped] as any[];
    expect(
      projectSessionLifecycle({ session: record.session, events }),
    ).toMatchObject({ lifecycleState: 'running' });
    expect(
      buildAgentRunSummary({
        persisted: record.session,
        events,
        answerability: ANSWERABILITY,
      }).status,
    ).toBe('running');
    expect(events.some((event) => event.method === 'turn.completed')).toBe(
      false,
    );
  });

  test('clears dispatch provenance after a genuine completion so a later handshake cannot inherit a stale id', () => {
    const publish = vi.fn();
    const record = makeRecord(undefined, { dispatched: ['turn-a'] });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        result: 'done',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: 'a-complete',
        session_id: record.session.threadId,
      } as any,
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'turn.completed', turnId: 'turn-a' }),
    );
    expect(record.activeTurnId).toBeUndefined();
    expect(record.sdkTurns?.running).toBeUndefined();
    expect(record.sdkTurns?.queued).toEqual([]);

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 0,
        result: '',
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
        uuid: 'late-resume',
        session_id: record.session.threadId,
      } as any,
    });
    expect(
      publish.mock.calls.filter(([event]) => event.method === 'turn.completed'),
    ).toHaveLength(1);
  });

  test('maps requires_action to awaiting-approval', () => {
    expect(mapClaudeSessionState('requires_action')).toBe('awaiting-approval');
    expect(mapClaudeSessionState('running')).toBe('running');
  });

  /**
   * archive#1827. A `result` message's `is_error: true` is the SDK's own
   * structured protocol flag (see `classifyClaudeResultOutcome`'s doc
   * comment) — this must publish a terminal `runtime.error`, never fold the
   * engine's raw error text into `turn.completed` as if it were an ordinary
   * assistant reply (the exact defect this ticket fixes).
   */
  test('a cursor-matched missing-session result publishes a binding-dead runtime.error instead of turn.completed, and sets terminalResultObserved', () => {
    const publish = vi.fn();
    const record = {
      session: {
        provider: 'claude' as const,
        threadId: 'thread-dead',
        status: 'running' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      attemptedResumeCursor: 'd434e194-cc2e-4edc-8733-d8645c512fab',
      lastSessionState: 'running' as const,
    } as ClaudeMessageState;
    withClaudeTurns(record, { dispatched: ['turn-dead'] });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result:
          'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab',
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
        uuid: 'msg-dead',
        session_id: 'thread-dead',
      } as any,
    });

    expect(publish.mock.calls.map(([event]) => event.method)).toEqual([
      'token-usage.updated',
      'runtime.error',
    ]);
    expect(publish.mock.calls[1][0]).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      code: 'engine-session-binding-dead',
      retriable: false,
      message:
        'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab',
      turnId: 'turn-dead',
    });
    expect(
      publish.mock.calls.some(([event]) => event.method === 'turn.completed'),
    ).toBe(false);
    expect((record as any).terminalResultObserved).toBe('binding-dead');
  });

  test("a requested interruption consumes Claude's null-stop-reason error result without replacing Stopped with Failed (#898)", () => {
    const publish = vi.fn();
    const logInfo = vi.fn();
    const record = makeRecord(undefined, {
      dispatched: ['turn-stopped'],
      stopped: ['turn-stopped'],
    });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      logInfo,
      message: {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'generic-error: stop_reason=null',
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
        uuid: 'msg-stopped',
        session_id: record.session.threadId,
      } as any,
    });

    expect(publish.mock.calls.map(([event]) => event.method)).toEqual([
      'token-usage.updated',
    ]);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'token-usage.updated',
        turnId: 'turn-stopped',
      }),
    );
    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'runtime.error' }),
    );
    expect(record).toMatchObject({
      activeTurnId: undefined,
      interruptedResultObserved: true,
    });
    expect(record.sdkTurns?.running).toBeUndefined();
    expect(
      (record as ClaudeMessageState).terminalResultObserved,
    ).toBeUndefined();
    expect(logInfo).toHaveBeenCalledWith(
      'Dropped Claude error result for requested interruption',
      expect.objectContaining({
        threadId: record.session.threadId,
        turnId: 'turn-stopped',
      }),
    );
  });

  test("a stopped turn's delayed error result does not clear a newer dispatched turn (#921)", () => {
    const publish = vi.fn();
    // Stop was requested for the running turn, and a newer send queued
    // behind it before its delayed error result arrived.
    const record = makeRecord(undefined, {
      dispatched: ['turn-stopped', 'turn-new'],
      stopped: ['turn-stopped'],
    });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'interrupted',
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
        uuid: 'msg-delayed-stop',
        session_id: record.session.threadId,
      } as any,
    });

    expect(publish.mock.calls.map(([event]) => event.method)).toEqual([
      'token-usage.updated',
    ]);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'token-usage.updated',
        turnId: 'turn-stopped',
      }),
    );
    expect(record).toMatchObject({
      activeTurnId: 'turn-new',
      interruptedResultObserved: true,
    });
    expect(record.sdkTurns?.running).toMatchObject({
      turnId: 'turn-new',
      stopRequested: false,
    });
  });

  test('an is_error: true result with no `result` field falls back to joined errors (SDKResultError shape)', () => {
    const publish = vi.fn();
    const record = {
      session: {
        provider: 'claude' as const,
        threadId: 'thread-dead-2',
        status: 'running' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      activeTurnId: 'turn-dead-2',
      lastSessionState: 'running' as const,
    };

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['engine crashed'],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
        uuid: 'msg-dead-2',
        session_id: 'thread-dead-2',
      } as any,
    });

    expect(publish.mock.calls[1][0]).toMatchObject({
      method: 'runtime.error',
      message: 'engine crashed',
    });
  });
});

describe('claude-adapter-events — subagent/background task lifecycle', () => {
  /** Every task frame this block feeds, as the SDK message it stands for. */
  function task(
    subtype:
      | 'task_started'
      | 'task_progress'
      | 'task_updated'
      | 'task_notification',
    fields: Record<string, unknown>,
  ): SDKMessage {
    return {
      type: 'system',
      subtype,
      uuid: `u-${subtype}-${String(fields.task_id)}`,
      session_id: 's-1',
      ...fields,
    } as unknown as SDKMessage;
  }

  function feed(record: ClaudeMessageState, messages: SDKMessage[]) {
    const events: CanonicalRuntimeEvent[] = [];
    for (const message of messages) {
      mapClaudeSdkMessage({
        provider: 'claude',
        record,
        message,
        publish: (event) => events.push(event),
      });
    }
    return events;
  }

  function childWorkDeltas(events: CanonicalRuntimeEvent[]): ChildWorkDelta[] {
    return events.flatMap((event) =>
      event.method === 'child-work.updated' ? [event.delta] : [],
    );
  }

  function fold(events: CanonicalRuntimeEvent[]): ChildWorkItem[] {
    return Object.values(
      childWorkDeltas(events).reduce(
        applyChildWorkDelta,
        createEmptyChildWorkRegistry(),
      ).items,
    );
  }

  /** #2457: the adapter never emits the pre-contract task tuples. */
  function expectNoLegacyTuples(events: CanonicalRuntimeEvent[]) {
    expect(
      events.filter(
        (event) =>
          event.method === 'extension.notification' &&
          (event.type === 'task/registry' || event.type === 'task/settled'),
      ),
    ).toEqual([]);
  }

  test('task_started maps to tool.started plus a running snapshot; task_progress to tool.progress plus a progress upsert', () => {
    const record = makeRecord();
    const events = feed(record, [
      task('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Explore the codebase',
        subagent_type: 'Explore',
      }),
      task('task_progress', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Explore the codebase',
        last_tool_name: 'Grep',
        usage: { total_tokens: 10, tool_uses: 2, duration_ms: 100 },
      }),
    ]);

    expect(events.map((event) => event.method)).toEqual([
      'tool.started',
      'child-work.updated',
      'tool.progress',
      'child-work.updated',
    ]);
    expect(events[0]).toMatchObject({
      method: 'tool.started',
      toolCallId: 'toolu-1',
      toolName: 'Task (Explore)',
      arguments: expect.objectContaining({
        description: 'Explore the codebase',
      }),
    });
    const [snapshot, upsert] = childWorkDeltas(events);
    expect(snapshot).toEqual({
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: 'thread-activity',
      running: [
        {
          producer: 'engine-subagent',
          reporterThreadId: 'thread-activity',
          childId: 'task-1',
          status: 'running',
          parent: { toolCallId: 'toolu-1', turnId: 'turn-1' },
          title: 'Explore the codebase',
          kindLabel: 'Explore',
          startedAt: expect.any(String),
          controls: { stop: 'provider-task-stop' },
        },
      ],
    });
    expect(events[2]).toMatchObject({
      method: 'tool.progress',
      toolCallId: 'toolu-1',
      message: 'Explore the codebase — Grep',
    });
    expect(upsert).toMatchObject({
      kind: 'upsert',
      item: {
        childId: 'task-1',
        title: 'Explore the codebase',
        progress: 'Explore the codebase — Grep',
        usage: { totalTokens: 10, toolUses: 2, durationMs: 100 },
      },
    });
    expectNoLegacyTuples(events);
  });

  test('task_progress prefers the model summary as the progress line and never replaces the title', () => {
    const record = makeRecord();
    const events = feed(record, [
      task('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Run four sleeps',
      }),
      task('task_progress', {
        task_id: 'task-1',
        description: 'Running sleep command',
        summary: 'Executing second sleep interval.',
        usage: { total_tokens: 42345, tool_uses: 4, duration_ms: 68172 },
        last_tool_name: 'Bash',
      }),
    ]);
    expect(fold(events)).toEqual([
      expect.objectContaining({
        childId: 'task-1',
        title: 'Run four sleeps',
        progress: 'Executing second sleep interval.',
      }),
    ]);
  });

  test('station#1892: both terminals settle; the fold holds ONE completed child with identity AND result', () => {
    const record = makeRecord();
    const events = feed(record, [
      task('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Investigate the failure',
        subagent_type: 'general-purpose',
      }),
      // Terminal ONE: `task_updated` carries the status but no result.
      task('task_updated', {
        task_id: 'task-1',
        patch: { status: 'completed', is_backgrounded: true },
      }),
      // Terminal TWO: `task_notification` carries the result.
      task('task_notification', {
        task_id: 'task-1',
        status: 'completed',
        summary: 'Traced it to conversationOpenController.',
        output_file: '/tmp/agent-1.jsonl',
        usage: { total_tokens: 5100, tool_uses: 23, duration_ms: 311000 },
      }),
    ]);

    const settles = childWorkDeltas(events).filter(
      (delta) => delta.kind === 'settle',
    );
    // Both are emitted: the second changed the fold (it filled the result).
    expect(settles).toHaveLength(2);
    expect(fold(events)).toEqual([
      expect.objectContaining({
        childId: 'task-1',
        status: 'completed',
        parent: { toolCallId: 'toolu-1', turnId: 'turn-1' },
        title: 'Investigate the failure',
        kindLabel: 'general-purpose',
        result: {
          summary: 'Traced it to conversationOpenController.',
          handle: { kind: 'transcript-file', path: '/tmp/agent-1.jsonl' },
        },
        usage: { totalTokens: 5100, toolUses: 23, durationMs: 311000 },
      }),
    ]);
    // Exactly one tool terminal for the call.
    expect(
      events.filter((event) => event.method === 'tool.completed'),
    ).toHaveLength(1);
    expectNoLegacyTuples(events);
  });

  test('station#1892: a duplicate terminal that changes nothing is not published', () => {
    const record = makeRecord();
    const notification = task('task_notification', {
      task_id: 'task-1',
      status: 'completed',
      summary: 'done',
      output_file: '/tmp/agent-x.jsonl',
    });
    const first = feed(record, [
      task('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Quick lookup',
      }),
      notification,
    ]);
    expect(childWorkDeltas(first).map((delta) => delta.kind)).toEqual([
      'snapshot',
      'settle',
    ]);
    // The repeat folds to the same registry, so nothing goes out.
    expect(childWorkDeltas(feed(record, [notification]))).toEqual([]);
  });

  test('station#1877 follow-up: spawn_depth is the child depth; an absent one stays absent', () => {
    const record = makeRecord();
    const events = feed(record, [
      task('task_started', {
        task_id: 'task-nested',
        tool_use_id: 'toolu-nested',
        description: 'Nested investigation',
        subagent_type: 'general-purpose',
        spawn_depth: 2,
      }),
      task('task_started', {
        task_id: 'task-flat',
        tool_use_id: 'toolu-flat',
        description: 'Top level',
      }),
    ]);
    const items = fold(events);
    expect(items.find((item) => item.childId === 'task-nested')?.depth).toBe(2);
    expect(
      'depth' in (items.find((item) => item.childId === 'task-flat') ?? {}),
    ).toBe(false);
  });

  test('#2457 accepted limitation: a second task_started for a RUNNING task_id is ignored — no second child, no re-keyed run', () => {
    const record = makeRecord();
    const events = feed(record, [
      task('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'First',
      }),
      task('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu-2',
        description: 'Overlapping',
      }),
    ]);
    expect(childWorkDeltas(events)).toHaveLength(1);
    expect(fold(events)).toEqual([
      expect.objectContaining({
        childId: 'task-1',
        status: 'running',
        title: 'First',
        parent: expect.objectContaining({ toolCallId: 'toolu-1' }),
      }),
    ]);
  });

  test('station#1877: activeTasks membership is what a task-scoped stop keys off', () => {
    const record = makeRecord();
    feed(record, [
      task('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Long investigation',
      }),
    ]);
    // Live: the adapter's stop path finds it and calls Query.stopTask.
    expect(record.activeTasks?.has('task-1')).toBe(true);
    const events = feed(record, [
      task('task_notification', {
        task_id: 'task-1',
        status: 'stopped',
        summary: 'stopped',
        output_file: '/tmp/a.jsonl',
      }),
    ]);
    // Settled: a stop arriving now is the documented `no-active-task` race.
    expect(record.activeTasks?.has('task-1')).toBe(false);
    expect(fold(events)).toEqual([
      expect.objectContaining({ childId: 'task-1', status: 'cancelled' }),
    ]);
  });

  test('station#1879: a settle with no usage omits it rather than reporting zeroes', () => {
    const record = makeRecord();
    const events = feed(record, [
      task('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Quick lookup',
      }),
      // `usage` is OPTIONAL on SDKTaskNotificationMessage.
      task('task_notification', {
        task_id: 'task-1',
        status: 'completed',
        summary: 'done',
        output_file: '/tmp/agent-x.jsonl',
      }),
    ]);
    const [item] = fold(events);
    expect(item.result?.handle).toEqual({
      kind: 'transcript-file',
      path: '/tmp/agent-x.jsonl',
    });
    expect('usage' in item).toBe(false);
  });

  test('task_started with skip_transcript is suppressed entirely', () => {
    const record = makeRecord();
    const events = feed(record, [
      task('task_started', {
        task_id: 'task-ambient',
        description: 'Housekeeping',
        skip_transcript: true,
      }),
    ]);
    expect(events).toEqual([]);
    expect(record.activeTasks?.has('task-ambient')).not.toBe(true);
  });

  test('an ambient or owned_by_subagent task keeps its tool events but is never child work', () => {
    const record = makeRecord();
    const events = feed(record, [
      task('task_started', {
        task_id: 'task-watch',
        description: 'Watcher',
        ambient: true,
      }),
      // Captured on 2.1.281: a subagent's own shell call.
      task('task_started', {
        task_id: 'bash-1',
        owned_by_subagent: true,
        tool_use_id: 'toolu-bash',
        description: 'Sleep for 20 seconds',
        is_backgrounded: false,
        task_type: 'local_bash',
      }),
      task('task_notification', {
        task_id: 'bash-1',
        tool_use_id: 'toolu-bash',
        status: 'completed',
        output_file: '',
        summary: 'Sleep for 20 seconds',
      }),
    ]);
    expect(events.map((event) => event.method)).toEqual([
      'tool.started',
      'tool.started',
      'tool.completed',
    ]);
    expect(childWorkDeltas(events)).toEqual([]);
  });

  test('task_notification settles a tracked task: tool.completed plus a failed settle, no tuples', () => {
    const record = makeRecord();
    feed(record, [
      task('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Run audit',
        subagent_type: 'general-purpose',
      }),
    ]);
    const events = feed(record, [
      task('task_notification', {
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        status: 'failed',
        output_file: '/tmp/x',
        summary: 'audit crashed',
      }),
    ]);
    expect(events.map((event) => event.method)).toEqual([
      'child-work.updated',
      'tool.completed',
    ]);
    expect(events[1]).toMatchObject({
      toolCallId: 'toolu-1',
      toolName: 'Task (general-purpose)',
      status: 'error',
      error: 'audit crashed',
    });
    expect(childWorkDeltas(events)[0]).toMatchObject({
      kind: 'settle',
      childId: 'task-1',
      status: 'failed',
      result: { summary: 'audit crashed' },
    });
    expect(record.activeTasks?.size).toBe(0);
  });

  test('station#1878: an unknown task_notification status settles the child unresolved, never completed', () => {
    const record = makeRecord();
    feed(record, [
      task('task_started', {
        task_id: 'task-unknown',
        tool_use_id: 'toolu-unknown',
        description: 'Future task',
      }),
    ]);
    const events = feed(record, [
      task('task_notification', {
        task_id: 'task-unknown',
        status: 'future-terminal-status',
      }),
    ]);
    // The tool card is left for the real tool_result / session end.
    expect(events.map((event) => event.method)).toEqual(['child-work.updated']);
    expect(fold(events)).toEqual([
      expect.objectContaining({
        childId: 'task-unknown',
        status: 'unresolved',
      }),
    ]);
    expect(record.activeTasks?.has('task-unknown')).toBe(true);
  });

  test.each(['paused', 'pending', 'running', 'some-future-status'])(
    'task_updated status %s is no child-work change',
    (status) => {
      const record = makeRecord();
      feed(record, [
        task('task_started', {
          task_id: 'task-1',
          tool_use_id: 'toolu-1',
          description: 'Long build',
        }),
      ]);
      const events = feed(record, [
        task('task_updated', { task_id: 'task-1', patch: { status } }),
      ]);
      expect(events).toEqual([]);
    },
  );

  test('station#1878: task_updated killed settles cancelled; the late stopped notification only fills the result', () => {
    const record = makeRecord();
    feed(record, [
      task('task_started', { task_id: 'task-2', description: 'Long build' }),
    ]);
    const killed = feed(record, [
      task('task_updated', { task_id: 'task-2', patch: { status: 'killed' } }),
    ]);
    expect(killed.map((event) => event.method)).toEqual([
      'child-work.updated',
      'tool.completed',
    ]);
    expect(killed[1]).toMatchObject({
      toolCallId: 'task-2',
      toolName: 'Task',
      status: 'cancelled',
    });
    const late = feed(record, [
      task('task_notification', {
        task_id: 'task-2',
        status: 'stopped',
        output_file: '/tmp/x',
        summary: 'stopped',
      }),
    ]);
    // No second tool terminal; the child stays cancelled, enriched.
    expect(late.map((event) => event.method)).toEqual(['child-work.updated']);
    expect(fold([...killed, ...late])).toEqual([
      expect.objectContaining({
        childId: 'task-2',
        status: 'cancelled',
        result: {
          summary: 'stopped',
          handle: { kind: 'transcript-file', path: '/tmp/x' },
        },
      }),
    ]);
  });

  test('task_updated is_backgrounded / description upserts the running child', () => {
    const record = makeRecord();
    const events = feed(record, [
      task('task_started', {
        task_id: 'task-bg',
        tool_use_id: 'toolu-bg',
        description: 'Deep research',
        is_backgrounded: false,
      }),
      task('task_updated', {
        task_id: 'task-bg',
        patch: { is_backgrounded: true, description: 'Deeper research' },
      }),
    ]);
    expect(fold(events)).toEqual([
      expect.objectContaining({
        childId: 'task-bg',
        status: 'running',
        backgrounded: true,
        title: 'Deeper research',
      }),
    ]);
  });

  test('session idle with live backgrounded tasks carries reason background-tasks and no tuple', () => {
    const record = makeRecord();
    feed(record, [
      task('task_started', {
        task_id: 'task-bg',
        tool_use_id: 'toolu-bg',
        description: 'Deep research',
        subagent_type: 'researcher',
        is_backgrounded: true,
      }),
    ]);
    const events = feed(record, [
      {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'u-11',
        session_id: 's-1',
      } as unknown as SDKMessage,
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'session.state-changed',
      to: 'idle',
      reason: 'background-tasks',
    });
  });

  test('session idle with no live tasks has no reason', () => {
    const record = makeRecord();
    const events = feed(record, [
      {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'u-12',
        session_id: 's-1',
      } as unknown as SDKMessage,
    ]);
    expect(events).toHaveLength(1);
    expect((events[0] as { reason?: string }).reason).toBeUndefined();
  });

  test("a backgrounded task's tool.completed lands on the turn that started it, not the running one", () => {
    const record = makeRecord(undefined, { dispatched: ['turn-1', 'turn-2'] });
    feed(record, [
      task('task_started', {
        task_id: 'task-bg',
        tool_use_id: 'toolu-bg',
        description: 'Background research',
        is_backgrounded: true,
      }),
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'LAUNCHED',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: 'result-1',
        session_id: 's-1',
      } as unknown as SDKMessage,
    ]);
    // Premise: turn-1 is over and another turn is the running one.
    expect(record.activeTurnId).not.toBe('turn-1');
    const events = feed(record, [
      task('task_notification', {
        task_id: 'task-bg',
        tool_use_id: 'toolu-bg',
        status: 'completed',
        summary: 'done',
        output_file: '/tmp/bg.output',
      }),
    ]);
    expect(
      events.find((event) => event.method === 'tool.completed'),
    ).toMatchObject({ turnId: 'turn-1', toolCallId: 'toolu-bg' });
  });

  test('#2348: every terminal reports the settled task id for the adapter to withdraw its requests', () => {
    const onTaskSettled = vi.fn();
    const record = makeRecord({ onTaskSettled });
    feed(record, [
      task('task_started', { task_id: 'task-a', description: 'A' }),
      task('task_started', { task_id: 'task-b', description: 'B' }),
      task('task_progress', { task_id: 'task-a', description: 'x' }),
      task('task_updated', { task_id: 'task-a', patch: { status: 'paused' } }),
    ]);
    expect(onTaskSettled).not.toHaveBeenCalled();
    feed(record, [
      task('task_updated', {
        task_id: 'task-a',
        patch: { status: 'completed' },
      }),
      task('task_notification', { task_id: 'task-a', status: 'completed' }),
    ]);
    expect(onTaskSettled.mock.calls).toEqual([['task-a'], ['task-a']]);
  });

  test('mapClaudeTaskStatus is defensive on unknown/non-terminal values', () => {
    expect(mapClaudeTaskStatus('completed')).toBe('success');
    expect(mapClaudeTaskStatus('failed')).toBe('error');
    expect(mapClaudeTaskStatus('stopped')).toBe('cancelled');
    expect(mapClaudeTaskStatus('killed')).toBe('cancelled');
    expect(mapClaudeTaskStatus('running')).toBeUndefined();
    expect(mapClaudeTaskStatus(undefined)).toBeUndefined();
    expect(mapClaudeTaskStatus('some-future-status')).toBeUndefined();
  });
});

describe('claude-adapter-events — thinking/status notifications', () => {
  test('thinking_tokens maps to a claude-code extension.notification', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 1234,
        estimated_tokens_delta: 56,
        uuid: 'u-13',
        session_id: 's-1',
      } as any,
    });

    expect(publish.mock.calls[0][0]).toMatchObject({
      method: 'extension.notification',
      namespace: CLAUDE_EXTENSION_NAMESPACE,
      type: 'thinking/tokens',
      payload: { estimatedTokens: 1234, estimatedTokensDelta: 56 },
    });
  });

  test('system status maps to session/status, forwarding null as the cleared signal', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        uuid: 'u-14',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'status',
        status: null,
        uuid: 'u-15',
        session_id: 's-1',
      } as any,
    });

    expect(publish.mock.calls[0][0]).toMatchObject({
      type: 'session/status',
      payload: { status: 'compacting' },
    });
    expect(publish.mock.calls[1][0]).toMatchObject({
      type: 'session/status',
      payload: { status: null },
    });
  });

  test('signature_delta stream events no longer emit reasoning deltas', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'signature_delta', signature: 'abc' },
        },
        uuid: 'u-16',
        session_id: 's-1',
      } as any,
    });

    expect(publish).not.toHaveBeenCalled();
  });
});

describe('claude-adapter-events — top-level tool_use / tool_result mapping', () => {
  // Turn-scoped tracking: a tool call belongs to the turn that issued it.
  test("a stopped turn's open tool call is left tracked and its late result lands on the stopped turn", () => {
    const publish = vi.fn();
    const record = makeRecord(undefined, { dispatched: ['turn-a'] });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'toolu-a', name: 'Bash', input: {} },
          ],
        },
        uuid: 'u-a-1',
        session_id: 's-1',
      } as any,
    });
    // Stop arrives, then a newer turn dispatches before A's delayed error
    // result lands (the #921 sequence).
    recordClaudeTurnStopRequested(record, 'turn-a');
    recordClaudeTurnDispatched(record, 'turn-b');
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'interrupted',
        num_turns: 1,
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
        uuid: 'u-a-2',
        session_id: 's-1',
      } as any,
    });
    // No synthetic completion: a backgrounded Task on the stopped turn may
    // legitimately still finish, and the fold has no honest status for an
    // outcome Station did not observe (station#1558).
    expect(publish.mock.calls.map(([e]) => e.method)).toEqual([
      'tool.started',
      'token-usage.updated',
    ]);
    expect(record.activeToolCalls?.size).toBe(1);
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-a', content: 'late' },
          ],
        },
        uuid: 'u-a-3',
        session_id: 's-1',
      } as any,
    });
    expect(publish.mock.calls[2][0]).toMatchObject({
      method: 'tool.completed',
      turnId: 'turn-a',
      toolCallId: 'toolu-a',
      status: 'success',
    });
    expect(record.activeToolCalls?.size).toBe(0);
  });

  test("an older turn's delayed real tool_result lands on the turn that issued the call", () => {
    const publish = vi.fn();
    const record = makeRecord(undefined, { dispatched: ['turn-old'] });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'toolu-old', name: 'Read', input: {} },
          ],
        },
        uuid: 'u-o-1',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        stop_reason: 'end_turn',
        result: 'done',
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: 'u-o-2',
        session_id: 's-1',
      } as any,
    });
    // The turn's completion leaves its still-open call alone (a
    // backgrounded Task can outlive its turn), and the next turn starts.
    expect(publish.mock.calls.map(([e]) => e.method)).toEqual([
      'tool.started',
      'token-usage.updated',
      'turn.completed',
    ]);
    expect(publish.mock.calls[2][0]).toMatchObject({ turnId: 'turn-old' });
    expect(record.activeToolCalls?.size).toBe(1);
    recordClaudeTurnDispatched(record, 'turn-next');
    expect(record.activeTurnId).toBe('turn-next');
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-old', content: 'late' },
          ],
        },
        uuid: 'u-o-3',
        session_id: 's-1',
      } as any,
    });
    expect(publish.mock.calls[3][0]).toMatchObject({
      method: 'tool.completed',
      turnId: 'turn-old',
      toolCallId: 'toolu-old',
      status: 'success',
    });
    expect(record.activeToolCalls?.size).toBe(0);
  });

  test('assistant tool_use blocks map to tool.started; matching tool_result maps to tool.completed', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'Let me check.' },
            {
              type: 'tool_use',
              id: 'toolu-b1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
        uuid: 'u-17',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-b1',
              content: 'file.txt',
            },
          ],
        },
        uuid: 'u-18',
        session_id: 's-1',
      } as any,
    });

    expect(publish.mock.calls.map(([e]) => e.method)).toEqual([
      'tool.started',
      'tool.completed',
    ]);
    expect(publish.mock.calls[0][0]).toMatchObject({
      toolCallId: 'toolu-b1',
      toolName: 'Bash',
      arguments: { command: 'ls' },
    });
    expect(publish.mock.calls[1][0]).toMatchObject({
      toolCallId: 'toolu-b1',
      toolName: 'Bash',
      status: 'success',
      output: 'file.txt',
    });
    expect(record.activeToolCalls?.size).toBe(0);
  });

  test('subagent-internal blocks and untracked tool_results are ignored (replay guard)', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: 'toolu-parent',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu-sub', name: 'Read', input: {} },
          ],
        },
        uuid: 'u-19',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-unknown', content: 'x' },
          ],
        },
        uuid: 'u-20',
        session_id: 's-1',
      } as any,
    });

    expect(publish).not.toHaveBeenCalled();
  });

  test('error tool_result maps to status error', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'toolu-e1', name: 'Bash', input: {} },
          ],
        },
        uuid: 'u-21',
        session_id: 's-1',
      } as any,
    });
    publish.mockClear();
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-e1',
              is_error: true,
              content: [{ type: 'text', text: 'command failed' }],
            },
          ],
        },
        uuid: 'u-22',
        session_id: 's-1',
      } as any,
    });

    expect(publish.mock.calls[0][0]).toMatchObject({
      method: 'tool.completed',
      status: 'error',
      output: 'command failed',
    });
  });
});

describe('station#1182 — claude-adapter-events runtime-reported model', () => {
  test('captures message.message.model off a top-level assistant message and carries it onto turn.completed as reportedModel — distinct from the requested/init model', () => {
    const publish = vi.fn();
    // The init message (session.configured) reports the REQUESTED alias —
    // this is the exact archive#1182 incident: the badge said
    // 'claude-fable-5' while the model's own reply said Opus 4.5.
    const record = makeRecord({ activeTurnId: 'turn-1' });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'init',
        session_id: 'thread-report',
        cwd: '/workspace',
        model: 'claude-fable-5',
        uuid: 'init-report',
      } as any,
    });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          model: 'claude-opus-4-5-20260101',
          content: [{ type: 'text', text: "I'm Claude Opus 4.5" }],
        },
        uuid: 'u-report-1',
        session_id: 'thread-report',
      } as any,
    });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        is_error: false,
        result: 'done',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: 'u-report-2',
        session_id: 'thread-report',
      } as any,
    });

    const configured = publish.mock.calls.find(
      ([e]) => e.method === 'session.configured',
    )?.[0];
    expect(configured.model).toBe('claude-fable-5');

    const completed = publish.mock.calls.find(
      ([e]) => e.method === 'turn.completed',
    )?.[0];
    expect(completed.metadata).toEqual({
      reportedModel: 'claude-opus-4-5-20260101',
    });
    // The two disagree — exactly the case this ticket exists to surface,
    // not paper over. `session.configured`'s model is unchanged by this
    // capture (requested is never overwritten).
    expect(completed.metadata.reportedModel).not.toBe(configured.model);
  });

  test('a turn with no assistant message publishes turn.completed with no reportedModel (never inherits a stale value)', () => {
    const publish = vi.fn();
    const record = makeRecord(undefined, { dispatched: ['turn-empty'] });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        is_error: false,
        result: undefined,
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
        uuid: 'u-empty',
        session_id: 'thread-empty',
      } as any,
    });

    const completed = publish.mock.calls.find(
      ([e]) => e.method === 'turn.completed',
    )?.[0];
    expect(completed.metadata).toBeUndefined();
  });

  test('never captures a subagent-internal assistant message model as the session-level reportedModel', () => {
    const publish = vi.fn();
    const record = makeRecord({ activeTurnId: 'turn-sub' });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: 'toolu-parent',
        message: {
          model: 'claude-haiku-subagent',
          content: [{ type: 'text', text: 'subagent output' }],
        },
        uuid: 'u-sub-1',
        session_id: 'thread-sub',
      } as any,
    });

    expect(record.lastReportedModel).toBeUndefined();
  });
});

describe('mapClaudeDecisionToPermissionResult — permission decision mapping', () => {
  const toolInput = { command: 'npm --version' };

  test('accept resolves to allow with the verbatim toolInput and no updatedPermissions', () => {
    expect(
      mapClaudeDecisionToPermissionResult('accept', toolInput, undefined),
    ).toEqual({
      behavior: 'allow',
      updatedInput: toolInput,
      updatedPermissions: undefined,
    });
  });

  test('acceptForSession resolves to allow with updatedInput and forces every suggestion destination to session', () => {
    const suggestions: PermissionUpdate[] = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm run *' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
      {
        type: 'setMode',
        mode: 'default',
        destination: 'session',
      },
    ];

    expect(
      mapClaudeDecisionToPermissionResult(
        'acceptForSession',
        toolInput,
        suggestions,
      ),
    ).toEqual({
      behavior: 'allow',
      updatedInput: toolInput,
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm run *' }],
          behavior: 'allow',
          destination: 'session',
        },
        {
          type: 'setMode',
          mode: 'default',
          destination: 'session',
        },
      ],
    });
  });

  test('acceptForSession with no suggestions resolves updatedPermissions to undefined', () => {
    expect(
      mapClaudeDecisionToPermissionResult(
        'acceptForSession',
        toolInput,
        undefined,
      ),
    ).toEqual({
      behavior: 'allow',
      updatedInput: toolInput,
      updatedPermissions: undefined,
    });
  });

  test('decline resolves to deny with the declined message and no interrupt key', () => {
    expect(
      mapClaudeDecisionToPermissionResult('decline', toolInput, undefined),
    ).toEqual({
      behavior: 'deny',
      message: 'User declined the permission request.',
    });
  });

  test('cancel resolves to deny with the cancelled message and interrupt set', () => {
    expect(
      mapClaudeDecisionToPermissionResult('cancel', toolInput, undefined),
    ).toEqual({
      behavior: 'deny',
      message: 'User cancelled the permission request.',
      interrupt: true,
    });
  });
});

describe('claudeToolResultOutputReceipt (station#4237)', () => {
  // The command-evidence spool derives `outputTruncated` from this receipt's
  // presence, so a missing receipt makes a head slice look like a complete
  // output. These pin both directions of that derivation.
  test('a string over the cap earns a receipt naming the omitted bytes', () => {
    const receipt = claudeToolResultOutputReceipt('b'.repeat(2500));
    expect(receipt).toMatchObject({
      truncated: true,
      reasons: ['bytes'],
      retainedBytes: 2000,
      omittedBytesAtLeast: 500,
      fullOutput: 'unavailable',
    });
  });

  test('a string exactly at the cap earns NO receipt — nothing was dropped', () => {
    // The boundary that separates "we kept everything, and it happened to be
    // 2000 chars" from "we cut it at 2000". Asserting truncation here would
    // be the mirror defect: claiming loss that did not occur.
    expect(claudeToolResultOutputReceipt('a'.repeat(2000))).toBeUndefined();
  });

  test('a short string earns no receipt', () => {
    expect(claudeToolResultOutputReceipt('ok')).toBeUndefined();
  });

  test('the array-of-parts branch measures the joined text, not one part', () => {
    const parts = [
      { type: 'text', text: 'c'.repeat(1500) },
      { type: 'text', text: 'd'.repeat(1500) },
    ];
    const receipt = claudeToolResultOutputReceipt(parts);
    // 1500 + 1 (join newline) + 1500 = 3001 retained-or-dropped
    expect(receipt?.truncated).toBe(true);
    expect(receipt?.omittedBytesAtLeast).toBe(1001);
  });

  test('a non-text payload earns no receipt', () => {
    expect(claudeToolResultOutputReceipt(null)).toBeUndefined();
    expect(claudeToolResultOutputReceipt({ unexpected: true })).toBeUndefined();
  });
});

describe('summarizeClaudeToolResult — output-length boundary', () => {
  test('a string exactly at the 2000-char cap is returned unmodified', () => {
    const content = 'a'.repeat(2000);
    const result = summarizeClaudeToolResult(content);
    expect(result).toHaveLength(2000);
    expect(result).toBe(content);
  });

  test('a string over the cap is truncated to exactly 2000 chars', () => {
    const content = 'b'.repeat(2500);
    const result = summarizeClaudeToolResult(content);
    expect(result).toHaveLength(2000);
    expect(result).toBe('b'.repeat(2000));
  });

  test('an array-of-content-parts branch joins text parts, then truncates over the cap', () => {
    const parts = [
      { type: 'text', text: 'x'.repeat(1200) },
      { type: 'text', text: 'y'.repeat(1200) },
    ];
    const result = summarizeClaudeToolResult(parts);
    // Joined with '\n': 1200 + 1 + 1200 = 2401 chars, bounded to 2000.
    expect(result).toHaveLength(2000);
    expect(result).toBe(
      `${'x'.repeat(1200)}\n${'y'.repeat(1200)}`.slice(0, 2000),
    );
  });

  test('an empty array-of-content-parts yields undefined, not an empty string', () => {
    expect(summarizeClaudeToolResult([])).toBeUndefined();
    expect(
      summarizeClaudeToolResult([{ type: 'text', text: '' }]),
    ).toBeUndefined();
  });

  test('a weird/unsupported shape (plain object, null, number) safely yields undefined', () => {
    expect(summarizeClaudeToolResult({ unexpected: true })).toBeUndefined();
    expect(summarizeClaudeToolResult(null)).toBeUndefined();
    expect(summarizeClaudeToolResult(undefined)).toBeUndefined();
    expect(summarizeClaudeToolResult(42)).toBeUndefined();
  });
});

describe('claude token-usage.updated — provider-reported cost and cache (station#1299)', () => {
  const resultMessage = (usage: Record<string, unknown>, extra = {}) =>
    ({
      type: 'result',
      is_error: false,
      result: 'done',
      stop_reason: 'end_turn',
      usage,
      uuid: 'msg-cost',
      session_id: 'thread-activity',
      ...extra,
    }) as any;

  function usageEvent(message: any) {
    const publish = vi.fn();
    mapClaudeSdkMessage({
      provider: 'claude',
      record: makeRecord(),
      publish,
      message,
    });
    return publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.method === 'token-usage.updated');
  }

  test('carries the engine-reported cost verbatim rather than recomputing it', () => {
    const event = usageEvent(
      resultMessage(
        { input_tokens: 10, output_tokens: 5 },
        { total_cost_usd: 0.031_25 },
      ),
    );

    expect(event).toMatchObject({ reportedCostUsd: 0.031_25 });
  });

  test('a reported zero cost is emitted; an absent one is not', () => {
    expect(
      usageEvent(
        resultMessage(
          { input_tokens: 10, output_tokens: 5 },
          { total_cost_usd: 0 },
        ),
      ),
    ).toMatchObject({ reportedCostUsd: 0 });

    expect(
      usageEvent(resultMessage({ input_tokens: 10, output_tokens: 5 })),
    ).not.toHaveProperty('reportedCostUsd');
  });

  test.each([-1, Number.NaN, 'free', null])(
    'drops an unusable cost value %s instead of emitting it',
    (total_cost_usd) => {
      expect(
        usageEvent(
          resultMessage({ input_tokens: 1, output_tokens: 1 }, {
            total_cost_usd,
          } as any),
        ),
      ).not.toHaveProperty('reportedCostUsd');
    },
  );

  test('maps the cache figures Claude reports and omits the ones it does not', () => {
    const event = usageEvent(
      resultMessage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 4_000,
      }),
    );

    expect(event).toMatchObject({ cacheReadTokens: 4_000 });
    expect(event).not.toHaveProperty('cacheWriteTokens');
  });

  test('reports context occupancy as the whole input, cached parts included', () => {
    const event = usageEvent(
      resultMessage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 4_000,
        cache_creation_input_tokens: 90,
      }),
    );

    // 10 uncached + 4,000 read from cache + 90 written to cache: what the
    // model actually read. `contextWindowTokens` is NOT emitted — Claude
    // does not report the window size, and inventing one here is exactly
    // the fabrication archive#3201 is about.
    expect(event).toMatchObject({ contextTokens: 4_100 });
    expect(event).not.toHaveProperty('contextWindowTokens');
  });

  test('emits no context occupancy when the engine reported no input figures', () => {
    expect(usageEvent(resultMessage({ output_tokens: 5 }))).not.toHaveProperty(
      'contextTokens',
    );
  });

  test.each([
    ['missing', undefined],
    ['non-numeric', 'unknown'],
  ])(
    '%s input tokens stay absent without poisoning folded or stats totals',
    async (_label, input_tokens) => {
      const event = usageEvent(
        resultMessage({ input_tokens, output_tokens: 5 }),
      );

      expect(event).not.toHaveProperty('promptTokens');
      expect(event).toMatchObject({ completionTokens: 5, totalTokens: 5 });
      const aggregate = foldUsageEvents([event]);
      expect(aggregate).toMatchObject({ outputTokens: 5, totalTokens: 5 });
      expect(aggregate.inputTokens).toBeUndefined();

      await expect(
        getConversationStats(
          'claude',
          'thread-activity',
          new Map(),
          new Map(),
          new Map(),
          { loadAgent: vi.fn().mockResolvedValue({ prompt: '' }) } as any,
          { defaultModel: 'anthropic.claude-3-haiku' } as any,
          undefined,
          {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
          () => aggregate,
        ),
      ).resolves.toMatchObject({ outputTokens: 5, totalTokens: 5 });
    },
  );
});

describe('a real Claude Bash tool cycle, replayed (#1536 finding B1)', () => {
  // These replay CAPTURED SDK messages (claude-adapter-tool-cycle-fixtures.ts),
  // not hand-written ones, because the defect this covers was invisible to
  // hand-written coverage: the mapper mapped `tool.completed` correctly all
  // along, and the engine simply never sent the `tool_result` it maps from.
  function replay(messages: SDKMessage[]) {
    const publish = vi.fn();
    const record = makeRecord() as ClaudeMessageState;
    for (const message of messages) {
      mapClaudeSdkMessage({ provider: 'claude', record, publish, message });
    }
    return {
      record,
      events: publish.mock.calls.map(([event]) => event),
    };
  }

  const TOOL_CALL_ID = 'toolu_01QuzhUwwwRumEUn3peJnLpw';

  test('the resolved cycle maps to tool.started then tool.completed with the output', () => {
    const { events } = replay([
      CLAUDE_BASH_TEXT_ASSISTANT,
      CLAUDE_BASH_TOOL_USE_ASSISTANT,
      CLAUDE_BASH_TOOL_RESULT_USER,
      CLAUDE_BASH_FINAL_TEXT_ASSISTANT,
      CLAUDE_BASH_END_TURN_RESULT,
    ]);

    const toolEvents = events.filter((event) =>
      String(event.method).startsWith('tool.'),
    );
    expect(toolEvents).toMatchObject([
      {
        method: 'tool.started',
        toolCallId: TOOL_CALL_ID,
        toolName: 'Bash',
        arguments: { command: 'pwd' },
      },
      {
        method: 'tool.completed',
        toolCallId: TOOL_CALL_ID,
        toolName: 'Bash',
        status: 'success',
        // The tool's real stdout, which is the thing the audited transcript
        // never showed the user.
        output: '/workspace/example',
      },
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: 'The directory is `/workspace/example`.',
        }),
      ]),
    );
  });

  test('a deferred turn settles the call as an error and does NOT report a clean stop', () => {
    // The engine ends this turn with the call unexecuted on
    // `deferred_tool_use` and no `tool_result` — the exact shape #1536 B1
    // rendered as "No result recorded · 1 tool call unresolved" beside a
    // completed turn.
    const { events, record } = replay([
      CLAUDE_BASH_TEXT_ASSISTANT,
      CLAUDE_BASH_TOOL_USE_ASSISTANT,
      CLAUDE_BASH_DEFERRED_RESULT,
    ]);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'tool.completed',
          toolCallId: TOOL_CALL_ID,
          toolName: 'Bash',
          status: 'error',
          error: expect.stringContaining('The tool did not run.'),
        }),
      ]),
    );
    const completed = events.find(
      (event) => event.method === 'turn.completed',
    ) as { finishReason?: string } | undefined;
    // `'other'` deliberately, not `'stop'` (the bug) and not `'tool-calls'`:
    // `PROVIDER_PROVEN_FINISH_REASONS` grants neither clear authority to
    // `'other'` nor the claim that the turn reached its own outcome.
    expect(completed?.finishReason).toBe('other');
    // Settled, so a later replayed `tool_result` cannot double-report it.
    expect(record.activeToolCalls?.has(TOOL_CALL_ID)).toBe(false);
  });

  test('terminal_reason tool_deferred_unavailable is recognised by name, without a deferred stop_reason', () => {
    // The second deferral terminal reason in the SDK's `TerminalReason` union.
    // Nothing guarantees it also sets `stop_reason: 'tool_deferred'`, so
    // reading only that string would let this one report a clean stop.
    const { events } = replay([
      CLAUDE_BASH_TEXT_ASSISTANT,
      CLAUDE_BASH_TOOL_USE_ASSISTANT,
      {
        ...(CLAUDE_BASH_DEFERRED_RESULT as unknown as Record<string, unknown>),
        stop_reason: 'end_turn',
        terminal_reason: 'tool_deferred_unavailable',
        deferred_tool_use: undefined,
      } as unknown as SDKMessage,
    ]);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'turn.completed',
          finishReason: 'other',
        }),
      ]),
    );
  });

  test('a deferral the engine describes without a name still refuses a clean stop', () => {
    // Version skew: `deferred_tool_use` present but nameless AND untracked.
    // `tool.completed` requires a `toolName`, and inventing one would be a
    // worse record than the completion's absence — so the honest signal has
    // to survive on `finishReason` alone.
    const { events } = replay([
      {
        ...(CLAUDE_BASH_DEFERRED_RESULT as unknown as Record<string, unknown>),
        deferred_tool_use: { id: 'toolu_unknown' },
      } as unknown as SDKMessage,
    ]);

    expect(
      events.filter((event) => event.method === 'tool.completed'),
    ).toHaveLength(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'turn.completed',
          finishReason: 'other',
        }),
      ]),
    );
  });
});

// station#1558: the session-end settle. `activeToolCalls` deliberately
// outlives its turn, so this is the ONLY moment at which a still-open
// `tool_use` is provably never going to report.
describe('settleUnresolvedClaudeToolCalls (station#1558)', () => {
  function recordWithOpenCalls() {
    const record = makeRecord(undefined, {
      dispatched: ['turn-c'],
    }) as ClaudeMessageState;
    record.activeToolCalls = new Map([
      ['toolu-a', { toolName: 'Bash', turnId: 'turn-a' }],
      ['toolu-b', { toolName: 'Read', turnId: 'turn-b' }],
    ]);
    return record;
  }

  test('settles every open call on the turn that ISSUED it, not the active one', () => {
    const publish = vi.fn();
    const record = recordWithOpenCalls();

    settleUnresolvedClaudeToolCalls({
      provider: 'claude',
      record,
      publish,
      createdAt: '2026-09-05T00:00:00.000Z',
    });

    expect(publish.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        method: 'tool.completed',
        turnId: 'turn-a',
        toolCallId: 'toolu-a',
        toolName: 'Bash',
        status: 'unresolved',
        output: CLAUDE_UNRESOLVED_TOOL_OUTPUT,
      }),
      expect.objectContaining({
        method: 'tool.completed',
        turnId: 'turn-b',
        toolCallId: 'toolu-b',
        toolName: 'Read',
        status: 'unresolved',
      }),
    ]);
    // Never the turn that happened to be active when the session ended.
    expect(
      publish.mock.calls.some(([event]) => event.turnId === 'turn-c'),
    ).toBe(false);
    expect(record.activeToolCalls?.size).toBe(0);
  });

  test('never republishes a call its own tool_result already settled', () => {
    const publish = vi.fn();
    const record = makeRecord(undefined, {
      dispatched: ['turn-a'],
    }) as ClaudeMessageState;
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'toolu-done', name: 'Read', input: {} },
            { type: 'tool_use', id: 'toolu-open', name: 'Bash', input: {} },
          ],
        },
        uuid: 'u-1',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-done', content: 'ok' },
          ],
        },
        uuid: 'u-2',
        session_id: 's-1',
      } as any,
    });
    publish.mockClear();

    settleUnresolvedClaudeToolCalls({ provider: 'claude', record, publish });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      toolCallId: 'toolu-open',
      status: 'unresolved',
    });
  });

  // station#1558 fix round (H1, blocking): the Task's `tool_use` is registered
  // in `activeToolCalls` and only its real `tool_result` removes it. A Task
  // settled by `task_notification` whose result has not come back was still
  // sitting there at session end, so the settle published a SECOND terminal
  // — `unresolved` — contradicting the success the engine had already
  // reported for the same call id.
  test('a Task already settled by its own notification is not re-settled as unresolved', () => {
    const publish = vi.fn();
    const record = makeRecord(undefined, {
      dispatched: ['turn-a'],
    }) as ClaudeMessageState;
    // The assistant's `tool_use` is what registers the call id — without it
    // the entry the defect lives in never exists.
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'toolu-task', name: 'Task', input: {} },
          ],
        },
        uuid: 'u-1',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'toolu-task',
        description: 'Run audit',
        subagent_type: 'Explore',
        uuid: 'u-2',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'completed',
        summary: 'audit clean',
        uuid: 'u-3',
        session_id: 's-1',
      } as any,
    });
    // The Task reported success and its `tool_result` never came back, so the
    // entry is still tracked — that is the point.
    expect(record.activeToolCalls?.has('toolu-task')).toBe(true);

    settleUnresolvedClaudeToolCalls({ provider: 'claude', record, publish });

    const terminals = publish.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.method === 'tool.completed' &&
          event.toolCallId === 'toolu-task',
      );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: 'success' });
    expect(
      terminals.some(
        (event: { status: string }) => event.status === 'unresolved',
      ),
    ).toBe(false);
  });

  test('a second settle publishes nothing (both session-end paths can run)', () => {
    const publish = vi.fn();
    const record = recordWithOpenCalls();

    settleUnresolvedClaudeToolCalls({ provider: 'claude', record, publish });
    const afterFirst = publish.mock.calls.length;
    settleUnresolvedClaudeToolCalls({ provider: 'claude', record, publish });

    expect(afterFirst).toBe(2);
    expect(publish.mock.calls.length).toBe(2);
  });

  test('a session that ends with nothing open publishes nothing', () => {
    const publish = vi.fn();
    const record = makeRecord() as ClaudeMessageState;

    settleUnresolvedClaudeToolCalls({ provider: 'claude', record, publish });

    expect(publish).not.toHaveBeenCalled();
  });
});

describe('#2324 turn ledger attribution with command lifecycle', () => {
  test('a reply frame naming no user message, while a send is only queued, is the engine’s own turn — never the queued send', () => {
    const publish = vi.fn();
    const record = makeRecord(undefined, { dispatched: [] });
    const map = (message: Record<string, unknown>) =>
      mapClaudeSdkMessage({
        provider: 'claude',
        record,
        publish,
        message: {
          session_id: record.session.threadId,
          uuid: `m-${Math.random()}`,
          ...message,
        } as unknown as SDKMessage,
      });
    // The first turn: dispatched, started, init (which declares lifecycle
    // messages), result.
    recordClaudeTurnDispatched(record, 'turn-0');
    map({
      type: 'command_lifecycle',
      command_uuid: 'turn-0',
      state: 'started',
    });
    map({
      type: 'system',
      subtype: 'init',
      cwd: '/w',
      model: 'm',
      capabilities: ['msg_lifecycle_v1'],
    });
    map({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      result: 'done',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      user_message_uuid: 'turn-0',
    });
    // A send is queued; the engine has not started it.
    recordClaudeTurnDispatched(record, 'turn-u');
    expect(record.activeTurnId).toBeUndefined();
    map({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'finished' },
      },
    });
    const started = publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.method === 'turn.started');
    expect(started).toEqual([
      expect.objectContaining({ metadata: { trigger: 'provider' } }),
    ]);
    expect(record.activeTurnId).toBe(started[0].turnId);
    expect(record.sdkTurns?.queued.map((turn) => turn.turnId)).toEqual([
      'turn-u',
    ]);
  });
});

describe('claude-adapter-events — images a tool returned', () => {
  const PNG_1X1_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const runToolCycle = (content: unknown) => {
    const publish = vi.fn();
    const record = makeRecord();
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu-img',
              name: 'Read',
              input: { file_path: '/tmp/chart.png' },
            },
          ],
        },
        uuid: 'u-img-1',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu-img', content }],
        },
        uuid: 'u-img-2',
        session_id: 's-1',
      } as any,
    });
    return publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.method === 'tool.completed');
  };

  test('a Read of a PNG publishes the image as an attachment, not as nothing', () => {
    // The real shape the Agent SDK delivers for Read on an image file.
    const completed = runToolCycle([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: PNG_1X1_BASE64,
        },
      },
    ]);
    expect(completed).toMatchObject({
      toolCallId: 'toolu-img',
      status: 'success',
      attachments: [
        {
          kind: 'image',
          name: 'image-1.png',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
        },
      ],
    });
    // The text output stays text: no base64 in it.
    expect(completed.output).toBeUndefined();
  });

  test('an MCP screenshot beside text keeps the text and adds the image', () => {
    const completed = runToolCycle([
      { type: 'text', text: 'Screenshot of the login page' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: PNG_1X1_BASE64,
        },
      },
    ]);
    expect(completed.output).toBe('Screenshot of the login page');
    expect(completed.attachments).toHaveLength(1);
  });

  test('an unsupported image is named in the output, never attached', () => {
    const completed = runToolCycle([
      { type: 'text', text: 'Rendered diagram' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/tiff',
          data: PNG_1X1_BASE64,
        },
      },
    ]);
    expect(completed).not.toHaveProperty('attachments');
    expect(completed.output).toBe(
      'Rendered diagram\n[image not shown: image/tiff is not a supported image type]',
    );
  });
});

describe('claude-adapter-events — many rejected images', () => {
  test('thousands of rejected image blocks still persist the terminal through EventStore', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { EventStore } = await import(
      '../../services/orchestration/event-store.js'
    );
    const dir = mkdtempSync(join(tmpdir(), 'claude-many-images-'));
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    try {
      const record = makeRecord();
      const publish = (event: any) =>
        store.appendEvent(store.projectLiveEvent(event));
      mapClaudeSdkMessage({
        provider: 'claude',
        record,
        publish,
        message: {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              { type: 'tool_use', id: 'toolu-many', name: 'mcp__x', input: {} },
            ],
          },
          uuid: 'u-many-1',
          session_id: 's-1',
        } as any,
      });
      // 3000 distinct unsupported types: one marker line each would be far
      // past the 64 KiB ingress ceiling.
      const content = Array.from({ length: 3000 }, (_, i) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: `image/x-unsupported-type-number-${i}`,
          data: 'AAAA',
        },
      }));
      mapClaudeSdkMessage({
        provider: 'claude',
        record,
        publish,
        message: {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu-many', content },
            ],
          },
          uuid: 'u-many-2',
          session_id: 's-1',
        } as any,
      });
      const terminal = store
        .listEvents(record.session.threadId)
        .map((event) => event.payload as any)
        .find((event) => event.method === 'tool.completed');
      expect(terminal.status).toBe('success');
      expect(terminal.output.split('\n')).toEqual([
        '[image not shown: image/x-unsupported-type-number-0 is not a supported image type]',
        '[image not shown: image/x-unsupported-type-number-1 is not a supported image type]',
        '[image not shown: image/x-unsupported-type-number-2 is not a supported image type]',
        '[2997 more images not shown]',
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('claude-adapter-events — inline image data in tool_result text', () => {
  test.each([
    [
      'a string result',
      `Screenshot: data:image/png;base64,${'QUJD'.repeat(5_000)}WFla==`,
    ],
    [
      'a text-block result',
      [
        {
          type: 'text',
          text: `Screenshot: data:image/png;base64,${'QUJD'.repeat(5_000)}WFla==`,
        },
      ],
    ],
  ])('%s is redacted before the head slice', (_label, content) => {
    const publish = vi.fn();
    const record = makeRecord();
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'toolu-text', name: 'mcp__x', input: {} },
          ],
        },
        uuid: 'u-text-1',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-text', content },
          ],
        },
        uuid: 'u-text-2',
        session_id: 's-1',
      } as any,
    });
    const completed = publish.mock.calls
      .map(([event]) => event)
      .find((event) => event.method === 'tool.completed');
    expect(completed.output).toBe('Screenshot: [inline image data omitted]');
    // The redacted text fits the limit: no truncation receipt, no bytes.
    expect(completed).not.toHaveProperty('outputReceipt');
    expect(JSON.stringify(completed)).not.toContain('QUJD');
  });
});
