import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test, vi } from 'vitest';
import type { SessionAnswerabilityObservation } from '../../services/orchestration/open-requests.js';
import { buildAgentRunSummary } from '../../services/orchestration/orchestration-session-state.js';
import { projectSessionLifecycle } from '../../services/orchestration/session-lifecycle-service.js';
import {
  CLAUDE_EXTENSION_NAMESPACE,
  type ClaudeMessageState,
  claudeToolResultOutputReceipt,
  mapClaudeDecisionToPermissionResult,
  mapClaudeSdkMessage,
  mapClaudeSessionState,
  mapClaudeTaskStatus,
  summarizeClaudeToolResult,
} from '../adapters/claude-adapter-events.js';

const ANSWERABILITY: SessionAnswerabilityObservation = {
  threadAttachment: 'detached',
  providerRegistered: true,
  observedBy: 'claude-adapter-events-test',
  observedAt: '2026-08-10T00:00:00.000Z',
};

function makeRecord(overrides?: Partial<ClaudeMessageState>) {
  return {
    session: {
      provider: 'claude' as const,
      threadId: 'thread-activity',
      status: 'running' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    activeTurnId: 'turn-1',
    dispatchedTurnId: 'turn-1',
    lastSessionState: 'running' as const,
    ...overrides,
  };
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
      activeTurnId: 'turn-1',
      dispatchedTurnId: 'turn-1',
      lastSessionState: 'running' as const,
    };

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
    const record = makeRecord({
      activeTurnId: 'turn-real',
      dispatchedTurnId: 'turn-real',
    });
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
    expect(record).toMatchObject({
      activeTurnId: 'turn-real',
      dispatchedTurnId: 'turn-real',
    });
    expect(logInfo).toHaveBeenCalledWith(
      'Dropped Claude handshake result before lifecycle mapping',
      expect.objectContaining({
        inheritedActiveTurnId: 'turn-real',
        dispatchedTurnId: 'turn-real',
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
    const record = makeRecord({
      activeTurnId: 'turn-a',
      dispatchedTurnId: 'turn-a',
    });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        subtype: 'success',
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
    expect(record.dispatchedTurnId).toBeUndefined();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
        subtype: 'success',
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
  test('an is_error: true result publishes a terminal runtime.error instead of turn.completed, and sets terminalResultObserved', () => {
    const publish = vi.fn();
    const record = {
      session: {
        provider: 'claude' as const,
        threadId: 'thread-dead',
        status: 'running' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      activeTurnId: 'turn-dead',
      dispatchedTurnId: 'turn-dead',
      lastSessionState: 'running' as const,
    };

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
    expect((record as any).terminalResultObserved).toBe(true);
  });

  test("a requested interruption consumes Claude's null-stop-reason error result without replacing Stopped with Failed (#898)", () => {
    const publish = vi.fn();
    const logInfo = vi.fn();
    const record = makeRecord({
      activeTurnId: 'turn-stopped',
      dispatchedTurnId: 'turn-stopped',
      interruptingTurnId: 'turn-stopped',
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
      dispatchedTurnId: undefined,
      interruptingTurnId: undefined,
      interruptedResultObserved: true,
    });
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
    const record = makeRecord({
      activeTurnId: 'turn-new',
      dispatchedTurnId: 'turn-new',
      interruptingTurnId: 'turn-stopped',
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
      dispatchedTurnId: 'turn-new',
      interruptedResultObserved: true,
    });
    expect(record.interruptingTurnId).toBeUndefined();
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
  test('task_started maps to tool.started and is tracked; task_progress maps to tool.progress with tool detail', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Explore the codebase',
        subagent_type: 'Explore',
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
        subtype: 'task_progress',
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Explore the codebase',
        last_tool_name: 'Grep',
        usage: { total_tokens: 10, tool_uses: 2, duration_ms: 100 },
        uuid: 'u-2',
        session_id: 's-1',
      } as any,
    });

    expect(publish.mock.calls[0][0]).toMatchObject({
      method: 'tool.started',
      toolCallId: 'toolu-1',
      toolName: 'Task (Explore)',
      arguments: expect.objectContaining({
        description: 'Explore the codebase',
      }),
    });
    expect(publish.mock.calls[1][0]).toMatchObject({
      method: 'tool.progress',
      toolCallId: 'toolu-1',
      message: 'Explore the codebase — Grep',
    });
    expect(record.activeTasks?.get('task-1')).toMatchObject({
      toolCallId: 'toolu-1',
      subagentType: 'Explore',
    });
  });

  test('task_started with skip_transcript is suppressed entirely', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-ambient',
        description: 'Housekeeping',
        skip_transcript: true,
        uuid: 'u-3',
        session_id: 's-1',
      } as any,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(record.activeTasks?.has('task-ambient')).not.toBe(true);
  });

  test('task_notification settles a tracked task: tool.completed + task/settled notification', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Run audit',
        subagent_type: 'general-purpose',
        uuid: 'u-4',
        session_id: 's-1',
      } as any,
    });
    publish.mockClear();
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        status: 'failed',
        output_file: '/tmp/x',
        summary: 'audit crashed',
        uuid: 'u-5',
        session_id: 's-1',
      } as any,
    });

    expect(publish.mock.calls.map(([e]) => e.method)).toEqual([
      'tool.completed',
      'extension.notification',
    ]);
    expect(publish.mock.calls[0][0]).toMatchObject({
      toolCallId: 'toolu-1',
      toolName: 'Task (general-purpose)',
      status: 'error',
      error: 'audit crashed',
    });
    expect(publish.mock.calls[1][0]).toMatchObject({
      namespace: CLAUDE_EXTENSION_NAMESPACE,
      type: 'task/settled',
      payload: expect.objectContaining({ taskId: 'task-1', status: 'error' }),
    });
    expect(record.activeTasks?.size).toBe(0);
  });

  test('task_notification with an unknown status is a no-op, never a success', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-unknown',
        tool_use_id: 'toolu-unknown',
        description: 'Future task',
        uuid: 'u-unknown-start',
        session_id: 's-1',
      } as any,
    });
    publish.mockClear();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-unknown',
        status: 'future-terminal-status',
        uuid: 'u-unknown-notification',
        session_id: 's-1',
      } as any,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(record.activeTasks?.has('task-unknown')).toBe(true);
  });

  test('task_updated terminal patch settles once; task_notification for an untracked task emits only task/settled', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-2',
        description: 'Long build',
        uuid: 'u-6',
        session_id: 's-1',
      } as any,
    });
    publish.mockClear();
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-2',
        patch: { status: 'killed' },
        uuid: 'u-7',
        session_id: 's-1',
      } as any,
    });

    expect(publish.mock.calls[0][0]).toMatchObject({
      method: 'tool.completed',
      toolCallId: 'task-2',
      toolName: 'Task',
      status: 'cancelled',
    });

    publish.mockClear();
    // Late notification for the already-settled (now untracked) task.
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-2',
        status: 'stopped',
        output_file: '/tmp/x',
        summary: 'stopped',
        uuid: 'u-8',
        session_id: 's-1',
      } as any,
    });
    expect(publish.mock.calls.map(([e]) => e.method)).toEqual([
      'extension.notification',
    ]);
    expect(publish.mock.calls[0][0]).toMatchObject({
      type: 'task/settled',
      payload: expect.objectContaining({ status: 'cancelled' }),
    });
  });

  test('session idle with live backgrounded tasks carries reason background-tasks plus a task/registry snapshot', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-bg',
        tool_use_id: 'toolu-bg',
        description: 'Deep research',
        subagent_type: 'researcher',
        uuid: 'u-9',
        session_id: 's-1',
      } as any,
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-bg',
        patch: { is_backgrounded: true },
        uuid: 'u-10',
        session_id: 's-1',
      } as any,
    });
    publish.mockClear();
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'u-11',
        session_id: 's-1',
      } as any,
    });

    expect(publish.mock.calls[0][0]).toMatchObject({
      method: 'session.state-changed',
      to: 'idle',
      reason: 'background-tasks',
    });
    expect(publish.mock.calls[1][0]).toMatchObject({
      method: 'extension.notification',
      namespace: CLAUDE_EXTENSION_NAMESPACE,
      type: 'task/registry',
      payload: {
        active: [
          expect.objectContaining({
            taskId: 'task-bg',
            toolCallId: 'toolu-bg',
            backgrounded: true,
          }),
        ],
      },
    });
  });

  test('session idle with no live tasks has no reason and no registry', () => {
    const publish = vi.fn();
    const record = makeRecord();

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'u-12',
        session_id: 's-1',
      } as any,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].reason).toBeUndefined();
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
    const record = makeRecord({
      activeTurnId: 'turn-empty',
      dispatchedTurnId: 'turn-empty',
    });

    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: {
        type: 'result',
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
});
