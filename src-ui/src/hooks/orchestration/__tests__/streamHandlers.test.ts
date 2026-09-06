// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// archive#3117: `handleToolCompletedEvent` is the LIVE tool-outcome path —
// reached from `handleOrchestrationEvent` for every foreground chat — unlike
// the dead `ToolLifecycleHandler`/`handleStreamEvent` these tests replaced
// (archive#3168 finished removing both: `ToolLifecycleHandler.ts` and its
// test file are deleted, and `useStreamingMessage.ts` no longer exposes
// `handleStreamEvent`). A fresh, isolated store instance per test avoids
// sessionStorage bleed between tests and sessions.
let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let handleToolStartedEvent: typeof import('../streamHandlers').handleToolStartedEvent;
let handleToolCompletedEvent: typeof import('../streamHandlers').handleToolCompletedEvent;
let handleTextDeltaEvent: typeof import('../streamHandlers').handleTextDeltaEvent;
// archive#3351: spies on the messageParts module (see the doMock in the
// text-delta describe below) to prove the dedup actually removed the
// duplicated per-token work.
let upsertTextPartCalls = 0;

const threadId = 'thread-tool-outcome-1';

function toolCompleted(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-1',
    provider: 'station-agent',
    threadId,
    createdAt: '2026-08-15T00:00:00.000Z',
    method: 'tool.completed',
    itemId: 'tool-1',
    toolCallId: 'tool-1',
    toolName: 'write_file',
    status: 'success',
    ...overrides,
  } as unknown as Parameters<typeof handleToolCompletedEvent>[0];
}

