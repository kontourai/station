/**
 * #3568 at the route: `POST /chat` with `whenBusy: 'queue'` hands a follow-up
 * to a busy conversation's inbox instead of sending it; the inbox sends it
 * when the turn ends. Real pieces: the route, the production
 * `executeForegroundMessage`, a real `OrchestrationService`, the SQLite turn
 * ledger and the inbox on the same EventStore. Only the engine is scripted.
 */
import { join } from 'node:path';
import type { ConversationKeyInspection } from '@kontourai/monument';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import {
  type ConversationInboxEntry,
  FOREGROUND_MESSAGE_INDETERMINATE_CODE,
  type TurnDeliveryInspection,
} from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  ProviderTurnInProgressError,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import {
  type ExecutionSessionBinding,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { AttachmentStagingService } from '../../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../../../services/orchestration/session-lifecycle-service.js';
import { turnDedupKey } from '../../../services/orchestration/sqlite-turn-dedup-persistence.js';
import { ThreadInboxDelivery } from '../../../services/orchestration/thread-inbox.js';
import { foregroundTurnSubmissionDigest } from '../../../services/orchestration/turn-submission-digest.js';
import {
  createOrchestrationRoutes,
  isForegroundDispatchHandle,
  isForegroundIndeterminateShape,
} from '../orchestration.js';

const OWNER = 'inbox-owner';
const STRANGER = 'inbox-stranger';
const READER = 'inbox-reader';
const ENVIRONMENT = 'inbox-station';
const AGENT = agentId('claude');
const CONVERSATION = 'conversation:inbox';

class ScriptedAdapter implements ProviderAdapterShape {
  readonly provider = 'claude' as const;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Inbox qualification adapter',
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
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly turns: ProviderSendTurnInput[] = [];
  readonly starts: ProviderSessionStartInput[] = [];
  /** Leave each turn running until `complete` ends it. */
  holdTurns = false;
  /** Refuse the next send as a turn the engine opened itself. */
  refuseNextAsBusy = false;
  /** Take the next send and never answer it (the engine may have it). */
  hangNextSend = false;
  /** Take the next send and answer it only once `releaseHeldSend` runs. */
  holdNextSend = false;
  releaseHeldSend: (() => void) | undefined;
  private readonly sessions = new Set<string>();
  private open:
    | Readonly<{ threadId: string; turnId: string; invocationId?: string }>
    | undefined;

  async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
    const now = new Date().toISOString();
    for (const method of ['session.started', 'session.configured'] as const)
      this.events.push({
        eventId: `${input.threadId}:${method}`,
        method,
        provider: this.provider,
        threadId: input.threadId,
        sessionId: input.threadId,
        createdAt: now,
        metadata: input.metadata,
      } as CanonicalRuntimeEvent);
    this.sessions.add(input.threadId);
    return {
      provider: this.provider,
      threadId: input.threadId,
      // The model it started with, as an engine that confirms it reports.
      ...(input.modelId ? { model: input.modelId } : {}),
      status: 'ready' as const,
      createdAt: now,
      updatedAt: now,
    };
  }

  async sendTurn(input: ProviderSendTurnInput) {
    if (this.refuseNextAsBusy) {
      this.refuseNextAsBusy = false;
      throw new ProviderTurnInProgressError();
    }
    this.turns.push(input);
    const request = Object.freeze({
      threadId: input.threadId,
      turnId: `inbox-turn-${this.turns.length}`,
      invocationId: input.invocationId,
    });
    if (this.hangNextSend) {
      this.hangNextSend = false;
      return new Promise<never>(() => {});
    }
    if (this.holdNextSend) {
      this.holdNextSend = false;
      await new Promise<void>((resolve) => {
        this.releaseHeldSend = resolve;
      });
    }
    const { threadId, turnId, invocationId } = request;
    this.events.push({
      provider: this.provider,
      threadId,
      turnId,
      invocationId,
      createdAt: new Date().toISOString(),
      eventId: `${turnId}:started`,
      method: 'turn.started',
      prompt: input.input,
    });
    if (this.holdTurns) this.open = request;
    else this.end(request);
    return { threadId: input.threadId, turnId };
  }

  /** End the turn left running. */
  complete() {
    const open = this.open;
    this.open = undefined;
    if (open) this.end(open);
  }

  private end(
    request: Readonly<{
      threadId: string;
      turnId: string;
      invocationId?: string;
    }>,
  ) {
    const { threadId, turnId, invocationId } = request;
    this.events.push({
      provider: this.provider,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
      eventId: `${turnId}:completed`,
      invocationId,
      method: 'turn.completed',
      outputText: 'ok',
    });
  }

  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }
  async retireSession(threadId: string) {
    await this.stopSession(threadId);
    return { status: 'retired' as const };
  }
  async listSessions() {
    return [];
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }
  async stopAll(): Promise<void> {}
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
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
    void check();
  });
}

function currentBinding(
  store: EventStore,
  conversationId: string,
): ExecutionSessionBinding | null {
  const current = store.conversationSessions(conversationId).at(-1);
  if (!current) return null;
  const metadata = store
    .listEvents(current.sessionId)
    .map((item) => item.payload)
    .reverse()
    .find((event) => event.method === 'session.configured')?.metadata;
  if (!metadata || typeof metadata.environmentId !== 'string') return null;
  return {
    environmentId: metadata.environmentId,
    agentId: String(metadata.agentId ?? metadata.targetId),
    ...(typeof metadata.userId === 'string' ? { userId: metadata.userId } : {}),
  };
}

