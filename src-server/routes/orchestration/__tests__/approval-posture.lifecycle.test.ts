/**
 * #2436 / #2418 / #2409: the approval-posture probe table, re-derived under
 * server order and driven end to end through the REAL HTTP routes
 * (`POST /api/orchestration/chat`, `/chat/:id/continue`, `/commands`), the
 * real foreground executor, the real `OrchestrationService` and the real
 * SQLite `EventStore`. Only the engine is a recording fake: each probe reads
 * the posture the engine was asked to run its LAST turn in.
 *
 * "Decide" is a `setApprovalMode` command from any device. A "report" is a
 * turn another device sends with no posture on it — a turn is not a
 * decision. An offline pick reaches the server riding the device's next
 * send (`setApprovalMode` on the `/chat` body) and is ordered by that
 * receipt. Each turn completes, so every continuation starts a new child
 * Session of the conversation: the recorded posture has to carry across
 * them (probes S1 and N).
 *
 * The hard bar: in no probe is the engine more permissive than the latest
 * decision by server order.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type {
  ApprovalMode,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import type { ProviderAdapterMetadata } from '../../../providers/adapter-shape.js';
import type { FullAccessGrant } from '../../../security/coding-authority.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import {
  ApprovalInboxNotificationProvider,
  wireApprovalInboxNotifications,
} from '../../../services/approvals/approval-inbox.js';
import {
  type ExecutionSessionBinding,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createNotificationRoutes } from '../../operations/notifications.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const OWNER = 'posture-owner';
const ENVIRONMENT = 'posture-station';
const CONVERSATION = 'conversation:posture';

class PostureAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Approval posture lifecycle adapter',
    capabilities: ['agent-runtime'],
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  };
  readonly starts: ProviderSessionStartInput[] = [];
  readonly turns: ProviderSendTurnInput[] = [];
  readonly answers: Array<{ requestId: string; decision: string }> = [];
  /** The context each answer reached the adapter with, in order. */
  readonly answerContexts: Array<Record<string, unknown> | undefined> = [];

  /** Sessions holding an open request the engine is waiting on. */
  readonly waiting = new Set<string>();

  override async hasSession(threadId?: string): Promise<boolean> {
    return threadId !== undefined && this.waiting.has(threadId);
  }

  /** Holds an answer until released (the race probe). */
  answerGate: Promise<void> | undefined;
  /** Whether an answer has reached the engine (and any gate). */
  answering = false;
  /**
   * Resolves once the request's resolution is persisted, so an answer
   * returns only after the store reads the request as resolved, as a fast
   * engine's would (the "read before the answer" ordering).
   */
  answerSettled:
    | ((threadId: string, requestId: string) => Promise<void>)
    | undefined;

  override async respondToRequest(
    threadId = '',
    requestId = '',
    decision = '',
    context?: Record<string, unknown>,
  ): Promise<void> {
    this.answering = true;
    await this.answerGate;
    this.answers.push({ requestId, decision });
    this.answerContexts.push(context);
    this.waiting.delete(threadId);
    this.events.push({
      eventId: `${requestId}:resolved`,
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'request.resolved',
      requestId,
      status: decision === 'decline' ? 'denied' : 'approved',
    } as CanonicalRuntimeEvent);
    await this.answerSettled?.(threadId, requestId);
  }

  override async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
    const now = new Date().toISOString();
    this.events.push({
      eventId: `${input.threadId}:configured`,
      method: 'session.configured',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      metadata: input.metadata,
    } as CanonicalRuntimeEvent);
    return {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      createdAt: now,
      updatedAt: now,
    };
  }

  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const turnId = `posture-turn-${this.turns.length}`;
    const base = {
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      createdAt: new Date().toISOString(),
    } as const;
    this.events.push({
      ...base,
      eventId: `${turnId}:started`,
      method: 'turn.started',
      prompt: input.input,
    });
    this.events.push({
      ...base,
      eventId: `${turnId}:completed`,
      method: 'turn.completed',
      outputText: 'done',
    });
    return { threadId: input.threadId, turnId };
  }

  /** The posture the engine was asked to run its latest turn in. */
  lastTurnPosture(): unknown {
    return this.turns.at(-1)?.modelOptions?.approvalMode;
  }
}

