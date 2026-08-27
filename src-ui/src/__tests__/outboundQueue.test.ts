// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOutboundQueueStorage,
  _setOutboundQueueStorage,
  classifyUndeliverableSend,
  OUTBOUND_QUEUE_MAX_AGE_MS,
  OUTBOUND_QUEUE_MAX_ENTRIES,
  OutboundDispatchCapacityError,
  type OutboundDispatchTransportResult,
  type OutboundQueueStorage,
  outboundDispatch,
  type QueuedOutboundTurn,
} from '../lib/outboundQueue';

function turn(
  clientTurnId: string,
  sessionId = 'session-a',
): Parameters<typeof outboundDispatch.enqueue>[0] {
  return {
    clientTurnId,
    sessionId,
    agentSlug: 'codex',
    content: clientTurnId,
  };
}

function memoryStorage(initial?: QueuedOutboundTurn[]): {
  storage: OutboundQueueStorage;
  read: () => QueuedOutboundTurn[] | undefined;
} {
  let value: unknown = initial;
  return {
    storage: {
      getItem: async () => value,
      setItem: async (_key, next) => {
        value = next;
      },
      updateItem: async (_key, updater) => {
        value = updater(value);
      },
    },
    read: () => value as QueuedOutboundTurn[] | undefined,
  };
}

const accepted = (
  providerTurnId = 'provider-turn-default',
): OutboundDispatchTransportResult => ({ kind: 'accepted', providerTurnId });

const notInvoked = (reason?: string): OutboundDispatchTransportResult => ({
  kind: 'not-invoked',
  ...(reason ? { reason } : {}),
});

