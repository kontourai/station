import { describe, expect, test } from 'vitest';
import type {
  OrchestrationCommandDispatchResult,
  OrchestrationCommandReceipt,
  OrchestrationSessionDetail,
  OrchestrationSessionEventPage,
  OrchestrationSessionSummary,
} from '../orchestration.js';

describe('orchestration session contract shapes', () => {
  test('session summary supports loaded and persisted read-model semantics', () => {
    const summary: OrchestrationSessionSummary = {
      provider: 'claude',
      threadId: 'thread-1',
      status: 'ready',
      controlMode: 'station-owned',
      answerability: { answerable: true },
      model: 'claude-sonnet',
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:01.000Z',
      isLoaded: true,
      isPersisted: true,
      eventCount: 2,
      lastEventAt: '2026-04-18T00:00:02.000Z',
      lastEventMethod: 'turn.completed',
      workspaceIsolation: {
        mode: 'worktree',
        repoPath: '/repo',
        path: '/repo-worktrees/station-session-thread-1',
        branch: 'station/session/thread-1',
        baseRef: 'HEAD',
        cleanupPolicy: 'cleanup',
        preserveOnFailure: true,
        createdAt: '2026-04-18T00:00:00.000Z',
      },
    };

    expect(summary).toEqual(
      expect.objectContaining({
        threadId: 'thread-1',
        isLoaded: true,
        isPersisted: true,
        eventCount: 2,
        lastEventMethod: 'turn.completed',
        workspaceIsolation: expect.objectContaining({
          mode: 'worktree',
          branch: 'station/session/thread-1',
          cleanupPolicy: 'cleanup',
        }),
      }),
    );
  });

  test('session detail pairs one summary with canonical event payloads', () => {
    const detail: OrchestrationSessionDetail = {
      session: {
        provider: 'codex',
        threadId: 'thread-2',
        status: 'running',
        controlMode: 'station-owned',
        answerability: { answerable: true },
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:01.000Z',
        isLoaded: true,
        isPersisted: false,
        eventCount: 1,
      },
      events: [
        {
          provider: 'codex',
          threadId: 'thread-2',
          eventId: 'evt-1',
          createdAt: '2026-04-18T00:00:02.000Z',
          method: 'content.text-delta',
          itemId: 'item-1',
          delta: 'hello',
        },
      ],
    };

    expect(detail).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          threadId: 'thread-2',
          isLoaded: true,
          isPersisted: false,
        }),
        events: [
          expect.objectContaining({
            method: 'content.text-delta',
            delta: 'hello',
          }),
        ],
      }),
    );
  });

  test('command receipts are protocol metadata separate from command result payloads', () => {
    const receipt: OrchestrationCommandReceipt = {
      commandId: 'cmd-1',
      threadId: 'thread-1',
      commandType: 'sendTurn',
      status: 'accepted',
      createdAt: '2026-04-18T00:00:03.000Z',
    };
    const result: OrchestrationCommandDispatchResult<{ turnId: string }> = {
      receipt,
      result: { turnId: 'turn-1' },
    };

    expect(result).toEqual({
      receipt: expect.objectContaining({
        commandType: 'sendTurn',
        status: 'accepted',
      }),
      result: { turnId: 'turn-1' },
    });
  });

  test('event pages pair stable sequence cursors with a full session summary', () => {
    const page: OrchestrationSessionEventPage = {
      session: {
        provider: 'codex',
        threadId: 'task-1',
        status: 'running',
        controlMode: 'read-only-attached',
        answerability: { answerable: true },
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:01.000Z',
        isLoaded: true,
        isPersisted: true,
        eventCount: 9,
        delegation: {
          taskId: 'task-1',
          targetKind: 'agent-app',
          targetId: 'codex',
        },
      },
      events: [
        {
          sequence: 8,
          event: {
            provider: 'codex',
            threadId: 'task-1',
            eventId: 'evt-8',
            createdAt: '2026-04-18T00:00:02.000Z',
            method: 'turn.started',
            turnId: 'turn-2',
          },
        },
      ],
      hasMore: true,
      nextSequence: 8,
    };

    expect(page.events[0]?.sequence).toBe(8);
    expect(page.session.delegation?.targetId).toBe('codex');
  });
});
