/**
 * @vitest-environment jsdom
 *
 * #4400 (A22): a tool call whose own terminal event never arrived (an exec
 * runner that timed out connecting) kept reading "Running …" under a turn the
 * header already called Done. When the turn ends, each of its calls settles:
 * an open call with no outcome becomes "No result recorded", exactly what the
 * durable projection records for an open call in a turn that is not live.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
}));

import { toolCallPhase } from '../components/chat/tool-call-labels';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  handleToolCompletedEvent,
  handleToolStartedEvent,
} from '../hooks/orchestration/streamHandlers';
import { handleTurnCompletedEvent } from '../hooks/orchestration/turnHandlers';

const THREAD_ID = 'open-tool-calls-thread';
const TURN_ID = 'turn-open-tools';

function startTool(toolCallId: string) {
  handleToolStartedEvent({
    threadId: THREAD_ID,
    method: 'tool.started',
    turnId: TURN_ID,
    toolCallId,
    toolName: 'exec',
    arguments: { command: 'pwsh.exe -NoProfile' },
    createdAt: '2026-10-31T12:00:00.000Z',
  } as any);
}

describe('finalizeAssistantTurn settles open tool calls (#4400)', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Codex Chat',
    });
    activeChatsStore.updateChat(THREAD_ID, {
      status: 'sending',
      orchestrationStatus: 'running',
      orchestrationTurnOpen: true,
      openTurnId: TURN_ID,
      streamingMessage: { role: 'assistant', content: '', contentParts: [] },
    });
  });

  test('a call with no terminal event no longer reads as running after the turn completes', () => {
    startTool('call-finished');
    startTool('call-orphaned');
    handleToolCompletedEvent({
      threadId: THREAD_ID,
      method: 'tool.completed',
      turnId: TURN_ID,
      toolCallId: 'call-finished',
      toolName: 'exec',
      error: 'Failed to create unified exec process',
      createdAt: '2026-10-31T12:00:01.000Z',
    } as any);
    const live = activeChatsStore.getSnapshot()[THREAD_ID].streamingMessage;
    expect(
      live?.contentParts?.map((part) => toolCallPhase(part as any)),
    ).toEqual(['failed', 'running']);

    handleTurnCompletedEvent('http://localhost', {
      threadId: THREAD_ID,
      method: 'turn.completed',
      provider: 'codex',
      turnId: TURN_ID,
      createdAt: '2026-10-31T12:00:02.000Z',
    } as any);

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    const answer = chat.messages?.find((m) => m.role === 'assistant');
    const phases = answer?.contentParts?.map((part) =>
      toolCallPhase(part as any),
    );
    expect(phases).toEqual(['failed', 'unresolved']);
    expect(answer?.contentParts?.[1]).toMatchObject({
      toolCallId: 'call-orphaned',
      state: 'call',
    });
    expect(chat.status).toBe('idle');
  });
});
