/**
 * archive#4080 — the honest interrupted-turn banner.
 *
 * Probes `InterruptedTurnRecovery.consume()` — reached through the service's
 * private `interruptedTurns` field (epic archive#4024 moved the body out of
 * `OrchestrationService`), called directly, matching the established
 * `(service as any).projectAndPublishEvent(...)` pattern elsewhere in this
 * suite.
 *
 * This is an INTEGRATION suite through the service, not a unit suite for the
 * module: it builds a real `OrchestrationService` and a real on-disk
 * `EventStore`. That is deliberately stronger — it covers the ctor wiring
 * that constructs `interruptedTurns`, which a module-only suite would miss.
 * (An earlier draft of slice 13 called it "its unit suite in everything but
 * name"; that was an overclaim in the wrong direction, corrected in review.)
 *
 * It probes the crash shape the issue describes: a `SessionTurnBoundaryAuthority` row left `invoking`/`accepted`
 * by an owner whose process died. The dead-owner simulation mirrors
 * `session-turn-boundary.test.ts`'s own pattern — release the first
 * `EventStore`'s owner via `close()`, then open a fresh `EventStore` on the
 * same file, which reconciles at construction exactly like a real restart.
 *
 * Review round 1 reshaped the presentation-path selection from a provider
 * branch to a FileMemory-occupancy check (H2) — `fakeMemoryAdapter()` below
 * models a real `getMessages`/`getConversation`/`addMessage` store so tests
 * can seed either an EMPTY store or one with existing content, in either
 * direction, independent of `provider`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import {
  type InterruptedTurnMemoryAdapter,
  OrchestrationService,
} from '../orchestration-service.js';
import { activeTurnIdForEvents } from '../session-lifecycle-service.js';

// archive#4080 follow-up (review round 2, finding 1): spy-wrap the
// REAL implementation so every other test's behavior is unchanged — this
// exists only to pin that `InterruptedTurnRecovery.consume` actually calls
// through the shared resolver `readConversationMessages` also uses, not a
// re-derived copy. See `conversations.routes.test.ts`'s sibling pin.
vi.mock(
  '../../../runtime/conversation/conversation-transcript-source.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../runtime/conversation/conversation-transcript-source.js')
      >();
    return {
      ...actual,
      resolveConversationTranscriptSource: vi.fn(
        actual.resolveConversationTranscriptSource,
      ),
    };
  },
);
const { resolveConversationTranscriptSource } = await import(
  '../../../runtime/conversation/conversation-transcript-source.js'
);

const logger = { debug: () => {}, warn: () => {} };

type StoredMessage = {
  id: string;
  role: 'user';
  parts: Array<{ type: 'text'; text: string }>;
  metadata?: { interruptedTurnBoundaryId?: string };
};

/**
 * Models the real FileMemory contract `resolveFileMemoryOccupancy` reads:
 * `getMessages` under the CONVENTIONAL `agent:${slug}` userId first, then
 * (only when that comes back empty) a `getConversation` lookup and a second
 * `getMessages` under the conversation's REAL owning userId. `addMessage`
 * writes land in whichever bucket matches its `userId` argument, so a test
 * can observe a follow-up occupancy/idempotence scan seeing what a prior
 * write produced — the same round-trip the real JSONL store gives for free.
 */
function fakeMemoryAdapter(options?: {
  conventionalUserId?: string;
  conventionalMessages?: StoredMessage[];
  conversation?: { userId: string; messages: StoredMessage[] } | null;
}): InterruptedTurnMemoryAdapter & {
  addMessage: ReturnType<typeof vi.fn>;
  getMessages: ReturnType<typeof vi.fn>;
} {
  const conventionalUserId = options?.conventionalUserId ?? '';
  let conventionalMessages = [...(options?.conventionalMessages ?? [])];
  const conversation = options?.conversation ?? null;

  const addMessage = vi.fn(
    async (message: StoredMessage, userId: string, _conversationId: string) => {
      if (userId === conventionalUserId) {
        conventionalMessages = [...conventionalMessages, message];
      } else if (conversation && userId === conversation.userId) {
        conversation.messages = [...conversation.messages, message];
      }
    },
  );
  // HONORS `limit`, like the real writer: `FileMemoryAdapter.getMessages`
  // reads the conversation's whole JSONL file and slices the last `limit`
  // entries off the END before returning. This fake previously ignored the
  // option and returned everything, which is why
  // INTERRUPTED_TURN_MEMORY_SCAN_LIMIT had zero test power — the marker
  // scan could never miss a marker no matter how many messages trailed it
  // (found in slice 13 review, M3). A fixture whose shape the real writer
  // never produces cannot pin behavior that depends on that shape.
  const tail = (messages: StoredMessage[], limit?: number) =>
    typeof limit === 'number' && limit >= 0 ? messages.slice(-limit) : messages;
  const getMessages = vi.fn(
    async (
      userId: string,
      _conversationId: string,
      opts?: { limit?: number },
    ) => {
      if (userId === conventionalUserId)
        return tail(conventionalMessages, opts?.limit);
      if (conversation && userId === conversation.userId) {
        return tail(conversation.messages, opts?.limit);
      }
      return [];
    },
  );
  const getConversation = vi.fn(async (_conversationId: string) =>
    conversation ? { userId: conversation.userId } : null,
  );

  return { addMessage, getMessages, getConversation };
}