describe('handleToolCompletedEvent — tool outcome truth (station#3113, #3117)', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    vi.resetModules();

    vi.doMock('../../../contexts/active-chats-store', async () => {
      const actual = await vi.importActual<
        typeof import('../../../contexts/active-chats-store')
      >('../../../contexts/active-chats-store');
      const store = new actual.ActiveChatsStore({
        storage: { getItem: () => null, setItem: () => {} },
      });
      return { ...actual, activeChatsStore: store };
    });

    ({ activeChatsStore } = await import(
      '../../../contexts/active-chats-store'
    ));
    ({ handleToolStartedEvent, handleToolCompletedEvent } = await import(
      '../streamHandlers'
    ));

    activeChatsStore.initChat(threadId, {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.doUnmock('../messageParts');
    vi.resetModules();
  });

  function toolPart() {
    const parts =
      activeChatsStore.getSnapshot()[threadId]?.streamingMessage
        ?.contentParts ?? [];
    return parts.find((part) => part.type === 'tool-invocation');
  }

  test('a successful tool call renders no error and no approval badge (negative control)', () => {
    handleToolCompletedEvent(
      toolCompleted({ status: 'success', output: { ok: true } }),
    );

    const part = toolPart();
    expect(part).toMatchObject({ state: 'completed', isError: false });
    expect(part?.sourceEventId).toBe('evt-1');
    expect(part?.error).toBeUndefined();
    expect(part?.approvalStatus).toBeUndefined();
  });

  test('keeps simultaneous terminal results with one call id distinct by source event id', () => {
    handleToolCompletedEvent(
      toolCompleted({
        eventId: 'result-a',
        output: { uiBlocks: [{ type: 'card', title: 'A', body: 'first' }] },
      }),
    );
    handleToolCompletedEvent(
      toolCompleted({
        eventId: 'result-b',
        output: { uiBlocks: [{ type: 'card', title: 'B', body: 'second' }] },
      }),
    );
    const tools = (
      activeChatsStore.getSnapshot()[threadId]?.streamingMessage
        ?.contentParts ?? []
    ).filter((part) => part.type === 'tool-invocation');
    expect(tools).toHaveLength(2);
    expect(tools.map((part) => part.sourceEventId)).toEqual([
      'result-a',
      'result-b',
    ]);
    const blocks = (
      activeChatsStore.getSnapshot()[threadId]?.streamingMessage
        ?.contentParts ?? []
    ).filter((part) => part.type === 'ui-block');
    expect(blocks).toHaveLength(2);
    expect(blocks.map((part) => part.sourceEventId)).toEqual([
      'result-a',
      'result-b',
    ]);
  });

  test('keeps a corrupt result without an event id observable but does not pin its UI blocks', () => {
    handleToolCompletedEvent(
      toolCompleted({
        eventId: undefined,
        status: 'error',
        error: 'result event identity missing',
        output: {
          uiBlocks: [{ type: 'card', title: 'Unpinnable', body: 'result' }],
        },
      }),
    );

    expect(toolPart()).toMatchObject({
      state: 'error',
      isError: true,
      error: 'result event identity missing',
    });
    expect(
      activeChatsStore
        .getSnapshot()
        [threadId]?.streamingMessage?.contentParts?.filter(
          (part) => part.type === 'ui-block',
        ),
    ).toEqual([]);
  });

  test('does not revive a settled call when the provider reuses its call id', () => {
    const started = (eventId: string, args: unknown) =>
      ({
        eventId,
        provider: 'station-agent',
        threadId,
        createdAt: '2026-08-15T00:00:00.000Z',
        method: 'tool.started',
        itemId: eventId,
        toolCallId: 'reused-call',
        toolName: 'shell',
        arguments: args,
      }) as unknown as Parameters<typeof handleToolStartedEvent>[0];
    handleToolStartedEvent(started('start-a', { command: 'first' }));
    handleToolCompletedEvent(
      toolCompleted({
        eventId: 'result-a',
        toolCallId: 'reused-call',
        toolName: 'shell',
        output: { uiBlocks: [{ type: 'card', title: 'A', body: 'first' }] },
      }),
    );
    handleToolStartedEvent(started('start-b', { command: 'second' }));
    handleToolCompletedEvent(
      toolCompleted({
        eventId: 'result-b',
        toolCallId: 'reused-call',
        toolName: 'shell',
        output: { uiBlocks: [{ type: 'card', title: 'B', body: 'second' }] },
      }),
    );
    // Duplicate delivery updates only the exact second terminal result.
    handleToolCompletedEvent(
      toolCompleted({
        eventId: 'result-b',
        toolCallId: 'reused-call',
        toolName: 'shell',
        output: { uiBlocks: [{ type: 'card', title: 'B', body: 'second' }] },
      }),
    );
    const parts =
      activeChatsStore.getSnapshot()[threadId]?.streamingMessage
        ?.contentParts ?? [];
    const tools = parts.filter((part) => part.type === 'tool-invocation');
    expect(tools).toHaveLength(2);
    expect(tools.map((part) => [part.sourceEventId, part.args])).toEqual([
      ['result-a', { command: 'first' }],
      ['result-b', { command: 'second' }],
    ]);
    const blocks = parts.filter((part) => part.type === 'ui-block');
    expect(blocks).toHaveLength(2);
    expect(blocks.map((part) => part.sourceEventId)).toEqual([
      'result-a',
      'result-b',
    ]);
  });

  // #3113: an ordinary (non-policy) failed tool call must render as failed —
  // and, since it carries no `policyDenied` marker, must NOT be labeled
  // policy-denied. Absence of the marker means "we don't know why this
  // failed", never "policy denied it" (the same discipline #3091 applied).
  test('an ordinary failed tool call sets isError/error but no approvalStatus', () => {
    handleToolCompletedEvent(
      toolCompleted({ status: 'error', error: 'Tool call failed.' }),
    );

    const part = toolPart();
    expect(part).toMatchObject({
      state: 'error',
      isError: true,
      error: 'Tool call failed.',
    });
    expect(part?.approvalStatus).toBeUndefined();
  });

  // archive#3167: cancelling is a correct user-initiated outcome, not a
  // failure — `isError` must stay false so nothing downstream that counts
  // failures starts counting cancellations (mirrored on the rehydrated
  // side by runtime-event-projection.test.ts).
  test('a cancelled tool call renders the cancelled state, not error or success, and isError is false', () => {
    handleToolCompletedEvent(toolCompleted({ status: 'cancelled' }));

    const part = toolPart();
    expect(part).toMatchObject({ state: 'cancelled', isError: false });
    expect(part?.approvalStatus).toBeUndefined();
  });

  // station#1558: the session ended with the call still open. Neither
  // `error` (nothing observed the tool fail) nor `cancelled` (nobody asked
  // it to stop) nor `completed` (there is no result).
  test('an unresolved tool call renders the unresolved state, not error, and isError is false', () => {
    handleToolCompletedEvent(
      toolCompleted({
        status: 'unresolved',
        output:
          'No result was reported before the session ended; whether the tool ran is unknown.',
      }),
    );

    const part = toolPart();
    expect(part).toMatchObject({ state: 'unresolved', isError: false });
    expect(part?.error).toBeUndefined();
    expect(part?.approvalStatus).toBeUndefined();
  });

  // #3117: the live-path derivation this issue exists to add. Only ever set
  // from the event's own `policyDenied` marker — never inferred from
  // `status === 'error'` alone.
  test('a policy-denied tool call sets approvalStatus to policy-denied on the LIVE path', () => {
    const reason =
      "Tool 'write_file' was blocked by the config-protection policy: writes require review";
    handleToolCompletedEvent(
      toolCompleted({ status: 'error', error: reason, policyDenied: true }),
    );

    const part = toolPart();
    expect(part).toMatchObject({
      approvalStatus: 'policy-denied',
      error: reason,
      state: 'error',
      isError: true,
    });
  });

  test('policyDenied overrides a call-time auto-approved label (config-protection runs before the auto-approve check)', () => {
    handleToolStartedEvent({
      eventId: 'evt-0',
      provider: 'station-agent',
      threadId,
      createdAt: '2026-08-15T00:00:00.000Z',
      method: 'tool.started',
      itemId: 'tool-1',
      toolCallId: 'tool-1',
      toolName: 'write_file',
    } as unknown as Parameters<typeof handleToolStartedEvent>[0]);
    // Simulate an optimistic auto-approved label set upstream of the
    // tool-result event (this handler itself never sets one — see
    // approvalHandlers.ts for the real request.opened/resolved source).
    const chat = activeChatsStore.getSnapshot()[threadId]!;
    activeChatsStore.updateChat(threadId, {
      streamingMessage: {
        ...chat.streamingMessage!,
        contentParts: chat.streamingMessage!.contentParts!.map((part) =>
          part.type === 'tool-invocation'
            ? { ...part, approvalStatus: 'auto-approved' as const }
            : part,
        ),
      },
    });
    expect(toolPart()?.approvalStatus).toBe('auto-approved');

    handleToolCompletedEvent(
      toolCompleted({
        status: 'error',
        error: 'blocked by policy',
        policyDenied: true,
      }),
    );

    expect(toolPart()?.approvalStatus).toBe('policy-denied');
  });

  // Pin archive#1834's existing behaviour: a genuine user decline (set by
  // useToolApproval.ts's optimistic click handler, upstream of any
  // tool-result event) is untouched when the result carries no policyDenied
  // marker — #3117 must not weaken it.
  test('a pre-existing user-denied approvalStatus is left alone when the result carries no policyDenied marker', () => {
    handleToolStartedEvent({
      eventId: 'evt-0',
      provider: 'station-agent',
      threadId,
      createdAt: '2026-08-15T00:00:00.000Z',
      method: 'tool.started',
      itemId: 'tool-1',
      toolCallId: 'tool-1',
      toolName: 'fs_write',
    } as unknown as Parameters<typeof handleToolStartedEvent>[0]);
    const chat = activeChatsStore.getSnapshot()[threadId]!;
    activeChatsStore.updateChat(threadId, {
      streamingMessage: {
        ...chat.streamingMessage!,
        contentParts: chat.streamingMessage!.contentParts!.map((part) =>
          part.type === 'tool-invocation'
            ? {
                ...part,
                approvalStatus: 'user-denied' as const,
                cancelled: true,
              }
            : part,
        ),
      },
    });

    handleToolCompletedEvent(
      toolCompleted({
        toolCallId: 'tool-1',
        status: 'error',
        error:
          "Tool 'fs_write' was denied: the user declined the approval request.",
      }),
    );

    expect(toolPart()?.approvalStatus).toBe('user-denied');
  });

  // station#1558 Part A (live side): the durable projection folds a late
  // result onto the turn its `turnId` names; this handler used to fold every
  // result into whatever message is streaming right now.
  describe('a late result settles on the message that holds its call (station#1558)', () => {
    function seedTwoMessages(openCallId: string) {
      activeChatsStore.updateChat(threadId, {
        messages: [
          {
            role: 'assistant',
            content: 'A is working.',
            turnId: 'turn-a',
            contentParts: [
              { type: 'text', content: 'A is working.' },
              {
                type: 'tool-invocation',
                toolCallId: openCallId,
                toolName: 'write_file',
                args: { path: 'a.txt' },
                state: 'running',
              },
            ],
          },
          {
            role: 'user',
            content: 'and now this',
          },
        ],
        streamingMessage: {
          role: 'assistant',
          content: 'B answers.',
          contentParts: [{ type: 'text', content: 'B answers.' }],
        },
      });
    }

    const historyParts = (index: number) =>
      activeChatsStore.getSnapshot()[threadId]?.messages?.[index]
        ?.contentParts ?? [];
    const streamingParts = () =>
      activeChatsStore.getSnapshot()[threadId]?.streamingMessage
        ?.contentParts ?? [];

    test("settles the earlier message's open call there, and adds no row to the streaming turn", () => {
      seedTwoMessages('tool-1');

      handleToolCompletedEvent(
        toolCompleted({
          turnId: 'turn-a',
          status: 'success',
          output: 'late output',
        }),
      );

      const settled = historyParts(0).filter(
        (part) => part.type === 'tool-invocation',
      );
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        toolCallId: 'tool-1',
        state: 'completed',
        isError: false,
        result: 'late output',
        sourceEventId: 'evt-1',
      });
      expect(
        streamingParts().filter((part) => part.type === 'tool-invocation'),
      ).toHaveLength(0);
    });

    test('puts a start-less late result on the turn its own turnId names, never on the streaming turn', () => {
      seedTwoMessages('tool-1');

      handleToolCompletedEvent(
        toolCompleted({
          eventId: 'evt-orphan',
          turnId: 'turn-a',
          toolCallId: 'orphan-call',
          status: 'success',
          output: 'orphan output',
        }),
      );

      const tools = historyParts(0).filter(
        (part) => part.type === 'tool-invocation',
      );
      expect(tools.map((part) => part.toolCallId)).toEqual([
        'tool-1',
        'orphan-call',
      ]);
      expect(
        streamingParts().filter((part) => part.type === 'tool-invocation'),
      ).toHaveLength(0);
    });

    // Fix round (M2): the historical scan must respect the turn the event
    // names, or a reused call id settles the older row with the newer turn's
    // result.
    test("does not settle an earlier message's row when the result names another turn", () => {
      seedTwoMessages('tool-1');
      // Give the second message a turn identity so the event has somewhere
      // honest to land.
      const chat = activeChatsStore.getSnapshot()[threadId]!;
      activeChatsStore.updateChat(threadId, {
        messages: [
          chat.messages![0],
          { ...chat.messages![1], role: 'assistant', turnId: 'turn-b' },
        ],
      });

      handleToolCompletedEvent(
        toolCompleted({ turnId: 'turn-b', status: 'success', output: 'B' }),
      );

      // turn-a's open row is untouched…
      const aTools = historyParts(0).filter(
        (part) => part.type === 'tool-invocation',
      );
      expect(aTools).toHaveLength(1);
      expect(aTools[0]).toMatchObject({ state: 'running' });
      expect(aTools[0]?.result).toBeUndefined();
      // …and the result went to the turn it names.
      const bTools = historyParts(1).filter(
        (part) => part.type === 'tool-invocation',
      );
      expect(bTools).toHaveLength(1);
      expect(bTools[0]).toMatchObject({
        toolCallId: 'tool-1',
        state: 'completed',
        result: 'B',
      });
    });

    // station#1569 (item 2): the OTHER half of the M2 rule — a committed row
    // with no turn identity of its own is deliberately NOT a mismatch. Only
    // prose said so; these execute the branch (`candidate.turnId !==
    // undefined` is what makes it fall through) and pin the consequence,
    // including the one it accepts.
    describe('a row with no turn identity (station#1569 item 2)', () => {
      /** The pre-turnId shape: a committed assistant row holding an open
       * call, with no `turnId` on the message at all. */
      function seedUnidentifiedRow() {
        activeChatsStore.updateChat(threadId, {
          messages: [
            {
              role: 'assistant',
              content: 'Older client, no turn identity.',
              contentParts: [
                { type: 'text', content: 'Older client, no turn identity.' },
                {
                  type: 'tool-invocation',
                  toolCallId: 'tool-1',
                  toolName: 'write_file',
                  args: { path: 'a.txt' },
                  state: 'running',
                },
              ],
            },
          ],
          streamingMessage: {
            role: 'assistant',
            content: 'B answers.',
            contentParts: [{ type: 'text', content: 'B answers.' }],
          },
        });
      }

      test('is settled by a completion that names a turn, rather than stranded', () => {
        seedUnidentifiedRow();

        handleToolCompletedEvent(
          toolCompleted({
            turnId: 'turn-b',
            status: 'success',
            output: 'late output',
          }),
        );

        const settled = historyParts(0).filter(
          (part) => part.type === 'tool-invocation',
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({
          toolCallId: 'tool-1',
          state: 'completed',
          result: 'late output',
        });
        // Rejecting it would have appended a second, result-only row to the
        // streaming turn and left this one running forever.
        expect(
          streamingParts().filter((part) => part.type === 'tool-invocation'),
        ).toHaveLength(0);
      });

      test('loses to a row that DOES name the completion turn when the call id is reused', () => {
        seedUnidentifiedRow();
        const chat = activeChatsStore.getSnapshot()[threadId]!;
        activeChatsStore.updateChat(threadId, {
          messages: [
            chat.messages![0],
            {
              role: 'assistant',
              content: 'B is working.',
              turnId: 'turn-b',
              contentParts: [
                {
                  type: 'tool-invocation',
                  toolCallId: 'tool-1',
                  toolName: 'write_file',
                  args: { path: 'b.txt' },
                  state: 'running',
                },
              ],
            },
          ],
        });

        handleToolCompletedEvent(
          toolCompleted({ turnId: 'turn-b', status: 'success', output: 'B' }),
        );

        // The scan runs newest-first and stops at the first row that does not
        // contradict the named turn, so the row that actually claims turn-b
        // wins over the one that claims nothing.
        const bTools = historyParts(1).filter(
          (part) => part.type === 'tool-invocation',
        );
        expect(bTools).toHaveLength(1);
        expect(bTools[0]).toMatchObject({ state: 'completed', result: 'B' });
        const aTools = historyParts(0).filter(
          (part) => part.type === 'tool-invocation',
        );
        expect(aTools).toHaveLength(1);
        expect(aTools[0]).toMatchObject({ state: 'running' });
        expect(aTools[0]?.result).toBeUndefined();
      });

      test('absorbs a completion for a turn it cannot disclaim — the accepted cost of the rule', () => {
        seedUnidentifiedRow();
        const chat = activeChatsStore.getSnapshot()[threadId]!;
        activeChatsStore.updateChat(threadId, {
          messages: [
            chat.messages![0],
            {
              role: 'assistant',
              content: 'B is working.',
              turnId: 'turn-b',
              contentParts: [
                {
                  type: 'tool-invocation',
                  toolCallId: 'tool-1',
                  toolName: 'write_file',
                  args: { path: 'b.txt' },
                  state: 'running',
                },
              ],
            },
          ],
        });

        // Names a THIRD turn: turn-b's row contradicts it and is skipped, and
        // the unidentified row has no claim to contradict it with — so it
        // takes the result. This is the trade the rule makes on purpose:
        // stranding every identity-less row is the worse failure.
        handleToolCompletedEvent(
          toolCompleted({ turnId: 'turn-c', status: 'success', output: 'C' }),
        );

        expect(
          historyParts(0).filter((part) => part.type === 'tool-invocation')[0],
        ).toMatchObject({ state: 'completed', result: 'C' });
        expect(
          historyParts(1).filter((part) => part.type === 'tool-invocation')[0],
        ).toMatchObject({ state: 'running' });
      });
    });

    test('a result for the streaming turn still lands on the streaming message', () => {
      seedTwoMessages('tool-1');

      handleToolCompletedEvent(
        toolCompleted({
          eventId: 'evt-live',
          turnId: 'turn-b',
          toolCallId: 'live-call',
          status: 'success',
          output: 'live output',
        }),
      );

      expect(
        streamingParts()
          .filter((part) => part.type === 'tool-invocation')
          .map((part) => part.toolCallId),
      ).toEqual(['live-call']);
      expect(
        historyParts(0).filter((part) => part.type === 'tool-invocation'),
      ).toHaveLength(1);
    });
  });
});

