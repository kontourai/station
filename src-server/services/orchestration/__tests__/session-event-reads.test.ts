import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { SessionEventReads } from '../session-event-reads.js';

const directories: string[] = [];

function createStore(): EventStore {
  const directory = mkdtempSync(join(tmpdir(), 'session-event-reads-'));
  directories.push(directory);
  return new EventStore(join(directory, 'orchestration.sqlite'));
}

function readsFor(
  store: EventStore,
  rootId: string,
  readSession?: (threadId: string) => Promise<any>,
  overrides: Partial<ConstructorParameters<typeof SessionEventReads>[0]> = {},
): SessionEventReads {
  return new SessionEventReads({
    eventStore: store,
    logger: { warn() {} },
    listSessions: async () => [],
    hydratePersistedTenantContexts() {},
    loadedSessionForThread: () => undefined,
    canReadSession: () => true,
    canUserReadSession: () => true,
    readTurnProgress: () => undefined,
    observeAnswerability: () => ({ state: 'unobserved' }) as never,
    readSession:
      readSession ??
      (async (threadId) =>
        threadId === rootId
          ? ({ session: { threadId: rootId }, events: [] } as never)
          : null),
    ...overrides,
  });
}

function seedRoot(store: EventStore, rootId: string): void {
  store.upsertSession({
    provider: 'claude',
    threadId: rootId,
    status: 'closed',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SessionEventReads conversation boundary hydration', () => {
  test('abort stops lineage authorization between awaited Session reads', async () => {
    const store = createStore();
    const rootId = 'event-reads-abort';
    const childId = `${rootId}:child`;
    const controller = new AbortController();
    const readSession = vi.fn(async (threadId: string) => {
      controller.abort();
      return { session: { threadId }, events: [] };
    });
    try {
      seedRoot(store, rootId);
      store.reserveConversationHandoff({
        conversationId: rootId,
        predecessorSessionId: rootId,
        sessionId: childId,
        idempotencyKey: 'abort-key',
        targetAgentId: 'claude' as never,
        targetEnvironmentId: '11111111-1111-4111-8111-111111111111' as never,
        messageDigest: 'abort-digest',
        createdAt: '2026-08-25T00:01:00.000Z',
      });
      await expect(
        readsFor(store, rootId, readSession).readConversationEventWindow(
          rootId,
          {
            authority: INTERNAL_SESSION_READ_SCOPE,
            turnLimit: 10,
            signal: controller.signal,
          },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(readSession).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });
  test.each([
    ['reserved', undefined],
    ['failed', 'failed'],
    ['indeterminate', 'indeterminate'],
  ] as const)(
    'folds an exact %s unmaterialized boundary child through its predecessor',
    async (_label, transition) => {
      const store = createStore();
      const rootId = `event-reads-${_label}`;
      const childId = `${rootId}:child`;
      try {
        seedRoot(store, rootId);
        store.reserveConversationContextBoundary({
          boundaryId: `boundary-${_label}`,
          conversationId: rootId,
          predecessorSessionId: rootId,
          successorSessionId: childId,
          idempotencyKey: `key-${_label}`,
          policy: 'empty-next-cold-start',
          status: 'reserved',
          actorId: 'owner-user',
          createdAt: '2026-08-25T00:01:00.000Z',
        });
        if (transition) {
          store.claimConversationContextBoundaryColdStart(
            `boundary-${_label}`,
            `start-${_label}`,
            '2026-08-25T00:02:00.000Z',
          );
          if (transition === 'failed') {
            store.releaseConversationContextBoundaryFailedClaim(
              `boundary-${_label}`,
              '2026-08-25T00:03:00.000Z',
            );
          } else {
            store.markConversationContextBoundaryIndeterminate(
              `boundary-${_label}`,
              '2026-08-25T00:03:00.000Z',
            );
          }
        }

        await expect(
          readsFor(store, rootId).readConversationEventWindow(rootId, {
            authority: INTERNAL_SESSION_READ_SCOPE,
            turnLimit: 10,
          }),
        ).resolves.toMatchObject({
          conversationId: rootId,
          currentSessionId: childId,
          session: { threadId: rootId },
        });
      } finally {
        store.close();
      }
    },
  );

  test('folds an exact unmaterialized handoff child through its predecessor', async () => {
    const store = createStore();
    const rootId = 'event-reads-handoff';
    const childId = `${rootId}:child`;
    try {
      seedRoot(store, rootId);
      store.reserveConversationHandoff({
        conversationId: rootId,
        predecessorSessionId: rootId,
        sessionId: childId,
        idempotencyKey: 'handoff-key',
        targetAgentId: 'codex',
        targetExecutionAgentId: 'claude',
        targetEnvironmentId: 'environment-a',
        messageDigest: 'message-a',
        createdAt: '2026-08-25T00:01:00.000Z',
      });

      const snapshot = await readsFor(
        store,
        rootId,
      ).readConversationEventWindow(rootId, {
        authority: INTERNAL_SESSION_READ_SCOPE,
        turnLimit: 10,
      });
      expect(snapshot).toMatchObject({
        currentSessionId: childId,
        session: { threadId: rootId },
        handoffs: [
          expect.objectContaining({ targetExecutionAgentId: 'claude' }),
        ],
      });
      expect(snapshot?.handoffs[0]).not.toHaveProperty('targetProvider');
      expect(snapshot?.handoffs[0]).not.toHaveProperty(
        'expectedDefinitionFingerprint',
      );
    } finally {
      store.close();
    }
  });

  test.each(['boundary', 'handoff'] as const)(
    'fails closed for a %s child that is materialized but denied by readSession',
    async (kind) => {
      const store = createStore();
      const rootId = `event-reads-denied-${kind}`;
      const childId = `${rootId}:child`;
      try {
        seedRoot(store, rootId);
        if (kind === 'boundary') {
          store.reserveConversationContextBoundary({
            boundaryId: `${kind}-denied`,
            conversationId: rootId,
            predecessorSessionId: rootId,
            successorSessionId: childId,
            idempotencyKey: `${kind}-denied`,
            policy: 'empty-next-cold-start',
            status: 'reserved',
            actorId: 'owner-user',
            createdAt: '2026-08-25T00:01:00.000Z',
          });
        } else {
          store.reserveConversationHandoff({
            conversationId: rootId,
            predecessorSessionId: rootId,
            sessionId: childId,
            idempotencyKey: `${kind}-denied`,
            targetAgentId: 'codex',
            targetEnvironmentId: 'environment-a',
            messageDigest: 'message-a',
            createdAt: '2026-08-25T00:01:00.000Z',
          });
        }
        // The read dependency represents a foreign owner/tenant and returns
        // null. The durable materialization must prevent predecessor folding.
        store.upsertSession({
          provider: 'claude',
          threadId: childId,
          status: 'closed',
          createdAt: '2026-08-25T00:02:00.000Z',
          updatedAt: '2026-08-25T00:02:00.000Z',
        });

        await expect(
          readsFor(store, rootId).readConversationEventWindow(rootId, {
            authority: INTERNAL_SESSION_READ_SCOPE,
            turnLimit: 10,
          }),
        ).resolves.toBeNull();
      } finally {
        store.close();
      }
    },
  );

  test('fails closed for a latest unmaterialized child without exact active lineage evidence', async () => {
    const store = createStore();
    const rootId = 'event-reads-unrelated';
    try {
      seedRoot(store, rootId);
      store.reserveNextConversationSession({
        conversationId: rootId,
        predecessorSessionId: rootId,
        proposedSessionId: `${rootId}:missing`,
        createdAt: '2026-08-25T00:01:00.000Z',
      });

      await expect(
        readsFor(store, rootId).readConversationEventWindow(rootId, {
          authority: INTERNAL_SESSION_READ_SCOPE,
          turnLimit: 10,
        }),
      ).resolves.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('SessionEventReads bounded archive caller', () => {
  test.each([false, true])(
    'discovers only an unknown target (unknown=%s)',
    async (unknown) => {
      const store = createStore();
      const id = 'archive-target';
      const inventory = vi.fn(async () => {
        seedRoot(store, id);
        return [];
      });
      const hydrate = vi.fn();
      try {
        if (!unknown) seedRoot(store, id);
        const reads = readsFor(store, id, undefined, {
          listSessions: inventory,
          hydratePersistedTenantContexts: hydrate,
        });
        const options = {
          afterSequence: 0,
          limit: 100,
          authority: INTERNAL_SESSION_READ_SCOPE,
        };
        expect(await reads.readSessionEventPage(id, options)).toMatchObject({
          session: { threadId: id },
          events: [],
        });
        expect(await reads.readSessionEventPage(id, options)).not.toBeNull();
        expect(inventory).toHaveBeenCalledTimes(unknown ? 1 : 0);
        expect(
          hydrate.mock.calls.every(
            ([sessions]) =>
              sessions.length === 1 && sessions[0].threadId === id,
          ),
        ).toBe(true);
      } finally {
        store.close();
      }
    },
  );
  test('denied archive never reads its event projection or payload', async () => {
    const store = createStore();
    try {
      seedRoot(store, 'private');
      const projection = vi.spyOn(store, 'listSessionProjectionEvents');
      const page = vi.spyOn(store, 'listEventPage');
      const result = await readsFor(store, 'private', undefined, {
        canReadSession: () => false,
      }).readSessionEventPage('private', {
        afterSequence: 0,
        limit: 100,
        authority: INTERNAL_SESSION_READ_SCOPE,
      });
      expect(result).toBeNull();
      expect(projection).not.toHaveBeenCalled();
      expect(page).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});

describe('SessionEventReads session window sequence space', () => {
  // Two threads interleaved, so a thread's own ordinal (1, 2, 3, …) and the
  // global stream sequence (1, 3, 5, …) diverge. The window's `watermark` is
  // the thread-filtered GLOBAL head; its events must be numbered in that same
  // space, or a reader stitching live SSE frames (global ids) past the
  // watermark orders the page wrongly.
  function seedInterleaved(store: EventStore, a: string, b: string) {
    seedRoot(store, a);
    seedRoot(store, b);
    const globals: number[] = [];
    for (let index = 0; index < 6; index++) {
      for (const threadId of [a, b]) {
        const event =
          index === 0
            ? {
                method: 'turn.started' as const,
                turnId: `${threadId}-turn`,
                prompt: 'go',
              }
            : {
                method: 'content.text-delta' as const,
                turnId: `${threadId}-turn`,
                itemId: 'text',
                delta: `${threadId}-${index} `,
              };
        store.appendEvent({
          eventId: `${threadId}-${index}`,
          provider: 'claude',
          threadId,
          createdAt: `2026-09-29T00:00:0${index}.000Z`,
          ...event,
        } as never);
        if (threadId === a) globals.push(store.headGlobalSequence());
      }
    }
    return globals;
  }

  test.each([
    ['newest', { direction: 'newest' as const }],
    ['oldest-first', {}],
  ])(
    'a no-lineage session window (%s) numbers its events in the watermark’s global space',
    async (_label, direction) => {
      const store = createStore();
      const a = `window-space-a-${_label}`;
      const b = `window-space-b-${_label}`;
      try {
        const globals = seedInterleaved(store, a, b);
        const reads = readsFor(store, a);
        const session = await reads.readSessionEventWindow(a, {
          authority: INTERNAL_SESSION_READ_SCOPE,
          turnLimit: 10,
          ...direction,
        });
        expect(session).not.toBeNull();
        const sequences = session!.events.map((item) => item.sequence);
        // Per-thread ordinals would be [1..6]; these are the global ones.
        expect(sequences).toEqual(globals);
        expect(Math.max(...sequences)).toBe(session!.watermark);

        // The conversation reader's legacy (no-lineage) branch serves the
        // same page, so it is in the same space too.
        const conversation = await reads.readConversationEventWindow(a, {
          authority: INTERNAL_SESSION_READ_SCOPE,
          turnLimit: 10,
          ...direction,
        });
        expect(conversation?.events.map((item) => item.sequence)).toEqual(
          globals,
        );
        expect(conversation?.watermark).toBe(session!.watermark);
      } finally {
        store.close();
      }
    },
  );
});

describe('SessionEventReads current-turn tool activity', () => {
  test('fresh capped windows retain the own latest tool start and reset at the next turn', async () => {
    const store = createStore();
    const threadId = 'activity-child';
    const base = {
      provider: 'claude' as const,
      threadId,
      createdAt: '2026-10-20T00:00:00.000Z',
    };
    const options = {
      authority: INTERNAL_SESSION_READ_SCOPE,
      direction: 'newest' as const,
      turnLimit: 1,
    };
    try {
      seedRoot(store, threadId);
      store.appendEvent({
        ...base,
        eventId: 'old-start',
        turnId: 'old',
        method: 'turn.started',
        prompt: 'Previous task',
      });
      store.appendEvent({
        ...base,
        eventId: 'old-tool',
        turnId: 'old',
        method: 'tool.started',
        itemId: 'old',
        toolCallId: 'old',
        toolName: 'OldTool',
      });
      store.appendEvent({
        ...base,
        eventId: 'start',
        turnId: 'current',
        method: 'turn.started',
        prompt: 'Inspect',
      });
      store.appendEvent({
        ...base,
        eventId: 'read',
        turnId: 'current',
        method: 'tool.started',
        itemId: 'read',
        toolCallId: 'read',
        toolName: 'Read',
      });
      store.appendEvent({
        ...base,
        eventId: 'edit',
        turnId: 'current',
        method: 'tool.started',
        itemId: 'edit',
        toolCallId: 'edit',
        toolName: 'Edit',
        arguments: { private: 'must not enter the activity fact' },
      });
      store.appendEvent({
        ...base,
        eventId: 'read-done',
        turnId: 'current',
        method: 'tool.completed',
        itemId: 'read',
        toolCallId: 'read',
        toolName: 'Read',
        status: 'success',
        output: 'done',
      });
      for (let index = 0; index < 160; index++) {
        store.appendEvent({
          ...base,
          eventId: `progress-${index}`,
          turnId: 'current',
          method: 'tool.progress',
          itemId: 'edit',
          toolCallId: 'edit',
          message: `step ${index}`,
        });
      }
      for (const other of ['parent', 'sibling']) {
        seedRoot(store, other);
        store.appendEvent({
          ...base,
          threadId: other,
          eventId: `${other}-start`,
          turnId: 'current',
          method: 'turn.started',
          prompt: 'Unrelated',
        });
        store.appendEvent({
          ...base,
          threadId: other,
          eventId: `${other}-tool`,
          turnId: 'current',
          method: 'tool.started',
          itemId: other,
          toolCallId: other,
          toolName: `${other}-tool`,
        });
      }
      const result = await readsFor(store, threadId).readSessionEventWindow(
        threadId,
        options,
      );
      expect(result).not.toBeNull();
      expect(result!.hasMore).toBe(true);
      expect(result!.events.length).toBeLessThanOrEqual(150);
      expect(
        result!.events.some(({ event }) => event.method === 'tool.started'),
      ).toBe(false);
      expect(result!.latestTool).toEqual({ turnId: 'current', name: 'Edit' });
      store.appendEvent({
        ...base,
        eventId: 'steer-current',
        turnId: 'current',
        method: 'turn.started',
        inputKind: 'steer',
        prompt: 'Keep inspecting',
      });
      expect(
        (await readsFor(store, threadId).readSessionEventWindow(
          threadId,
          options,
        ))!.latestTool,
      ).toEqual({ turnId: 'current', name: 'Edit' });

      store.appendEvent({
        ...base,
        eventId: 'next-start',
        turnId: 'next',
        method: 'turn.started',
        prompt: 'Next task',
      });
      store.appendEvent({
        ...base,
        eventId: 'late-old-tool',
        turnId: 'current',
        method: 'tool.started',
        itemId: 'late',
        toolCallId: 'late',
        toolName: 'LateOldTool',
      });
      const next = await readsFor(store, threadId).readSessionEventWindow(
        threadId,
        options,
      );
      expect(next!.latestTool).toBeNull();
      store.appendEvent({
        ...base,
        eventId: 'next-tool',
        turnId: 'next',
        method: 'tool.started',
        itemId: 'next',
        toolCallId: 'next',
        toolName: 'NextTool',
      });
      expect(
        (await readsFor(store, threadId).readSessionEventWindow(
          threadId,
          options,
        ))!.latestTool,
      ).toEqual({ turnId: 'next', name: 'NextTool' });
      store.appendEvent({
        ...base,
        eventId: 'same-id-start',
        turnId: 'next',
        method: 'turn.started',
        prompt: 'New input on the same id',
      });
      expect(
        (await readsFor(store, threadId).readSessionEventWindow(
          threadId,
          options,
        ))!.latestTool,
      ).toEqual({ turnId: 'next', name: 'NextTool' });
    } finally {
      store.close();
    }
  });

  test('activity respects the transcript watermark when a newer turn arrives between reads', async () => {
    const store = createStore();
    const threadId = 'activity-watermark';
    const base = {
      provider: 'claude' as const,
      threadId,
      createdAt: '2026-10-20T00:00:00.000Z',
    };
    try {
      seedRoot(store, threadId);
      store.appendEvent({
        ...base,
        eventId: 'start',
        turnId: 'first',
        method: 'turn.started',
        prompt: 'First',
      });
      store.appendEvent({
        ...base,
        eventId: 'tool',
        turnId: 'first',
        method: 'tool.started',
        itemId: 'read',
        toolCallId: 'read',
        toolName: 'Read',
      });
      const window = store.listEventWindowByTurn.bind(store);
      vi.spyOn(store, 'listEventWindowByTurn').mockImplementationOnce(
        (id, options) => {
          const result = window(id, options);
          store.appendEvent({
            ...base,
            eventId: 'next',
            turnId: 'second',
            method: 'turn.started',
            prompt: 'Second',
          });
          return result;
        },
      );
      const result = await readsFor(store, threadId).readSessionEventWindow(
        threadId,
        {
          authority: INTERNAL_SESSION_READ_SCOPE,
          direction: 'newest',
          turnLimit: 1,
        },
      );
      expect(result!.watermark).toBeLessThan(store.headGlobalSequence());
      expect(result!.latestTool).toEqual({ turnId: 'first', name: 'Read' });
    } finally {
      store.close();
    }
  });

  test.each(['é'.repeat(128), 'é'.repeat(129), ''])(
    'bounds the latest tool name without substituting an earlier tool (%s)',
    async (name) => {
      const store = createStore();
      const threadId = 'activity-bound';
      const base = {
        provider: 'claude' as const,
        threadId,
        turnId: 'current',
        createdAt: '2026-10-20T00:00:00.000Z',
      };
      try {
        seedRoot(store, threadId);
        store.appendEvent({
          ...base,
          eventId: 'start',
          method: 'turn.started',
          prompt: 'Inspect',
        });
        store.appendEvent({
          ...base,
          eventId: 'earlier',
          method: 'tool.started',
          itemId: 'earlier',
          toolCallId: 'earlier',
          toolName: 'EarlierTool',
        });
        store.appendEvent({
          ...base,
          eventId: 'latest',
          method: 'tool.started',
          itemId: 'latest',
          toolCallId: 'latest',
          toolName: name,
        });
        const result = await readsFor(store, threadId).readSessionEventWindow(
          threadId,
          {
            authority: INTERNAL_SESSION_READ_SCOPE,
            direction: 'newest',
            turnLimit: 1,
          },
        );
        expect(result!.latestTool).toEqual(
          name && Buffer.byteLength(name) <= 256
            ? { turnId: 'current', name }
            : null,
        );
      } finally {
        store.close();
      }
    },
  );
});