describe('OutboundDispatchModule', () => {
  it('fences Agent handoff while an offline row still owns the conversation', async () => {
    await outboundDispatch.enqueue({
      ...turn('offline-before-handoff'),
      conversationId: 'conversation-a',
      sessionId: 'session-a',
      agentSlug: 'claude',
    });
    const effect = vi.fn(async () => 'switched');

    const result = await outboundDispatch.fenceConversationHandoff(
      { conversationId: 'conversation-a', sessionId: 'session-a' },
      effect,
    );

    expect(result).toEqual({ status: 'blocked', count: 1 });
    expect(effect).not.toHaveBeenCalled();
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: 'offline-before-handoff',
        agentSlug: 'claude',
      }),
    ]);
  });
  beforeEach(() => {
    _setOutboundQueueStorage(memoryStorage().storage);
  });

  afterEach(() => {
    _resetOutboundQueueStorage();
  });

  it('owns the complete claim → accepted → terminal lifecycle', async () => {
    await outboundDispatch.enqueue(turn('one'));
    const sent: string[] = [];
    await outboundDispatch.flush(async (queued) => {
      sent.push(queued.clientTurnId);
      return accepted('provider-turn-1');
    });

    expect(sent).toEqual(['one']);
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({ clientTurnId: 'one', status: 'accepted' }),
    ]);

    await outboundDispatch.completeAcceptedTurn('session-a', 'provider-turn-1');
    expect(await outboundDispatch.snapshot()).toEqual([]);
  });

  it('consumes matched early evidence on completion and ignores duplicate terminals on tuple reuse', async () => {
    let state: unknown = {
      version: 2,
      turns: [
        {
          ...turn('seed-accepted', 'session-reuse'),
          createdAt: Date.now(),
          attempts: 1,
          status: 'accepted',
          providerTurnId: 'provider-reused',
        },
      ],
      terminalEvidence: [
        {
          sessionId: 'session-reuse',
          providerTurnId: 'provider-reused',
          observedAt: Date.now(),
        },
      ],
    };
    const storage: OutboundQueueStorage = {
      getItem: async () => state,
      setItem: async (_key, next) => {
        state = next;
      },
      updateItem: async (_key, updater) => {
        state = updater(state);
      },
    };
    _setOutboundQueueStorage(storage);

    await outboundDispatch.completeAcceptedTurn(
      'session-reuse',
      'provider-reused',
    );
    await expect(outboundDispatch.open()).resolves.toEqual([]);
    expect(state).toMatchObject({ turns: [], terminalEvidence: [] });

    // The replay does not recreate early evidence after the completed tuple
    // was consumed, so a later same tuple is not deleted on acceptance.
    await outboundDispatch.completeAcceptedTurn(
      'session-reuse',
      'provider-reused',
    );
    await outboundDispatch.enqueue(turn('same-tuple-later', 'session-reuse'));
    await outboundDispatch.flush(async () => accepted('provider-reused'));
    await expect(outboundDispatch.open()).resolves.toEqual([
      expect.objectContaining({
        clientTurnId: 'same-tuple-later',
        status: 'accepted',
        providerTurnId: 'provider-reused',
      }),
    ]);
  });

  it('records an open-time accepted-terminal reconciliation before tuple reuse', async () => {
    let state: unknown = {
      version: 2,
      turns: [
        {
          ...turn('seed-open', 'session-open'),
          createdAt: Date.now(),
          attempts: 1,
          status: 'accepted',
          providerTurnId: 'provider-open',
        },
      ],
      terminalEvidence: [
        {
          sessionId: 'session-open',
          providerTurnId: 'provider-open',
          observedAt: Date.now(),
        },
      ],
    };
    const storage: OutboundQueueStorage = {
      getItem: async () => state,
      setItem: async (_key, next) => {
        state = next;
      },
      updateItem: async (_key, updater) => {
        state = updater(state);
      },
    };
    _setOutboundQueueStorage(storage);

    await expect(outboundDispatch.open()).resolves.toEqual([]);
    await outboundDispatch.completeAcceptedTurn(
      'session-open',
      'provider-open',
    );
    await outboundDispatch.enqueue(turn('reuse-after-open', 'session-open'));
    await outboundDispatch.flush(async () => accepted('provider-open'));

    await expect(outboundDispatch.open()).resolves.toEqual([
      expect.objectContaining({
        clientTurnId: 'reuse-after-open',
        status: 'accepted',
      }),
    ]);
  });

  it.each([
    [
      'legacy array',
      () => [
        {
          ...turn('legacy-array'),
          createdAt: Date.now(),
          attempts: 1,
          status: 'accepted',
        },
      ],
    ],
    [
      'current state',
      () => ({
        version: 2,
        turns: [
          {
            ...turn('current-state'),
            createdAt: Date.now(),
            attempts: 1,
            status: 'accepted',
            providerTurnId: ' ',
          },
        ],
        terminalEvidence: [],
      }),
    ],
  ])(
    'migrates %s accepted rows without provider identity to durable possible-effect evidence',
    async (_shape, fixture) => {
      let state: unknown = fixture();
      const storage: OutboundQueueStorage = {
        getItem: async () => state,
        setItem: async (_key, next) => {
          state = next;
        },
        updateItem: async (_key, updater) => {
          state = updater(state);
        },
      };
      _setOutboundQueueStorage(storage);

      await expect(outboundDispatch.open()).resolves.toEqual([
        expect.objectContaining({
          status: 'may-have-started',
          providerTurnId: undefined,
          lastError: expect.stringContaining('Migration: legacy accepted'),
        }),
      ]);
      // A restart reads the persisted current-state form, never re-projecting
      // the row as accepted or making it replayable.
      _setOutboundQueueStorage(storage);
      await expect(outboundDispatch.open()).resolves.toEqual([
        expect.objectContaining({ status: 'may-have-started' }),
      ]);
      expect(state).toMatchObject({ version: 2 });
    },
  );

  it('never accepts forged provider terminal identity from an enqueue intent', async () => {
    await outboundDispatch.enqueue({
      ...turn('forged-provider-id'),
      providerTurnId: 'forged-provider-turn',
    } as never);

    expect(await outboundDispatch.snapshot()).toEqual([
      expect.not.objectContaining({ providerTurnId: 'forged-provider-turn' }),
    ]);
  });

  it('edits a queued message in its original position instead of moving it to the tail', async () => {
    await outboundDispatch.enqueue(turn('first'));
    await outboundDispatch.enqueue(turn('edit-me'));
    await outboundDispatch.enqueue(turn('last'));

    const edited = await outboundDispatch.edit('edit-me', 'corrected');

    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({ clientTurnId: 'first', content: 'first' }),
      expect.objectContaining({
        clientTurnId: edited.clientTurnId,
        content: 'corrected',
      }),
      expect.objectContaining({ clientTurnId: 'last', content: 'last' }),
    ]);
  });

  it('refuses an edit when the same durable write observes that the turn started running', async () => {
    let state: unknown = {
      version: 2,
      turns: [
        {
          ...turn('started-during-edit'),
          createdAt: Date.now(),
          attempts: 1,
          status: 'pending',
        },
      ],
      terminalEvidence: [],
      completedTerminals: [],
    };
    _setOutboundQueueStorage({
      getItem: async () => state,
      setItem: async (_key, next) => {
        state = next;
      },
      updateItem: async (_key, updater) => {
        // This represents the drain's claim committing after the UI opened
        // its editor but before the edit's transaction begins. The edit must
        // decide from this observed write-time state, not a stale pre-check.
        state = {
          ...(state as { version: 2; terminalEvidence: unknown[] }),
          turns: [
            {
              ...(state as { turns: QueuedOutboundTurn[] }).turns[0],
              status: 'invoking',
              dispatchBootId: 'other-renderer',
              claimedAt: Date.now(),
            },
          ],
        };
        state = updater(state);
      },
    });

    await expect(
      outboundDispatch.edit('started-during-edit', 'too late'),
    ).rejects.toThrow('is invoking and cannot be edited');
    expect(state).toMatchObject({
      turns: [
        expect.objectContaining({
          content: 'started-during-edit',
          status: 'invoking',
        }),
      ],
    });
  });

  it('persists a state-relative reordered queue through a fresh queue reader', async () => {
    const { storage } = memoryStorage();
    _setOutboundQueueStorage(storage);
    await outboundDispatch.enqueue(turn('first'));
    await outboundDispatch.enqueue(turn('second'));
    await outboundDispatch.enqueue(turn('third'));

    await outboundDispatch.reorder('third', 'up');
    await outboundDispatch.reorder('third', 'up');
    _setOutboundQueueStorage(storage);

    expect(await outboundDispatch.open()).toEqual([
      expect.objectContaining({ clientTurnId: 'third' }),
      expect.objectContaining({ clientTurnId: 'first' }),
      expect.objectContaining({ clientTurnId: 'second' }),
    ]);
  });

  it.each(['accepted', 'invoking'] as const)(
    'refuses to move a pending row past an %s same-session barrier before flush',
    async (barrierStatus) => {
      const now = Date.now();
      const { storage } = memoryStorage([
        {
          ...turn('accepted-first'),
          createdAt: now,
          attempts: 1,
          status: barrierStatus,
          ...(barrierStatus === 'accepted'
            ? { providerTurnId: 'provider-first' }
            : {}),
        },
        {
          ...turn('pending-second'),
          createdAt: now + 1,
          attempts: 1,
          status: 'pending',
        },
      ]);
      _setOutboundQueueStorage(storage);

      await expect(
        outboundDispatch.reorder('pending-second', 'up'),
      ).rejects.toThrow(
        'cannot cross an in-flight message from the same session',
      );
      const sent: string[] = [];
      await outboundDispatch.flush(async (queued) => {
        sent.push(queued.clientTurnId);
        return accepted('provider-second');
      });

      expect(sent).toEqual([]);
      expect(
        (await outboundDispatch.snapshot()).map((entry) => entry.clientTurnId),
      ).toEqual(['accepted-first', 'pending-second']);
    },
  );

  it('resolves an up move against the queue order observed inside its durable update', async () => {
    const now = Date.now();
    let concurrentMovePending = true;
    let state: unknown = {
      version: 2,
      turns: ['a', 'b', 'c', 'd'].map((clientTurnId, index) => ({
        ...turn(clientTurnId),
        createdAt: now + index,
        attempts: 1,
        status: 'pending',
      })),
      terminalEvidence: [],
      completedTerminals: [],
    };
    _setOutboundQueueStorage({
      getItem: async () => state,
      setItem: async (_key, next) => {
        state = next;
      },
      updateItem: async (_key, updater) => {
        // Another renderer moves D before this renderer's click reaches the
        // update. The user's intent remains "C up", not "C to index 1".
        if (concurrentMovePending) {
          concurrentMovePending = false;
          const prior = state as { turns: QueuedOutboundTurn[] };
          state = {
            ...(state as object),
            turns: [
              prior.turns[3]!,
              prior.turns[0]!,
              prior.turns[1]!,
              prior.turns[2]!,
            ],
          };
        }
        state = updater(state);
      },
    });

    await outboundDispatch.reorder('c', 'up');

    expect(
      (await outboundDispatch.snapshot()).map((entry) => entry.clientTurnId),
    ).toEqual(['d', 'a', 'c', 'b']);
  });

  it('merges only when asked, exposes the merged text, and restores the original rows before send', async () => {
    await outboundDispatch.enqueue(turn('first'));
    await outboundDispatch.enqueue(turn('second'));
    await outboundDispatch.enqueue(turn('third'));

    const merged = await outboundDispatch.merge('first', 'second');
    expect({
      content: merged.content,
      mergedContents: merged.mergedTurns?.map((entry) => entry.content),
    }).toEqual({
      content: 'first\n\nsecond',
      mergedContents: ['first', 'second'],
    });
    expect(
      (await outboundDispatch.snapshot()).map((entry) => ({
        clientTurnId: entry.clientTurnId,
        content: entry.content,
        mergedContents: entry.mergedTurns?.map((turn) => turn.content),
      })),
    ).toEqual([
      {
        clientTurnId: merged.clientTurnId,
        content: 'first\n\nsecond',
        mergedContents: ['first', 'second'],
      },
      { clientTurnId: 'third', content: 'third', mergedContents: undefined },
    ]);

    await outboundDispatch.unmerge(merged.clientTurnId);
    expect(
      (await outboundDispatch.snapshot()).map((entry) => ({
        clientTurnId: entry.clientTurnId,
        content: entry.content,
        mergedTurns: entry.mergedTurns,
      })),
    ).toEqual([
      { clientTurnId: 'first', content: 'first', mergedTurns: undefined },
      { clientTurnId: 'second', content: 'second', mergedTurns: undefined },
      { clientTurnId: 'third', content: 'third', mergedTurns: undefined },
    ]);
  });

  it('persists a subsequent merge from an edited composite’s displayed content', async () => {
    await outboundDispatch.enqueue(turn('first'));
    await outboundDispatch.enqueue(turn('second'));
    await outboundDispatch.enqueue(turn('third'));

    const initialMerge = await outboundDispatch.merge('first', 'second');
    const edited = await outboundDispatch.edit(
      initialMerge.clientTurnId,
      'revised',
    );
    const remerged = await outboundDispatch.merge(edited.clientTurnId, 'third');

    expect(remerged.content).toBe('revised\n\nthird');
    expect(
      (await outboundDispatch.snapshot()).map((entry) => ({
        clientTurnId: entry.clientTurnId,
        content: entry.content,
        mergedContents: entry.mergedTurns?.map((turn) => turn.content),
      })),
    ).toEqual([
      {
        clientTurnId: remerged.clientTurnId,
        content: 'revised\n\nthird',
        mergedContents: ['revised', 'third'],
      },
    ]);

    await outboundDispatch.unmerge(remerged.clientTurnId);
    expect(
      (await outboundDispatch.snapshot()).map((entry) => ({
        content: entry.content,
        mergedContents: entry.mergedTurns?.map((turn) => turn.content),
      })),
    ).toEqual([
      { content: 'revised', mergedContents: ['first', 'second'] },
      { content: 'third', mergedContents: undefined },
    ]);
  });

  it.each([
    ['edit', 'accepted', 'was accepted and cannot be edited'],
    ['reorder', 'invoking', 'is invoking and cannot be reordered'],
    ['unmerge', 'may-have-started', 'may have started and cannot be unmerged'],
  ] as const)(
    'derives the %s refusal from an observed %s status',
    async (operation, status, expected) => {
      const now = Date.now();
      const mergedTurns =
        operation === 'unmerge'
          ? [
              {
                ...turn('original'),
                createdAt: now,
                attempts: 1,
                status: 'pending' as const,
              },
            ]
          : undefined;
      _setOutboundQueueStorage(
        memoryStorage([
          {
            ...turn('observed'),
            createdAt: now,
            attempts: 1,
            status,
            ...(status === 'accepted'
              ? { providerTurnId: 'provider-observed' }
              : {}),
            ...(mergedTurns ? { mergedTurns } : {}),
          },
        ]).storage,
      );

      const result =
        operation === 'edit'
          ? outboundDispatch.edit('observed', 'revised')
          : operation === 'reorder'
            ? outboundDispatch.reorder('observed', 'up')
            : outboundDispatch.unmerge('observed');
      await expect(result).rejects.toThrow(expected);
    },
  );

  it('reports the in-memory unavailable fence instead of guessing that a turn started', async () => {
    const now = Date.now();
    let state: unknown = {
      version: 2,
      turns: [
        {
          ...turn('fenced'),
          createdAt: now,
          attempts: 1,
          status: 'pending',
        },
      ],
      terminalEvidence: [],
      completedTerminals: [],
    };
    let updateCount = 0;
    _setOutboundQueueStorage({
      getItem: async () => state,
      setItem: async (_key, next) => {
        state = next;
      },
      updateItem: async (_key, updater) => {
        updateCount += 1;
        // The pre-call claim was persisted, but its accepted transition is
        // unavailable. The module must retain an in-memory fence.
        if (updateCount === 2)
          throw new Error('accepted transition unavailable');
        state = updater(state);
      },
    });

    await expect(outboundDispatch.flush(async () => accepted())).resolves.toBe(
      'unavailable',
    );
    await expect(outboundDispatch.edit('fenced', 'revised')).rejects.toThrow(
      'dispatch state is unavailable and cannot be edited',
    );
  });

  it('reports a definite pre-invocation rejection instead of claiming a merge target started', async () => {
    const now = Date.now();
    _setOutboundQueueStorage(
      memoryStorage([
        {
          ...turn('pending'),
          createdAt: now,
          attempts: 1,
          status: 'pending',
        },
        {
          ...turn('rejected'),
          createdAt: now + 1,
          attempts: 1,
          status: 'failed',
        },
      ]).storage,
    );

    await expect(outboundDispatch.merge('pending', 'rejected')).rejects.toThrow(
      'was rejected before invocation and cannot be merged',
    );
  });

  it('consumes durable exact terminal evidence that arrived before accepted persistence', async () => {
    const { storage } = memoryStorage();
    _setOutboundQueueStorage(storage);
    await outboundDispatch.completeAcceptedTurn('session-a', 'provider-early');
    // Simulate a fresh renderer: terminal evidence is inside the one durable
    // queue record, not a loose provider-id cache.
    _setOutboundQueueStorage(storage);
    await outboundDispatch.enqueue(turn('early-terminal'));

    await outboundDispatch.flush(async () => accepted('provider-early'));

    expect(await outboundDispatch.snapshot()).toEqual([]);
  });

  it('keys terminal-before-accept evidence by session and consumes it once', async () => {
    await outboundDispatch.completeAcceptedTurn('session-a', 'provider-shared');
    await outboundDispatch.enqueue(turn('wrong-session', 'session-b'));
    await outboundDispatch.flush(async () => accepted('provider-shared'));
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: 'wrong-session',
        status: 'accepted',
        providerTurnId: 'provider-shared',
      }),
    ]);

    await outboundDispatch.enqueue(turn('right-session', 'session-a'));
    await outboundDispatch.flush(async (queued) =>
      queued.clientTurnId === 'right-session'
        ? accepted('provider-shared')
        : notInvoked(),
    );
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({ clientTurnId: 'wrong-session' }),
    ]);

    // The first exact acceptance consumed the evidence. A later identical
    // provider ID must not be deleted without a new canonical terminal.
    await outboundDispatch.enqueue(turn('same-id-later', 'session-a'));
    await outboundDispatch.flush(async (queued) =>
      queued.clientTurnId === 'same-id-later'
        ? accepted('provider-shared')
        : notInvoked(),
    );
    expect(await outboundDispatch.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientTurnId: 'same-id-later',
          status: 'accepted',
        }),
      ]),
    );
  });

  it('serializes a terminal and acceptance from concurrent renderers', async () => {
    await outboundDispatch.enqueue(turn('race-terminal', 'session-race'));
    await Promise.all([
      outboundDispatch.completeAcceptedTurn('session-race', 'provider-race'),
      outboundDispatch.flush(async () => accepted('provider-race')),
    ]);
    expect(await outboundDispatch.snapshot()).toEqual([]);
  });

  it('recognizes an accepted-terminal completion after its state write throws', async () => {
    let state: unknown = {
      version: 2,
      turns: [],
      terminalEvidence: [
        {
          sessionId: 'session-atomic',
          providerTurnId: 'provider-atomic',
          observedAt: Date.now(),
        },
      ],
    };
    let throwAfterAcceptedWrite = false;
    _setOutboundQueueStorage({
      getItem: async () => state,
      setItem: async (_key, next) => {
        state = next;
      },
      updateItem: async (_key, updater) => {
        state = updater(state);
        if (throwAfterAcceptedWrite) {
          throwAfterAcceptedWrite = false;
          throw new Error('post-write notification failed');
        }
      },
    });
    await outboundDispatch.enqueue(
      turn('accepted-terminal-atomic', 'session-atomic'),
    );

    await outboundDispatch.flush(async () => {
      throwAfterAcceptedWrite = true;
      return accepted('provider-atomic');
    });

    expect(await outboundDispatch.snapshot()).toEqual([]);
    expect(state).toMatchObject({ turns: [], terminalEvidence: [] });
  });

  it('does not confuse adversarial embedded-NUL terminal identities', async () => {
    const state: unknown = {
      version: 2,
      turns: [
        {
          ...turn('nul-turn', 'session\u0000provider'),
          createdAt: Date.now(),
          attempts: 1,
          status: 'accepted',
          providerTurnId: 'turn',
        },
      ],
      terminalEvidence: [
        {
          sessionId: 'session',
          providerTurnId: 'provider\u0000turn',
          observedAt: Date.now(),
        },
      ],
    };
    _setOutboundQueueStorage({
      getItem: async () => state,
      setItem: async () => {},
      updateItem: async (_key, updater) => {
        updater(state);
      },
    });

    await expect(outboundDispatch.open()).resolves.toEqual([
      expect.objectContaining({ clientTurnId: 'nul-turn', status: 'accepted' }),
    ]);
  });

  it('fails closed on malformed durable state without overwriting its evidence', async () => {
    const malformed = {
      version: 2,
      turns: 'not-an-array',
      terminalEvidence: [
        { sessionId: 's', providerTurnId: 'p', observedAt: 1 },
      ],
    };
    let persisted: unknown = malformed;
    let writes = 0;
    _setOutboundQueueStorage({
      getItem: async () => persisted,
      setItem: async (_key, next) => {
        writes += 1;
        persisted = next;
      },
      updateItem: async (_key, updater) => {
        const next = updater(persisted);
        writes += 1;
        persisted = next;
      },
    });

    await expect(outboundDispatch.open()).rejects.toThrow('malformed');
    await expect(
      outboundDispatch.enqueue(turn('must-not-overwrite')),
    ).rejects.toThrow('malformed');
    expect(writes).toBe(0);
    expect(persisted).toBe(malformed);
  });

  it('retries an interrupted accepted-terminal join from durable queue state', async () => {
    let state: unknown = {
      version: 2,
      turns: [
        {
          ...turn('accepted-before-crash', 'session-crash'),
          createdAt: Date.now(),
          attempts: 1,
          status: 'accepted',
          providerTurnId: 'provider-crash',
        },
      ],
      terminalEvidence: [
        {
          sessionId: 'session-crash',
          providerTurnId: 'provider-crash',
          observedAt: Date.now(),
        },
      ],
    };
    let failOnce = true;
    _setOutboundQueueStorage({
      getItem: async () => state,
      setItem: async (_key, next) => {
        state = next;
      },
      updateItem: async (_key, updater) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('interrupted after accepted write');
        }
        state = updater(state);
      },
    });

    await expect(outboundDispatch.open()).rejects.toThrow('interrupted');
    await expect(outboundDispatch.open()).resolves.toEqual([]);
    expect(state).toMatchObject({ turns: [], terminalEvidence: [] });
  });

  it('latches a possible invocation before a throwing Adapter can cause a replay', async () => {
    await outboundDispatch.enqueue(turn('possible-start'));
    const send = vi.fn(async (_queued, claim) => {
      await claim.indeterminate('foreground receipt unavailable');
      throw new Error('observer also failed');
    });

    await outboundDispatch.flush(send);
    await outboundDispatch.flush(send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: 'possible-start',
        status: 'may-have-started',
      }),
    ]);
  });

  it('never turns a server effect followed by a TypeError into a pending replay', async () => {
    await outboundDispatch.enqueue(turn('effect-then-type-error'));
    const serverEffect = vi.fn();
    let signalEffect!: () => void;
    const effectObserved = new Promise<void>((resolve) => {
      signalEffect = resolve;
    });
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const send = vi.fn(async () => {
      serverEffect();
      signalEffect();
      await failureGate;
      throw new TypeError('response connection was lost');
    });

    const first = outboundDispatch.flush(send);
    await effectObserved;
    const second = outboundDispatch.flush(send);
    releaseFailure();
    await Promise.all([first, second]);

    expect(serverEffect).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: 'effect-then-type-error',
        status: 'may-have-started',
      }),
    ]);
  });

  it('releases only an explicit pre-invocation gate', async () => {
    await outboundDispatch.enqueue(turn('not-invoked'));
    const send = vi.fn(async () => notInvoked('the session was busy'));

    await outboundDispatch.flush(send);

    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: 'not-invoked',
        status: 'pending',
        attempts: 2,
      }),
    ]);
  });

  it('retains a durable invoking claim when accepted settlement is unavailable, including after restart', async () => {
    let value: unknown;
    let phase: 'normal' | 'accepted-write-unavailable' = 'normal';
    _setOutboundQueueStorage({
      getItem: async () => value,
      setItem: async (_key, next) => {
        value = next;
      },
      updateItem: async (_key, updater) => {
        if (phase === 'accepted-write-unavailable') {
          phase = 'normal';
          throw new Error('IndexedDB unavailable');
        }
        value = updater(value);
      },
    });
    await outboundDispatch.enqueue(turn('receipt-write-fault'));
    const send = vi.fn(async () => {
      phase = 'accepted-write-unavailable';
      return accepted();
    });
    expect(await outboundDispatch.flush(send)).toBe('unavailable');
    await outboundDispatch.flush(send);

    expect(send).toHaveBeenCalledTimes(1);
    expect((value as { turns: QueuedOutboundTurn[] }).turns).toEqual([
      expect.objectContaining({
        clientTurnId: 'receipt-write-fault',
        status: 'invoking',
      }),
    ]);

    // A fresh renderer has no process-local fence, but the durable claim is
    // still non-replayable and projects as possible-effect evidence.
    _setOutboundQueueStorage({
      getItem: async () => value,
      setItem: async (_key, next) => {
        value = next;
      },
      updateItem: async (_key, updater) => {
        value = updater(value);
      },
    });
    await outboundDispatch.flush(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await outboundDispatch.open())[0]).toMatchObject({
      status: 'invoking',
    });
  });

  it('recognizes an accepted write that committed before its storage Adapter threw', async () => {
    let value: unknown;
    let phase: 'normal' | 'post-accepted-write' = 'normal';
    _setOutboundQueueStorage({
      getItem: async () => value,
      setItem: async (_key, next) => {
        value = next;
      },
      updateItem: async (_key, updater) => {
        value = updater(value);
        if (phase === 'post-accepted-write') {
          phase = 'normal';
          throw new Error('post-write notification failed');
        }
      },
    });
    await outboundDispatch.enqueue(turn('post-write'));
    const send = vi.fn(async () => {
      phase = 'post-accepted-write';
      return accepted();
    });

    expect(await outboundDispatch.flush(send)).toBe('drained');
    expect(await outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: 'post-write',
        status: 'accepted',
      }),
    ]);
    await outboundDispatch.flush(send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent drains through its storage transaction', async () => {
    await outboundDispatch.enqueue(turn('one'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await gate;
      return accepted();
    });
    const first = outboundDispatch.flush(send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const second = outboundDispatch.flush(send);
    release();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing subscriber so later observers still run', async () => {
    const broken = vi.fn(() => {
      throw new Error('observer failure');
    });
    const observed = vi.fn();
    const unsubscribeBroken = outboundDispatch.subscribe(broken);
    const unsubscribeObserved = outboundDispatch.subscribe(observed);

    await outboundDispatch.enqueue(turn('listener-isolation'));

    expect(broken).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledTimes(1);
    unsubscribeBroken();
    unsubscribeObserved();
  });

  it('keeps later same-session intents behind accepted or possible-effect evidence', async () => {
    await outboundDispatch.enqueue(turn('first'));
    await outboundDispatch.enqueue(turn('second'));
    const send = vi.fn(async (queued, claim) => {
      if (queued.clientTurnId === 'first') {
        await claim.indeterminate('receipt unavailable');
        return notInvoked('capability has already recorded uncertainty');
      }
      return accepted();
    });
    await outboundDispatch.flush(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await outboundDispatch.snapshot()).map((entry) => entry.status),
    ).toEqual(['may-have-started', 'pending']);
  });

  it('can drain a different session while a prior session is delivery-uncertain', async () => {
    await outboundDispatch.enqueue(turn('session-a-possible', 'session-a'));
    await outboundDispatch.enqueue(turn('session-b-accepted', 'session-b'));
    const send = vi.fn(async (queued, claim) => {
      if (queued.sessionId === 'session-a') {
        await claim.indeterminate('receipt unavailable');
        return notInvoked();
      }
      return accepted('provider-turn-b');
    });

    await outboundDispatch.flush(send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(
      (await outboundDispatch.snapshot()).map((entry) => entry.status),
    ).toEqual(['may-have-started', 'accepted']);
  });

  it('never ages or evicts may-have-started evidence', async () => {
    const stale = Date.now() - OUTBOUND_QUEUE_MAX_AGE_MS - 1;
    const protectedRow: QueuedOutboundTurn = {
      ...turn('protected'),
      createdAt: stale,
      attempts: 1,
      status: 'may-have-started',
    };
    const ordinary = Array.from(
      { length: OUTBOUND_QUEUE_MAX_ENTRIES + 4 },
      (_, index) => ({
        ...turn(`ordinary-${index}`, `session-${index}`),
        createdAt: Date.now(),
        attempts: 1,
        status: 'pending' as const,
      }),
    );
    const { storage } = memoryStorage([protectedRow, ...ordinary]);
    _setOutboundQueueStorage(storage);

    const entries = await outboundDispatch.snapshot();
    expect(entries).toContainEqual(
      expect.objectContaining({ clientTurnId: 'protected' }),
    );
    expect(entries.length).toBeLessThanOrEqual(OUTBOUND_QUEUE_MAX_ENTRIES + 1);
  });

  it('fails admission instead of evicting protected possible-effect evidence', async () => {
    const protectedRows = Array.from(
      { length: OUTBOUND_QUEUE_MAX_ENTRIES },
      (_, index): QueuedOutboundTurn => ({
        ...turn(`protected-${index}`, `session-${index}`),
        createdAt: Date.now(),
        attempts: 1,
        status: 'may-have-started',
      }),
    );
    _setOutboundQueueStorage(memoryStorage(protectedRows).storage);

    await expect(
      outboundDispatch.enqueue(turn('one-too-many')),
    ).rejects.toBeInstanceOf(OutboundDispatchCapacityError);
    expect(await outboundDispatch.snapshot()).toHaveLength(
      OUTBOUND_QUEUE_MAX_ENTRIES,
    );
  });

  it('evicts the oldest ordinary pending draft when capacity is full', async () => {
    const now = Date.now();
    const ordinary = Array.from(
      { length: OUTBOUND_QUEUE_MAX_ENTRIES },
      (_, index): QueuedOutboundTurn => ({
        ...turn(`ordinary-${index}`, `session-${index}`),
        createdAt: now - (OUTBOUND_QUEUE_MAX_ENTRIES - index),
        attempts: 1,
        status: 'pending',
      }),
    );
    _setOutboundQueueStorage(memoryStorage(ordinary).storage);

    await outboundDispatch.enqueue(turn('newest'));

    const entries = await outboundDispatch.snapshot();
    expect(entries).toHaveLength(OUTBOUND_QUEUE_MAX_ENTRIES);
    expect(entries.map((entry) => entry.clientTurnId)).not.toContain(
      'ordinary-0',
    );
    expect(entries.map((entry) => entry.clientTurnId)).toContain('newest');
  });

  it('evicts safe failed drafts before rejecting new ordinary work', async () => {
    const now = Date.now();
    const failed = Array.from(
      { length: OUTBOUND_QUEUE_MAX_ENTRIES },
      (_, index): QueuedOutboundTurn => ({
        ...turn(`failed-${index}`, `session-${index}`),
        createdAt: now - (OUTBOUND_QUEUE_MAX_ENTRIES - index),
        attempts: 5,
        status: 'failed',
      }),
    );
    _setOutboundQueueStorage(memoryStorage(failed).storage);

    await outboundDispatch.enqueue(turn('newest-failed-capacity'));

    const entries = await outboundDispatch.snapshot();
    expect(entries).toHaveLength(OUTBOUND_QUEUE_MAX_ENTRIES);
    expect(entries.map((entry) => entry.clientTurnId)).not.toContain(
      'failed-0',
    );
    expect(entries.map((entry) => entry.clientTurnId)).toContain(
      'newest-failed-capacity',
    );
  });

  it('keeps protected evidence while evicting an ordinary pending draft', async () => {
    const now = Date.now();
    const protectedRow: QueuedOutboundTurn = {
      ...turn('protected', 'session-protected'),
      createdAt: 0,
      attempts: 1,
      status: 'may-have-started',
    };
    const ordinary = Array.from(
      { length: OUTBOUND_QUEUE_MAX_ENTRIES - 1 },
      (_, index): QueuedOutboundTurn => ({
        ...turn(`ordinary-${index}`, `session-${index}`),
        createdAt: now - (OUTBOUND_QUEUE_MAX_ENTRIES - index),
        attempts: 1,
        status: 'pending',
      }),
    );
    _setOutboundQueueStorage(
      memoryStorage([protectedRow, ...ordinary]).storage,
    );

    await outboundDispatch.enqueue(turn('newest'));

    const entries = await outboundDispatch.snapshot();
    expect(entries).toContainEqual(
      expect.objectContaining({ clientTurnId: 'protected' }),
    );
    expect(entries.map((entry) => entry.clientTurnId)).not.toContain(
      'ordinary-0',
    );
  });

  it('keeps failed drafts editable and retryable before any provider invocation', async () => {
    await outboundDispatch.enqueue(turn('editable'));
    await outboundDispatch.flush(async () => notInvoked('local validation'));
    // Exhaust pre-invocation attempts into the existing failed draft state.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await outboundDispatch.flush(async () => notInvoked('local validation'));
    }
    expect((await outboundDispatch.snapshot())[0]).toMatchObject({
      status: 'failed',
    });

    const edited = await outboundDispatch.edit('editable', 'edited draft');
    expect(edited).toMatchObject({ content: 'edited draft', status: 'failed' });
    await outboundDispatch.retry(edited.clientTurnId);
    expect((await outboundDispatch.snapshot())[0]).toMatchObject({
      clientTurnId: edited.clientTurnId,
      content: 'edited draft',
      status: 'pending',
    });
  });
});

