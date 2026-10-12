import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let resumePendingSendNowOnTurnTerminal: typeof import('../queueDrain').resumePendingSendNowOnTurnTerminal;
let sendPendingMessageNow: typeof import('../queueDrain').sendPendingMessageNow;
let drainQueuedMessageOnTurnCompleted: typeof import('../queueDrain').drainQueuedMessageOnTurnCompleted;
// Imported after resetModules so `instanceof` in queueDrain sees the same
// module instance the test constructs errors from.
let ChatHttpError: typeof import('@kontourai/station-sdk/client').ChatHttpError;

const interruptMock = vi.fn();
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
    interruptMock.mockReset();

    vi.doMock('../../../contexts/active-chats-store', async () => {
      const actual = await vi.importActual<
        typeof import('../../../contexts/active-chats-store')
      >('../../../contexts/active-chats-store');
      const store = new actual.ActiveChatsStore({
        storage: { getItem: () => null, setItem: () => {} },
      });
      return { ...actual, activeChatsStore: store };
    });

    vi.doMock('@kontourai/station-sdk/client', async () => ({
      ...(await vi.importActual<typeof import('@kontourai/station-sdk/client')>(
        '@kontourai/station-sdk/client',
      )),
      sendExecutionMessage: (...args: unknown[]) =>
        sendExecutionMessageMock(...args),
    }));

    vi.doMock('@kontourai/station-sdk', () => ({
      contextRegistry: { getComposedContext: () => undefined },
      interruptOrchestrationTurn: (...args: unknown[]) =>
        interruptMock(...args),
    }));

    ({ activeChatsStore } = await import(
      '../../../contexts/active-chats-store'
    ));
    ({
      drainQueuedMessageOnTurnCompleted,
      sendPendingMessageNow,
      resumePendingSendNowOnTurnTerminal,
    } = await import('../queueDrain'));
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
    vi.doUnmock('@kontourai/station-sdk/client');
    vi.doUnmock('@kontourai/station-sdk');
    vi.doUnmock('../../../lib/foregroundMessageDispatch');
    vi.resetModules();
    vi.useRealTimers();
  });

  test('Send now coalesces repeated clicks, stops once, and preserves remaining FIFO messages', async () => {
    let settle!: (value: unknown) => void;
    interruptMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['first', 'selected', 'third'],
      orchestrationTurnOpen: true,
      openTurnId: 'running',
      status: 'sending',
    });
    const id =
      activeChatsStore.getSnapshot()[threadId].queuedMessageMetadata![1].id;
    const first = sendPendingMessageNow('http://api.test', threadId, id);
    await vi.dynamicImportSettled();
    await sendPendingMessageNow('http://api.test', threadId, id);
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    settle({ outcome: 'cooperative', turnId: 'running' });
    await first;
    await sendPendingMessageNow('http://api.test', threadId, id);
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(interruptMock).toHaveBeenCalledTimes(1);
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(sendExecutionMessageMock.mock.calls[0][1]).toMatchObject({
      message: 'selected',
      clientTurnId: id,
    });
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'first',
      'third',
    ]);
  });

  test('a terminal event before dispatch acknowledgement still releases the next queued message', async () => {
    let acknowledge!: (receipt: unknown) => void;
    sendExecutionMessageMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['first', 'second'],
    });
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    activeChatsStore.updateChat(threadId, {
      status: 'idle',
      orchestrationTurnOpen: false,
    });
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    acknowledge({});
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(2);
    expect(sendExecutionMessageMock.mock.calls[1][1]).toMatchObject({
      message: 'second',
    });
  });

  test('reload retains a follow-up before the first conversation receipt and blocks unconfirmed dispatch', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['authored before first receipt'],
      queuedMessageMetadata: [{ id: 'first-receipt-pending', mode: 'queue' }],
    });
    const { serializeActiveChats } = await import(
      '../../../contexts/active-chats-state'
    );
    const saved = JSON.stringify(
      serializeActiveChats(activeChatsStore.getSnapshot()),
    );
    const { ActiveChatsStore } = await import(
      '../../../contexts/active-chats-store'
    );
    const reloaded = new ActiveChatsStore({
      storage: { getItem: () => saved, setItem: () => {} },
    });
    const recovered = reloaded.getSnapshot()[threadId];
    expect(recovered).toBeDefined();
    expect(recovered.queuedMessages).toEqual(['authored before first receipt']);
    expect(recovered.queuedMessageMetadata).toEqual([
      { id: 'first-receipt-pending', mode: 'queue' },
    ]);
    expect(recovered.queuedMessageFailure?.code).toBe('unconfirmed-first-send');
    const { conversationCanMutate } = await import(
      '../../../contexts/conversation-open-policy'
    );
    expect(conversationCanMutate(recovered)).toBe(false);
    activeChatsStore.updateChat(threadId, recovered);
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId, true, true);
    await vi.advanceTimersByTimeAsync(200);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
  });

  test('reload restores a claimed queue head with its original mode and dispatch identity', async () => {
    activeChatsStore.updateChat(threadId, {
      conversationId: 'persisted-conversation',
      queuedMessages: ['recover me', 'later'],
      queuedMessageMetadata: [
        { id: 'recover-id', mode: 'steer' },
        { id: 'later-id', mode: 'queue' },
      ],
    });
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    const { serializeActiveChats } = await import(
      '../../../contexts/active-chats-state'
    );
    const saved = JSON.stringify(
      serializeActiveChats(activeChatsStore.getSnapshot()),
    );
    const { ActiveChatsStore } = await import(
      '../../../contexts/active-chats-store'
    );
    const reloaded = new ActiveChatsStore({
      storage: { getItem: () => saved, setItem: () => {} },
    });
    expect(reloaded.getSnapshot()[threadId].queuedMessages).toEqual([
      'recover me',
      'later',
    ]);
    expect(reloaded.getSnapshot()[threadId].queuedMessageMetadata).toEqual([
      { id: 'recover-id', mode: 'steer' },
      { id: 'later-id', mode: 'queue' },
    ]);
    expect(reloaded.getSnapshot()[threadId].queueDrainHeldForOpen).toBe(true);
  });

  test('an unconfirmed Send now keeps the message and never dispatches it', async () => {
    interruptMock.mockRejectedValueOnce(new Error('response lost'));
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['held'],
      orchestrationTurnOpen: true,
      openTurnId: 'held-turn',
      status: 'sending',
    });
    const id =
      activeChatsStore.getSnapshot()[threadId].queuedMessageMetadata![0].id;
    await sendPendingMessageNow('http://api.test', threadId, id);
    await vi.advanceTimersByTimeAsync(200);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'held',
    ]);
    expect(activeChatsStore.getSnapshot()[threadId].queueSendNowPending).toBe(
      false,
    );
  });

  test('deferred Send now resumes only its selected message after the exact interrupted turn ends', async () => {
    interruptMock.mockResolvedValueOnce({
      outcome: 'pending-turn-start',
      threadId,
    });
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['first', 'selected'],
      orchestrationTurnOpen: true,
      openTurnId: 'stop-target',
      status: 'sending',
    });
    const id =
      activeChatsStore.getSnapshot()[threadId].queuedMessageMetadata![1].id;
    await sendPendingMessageNow('http://api.test', threadId, id);
    expect(
      activeChatsStore.getSnapshot()[threadId].pendingSendNow,
    ).toMatchObject({ messageId: id, turnId: 'stop-target' });
    activeChatsStore.updateChat(threadId, {
      orchestrationTurnOpen: false,
      status: 'idle',
      orchestrationStatus: 'aborted',
    });
    resumePendingSendNowOnTurnTerminal(
      'http://api.test',
      threadId,
      'other-turn',
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    resumePendingSendNowOnTurnTerminal(
      'http://api.test',
      threadId,
      'stop-target',
    );
    resumePendingSendNowOnTurnTerminal(
      'http://api.test',
      threadId,
      'stop-target',
    );
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(sendExecutionMessageMock.mock.calls[0][1]).toMatchObject({
      message: 'selected',
      clientTurnId: id,
    });
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'first',
    ]);
  });

  test('safe fallback waits for turn completion even when no tool is active', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['safe steer'],
      queuedMessageMetadata: [{ id: 'pending-steer', mode: 'steer' }],
      orchestrationTurnOpen: true,
    });
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(interruptMock).not.toHaveBeenCalled();
    activeChatsStore.updateChat(threadId, { orchestrationTurnOpen: false });
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(sendExecutionMessageMock.mock.calls[0][1]).toMatchObject({
      message: 'safe steer',
      clientTurnId: 'pending-steer',
    });
  });

  test('is a no-op when the queue is empty', async () => {
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
  });

  test('is a no-op while isEditingQueue is true', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['queued'],
      isEditingQueue: true,
    });

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();

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
    await vi.dynamicImportSettled();

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
    await vi.dynamicImportSettled();

    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([
      'race head',
    ]);
  });

  test('retains queued text when the lazy send module cannot load', async () => {
    vi.doMock('../../../lib/foregroundMessageDispatch', () => {
      throw new Error('Send chunk unavailable');
    });
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['first', 'second'],
    });
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
    expect(activeChatsStore.getSnapshot()[threadId]).toMatchObject({
      queuedMessages: ['first', 'second'],
      queuedMessageFailure: {
        message: expect.stringContaining('error when mocking a module'),
      },
    });
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
    await vi.dynamicImportSettled();

    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    expect(sendExecutionMessageMock).toHaveBeenCalledWith(
      'http://api.test',
      expect.objectContaining({
        target: {
          agent: 'claude',
          workspace: { kind: 'project', projectSlug: 'station' },
        },
        conversationId: threadId,
        message: 'first',
      }),
      { signal: undefined },
    );
    expect(sendExecutionMessageMock.mock.calls[0][1].target).not.toHaveProperty(
      'environment',
    );
    const state = activeChatsStore.getSnapshot()[threadId];
    expect(sendExecutionMessageMock.mock.calls[0][1].clientTurnId).toBe(
      state.messages?.[state.messages.length - 1].clientId,
    );
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
    await vi.dynamicImportSettled();

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
    await vi.dynamicImportSettled();

    const afterRetry = activeChatsStore.getSnapshot()[threadId];
    expect(
      afterRetry.messages?.filter((m) => m.content === 'flaky message'),
    ).toHaveLength(1);
  });

  test('a user-initiated send that cannot start says why, as a send-failure notice', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['held message'],
      isEditingQueue: true,
    });

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId, true, true);

    const notice =
      activeChatsStore.getSnapshot()[threadId].ephemeralMessages?.[0];
    expect(notice?.content).toBe(
      'Finish editing the queued message first, then send it.',
    );
    expect(notice?.sendFailure).toBe(true);
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
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
    await vi.dynamicImportSettled();

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
    // The short-dock composer repeats it: it is a send that did not go.
    expect(afterFailure.ephemeralMessages?.[0]?.sendFailure).toBe(true);
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
    interruptMock.mockReset();
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
  });

  // #2708 A-3a: a send refused by the validation middleware, as the REAL
  // execution fetcher throws it, is recorded by its reason, not its field key.
  test('a validation refusal from the real fetcher is recorded by its reason', async () => {
    const actual = await vi.importActual<
      typeof import('@kontourai/station-sdk/client')
    >('@kontourai/station-sdk/client');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: 'Validation failed',
            details: {
              formErrors: [],
              fieldErrors: { message: ['Write a message to send.'] },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const refusal = await actual
      .sendExecutionMessage('http://api.test', {} as never)
      .catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(ChatHttpError);
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['refused message'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(refusal);

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);
    await vi.dynamicImportSettled();

    expect(activeChatsStore.getSnapshot()[threadId].unsentMessages).toEqual([
      expect.objectContaining({ reason: 'Write a message to send.' }),
    ]);
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
    await vi.dynamicImportSettled();

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.status).toBe('idle');
    expect(afterFailure.error).toBeUndefined();
    expect(afterFailure.queuedMessages).toEqual([]);
    expect(afterFailure.ephemeralMessages?.[0]?.sendFailure).toBe(true);
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
    await vi.dynamicImportSettled();

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.queuedMessages).toEqual(['transient message']);
    expect(afterFailure.unsentMessages).toBeUndefined();
  });

  // #2708 A-3a review: only Station's own refusal is definitive. A proxy's
  // page keeps its status on the error but must not drop the person's
  // message; a 5xx is never definitive. Driven through the REAL execution
  // fetcher so the flag the drain reads is the one the fetcher derives.
  const html = (status: number) =>
    new Response('<html>Forbidden</html>', {
      status,
      headers: { 'content-type': 'text/html' },
    });
  const envelope = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  test.each([
    ['a proxy HTML 403', 'requeued', () => html(403)],
    ['a proxy HTML 404', 'requeued', () => html(404)],
    [
      'a gateway JSON 403 that is not an envelope',
      'requeued',
      () => envelope(403, { message: 'Forbidden' }),
    ],
    ['a proxy HTML 502', 'requeued', () => html(502)],
    [
      'a Station 500 refusal',
      'requeued',
      () => envelope(500, { success: false, error: 'Station failed.' }),
    ],
    [
      'a Station 400 refusal',
      'dropped',
      () =>
        envelope(400, {
          success: false,
          error: 'Agent has no authored Agent definition.',
        }),
    ],
  ] as const)(
    '%s from the real fetcher is %s',
    async (_name, verdict, answer) => {
      const actual = await vi.importActual<
        typeof import('@kontourai/station-sdk/client')
      >('@kontourai/station-sdk/client');
      vi.stubGlobal('fetch', async () => answer());
      sendExecutionMessageMock.mockImplementationOnce(
        (...args: Parameters<typeof actual.sendExecutionMessage>) =>
          actual.sendExecutionMessage(...args),
      );
      activeChatsStore.updateChat(threadId, {
        queuedMessages: ['queued message'],
      });

      drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
      await vi.advanceTimersByTimeAsync(100);
      await vi.dynamicImportSettled();

      expect(sendExecutionMessageMock).toHaveBeenCalledOnce();
      const after = activeChatsStore.getSnapshot()[threadId];
      if (verdict === 'dropped') {
        expect(after.queuedMessages).toEqual([]);
        expect(after.unsentMessages).toEqual([
          expect.objectContaining({ content: 'queued message' }),
        ]);
      } else {
        expect(after.queuedMessages).toEqual(['queued message']);
        expect(after.unsentMessages).toBeUndefined();
      }
    },
  );

  // #2842: a gateway can answer with JSON in exactly Station's shape, so the
  // shape cannot say who refused. Once this Station has sent its marker, a
  // refusal without it came from something in between and keeps the message.
  // The REAL fetcher both learns the marker and derives the flag.
  test.each([
    [
      "a gateway JSON 403 in Station's shape, without the marker",
      'requeued',
      403,
      { error: { code: 'forbidden' } },
      {},
    ],
    [
      'a gateway JSON 400 with success:false, without the marker',
      'requeued',
      400,
      { success: false, error: 'Blocked by policy.' },
      {},
    ],
    [
      'a Station 400 with the marker',
      'dropped',
      400,
      { success: false, error: 'Agent has no authored Agent definition.' },
      { 'x-station-envelope': '1' },
    ],
  ] as const)(
    'after Station has sent its marker, %s is %s',
    async (_name, verdict, status, body, markerHeaders) => {
      const actual = await vi.importActual<
        typeof import('@kontourai/station-sdk/client')
      >('@kontourai/station-sdk/client');
      const apiBase = 'http://marking-station.test';
      const answers = [
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-station-envelope': '1',
          },
        }),
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', ...markerHeaders },
        }),
      ];
      vi.stubGlobal('fetch', async () => answers.shift());
      // Any ordinary read: the first marked answer from this origin.
      await actual.fetchAgentsBare(apiBase);
      sendExecutionMessageMock.mockImplementationOnce(
        (...args: Parameters<typeof actual.sendExecutionMessage>) =>
          actual.sendExecutionMessage(...args),
      );
      activeChatsStore.updateChat(threadId, {
        queuedMessages: ['queued message'],
      });

      drainQueuedMessageOnTurnCompleted(apiBase, threadId);
      await vi.advanceTimersByTimeAsync(100);
      await vi.dynamicImportSettled();

      expect(sendExecutionMessageMock).toHaveBeenCalledOnce();
      expect(answers).toEqual([]);
      const after = activeChatsStore.getSnapshot()[threadId];
      if (verdict === 'dropped') {
        expect(after.queuedMessages).toEqual([]);
        expect(after.unsentMessages).toEqual([
          expect.objectContaining({ content: 'queued message' }),
        ]);
      } else {
        expect(after.queuedMessages).toEqual(['queued message']);
        expect(after.unsentMessages).toBeUndefined();
      }
    },
  );

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
    await vi.dynamicImportSettled();

    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['second refused'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(400, 'Refused twice.'),
    );
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);
    await vi.dynamicImportSettled();

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
    await vi.dynamicImportSettled();

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
    await vi.dynamicImportSettled();

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
    await vi.dynamicImportSettled();

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
    await vi.dynamicImportSettled();

    const sent = sendExecutionMessageMock.mock.calls.at(-1)?.[1];
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
    await vi.dynamicImportSettled();

    expect(
      activeChatsStore.getSnapshot()[threadId].queuedMessageFailure,
    ).toBeUndefined();
  });

  // The chat route's catch-all collapses server-declared-retryable refusals
  // into 400 with the error's code in the body — the drop discriminator must
  // consult the code, or adoption races would permanently discard queued
  // messages (archive#3027 fix-round).
  for (const retryableCode of [
    'adoption_continuation_in_progress',
    'resource_engine_start_capacity',
    // #2300: a Muse send refused while the previous process was exiting.
    'muse_turn_slot_releasing',
  ]) {
    test(`a 400 carrying server-retryable code '${retryableCode}' is requeued, not dropped`, async () => {
      activeChatsStore.updateChat(threadId, {
        queuedMessages: ['transiently refused'],
      });
      sendExecutionMessageMock.mockRejectedValueOnce(
        new ChatHttpError(400, 'Refused for now.', retryableCode),
      );

      drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
      await vi.advanceTimersByTimeAsync(100);
      await vi.dynamicImportSettled();

      const afterFailure = activeChatsStore.getSnapshot()[threadId];
      expect(afterFailure.status).toBe('error');
      expect(afterFailure.queuedMessages).toEqual(['transiently refused']);
      expect(afterFailure.ephemeralMessages?.[0]?.content).toMatch(
        /failed to send/i,
      );
    });
  }

  test('#2324 (D4, review L2): a send refused because the engine is replying on its own waits in the queue — and is re-sent when no turn would drain it', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['after the reply'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(
        400,
        'The agent is replying on its own; your message will be sent when it finishes.',
        'provider_turn_in_progress',
      ),
    );

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);
    await vi.dynamicImportSettled();

    const waiting = activeChatsStore.getSnapshot()[threadId];
    // Waiting, not failed: no error state, no failure notice.
    expect(waiting.status).not.toBe('error');
    expect(waiting.error).toBeUndefined();
    expect(waiting.queuedMessages).toEqual(['after the reply']);
    expect(waiting.ephemeralMessages ?? []).toEqual([]);
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);

    // The provider turn's end already passed (no turn is open), so nothing
    // else would drain it: it is re-sent after the retry delay.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(100);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(2);
    expect(activeChatsStore.getSnapshot()[threadId].queuedMessages).toEqual([]);
  });

  test('#2324 delta review: a pending provider-turn retry is dropped when the chat was removed before it fires', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['after the reply'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(
        400,
        'The agent is replying on its own; your message will be sent when it finishes.',
        'provider_turn_in_progress',
      ),
    );
    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
    activeChatsStore.removeChat(threadId);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).toHaveBeenCalledTimes(1);
  });

  test('a 401 auth refusal is requeued — re-pairing recovers it', async () => {
    activeChatsStore.updateChat(threadId, {
      queuedMessages: ['auth-blocked message'],
    });
    sendExecutionMessageMock.mockRejectedValueOnce(
      new ChatHttpError(401, 'Authentication required.'),
    );

    drainQueuedMessageOnTurnCompleted('http://api.test', threadId);
    await vi.advanceTimersByTimeAsync(100);
    await vi.dynamicImportSettled();

    const afterFailure = activeChatsStore.getSnapshot()[threadId];
    expect(afterFailure.queuedMessages).toEqual(['auth-blocked message']);
  });

  test('ignores a thread with no active chat', async () => {
    expect(() =>
      drainQueuedMessageOnTurnCompleted('http://api.test', 'missing-thread'),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(sendExecutionMessageMock).not.toHaveBeenCalled();
  });
});
