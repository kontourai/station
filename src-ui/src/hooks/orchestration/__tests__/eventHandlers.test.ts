// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../../contexts/background-tasks-store';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  outboundDispatch,
} from '../../../lib/outboundQueue';
import { handleOrchestrationEvent } from '../eventHandlers';
import { drainQueuedMessageOnTurnCompleted } from '../queueDrain';
import type { OrchestrationEvent } from '../types';

function event(
  method: string,
  overrides: Record<string, unknown> = {},
): OrchestrationEvent {
  return {
    provider: 'claude',
    threadId: 'task:delegate-untracked',
    createdAt: '2026-07-29T00:00:00.000Z',
    method,
    ...overrides,
  } as unknown as OrchestrationEvent;
}

describe('handleOrchestrationEvent — station#1301 slice 1 ingest seam', () => {
  beforeEach(() => {
    backgroundTasksStore.reset();
    _resetOutboundQueueStorage();
  });

  test('ingests a delegate-thread event into backgroundTasksStore even though the thread is never a tracked chat (the #1301 §1.3 "precise missing projection")', () => {
    expect(
      activeChatsStore.getSnapshot()['task:delegate-untracked'],
    ).toBeUndefined();

    const ingestSpy = vi.spyOn(backgroundTasksStore, 'ingest');

    handleOrchestrationEvent(
      'http://api',
      event('session.started', {
        sessionId: 'task:delegate-untracked',
        metadata: {
          taskId: 'task:delegate-untracked',
          parentTaskId: 'chat-1',
        },
      }),
    );

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    // The store actually bound the delegate — proof this isn't just a
    // pass-through call that the guard immediately discarded downstream.
    expect(
      backgroundTasksStore.getSnapshot().delegateParents[
        'task:delegate-untracked'
      ],
    ).toBe('chat-1');

    ingestSpy.mockRestore();
  });

  test('does not treat a same-session turn.started event as proof for an unrelated foreground dispatch', async () => {
    let entries: unknown;
    _setOutboundQueueStorage({
      getItem: async () => entries,
      setItem: async (_key, next) => {
        entries = next;
      },
      updateItem: async (_key, updater) => {
        entries = updater(entries);
      },
    });
    await outboundDispatch.enqueue({
      clientTurnId: 'possible-start',
      sessionId: 'provider-session-1',
      agentSlug: 'assistant',
      content: 'may have started',
    });
    await outboundDispatch.flush(async (_turn, claim) => {
      await claim.indeterminate('receipt unavailable');
      return { kind: 'not-invoked' };
    });

    handleOrchestrationEvent(
      'http://api',
      event('turn.started', {
        threadId: 'provider-session-1',
        turnId: 'provider-turn-1',
      }),
    );

    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: 'possible-start',
        status: 'may-have-started',
      }),
    ]);
  });
});

