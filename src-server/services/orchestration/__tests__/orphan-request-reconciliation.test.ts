/**
 * archive#1284 / archive#1745 — the orphaned-request cancellation, as a
 * READ-TIME PROJECTION.
 *
 * archive#1284 fixed a stranded "Tool call awaiting approval" card by
 * WRITING, at boot, a synthetic `request.resolved{status:'cancelled'}` for
 * every open request on a session that was provably not live. That write was
 * irreversible, and every artifact the four review rounds added existed only
 * to service the irreversibility: a `providerRegistrationSettled` barrier so
 * the registry read could not be taken too early, a resting-state guard so
 * the synthetic event could not erase a recorded `failed`, and an ordering
 * argument for the whole startup chain.
 *
 * archive#1745 projects the same fact instead. `projectRequestAnswerability`
 * (`open-requests.ts`) answers, at each read, whether anything in THIS
 * process could still answer the request; the attention projection drops the
 * card while the answer is no. Nothing is written, so nothing has to be
 * ordered — and the case the barrier existed for (a plugin registering its
 * adapter after boot) now self-heals on the next read, which is a property
 * the barrier could never provide.
 *
 * WHAT THIS SUITE STILL PROVES, AND WHAT MOVED. Every behaviour archive#1338 pinned
 * is either preserved below or, where the code it guarded no longer exists,
 * replaced by a test of the property it was protecting:
 *
 *  - AC1, AC2, the liveness-guard conjunct, the archive#1090 retriable-failure
 *    shape, the predicate pin, the runs fold, cross-boot convergence, the
 *    live-subscribed path, `readRequestOutcome`'s totality and
 *    `resolveSessionProjectSlug`'s delegation precedence: PRESERVED, restated
 *    against the projection.
 *  - The resting-state matrix (which state the synthetic event stamped):
 *    UNREACHABLE — there is no synthetic event. Replaced by a STRONGER
 *    contract-driven matrix asserting that NO event is appended for any of
 *    the eight lifecycle states and every folded state is left exactly as it
 *    was, which is the property the guard was approximating. The
 *    `SESSION_LIFECYCLE_STATES` set is still pinned in both directions.
 *  - The provider-registration barrier tests (it waits; a rejected barrier
 *    still proceeds): UNREACHABLE — the barrier is deleted. Replaced by the
 *    self-healing test, which asserts the outcome the barrier was bought to
 *    protect (a late-registering plugin's approval survives) and additionally
 *    asserts recovery WITHOUT any ordering.
 *  - The pass's internal error isolation (`failedCount`, "the receipt always
 *    fires even when `readSessions()` throws"): UNREACHABLE — the pass and
 *    its receipt are deleted. The property that mattered downstream —
 *    `recoveryCoordinator.reconcile()` is never skipped — is pinned below.
 *    The read-side equivalent (one session's store failure must not blank the
 *    whole projection) is pinned in `attention-projection.test.ts`'s
 *    "boom: session store unavailable" case, which predates this change.
 *
 * Metrics are intentionally NOT mocked here (unlike orchestration-service.
 * test.ts) — metrics.ts is documented safe to import unmocked ("all
 * instruments become no-ops" without an SDK configured), and this suite
 * needs the SAME resolved metrics module every file in the exercised graph
 * (orchestration-service.ts, attention-projection.ts, approval-inbox.ts)
 * imports, which a partial vi.mock() would have to fully enumerate anyway.
 */ import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineRuntimeId } from '@kontourai/station-contracts/agent-identity';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import type { SessionLifecycleState } from '@kontourai/station-contracts/session-lifecycle';
import { SESSION_LIFECYCLE_STATES } from '@kontourai/station-contracts/session-lifecycle';
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
import {
  ApprovalInboxNotificationProvider,
  wireApprovalInboxNotifications,
} from '../../approvals/approval-inbox.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { receiptBus, waitForReceipt } from '../../infra/receipt-bus.js';
import { NotificationService } from '../../notifications/notification-service.js';
import { AttentionProjectionService } from '../../projects/attention-projection.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { projectRequestAnswerability } from '../open-requests.js';
import { OrchestrationService as RawOrchestrationService } from '../orchestration-service.js';

const logger = { debug: async () => {}, warn: async () => {} };

/** Legacy observer assertions use the explicit aggregate scope. */
function scopedOrchestrationService(
  target: RawOrchestrationService,
): RawOrchestrationService {
  const firstScope = new Set([
    'listProviders',
    'listSessions',
    'listSessionReadModel',
    'listLoadedSessionReadModel',
    'listAgentRuns',
    'listAllSessionConversations',
  ]);
  const secondScope = new Set([
    'readAgentRun',
    'listProjectSessionBoard',
    'readSession',
    'readSessionMessages',
    'readSessionUsage',
    'canUserReadSession',
    'readSessionConversation',
    'listSessionConversations',
    'readCommandReceipt',
    'readSessionFlowRun',
    'readSessionBuilderRun',
    'readSessionWorkflowState',
  ]);
  return new Proxy(target, {
    get(instance, property, receiver) {
      const value = Reflect.get(instance, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') {
        return value;
      }
      const scopeIndex = firstScope.has(property)
        ? 0
        : secondScope.has(property)
          ? 1
          : undefined;
      if (scopeIndex === undefined) return value.bind(instance);
      return (...args: unknown[]) => {
        args[scopeIndex] = INTERNAL_SESSION_READ_SCOPE;
        return value.apply(instance, args);
      };
    },
  }) as RawOrchestrationService;
}

class OrchestrationService extends RawOrchestrationService {
  constructor(
    options: ConstructorParameters<typeof RawOrchestrationService>[0],
  ) {
    super(options);
    // biome-ignore lint/correctness/noConstructorReturn: test-only proxy supplies the named internal scope to legacy observer calls.
    return scopedOrchestrationService(this) as OrchestrationService;
  }
}