describe('POST /chat whenBusy queue (#3568)', () => {
  const tempDir = trackTempDirs();
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  function station(
    options: {
      inbox?: boolean;
      continueThroughExecutor?: true;
      stagedAttachments?: true;
      /** Reopen another process's home (a restart). */
      root?: string;
      /** This process's birth: an earlier birth's claims read as dead. */
      birth?: string;
      /** The inbox's start deadline (default: production's). */
      placementDeadlineMs?: number;
      /**
       * An engine that cannot change model per turn: a send naming another
       * model continues in a new Session (`needsModelRestart`).
       */
      modelPerTurn?: false;
    } = {},
  ) {
    const root = options.root ?? tempDir('station-inbox-');
    const birth = options.birth;
    const store = new EventStore(
      join(root, 'orchestration.sqlite'),
      512,
      ...(birth
        ? [
            {
              exact: () => ({ pid: process.pid, start: birth }),
              probe: () => ({
                state: 'exact' as const,
                identity: { pid: process.pid, start: birth },
              }),
            },
          ]
        : []),
    );
    const adapter = new ScriptedAdapter();
    if (options.stagedAttachments)
      adapter.metadata.capabilities = [
        ...adapter.metadata.capabilities,
        'file-input',
      ];
    const staging = new AttachmentStagingService();
    cleanup.push(() => staging.dispose());
    if (options.modelPerTurn === false && adapter.metadata.modelLaunch)
      (
        adapter.metadata.modelLaunch as { overridePerTurn: boolean }
      ).overridePerTurn = false;
    const bus = new EventBus();
    const service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'claude' ? adapter : undefined),
        list: () => [adapter],
      } satisfies IProviderAdapterRegistry,
      eventBus: bus,
      eventStore: store,
      // A personal Station that lets READER read (and so continue) OWNER's
      // conversations, as a paired person's second account would.
      personalConversationAccess: {
        canRead: (requesterId, ownerId) =>
          requesterId === READER && ownerId === OWNER,
        ownerIds: (requesterId) =>
          requesterId === READER ? [READER, OWNER] : undefined,
      },
      loadAgentExecutionConfig: async () => ({}),
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) => ({
          name: slug,
          prompt: 'Inbox qualification agent',
          skills: [],
          tools: { mcpServers: [] },
        }),
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    /**
     * Set to hold the inbox's next start before it reaches the continuation,
     * on a Session that is already running (a warm start).
     */
    const inboxStartGate: { wait?: Promise<void> } = {};
    /**
     * Set to hold the next Session start, as a cold start does: until the new
     * Session exists, no turn claim holds the send's key.
     */
    const coldStartGate: { wait?: Promise<void>; entered: number } = {
      entered: 0,
    };
    /**
     * Set to hold the next turn send before the service claims its key, the
     * window in which no Session's ledger holds it yet.
     */
    const sendTurnGate: { wait?: Promise<void>; entered: number } = {
      entered: 0,
    };
    /** Set to answer the conversation-wide ledger read with this instead. */
    const ledger: { answer?: ConversationKeyInspection } = {};
    const deps: ExecutionTargetExecutionDependencies = {
      readPendingConversationSubmission: (
        _access,
        conversationId,
        clientTurnId,
        userId,
      ) =>
        service.readPendingConversationSubmission(
          conversationId,
          clientTurnId,
          INTERNAL_SESSION_READ_SCOPE,
          userId,
        ),
      inspectConversationTurnKey: (
        _access,
        conversationId,
        clientTurnId,
        inputDigest,
      ) =>
        ledger.answer ??
        service.inspectTurnDelivery(
          conversationId,
          clientTurnId,
          INTERNAL_SESSION_READ_SCOPE,
          inputDigest,
        ),
      // As production composes it (station-control-delegation.ts).
      joinConversationTurnKey: (
        _access,
        sessionId,
        clientTurnId,
        signal,
        inputDigest,
      ) =>
        service.joinHeldTurnKey(sessionId, clientTurnId, signal, inputDigest),
      resolveEnvironmentAccess: async () => ({
        apiBase: 'http://inbox.station',
        environmentId: ENVIRONMENT,
        environmentName: 'Inbox Station',
        kind: 'current',
      }),
      getAgent: async (_access, id) => ({
        slug: id,
        available: true,
        executionDefault: true,
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
      getConnection: async () => ({
        id: engineConnectionId('claude'),
        name: 'Claude Code',
        type: 'claude-runtime',
        kind: 'agent',
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
        prerequisites: [],
        config: { provider: 'claude' },
      }),
      getProject: vi.fn(),
      // The live path's own rule for a reader who is not the owner.
      canContinueConversation: (_access, conversationId, userId) =>
        service.canUserReadSession(conversationId, authority(userId)),
      getProviderAdapter: (provider) => service.getProviderAdapter(provider),
      readInitialConversationContext: async () => undefined,
      readSessionBinding: async (_access, id) => currentBinding(store, id),
      resolveConversationSession: async (_access, id, requested) =>
        service.resolveConversationContinuation(
          id,
          INTERNAL_SESSION_READ_SCOPE,
          requested,
        ),
      startSession: async (_access, input) => {
        const gate = coldStartGate.wait;
        coldStartGate.wait = undefined;
        if (gate) {
          coldStartGate.entered += 1;
          await gate;
        }
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
            currentBinding(store, String(input.metadata?.conversationId)),
          ).not.toBeNull();
        });
        return undefined;
      },
      sendTurn: async (_access, input, context) => {
        const gate = sendTurnGate.wait;
        sendTurnGate.wait = undefined;
        if (gate) {
          sendTurnGate.entered += 1;
          await gate;
        }
        const dispatched = await service.dispatchWithReceipt(
          { type: 'sendTurn', input },
          { userId: OWNER },
          { submissionDigest: context?.submissionDigest },
        );
        if (!dispatched.result || !('turnId' in dispatched.result))
          throw new Error('dispatch returned no turn id');
        return { turnId: dispatched.result.turnId };
      },
    };
    /** Set to lose the inbox's answer after the engine took the turn (a crash). */
    const crashAfterStart: { armed: boolean; release?: () => void } = {
      armed: false,
    };
    const authority = (userId: string) =>
      sessionReadAuthorityFromRequest(userId, undefined, undefined);
    // A new delivery over the same store and service: a restarted process.
    const makeInbox = () =>
      new ThreadInboxDelivery({
        store: store.threadInboxStore(),
        foldEvents: (threadId) =>
          store
            .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
            .map((stored) => ({
              sequence: stored.sequence,
              event: stored.payload,
            })),
        headSequence: (threadId) =>
          store.readSessionInventoryHighWater(threadId),
        readInputlessTurnDisposition: (threadId) =>
          store.readInputlessTurnDisposition(threadId),
        readInvocationTerminal: (threadId, invocationId, turnId) =>
          store.readInvocationTerminal(threadId, invocationId, turnId),
        coordinatorBusy: (threadId) => service.hasActiveTurn(threadId),
        hasPossibleEffect: (threadId) =>
          store.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
        conversationOf: (threadId) =>
          store.conversationForSession(threadId)?.conversationId ?? threadId,
        currentSessionId: (conversationId) =>
          service.currentConversationSessionId(conversationId),
        // The live continuation's own rule, as production composes it.
        mayContinue: (conversationId, userId) =>
          service.sessionRecordedOwnerId(
            service.currentConversationSessionId(conversationId),
          ) === userId ||
          service.canUserReadSession(conversationId, authority(userId)),
        deviceMaySend: () => true,
        inspectDelivery: (
          conversationId,
          clientTurnId,
          inputDigest,
          userId,
        ) => {
          if (!userId)
            throw new Error('The requested conversation is unavailable.');
          return service.inspectTurnDelivery(
            conversationId,
            clientTurnId,
            authority(userId),
            inputDigest,
          );
        },
        // The continuation a placement makes, through the same foreground
        // execution the route uses, as the recorded sender.
        start: async ({ conversationId, payload, clientTurnId }) => {
          const gate = inboxStartGate.wait;
          inboxStartGate.wait = undefined;
          if (gate) await gate;
          try {
            const handle = await executeForegroundMessage(
              {
                target: { environment: { kind: 'current' }, agent: AGENT },
                message: payload.message,
                conversationId,
                clientTurnId,
                userId: payload.actor.userId,
                ownerAttribution: undefined,
                fullAccessGrant: null,
              } as never,
              deps,
              { submissionDigest: payload.inputDigest, inboxPlacement: true },
            );
            if (!isForegroundDispatchHandle(handle))
              return { outcome: 'indeterminate' };
            if (crashAfterStart.armed)
              return new Promise((_resolve, reject) => {
                crashAfterStart.release = () =>
                  reject(new Error('The process is gone.'));
              });
            return {
              outcome: 'started',
              conversationId: handle.conversationId,
              sessionId: (handle as { sessionId: string }).sessionId,
              turnId: handle.providerTurnId,
            };
          } catch (error) {
            if (isForegroundIndeterminateShape(error))
              return { outcome: 'indeterminate' };
            throw error;
          }
        },
        subscribe: (listener) =>
          bus.subscribe((frame) => {
            const event = (frame.data as { event?: CanonicalRuntimeEvent })
              ?.event;
            if (frame.event === 'orchestration:event' && event)
              listener({ threadId: event.threadId, method: event.method });
          }),
        logger: { warn: vi.fn() },
        retryDelaysMs: [20, 50, 100],
        ...(options.placementDeadlineMs
          ? { placementDeadlineMs: options.placementDeadlineMs }
          : {}),
      });
    const inbox = makeInbox();
    inbox.start();
    cleanup.push(() => {
      store.close();
    });
    cleanup.push(() => service.shutdown());
    cleanup.push(async () => {
      inbox.stop();
      await inbox.idle();
    });
    let caller = OWNER;
    /**
     * `/chat/:id/continue` reached its continuation with these keys. A
     * recorder: what is tested there is what the route lets through.
     */
    const continuations: Array<{ clientTurnId?: string; userId: string }> = [];
    /** Set to make the recorder refuse with this code, as a continuation can. */
    const continueRefusal: { code?: string } = {};
    const app = new Hono();
    app.route(
      '/api/orchestration',
      createOrchestrationRoutes(service, {
        eventBus: bus,
        logger: { debug: vi.fn() },
        getUserId: () => caller,
        ...(options.stagedAttachments
          ? {
              resolvePrincipal: () => ({
                id: caller,
                kind: 'human' as const,
                display: caller,
              }),
              hydrateStagedAttachments: (
                principal,
                references,
                binding,
                options,
              ) =>
                staging.bindAndHydrate(
                  { principalId: principal.id },
                  references,
                  binding,
                  options,
                ),
              releaseStagedAttachments: (principal, references, binding) =>
                staging.releaseBinding(
                  { principalId: principal.id },
                  references,
                  binding,
                ),
              acceptStagedAttachments: (principal, references, binding) =>
                staging.acceptBinding(
                  { principalId: principal.id },
                  references,
                  binding,
                ),
            }
          : {}),
        executeForegroundMessage: (input) =>
          executeForegroundMessage(input, deps),
        continueForegroundMessage: async (input) => {
          continuations.push({
            ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}),
            userId: input.userId,
          });
          if (continueRefusal.code)
            throw Object.assign(new Error('refused'), {
              code: continueRefusal.code,
            });
          if (options.continueThroughExecutor)
            return executeForegroundMessage(
              {
                ...input,
                target: {
                  environment: { kind: 'current' },
                  agent: AGENT,
                  ...(input.model ? { model: input.model } : {}),
                },
              },
              deps,
            );
          return {} as never;
        },
        ...(options.inbox === false ? {} : { threadInbox: inbox }),
      }),
    );
    const as = async <T>(who: string, run: () => T | Promise<T>) => {
      const previous = caller;
      caller = who;
      try {
        return await run();
      } finally {
        caller = previous;
      }
    };
    const send = (
      clientTurnId: string,
      message: string,
      extra: Record<string, unknown> = {},
    ) =>
      app.request('/api/orchestration/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          conversationId: CONVERSATION,
          clientTurnId,
          target: { environment: { kind: 'current' }, agent: AGENT },
          ...extra,
        }),
      });
    const lookup = async (clientTurnId: string, who = OWNER) =>
      as(who, async () => {
        const response = await app.request(
          `/api/orchestration/conversations/${encodeURIComponent(CONVERSATION)}/turn-deliveries/${encodeURIComponent(clientTurnId)}`,
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as { data: TurnDeliveryInspection })
          .data.outcome;
      });
    const listInbox = (who = OWNER) =>
      as(who, () =>
        app.request(
          `/api/orchestration/conversations/${encodeURIComponent(CONVERSATION)}/inbox`,
        ),
      );
    const cancel = (clientTurnId: string, who = OWNER) =>
      as(who, () =>
        app.request(
          `/api/orchestration/conversations/${encodeURIComponent(CONVERSATION)}/inbox/${encodeURIComponent(clientTurnId)}`,
          { method: 'DELETE' },
        ),
      );
    /** The first turn, left running. */
    const busy = async () => {
      adapter.holdTurns = true;
      const first = await send('first', 'read the file');
      expect(first.status, await first.clone().text()).toBe(200);
      await eventually(() => expect(inbox.mustQueue(CONVERSATION)).toBe(true));
    };
    const prompts = () => adapter.turns.map((turn) => turn.input);
    const continueSend = (clientTurnId: string, message: string) =>
      app.request(
        `/api/orchestration/chat/${encodeURIComponent(CONVERSATION)}/continue`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message, clientTurnId }),
        },
      );
    const lookupData = async (clientTurnId: string) =>
      (
        (await (
          await app.request(
            `/api/orchestration/conversations/${encodeURIComponent(CONVERSATION)}/turn-deliveries/${encodeURIComponent(clientTurnId)}`,
          )
        ).json()) as { data: Record<string, unknown> }
      ).data;
    /** `send`, with the request's own abort signal. */
    const sendAbortable = (
      clientTurnId: string,
      message: string,
      signal: AbortSignal,
    ) =>
      app.request('/api/orchestration/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          message,
          conversationId: CONVERSATION,
          clientTurnId,
          target: { environment: { kind: 'current' }, agent: AGENT },
        }),
      });
    return {
      staging,
      sendAbortable,
      continueRefusal,
      lookupData,
      sendTurnGate,
      ledger,
      inboxStartGate,
      coldStartGate,
      continuations,
      continueSend,
      root,
      adapter,
      store,
      service,
      inbox,
      makeInbox,
      crashAfterStart,
      as,
      send,
      lookup,
      listInbox,
      cancel,
      busy,
      prompts,
    };
  }

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    '#3567: queue admission authorizes every materialized Session before mutation (readable=%s, known=%s)',
    async (readable, known) => {
      const world = station();
      expect((await world.send('queue-setup', 'setup')).status).toBe(200);
      const metadata = world.service.firstStartedMetadataOfThread(CONVERSATION);
      if (!metadata) throw new Error('Expected root execution binding');
      let predecessor = CONVERSATION;
      const middle = `${CONVERSATION}:queue-middle`;
      const current = `${CONVERSATION}:queue-current`;
      for (const id of [middle, current]) {
        const now = new Date().toISOString();
        world.store.reserveNextConversationSession({
          conversationId: CONVERSATION,
          predecessorSessionId: predecessor,
          proposedSessionId: id,
          createdAt: now,
        });
        world.store.upsertSession({
          provider: 'claude',
          threadId: id,
          status: 'ready',
          createdAt: now,
          updatedAt: now,
        });
        world.store.appendEvent({
          eventId: `${id}:started`,
          provider: 'claude',
          threadId: id,
          sessionId: id,
          createdAt: now,
          method: 'session.started',
          metadata: {
            ...metadata,
            conversationId: CONVERSATION,
            userId: id === middle && !readable ? STRANGER : OWNER,
          },
        });
        predecessor = id;
      }
      const authority = sessionReadAuthorityFromRequest(
        OWNER,
        undefined,
        undefined,
      );
      expect(world.service.canUserReadSession(CONVERSATION, authority)).toBe(
        true,
      );
      expect(world.service.canUserReadSession(current, authority)).toBe(true);
      expect(world.service.canUserReadSession(middle, authority)).toBe(
        readable,
      );
      if (known) {
        const claim = world.store.createTurnDeduplicator().claim({
          threadId: middle,
          clientTurnId: 'queue-key',
          inputDigest: foregroundTurnSubmissionDigest({
            message: 'original',
            target: { environment: { kind: 'current' }, agent: AGENT },
          }),
        });
        if (claim.kind !== 'owner') throw new Error('Expected original claim');
      }
      world.store.appendEvent({
        eventId: `${current}:busy`,
        provider: 'claude',
        threadId: current,
        turnId: 'engine-busy-turn',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'An engine turn already runs.',
      });
      expect(world.inbox.mustQueue(CONVERSATION)).toBe(true);
      const starts = world.adapter.starts.length;
      const answer = await world.send(
        'queue-key',
        readable ? 'original' : 'changed',
        { whenBusy: 'queue' },
      );
      const body = await answer.json();
      if (readable) {
        expect({ status: answer.status, body }).toMatchObject({
          status: 202,
          body: { data: { outcome: 'queued' } },
        });
        expect(world.inbox.list(CONVERSATION)).toMatchObject([
          { state: 'queued', message: 'original' },
        ]);
      } else {
        expect({ status: answer.status, body }).toMatchObject({
          status: 400,
          body: { error: 'The requested conversation is unavailable.' },
        });
        expect(world.inbox.list(CONVERSATION)).toEqual([]);
        expect(() =>
          world.inbox.submit({
            conversationId: CONVERSATION,
            clientTurnId: 'queue-key',
            payload: {
              message: 'changed',
              inputDigest: foregroundTurnSubmissionDigest({
                message: 'changed',
                target: { environment: { kind: 'current' }, agent: AGENT },
              }),
              actor: { userId: OWNER },
            },
          }),
        ).toThrow('The requested conversation is unavailable.');
        expect(world.inbox.list(CONVERSATION)).toEqual([]);
      }
      expect(world.adapter.starts).toHaveLength(starts);
      expect(world.adapter.turns).toHaveLength(1);
    },
  );

  test.each([
    'retained',
    'dead-invoked',
    'reclaimable',
    'legacy',
    'tombstone',
  ] as const)(
    '#3567: staged input checks authorized original proof before %s disposition or successor reservation',
    async (state) => {
      const first = station({
        birth: 'original-owner',
        stagedAttachments: true,
        modelPerTurn: false,
      });
      expect((await first.send('setup', 'setup')).status).toBe(200);
      const sessionId =
        first.service.currentConversationSessionId(CONVERSATION);
      const attachment = {
        kind: 'file' as const,
        name: 'note.txt',
        mimeType: 'text/plain' as const,
        size: 2,
        dataUrl: 'data:text/plain;base64,aGk=',
      };
      const original = {
        target: { environment: { kind: 'current' as const }, agent: AGENT },
        message: ' original ',
        attachments: [attachment],
      };
      if (state === 'tombstone') {
        first.store['db']
          .prepare(
            'INSERT INTO orchestration_turn_dedup_expired (dedup_key, expired_at) VALUES (?, ?)',
          )
          .run(turnDedupKey(sessionId, 'staged-key'), Date.now());
      } else {
        const claim = first.store.createTurnDeduplicator().claim({
          threadId: sessionId,
          clientTurnId: 'staged-key',
          ...(state === 'legacy'
            ? {}
            : { inputDigest: foregroundTurnSubmissionDigest(original) }),
        });
        if (claim.kind !== 'owner')
          throw new Error('Expected original pending owner');
        if (state === 'retained' || state === 'dead-invoked')
          claim.claim.beginInvocation();
        if (state === 'retained') claim.claim.retain();
      }
      if (state !== 'retained' && state !== 'tombstone') {
        first.adapter.events.push({
          eventId: `${sessionId}:staged-owner-exited`,
          provider: 'claude',
          threadId: sessionId,
          sessionId,
          createdAt: new Date().toISOString(),
          method: 'session.exited',
          exitKind: 'error',
        } as CanonicalRuntimeEvent);
        await eventually(() =>
          expect(
            first.store
              .listEvents(sessionId)
              .some((entry) => entry.payload.method === 'session.exited'),
          ).toBe(true),
        );
      }
      const world =
        state === 'retained' || state === 'tombstone'
          ? first
          : station({
              root: first.root,
              birth: 'replacement-owner',
              stagedAttachments: true,
              modelPerTurn: false,
            });
      const prepared = world.staging.prepare(
        { principalId: OWNER },
        {
          clientAttachmentId: 'staged-proof',
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
        },
      );
      const reference = world.staging.upload(
        prepared.stageId,
        prepared.uploadGrant,
        attachment.dataUrl,
      );
      const target = {
        ...original.target,
        model: { override: 'claude-other-model' },
      };
      const startsBefore = world.adapter.starts.length;
      if (state === 'retained') {
        const wrongOwner = await world.as(READER, () =>
          world.send('staged-key', 'original', {
            attachmentRefs: [reference],
            target,
          }),
        );
        expect(wrongOwner.status).toBe(400);
        expect(await wrongOwner.json()).toMatchObject({
          code: 'stage_forbidden',
        });
        expect(world.adapter.starts).toHaveLength(startsBefore);
      }
      const changed = await world.send('staged-key', 'original', {
        attachmentRefs: [reference],
        target,
      });
      const changedAnswer = {
        status: changed.status,
        body: await changed.json(),
      };
      if (state === 'legacy') {
        expect(changedAnswer.status).toBe(200);
        expect(world.adapter.turns).toHaveLength(1);
        expect(world.service.conversationSessionIds(CONVERSATION)).toHaveLength(
          2,
        );
        return;
      }
      expect(changedAnswer).toMatchObject({
        status: 409,
        body: {
          code:
            state === 'tombstone'
              ? 'foreground_message_indeterminate'
              : 'client_turn_input_conflict',
        },
      });
      expect(world.service.conversationSessionIds(CONVERSATION)).toHaveLength(
        1,
      );
      expect(world.adapter.starts).toHaveLength(startsBefore);
      expect(world.adapter.turns).toHaveLength(world === first ? 1 : 0);
      const matching = await world.send('staged-key', original.message, {
        attachmentRefs: [reference],
      });
      expect(matching.status, await matching.clone().text()).toBe(
        state === 'reclaimable' ? 200 : 409,
      );
      if (state !== 'reclaimable')
        expect(await matching.json()).toMatchObject({
          code: 'foreground_message_indeterminate',
        });
      expect([
        ...first.adapter.turns,
        ...(world === first ? [] : world.adapter.turns),
      ]).toHaveLength(state === 'reclaimable' ? 2 : 1);
    },
  );

  test.each([false, true])(
    '#3567: known input conflicts before conversation replay or busy queue acceptance (queue=%s)',
    async (queue) => {
      const world = station();
      if (queue) world.adapter.holdTurns = true;
      const first = await world.send('digest-key', ' original ');
      expect(first.status, await first.clone().text()).toBe(200);
      const firstTurn = (
        (await first.json()) as { data: { providerTurnId: string } }
      ).data.providerTurnId;
      const changed = await world.send(
        'digest-key',
        'original',
        queue ? { whenBusy: 'queue' } : {},
      );
      expect({
        status: changed.status,
        body: await changed.json(),
      }).toMatchObject({
        status: 409,
        body: { code: 'client_turn_input_conflict' },
      });
      expect(world.inbox.list(CONVERSATION)).toEqual([]);
      const replay = await world.send('digest-key', ' original ');
      expect({
        status: replay.status,
        body: await replay.json(),
      }).toMatchObject({
        status: 200,
        body: { data: { providerTurnId: firstTurn } },
      });
      expect(world.adapter.turns).toHaveLength(1);
      expect(world.service.conversationSessionIds(CONVERSATION)).toHaveLength(
        1,
      );
    },
  );

  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    '#3567: a live retry of an owned queued intent conflicts or returns its existing FIFO entry (same=%s, continue=%s)',
    async (same, continuation) => {
      const world = station({ continueThroughExecutor: true });
      await world.busy();
      expect(
        (await world.send('follow', 'queued original', { whenBusy: 'queue' }))
          .status,
      ).toBe(202);
      world.inbox.stop();
      world.adapter.holdTurns = false;
      world.adapter.complete();
      await eventually(() =>
        expect(
          world.service.hasActiveTurn(
            world.service.currentConversationSessionId(CONVERSATION),
          ),
        ).toBe(false),
      );
      const retry = await (continuation ? world.continueSend : world.send)(
        'follow',
        same ? 'queued original' : 'different live input',
      );
      expect({ status: retry.status, body: await retry.json() }).toMatchObject(
        same
          ? {
              status: 202,
              body: {
                data: {
                  outcome: 'queued',
                  entry: {
                    clientTurnId: 'follow',
                    state: 'queued',
                    message: 'queued original',
                  },
                },
              },
            }
          : {
              status: 409,
              body: { code: 'client_turn_input_conflict' },
            },
      );
      expect(world.adapter.turns).toHaveLength(1);
      expect(world.inbox.list(CONVERSATION)).toMatchObject([
        { state: 'queued', message: 'queued original' },
      ]);
    },
  );

  test('#3567: legacy queued input remains unknown when first placed instead of receiving reconstructed proof', async () => {
    const world = station();
    await world.busy();
    expect(
      (
        await world.send('legacy-follow', 'legacy queued input', {
          whenBusy: 'queue',
        })
      ).status,
    ).toBe(202);
    const db = world.store['db'];
    const before = db
      .prepare('SELECT payload FROM monument_inbox_entries WHERE entry_key = ?')
      .get('legacy-follow') as { payload: string };
    const payload = JSON.parse(before.payload);
    delete payload.inputDigest;
    db.prepare(
      'UPDATE monument_inbox_entries SET payload = ? WHERE entry_key = ?',
    ).run(JSON.stringify(payload), 'legacy-follow');
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.inbox.list(CONVERSATION)).toMatchObject([{ state: 'sent' }]),
    );
    const row = db
      .prepare(
        'SELECT input_digest FROM orchestration_turn_dedup WHERE dedup_key LIKE ?',
      )
      .get('%legacy-follow') as { input_digest: string | null };
    expect(row.input_digest).toBeNull();
    expect(world.prompts()).toEqual(['read the file', 'legacy queued input']);
  });

  test('#3567: a queued retry compares its original submitted identity before payload defaults discard empty context', async () => {
    const world = station();
    await world.busy();
    expect(
      (await world.send('follow', 'same message', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    const changed = await world.send('follow', 'same message', {
      whenBusy: 'queue',
      ambientContext: '',
    });
    expect({
      status: changed.status,
      body: await changed.json(),
    }).toMatchObject({
      status: 409,
      body: { code: 'client_turn_input_conflict' },
    });
    expect(world.inbox.list(CONVERSATION)).toMatchObject([
      { message: 'same message', state: 'queued' },
    ]);
    expect(world.adapter.turns).toHaveLength(1);
  });

  test('a follow-up to a busy conversation is held, answered 202, and sent once when the turn ends', async () => {
    const world = station();
    await world.busy();
    const queued = await world.send('follow', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(queued.status, await queued.clone().text()).toBe(202);
    expect(await queued.json()).toMatchObject({
      success: true,
      data: {
        outcome: 'queued',
        conversationId: CONVERSATION,
        clientTurnId: 'follow',
        entry: { state: 'queued', position: 1, message: 'then summarize' },
      },
    });
    expect(world.prompts()).toEqual(['read the file']);
    expect(await world.lookup('follow')).toBe('queued');
    // Another client of the conversation sees the same queue.
    const listed = await world.listInbox();
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { data: { entries: ConversationInboxEntry[] } })
        .data.entries,
    ).toMatchObject([{ clientTurnId: 'follow', state: 'queued' }]);
    // The same send again is the same entry.
    const again = await world.send('follow', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(again.status).toBe(202);

    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.prompts()).toEqual(['read the file', 'then summarize']),
    );
    await eventually(async () =>
      expect(await world.lookup('follow')).toBe('started'),
    );
    expect(world.adapter.turns.at(-1)?.clientTurnId).toBe('follow');
    // Sent once: a later send of the same key returns the same turn.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(world.prompts()).toEqual(['read the file', 'then summarize']);
  });

  test('a send without whenBusy is not held, whatever the conversation is doing', async () => {
    const world = station();
    await world.busy();
    const direct = await world.send('direct', 'not queued');
    expect(direct.status, await direct.clone().text()).toBe(200);
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test('a send the inbox cannot replay is not held, even when asked', async () => {
    const world = station();
    await world.busy();
    const withPick = await world.send('pick', 'with an approval pick', {
      whenBusy: 'queue',
      setApprovalMode: 'default',
      setApprovalModeBasedOn: null,
    });
    expect(withPick.status).not.toBe(202);
    // A valid attachment (the route reaches the inbox check with it); this
    // engine takes no files, so the direct dispatch refuses it.
    const withFile = await world.send('file', 'needs its attachment', {
      whenBusy: 'queue',
      attachments: [
        {
          kind: 'file',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 2,
          dataUrl: 'data:text/plain;base64,aGk=',
        },
      ],
    });
    expect(withFile.status, await withFile.clone().text()).not.toBe(202);
    expect(await withFile.json()).toMatchObject({ success: false });
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test('a Station without the inbox ignores whenBusy', async () => {
    const world = station({ inbox: false });
    await world.busy();
    const sent = await world.send('follow', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(sent.status).not.toBe(202);
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test.each([undefined, 'queue'] as const)(
    'a begun engine-busy refusal closes its key with typed 409 (whenBusy=%s)',
    async (whenBusy) => {
      const world = station();
      expect((await world.send('first', 'read the file')).status).toBe(200);
      await eventually(() =>
        expect(world.inbox.mustQueue(CONVERSATION)).toBe(false),
      );
      world.adapter.refuseNextAsBusy = true;
      const options = whenBusy === undefined ? {} : { whenBusy };
      const raced = await world.send('raced', 'then summarize', options);
      expect(raced.status, await raced.clone().text()).toBe(409);
      expect(await raced.json()).toMatchObject({
        success: false,
        code: 'client_turn_settled',
        disposition: 'definitively-refused',
        error:
          'This turn was definitively refused. A new request requires a new turn key.',
      });
      expect(world.inbox.list(CONVERSATION)).toEqual([]);
      expect(world.prompts()).toEqual(['read the file']);
      const retry = await world.send('raced', 'then summarize', options);
      expect(retry.status, await retry.clone().text()).toBe(409);
      expect(await retry.json()).toMatchObject({
        code: 'client_turn_settled',
        disposition: 'definitively-refused',
      });
      expect(world.inbox.list(CONVERSATION)).toEqual([]);
      expect(world.prompts()).toEqual(['read the file']);
      const fresh = await world.send(
        'explicit-new-key',
        'then summarize',
        options,
      );
      expect(fresh.status, await fresh.clone().text()).toBe(200);
      await eventually(() =>
        expect(world.prompts()).toEqual(['read the file', 'then summarize']),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(world.prompts()).toEqual(['read the file', 'then summarize']);
    },
  );

  test('a reused key with a different message is refused 409, and the held message is kept', async () => {
    const world = station();
    await world.busy();
    expect(
      (await world.send('follow', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    const conflict = await world.send('follow', 'something else', {
      whenBusy: 'queue',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: 'client_turn_input_conflict',
    });
    expect(world.inbox.list(CONVERSATION)).toMatchObject([
      { message: 'then summarize' },
    ]);
  });

  test('only the sender withdraws a held message; a stranger cannot read or remove it', async () => {
    const world = station();
    await world.busy();
    await world.send('follow', 'then summarize', { whenBusy: 'queue' });
    const replay = vi.spyOn(world.store, 'listEvents');
    expect((await world.listInbox()).status).toBe(200);
    expect(replay).not.toHaveBeenCalled();
    expect((await world.listInbox(STRANGER)).status).toBe(404);
    expect((await world.cancel('follow', STRANGER)).status).toBe(404);
    expect(await world.lookup('follow', STRANGER)).toBe('not-received');
    const withdrawn = await world.cancel('follow');
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toMatchObject({
      data: { entry: { clientTurnId: 'follow', state: 'cancelled' } },
    });
    expect((await world.cancel('missing')).status).toBe(404);
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(world.prompts()).toEqual(['read the file']);
    expect(await world.lookup('follow')).toBe('not-received');
  });

  test('D1: an entry the engine took before a crash is not sent again into a successor Session', async () => {
    const world = station();
    await world.busy();
    expect(
      (await world.send('follow', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    // The engine takes the follow-up, and the process dies before the
    // inbox hears back: the entry stays `sending`, pinned to this Session.
    world.crashAfterStart.armed = true;
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.prompts()).toEqual(['read the file', 'then summarize']),
    );
    expect(world.inbox.list(CONVERSATION)).toMatchObject([
      { state: 'sending' },
    ]);
    world.inbox.stop();
    world.crashAfterStart.armed = false;
    // That Session ends, so continuing the conversation would reserve a
    // successor with a fresh turn claim.
    const session = world.service.currentConversationSessionId(CONVERSATION);
    world.adapter.events.push({
      eventId: `${session}:exited`,
      provider: 'claude',
      threadId: session,
      sessionId: session,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      exitKind: 'error',
    } as unknown as CanonicalRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const restarted = world.makeInbox();
    restarted.start();
    try {
      await restarted.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await restarted.idle();
      expect(world.prompts()).toEqual(['read the file', 'then summarize']);
      expect(restarted.list(CONVERSATION)).toMatchObject([{ state: 'sent' }]);
    } finally {
      restarted.stop();
      await restarted.idle();
      // Let the dead process's abandoned call end, so teardown can finish.
      world.crashAfterStart.release?.();
    }
  });

  test('A1: a reader the Station lets continue the conversation has a held follow-up delivered', async () => {
    const world = station();
    await world.busy();
    const queued = await world.as(READER, () =>
      world.send('reader-follow', 'from the other account', {
        whenBusy: 'queue',
      }),
    );
    expect(queued.status, await queued.clone().text()).toBe(202);
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.prompts()).toEqual([
        'read the file',
        'from the other account',
      ]),
    );
    await eventually(() =>
      expect(world.inbox.list(CONVERSATION)).toMatchObject([
        { clientTurnId: 'reader-follow', state: 'sent' },
      ]),
    );
  });

  test('A1: a caller placement would refuse is never answered 202', async () => {
    const world = station();
    await world.busy();
    const refused = await world.as(STRANGER, () =>
      world.send('stranger-follow', 'not mine', { whenBusy: 'queue' }),
    );
    expect(refused.status).not.toBe(202);
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test('A3: another reader cannot withdraw a waiting message that is not theirs', async () => {
    const world = station();
    await world.busy();
    await world.send('follow', 'then summarize', { whenBusy: 'queue' });
    expect((await world.cancel('follow', READER)).status).toBe(404);
    expect((await world.cancel('follow', STRANGER)).status).toBe(404);
    expect(world.inbox.list(CONVERSATION)).toMatchObject([{ state: 'queued' }]);
  });

  test('A4: a body naming another Agent or workspace than the binding takes the live path', async () => {
    const world = station();
    await world.busy();
    const otherAgent = await world.send('other-agent', 'elsewhere', {
      whenBusy: 'queue',
      target: { environment: { kind: 'current' }, agent: agentId('writer') },
    });
    expect(otherAgent.status).not.toBe(202);
    const otherWorkspace = await world.send('other-ws', 'elsewhere', {
      whenBusy: 'queue',
      target: {
        environment: { kind: 'current' },
        agent: AGENT,
        workspace: { kind: 'directory', cwd: '/tmp/somewhere-else' },
      },
    });
    expect(otherWorkspace.status).not.toBe(202);
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test('R2-1: a send the engine may have taken, then a crash and the Session ending, is unconfirmed, never sent into a successor', async () => {
    // A short deadline only so this dead process's abandoned call can end
    // for teardown; a stopped inbox records nothing at it.
    const first = station({ birth: 'boot-1', placementDeadlineMs: 300 });
    await first.busy();
    expect(
      (await first.send('follow', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    // The engine is handed the follow-up (its claim records the invocation)
    // and never answers; the process then dies.
    first.adapter.hangNextSend = true;
    first.adapter.holdTurns = false;
    first.adapter.complete();
    await eventually(() =>
      expect(first.prompts()).toEqual(['read the file', 'then summarize']),
    );
    first.inbox.stop();
    // The Session the claim is on ends, so continuing would reserve a
    // successor with a fresh claim of its own.
    const session = first.service.currentConversationSessionId(CONVERSATION);
    first.adapter.events.push({
      eventId: `${session}:exited`,
      provider: 'claude',
      threadId: session,
      sessionId: session,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      exitKind: 'error',
    } as unknown as CanonicalRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = station({ root: first.root, birth: 'boot-2' });
    await second.inbox.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await second.inbox.idle();
    // A start into a successor Session carries the transcript before the
    // message, so a second send ends with it rather than equalling it.
    expect(
      [...first.prompts(), ...second.prompts()].filter((prompt) =>
        prompt.endsWith('then summarize'),
      ),
    ).toHaveLength(1);
    expect(second.inbox.list(CONVERSATION)).toMatchObject([
      { state: 'unconfirmed', reasonCode: 'may_have_been_sent' },
    ]);
    const changed = await second.send('follow', 'different original input');
    expect({
      status: changed.status,
      body: await changed.json(),
    }).toMatchObject({
      status: 409,
      body: { code: 'client_turn_input_conflict' },
    });
    expect(second.prompts()).toEqual([]);
  });

  test('R2-2: a live claim on the ended Session holds the entry back from a successor', async () => {
    const world = station();
    await world.busy();
    expect(
      (await world.send('follow', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    const session = world.service.currentConversationSessionId(CONVERSATION);
    // Another attempt of the same key holds a live claim on this Session
    // and has not begun invoking.
    const claim = world.store
      .createTurnDeduplicator()
      .claim({ threadId: session, clientTurnId: 'follow' });
    expect(claim).toMatchObject({ kind: 'owner' });
    world.adapter.events.push({
      eventId: `${session}:exited`,
      provider: 'claude',
      threadId: session,
      sessionId: session,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      exitKind: 'error',
    } as unknown as CanonicalRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(world.prompts()).toEqual(['read the file']);
    expect(world.inbox.list(CONVERSATION)).toMatchObject([{ state: 'queued' }]);
  });

  test("R2-8: a reader sees no key for someone else's message that may still be sent", async () => {
    const world = station();
    await world.busy();
    await world.send('owner-key', 'then summarize', { whenBusy: 'queue' });
    await world.as(READER, () =>
      world.send('reader-key', 'from the reader', { whenBusy: 'queue' }),
    );
    const read = async (who: string) =>
      (
        (await (await world.listInbox(who)).json()) as {
          data: { entries: Array<Record<string, unknown>> };
        }
      ).data.entries;
    const asReader = await read(READER);
    expect(asReader[0]).not.toHaveProperty('clientTurnId');
    expect(asReader[1]).toMatchObject({ clientTurnId: 'reader-key' });
    const asOwner = await read(OWNER);
    expect(asOwner[0]).toMatchObject({ clientTurnId: 'owner-key' });
    expect(asOwner[1]).not.toHaveProperty('clientTurnId');
  });

  test('R2-7: a send carrying an Agent-definition precondition takes the live path', async () => {
    const world = station();
    const override = {
      kind: 'agent-execution-override' as const,
      agent: AGENT,
      executionAgent: AGENT,
    };
    // The conversation is bound through an execution override, so a
    // follow-up naming the same override matches its binding.
    world.adapter.holdTurns = true;
    const first = await world.send('first', 'read the file', {
      target: { environment: { kind: 'current' }, agent: override },
    });
    expect(first.status, await first.clone().text()).toBe(200);
    await eventually(() =>
      expect(world.inbox.mustQueue(CONVERSATION)).toBe(true),
    );
    // Control: the same target without a precondition is held.
    const plain = await world.send('plain', 'no precondition', {
      whenBusy: 'queue',
      target: { environment: { kind: 'current' }, agent: override },
    });
    expect(plain.status, await plain.clone().text()).toBe(202);
    const fingerprinted = await world.send('fp', 'with a precondition', {
      whenBusy: 'queue',
      target: {
        environment: { kind: 'current' },
        agent: {
          ...override, // A well-formed fingerprint, so the route reaches the hold check.
          expectedDefinitionFingerprint: `sha256:${'0'.repeat(64)}`,
        },
      },
    });
    expect(fingerprinted.status).not.toBe(202);
    expect(world.inbox.list(CONVERSATION)).toMatchObject([
      { clientTurnId: 'plain' },
    ]);
  });

  test('R3-4: a send under a key the inbox holds for someone else is refused inbox_key_held, queued or not', async () => {
    const world = station();
    await world.busy();
    const held = await world.send('owner-key', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(held.status, await held.clone().text()).toBe(202);
    // The reader may read and continue the conversation, so the live path
    // would otherwise take the key's turn claim.
    for (const extra of [{}, { whenBusy: 'queue' }]) {
      const squat = await world.as(READER, () =>
        world.send('owner-key', 'from the reader', extra),
      );
      expect(squat.status, await squat.clone().text()).toBe(409);
      expect(await squat.json()).toMatchObject({ code: 'inbox_key_held' });
    }
    // Someone who may not read the conversation is not told about the key.
    const stranger = await world.as(STRANGER, () =>
      world.send('owner-key', 'from a stranger'),
    );
    expect(await stranger.text()).not.toContain('inbox_key_held');
    // The sender's own resend still answers its entry.
    const again = await world.send('owner-key', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(again.status).toBe(202);
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.prompts()).toEqual(['read the file', 'then summarize']),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(world.prompts()).toEqual(['read the file', 'then summarize']);
    expect(world.adapter.turns.at(-1)?.clientTurnId).toBe('owner-key');
  });

  test('R3-4: /chat/:id/continue refuses a key the inbox holds for someone else too', async () => {
    const world = station();
    await world.busy();
    const held = await world.send('owner-key', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(held.status).toBe(202);
    const squat = await world.as(READER, () =>
      world.continueSend('owner-key', 'from the reader'),
    );
    expect(squat.status, await squat.clone().text()).toBe(409);
    expect(await squat.json()).toMatchObject({ code: 'inbox_key_held' });
    expect(world.continuations).toEqual([]);
    // Control: a key of the reader's own reaches the continuation.
    await world.as(READER, () => world.continueSend('reader-key', 'mine'));
    expect(world.continuations).toEqual([
      { clientTurnId: 'reader-key', userId: READER },
    ]);
  });

  test.each([
    ['before its start deadline', 60_000],
    ['after its start deadline', 50],
  ])(
    'R5-1: while the inbox cold-starts a key (%s), its own sender cannot send it live, and it is sent once',
    async (window, deadline) => {
      const world = station({ placementDeadlineMs: deadline });
      await world.busy();
      const held = await world.send('owner-key', 'then summarize', {
        whenBusy: 'queue',
      });
      expect(held.status).toBe(202);
      // The Session ends, so the inbox's start has to start a successor: a
      // cold start, with no turn claim on the key until that Session exists.
      let release!: () => void;
      world.coldStartGate.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const session = world.service.currentConversationSessionId(CONVERSATION);
      world.adapter.holdTurns = false;
      world.adapter.events.push({
        eventId: `${session}:exited`,
        provider: 'claude',
        threadId: session,
        sessionId: session,
        createdAt: new Date().toISOString(),
        method: 'session.exited',
        exitKind: 'error',
      } as unknown as CanonicalRuntimeEvent);
      await eventually(() => expect(world.coldStartGate.entered).toBe(1));
      if (window === 'after its start deadline')
        await eventually(() =>
          expect(world.inbox.list(CONVERSATION)).toMatchObject([
            { clientTurnId: 'owner-key', state: 'unconfirmed' },
          ]),
        );
      else
        expect(world.inbox.list(CONVERSATION)).toMatchObject([
          { clientTurnId: 'owner-key', state: 'sending' },
        ]);
      expect(world.inbox.inFlight(CONVERSATION, 'owner-key')).toBe(true);
      const refusals = [
        // `/chat` with `whenBusy` and the same body: while the successor is
        // reserved the inbox cannot hold a follow-up (its binding is not
        // known yet), so this too would take the live path.
        await world.send('owner-key', 'then summarize', { whenBusy: 'queue' }),
        // `/chat` without `whenBusy`.
        await world.send('owner-key', 'then summarize'),
        // `/chat` with `whenBusy`, but naming another Agent: the live path.
        await world.send('owner-key', 'then summarize', {
          whenBusy: 'queue',
          target: {
            environment: { kind: 'current' },
            agent: agentId('writer'),
          },
        }),
        // The composer's continue route. The harness's continuation is a
        // recorder, so this row proves the route refuses before reaching it
        // (`continuations` stays empty), not what a real continuation would
        // send; the `/chat` rows above run the real one.
        await world.continueSend('owner-key', 'then summarize'),
      ];
      const answers = await Promise.all(
        refusals.map(async (refused) => ({
          status: refused.status,
          body: (await refused.json()) as Record<string, unknown>,
        })),
      );
      // The cold start completes. Whatever the live sends did, the run is
      // let finish before anything is asserted, so a second send is counted.
      release();
      await eventually(() =>
        expect(world.inbox.list(CONVERSATION)[0]?.state).toMatch(
          /^(sent|unconfirmed|refused)$/,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      // A start into a successor carries the transcript before the message.
      expect(
        world.prompts().filter((prompt) => prompt.endsWith('then summarize')),
      ).toHaveLength(1);
      expect(world.continuations).toEqual([]);
      for (const answer of answers)
        expect(answer, JSON.stringify(answer)).toMatchObject({
          status: 409,
          body: { code: 'client_turn_in_flight', retryable: true },
        });
      expect(world.inbox.list(CONVERSATION)).toMatchObject([
        { clientTurnId: 'owner-key', state: 'sent' },
      ]);
      expect(world.inbox.inFlight(CONVERSATION, 'owner-key')).toBe(false);
    },
  );

  test("R5-3: while the inbox starts a key on a running Session, its sender's own held resend is answered 202, and a live send is refused", async () => {
    const world = station();
    await world.busy();
    expect(
      (await world.send('owner-key', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    let release!: () => void;
    world.inboxStartGate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.inbox.inFlight(CONVERSATION, 'owner-key')).toBe(true),
    );
    // The hold step comes first: the same submission is its own entry.
    const resend = await world.send('owner-key', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(resend.status, await resend.clone().text()).toBe(202);
    expect(await resend.json()).toMatchObject({
      data: { outcome: 'queued', entry: { state: 'sending' } },
    });
    const live = await world.send('owner-key', 'then summarize');
    expect(live.status).toBe(409);
    expect(await live.json()).toMatchObject({ code: 'client_turn_in_flight' });
    release();
    await eventually(() =>
      expect(world.inbox.list(CONVERSATION)).toMatchObject([
        { clientTurnId: 'owner-key', state: 'sent' },
      ]),
    );
    expect(world.prompts()).toEqual(['read the file', 'then summarize']);
  });

  /** Engine sends whose prompt ends with `message` (a successor's start carries the transcript first). */
  const sendsOf = (world: ReturnType<typeof station>, message: string) =>
    world.adapter.turns.filter((turn) => turn.input.endsWith(message));
  const otherModel = {
    environment: { kind: 'current' },
    agent: AGENT,
    model: { override: 'claude-other-model' },
  };

  test('R6-1: a changed model is in flight while the inbox starts the key, then conflicts with its known original input', async () => {
    const world = station({ modelPerTurn: false });
    await world.busy();
    expect(
      (await world.send('owner-key', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    // The inbox's send is held before the service claims the key on S1.
    let release!: () => void;
    world.sendTurnGate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() => expect(world.sendTurnGate.entered).toBe(1));
    expect(world.inbox.inFlight(CONVERSATION, 'owner-key')).toBe(true);
    // A model this engine cannot switch to per turn: a live send would
    // continue in a new Session, under a claim of its own.
    const live = await world.send('owner-key', 'then summarize', {
      target: otherModel,
    });
    const liveAnswer = { status: live.status, body: await live.json() };
    release();
    await eventually(() =>
      expect(world.inbox.list(CONVERSATION)).toMatchObject([
        { clientTurnId: 'owner-key', state: 'sent' },
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sendsOf(world, 'then summarize')).toHaveLength(1);
    expect(liveAnswer).toMatchObject({
      status: 409,
      body: { code: 'client_turn_in_flight' },
    });
    // Once original input is known, changing the model is a nonretryable conflict.
    const retry = await world.send('owner-key', 'then summarize', {
      target: otherModel,
    });
    const retryAnswer = { status: retry.status, body: await retry.json() };
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sendsOf(world, 'then summarize')).toHaveLength(1);
    expect(retryAnswer).toMatchObject({
      status: 409,
      body: { code: 'client_turn_input_conflict' },
    });
  });

  test.each([false, true])(
    'R6-2: changed model conflicts with known proof and preserves unknown legacy replay (legacy=%s)',
    async (legacy) => {
      const world = station({ modelPerTurn: false });
      const first = await world.send('k1', 'read the file');
      expect(first.status, await first.clone().text()).toBe(200);
      const firstTurn = (
        (await first.json()) as { data: { providerTurnId: string } }
      ).data.providerTurnId;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (legacy)
        world.store['db'].exec(
          'UPDATE orchestration_turn_dedup SET input_digest = NULL',
        );
      const retry = await world.send('k1', 'read the file', {
        target: otherModel,
      });
      const retryAnswer = { status: retry.status, body: await retry.json() };
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sendsOf(world, 'read the file')).toHaveLength(1);
      expect(retryAnswer).toMatchObject(
        legacy
          ? {
              status: 200,
              body: { data: { providerTurnId: firstTurn } },
            }
          : {
              status: 409,
              body: { code: 'client_turn_input_conflict' },
            },
      );
      expect(world.service.conversationSessionIds(CONVERSATION)).toHaveLength(
        1,
      );
    },
  );

  test('R6-2: a key the ledger reads as possibly sent or in flight elsewhere is refused before any Session is reserved', async () => {
    const world = station({ modelPerTurn: false });
    expect((await world.send('first', 'read the file')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    world.ledger.answer = { outcome: 'expired' };
    const maybe = await world.send('k2', 'again', { target: otherModel });
    expect(maybe.status).toBe(409);
    expect(await maybe.json()).toMatchObject({
      code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
      outcome: 'indeterminate',
    });
    world.ledger.answer = { outcome: 'received' };
    const busy = await world.send('k3', 'again', { target: otherModel });
    // A conflict to retry, as the inbox's own in-flight refusal answers it.
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: 'client_turn_in_flight' });
    world.ledger.answer = undefined;
    // The continue route answers the same code the same way.
    world.continueRefusal.code = 'client_turn_in_flight';
    const continued = await world.continueSend('k4', 'again');
    expect(continued.status).toBe(409);
    expect(await continued.json()).toMatchObject({
      code: 'client_turn_in_flight',
    });
    expect(world.prompts()).toEqual(['read the file']);
    expect(world.service.conversationSessionIds(CONVERSATION)).toHaveLength(1);
  });

  test.each([
    ['a fresh claim', 0],
    ['a claim older than 15 minutes, whose owner is alive', 16 * 60_000],
  ])(
    'R7-1/2: a same-key retry while another attempt holds the key on its Session (%s) joins that turn, never indeterminate',
    async (_claim, ageMs) => {
      const world = station({ modelPerTurn: false });
      expect((await world.send('first', 'read the file')).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The first attempt's engine call is under way: the service holds a live
      // claim on the key (owner alive, invoking) that has not resolved.
      world.adapter.holdNextSend = true;
      const firstAttempt = world.send('k1', 'and then this');
      await eventually(() =>
        expect(world.adapter.releaseHeldSend).toBeDefined(),
      );
      const realNow = Date.now.bind(Date);
      const clock = vi
        .spyOn(Date, 'now')
        .mockImplementation(() => realNow() + ageMs);
      try {
        // The lookup shows only its public fields: never the Session a live
        // claim is on. #3660: a claim this old reads indeterminate there.
        expect(await world.lookupData('k1')).toEqual({
          outcome: ageMs > 0 ? 'indeterminate' : 'received',
          conversationId: CONVERSATION,
          clientTurnId: 'k1',
        });
        const changed = await world.send('k1', 'and then this', {
          target: otherModel,
        });
        expect({
          status: changed.status,
          body: await changed.json(),
        }).toMatchObject({
          status: 409,
          body: { code: 'client_turn_input_conflict' },
        });
        // Identical input still joins the live holder, even when that claim is old.
        const retry = world.send('k1', 'and then this');
        await new Promise((resolve) => setTimeout(resolve, 200));
        world.adapter.releaseHeldSend?.();
        const [first, again] = await Promise.all([firstAttempt, retry]);
        const firstTurn = (
          (await first.json()) as { data: { providerTurnId: string } }
        ).data.providerTurnId;
        const retryAnswer = { status: again.status, body: await again.json() };
        expect(sendsOf(world, 'and then this')).toHaveLength(1);
        expect(retryAnswer).toMatchObject({
          status: 200,
          body: { data: { providerTurnId: firstTurn } },
        });
      } finally {
        clock.mockRestore();
      }
    },
  );

  test('R7-0: a plain same-key retry after its Session ended answers the first turn; one engine send', async () => {
    const world = station();
    const first = await world.send('k1', 'read the file');
    expect(first.status, await first.clone().text()).toBe(200);
    const firstTurn = (
      (await first.json()) as { data: { providerTurnId: string } }
    ).data.providerTurnId;
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The Session's engine binding ends (`error`), so a continuation now
    // reserves a successor Session with a claim of its own.
    const session = world.service.currentConversationSessionId(CONVERSATION);
    world.adapter.events.push({
      eventId: `${session}:exited`,
      provider: 'claude',
      threadId: session,
      sessionId: session,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      exitKind: 'error',
    } as unknown as CanonicalRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const retry = await world.send('k1', 'read the file');
    const retryAnswer = { status: retry.status, body: await retry.json() };
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sendsOf(world, 'read the file')).toHaveLength(1);
    expect(retryAnswer).toMatchObject({
      status: 200,
      body: { data: { providerTurnId: firstTurn } },
    });
  });

  test('R8-2: a same-key retry joining another attempt stops waiting when its request is aborted; nothing is sent', async () => {
    const world = station();
    expect((await world.send('first', 'read the file')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    world.adapter.holdNextSend = true;
    const firstAttempt = world.send('k1', 'and then this');
    await eventually(() => expect(world.adapter.releaseHeldSend).toBeDefined());
    const abort = new AbortController();
    let settled = false;
    const retry = Promise.resolve(
      world.sendAbortable('k1', 'and then this', abort.signal),
    ).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    abort.abort();
    // It answers without the held attempt resolving (the join would otherwise
    // wait for it, up to five minutes).
    await eventually(() => expect(settled).toBe(true));
    const answer = await retry;
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({
      code: 'client_turn_in_flight',
    });
    world.adapter.releaseHeldSend?.();
    expect((await firstAttempt).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendsOf(world, 'and then this')).toHaveLength(1);
  });
});