describe('classifyUndeliverableSend (station#3686)', () => {
  // jsdom defines `onLine` on Navigator.prototype, not on the instance, so
  // `getOwnPropertyDescriptor(navigator, 'onLine')` is undefined and a
  // restore-if-present cleanup never runs — it silently leaks `onLine = false`
  // into every later test in the file. Delete the injected own property
  // instead (station#3686 review).
  function setOnLine(value: boolean) {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => value,
    });
  }

  afterEach(() => {
    delete (window.navigator as { onLine?: unknown }).onLine;
  });

  it('restores the inherited onLine between tests', () => {
    expect(
      Object.getOwnPropertyDescriptor(window.navigator, 'onLine'),
    ).toBeUndefined();
  });

  // The point of the split. `fetch` throws TypeError for every pre-response
  // failure — a refused socket, a DNS failure, a TLS error, a rejected origin,
  // the wrong port — none of which mean the device has no network. The old
  // `isOffline` returned true here and the composer said "Offline" while the
  // rest of the app kept working.
  it('reports an unconfirmed send, not a network state, when a send threw', () => {
    setOnLine(true);
    expect(classifyUndeliverableSend(new TypeError('Failed to fetch'))).toBe(
      'send-unconfirmed',
    );
  });

  it('names the reporter, not the fact, when the browser claims no network', () => {
    setOnLine(false);
    expect(classifyUndeliverableSend(new TypeError('Failed to fetch'))).toBe(
      'browser-reports-offline',
    );
  });

  it('reports the browser claim from that signal alone', () => {
    setOnLine(false);
    expect(classifyUndeliverableSend(new Error('anything'))).toBe(
      'browser-reports-offline',
    );
  });

  // A response is proof the address answered, so nothing about it is
  // undeliverable — and that fact outranks `navigator.onLine`, which this
  // repo's own connection layer refuses to trust. Before the review this
  // returned 'device-offline' and queued an HTTP error for retry while
  // telling the user they were offline, even though Station had replied.
  it('returns null for a response-bearing failure even when the browser claims offline', () => {
    setOnLine(false);
    const httpError = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(classifyUndeliverableSend(httpError)).toBeNull();
    const serverError = Object.assign(new Error('Boom'), { status: 500 });
    expect(classifyUndeliverableSend(serverError)).toBeNull();
  });

  it('returns null for a failure that is neither a throw nor a browser offline claim', () => {
    setOnLine(true);
    expect(classifyUndeliverableSend(new Error('HTTP 500'))).toBeNull();
    expect(classifyUndeliverableSend(undefined)).toBeNull();
  });

  // A non-numeric `status` is not response evidence — it must not open a hole
  // that drops a genuinely undeliverable send out of the durable queue.
  it('does not treat a non-numeric status as a response', () => {
    setOnLine(true);
    const odd = Object.assign(new TypeError('Failed to fetch'), {
      status: 'weird',
    });
    expect(classifyUndeliverableSend(odd)).toBe('send-unconfirmed');
  });
});