function eventually(assertion: () => void | Promise<void>, timeoutMs = 5_000) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const check = async () => {
      try {
        await assertion();
        resolve();
      } catch (error) {
        if (Date.now() - started >= timeoutMs) reject(error);
        else setTimeout(check, 10);
      }
    };
    check();
  });
}

function binding(
  store: EventStore,
  conversationId: string,
): ExecutionSessionBinding | null {
  const root = store.conversationSessions(conversationId)[0];
  if (!root) return null;
  const configured = [...store.listEvents(root.sessionId)]
    .reverse()
    .find((item) => item.payload.method === 'session.configured')?.payload;
  const metadata =
    configured?.method === 'session.configured'
      ? configured.metadata
      : undefined;
  if (!metadata || typeof metadata.environmentId !== 'string') return null;
  return {
    environmentId: metadata.environmentId,
    agentId: 'claude',
    ...(typeof metadata.userId === 'string' ? { userId: metadata.userId } : {}),
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness(roots: string[], stationDefault?: ApprovalMode) {
  const root = mkdtempSync(join(tmpdir(), 'station-approval-posture-'));
  roots.push(root);
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const eventBus = new EventBus();
  const adapter = new PostureAdapter();
  adapter.answerSettled = (threadId, requestId) =>
    eventually(() => {
      expect(store.readCurrentRequestEvent(threadId, requestId)).toMatchObject({
        state: 'found',
        event: { method: 'request.resolved' },
      });
    });
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus,
    eventStore: store,
    resolveSessionAgent: async (input) => ({
      ...input,
      agent: { slug: 'claude' },
    }),
    resolveStationDefaultApprovalMode: async () => stationDefault,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const deps: ExecutionTargetExecutionDependencies = {
    resolveEnvironmentAccess: async () => ({
      apiBase: 'http://posture.station',
      environmentId: ENVIRONMENT,
      environmentName: 'Posture Station',
      kind: 'current',
    }),
    getAgent: async () => ({
      slug: 'claude',
      available: true,
      execution: { agentConnectionId: engineConnectionId('claude') },
    }),
    getConnection: async () => ({
      id: engineConnectionId('claude'),
      name: 'Claude Code',
      type: 'claude',
      kind: 'agent',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { provider: 'claude' },
    }),
    getProject: async () => undefined,
    getProviderAdapter: (provider) => service.getProviderAdapter(provider),
    readSessionBinding: async (_access, id) => binding(store, id),
    resolveConversationSession: async (_access, id, requested) =>
      service.resolveConversationContinuation(
        id,
        INTERNAL_SESSION_READ_SCOPE,
        requested,
      ),
    startSession: async (_access, input) => {
      const started = await service.startSessionInternal(
        { type: 'start-session', input },
        { userId: OWNER },
        {
          conversationIdentity: {
            conversationId: String(input.metadata?.conversationId),
            environmentId: String(input.metadata?.environmentId),
          },
        },
      );
      if (started.status !== 'accepted') throw new Error(started.message);
      await eventually(() => {
        expect(
          store
            .listEvents(input.threadId)
            .some((item) => item.payload.method === 'session.configured'),
        ).toBe(true);
      });
      return undefined;
    },
    sendTurn: async (_access, input) => {
      const dispatched = await service.dispatchWithReceipt(
        { type: 'sendTurn', input },
        { userId: OWNER },
      );
      if (!dispatched.result || !('turnId' in dispatched.result))
        throw new Error('dispatch returned no turn id');
      return { turnId: dispatched.result.turnId };
    },
    recordApprovalMode: (_access, pick) =>
      service.recordApprovalModeDecision(pick),
    createConversationId: () => CONVERSATION,
  };
  const execute = (input: {
    message: string;
    conversationId?: string;
    model?: { options?: Record<string, unknown> };
    setApprovalMode?: ApprovalMode;
    setApprovalModeBasedOn?: number | null;
    /** The route's grant, forwarded as the production composition does. */
    fullAccessGrant?: FullAccessGrant | null;
  }) =>
    executeForegroundMessage(
      {
        message: input.message,
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {}),
        target: {
          environment: { kind: 'current' },
          agent: agentId('claude'),
          ...(input.model ? { model: input.model } : {}),
        },
        ...(input.setApprovalMode
          ? {
              setApprovalMode: input.setApprovalMode,
              setApprovalModeBasedOn: input.setApprovalModeBasedOn,
            }
          : {}),
        ...(input.fullAccessGrant
          ? { fullAccessGrant: input.fullAccessGrant }
          : {}),
        userId: OWNER,
      },
      deps,
    );
  const routes = createOrchestrationRoutes(service, {
    eventBus,
    logger: { debug: vi.fn() },
    getUserId: () => OWNER,
    executeForegroundMessage: (input) => execute(input),
    continueForegroundMessage: (input) =>
      execute({
        message: input.message,
        conversationId: input.conversationId,
        ...(input.fullAccessGrant
          ? { fullAccessGrant: input.fullAccessGrant }
          : {}),
      }),
  });
  const app = new Hono();
  // Every device in these probes acts as the operator in person (the
  // operator credential), which may put a session at full access (#2436
  // escalation authority is pinned in approval-full-access-authority).
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      credential: 'operator-credential-fixture',
      authority: 'operator-credential',
      source: 'bearer',
    });
    await next();
  });
  app.route('/api/orchestration', routes);

  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response;
  };
  // #2540: a follow-up runs in the SAME idle session, which already reads
  // `idle` from the previous turn — so settling counts this send's own
  // completed turn across the lineage rather than trusting the state alone.
  let settledTurns = 0;
  const turnsSettled = async () => {
    settledTurns += 1;
    await eventually(async () => {
      const lineage = store.conversationSessions(CONVERSATION);
      const current = lineage.at(-1);
      expect(current).toBeDefined();
      const completed = lineage.flatMap((item) =>
        store
          .listEvents(item.sessionId)
          .filter((event) => event.payload.method === 'turn.completed'),
      );
      expect(completed.length).toBeGreaterThanOrEqual(settledTurns);
      expect(
        (
          await service.readSession(
            current!.sessionId,
            INTERNAL_SESSION_READ_SCOPE,
          )
        )?.session.lifecycleState,
      ).toBe('idle');
    });
  };
  const currentThread = () =>
    store.conversationSessions(CONVERSATION).at(-1)?.sessionId;

  /**
   * The desktop's client: the latest decision sequence it has folded. It
   * learns sequences only from its own sends' results, never from the
   * phone's decisions (the probes model it missing them).
   */
  let seen: number | null = null;
  const composerSend = async (
    body: Record<string, unknown>,
    carried?: ApprovalMode,
    defaultChannel?: ApprovalMode,
  ) => {
    const response = await post('/api/orchestration/chat', {
      ...body,
      target: {
        environment: { kind: 'current' },
        agent: 'claude',
        ...(defaultChannel
          ? { model: { options: { approvalMode: defaultChannel } } }
          : {}),
      },
      ...(carried
        ? { setApprovalMode: carried, setApprovalModeBasedOn: seen }
        : {}),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const recorded = (
      JSON.parse(text) as {
        data?: { approvalMode?: { sequence: number; recorded: boolean } };
      }
    ).data?.approvalMode;
    if (recorded) seen = recorded.sequence;
    await turnsSettled();
    return recorded;
  };

  return {
    root,
    store,
    service,
    adapter,
    eventBus,
    /** The composer's first send: `/chat`, optionally carrying a pick. */
    firstSend: (carried?: ApprovalMode, defaultChannel?: ApprovalMode) =>
      composerSend({ message: 'first' }, carried, defaultChannel),
    /** A composer send on the existing conversation, maybe carrying a pick. */
    send: (carried?: ApprovalMode, defaultChannel?: ApprovalMode) =>
      composerSend(
        { message: 'again', conversationId: CONVERSATION },
        carried,
        defaultChannel,
      ),
    /**
     * A turn from outside the composer (#2418): attention replies, the
     * delegated-task coordinator and the session-detail composer continue
     * the conversation with no posture on the request at all.
     */
    async continueWithoutPosture() {
      const response = await post(
        `/api/orchestration/chat/${encodeURIComponent(CONVERSATION)}/continue`,
        { message: 'reply' },
      );
      expect(response.status, await response.text()).toBe(200);
      await turnsSettled();
    },
    /**
     * Any other device's decision, through the public command route, made
     * having seen every decision so far (its basis is the latest one).
     */
    async decide(approvalMode: ApprovalMode) {
      const threadId = currentThread();
      expect(threadId).toBeDefined();
      const sequences = store
        .conversationSessions(CONVERSATION)
        .flatMap(({ sessionId }) => store.listEvents(sessionId))
        .filter((row) => row.payload.method === 'session.approval-mode-set')
        .map((row) => row.globalSequence);
      const response = await post('/api/orchestration/commands', {
        type: 'setApprovalMode',
        threadId,
        approvalMode,
        basedOnSequence: sequences.length > 0 ? Math.max(...sequences) : null,
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      return JSON.parse(text) as {
        data: { approvalMode: ApprovalMode; sequence: number };
      };
    },
    post,
    currentThread,
    /** The engine opens an approval request on the current session. */
    async openRequest(requestId: string, payload: Record<string, unknown>) {
      const threadId = currentThread()!;
      adapter.waiting.add(threadId);
      adapter.events.push({
        eventId: `${requestId}:opened`,
        provider: adapter.provider,
        threadId,
        createdAt: new Date().toISOString(),
        method: 'request.opened',
        requestId,
        requestType: 'approval',
        title: `Allow ${String(payload.toolName)}`,
        payload,
      } as CanonicalRuntimeEvent);
      await eventually(() => {
        expect(store.readCurrentRequestEvent(threadId, requestId).state).toBe(
          'found',
        );
      });
      return threadId;
    },
    decisionEvents: () =>
      store
        .conversationSessions(CONVERSATION)
        .flatMap(({ sessionId }) => store.listEvents(sessionId))
        .map((row) => row.payload)
        .filter((payload) => payload.method === 'session.approval-mode-set'),
    decisions: () =>
      store
        .conversationSessions(CONVERSATION)
        .flatMap(({ sessionId }) => store.listEvents(sessionId))
        .filter((row) => row.payload.method === 'session.approval-mode-set')
        .map((row) =>
          row.payload.method === 'session.approval-mode-set'
            ? row.payload.approvalMode
            : undefined,
        ),
  };
}

describe('approval posture probe table under server order (#2436)', () => {
  const roots: string[] = [];
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.service.shutdown();
      harness.store.close();
    }
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  async function harness(stationDefault?: ApprovalMode) {
    const created = await createHarness(roots, stationDefault);
    harnesses.push(created);
    return created;
  }

  test('a pick made before the chat had a session spawns it and is recorded', async () => {
    const h = await harness();
    await h.firstSend('never');
    expect(h.adapter.starts[0]?.modelOptions?.approvalMode).toBe('never');
    expect(h.adapter.lastTurnPosture()).toBe('never');
    const decisions = h.store
      .listEvents(h.currentThread()!)
      .filter((row) => row.payload.method === 'session.approval-mode-set');
    expect(decisions).toHaveLength(1);
  });

  test('#2418: a turn continued from outside the composer runs at the recorded posture', async () => {
    const h = await harness();
    await h.firstSend('never');
    await h.decide('ask');
    await h.continueWithoutPosture();
    expect(h.adapter.lastTurnPosture()).toBe('ask');
    // A new child Session spawned for that turn, in the recorded posture.
    expect(h.adapter.starts.at(-1)?.modelOptions?.approvalMode).toBe('ask');
  });

  describe('#2915: an "Auto-accept file edits for this session" answer', () => {
    const acceptEdits = {
      type: 'setMode',
      mode: 'acceptEdits',
      destination: 'session',
    };
    const answer = (
      h: Harness,
      threadId: string,
      requestId: string,
      decision: string,
    ) =>
      h.post('/api/orchestration/commands', {
        type: 'respondToRequest',
        threadId,
        requestId,
        decision,
      });

    test('records Auto for the conversation: the next turn keeps it, and picking Ask ends it', async () => {
      const h = await harness();
      await h.firstSend('ask');
      const threadId = await h.openRequest('req-edit', {
        toolName: 'Edit',
        toolInput: { file_path: '/work/a/x.ts' },
        suggestions: [acceptEdits],
      });
      const response = await answer(
        h,
        threadId,
        'req-edit',
        'acceptForSession',
      );
      expect(response.status, await response.text()).toBe(200);
      await eventually(() => {
        expect(
          h.store.readCurrentRequestEvent(threadId, 'req-edit'),
        ).toMatchObject({
          state: 'found',
          event: { method: 'request.resolved' },
        });
      });
      expect(h.adapter.answers.at(-1)).toEqual({
        requestId: 'req-edit',
        decision: 'acceptForSession',
      });
      expect(h.decisions().at(-1)).toBe('auto');

      await h.send();
      expect(h.adapter.lastTurnPosture()).toBe('auto');

      await h.decide('ask');
      await h.send();
      expect(h.adapter.lastTurnPosture()).toBe('ask');
    });

    test('the recorded Auto carries the answering caller, as a setApprovalMode pick does', async () => {
      const h = await harness();
      await h.firstSend();
      await h.decide('ask');
      const threadId = await h.openRequest('req-edit', {
        toolName: 'Edit',
        toolInput: { file_path: '/work/a/x.ts' },
        suggestions: [acceptEdits],
      });
      const response = await answer(
        h,
        threadId,
        'req-edit',
        'acceptForSession',
      );
      expect(response.status, await response.text()).toBe(200);
      const [picked, recorded] = h.decisionEvents().slice(-2);
      expect(picked).toMatchObject({ approvalMode: 'ask' });
      expect(recorded).toMatchObject({ approvalMode: 'auto' });
      expect(recorded?.clientOrigin).toBeDefined();
      expect(recorded?.clientOrigin).toEqual(picked?.clientOrigin);
      // This harness's operator credential resolves no principal, on either.
      expect(recorded?.principal).toEqual(picked?.principal);
    });

    test('the recorded Auto carries the dispatching principal and origin', async () => {
      const h = await harness();
      await h.firstSend('ask');
      const threadId = await h.openRequest('req-edit', {
        toolName: 'Edit',
        toolInput: { file_path: '/work/a/x.ts' },
        suggestions: [acceptEdits],
      });
      const principal = humanPrincipal(
        'github',
        'posture-owner',
        'Posture Owner',
      );
      const clientOrigin: ClientOrigin = {
        version: 1,
        actor: { kind: 'device', deviceId: 'pixel-10' },
        reported: { version: 1, surface: 'mobile', build: '1' },
      };
      await h.service.dispatchWithReceipt(
        {
          type: 'respondToRequest',
          threadId,
          requestId: 'req-edit',
          decision: 'acceptForSession',
        },
        {
          userId: OWNER,
          principal,
          clientOrigin,
          approvalModeAuthority: true,
        },
      );
      expect(h.decisionEvents().at(-1)).toMatchObject({
        approvalMode: 'auto',
        principal,
        clientOrigin,
      });
    });

    test.each(['ask', 'auto', 'never'] as const)(
      'a %s decision recorded while the engine takes the answer wins: nothing more is recorded',
      async (meanwhile) => {
        const h = await harness();
        await h.firstSend('ask');
        const threadId = await h.openRequest('req-edit', {
          toolName: 'Edit',
          toolInput: { file_path: '/work/a/x.ts' },
          suggestions: [acceptEdits],
        });
        let release!: () => void;
        h.adapter.answerGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const answering = answer(h, threadId, 'req-edit', 'acceptForSession');
        await eventually(() => expect(h.adapter.answering).toBe(true));
        await h.decide(meanwhile);
        release();
        const response = await answering;
        expect(response.status, await response.text()).toBe(200);
        expect(h.decisions()).toEqual(['ask', meanwhile]);

        await h.send();
        expect(h.adapter.lastTurnPosture()).toBe(meanwhile);
      },
    );

    test.each([
      ['a recorded Ask', 'ask', ['ask']],
      // A delegated child starts with the default posture applied but no
      // decision recorded, so no later turn would undo an acceptEdits.
      ['no recorded decision', undefined, []],
    ] as const)(
      'an answer without setApprovalMode authority is a one-call accept, with %s',
      async (_case, pick, decisions) => {
        const h = await harness();
        await h.firstSend(pick);
        const threadId = await h.openRequest('req-edit', {
          toolName: 'Edit',
          toolInput: { file_path: '/work/a/x.ts' },
          suggestions: [acceptEdits],
        });
        // The delegated respond path dispatches with the caller's identity but
        // not the command route's approval authority.
        await h.service.dispatchWithReceipt(
          {
            type: 'respondToRequest',
            threadId,
            requestId: 'req-edit',
            decision: 'acceptForSession',
          },
          { userId: OWNER },
        );
        // `accept` forwards no suggestion, so the engine stays in its mode.
        expect(h.adapter.answers.at(-1)).toEqual({
          requestId: 'req-edit',
          decision: 'accept',
        });
        expect(h.decisions()).toEqual(decisions);
      },
    );

    test('an acceptForSession posted directly to the inbox card is a one-call accept', async () => {
      const h = await harness();
      await h.firstSend();
      // Inside the harness's own temporary root, which afterEach removes.
      const dir = join(h.root, 'notifications');
      mkdirSync(dir);
      const notifications = new NotificationService(h.eventBus, dir, 999_999);
      const provider = new ApprovalInboxNotificationProvider({
        approvalRegistry: { has: () => false, resolve: () => false },
        orchestrationService: h.service,
      });
      notifications.addProvider(provider);
      const unwire = wireApprovalInboxNotifications(
        h.eventBus,
        provider,
        notifications,
        { debug: vi.fn(), warn: vi.fn() },
      );
      await notifications.start();
      try {
        await h.openRequest('req-edit', {
          toolName: 'Edit',
          toolInput: { file_path: '/work/a/x.ts' },
          suggestions: [acceptEdits],
        });
        let card: { id: string; actions?: Array<{ id: string }> } | undefined;
        await eventually(async () => {
          await notifications.drainAsyncDispatch();
          card = (await notifications.list())[0];
          expect(card).toBeDefined();
        });
        // The card does not offer it; the action id is posted anyway.
        expect(card?.actions?.map((action) => action.id)).toEqual([
          'accept',
          'decline',
        ]);
        const routes = new Hono();
        routes.use('*', async (c, next) => {
          setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
            credential: 'operator-credential-fixture',
            authority: 'operator-credential',
            source: 'bearer',
          });
          await next();
        });
        routes.route('/', createNotificationRoutes(notifications));
        const response = await routes.request(
          `/${card!.id}/action/acceptForSession`,
          { method: 'POST' },
        );
        expect(response.status, await response.text()).toBe(200);
        expect(h.adapter.answers.at(-1)).toEqual({
          requestId: 'req-edit',
          decision: 'accept',
        });
        expect(h.decisions()).toEqual([]);
      } finally {
        unwire();
        await notifications.shutdown();
      }
    });

    describe('the Station browser server grant on the answer wire', () => {
      const browserCall = {
        toolName: 'mcp__station-browser__browser_click',
        toolInput: { ref: 'e1' },
        stationBrowserServer: true,
      };
      const post = (
        h: Harness,
        threadId: string,
        body: Record<string, unknown>,
      ) =>
        h.post('/api/orchestration/commands', {
          type: 'respondToRequest',
          threadId,
          requestId: 'req-browser',
          ...body,
        });

      test('the typed scope reaches the adapter beside acceptForSession, and records no posture', async () => {
        const h = await harness();
        await h.firstSend('ask');
        const threadId = await h.openRequest('req-browser', browserCall);
        const response = await post(h, threadId, {
          decision: 'acceptForSession',
          sessionGrantScope: 'server',
        });
        expect(response.status, await response.text()).toBe(200);
        expect(h.adapter.answers.at(-1)).toEqual({
          requestId: 'req-browser',
          decision: 'acceptForSession',
        });
        expect(h.adapter.answerContexts.at(-1)).toMatchObject({
          sessionGrantScope: 'server',
        });
        expect(h.decisions()).toEqual(['ask']);
      });

      test("an older client's plain acceptForSession reaches the adapter with no scope", async () => {
        const h = await harness();
        await h.firstSend('ask');
        const threadId = await h.openRequest('req-browser', browserCall);
        const response = await post(h, threadId, {
          decision: 'acceptForSession',
        });
        expect(response.status, await response.text()).toBe(200);
        expect(h.adapter.answerContexts.at(-1)?.sessionGrantScope).toBe(
          undefined,
        );
      });

      test('a scope other than the typed value is refused at the route', async () => {
        const h = await harness();
        await h.firstSend('ask');
        const threadId = await h.openRequest('req-browser', browserCall);
        const response = await post(h, threadId, {
          decision: 'acceptForSession',
          sessionGrantScope: 'tool',
        });
        expect(response.status).toBe(400);
        expect(h.adapter.answers).toEqual([]);
      });

      test('a scope on any other decision is not forwarded', async () => {
        const h = await harness();
        await h.firstSend('ask');
        const threadId = await h.openRequest('req-browser', browserCall);
        const response = await post(h, threadId, {
          decision: 'accept',
          sessionGrantScope: 'server',
        });
        expect(response.status, await response.text()).toBe(200);
        expect(h.adapter.answerContexts.at(-1)?.sessionGrantScope).toBe(
          undefined,
        );
      });
    });

    test('records nothing for any other session answer', async () => {
      const h = await harness();
      await h.firstSend('ask');
      const threadId = await h.openRequest('req-bash', {
        toolName: 'Bash',
        toolInput: { command: 'git status' },
      });
      const response = await answer(
        h,
        threadId,
        'req-bash',
        'acceptForSession',
      );
      expect(response.status, await response.text()).toBe(200);
      expect(h.decisions()).toEqual(['ask']);
    });

    test('never loosens a standing full access into Auto', async () => {
      const h = await harness();
      await h.firstSend('never');
      const threadId = await h.openRequest('req-edit', {
        toolName: 'Edit',
        toolInput: { file_path: '/work/a/x.ts' },
        suggestions: [acceptEdits],
      });
      const response = await answer(
        h,
        threadId,
        'req-edit',
        'acceptForSession',
      );
      expect(response.status, await response.text()).toBe(200);
      expect(h.decisions()).toEqual(['never']);
    });
  });

  test('the command route refuses a posture that is not one', async () => {
    const h = await harness();
    await h.firstSend();
    const response = await h.post('/api/orchestration/commands', {
      type: 'setApprovalMode',
      threadId: h.currentThread(),
      approvalMode: 'yolo',
      basedOnSequence: null,
    });
    expect(response.status).toBe(400);
  });

  type Step =
    | { kind: 'first'; carried?: ApprovalMode; defaultChannel?: ApprovalMode }
    | { kind: 'decide'; mode: ApprovalMode }
    | { kind: 'send'; carried?: ApprovalMode; defaultChannel?: ApprovalMode }
    | { kind: 'report' };

  /**
   * The engine posture at the last turn. `undefined`: the engine was sent no
   * posture and keeps its own configuration.
   */
  const probes: Array<{
    probe: string;
    steps: Step[];
    expected: ApprovalMode | undefined;
    stationDefault?: ApprovalMode;
  }> = [
    {
      probe: 'E: desktop decides never, the phone decides Ask',
      steps: [
        { kind: 'first', carried: 'never' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
    {
      probe: 'G: the desktop decides never online, then the phone decides Ask',
      steps: [
        { kind: 'first' },
        { kind: 'decide', mode: 'never' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'G-off: the desktop picks never offline, the phone decides Ask, the desktop reconnects and sends: the pick it made without seeing Ask is dropped (compare-and-set)',
      steps: [
        { kind: 'first' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send', carried: 'never' },
      ],
      expected: 'ask',
    },
    {
      probe: 'R: the desktop decides Ask, then the phone decides never',
      steps: [
        { kind: 'first', carried: 'ask' },
        { kind: 'decide', mode: 'never' },
        { kind: 'send' },
      ],
      expected: 'never',
    },
    {
      probe:
        'R-report: the desktop decides Ask; the phone only sends a turn (a report, not a decision)',
      steps: [
        { kind: 'first', carried: 'ask' },
        { kind: 'report' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'T1: Ask picked offline reaches the server with the reconnect send',
      steps: [
        { kind: 'first', carried: 'auto' },
        { kind: 'report' },
        { kind: 'send', carried: 'ask' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'S1/Q: Ask decided, the phone decides never; the next session (a new child) runs at never',
      steps: [
        { kind: 'first', carried: 'ask' },
        { kind: 'decide', mode: 'never' },
        { kind: 'send' },
      ],
      expected: 'never',
    },
    {
      probe:
        'T3: Ask decided; the default channel carries the Station default never',
      steps: [
        { kind: 'first', carried: 'ask' },
        { kind: 'send', defaultChannel: 'never' },
      ],
      expected: 'ask',
    },
    {
      probe: 'S2: Auto decided, the phone tightens to Ask',
      steps: [
        { kind: 'first', carried: 'auto' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'H: Default decided on a conversation Station never set: nothing is sent',
      steps: [
        { kind: 'first' },
        { kind: 'decide', mode: 'connection-default' },
        { kind: 'send' },
      ],
      expected: undefined,
    },
    {
      probe: 'I: never decided, then Ask decided; the phone only reports never',
      steps: [
        { kind: 'first', carried: 'never' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'report' },
      ],
      expected: 'ask',
    },
    {
      probe:
        'N: never decided, the session ends; the next child starts at never, not the Station default',
      stationDefault: 'auto',
      steps: [
        { kind: 'first', carried: 'never' },
        { kind: 'send', defaultChannel: 'auto' },
      ],
      expected: 'never',
    },
    {
      probe:
        'M1: Auto decided; the phone tightens to Ask while the desktop is disconnected; the desktop sends',
      steps: [
        { kind: 'first', carried: 'auto' },
        { kind: 'decide', mode: 'ask' },
        { kind: 'send' },
      ],
      expected: 'ask',
    },
  ];

  test.each(probes)('$probe', async ({ steps, expected, stationDefault }) => {
    const h = await harness(stationDefault);
    for (const step of steps) {
      if (step.kind === 'first')
        await h.firstSend(step.carried, step.defaultChannel);
      else if (step.kind === 'decide') await h.decide(step.mode);
      else if (step.kind === 'send')
        await h.send(step.carried, step.defaultChannel);
      else await h.continueWithoutPosture();
    }
    expect(h.adapter.lastTurnPosture()).toBe(expected);
  });
});
