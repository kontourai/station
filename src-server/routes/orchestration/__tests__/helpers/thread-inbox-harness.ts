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
import { type TurnDeliveryInspection } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, expect, vi } from 'vitest';
import { trackTempDirs } from '../../../../__test-utils__/temp-dirs.js';
import {
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  ProviderTurnInProgressError,
} from '../../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../../providers/sessions/async-event-queue.js';
import {
  type ExecutionSessionBinding,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../../services/execution-target/execution-target-execution.js';
import { AttachmentStagingService } from '../../../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../../services/orchestration/event-store.js';
import { memoryContinuationForInbox } from '../../../../services/orchestration/memory-exhaustion-continuation.js';
import { OrchestrationService } from '../../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../../services/orchestration/session-agent-resolution.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../../../../services/orchestration/session-lifecycle-service.js';
import { ThreadInboxDelivery } from '../../../../services/orchestration/thread-inbox.js';
import {
  createOrchestrationRoutes,
  isForegroundDispatchHandle,
  isForegroundIndeterminateShape,
} from '../../orchestration.js';

export const OWNER = 'inbox-owner';
export const STRANGER = 'inbox-stranger';
export const READER = 'inbox-reader';
export const ENVIRONMENT = 'inbox-station';
export const AGENT = agentId('claude');
export const CONVERSATION = 'conversation:inbox';

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

export function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 5_000,
) {
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

export function createInboxHarness() {
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
      /**
       * Continuation after a memory kill: `manual` mounts only the
       * person's route; `automatic` also feeds Station's own trigger.
       */
      memoryContinuation?: 'manual' | 'automatic';
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
    const memoryContinuation = options.memoryContinuation
      ? memoryContinuationForInbox({
          eventStore: store,
          service,
          inbox,
          logger: { warn: vi.fn() },
        })
      : undefined;
    if (memoryContinuation && options.memoryContinuation === 'automatic')
      cleanup.push(
        bus.subscribe((frame) => {
          const event = (frame.data as { event?: CanonicalRuntimeEvent })
            ?.event;
          if (frame.event === 'orchestration:event' && event)
            memoryContinuation.observe(event);
        }),
      );
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
        ...(memoryContinuation ? { memoryContinuation } : {}),
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
      app,
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

  return station;
}
