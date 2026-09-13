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
        targetEnvironmentId: 'environment-a',
        messageDigest: 'message-a',
        createdAt: '2026-08-25T00:01:00.000Z',
      });

      await expect(
        readsFor(store, rootId).readConversationEventWindow(rootId, {
          authority: INTERNAL_SESSION_READ_SCOPE,
          turnLimit: 10,
        }),
      ).resolves.toMatchObject({
        currentSessionId: childId,
        session: { threadId: rootId },
      });
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