function createRegistry(): IProviderAdapterRegistry {
  return {
    register() {},
    get() {
      return undefined;
    },
    list() {
      return [] as ProviderAdapterShape[];
    },
  };
}

function sessionStartedEvent(input: {
  threadId: string;
  provider: string;
  agentSlug?: string;
  userId?: string;
}): CanonicalRuntimeEvent {
  return {
    eventId: `session-started:${input.threadId}`,
    provider: input.provider,
    threadId: input.threadId,
    createdAt: '2026-08-16T00:00:00.000Z',
    method: 'session.started',
    sessionId: input.threadId,
    metadata: {
      ...(input.agentSlug ? { agentSlug: input.agentSlug } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    },
  } as CanonicalRuntimeEvent;
}

/**
 * Seeds a boundary row owned by a process this helper immediately releases
 * (via `EventStore.close()`), then returns a FRESH `EventStore` on the same
 * file — its constructor reconciles at construction, exactly as a real
 * restart would, finding the seeded row's owner dead.
 */
function bootAfterCrash(options: {
  path: string;
  threadId: string;
  provider: string;
  agentSlug?: string;
  userId?: string;
  boundaryState: 'invoking' | 'accepted';
}): EventStore {
  const dying = new EventStore(options.path);
  dying.appendEvent(
    sessionStartedEvent({
      threadId: options.threadId,
      provider: options.provider,
      agentSlug: options.agentSlug,
      userId: options.userId,
    }),
  );
  dying.appendEvent({
    eventId: `turn-started:${options.threadId}`,
    provider: options.provider,
    threadId: options.threadId,
    turnId: 'turn-1',
    createdAt: '2026-08-16T00:00:01.000Z',
    method: 'turn.started',
    prompt: 'do the thing',
  } as CanonicalRuntimeEvent);
  const claimed = dying
    .sessionTurnBoundaryAuthority()
    .claim(options.threadId, '2026-08-16T00:00:01.500Z');
  if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
  claimed.claim.beginInvocation('2026-08-16T00:00:02.000Z');
  if (options.boundaryState === 'accepted') {
    claimed.claim.accepted('turn-1', '2026-08-16T00:00:02.500Z');
  }
  dying.close(); // Releases the owner: the next EventStore(path) sees it dead.
  return new EventStore(options.path);
}

describe('station#4080 slice 1: interrupted-turn boundary consumption', () => {
  const roots: string[] = [];
  const stores: EventStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      try {
        store.close();
      } catch {
        // Already closed by the test.
      }
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function databasePath() {
    const root = mkdtempSync(join(tmpdir(), 'interrupted-turn-recovery-'));
    roots.push(root);
    return join(root, 'orchestration.sqlite');
  }

  test.each(['session-start', 'task-dispatch'] as const)(
    'startup banners cannot retire unresolved %s effects',
    async (purpose) => {
      const path = databasePath();
      const threadId = `unresolved-${purpose}`;
      const dying = new EventStore(path);
      dying.appendEvent(
        sessionStartedEvent({
          threadId,
          provider: 'station-agent',
          agentSlug: 'demo-agent',
          userId: 'owner-user',
        }),
      );
      const authority = dying.sessionTurnBoundaryAuthority();
      const owned =
        purpose === 'session-start'
          ? authority.claimSessionStart(threadId, '2026-08-16T00:00:01.000Z')
          : authority.claimTaskDispatch(threadId, '2026-08-16T00:00:01.000Z');
      if (owned.kind !== 'owner') throw new Error('Expected effect admission');
      if ('beginEffects' in owned.claim)
        owned.claim.beginEffects('2026-08-16T00:00:02.000Z');
      else owned.claim.beginInvocation('2026-08-16T00:00:02.000Z');
      dying.close();
      const booted = new EventStore(path);
      stores.push(booted);
      const records = booted
        .sessionTurnBoundaryAuthority()
        .reconcile('2026-08-16T00:00:03.000Z');
      if (records.kind !== 'available')
        throw new Error('Expected recovery records');
      const record = records.interrupted.find(
        (item) => item.threadId === threadId,
      );
      if (!record) throw new Error('Expected unresolved effect record');
      const adapter = fakeMemoryAdapter({
        conventionalUserId: 'agent:demo-agent',
      });
      const service = new OrchestrationService({
        adapterRegistry: createRegistry(),
        eventBus: new EventBus(),
        eventStore: booted,
        logger: { debug: vi.fn(), warn: vi.fn() },
        memoryAdapters: new Map([['demo-agent', adapter]]),
      });
      await (service as any).interruptedTurns.consume();
      expect(adapter.addMessage).not.toHaveBeenCalled();
      // Also exercise the final storage fence with a stale/misrouted banner receipt.
      booted.resolveInterruptedTurnBoundary({
        boundaryId: record.boundaryId,
        ownerId: record.ownerId,
        state: 'indeterminate',
      });
      expect(
        booted.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
      ).toEqual({ kind: 'available', active: true });
      booted.close();
      const rebooted = new EventStore(path);
      stores.push(rebooted);
      expect(
        rebooted.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
      ).toEqual({ kind: 'available', active: true });
    },
  );

  test('boots after a crash and banners a FileMemory-occupied session (Station engine) as needs-input', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-station-agent',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      userId: 'owner-user',
      boundaryState: 'invoking',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-station-agent',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    // Occupied under the CONVENTIONAL agent:<slug> id — this session's own
    // interrupted prompt already lived in FileMemory before the crash.
    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
      conventionalMessages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'do the thing' }],
        },
      ],
    });
    const eventBus = new EventBus();
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus,
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    expect(adapter.addMessage).toHaveBeenCalledOnce();
    const [message, userId, conversationId] = adapter.addMessage.mock.calls[0];
    expect(message.role).toBe('user');
    expect(message.parts[0].text).toMatch(
      /^\[SYSTEM_EVENT\] \[TURN_INTERRUPTED\]/,
    );
    expect(message.metadata).toMatchObject({
      interruptedTurnBoundaryId: expect.any(String),
    });
    expect(userId).toBe('agent:demo-agent');
    expect(conversationId).toBe('thread-station-agent');

    const detail = await service.readSession(
      'thread-station-agent',
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.lifecycleState).toBe('needs_input');
    expect(detail?.session.lifecycleState).not.toBe('running');
  });

  test('consume() resolves its store via the shared conversation-transcript-source resolver (station#4080 slice 1 follow-up)', async () => {
    // Pins the H2 core-reshape doctrine from the other side: this and
    // `conversations.routes.test.ts`'s sibling pin must both call through
    // ONE shared resolver, not two independently maintained copies of the
    // same lookup. Spies on the real implementation (wired above this
    // describe block), so a regression that reintroduces an inline mirror
    // here reds even though the banner's own outcome stays correct either
    // way.
    (resolveConversationTranscriptSource as any).mockClear();
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-resolver-pin',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'invoking',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-resolver-pin',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
      conventionalMessages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'do the thing' }],
        },
      ],
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    expect(resolveConversationTranscriptSource).toHaveBeenCalledWith(
      adapter,
      'agent:demo-agent',
      'thread-resolver-pin',
      expect.objectContaining({ limit: expect.any(Number) }),
    );
  });

  test('boots after a crash and banners an EMPTY-store session (any provider) via the event-projected path, never FileMemory', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-claude',
      provider: 'claude',
      agentSlug: 'default-agent',
      boundaryState: 'invoking',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-claude',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    // A memory adapter IS registered for this agent slug, but its store is
    // EMPTY — the H2 branch selection must key off occupancy, not off
    // whether an adapter merely exists.
    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:default-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['default-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    expect(adapter.addMessage).not.toHaveBeenCalled();

    const messages = service.readSessionMessages(
      'thread-claude',
      INTERNAL_SESSION_READ_SCOPE,
    );
    const banner = messages.find(
      (m) =>
        m.role === 'user' &&
        m.parts.some((p) => p.text?.includes('[TURN_INTERRUPTED]')),
    );
    expect(banner).toBeDefined();
    expect(
      banner?.parts.find((p) => p.text?.includes('[TURN_INTERRUPTED]'))?.text,
    ).toMatch(/^\[SYSTEM_EVENT\] \[TURN_INTERRUPTED\]/);

    const detail = await service.readSession(
      'thread-claude',
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.lifecycleState).toBe('needs_input');
    expect(detail?.session.lifecycleState).not.toBe('running');
  });

  test('H2 (review round 1): a non-station-agent provider whose FileMemory store IS occupied still gets the FileMemory banner — provider is never consulted', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-claude-occupied',
      provider: 'claude',
      agentSlug: 'shared-agent',
      boundaryState: 'invoking',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-claude-occupied',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:shared-agent',
      conventionalMessages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'earlier turn' }],
        },
      ],
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['shared-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    // The claim under test: FileMemory occupancy alone — not provider —
    // decided this. The lifecycle-fix event is ALWAYS appended (it also
    // carries the `interruptedTurnBoundary` provenance field regardless of
    // presentation path, per this method's own doc), so
    // `readSessionMessages` can still project a banner from it directly;
    // that capability existing is not the same as the production read path
    // reaching for it — `readConversationMessages` only falls through to
    // event-projection when FileMemory comes back EMPTY, which the sibling
    // "EMPTY-store session" test above is what actually proves. This test's
    // job is narrower: prove the FileMemory write itself is occupancy-gated,
    // not provider-gated.
    expect(adapter.addMessage).toHaveBeenCalledOnce();
    const [, userId, conversationId] = adapter.addMessage.mock.calls[0];
    expect(userId).toBe('agent:shared-agent');
    expect(conversationId).toBe('thread-claude-occupied');
  });

  test('H2 (review round 1): a station-agent session whose FileMemory store is EMPTY gets the event-projected banner, not FileMemory', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-station-empty',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'invoking',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-station-empty',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    expect(adapter.addMessage).not.toHaveBeenCalled();
    const messages = service.readSessionMessages(
      'thread-station-empty',
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(
      messages.some((m) =>
        m.parts.some((p) => p.text?.includes('[TURN_INTERRUPTED]')),
      ),
    ).toBe(true);
  });

  test('label-vs-derivation: no boundary row, no banner', async () => {
    const path = databasePath();
    const eventStore = new EventStore(path);
    stores.push(eventStore);
    eventStore.appendEvent(
      sessionStartedEvent({
        threadId: 'thread-idle',
        provider: 'station-agent',
        agentSlug: 'demo-agent',
      }),
    );
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-idle',
      status: 'ready',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    expect(adapter.addMessage).not.toHaveBeenCalled();
    const events = eventStore.listEvents('thread-idle');
    expect(
      events.some((e) => e.payload.method === 'session.state-changed'),
    ).toBe(false);
  });

  test('label-vs-derivation: an interrupted session does not leak a banner onto an unrelated session', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-crashed',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'invoking',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-crashed',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });
    // An unrelated, perfectly healthy session on the SAME store.
    eventStore.appendEvent(
      sessionStartedEvent({
        threadId: 'thread-healthy',
        provider: 'station-agent',
        agentSlug: 'demo-agent',
      }),
    );
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-healthy',
      status: 'ready',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    const events = eventStore.listEvents('thread-crashed');
    expect(
      events.some((e) => e.payload.method === 'session.state-changed'),
    ).toBe(true);
    const unrelatedEvents = eventStore.listEvents('thread-healthy');
    expect(
      unrelatedEvents.some((e) => e.payload.method === 'session.state-changed'),
    ).toBe(false);
  });

  test('idempotence: consuming twice writes exactly one banner, and a fresh boot on the same store finds nothing left', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-once',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-once',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
      conventionalMessages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'do the thing' }],
        },
      ],
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();
    await (service as any).interruptedTurns.consume();

    expect(adapter.addMessage).toHaveBeenCalledOnce();

    // Durable idempotence: a THIRD, independent EventStore reopening the
    // SAME file (a genuine second boot) must find nothing left to banner —
    // proves the row was actually closed (removed), not just drained from
    // this process's in-memory list.
    const rebooted = new EventStore(path);
    stores.push(rebooted);
    expect(rebooted.takeInterruptedTurnBoundaries()).toEqual([]);
  });

  test('H1 (review round 1): a crash between banner write and boundary DELETE never doubles the banner, and the next boot finishes closing the row', async () => {
    const path = databasePath();
    const eventStore1 = bootAfterCrash({
      path,
      threadId: 'thread-crash-window',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore1);
    eventStore1.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-crash-window',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const sharedAdapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
      conventionalMessages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'do the thing' }],
        },
      ],
    });

    const service1 = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore: eventStore1,
      logger,
      memoryAdapters: new Map([['demo-agent', sharedAdapter]]),
    });

    // Simulate the crash window: the banner writes land, but the process
    // dies before `resolveInterruptedTurnBoundary` (the DELETE) runs.
    const deleteSpy = vi
      .spyOn(eventStore1, 'resolveInterruptedTurnBoundary')
      .mockImplementation(() => {
        throw new Error('simulated crash before delete');
      });
    await (service1 as any).interruptedTurns.consume();
    deleteSpy.mockRestore();

    expect(sharedAdapter.addMessage).toHaveBeenCalledOnce();
    expect(
      eventStore1
        .listEvents('thread-crash-window')
        .filter((e) => e.payload.method === 'session.state-changed'),
    ).toHaveLength(1);

    // A genuine second boot: a fresh EventStore on the SAME file rediscovers
    // the still-unresolved row (its dead owner is unchanged). Verified via a
    // THROWAWAY instance, closed immediately — `takeInterruptedTurnBoundaries`
    // drains its caller's in-memory list, so checking on the SAME instance
    // `service2` is about to consume from would starve `service2` of the
    // very row this test needs it to resolve.
    const probe = new EventStore(path);
    expect(probe.takeInterruptedTurnBoundaries()).not.toEqual([]);
    probe.close();

    const eventStore2 = new EventStore(path);
    stores.push(eventStore2);

    const service2 = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore: eventStore2,
      logger,
      memoryAdapters: new Map([['demo-agent', sharedAdapter]]),
    });
    await (service2 as any).interruptedTurns.consume();

    // Still exactly ONE banner and ONE event, across BOTH boots combined.
    expect(sharedAdapter.addMessage).toHaveBeenCalledOnce();
    expect(
      eventStore2
        .listEvents('thread-crash-window')
        .filter((e) => e.payload.method === 'session.state-changed'),
    ).toHaveLength(1);

    // And the row is NOW truly gone.
    const eventStore3 = new EventStore(path);
    stores.push(eventStore3);
    expect(eventStore3.takeInterruptedTurnBoundaries()).toEqual([]);
  });

  test('H1b scan depth: the marker is still found when messages trail the banner (slice 13 review M3)', async () => {
    // INTERRUPTED_TURN_MEMORY_SCAN_LIMIT had ZERO test power before this:
    // the fake adapter ignored `limit`, so the marker scan saw every message
    // and could not miss one however deep it sat. With the fake honoring
    // `limit` like the real writer, this fixture puts FOUR messages after
    // the banner — inside a limit of 5, outside a limit of 1 — so tightening
    // the constant reds here instead of silently double-bannering a real
    // crash-window replay.
    const path = databasePath();
    const eventStore1 = bootAfterCrash({
      path,
      threadId: 'thread-scan-depth',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore1);
    eventStore1.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-scan-depth',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const sharedAdapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
      conventionalMessages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'do it' }] },
      ],
    });
    const makeService = (store: EventStore) =>
      new OrchestrationService({
        adapterRegistry: createRegistry(),
        eventBus: new EventBus(),
        eventStore: store,
        logger,
        memoryAdapters: new Map([['demo-agent', sharedAdapter]]),
      });

    // Boot 1 writes the banner, then dies before the row DELETE.
    const deleteSpy = vi
      .spyOn(eventStore1, 'resolveInterruptedTurnBoundary')
      .mockImplementation(() => {
        throw new Error('simulated crash before delete');
      });
    await (makeService(eventStore1) as any).interruptedTurns.consume();
    deleteSpy.mockRestore();
    expect(sharedAdapter.addMessage).toHaveBeenCalledOnce();

    // Traffic lands AFTER the banner — the case the constant's docblock
    // reasons about, and which no other fixture constructs.
    for (const id of ['t1', 't2', 't3', 't4']) {
      await sharedAdapter.addMessage(
        { id, role: 'user', parts: [{ type: 'text', text: id }] },
        'agent:demo-agent',
        'thread-scan-depth',
      );
    }

    // Boot 2 rediscovers the unresolved row and must still SEE the marker.
    const eventStore2 = new EventStore(path);
    stores.push(eventStore2);
    await (makeService(eventStore2) as any).interruptedTurns.consume();

    const banners = sharedAdapter.addMessage.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { metadata?: { interruptedTurnBoundaryId?: string } })
          .metadata?.interruptedTurnBoundaryId !== undefined,
    );
    expect(banners).toHaveLength(1);
  });

  test('H1 (review round 2, coverage gap): a crash AFTER the event publish but BEFORE the FileMemory write skips the event on boot 2 (hasEventId) and still completes the write, ending with exactly one of each', async () => {
    const path = databasePath();
    const eventStore1 = bootAfterCrash({
      path,
      threadId: 'thread-crash-between-writes',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore1);
    eventStore1.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-crash-between-writes',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const sharedAdapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
      conventionalMessages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'do the thing' }],
        },
      ],
    });

    const service1 = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore: eventStore1,
      logger,
      memoryAdapters: new Map([['demo-agent', sharedAdapter]]),
    });

    // Simulate the crash window ONE STEP LATER than the sibling H1 test: the
    // event has already landed durably, but the FileMemory write itself
    // never completes — the mocked call throws WITHOUT appending, exactly
    // like a process dying mid-write leaves nothing on disk.
    sharedAdapter.addMessage.mockImplementationOnce(async () => {
      throw new Error('simulated crash before the FileMemory write lands');
    });
    await (service1 as any).interruptedTurns.consume();

    expect(sharedAdapter.addMessage).toHaveBeenCalledOnce();
    // The event DID land — this is the fact boot 2 must not re-derive.
    expect(
      eventStore1
        .listEvents('thread-crash-between-writes')
        .filter((e) => e.payload.method === 'session.state-changed'),
    ).toHaveLength(1);
    // The row was NOT resolved — the whole record's try block aborted at
    // the throwing write, before `resolveInterruptedTurnBoundary` runs.
    const probe = new EventStore(path);
    expect(probe.takeInterruptedTurnBoundaries()).not.toEqual([]);
    probe.close();

    // A genuine second boot. The event is already durable; only the
    // FileMemory write is outstanding.
    const eventStore2 = new EventStore(path);
    stores.push(eventStore2);
    const service2 = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore: eventStore2,
      logger,
      memoryAdapters: new Map([['demo-agent', sharedAdapter]]),
    });
    await (service2 as any).interruptedTurns.consume();

    // `addMessage` was called a SECOND time (the retry) — this boot's call
    // succeeds (no mocked override left), landing the banner for real.
    expect(sharedAdapter.addMessage).toHaveBeenCalledTimes(2);
    // Still exactly ONE event, never re-published (hasEventId skipped it).
    expect(
      eventStore2
        .listEvents('thread-crash-between-writes')
        .filter((e) => e.payload.method === 'session.state-changed'),
    ).toHaveLength(1);
    // And exactly ONE banner actually landed in the store (the failed
    // first attempt appended nothing) — "one of each", not one event and
    // two failed/successful write attempts.
    const landedBanners = (
      await sharedAdapter.getMessages(
        'agent:demo-agent',
        'thread-crash-between-writes',
      )
    ).filter(
      (message: { metadata?: { interruptedTurnBoundaryId?: string } }) =>
        message.metadata?.interruptedTurnBoundaryId,
    );
    expect(landedBanners).toHaveLength(1);

    // And the row is now truly gone.
    const eventStore3 = new EventStore(path);
    stores.push(eventStore3);
    expect(eventStore3.takeInterruptedTurnBoundaries()).toEqual([]);
  });

  test('H2 occupancy-resolution failure: an adapter that throws falls back to the event path and the loop continues to the next record', async () => {
    const path = databasePath();
    const dying = new EventStore(path);
    dying.appendEvent(
      sessionStartedEvent({
        threadId: 'thread-throwing-adapter',
        provider: 'station-agent',
        agentSlug: 'demo-agent',
      }),
    );
    dying.appendEvent(
      sessionStartedEvent({
        threadId: 'thread-second-record',
        provider: 'station-agent',
        agentSlug: 'demo-agent',
      }),
    );
    for (const threadId of [
      'thread-throwing-adapter',
      'thread-second-record',
    ]) {
      dying.appendEvent({
        eventId: `turn-started:${threadId}`,
        provider: 'station-agent',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-16T00:00:01.000Z',
        method: 'turn.started',
        prompt: 'do the thing',
      } as CanonicalRuntimeEvent);
      const claimed = dying
        .sessionTurnBoundaryAuthority()
        .claim(threadId, '2026-08-16T00:00:01.500Z');
      if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
      claimed.claim.beginInvocation('2026-08-16T00:00:02.000Z');
    }
    dying.close();
    const eventStore = new EventStore(path);
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-throwing-adapter',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-second-record',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const throwingAdapter: InterruptedTurnMemoryAdapter = {
      addMessage: vi.fn(async () => {}),
      getMessages: vi.fn(async () => {
        throw new Error('simulated FileMemory store outage');
      }),
      getConversation: vi.fn(async () => null),
    };
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', throwingAdapter]]),
    });

    await (service as any).interruptedTurns.consume();

    // The occupancy check's own failure must not write to the throwing
    // store — it falls back to the SAFE direction (event-projected), never
    // to a guessed FileMemory write.
    expect(throwingAdapter.addMessage).not.toHaveBeenCalled();
    expect(
      eventStore
        .listEvents('thread-throwing-adapter')
        .some((e) => e.payload.method === 'session.state-changed'),
    ).toBe(true);
    // And the loop continued: the SECOND record, whose own occupancy check
    // hits the SAME throwing adapter, is processed too, not abandoned.
    expect(
      eventStore
        .listEvents('thread-second-record')
        .some((e) => e.payload.method === 'session.state-changed'),
    ).toBe(true);
    // Both rows are resolved — an occupancy-check failure degrades the
    // presentation path, it does not leave the row stuck.
    const rebooted = new EventStore(path);
    stores.push(rebooted);
    expect(rebooted.takeInterruptedTurnBoundaries()).toEqual([]);
  });

  test('M4 (review round 1): a declined publish (quarantined thread) retains the boundary row instead of silently treating it as done', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-quarantined',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'invoking',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-quarantined',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
      conventionalMessages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'do the thing' }],
        },
      ],
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });
    // `publishCanonicalEvent` refuses any non-`session.exited` event on a
    // quarantined thread — see orchestration-service.ts's own guard.
    (service as any).quarantinedThreads.add('thread-quarantined');

    await (service as any).interruptedTurns.consume();

    expect(adapter.addMessage).not.toHaveBeenCalled();
    expect(
      eventStore
        .listEvents('thread-quarantined')
        .some((e) => e.payload.method === 'session.state-changed'),
    ).toBe(false);

    // The row was retained, not resolved — a fresh boot still finds it.
    const rebooted = new EventStore(path);
    stores.push(rebooted);
    expect(rebooted.takeInterruptedTurnBoundaries()).not.toEqual([]);
  });

  test('M5 (review round 1): the durable event carries the boundary facts DELETE would otherwise discard', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-facts',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-facts',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    const bannerEvent = eventStore
      .listEvents('thread-facts')
      .find((e) => e.payload.method === 'session.state-changed');
    expect(bannerEvent).toBeDefined();
    const payload = bannerEvent!.payload as CanonicalRuntimeEvent & {
      interruptedTurnBoundary?: {
        boundaryId: string;
        priorState: string;
        providerTurnId?: string;
        ownerId: string;
        boundaryCreatedAt: string;
        boundaryUpdatedAt: string;
      };
    };
    expect(payload.interruptedTurnBoundary).toMatchObject({
      priorState: 'accepted',
      providerTurnId: 'turn-1',
      ownerId: expect.any(String),
      boundaryCreatedAt: expect.any(String),
      boundaryUpdatedAt: expect.any(String),
    });
    expect(typeof payload.interruptedTurnBoundary?.boundaryId).toBe('string');

    // The row itself is now gone — the event is where the facts live on.
    const rebooted = new EventStore(path);
    stores.push(rebooted);
    expect(rebooted.takeInterruptedTurnBoundaries()).toEqual([]);
  });

  test('station#2235: an accepted boundary closes the dead turn with turn.aborted BEFORE the needs_input banner', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-abort',
      provider: 'acp',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'acp',
      threadId: 'thread-abort',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    const events = eventStore.listEvents('thread-abort');
    const abort = events.find((e) => e.payload.method === 'turn.aborted');
    expect(abort).toBeDefined();
    // Names the dead turn, not a fresh one — this is what lets every fold
    // (and every live client) settle the turn that actually died.
    const abortPayload = abort!.payload as Extract<
      CanonicalRuntimeEvent,
      { method: 'turn.aborted' }
    >;
    expect(abortPayload.turnId).toBe('turn-1');
    expect(abortPayload.eventId).toMatch(/^turn-interrupted-abort:/);
    expect(abortPayload.reason).toContain('interrupted');
    // The marker the boundary-retirement carve-outs match on: without it
    // the row dies mid-flow and the H1 crash-window tests below go red.
    // Asserted on the payload, not inferred from behavior.
    expect(abortPayload.recoveryTerminal).toBe(true);

    const banner = events.find(
      (e) => e.payload.method === 'session.state-changed',
    );
    expect(banner).toBeDefined();
    // The terminal turn fact lands BEFORE the banner, so the banner's
    // explicit sessionState stamp is still the fold's final word.
    expect(abort!.sequence).toBeLessThan(banner!.sequence);

    // The claim that matters: the turn reads closed AND the session reads
    // needs_input — neither the stuck-true hasActiveTurn nor the retracted
    // attention state.
    const detail = await service.readSession(
      'thread-abort',
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.lifecycleState).toBe('needs_input');
    expect(
      activeTurnIdForEvents(events.map((row) => row.payload)),
    ).toBeUndefined();
  });

  describe('#2324: a turn the engine opened on its own', () => {
    const providerStart = (threadId: string): CanonicalRuntimeEvent => ({
      eventId: `provider-start:${threadId}`,
      provider: 'claude',
      threadId,
      turnId: 'provider:turn-1',
      createdAt: '2026-08-16T00:00:01.000Z',
      method: 'turn.started',
      metadata: { trigger: 'provider' },
    });
    const serviceOn = (eventStore: EventStore) =>
      new OrchestrationService({
        adapterRegistry: createRegistry(),
        eventBus: new EventBus(),
        eventStore,
        logger,
      });

    test('open at a crash: boot closes it with its trigger and the interrupted banner, like a user turn (D3)', async () => {
      const path = databasePath();
      const threadId = 'thread-provider-crash';
      const dying = new EventStore(path);
      dying.appendEvent(sessionStartedEvent({ threadId, provider: 'claude' }));
      // The live path: the service records the boundary as it persists the
      // provider turn's start.
      (serviceOn(dying) as any).projectAndPublishEvent(providerStart(threadId));
      expect(
        dying.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
      ).toEqual({ kind: 'available', active: true });
      dying.close();

      const eventStore = new EventStore(path);
      stores.push(eventStore);
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'running',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:02.000Z',
      });
      const service = serviceOn(eventStore);
      await (service as any).interruptedTurns.consume();

      const events = eventStore.listEvents(threadId);
      const abort = events.find((e) => e.payload.method === 'turn.aborted');
      expect(abort?.payload).toMatchObject({
        turnId: 'provider:turn-1',
        recoveryTerminal: true,
        metadata: { trigger: 'provider' },
      });
      const banner = events.find(
        (e) => e.payload.method === 'session.state-changed',
      );
      expect(banner?.payload).toMatchObject({ sessionState: 'needs_input' });
      expect(abort!.sequence).toBeLessThan(banner!.sequence);
      const detail = await service.readSession(
        threadId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      expect(detail?.session.lifecycleState).toBe('needs_input');
      expect(
        activeTurnIdForEvents(events.map((row) => row.payload)),
      ).toBeUndefined();
      expect(
        eventStore.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
      ).toEqual({ kind: 'available', active: false });
    });

    test('L4: a send queued behind it when the process died (accepted, never started) still gets its terminal and banner', async () => {
      const path = databasePath();
      const threadId = 'thread-queued-behind-provider';
      const dying = new EventStore(path);
      dying.appendEvent(sessionStartedEvent({ threadId, provider: 'claude' }));
      // The send: the engine accepted it (its boundary is `accepted`) but it
      // was queued, so its `turn.started` was never published.
      const claimed = dying
        .sessionTurnBoundaryAuthority()
        .claim(threadId, '2026-08-16T00:00:00.500Z');
      if (claimed.kind !== 'owner') throw new Error('expected boundary owner');
      claimed.claim.beginInvocation('2026-08-16T00:00:00.600Z');
      claimed.claim.accepted('queued-send', '2026-08-16T00:00:00.700Z');
      // The engine's own turn, running ahead of it.
      (serviceOn(dying) as any).projectAndPublishEvent(providerStart(threadId));
      dying.close();

      const eventStore = new EventStore(path);
      stores.push(eventStore);
      await (serviceOn(eventStore) as any).interruptedTurns.consume();
      const aborts = eventStore
        .listEvents(threadId)
        .filter((event) => event.payload.method === 'turn.aborted')
        .map((event) => event.payload.turnId);
      expect(aborts.sort()).toEqual(['provider:turn-1', 'queued-send']);
      expect(
        eventStore
          .listEvents(threadId)
          .filter((event) => event.payload.method === 'session.state-changed'),
      ).toHaveLength(2);
      expect(
        eventStore.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
      ).toEqual({ kind: 'available', active: false });
    });

    test('a crash before its start was persisted leaves nothing to close: the row resolves silently', async () => {
      const path = databasePath();
      const threadId = 'thread-provider-no-start';
      const dying = new EventStore(path);
      dying.appendEvent(sessionStartedEvent({ threadId, provider: 'claude' }));
      // A finished user turn precedes it, so "latest turn start" exists.
      dying.appendEvent({
        eventId: `user-start:${threadId}`,
        provider: 'claude',
        threadId,
        turnId: 'user-turn',
        createdAt: '2026-08-16T00:00:00.500Z',
        method: 'turn.started',
        prompt: 'earlier',
      });
      expect(
        dying
          .sessionTurnBoundaryAuthority()
          .recordProviderTurn(
            threadId,
            'provider:turn-1',
            '2026-08-16T00:00:01.000Z',
          ),
      ).toEqual({ kind: 'applied' });
      dying.close();

      const eventStore = new EventStore(path);
      stores.push(eventStore);
      await (serviceOn(eventStore) as any).interruptedTurns.consume();
      const methods = eventStore
        .listEvents(threadId)
        .map((e) => e.payload.method);
      expect(methods).not.toContain('turn.aborted');
      expect(methods).not.toContain('session.state-changed');
      expect(
        eventStore.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
      ).toEqual({ kind: 'available', active: false });
    });

    test('its own terminal retires the row: a completed provider turn leaves nothing for boot', async () => {
      const path = databasePath();
      const threadId = 'thread-provider-done';
      const eventStore = new EventStore(path);
      stores.push(eventStore);
      eventStore.appendEvent(
        sessionStartedEvent({ threadId, provider: 'claude' }),
      );
      const service = serviceOn(eventStore) as any;
      service.projectAndPublishEvent(providerStart(threadId));
      service.projectAndPublishEvent({
        eventId: `provider-done:${threadId}`,
        provider: 'claude',
        threadId,
        turnId: 'provider:turn-1',
        createdAt: '2026-08-16T00:00:02.000Z',
        method: 'turn.completed',
        finishReason: 'stop',
        metadata: { trigger: 'provider' },
      });
      expect(
        eventStore.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
      ).toEqual({ kind: 'available', active: false });
    });
  });

  test('#2309: the restarted process reads the dead turn open until consume() closes it, then closed', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-activity',
      provider: 'acp',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'acp',
      threadId: 'thread-activity',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([
        [
          'demo-agent',
          fakeMemoryAdapter({ conventionalUserId: 'agent:demo-agent' }),
        ],
      ]),
    });
    const activity = () =>
      (
        service as unknown as {
          conversationActivity: {
            readForThread(threadId: string): { openTurn?: { turnId: string } };
          };
        }
      ).conversationActivity.readForThread('thread-activity');

    // Seeded from durable state in the new process: the crashed turn's
    // `turn.started` is its last turn fact, so it reads open.
    expect(activity().openTurn?.turnId).toBe('turn-1');
    await (service as any).interruptedTurns.consume();
    // The recovery `turn.aborted` reaches the live fold through the store.
    expect(activity().openTurn).toBeUndefined();
  });

  test('station#2235: an invoking boundary (no accepted turn) banners without a turn.aborted', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-no-turn',
      provider: 'acp',
      agentSlug: 'demo-agent',
      boundaryState: 'invoking',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'acp',
      threadId: 'thread-no-turn',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    const events = eventStore.listEvents('thread-no-turn');
    // No turn was ever accepted, so there is nothing to close — and minting
    // a turn.aborted for a turn that never opened would be the same label
    // class this change removes.
    expect(events.some((e) => e.payload.method === 'turn.aborted')).toBe(false);
    expect(
      events.some((e) => e.payload.method === 'session.state-changed'),
    ).toBe(true);
  });

  test('station#2235: a declined abort publish (quarantined thread) retains the boundary row and writes neither event', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-quarantined-abort',
      provider: 'station-agent',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-quarantined-abort',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });
    // Same decline mechanism as the M4 banner test: publishCanonicalEvent
    // refuses any non-session.exited event on a quarantined thread. The
    // abort is attempted FIRST, so its decline must stop the banner too —
    // a banner without its abort would reintroduce the stuck turn.
    (service as any).quarantinedThreads.add('thread-quarantined-abort');

    await (service as any).interruptedTurns.consume();

    const events = eventStore.listEvents('thread-quarantined-abort');
    expect(events.some((e) => e.payload.method === 'turn.aborted')).toBe(false);
    expect(
      events.some((e) => e.payload.method === 'session.state-changed'),
    ).toBe(false);

    const rebooted = new EventStore(path);
    stores.push(rebooted);
    expect(rebooted.takeInterruptedTurnBoundaries()).not.toEqual([]);
  });

  test('station#2235 (review MEDIUM 1): a boundary the thread moved past resolves silently with no recovery events', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-moved-on',
      provider: 'acp',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'acp',
      threadId: 'thread-moved-on',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });
    // The user kept going after the crash: a newer turn opened well after
    // the boundary claim (claim lands ~00:00:02.5 in bootAfterCrash).
    eventStore.appendEvent({
      eventId: 'turn-started:turn-2',
      provider: 'acp',
      threadId: 'thread-moved-on',
      turnId: 'turn-2',
      createdAt: '2026-08-16T00:01:00.000Z',
      method: 'turn.started',
      prompt: 'a fresh start after the crash',
    } as CanonicalRuntimeEvent);

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    // Neither recovery event: the abort would be anchor-rejected by every
    // fold, but the banner would force needs_input over the live turn.
    const events = eventStore.listEvents('thread-moved-on');
    expect(events.some((e) => e.payload.method === 'turn.aborted')).toBe(false);
    expect(
      events.some((e) => e.payload.method === 'session.state-changed'),
    ).toBe(false);
    expect(adapter.addMessage).not.toHaveBeenCalled();

    // And the stale row is gone — the next boot has nothing to redo.
    const rebooted = new EventStore(path);
    stores.push(rebooted);
    expect(rebooted.takeInterruptedTurnBoundaries()).toEqual([]);
  });

  test('station#2235: a second consume never duplicates the abort — exactly one turn.aborted survives a reboot', async () => {
    const path = databasePath();
    const eventStore = bootAfterCrash({
      path,
      threadId: 'thread-abort-once',
      provider: 'acp',
      agentSlug: 'demo-agent',
      boundaryState: 'accepted',
    });
    stores.push(eventStore);
    eventStore.upsertSession({
      provider: 'acp',
      threadId: 'thread-abort-once',
      status: 'running',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:02.000Z',
    });

    const adapter = fakeMemoryAdapter({
      conventionalUserId: 'agent:demo-agent',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });

    await (service as any).interruptedTurns.consume();

    const rebooted = new EventStore(path);
    stores.push(rebooted);
    const rebootedService = new OrchestrationService({
      adapterRegistry: createRegistry(),
      eventBus: new EventBus(),
      eventStore: rebooted,
      logger,
      memoryAdapters: new Map([['demo-agent', adapter]]),
    });
    await (rebootedService as any).interruptedTurns.consume();

    const aborts = rebooted
      .listEvents('thread-abort-once')
      .filter((e) => e.payload.method === 'turn.aborted');
    expect(aborts).toHaveLength(1);
  });
});
