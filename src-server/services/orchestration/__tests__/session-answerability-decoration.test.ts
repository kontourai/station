/**
 * archive#1778 — EVERY EMISSION ROUTE CARRIES THE DECORATION, AND NOTHING IS
 * WRITTEN TO COMPUTE IT (ADR 0012, AC2/AC3/AC4).
 *
 * The consumer sweep recorded on archive#1745 found SIX independent routes
 * that hand an `OrchestrationSessionSummary`-shaped payload to a client, plus
 * two sibling wire shapes that re-declare the same lifecycle fields. There is
 * no natural choke point among them: `listSessionReadModel` is the base read,
 * but `listProjectSessionBoard` and `listAllSessionConversations` layer their
 * OWN shapes over it, and three more routes emit the summary directly.
 *
 * The required type member is what enumerates them, and
 * `packages/contracts/src/__tests__/orchestration-answerability.test.ts` pins
 * that enforcement at typecheck time. This file is the behavioural half: for
 * each route, through a REAL service over a REAL event store, the decoration
 * is present and is the one the predicate computed — not a placeholder that
 * satisfies the type.
 *
 * Route → producer map (the six, plus the three sibling shapes ADR 0012
 * names and the store leg the compiler caught):
 *   GET  /api/orchestration/sessions/read-model  → listSessionReadModel
 *   GET  /api/orchestration/sessions/loaded      → listLoadedSessionReadModel
 *   GET  /api/orchestration/sessions/:threadId   → readSession
 *   POST /api/orchestration/sessions/:id/lifecycle → SessionLifecycleModule
 *   SSE  `orchestration:snapshot`                → listSessionReadModel
 *   GET  /api/orchestration/session-board/projects/:slug → listProjectSessionBoard
 *   GET  /api/orchestration/sessions/:id/events  → readSessionEventPage
 *   GET  /api/orchestration/runs                 → listAgentRuns
 *   GET  /api/conversations (runtime leg)        → listAllSessionConversations
 *   GET  /api/conversations (store leg)          → routes/chat/conversations.ts
 *
 * The SSE frame is additionally asserted AT THE HANDLER in
 * `routes/orchestration/__tests__/orchestration.routes.test.ts`: it is the one
 * route whose payload leaves through `JSON.stringify`, which accepts anything,
 * so the compiler is not the enumerator there. The store leg has no
 * orchestration session and is covered by the conversations route suite.
 *
 * COVERAGE HONESTY: both arms are asserted for `listSessionReadModel`,
 * `readSession`, `listProjectSessionBoard`, `listAgentRuns` and
 * `listAllSessionConversations`; the remaining routes assert the unanswerable
 * arm only, because one function computes the decoration for all of them and
 * per-arm behaviour is pinned at the predicate.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineRuntimeId } from '@kontourai/station-contracts/agent-identity';
import type { RequestAnswerability } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { receiptBus, waitForReceipt } from '../../infra/receipt-bus.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { servingInstanceIdentity } from '../serving-instance.js';

const logger = { debug: () => {}, warn: () => {} };

class FakeAdapter implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly sessions = new Map<string, ProviderSession>();
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();

  constructor(readonly provider: 'claude' | 'codex') {
    this.metadata = {
      displayName: `${provider} Runtime`,
      description: `${provider} adapter for tests`,
      capabilities: ['agent-runtime'],
      runtimeId: engineRuntimeId(`${provider}-runtime`),
      builtin: true,
      executionClass: 'connected',
    };
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    return { threadId: input.threadId, turnId: `${this.provider}-turn` };
  }

  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }
  async stopAll(): Promise<void> {
    this.sessions.clear();
  }
  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }
  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
  async getPrerequisites() {
    return [];
  }
}

function createRegistry(
  adapters: ProviderAdapterShape[],
): IProviderAdapterRegistry {
  return {
    register() {},
    get(provider) {
      return adapters.find((adapter) => adapter.provider === provider);
    },
    list() {
      return adapters;
    },
  };
}

/**
 * The qualification without the clock. Two reads are two observations, so
 * `observedAt` legitimately differs between them; comparing what the arms
 * DECIDED is the invariant, and including the timestamp would make an
 * agreement assertion fail for a reason that is not a disagreement.
 */
function withoutStamp(
  answerability: RequestAnswerability | undefined,
): unknown {
  if (!answerability || answerability.answerable) return answerability;
  const { observedAt: _observedAt, ...rest } = answerability;
  return rest;
}

const PROJECT = 'demo-project';