class FakeAdapter implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly sessions = new Map<string, ProviderSession>();
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();

  constructor(
    readonly provider: 'claude' | 'codex',
    /**
     * archive#1284 review finding 1(b): lets a test simulate the archive#1090
     * recovery-failure shape -- an adapter genuinely registered for the
     * provider whose `startSession` throws for a SPECIFIC thread this boot
     * (`orchestration-session-state.ts`'s recovery catch block then marks
     * that session `status:'error'`), as opposed to no adapter existing for
     * the provider at all (AC1's true-orphan shape).
     */
    private readonly shouldFailStart?: (threadId: string) => boolean,
  ) {
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
    if (this.shouldFailStart?.(input.threadId)) {
      throw new Error(`simulated recovery failure for ${input.threadId}`);
    }
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      model: input.modelId,
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

function requestOpenedEvent(
  overrides: Partial<CanonicalRuntimeEvent> & { threadId: string },
): CanonicalRuntimeEvent {
  return {
    eventId: `req-opened-${overrides.threadId}`,
    provider: 'codex',
    createdAt: '2026-07-20T00:00:00.000Z',
    method: 'request.opened',
    requestId: 'req-1',
    requestType: 'approval',
    title: 'Tool call awaiting approval: shell.exec',
    ...overrides,
  } as CanonicalRuntimeEvent;
}

/**
 * How long a "nothing was written" assertion observes before concluding it.
 *
 * Two hundred milliseconds is not a hope that a race lands the right way: the
 * assertion made across this window is that NOTHING happened, so a longer
 * window can only make it stronger, and the wait below crosses ~10 real
 * macrotask boundaries rather than draining one. That is the property the
 * assertion needs — see `settleBeyondOneMacrotask`.
 */
const WRITE_ABSENCE_OBSERVATION_MS = 200;

/**
 * Yield past MANY macrotask boundaries, not one microtask drain.
 *
 * `await new Promise(resolve => setImmediate(resolve))` proves only that
 * every pending MICROtask has run, so a negative assertion made after it
 * holds exactly as long as nothing in the startup chain crosses a macrotask
 * boundary — which nothing enforces. Independent verification of archive#1338
 * measured that a single `setTimeout(r, 0)` inserted into that chain left an
 * assertion of this shape green while the behaviour it denied had happened.
 */
async function settleBeyondOneMacrotask(): Promise<void> {
  const deadline = Date.now() + WRITE_ABSENCE_OBSERVATION_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A registry whose adapter list can grow after construction — a plugin registering late. */
function createMutableRegistry(adapters: ProviderAdapterShape[]): {
  registry: IProviderAdapterRegistry;
  registerLate(adapter: ProviderAdapterShape): void;
} {
  const live = [...adapters];
  return {
    registry: createRegistry(live),
    registerLate: (adapter) => {
      live.push(adapter);
    },
  };
}

/**
 * The hydrated approval notification a live `request.opened` would already
 * have created before a restart — the row `hydrate()` picks up on a real
 * boot.
 */
function approvalNotificationFor(
  threadId: string,
): Parameters<NotificationService['schedule']>[1] {
  return {
    category: 'approval-request',
    title: 'Tool call awaiting approval: shell.exec',
    priority: 'high',
    actions: [
      { id: 'accept', label: 'Allow Once', variant: 'primary' },
      { id: 'decline', label: 'Deny', variant: 'danger' },
    ],
    dedupeTag: `orchestration:${threadId}:req-1`,
    metadata: {
      provider: 'codex',
      requestId: 'req-1',
      requestKey: `orchestration:${threadId}:req-1`,
      requestKind: 'orchestration',
      requestType: 'approval',
      sessionId: threadId,
      sessionKind: 'runtime',
      threadId,
    },
  };
}

/**
 * `to` and `sessionState` are DIFFERENT channels and two different folds read
 * them: the lifecycle fold reads `sessionState`, the runs fold reads `to`
 * (`agentRunStatusFromEvents`' `session.state-changed` arm switches on it and
 * ignores `sessionState` entirely). A helper that always sent `to: 'idle'`
 * would author fixtures whose lifecycle state says `failed` while the runs
 * board still says `waiting_for_approval` — which is a real product shape,
 * but not the one a runs-fold assertion means to build. So `to` is explicit.
 */
function stateChangedEvent(
  threadId: string,
  sessionState: SessionLifecycleState,
  options: {
    provider?: 'claude' | 'codex';
    to?: string;
    transitionSource?: string;
  } = {},
): CanonicalRuntimeEvent {
  return {
    eventId: `state-${threadId}`,
    provider: options.provider ?? 'codex',
    threadId,
    createdAt: '2026-07-20T00:00:02.000Z',
    method: 'session.state-changed',
    sessionId: threadId,
    from: 'running',
    to: options.to ?? 'idle',
    sessionState,
    previousState: 'running',
    transitionSource: options.transitionSource ?? 'user_action',
  } as CanonicalRuntimeEvent;
}

const OBSERVED_BY = 'test-instance#0';
const OBSERVED_AT = '2026-07-20T12:00:00.000Z';

/** The basis every negative arm must carry on the wire (archive#1778). */
const OBSERVATION_BASIS = {
  observedBy: OBSERVED_BY,
  observedAt: OBSERVED_AT,
} as const;

describe('projectRequestAnswerability — the derivation itself (station#1745)', () => {
  /**
   * The arms, as data. Pure, so they are exercised without booting a service
   * and the fixture cannot accidentally satisfy two at once.
   */
  test.each([
    {
      name: 'a thread this process holds is answerable whatever its log folds to',
      input: {
        threadAttachment: 'attached' as const,
        lifecycleState: 'canceled' as const,
        providerRegistered: false,
      },
      expected: { answerable: true },
    },
    {
      name: 'an unsettled attachment fails open rather than hiding a live approval',
      input: {
        threadAttachment: 'unknown' as const,
        lifecycleState: 'canceled' as const,
        providerRegistered: false,
      },
      expected: { answerable: true },
    },
    {
      name: 'a session past resuming is unanswerable even with its provider registered',
      input: {
        threadAttachment: 'detached' as const,
        lifecycleState: 'canceled' as const,
        providerRegistered: true,
      },
      expected: {
        answerable: false,
        qualification: 'past_resume',
        ...OBSERVATION_BASIS,
      },
    },
    {
      name: 'a resumable session whose provider is absent is unanswerable',
      input: {
        threadAttachment: 'detached' as const,
        lifecycleState: 'review_pending' as const,
        providerRegistered: false,
      },
      expected: {
        answerable: false,
        qualification: 'provider_absent',
        ...OBSERVATION_BASIS,
      },
    },
    {
      name: 'a resumable session with its provider registered is answerable',
      input: {
        threadAttachment: 'detached' as const,
        lifecycleState: 'review_pending' as const,
        providerRegistered: true,
      },
      expected: { answerable: true },
    },
    {
      name: 'an unknown lifecycle state folds to running, not to unanswerable',
      input: {
        threadAttachment: 'detached' as const,
        lifecycleState: undefined,
        providerRegistered: true,
      },
      expected: { answerable: true },
    },
  ])('$name', ({ input, expected }) => {
    expect(
      projectRequestAnswerability({
        ...input,
        observedBy: OBSERVED_BY,
        observedAt: OBSERVED_AT,
      }),
    ).toEqual(expected);
  });

  /**
   * `failed` is the state the two same-sounding contract predicates disagree
   * about, and the one whose retriability archive#1090 depends on. Pinned
   * separately from the table so its rationale is not buried in a row.
   */
  test('a retriable `failed` session stays answerable while its provider is registered', async () => {
    expect(
      projectRequestAnswerability({
        threadAttachment: 'detached',
        lifecycleState: 'failed',
        providerRegistered: true,
        observedBy: OBSERVED_BY,
        observedAt: OBSERVED_AT,
      }),
    ).toEqual({ answerable: true });
  });

  /**
   * archive#1778: the negative arm is a RECORD OF AN OBSERVATION, not a
   * timeless property. Without `observedBy`/`observedAt` a consumer reads
   * "this session is unanswerable" (universal) where the truth is "the
   * serving process held no adapter for it at T" — the label-vs-derivation
   * defect the wire shape exists to prevent. Two processes observing the
   * same session must be distinguishable in their own answers.
   */
  test('the unanswerable arm carries whose process observed it, and when', async () => {
    const one = projectRequestAnswerability({
      threadAttachment: 'detached',
      lifecycleState: 'review_pending',
      providerRegistered: false,
      observedBy: 'station-a#11',
      observedAt: '2026-07-20T12:04:03.000Z',
    });
    const two = projectRequestAnswerability({
      threadAttachment: 'detached',
      lifecycleState: 'review_pending',
      providerRegistered: false,
      observedBy: 'station-b#22',
      observedAt: '2026-07-20T12:09:00.000Z',
    });
    expect(one).toEqual({
      answerable: false,
      qualification: 'provider_absent',
      observedBy: 'station-a#11',
      observedAt: '2026-07-20T12:04:03.000Z',
    });
    expect(two).toEqual({
      answerable: false,
      qualification: 'provider_absent',
      observedBy: 'station-b#22',
      observedAt: '2026-07-20T12:09:00.000Z',
    });
  });
});

describe('OrchestrationService — read-time orphan projection (station#1284, station#1745)', () => {
  let tmp: string;
  let eventStore: EventStore;
  let eventBus: EventBus;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'orphan-reconciliation-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    eventBus = new EventBus();
  });

  afterEach(async () => {
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
    receiptBus.resetForTest();
  });

  /**
   * AC1, IN PRODUCTION'S OWN ORDER (initialize, settle, THEN wire the inbox).
   *
   * The ordering is kept from archive#1338 for the reason it was introduced: wiring
   * the inbox first would let a live bus subscription do work production has
   * nobody listening for. It matters differently now — there is no emission
   * at all — but keeping it makes the "nothing was heard" claim structural
   * rather than incidental.
   *
   * The four assertions that changed, and why each is the honest one:
   *   - NO `request.resolved` is appended. The projection writes nothing, so
   *     idempotency across boots is not a property to maintain, it is a
   *     property there is no way to violate.
   *   - `lifecycleState` stays `review_pending`. archive#1338 stamped `canceled`
   *     here; nothing did cancel it, and the synthetic stamp is exactly the
   *     irreversibility archive#1745 removed.
   *   - the ATTENTION PROJECTION drops the card. This is the user-visible
   *     defect archive#1284 was filed for (the bell badge reads
   *     `AttentionProjectionService.list()`, not the notification store), and
   *     it is now the whole fix.
   *   - the notification row is still `delivered`, NOT `actioned`. archive#1338's
   *     synthetic resolution drove the inbox sweep to mark it `actioned` — a
   *     claim that a decision was made, when the whole premise is that nobody
   *     could make one. The row now says what happened: nothing.
   */
  test('AC1: a stranded approval disappears from the attention projection with nothing written and no decision claimed', async () => {
    const threadId = 'thread-orphan';
    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(requestOpenedEvent({ threadId }));

    const notificationService = new NotificationService(eventBus, tmp, 999_999);
    const approvalRegistry = new ApprovalRegistry(logger, { eventBus });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]), // no adapter for 'codex' at all
      eventBus,
      eventStore,
      logger,
    });
    const provider = new ApprovalInboxNotificationProvider({
      approvalRegistry,
      orchestrationService: service,
    });
    await notificationService.schedule(
      'approval-inbox',
      approvalNotificationFor(threadId),
    );
    const projection = new AttentionProjectionService(
      notificationService,
      service,
      { getRunConsole: async () => ({ gates: [] }) } as never,
      approvalRegistry,
    );

    // Fixture sanity, at the raw event-store level (every read method on
    // OrchestrationService self-calls `initialize()`): the request really is
    // outstanding, so the card really is stranded.
    expect(
      eventStore
        .listEvents(threadId)
        .some((event) => event.payload.method === 'request.resolved'),
    ).toBe(false);

    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );
    wireApprovalInboxNotifications(
      eventBus,
      provider,
      notificationService,
      logger,
    );
    // Nothing is appended later either — a negative assertion that outlasts
    // macrotasks, not one that happens to be made before the write.
    await settleBeyondOneMacrotask();

    expect(
      eventStore
        .listEvents(threadId)
        .some((event) => event.payload.method === 'request.resolved'),
    ).toBe(false);

    const detail = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.lifecycleState).toBe('review_pending');

    const after = await projection.list();
    expect(after.items.some((item) => item.sessionId === threadId)).toBe(false);
    expect(after.pendingCount).toBe(0);

    const approvalNotification = (await notificationService.list()).find(
      (notification) => notification.metadata?.threadId === threadId,
    );
    expect(approvalNotification?.status).toBe('delivered');

    await notificationService.shutdown();

    // A second boot against the same store changes nothing, because the
    // first one wrote nothing.
    const eventsBefore = eventStore.listEvents(threadId).length;
    const restarted = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus: new EventBus(),
      eventStore,
      logger,
    });
    restarted.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );
    expect(eventStore.listEvents(threadId).length).toBe(eventsBefore);
  });

  /**
   * THE PROPERTY THE `providerRegistrationSettled` BARRIER WAS BOUGHT TO
   * PROTECT (archive#1284 HIGH 4), now held without it.
   *
   * The barrier existed because `adapterRegistry.get(provider) === undefined`
   * means "registration has not finished" before plugin loading settles and
   * "this process has no adapter" after, and the boot pass could not tell
   * them apart in time to avoid an IRREVERSIBLE cancellation. A projection
   * does not have to tell them apart: it answers with what is true right now
   * and answers again on the next read.
   *
   * So this asserts something the barrier could not deliver — RECOVERY, not
   * merely delay. Before registration the plugin session's card is suppressed
   * (honestly: nothing in this process can answer it yet); after the adapter
   * registers, the SAME service instance projects it again, with no restart,
   * no repair pass, and nothing written in between. The genuinely
   * provider-less session stays suppressed throughout, so the test is not
   * satisfied by "everything came back".
   *
   * Fault injections it is built to catch: making
   * `projectRequestAnswerability` cache its answer per thread, or moving the
   * registry read to construction time, both red the second half.
   */
  test('self-heals: a late-registering plugin session gets its approval back on the next read, with nothing written and no restart', async () => {
    const pluginThreadId = 'thread-plugin-late';
    const orphanThreadId = 'thread-truly-orphaned';
    for (const [threadId, provider] of [
      [pluginThreadId, 'claude'],
      [orphanThreadId, 'codex'],
    ] as const) {
      eventStore.upsertSession({
        provider,
        threadId,
        status: 'running',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:01.000Z',
      });
      eventStore.appendEvent(requestOpenedEvent({ threadId, provider }));
    }

    const notificationService = new NotificationService(eventBus, tmp, 999_999);
    for (const threadId of [pluginThreadId, orphanThreadId]) {
      await notificationService.schedule(
        'approval-inbox',
        approvalNotificationFor(threadId),
      );
    }

    const { registry, registerLate } = createMutableRegistry([]);
    const service = new OrchestrationService({
      adapterRegistry: registry,
      eventBus,
      eventStore,
      logger,
    });
    const projection = new AttentionProjectionService(
      notificationService,
      service,
      { getRunConsole: async () => ({ gates: [] }) } as never,
    );

    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );

    const beforeRegistration = await projection.list();
    expect(
      beforeRegistration.items.map((item) => item.sessionId).sort(),
    ).toEqual([]);

    // The plugin loads and contributes its adapter — several awaits after
    // `initialize()`, exactly as `runtime-initialize.ts` does it.
    registerLate(new FakeAdapter('claude'));

    const afterRegistration = await projection.list();
    expect(
      afterRegistration.items.some((item) => item.sessionId === pluginThreadId),
    ).toBe(true);
    // The control: still nothing that can answer this one.
    expect(
      afterRegistration.items.some((item) => item.sessionId === orphanThreadId),
    ).toBe(false);

    // Neither session was ever written to, in either direction.
    for (const threadId of [pluginThreadId, orphanThreadId]) {
      expect(
        eventStore
          .listEvents(threadId)
          .some((event) => event.payload.method === 'request.resolved'),
      ).toBe(false);
    }
    expect(
      (await service.readSession(pluginThreadId, INTERNAL_SESSION_READ_SCOPE))
        ?.session.lifecycleState,
    ).toBe('review_pending');

    await notificationService.shutdown();
  });

  test('AC2 (harmful-direction control): a request on a session this process has an adapter record for still projects as needs-attention', async () => {
    const threadId = 'thread-live';
    const claude = new FakeAdapter('claude');

    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(
      requestOpenedEvent({ threadId, provider: 'claude' }),
    );

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      logger,
    });

    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );

    expect(
      eventStore
        .listEvents(threadId)
        .some((event) => event.payload.method === 'request.resolved'),
    ).toBe(false);

    const detail = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.lifecycleState).toBe('review_pending');

    const projection = new AttentionProjectionService(
      { list: () => [] } as never,
      service,
      { getRunConsole: async () => ({ gates: [] }) } as never,
    );
    const { items } = await projection.list();
    expect(items.some((item) => item.sessionId === threadId)).toBe(true);
  });

  /**
   * THE LIVENESS GUARD, PINNED AS A CONJUNCT (round-3 verification: probe 3;
   * carried forward to the projection).
   *
   * AC2 above proves only a DISJUNCTION — its fixture is also answerable
   * through the resumable-with-registered-provider arm, so deleting the
   * `threadIsAttached` check leaves it green. This fixture removes the mask:
   *   - the persisted row is `running` and an adapter for its provider IS
   *     registered, so recovery re-attaches it and it lands in
   *     `sessionAdapters` — the live half;
   *   - its own log folds to `canceled`, so the `past_resume` arm WOULD fire;
   *   - its provider is registered, so `provider_absent` does not apply.
   * With the attachment check: the approval card stays. Without it: the card
   * vanishes off a session this process is holding open right now, which is
   * the harm AC2 exists to prevent.
   *
   * Asserted through the APPROVAL notification rather than a lifecycle item
   * on purpose: a `canceled` session projects no lifecycle item either way,
   * so a lifecycle-based assertion here would prove nothing.
   */
  test('liveness guard (AC2 conjunct): a re-attached session whose log folds past resuming keeps its pending approval, because this process is holding it', async () => {
    const threadId = 'thread-live-but-folded-canceled';
    const claude = new FakeAdapter('claude');

    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(
      requestOpenedEvent({ threadId, provider: 'claude' }),
    );
    eventStore.appendEvent(
      stateChangedEvent(threadId, 'canceled', { provider: 'claude' }),
    );

    const notificationService = new NotificationService(eventBus, tmp, 999_999);
    await notificationService.schedule(
      'approval-inbox',
      approvalNotificationFor(threadId),
    );

    // archive#3476: boot recovery no longer starts an engine per persisted
    // row, so "this process is holding it" has to be a real fact for the
    // fixture to mean anything. An adapter that already holds the thread is
    // now exactly what makes recovery record the session as attached — the
    // attachment fact is DERIVED from `hasSession`, not from recovery having
    // run — so state it here rather than relying on a boot-time spawn.
    claude.sessions.set(threadId, {
      provider: 'claude',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      logger,
    });

    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );

    // Fixture sanity, both halves — without these the test could pass for
    // reasons that have nothing to do with the guard under test.
    expect(await claude.hasSession(threadId)).toBe(true);
    const detail = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.lifecycleState).toBe('canceled');

    const projection = new AttentionProjectionService(
      notificationService,
      service,
      { getRunConsole: async () => ({ gates: [] }) } as never,
    );
    const { items } = await projection.list();
    expect(
      items.some(
        (item) => item.sessionId === threadId && item.kind === 'approval',
      ),
    ).toBe(true);
    expect(
      eventStore
        .listEvents(threadId)
        .some((event) => event.payload.method === 'request.resolved'),
    ).toBe(false);

    await notificationService.shutdown();
  });

  /**
   * Review finding 1(b) (MERGE-BLOCKING, round 2 of archive#1338): "no adapter
   * record for this thread" alone is not proof a session is provably ended.
   * A session whose OWN recovery attempt genuinely fails THIS boot (an
   * adapter IS registered for its provider — archive#1090's shape) is marked
   * `lifecycleState: 'failed'` deliberately so it stays retriable for the
   * NEXT restart, and `failed -> queued|running` is legal by contract.
   */
  test('#1090 shape: a session whose own recovery attempt failed this boot stays answerable and still projects', async () => {
    const threadId = 'thread-1090-recovery-failed';
    const claude = new FakeAdapter(
      'claude',
      (candidateThreadId) => candidateThreadId === threadId,
    );

    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(
      requestOpenedEvent({ threadId, provider: 'claude' }),
    );

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      logger,
    });

    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );
    // archive#3476: the resume this session cannot survive is now attempted
    // when the conversation is next used rather than at boot. The shape it
    // leaves behind — `status: 'error'`, retryable, still projecting — is
    // unchanged, which is what the assertions below pin.
    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'first turn after restart' },
      }),
    ).rejects.toThrow();

    // Sanity: this really is the archive#1090 shape — the resume was attempted (the
    // adapter IS registered) and genuinely failed, folding to `failed`
    // rather than being left untouched at `running`.
    const detail = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.lifecycleState).toBe('failed');
    // Read off the emitted summary, not a service back-channel: the wire
    // decoration is what every consumer sees (archive#1778).
    expect(detail?.session.answerability).toEqual({ answerable: true });

    const projection = new AttentionProjectionService(
      { list: () => [] } as never,
      service,
      { getRunConsole: async () => ({ gates: [] }) } as never,
    );
    const { items } = await projection.list();
    expect(items.some((item) => item.sessionId === threadId)).toBe(true);
  });

  /**
   * PREDICATE PIN (archive#1548 convergence — this test exists to fail if
   * someone swaps the predicate for the one whose NAME matches).
   *
   * The fixture is built so ONLY the lifecycle predicate can decide: the
   * provider IS registered (so `provider_absent` cannot qualify either
   * session on its own) and the persisted sessions are `closed` (so recovery
   * skips them and neither lands in `sessionAdapters`, whose presence would
   * short-circuit before the predicate runs).
   *
   * `isSessionLifecycleStateTerminal` answers false for `canceled`, so
   * swapping it in leaves the canceled thread's card on screen — the exact
   * report archive#1284 was filed against. The opposite direction — widening
   * to `isSessionLifecycleStateStopped` — is pinned by the archive#1090 test above.
   */
  test('predicate pin: a canceled session past resuming is projected unanswerable, while a blocked session that can still resume is left alone', async () => {
    const canceledThreadId = 'thread-canceled';
    const blockedThreadId = 'thread-blocked';
    const claude = new FakeAdapter('claude');

    const notificationService = new NotificationService(eventBus, tmp, 999_999);
    for (const [threadId, sessionState] of [
      [canceledThreadId, 'canceled'],
      [blockedThreadId, 'blocked'],
    ] as const) {
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'closed',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:01.000Z',
      });
      eventStore.appendEvent(
        requestOpenedEvent({ threadId, provider: 'claude' }),
      );
      eventStore.appendEvent(
        stateChangedEvent(threadId, sessionState, { provider: 'claude' }),
      );
      await notificationService.schedule(
        'approval-inbox',
        approvalNotificationFor(threadId),
      );
    }

    const service = new OrchestrationService({
      // Registered on purpose: without this, `provider_absent` would qualify
      // BOTH threads and the test would pass under either predicate.
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      logger,
    });

    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );

    // Fixture sanity: the states really folded the way the pin depends on.
    expect(
      (await service.readSession(canceledThreadId, INTERNAL_SESSION_READ_SCOPE))
        ?.session.lifecycleState,
    ).toBe('canceled');
    expect(
      (await service.readSession(blockedThreadId, INTERNAL_SESSION_READ_SCOPE))
        ?.session.lifecycleState,
    ).toBe('blocked');

    const projection = new AttentionProjectionService(
      notificationService,
      service,
      { getRunConsole: async () => ({ gates: [] }) } as never,
    );
    const { items } = await projection.list();
    const sessionIds = items.map((item) => item.sessionId);
    expect(sessionIds).not.toContain(canceledThreadId);
    expect(sessionIds).toContain(blockedThreadId);

    // And, either way, nothing was written for either of them.
    for (const threadId of [canceledThreadId, blockedThreadId]) {
      expect(
        eventStore
          .listEvents(threadId)
          .some((event) => event.payload.method === 'request.resolved'),
      ).toBe(false);
    }

    await notificationService.shutdown();
  });

  /**
   * THE FAIL-OPEN WINDOW, PINNED AS DELIBERATE AND AS A WINDOW.
   *
   * `sessionAdapters` is populated by `recoverSessions()`, so before that
   * settles "no adapter record" means "recovery has not got there yet".
   * Answering `unanswerable` then would briefly hide a live approval. This
   * asserts BOTH halves: the projection fails open before the settle receipt,
   * and it does not STAY open — an unpinned fail-open is indistinguishable
   * from a broken predicate.
   */
  test('the projection fails open until session attachment settles, and only until then', async () => {
    const threadId = 'thread-fail-open';
    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'closed',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(requestOpenedEvent({ threadId }));
    eventStore.appendEvent(stateChangedEvent(threadId, 'canceled'));

    // The window is held open DETERMINISTICALLY rather than raced: a second
    // persisted session, whose adapter IS registered, blocks recovery's
    // sequential loop until this test releases it. Asserting "before settle"
    // by winning a microtask race would be a timing coincidence, and a test
    // that passes by coincidence proves nothing about the guard.
    let releaseRecovery: () => void = async () => {};
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const claude = new FakeAdapter('claude');
    const gatedStart = claude.startSession.bind(claude);
    claude.startSession = async (input) => {
      await recoveryGate;
      return gatedStart(input);
    };
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-recovery-gate',
      status: 'ready',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      logger,
    });

    service.initialize();

    // Before attachment settles — the honest answer is "this process cannot
    // say yet", which renders as answerable. Note the subject session is
    // `canceled` with NO adapter for `codex`, so BOTH negative arms would
    // fire if the fail-open guard were not wired.
    const early = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(early?.session.lifecycleState).toBe('canceled');
    expect(early?.session.answerability).toEqual({ answerable: true });

    releaseRecovery();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );

    const settled = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(settled?.session.answerability).toEqual({
      answerable: false,
      qualification: 'past_resume',
      observedBy: expect.any(String),
      observedAt: expect.any(String),
    });
  });

  /**
   * NOTHING IS STAMPED, FOR ANY LIFECYCLE STATE — the replacement for
   * archive#1338's resting-state matrix.
   *
   * That matrix asserted which `sessionState` the synthetic `request.resolved`
   * stamped, and existed because the stamp could erase a recorded `failed`
   * and persist a transition the contract forbids. There is no stamp now, so
   * the matrix is unreachable — and the property it approximated is
   * assertable in a strictly stronger form: across every state the contract
   * declares, the projection appends NO event and leaves the folded state
   * exactly as authored.
   *
   * The loop is DRIVEN by the contract, so a state DELETED from
   * `SESSION_LIFECYCLE_STATES` would silently shrink it (protocol section 2:
   * "an assertion that iterates a list cannot catch an entry being deleted").
   * Pin the set itself, in both directions, at runtime — Vitest does not
   * typecheck, so `Record<SessionLifecycleState, …>` alone catches only
   * additions.
   */
  test('resting state: the projection stamps nothing, for every state the lifecycle contract declares', async () => {
    const expectedFoldedStates: Record<SessionLifecycleState, string> = {
      queued: 'queued',
      running: 'running',
      needs_input: 'needs_input',
      review_pending: 'review_pending',
      blocked: 'blocked',
      completed: 'completed',
      failed: 'failed',
      canceled: 'canceled',
    };
    expect([...SESSION_LIFECYCLE_STATES].sort()).toEqual(
      Object.keys(expectedFoldedStates).sort(),
    );

    for (const state of SESSION_LIFECYCLE_STATES) {
      const threadId = `thread-resting-${state}`;
      eventStore.upsertSession({
        provider: 'codex',
        threadId,
        status: 'running',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:01.000Z',
      });
      // An INPUT request, deliberately: a still-open non-input request makes
      // `projectSessionLifecycle` force `review_pending` over any non-stopped,
      // non-blocked state, so five of these eight authored states would be
      // unreachable and the matrix would assert against fixtures the system
      // cannot produce. It doubles as proof that the projection covers input
      // requests too.
      eventStore.appendEvent(
        requestOpenedEvent({ threadId, requestType: 'input' }),
      );
      eventStore.appendEvent(stateChangedEvent(threadId, state));
    }

    // No adapter for 'codex' at all, so every one of these sessions is
    // projected unanswerable — the arm that used to DO the writing.
    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      logger,
    });
    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );
    await settleBeyondOneMacrotask();

    for (const state of SESSION_LIFECYCLE_STATES) {
      const threadId = `thread-resting-${state}`;
      const methods = eventStore
        .listEvents(threadId)
        .map((event) => event.payload.method);
      expect([state, methods]).toEqual([
        state,
        ['request.opened', 'session.state-changed'],
      ]);
      const detail = await service.readSession(
        threadId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      expect([state, detail?.session.lifecycleState]).toEqual([
        state,
        expectedFoldedStates[state],
      ]);
    }
  });

  /**
   * The single case archive#1338's resting-state guard existed for, in its own
   * natural shape: a session that FAILED while holding an open APPROVAL
   * request. Under the pre-guard code the synthetic event stamped `canceled`,
   * erasing the recorded failure and hiding archive#1548's `session-failed`
   * attention item. Nothing stamps anything now, so the failure survives by
   * construction — and this pins the consequence that mattered: the
   * `session-failed` item is still projected, while the request-derived
   * item is not.
   */
  test('a failed session with an unanswerable open approval keeps `failed` and still projects session-failed', async () => {
    const threadId = 'thread-failed-approval';
    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(requestOpenedEvent({ threadId }));
    eventStore.appendEvent(
      stateChangedEvent(threadId, 'failed', {
        to: 'errored',
        transitionSource: 'runtime',
      }),
    );

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      logger,
    });
    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );

    expect(
      eventStore
        .listEvents(threadId)
        .some((event) => event.payload.method === 'request.resolved'),
    ).toBe(false);
    const detail = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.lifecycleState).toBe('failed');

    const projection = new AttentionProjectionService(
      { list: () => [] } as never,
      service,
      { getRunConsole: async () => ({ gates: [] }) } as never,
    );
    const { items } = await projection.list();
    const forThread = items.filter((item) => item.sessionId === threadId);
    expect(forThread.map((item) => item.kind)).toEqual(['session-failed']);
  });

  /**
   * THE RUNS FOLD (archive#1284 HIGH 1, carried forward).
   *
   * HIGH 1 was: a synthetic `request.resolved` folding to `running` put a
   * dead thread on `listAgentRuns` as the freshest ACTIVE work with no
   * `completedAt`. There is no synthetic event now, so that fold cannot be
   * reached at all from this path — but the symptom is what mattered, so it
   * is pinned directly: a failed session holding an open request must not
   * report as `running`.
   *
   * It also pins, in the same test, the DISCLOSED consequence of writing
   * nothing: a session that merely stopped — no terminal event of any kind —
   * keeps reading `waiting_for_approval` rather than acquiring a fabricated
   * cancellation. See the second half.
   */
  test('runs fold: a failed session holding an open request reports as failed, never as the freshest running work', async () => {
    const threadId = 'thread-failed-runs-fold';
    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(requestOpenedEvent({ threadId }));
    eventStore.appendEvent(
      stateChangedEvent(threadId, 'failed', {
        to: 'errored',
        transitionSource: 'runtime',
      }),
    );

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      logger,
    });
    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );

    const runs = await service.listAgentRuns(INTERNAL_SESSION_READ_SCOPE);
    const run = runs.find((candidate) => candidate.runId === threadId);
    // Fixture sanity: the state change really is the last event, so this is
    // the runs fold reading THAT event and not a synthetic one.
    expect(eventStore.listEvents(threadId).at(-1)?.payload.method).toBe(
      'session.state-changed',
    );
    expect(run?.status).toBe('failed');
    expect(run?.status).not.toBe('running');
    // `completedAt` survives, and is now STRICTLY more truthful: it is the
    // recorded transition's own timestamp. archive#1338 produced one by stamping the
    // moment the reconciliation pass RAN, which is not when the session
    // ended — a value with no truthful source, on every reconciled session.
    expect(run?.completedAt).toBe('2026-07-20T00:00:02.000Z');

    // THE DISCLOSED HALF, pinned so it is a decision and not a discovery.
    // A session that simply STOPPED — no `session.exited`, no errored
    // transition, just an open request and a process that died, which is
    // AC1's own fixture — keeps reading `waiting_for_approval` on the runs
    // board. archive#1338's boot pass changed that incidentally, by writing a
    // cancellation whose `completedAt` was the moment the pass ran rather
    // than the moment the session ended. Removing the write returns the runs
    // board to what the log actually says. It is NOT the HIGH-1 symptom
    // (`running`, sorted as the freshest active work) and it is not a claim
    // that anything is in progress.
    const stoppedThreadId = 'thread-stopped-no-terminal-event';
    eventStore.upsertSession({
      provider: 'codex',
      threadId: stoppedThreadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(requestOpenedEvent({ threadId: stoppedThreadId }));
    const stoppedRun = (
      await service.listAgentRuns(INTERNAL_SESSION_READ_SCOPE)
    ).find((candidate) => candidate.runId === stoppedThreadId);
    expect(stoppedRun?.status).toBe('waiting_for_approval');
    expect(stoppedRun?.status).not.toBe('running');
    expect(stoppedRun?.completedAt).toBeUndefined();
  });

  /**
   * `recoveryCoordinator.reconcile()` IS NEVER SKIPPED.
   *
   * archive#1338 pinned this as a consequence of the orphan pass's error isolation
   * ("one poisoned append must not skip reconcile()"). Both the pass and its
   * isolation are gone, but the requirement is not — and archive#1745 has its
   * own reason to hold it: `reconcile()` used to sit BEHIND the provider-
   * registration barrier, delayed by plugin asset loading it has no
   * dependency on. It now runs as soon as recovery settles.
   *
   * Observed through the composed RecoveryLedger Interface, whose `pending()`
   * call `reconcile()` makes synchronously.
   */
  test('recoveryCoordinator.reconcile() runs once recovery settles, no longer behind plugin registration', async () => {
    const threadId = 'thread-recovery-coordinator';
    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(requestOpenedEvent({ threadId }));

    let reconciled = false;
    const original = eventStore.createRecoveryLedger.bind(eventStore);
    eventStore.createRecoveryLedger = () => {
      const ledger = original();
      return {
        ...ledger,
        pending: () => {
          reconciled = true;
          return ledger.pending();
        },
      };
    };

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      logger,
    });
    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );
    await settleBeyondOneMacrotask();

    eventStore.createRecoveryLedger = original;
    expect(reconciled).toBe(true);
  });

  /**
   * archive#1779 delta review, MEDIUM — THE FAIL-OPEN WINDOW MUST CLOSE EVEN
   * WHEN THE STARTUP CHAIN REJECTS.
   *
   * `sessionAttachmentSettled` used to be set on the SUCCESS path of an
   * unguarded `.then()`. Both upstream steps do unguarded store reads, so a
   * throwing store left the flag false for the process lifetime — a
   * PERMANENT fail-open, where the ADR and the PR both claim the window
   * closes when attachment settles — and skipped
   * `recoveryCoordinator.reconcile()` entirely, which is a property this
   * suite pins separately. It also surfaced as an unhandled rejection.
   *
   * The store is made to throw on the read recovery performs. All three
   * consequences are asserted together, because fixing one and not the
   * others is the shape this defect had in the first place.
   */
  test('a rejecting startup chain still settles attachment and still reconciles', async () => {
    const threadId = 'thread-throwing-boot';
    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'closed',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(requestOpenedEvent({ threadId }));
    eventStore.appendEvent(stateChangedEvent(threadId, 'canceled'));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    let reconciled = false;
    const originalLedger = eventStore.createRecoveryLedger.bind(eventStore);
    eventStore.createRecoveryLedger = () => {
      const ledger = originalLedger();
      return {
        ...ledger,
        pending: () => {
          reconciled = true;
          return ledger.pending();
        },
      };
    };
    // Recovery's own session read throws. Restored immediately after
    // `initialize()` so every LATER read in this test is honest — the
    // injection is of a boot-time failure, not of a broken store.
    const originalReadSessions = eventStore.readSessions.bind(eventStore);
    let failNextReadSessions = true;
    eventStore.readSessions = (
      ...args: Parameters<typeof originalReadSessions>
    ) => {
      if (failNextReadSessions) {
        failNextReadSessions = false;
        throw new Error('simulated store failure during recovery');
      }
      return originalReadSessions(...args);
    };

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      logger,
    });

    service.initialize();
    // The receipt firing at all IS the assertion: before the fix this await
    // would never resolve.
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );
    await settleBeyondOneMacrotask();

    eventStore.readSessions = originalReadSessions;
    eventStore.createRecoveryLedger = originalLedger;
    process.off('unhandledRejection', onUnhandled);

    // 1. The window CLOSED: the projection now gives a real answer instead of
    //    failing open forever.
    const settled = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(settled?.session.answerability).toEqual({
      answerable: false,
      qualification: 'past_resume',
      observedBy: expect.any(String),
      observedAt: expect.any(String),
    });
    // 2. Recovery reconciliation still ran.
    expect(reconciled).toBe(true);
    // 3. And the failure did not escape as an unhandled rejection.
    expect(unhandled).toEqual([]);
  });

  test('live-subscribed path: a resolution emitted while the inbox IS subscribed still clears its notification through the bus', async () => {
    const threadId = 'thread-live-subscribed';

    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(requestOpenedEvent({ threadId }));

    const notificationService = new NotificationService(eventBus, tmp, 999_999);
    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      logger,
    });
    const provider = new ApprovalInboxNotificationProvider({
      approvalRegistry: new ApprovalRegistry(logger, { eventBus }),
      orchestrationService: service,
    });
    await notificationService.schedule(
      'approval-inbox',
      approvalNotificationFor(threadId),
    );

    // Wired FIRST, so the sweep finds the request still open and leaves it
    // alone — anything that clears below came off the bus.
    wireApprovalInboxNotifications(
      eventBus,
      provider,
      notificationService,
      logger,
    );
    await notificationService.drainAsyncDispatch();
    expect(
      (await notificationService.list()).find(
        (notification) => notification.metadata?.threadId === threadId,
      )?.status,
    ).not.toBe('actioned');

    // A REAL resolution, the way an adapter's event stream delivers one.
    // archive#1338 used the orphan pass's synthetic event for this; with the pass
    // gone the live path has to be exercised by a live event, which is what
    // it was always meant to cover.
    eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: {
        eventId: `req-resolved-${threadId}`,
        provider: 'codex',
        threadId,
        createdAt: '2026-07-20T00:00:05.000Z',
        method: 'request.resolved',
        requestId: 'req-1',
        status: 'approved',
      } as CanonicalRuntimeEvent,
    });
    await notificationService.drainAsyncDispatch();

    expect(
      (await notificationService.list()).find(
        (notification) => notification.metadata?.threadId === threadId,
      )?.status,
    ).toBe('actioned');

    await notificationService.shutdown();
  });

  /**
   * CROSS-BOOT CONVERGENCE, WITH NO LIVE EVENT AT ALL (archive#1284,
   * HIGH 2). The strongest form of the proof: `initialize()` is never
   * called, so no reconciliation pass runs and nothing is ever emitted on
   * the bus. The event store simply already contains what a PREVIOUS boot
   * wrote, and the notification store still says `delivered` — the two
   * stores are not transactional, which is why bus replay could never have
   * fixed this class.
   *
   * No arrangement of wiring order can make this test pass; only reading
   * the persisted log can. It also pins the four outcomes apart, including
   * the negative control (a genuinely open request must survive the sweep).
   */
  test('cross-boot convergence: hydrated approvals reconcile against the persisted log with no live event, and a still-open request survives the sweep', async () => {
    const cases = [
      {
        threadId: 'thread-xboot-approved',
        resolvedStatus: 'approved' as const,
        expected: 'actioned',
      },
      {
        threadId: 'thread-xboot-expired',
        resolvedStatus: 'expired' as const,
        expected: 'expired',
      },
      // Nothing in the log names this request, so nobody can ever resolve
      // it and its Allow/Deny would dispatch into nothing. `expired`
      // (nobody acted) is honest; `actioned` would claim a decision.
      {
        threadId: 'thread-xboot-unrecorded',
        resolvedStatus: null,
        expected: 'expired',
      },
      // NEGATIVE CONTROL: still genuinely outstanding. If this one also
      // cleared, the sweep would be expiring everything it hydrates rather
      // than deriving anything.
      {
        threadId: 'thread-xboot-open',
        resolvedStatus: undefined,
        expected: 'delivered',
      },
    ];

    const notificationService = new NotificationService(eventBus, tmp, 999_999);
    for (const testCase of cases) {
      if (testCase.resolvedStatus !== null) {
        eventStore.upsertSession({
          provider: 'codex',
          threadId: testCase.threadId,
          status: 'running',
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:01.000Z',
        });
        eventStore.appendEvent(
          requestOpenedEvent({ threadId: testCase.threadId }),
        );
        if (testCase.resolvedStatus !== undefined) {
          eventStore.appendEvent({
            eventId: `req-resolved-${testCase.threadId}`,
            provider: 'codex',
            threadId: testCase.threadId,
            createdAt: '2026-07-20T00:00:05.000Z',
            method: 'request.resolved',
            requestId: 'req-1',
            status: testCase.resolvedStatus,
          } as CanonicalRuntimeEvent);
        }
      }
      await notificationService.schedule('approval-inbox', {
        category: 'approval-request',
        title: 'Tool call awaiting approval: shell.exec',
        priority: 'high',
        actions: [{ id: 'accept', label: 'Allow Once', variant: 'primary' }],
        dedupeTag: `orchestration:${testCase.threadId}:req-1`,
        metadata: {
          provider: 'codex',
          requestId: 'req-1',
          requestKey: `orchestration:${testCase.threadId}:req-1`,
          requestKind: 'orchestration',
          requestType: 'approval',
          sessionId: testCase.threadId,
          sessionKind: 'runtime',
          threadId: testCase.threadId,
        },
      });
    }

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      logger,
    });
    const provider = new ApprovalInboxNotificationProvider({
      approvalRegistry: new ApprovalRegistry(logger, { eventBus }),
      orchestrationService: service,
    });

    // A bus nothing ever emits on: `service.initialize()` is deliberately
    // never called, so no reconciliation pass and no live event exist.
    wireApprovalInboxNotifications(
      eventBus,
      provider,
      notificationService,
      logger,
    );
    await notificationService.drainAsyncDispatch();

    const statusByThread = new Map(
      (await notificationService.list()).map((notification) => [
        notification.metadata?.threadId,
        notification.status,
      ]),
    );
    for (const testCase of cases) {
      expect([
        testCase.threadId,
        statusByThread.get(testCase.threadId),
      ]).toEqual([testCase.threadId, testCase.expected]);
    }

    await notificationService.shutdown();
  });

  /**
   * `readRequestOutcome` IS TOTAL OVER ITS OWN RETURN TYPE (round-3 review,
   * MEDIUM 1).
   *
   * It documents four states and computed each from something — except that
   * a failing `listEvents` propagated out, so the ONE state whose own
   * definition is "no persisted log was readable" was returned only for a
   * missing event store, never for an unreadable one. Safe while the sole
   * call site wrapped it; not safe as a public method that is also part of
   * the approval inbox's `Pick<>` contract, where the next consumer reads
   * the documented type and gets an exception.
   *
   * Both directions in one fixture: the same request, same store, reads
   * `open` while the log is readable and `undetermined` when it is not.
   */
  test('readRequestOutcome answers undetermined for an unreadable log instead of throwing past its own type', async () => {
    const threadId = 'thread-unreadable-log';
    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:01.000Z',
    });
    eventStore.appendEvent(requestOpenedEvent({ threadId }));

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      logger,
    });

    expect(service.readRequestOutcome(threadId, 'req-1')).toEqual({
      state: 'open',
      request: expect.objectContaining({ requestId: 'req-1' }),
    });

    // Fault the method the read path ACTUALLY calls. archive#1867 moved this
    // read off `listEvents` onto the targeted `listEventsForRequest`
    // projection, so stubbing `listEvents` stopped faulting anything: the
    // read succeeded and returned a real 'open' verdict, and this case
    // silently stopped proving the honesty property it exists for — that a
    // failed store read reports 'undetermined' rather than fabricating an
    // outcome.
    const originalListEventsForRequest =
      eventStore.listEventsForRequest.bind(eventStore);
    eventStore.listEventsForRequest = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };
    try {
      expect(service.readRequestOutcome(threadId, 'req-1')).toEqual({
        state: 'undetermined',
      });
    } finally {
      eventStore.listEventsForRequest = originalListEventsForRequest;
    }
  });

  /**
   * DELEGATION PRECEDENCE (round-3 verification: injection 7).
   *
   * `resolveSessionProjectSlug` returns `summary.delegation?.projectSlug ??
   * summary.projectSlug`, and that precedence is the stated reason the
   * review's performance MEDIUM was DECLINED: the cheaper reads it proposed
   * cannot express "delegation-scoped binding first, exactly as
   * `sessionOpenHref`/`resolveNotificationOpenHref` do". The argument is
   * sound and the ruling stands — but every existing test of this method
   * mocks it, so nothing proved the property the ruling rests on.
   *
   * WHERE THE PROPERTY ACTUALLY LIVES, because this matters for what can be
   * pinned at all: `resolveSessionProjectSlug`'s own
   * `summary.delegation?.projectSlug ?? summary.projectSlug` is REDUNDANT —
   * `buildOrchestrationSessionSummary` already computes `projectSlug` as
   * `delegation?.projectSlug ?? …`, so the two operands are provably equal
   * whenever the first is defined and no fixture can separate them. That is
   * why verification's operand-swap injection went uncaught: the swap is
   * unobservable by construction, not unguarded. The local `??` documents
   * intent; the DERIVATION is one layer down.
   *
   * So this pins the property itself, in a fixture where the two candidate
   * bindings genuinely differ: a delegated session carrying
   * `delegated-project` on its `session.started`, and a LATER
   * `session.configured` carrying a different session-level
   * `lifecycle-project`. The delegated binding must win, and it must come
   * out of the replayed event log — which is exactly what the declined
   * cheaper read (a stored column, no replay) could not have delivered.
   */
  test('resolveSessionProjectSlug resolves the delegation-scoped project, outranking a later session-level binding', async () => {
    const threadId = 'thread-delegated-project';
    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:02.000Z',
    });
    eventStore.appendEvent({
      eventId: `started-${threadId}`,
      provider: 'codex',
      threadId,
      createdAt: '2026-07-20T00:00:01.000Z',
      method: 'session.started',
      sessionId: threadId,
      metadata: {
        projectSlug: 'delegated-project',
        taskId: 'task-7',
      },
    } as CanonicalRuntimeEvent);
    // Newer, and NOT delegated: the session-level fold takes its
    // `projectSlug` from the latest such event, so this is the competing
    // candidate.
    eventStore.appendEvent({
      eventId: `configured-${threadId}`,
      provider: 'codex',
      threadId,
      createdAt: '2026-07-20T00:00:02.000Z',
      method: 'session.configured',
      sessionId: threadId,
      metadata: {
        projectSlug: 'lifecycle-project',
      },
    } as CanonicalRuntimeEvent);

    const service = new OrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      logger,
    });

    // Fixture sanity: the delegation context really is the older event, and
    // a different, newer session-level slug really is present — otherwise
    // the assertion below could pass with no precedence at work.
    const detail = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.delegation?.projectSlug).toBe('delegated-project');

    expect(service.resolveSessionProjectSlug(threadId)).toBe(
      'delegated-project',
    );
  });
});