describe('handleTextDeltaEvent — per-token plan derivation (station#3351)', () => {
  const threadId = 'thread-text-delta-plan';

  function textDelta(delta: string, createdAt = '2026-08-19T00:00:00.000Z') {
    return {
      eventId: 'evt',
      provider: 'station-agent',
      threadId,
      createdAt,
      method: 'content.text-delta',
      delta,
    } as unknown as Parameters<typeof handleTextDeltaEvent>[0];
  }

  beforeEach(async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    vi.resetModules();

    vi.doMock('../../../contexts/active-chats-store', async () => {
      const actual = await vi.importActual<
        typeof import('../../../contexts/active-chats-store')
      >('../../../contexts/active-chats-store');
      const store = new actual.ActiveChatsStore({
        storage: { getItem: () => null, setItem: () => {} },
      });
      return { ...actual, activeChatsStore: store };
    });

    upsertTextPartCalls = 0;
    vi.doMock('../messageParts', async () => {
      const actual =
        await vi.importActual<typeof import('../messageParts')>(
          '../messageParts',
        );
      return {
        ...actual,
        upsertTextPart: (...args: Parameters<typeof actual.upsertTextPart>) => {
          upsertTextPartCalls += 1;
          return actual.upsertTextPart(...args);
        },
      };
    });

    ({ activeChatsStore } = await import(
      '../../../contexts/active-chats-store'
    ));
    ({ handleTextDeltaEvent } = await import('../streamHandlers'));

    activeChatsStore.initChat(threadId, {
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Chat',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../../contexts/active-chats-store');
    vi.doUnmock('../messageParts');
    vi.resetModules();
  });

  test('the plan artifact stays live while a plan streams: rawText and steps advance per delta', () => {
    handleTextDeltaEvent(textDelta('Plan:\n- [ ] first'));
    handleTextDeltaEvent(textDelta('\n- [ ] second'));

    const chat = activeChatsStore.getSnapshot()[threadId]!;
    expect(chat.planArtifact).toMatchObject({
      source: 'assistant',
      rawText: 'Plan:\n- [ ] first\n- [ ] second',
      steps: [
        { content: 'first', status: 'pending' },
        { content: 'second', status: 'pending' },
      ],
    });
    expect(chat.streamingMessage?.content).toBe(
      'Plan:\n- [ ] first\n- [ ] second',
    );
  });

  // archive#3351: the pre-dedup handler built the accumulated
  // streaming message twice per token — once for the store update and once
  // verbatim inside the planArtifact argument — so upsertTextPart ran twice
  // per delta. This is the discriminating assertion for the dedup: the value
  // assertions in the tests above were already identical pre-fix.
  test('handleTextDeltaEvent builds the streaming message parts exactly once per delta', () => {
    upsertTextPartCalls = 0;

    handleTextDeltaEvent(textDelta('Plan:\n- [ ] first'));
    expect(upsertTextPartCalls).toBe(1);

    handleTextDeltaEvent(textDelta('\n- [ ] second'));
    expect(upsertTextPartCalls).toBe(2);
  });

  test('non-plan text keeps the cached artifact by reference (no new identity per token)', () => {
    const cached: import('../../../utils/planArtifacts').PlanArtifact = {
      source: 'assistant',
      rawText: '- settled plan',
      steps: [{ content: 'settled plan', status: 'pending' }],
      updatedAt: '2026-08-18T00:00:00.000Z',
    };
    activeChatsStore.updateChat(threadId, { planArtifact: cached });

    handleTextDeltaEvent(textDelta('just a plain sentence'));
    handleTextDeltaEvent(textDelta(' continuing'));

    const chat = activeChatsStore.getSnapshot()[threadId]!;
    expect(chat.planArtifact).toBe(cached);
  });
});