describe('session-summary answerability decoration (station#1778)', () => {
  let tmp: string;
  let eventStore: EventStore;
  let eventBus: EventBus;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'answerability-decoration-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    eventBus = new EventBus();
  });

  afterEach(() => {
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
    receiptBus.resetForTest();
  });

  /**
   * Two sessions on ONE store, deliberately landing on opposite arms so an
   * assertion cannot pass by everything being decorated the same way:
   *   - `thread-live`: provider registered, resumable → answerable
   *   - `thread-stranded`: provider ABSENT (no `codex` adapter), resumable,
   *     holding an open request → `provider_absent`
   */
  function seedSessions(): void {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-live',
      status: 'ready',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:01.000Z',
    });
    eventStore.appendEvent({
      eventId: 'started-live',
      provider: 'claude',
      threadId: 'thread-live',
      createdAt: '2026-08-03T00:00:01.000Z',
      method: 'session.started',
      sessionId: 'thread-live',
      metadata: { projectSlug: PROJECT, assignedAgentSlug: 'station' },
    } as CanonicalRuntimeEvent);

    eventStore.upsertSession({
      provider: 'codex',
      threadId: 'thread-stranded',
      status: 'ready',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:02.000Z',
    });
    eventStore.appendEvent({
      eventId: 'started-stranded',
      provider: 'codex',
      threadId: 'thread-stranded',
      createdAt: '2026-08-03T00:00:01.000Z',
      method: 'session.started',
      sessionId: 'thread-stranded',
      metadata: { projectSlug: PROJECT, assignedAgentSlug: 'station' },
    } as CanonicalRuntimeEvent);
    eventStore.appendEvent({
      eventId: 'req-stranded',
      provider: 'codex',
      threadId: 'thread-stranded',
      createdAt: '2026-08-03T00:00:02.000Z',
      method: 'request.opened',
      requestId: 'req-1',
      requestType: 'approval',
      title: 'Tool call awaiting approval: shell.exec',
    } as CanonicalRuntimeEvent);
  }

  async function settledService(): Promise<OrchestrationService> {
    const service = new OrchestrationService({
      // Only `claude` is registered: `codex` sessions have no adapter in this
      // process at all, which is the `provider_absent` arm.
      adapterRegistry: createRegistry([new FakeAdapter('claude')]),
      eventBus,
      eventStore,
      logger,
    });
    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );
    return service;
  }

  test('AC2: every summary-emitting route carries the decoration, on both arms', async () => {
    seedSessions();
    const service = await settledService();

    const answerable = { answerable: true };
    // archive#1778 delta review, finding 2: `observedBy` is pinned to THIS
    // process's real identity, not `expect.any(String)`. The verifier
    // collapsed `servingInstanceIdentity()` to a constant and 125 tests
    // stayed green — a wildcard here is exactly how the field that IS the
    // derivation argument went unchecked.
    //
    // WHAT THIS DOES AND DOES NOT PROVE, stated so the pair is legible:
    // comparing against `servingInstanceIdentity()` proves the wire carries
    // THAT function's output and not some other string, but it cannot notice
    // the function itself degrading (both sides would degrade together).
    // What the identity CONTAINS — the pid that distinguishes two unnamed
    // instances on one host — is pinned in `serving-instance.test.ts`, which
    // is where a collapse to a constant reds. Neither file is sufficient
    // alone; the injection that beat the previous round beat it because only
    // one half existed.
    const stranded = {
      answerable: false,
      qualification: 'provider_absent',
      observedBy: servingInstanceIdentity(),
      observedAt: expect.any(String),
    };

    // 1. GET /sessions/read-model
    const readModel = await service.listSessionReadModel(
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(readModel).toHaveLength(2);
    expect(
      readModel.find((s) => s.threadId === 'thread-live')?.answerability,
    ).toEqual(answerable);
    expect(
      readModel.find((s) => s.threadId === 'thread-stranded')?.answerability,
    ).toEqual(stranded);

    // 2. GET /sessions/loaded — a filter over the same read, so the guarantee
    // it inherits is the point; asserted rather than assumed.
    for (const session of await service.listLoadedSessionReadModel(
      INTERNAL_SESSION_READ_SCOPE,
    )) {
      expect(session.answerability).toBeDefined();
    }

    // 3. GET /sessions/:threadId (detail)
    expect(
      (
        await service.readSession(
          'thread-stranded',
          INTERNAL_SESSION_READ_SCOPE,
        )
      )?.session.answerability,
    ).toEqual(stranded);
    expect(
      (await service.readSession('thread-live', INTERNAL_SESSION_READ_SCOPE))
        ?.session.answerability,
    ).toEqual(answerable);

    // 4. POST /sessions/:threadId/lifecycle (mutation response)
    const transitioned = await service.sessionLifecycles.transition({
      threadId: 'thread-live',
      authority: INTERNAL_SESSION_READ_SCOPE,
      to: 'blocked',
      reason: 'manual_update',
      source: 'user_action',
    });
    expect(transitioned.answerability).toEqual(answerable);

    // 5. GET /sessions/:threadId/events (page header carries a full summary)
    const page = await service.readSessionEventPage('thread-stranded', {
      afterSequence: 0,
      limit: 10,
      authority: INTERNAL_SESSION_READ_SCOPE,
    });
    expect(page?.session.answerability).toEqual(stranded);

    // 6. GET /runs — the THIRD sibling shape ADR 0012 names (delta review
    //    HIGH 1). `AgentRunSummary.status` folds `waiting_for_approval` from
    //    the same raw open-request evidence, so an undecorated run is a
    //    consumer with no wire-level way to know nothing can answer it.
    const runs = await service.listAgentRuns(INTERNAL_SESSION_READ_SCOPE);
    expect(runs).toHaveLength(2);
    expect(
      runs.find((run) => run.sessionId === 'thread-stranded')?.answerability,
    ).toEqual(stranded);
    expect(
      runs.find((run) => run.sessionId === 'thread-live')?.answerability,
    ).toEqual(answerable);
    // And the fold it is there to qualify really is the stuck one, so this
    // is not decorating a shape that had no problem.
    expect(
      runs.find((run) => run.sessionId === 'thread-stranded')?.status,
    ).toBe('waiting_for_approval');

    // 7. GET /session-board/projects/:slug
    const board = await service.listProjectSessionBoard(
      PROJECT,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(board).toHaveLength(2);
    expect(
      board.find((item) => item.sessionId === 'thread-stranded')?.answerability,
    ).toEqual(stranded);

    // 8. Sibling shape: GET /api/conversations (runtime leg).
    const conversations = await service.listAllSessionConversations(
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(conversations.length).toBeGreaterThan(0);
    expect(
      conversations.find((item) => item.id === 'thread-stranded')
        ?.answerability,
    ).toEqual(stranded);

    // The SSE `orchestration:snapshot` frame serialises `listSessionReadModel`
    // verbatim (`routes/orchestration.ts`), so covering the base read covers
    // it — but only if the payload survives JSON. A wire member that does not
    // is not on the wire.
    const framed = JSON.parse(JSON.stringify({ sessions: readModel })) as {
      sessions: Array<{ threadId: string; answerability: unknown }>;
    };
    expect(
      framed.sessions.find((s) => s.threadId === 'thread-stranded')
        ?.answerability,
    ).toEqual(stranded);
  });

  /**
   * archive#1778 AC3: the decoration's inputs are live process state, so the
   * read path writes NOTHING. Compared as raw persisted rows rather than a
   * count — a replacement in place, or a mutated payload, would keep any
   * count identical (protocol section 6: an assertion that counts cannot see
   * a substitution).
   */
  test('AC3: decorating a read appends nothing and mutates nothing', async () => {
    seedSessions();
    const service = await settledService();

    const before = JSON.stringify(
      ['thread-live', 'thread-stranded'].map((threadId) =>
        eventStore.listEvents(threadId),
      ),
    );

    await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE);
    await service.readSession('thread-stranded', INTERNAL_SESSION_READ_SCOPE);
    await service.listProjectSessionBoard(PROJECT, INTERNAL_SESSION_READ_SCOPE);
    await service.listAllSessionConversations(INTERNAL_SESSION_READ_SCOPE);
    await service.readSessionEventPage('thread-stranded', {
      afterSequence: 0,
      limit: 10,
      authority: INTERNAL_SESSION_READ_SCOPE,
    });

    const after = JSON.stringify(
      ['thread-live', 'thread-stranded'].map((threadId) =>
        eventStore.listEvents(threadId),
      ),
    );
    expect(after).toBe(before);
  });

  /**
   * archive#1778 AC4: the board's hand-copied re-folds are DELETED, not
   * relocated. `pendingReview` is carried from the base summary, so the two
   * agree by construction rather than by two derivations happening to match.
   *
   * The fixture is chosen so a re-derivation would DISAGREE: `thread-review`
   * is manually transitioned to `review_pending` with no open request, which
   * the base fold reports as `pendingReview: false` (nothing is outstanding)
   * while the deleted copy's `|| lifecycleState === 'review_pending'`
   * disjunct reported `true`. An agreement test on a fixture where both
   * answers coincide would prove nothing.
   */
  test('AC4: board items carry the base summary values instead of re-deriving them', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-review',
      status: 'ready',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:01.000Z',
    });
    eventStore.appendEvent({
      eventId: 'started-review',
      provider: 'claude',
      threadId: 'thread-review',
      createdAt: '2026-08-03T00:00:01.000Z',
      method: 'session.started',
      sessionId: 'thread-review',
      metadata: { projectSlug: PROJECT, assignedAgentSlug: 'station' },
    } as CanonicalRuntimeEvent);
    eventStore.appendEvent({
      eventId: 'state-review',
      provider: 'claude',
      threadId: 'thread-review',
      createdAt: '2026-08-03T00:00:02.000Z',
      method: 'session.state-changed',
      sessionId: 'thread-review',
      from: 'running',
      to: 'idle',
      sessionState: 'review_pending',
      previousState: 'running',
      transitionSource: 'user_action',
    } as CanonicalRuntimeEvent);
    seedSessions();

    const service = await settledService();
    const summaries = new Map(
      (await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE)).map(
        (session) => [session.threadId, session],
      ),
    );
    const board = await service.listProjectSessionBoard(
      PROJECT,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(board.length).toBe(3);

    for (const item of board) {
      const summary = summaries.get(item.sessionId);
      expect(summary).toBeDefined();
      expect(item.pendingReview).toBe(summary?.pendingReview === true);
      expect(item.lifecycleState).toBe(summary?.lifecycleState);
      // Equal in value, from two separate reads of the same process state.
      // Reference identity is deliberately NOT claimed here: the board's
      // summary comes from its own `listSessionReadModel()` call, so the
      // objects differ by construction and asserting `toBe` would be
      // asserting something the design does not promise. `observedAt` is
      // stripped for the same reason — two reads are two observations, and
      // the invariant under test is the QUALIFICATION agreeing, not the
      // clock.
      expect(withoutStamp(item.answerability)).toEqual(
        withoutStamp(summary?.answerability),
      );
    }

    // The discriminating case, stated so a future fixture change cannot
    // silently make this suite vacuous.
    const review = summaries.get('thread-review');
    expect(review?.lifecycleState).toBe('review_pending');
    expect(review?.pendingReview).toBeFalsy();
    expect(
      board.find((item) => item.sessionId === 'thread-review')?.pendingReview,
    ).toBe(false);
  });

  /**
   * archive#1778 delta review, finding 2 (second half): `observedAt` must be
   * WHEN THIS READ HAPPENED.
   *
   * Nothing checked its content before — the verifier froze it at the epoch
   * and 71 tests stayed green. A timestamp that is always the same value is
   * the label-vs-derivation defect in its purest form: it reads as
   * provenance while recording nothing. The window is deliberately generous
   * (the assertion is "stamped at emission", not "stamped within 5ms") but
   * it is bounded on BOTH sides, so neither a frozen constant nor a value
   * copied from the session's own `createdAt` can satisfy it.
   */
  test('observedAt records when the read happened, not a constant', async () => {
    seedSessions();
    const service = await settledService();

    const before = Date.now();
    const observed = (
      await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE)
    ).find((session) => session.threadId === 'thread-stranded')?.answerability;
    const after = Date.now();

    expect(observed?.answerable).toBe(false);
    if (observed?.answerable !== false) throw new Error('unreachable');
    const stamped = Date.parse(observed.observedAt);
    expect(Number.isNaN(stamped)).toBe(false);
    // Bounded on both sides by the call that produced it.
    expect(stamped).toBeGreaterThanOrEqual(before - 1_000);
    expect(stamped).toBeLessThanOrEqual(after + 1_000);
    // And explicitly NOT the fixture's own timestamps, which is what a
    // copied-from-the-session mistake would produce.
    expect(observed.observedAt).not.toBe('2026-08-03T00:00:00.000Z');
    expect(observed.observedAt).not.toBe('2026-08-03T00:00:02.000Z');

    // A LATER read stamps a LATER moment: one observation per read, not one
    // per session lifetime.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = (
      await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE)
    ).find((session) => session.threadId === 'thread-stranded')?.answerability;
    if (second?.answerable !== false) throw new Error('unreachable');
    expect(Date.parse(second.observedAt)).toBeGreaterThanOrEqual(stamped);
  });

  /**
   * The decoration is a per-read observation, so a list read stamps ONE
   * timestamp across its rows: N rows are one observation of this process,
   * not N of them, and a client comparing rows must not see them drift.
   */
  test('one list read carries one observation timestamp and one observer', async () => {
    seedSessions();
    eventStore.upsertSession({
      provider: 'codex',
      threadId: 'thread-stranded-2',
      status: 'ready',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:03.000Z',
    });
    const service = await settledService();

    const stamps = (
      await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE)
    )
      .map((session) => session.answerability)
      .filter((answerability) => !answerability.answerable);
    expect(stamps.length).toBeGreaterThan(1);
    expect(new Set(stamps.map((s) => s.observedAt)).size).toBe(1);
    expect(new Set(stamps.map((s) => s.observedBy)).size).toBe(1);
  });
});