describe('handleOrchestrationEvent — durable conversation child routing (#3937)', () => {
  const conversationId = 'conversation-root';
  const childSessionId = 'conversation-root:session:1';

  beforeEach(() => {
    activeChatsStore.removeChat(conversationId);
    activeChatsStore.initChat(conversationId, {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Conversation',
      conversationId,
      currentSessionId: childSessionId,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetOutboundQueueStorage();
    activeChatsStore.removeChat(conversationId);
  });

  test('routes a live child delta to the original conversation without changing event identity', () => {
    const child = event('content.text-delta', {
      threadId: childSessionId,
      itemId: 'text-1',
      delta: 'second answer',
    });

    handleOrchestrationEvent('http://api', child);

    expect(child.threadId).toBe(childSessionId);
    expect(
      activeChatsStore.getSnapshot()[conversationId]?.streamingMessage?.content,
    ).toBe('second answer');
    expect(activeChatsStore.getSnapshot()[childSessionId]).toBeUndefined();
  });

  test('a child runtime error settles the conversation-keyed durable turn and drains its follow-up queue', async () => {
    vi.useFakeTimers();
    let entries: unknown;
    _resetOutboundQueueStorage();
    _setOutboundQueueStorage({
      getItem: async () => entries,
      setItem: async (_key, next) => {
        entries = next;
      },
      updateItem: async (_key, updater) => {
        entries = updater(entries);
      },
    });
    await outboundDispatch.enqueue({
      clientTurnId: 'child-client-turn',
      sessionId: conversationId,
      conversationId,
      agentSlug: 'claude',
      content: 'first follow-up',
    });
    await outboundDispatch.flush(async () => {
      return { kind: 'accepted', providerTurnId: 'child-provider-turn' };
    });
    activeChatsStore.updateChat(conversationId, {
      queuedMessages: ['next follow-up'],
    });

    handleOrchestrationEvent(
      'http://api',
      event('runtime.error', {
        threadId: childSessionId,
        turnId: 'child-provider-turn',
        message: 'child failed',
      }),
    );

    expect(
      activeChatsStore.getSnapshot()[conversationId]?.queuedMessages,
    ).toEqual([]);
    await vi.dynamicImportSettled();
    expect(await outboundDispatch.snapshot()).toEqual([]);
  });
});

describe('handleOrchestrationEvent — station#3451 finding 7 (queue drain on runtime.error)', () => {
  const threadId = 'thread-runtime-error-drain';

  beforeEach(() => {
    // Real timers would let drainQueuedMessageOnTurnCompleted's setTimeout
    // fire later and reach the real network-touching sendExecutionMessage;
    // fake timers left un-advanced means it never fires in this test.
    vi.useFakeTimers();
    activeChatsStore.removeChat(threadId);
    activeChatsStore.initChat(threadId, {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: 'Claude Chat',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test.each(['turn.completed', 'runtime.error', 'turn.aborted'])(
    '%s remembers an exact Send now terminal while its stop receipt is pending',
    (method) => {
      activeChatsStore.updateChat(threadId, {
        queuedMessages: ['first', 'selected'],
        queuedMessageMetadata: [
          { id: 'first-id', mode: 'queue' },
          { id: 'selected-id', mode: 'queue' },
        ],
        orchestrationTurnOpen: true,
        openTurnId: 'exact-stop-turn',
        queueSendNowPending: true,
        pendingSendNow: {
          messageId: 'selected-id',
          threadId,
          turnId: 'exact-stop-turn',
        },
      });
      handleOrchestrationEvent(
        'http://api',
        event(method, {
          threadId,
          turnId: 'exact-stop-turn',
          message: 'terminal failure',
          reason: 'interrupted',
        }),
      );
      expect(
        activeChatsStore.getSnapshot()[threadId].pendingSendNow,
      ).toMatchObject({ terminalConfirmed: true });
      expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
        'first',
        'selected',
      ]);
    },
  );

  test('completion sends a deferred Send now selection before the ordinary queue head', () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['first', 'selected'],
      queuedMessageMetadata: [
        { id: 'first-id', mode: 'queue' },
        { id: 'selected-id', mode: 'queue' },
      ],
      orchestrationTurnOpen: true,
      openTurnId: 'exact-stop-turn',
      pendingSendNow: {
        messageId: 'selected-id',
        threadId,
        turnId: 'exact-stop-turn',
      },
    });
    handleOrchestrationEvent(
      'http://api',
      event('turn.completed', { threadId, turnId: 'exact-stop-turn' }),
    );
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'first',
    ]);
    expect(
      activeChatsStore.getSnapshot()[threadId].pendingQueueDispatch?.content,
    ).toBe('selected');
    expect(
      activeChatsStore.getSnapshot()[threadId].pendingSendNow,
    ).toBeUndefined();
  });

  test('a runtime.error drains a queued message (a message queued during the failed turn had no other trigger to ever send)', () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['queued follow-up'],
    });

    handleOrchestrationEvent(
      'http://api',
      event('runtime.error', { threadId, message: 'boom' }),
    );

    // drainQueuedMessageOnTurnCompleted shifts the queue head synchronously,
    // before its setTimeout-deferred send — proof this listener is wired.
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([]);
  });

  test('a runtime.error with no queued message is a no-op (nothing to drain)', () => {
    expect(() =>
      handleOrchestrationEvent(
        'http://api',
        event('runtime.error', { threadId, message: 'boom' }),
      ),
    ).not.toThrow();
    expect(
      activeChatsStore.getSnapshot()[threadId].queuedMessages ?? [],
    ).toEqual([]);
  });

  // archive#3451: the discriminating case — a codex
  // deferred-retriable runtime.error (willRetry: true) must NOT drain, since
  // codex may still resolve this same turn without a new turn.started. The
  // earlier "drains on a runtime.error" test above uses provider: 'claude'
  // (the event helper's default), so it never actually exercised this
  // gate — it would have passed identically with no gate at all.
  test('a codex deferred-retriable runtime.error does NOT drain a queued message', () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['queued follow-up'],
    });

    handleOrchestrationEvent(
      'http://api',
      event('runtime.error', {
        threadId,
        message: 'transient',
        provider: 'codex',
        retriable: true,
      }),
    );

    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'queued follow-up',
    ]);
  });

  // #3157: the failed turn stopped on a usage limit. Draining would send the
  // follow-up into the same limit and retire the resume waiting for the reset.
  test('a usage-limit runtime.error holds the queued message', () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['queued follow-up'],
    });

    handleOrchestrationEvent(
      'http://api',
      event('runtime.error', {
        threadId,
        message: "You've hit your usage limit.",
        provider: 'codex',
        code: 'usageLimitExceeded',
        retriable: false,
        details: {
          codexErrorInfo: 'usageLimitExceeded',
          usageLimit: true,
          scope: 'account',
          resetAt: '2026-07-29T05:00:00.000Z',
        },
      }),
    );

    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'queued follow-up',
    ]);
  });

  const usageLimitStop = () =>
    event('runtime.error', {
      threadId,
      turnId: 'limited-turn',
      message: "You've hit your usage limit.",
      provider: 'codex',
      code: 'usageLimitExceeded',
      retriable: false,
      details: { usageLimit: true, scope: 'account' },
    });

  test('a turn starting after a usage-limit stop lets its end drain the queue', () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['queued follow-up'],
    });
    handleOrchestrationEvent('http://api', usageLimitStop());
    expect(activeChatsStore.getSnapshot()[threadId].usageLimitStopped).toBe(
      true,
    );
    handleOrchestrationEvent(
      'http://api',
      event('turn.started', {
        threadId,
        turnId: 'resumed-turn',
        prompt: 'the resumed turn',
      }),
    );
    expect(
      activeChatsStore.getSnapshot()[threadId].usageLimitStopped,
    ).toBeUndefined();
    handleOrchestrationEvent(
      'http://api',
      event('turn.completed', {
        threadId,
        turnId: 'resumed-turn',
        finishReason: 'stop',
      }),
    );
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([]);
  });

  test('Send now still sends while a usage-limit stop holds the queue', () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['queued follow-up'],
    });
    handleOrchestrationEvent('http://api', usageLimitStop());
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'queued follow-up',
    ]);
    drainQueuedMessageOnTurnCompleted('http://api', threadId, true, true);
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([]);
  });

  // Negative control: a DEFINITIVE (non-retriable) codex runtime.error is
  // NOT deferred and must still drain.
  test('a definitive (non-retriable) codex runtime.error still drains', () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['queued follow-up'],
    });

    handleOrchestrationEvent(
      'http://api',
      event('runtime.error', {
        threadId,
        message: 'fatal',
        provider: 'codex',
        retriable: false,
      }),
    );

    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([]);
  });
});
