import type { EngineId } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';

describe('CanonicalRuntimeEvent', () => {
  const base = {
    eventId: 'evt_123',
    provider: 'claude' as EngineId,
    threadId: 'thread_123',
    createdAt: '2026-03-28T12:00:00.000Z',
  };

  test('supports the shared provider kinds', () => {
    const providers: EngineId[] = ['bedrock', 'claude', 'codex'];
    expect(providers).toEqual(['bedrock', 'claude', 'codex']);
  });

  test('constructs representative events across the MVP taxonomy', () => {
    const events: CanonicalRuntimeEvent[] = [
      {
        ...base,
        method: 'session.started',
        sessionId: 'sess_1',
        initialState: 'created',
      },
      {
        ...base,
        method: 'session.configured',
        sessionId: 'sess_1',
        model: 'claude-sonnet',
        tools: ['read_file'],
      },
      {
        ...base,
        method: 'session.state-changed',
        sessionId: 'sess_1',
        from: 'idle',
        to: 'running',
      },
      {
        ...base,
        method: 'session.exited',
        sessionId: 'sess_1',
        reason: 'completed',
      },
      {
        ...base,
        method: 'turn.started',
        turnId: 'turn_1',
        prompt: 'Inspect the repo',
      },
      {
        ...base,
        method: 'turn.completed',
        turnId: 'turn_1',
        finishReason: 'stop',
        outputText: 'Done.',
      },
      {
        ...base,
        method: 'turn.aborted',
        turnId: 'turn_2',
        reason: 'user_cancelled',
      },
      {
        ...base,
        method: 'content.text-delta',
        turnId: 'turn_1',
        itemId: 'item_text',
        delta: 'Hello',
      },
      {
        ...base,
        method: 'content.reasoning-delta',
        turnId: 'turn_1',
        itemId: 'item_reasoning',
        delta: 'Need to inspect the tool output first.',
      },
      {
        ...base,
        method: 'tool.started',
        turnId: 'turn_1',
        itemId: 'tool_item',
        toolCallId: 'call_1',
        toolName: 'read_file',
        arguments: { path: 'README.md' },
      },
      {
        ...base,
        method: 'tool.progress',
        turnId: 'turn_1',
        itemId: 'tool_item',
        toolCallId: 'call_1',
        message: 'Reading file',
        progress: 0.5,
      },
      {
        ...base,
        method: 'tool.completed',
        turnId: 'turn_1',
        itemId: 'tool_item',
        toolCallId: 'call_1',
        toolName: 'read_file',
        status: 'success',
        output: { bytes: 128 },
      },
      {
        ...base,
        method: 'request.opened',
        requestId: 'req_1',
        requestType: 'approval',
        title: 'Approve tool call',
      },
      {
        ...base,
        method: 'request.resolved',
        requestId: 'req_1',
        status: 'approved',
      },
      {
        ...base,
        method: 'runtime.error',
        severity: 'error',
        message: 'Tool execution failed',
        retriable: true,
      },
      {
        ...base,
        method: 'runtime.warning',
        severity: 'warning',
        message: 'Session is using a fallback transport',
      },
      {
        ...base,
        method: 'token-usage.updated',
        turnId: 'turn_1',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
    ];

    expect(events).toHaveLength(17);
    expect(events.map((event) => event.method)).toContain('tool.completed');
    expect(events.map((event) => event.method)).toContain('runtime.error');
  });
});
