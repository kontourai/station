import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let drainQueuedMessageOnTurnCompleted: typeof import('../queueDrain').drainQueuedMessageOnTurnCompleted;
// Imported after resetModules so `instanceof` in queueDrain sees the same
// module instance the test constructs errors from.
let ChatHttpError: typeof import('@kontourai/station-sdk/client').ChatHttpError;

const sendExecutionMessageMock = vi.fn().mockResolvedValue(undefined);

const threadId = 'thread-drain-1';

describe('drainQueuedMessageOnTurnCompleted (#613)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    vi.resetModules();
    sendExecutionMessageMock.mockClear();

    vi.doMock('../../../contexts/active-chats-store', async () => {
      const actual = await vi.importActual<
        typeof import('../../../contexts/active-chats-store')
      >('../../../contexts/active-chats-store');
      const store = new actual.ActiveChatsStore({
        storage: { getItem: () => null, setItem: () => {} },
      });
      return { ...actual, activeChatsStore: store };
    });

    vi.doMock('../../useOrchestration', () => ({
      sendExecutionMessage: (...args: unknown[]) =>
        sendExecutionMessageMock(...args),
    }));

    vi.doMock('@kontourai/station-sdk', () => ({
      contextRegistry: { getComposedContext: () => undefined },
    }));

    ({ activeChatsStore } = await import(
      '../../../contexts/active-chats-store'
    ));
    ({ drainQueuedMessageOnTurnCompleted } = await import('../queueDrain'));
    ({ ChatHttpError } = await import('@kontourai/station-sdk/client'));

    activeChatsStore.initChat(threadId, {
      agentSlug: 'claude',
      agentName: 'Claude Runtime',
      title: 'Claude chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.doUnmock('../../useOrchestration');
    vi.doUnmock('@kontourai/station-sdk');
    vi.resetModules();
    vi.useRealTimers();
  });

  test('is a no-op when the queue is empty', async () => {
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
  });

  test('is a no-op while isEditingQueue is true', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['queued'],
      isEditingQueue: true,
    });

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);

    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'queued',
    ]);
  });

  test('#749 preserves queued text when a replayed terminal event arrives before open revalidation', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['do not shift'],
      conversationOpenPending: true,
    });

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);

    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'do not shift',
    ]);
  });

  test('#749 requeues the shifted head when open state changes during the settle delay', async () => {
    activeChatsStore.updateChat(threadId, { queuedMessages: ['race head'] });
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    // The first phase already shifted its head; resolution loses authority
    // before the delayed mutation/provider boundary.
    activeChatsStore.updateChat(threadId, { conversationOpenFailed: true });
    await vi.advanceTimersByTimeAsync(200);

    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'race head',
    ]);
  });

  test('pops the head synchronously, then dispatches the canonical Agent target after the settle delay', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['first', 'second'],
      projectSlug: 'station',
    });

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);

    // Popped synchronously so a second turn.completed racing in before the
    // settle delay elapses can't double-dispatch the same head message.
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'second',
    ]);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(sendExecutionMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBase: 'http://api.test',
        target: {
          agent: 'claude',
          workspace: { kind: 'project', projectSlug: 'station' },
        },
        conversationId: threadId,
        message: 'first',
      }),
    );
    expect(sendExecutionMessageMock.mock.calls[0][0].target).not.toHaveProperty(
      'environment',
    );
    const state = activeChatsStore.getSnapshot()[threadId];
    expect(state.status).toBe('sending');
    expect(state.messages?.[state.messages.length - 1]).toMatchObject({
      role: 'user',
      content: 'first',
    });
  });

  // archive#1293: buildOutgoingUserMessage mints a
  // clientId for the optimistic bubble this drain appends, but the failure
  // path used to discard it and only re-queue the TEXT — the failed
  // optimistic message stayed in `messages` forever, so a later successful
  // drain of the same (re-queued) text appended a SECOND optimistic entry:
  // a duplicate bubble on retry-after-failure.
  test('a failed drain rolls back its own optimistic message by id, so a later successful retry does not leave a duplicate', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['flaky message'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(new Error('network blip'));

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.status).toBe('error');
    expect(afterFailure.queuedMessages).toEqual(['flaky message']);
    // The failed attempt's own optimistic bubble must not remain stranded.
    expect(
      afterFailure.messages?.filter((m) => m.content === 'flaky message'),
    ).toHaveLength(0);
    expect(afterFailure.ephemeralMessages?.[0]?.content).toMatch(
      /failed to send/i,
    );

    // A later successful drain of the same re-queued text must not produce
    // a duplicate bubble.
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const afterRetry = activeChatsStore.getSnapshot()[threadId];
    expect(
      afterRetry.messages?.filter((m) => m.content === 'flaky message'),
    ).toHaveLength(1);
  });

  // archive#3027: a permanent 400-class refusal (e.g. the
  // authored-spec alias rejection) used to be requeued at the head on every
  // failure — an infinite refusal loop the user could never escape.
  test('a definitive 4xx rejection drops the entry instead of requeueing and surfaces the failure', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['refused message'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(400, 'Agent has no authored Agent definition.'),
    );

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    // archive#3706: a permanent queue refusal is not an error
    // state of the CHAT — the conversation is settled and the refusal is
    // carried by the unsent record. 'error' here made Home/inbox label the
    // chat "Failed" for a follow-up the agent never saw.
    expect(afterFailure.status).toBe('idle');
    expect(afterFailure.error).toBeUndefined();
    expect(afterFailure.queuedMessages).toEqual([]);
    // The dropped attempt's optimistic bubble must not remain stranded.
    expect(
      afterFailure.messages?.filter((m) => m.content === 'refused message'),
    ).toHaveLength(0);
    expect(afterFailure.ephemeralMessages?.[0]?.content).toMatch(
      /refused and removed from the queue/i,
    );
    // The notice echoes the text for immediate visibility…
    expect(afterFailure.ephemeralMessages?.[0]?.content).toContain(
      'refused message',
    );
    // …and archive#3706 makes it durable: ephemeral notices never survive a
    // reload (archive#1292), so the drop also writes an unsent record — the
    // one copy that persists until the user dismisses it.
    expect(afterFailure.unsentMessages).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        content: 'refused message',
        reason: expect.stringMatching(/authored Agent definition/i),
        at: expect.any(Number),
      }),
    ]);

    // The poison loop is the defect: a later turn completion must not
    // re-dispatch the dropped entry.
    sendExecutionMessageMock.mockClear();
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
  });

  // The screenshot defect behind station's chat-surface honesty pass: a raw
  // `Session state completed is terminal` sentence rode into the notice, and
  // `status: 'error'` branded the completed conversation "Failed" in the
  // inbox. A Station-side refusal on an ended session is not an agent
  // failure: the chat returns to idle, the notice says what happened in user
  // language, and the dropped text stays recoverable.
  test('an ended-session refusal drops the entry without marking the chat failed', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['test'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(
        400,
        'This session has already ended, so it cannot take another message. Start a new chat to continue.',
        'session_ended',
      ),
    );

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.status).toBe('idle');
    expect(afterFailure.error).toBeUndefined();
    expect(afterFailure.queuedMessages).toEqual([]);
    const notice = afterFailure.ephemeralMessages?.[0]?.content ?? '';
    expect(notice).toMatch(/already ended/i);
    // The notice echoes the text for immediate visibility.
    expect(notice).toContain('Your message: test');
    // The internal lifecycle sentence must not reach the user.
    expect(notice).not.toMatch(/terminal/i);
    // archive#3706: the durable record survives where the notice cannot, and
    // its reason is the user-language attribution, not the raw server prose.
    // Verbatim: a regex on /already ended/ also matched the RAW server prose
    // this record must not carry (archive#3706, verification gaps).
    expect(afterFailure.unsentMessages?.[0]?.reason).toBe(
      'This chat had already ended when Station tried to send it.',
    );
    expect(afterFailure.unsentMessages?.[0]?.id).toEqual(expect.any(String));
  });

  // The record is written ONLY on a permanent drop. A transient failure keeps
  // the text in `queuedMessages` (still durable, still retried) — writing an
  // unsent record there too would show the same text twice and imply the
  // retry had been given up on.
  test('a transient failure requeues without writing an unsent record', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['transient message'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.queuedMessages).toEqual(['transient message']);
    expect(afterFailure.unsentMessages).toBeUndefined();
  });

  // Two drops accumulate — the second must not overwrite the first: each row
  // is a distinct piece of user text.
  test('a second permanent drop appends to the existing unsent records', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['first refused'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(400, 'Refused once.'),
    );
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['second refused'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(400, 'Refused twice.'),
    );
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const records = activeChatsStore.getSnapshot()[threadId].unsentMessages;
    expect(records?.map((record) => record.content)).toEqual([
      'first refused',
      'second refused',
    ]);
    // Identity is `id`, not `at`: two drops in the same millisecond must
    // remain individually dismissable (archive#3706).
    expect(records?.[0]?.id).not.toBe(records?.[1]?.id);
  });

  test('an indeterminate 4xx refusal is still requeued — the turn may have started', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['maybe-started message'],
    });
    const indeterminate = new ChatHttpError(
      409,
      'Foreground message may have started.',
    );
    (indeterminate as unknown as { outcome: string }).outcome = 'indeterminate';
    sendExecutionMessageMock.mockRejectedValueOnce(indeterminate);

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.status).toBe('error');
    expect(afterFailure.queuedMessages).toEqual(['maybe-started message']);
    expect(afterFailure.ephemeralMessages?.[0]?.content).toMatch(
      /failed to send/i,
    );
  });

  test('keeps a queued direct-conversation follow-up when its workspace needs binding', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['keep this follow-up'],
    });
    const mismatch = new ChatHttpError(
      400,
      'This conversation belongs to a different workspace directory.',
    );
    (mismatch as unknown as { code: string }).code =
      'continuation_workspace_direct_mismatch';
    sendExecutionMessageMock.mockRejectedValueOnce(mismatch);

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.queuedMessages).toEqual(['keep this follow-up']);
    expect(afterFailure.ephemeralMessages?.[0]?.content).toMatch(
      /failed to send/i,
    );
    expect(afterFailure.ephemeralMessages?.[0]?.content).not.toMatch(
      /removed from the queue/i,
    );
  });

  // the retained text used to be the only thing kept — the reason
  // lived solely in an ephemeral notice, which is deliberately never persisted
  // (archive#1292), so a reload left a queued follow-up with no explanation.
  test('records the refusal on the chat so it survives with the retained message', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['keep this follow-up'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(
        400,
        'This conversation was started without a workspace, so it cannot be continued inside one.',
        'continuation_workspace_unbound',
      ),
    );

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.queuedMessages).toEqual(['keep this follow-up']);
    expect(afterFailure.queuedMessageFailure).toMatchObject({
      code: 'continuation_workspace_unbound',
      message:
        'This conversation was started without a workspace, so it cannot be continued inside one.',
    });
  });

  // Retry after an unbound-workspace refusal used
  // to resubmit the chat's unchanged projectSlug, which supplies the same
  // project workspace and reproduces the identical refusal — a button that
  // deterministically repeats a failure.
  test('a retry after an unbound-workspace refusal sends without the workspace', async () => {
    activeChatsStore.updateChat(threadId, {
      projectSlug: 'station',
      queuedMessages: ['keep this follow-up'],
      queuedMessageFailure: {
        message: 'This conversation was started without a workspace.',
        code: 'continuation_workspace_unbound',
        at: 1,
      },
    });
    sendExecutionMessageMock.mockResolvedValueOnce({ conversationId: 'c' });

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const sent = sendExecutionMessageMock.mock.calls.at(-1)?.[0];
    expect(sent.target.workspace).toBeUndefined();
    expect(sent.target.environment).toEqual({ kind: 'current' });
    //.and the user is told the follow-up did not go into the project.
    const notices = (
      activeChatsStore.getSnapshot()[threadId].ephemeralMessages ?? []
    ).map((message) => message.content);
    expect(notices.some((text) => /as it is/i.test(text ?? ''))).toBe(true);
  });

  test('a fresh drain clears the previous refusal rather than leaving a stale reason', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['retry me'],
      queuedMessageFailure: {
        message: 'an earlier refusal',
        code: 'continuation_workspace_unbound',
        at: 1,
      },
    });
    sendExecutionMessageMock.mockResolvedValueOnce({ conversationId: 'c' });

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    expect(
      activeChatsStore.getSnapshot()[threadId].queuedMessageFailure,
    ).toBeUndefined();
  });

  // The chat route's catch-all collapses server-declared-retryable refusals
  // into 400 with the error's code in the body — the drop discriminator must
  // consult the code, or adoption races would permanently discard queued
  // messages (archive#3027 fix-round).
  for (const retryableCode of ['adoption_continuation_in_progress']) {
    test(`a 400 carrying server-retryable code '${retryableCode}' is requeued, not dropped`, async () => {
      activeChatsStore.updateChat(threadId, {
        queuedMessages: ['transiently refused'],
      });
      sendExecutionMessageMock.mockRejectedValueOnce(
        new ChatHttpError(400, 'Refused for now.', retryableCode),
      );

      drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
      await vi.advanceTimersByTimeAsync(100);

      const afterFailure = activeChatsStore.getSnapshot()[threadId];
      expect(afterFailure.status).toBe('error');
      expect(afterFailure.queuedMessages).toEqual(['transiently refused']);
      expect(afterFailure.ephemeralMessages?.[0]?.content).toMatch(
        /failed to send/i,
      );
    });
  }

  test('a 401 auth refusal is requeued — re-pairing recovers it', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['auth-blocked message'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(401, 'Authentication required.'),
    );

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.queuedMessages).toEqual(['auth-blocked message']);
  });

  test('ignores a thread with no active chat', async () => {
    expect(() =>
      drainQueuedMessageOnTurnCompleted('http://api.test', 'missing-thread'),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(200);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
  });
});
