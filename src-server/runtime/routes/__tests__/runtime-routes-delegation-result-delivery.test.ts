/**
 * #3158 fix round 1: delegated result delivery through the REAL runtime
 * composition (`configureRuntimeRoutes`): the real credential pipeline and
 * station-control guard, real caller-token mints, the real request-delegation
 * resolver, the production start/steer ports and the event-bus subscription
 * mapping, the hosted-Station exclusion, and the startup reconcile. The
 * delivery records live in a real on-disk EventStore. Stubs stand in only
 * behind the routes: the delegation tool's dispatch and conversation
 * continue (recorded), and orchestration-service reads.
 */
import { writeFileSync, writeSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { serve } from '@hono/node-server';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../bootstrap/hosted-tenant-mode.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const PARENT = 'op-caller-global';
const CHILD = 'task:child-runtime-1';

const support = vi.hoisted(() => ({
  notificationService: undefined as unknown,
  /** Every conversation continue the production start port reached. */
  continued: [] as Record<string, unknown>[],
  /** Every orchestration command dispatched (a steer, here). */
  commands: [] as Record<string, unknown>[],
  busy: new Set<string>(),
  /** The steer dispatch throws (after, possibly, being accepted). */
  steerThrows: false,
  /** What the conversation's turn ledger answers for a key (#3568 D1). */
  inspect: undefined as
    | ((conversationId: string, clientTurnId: string) => unknown)
    | undefined,
  /** Paired devices still allowed to send (#3568 A2). */
  devices: new Set<string>(),
}));

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: support.notificationService,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => stub,
  };
});

vi.mock('../../../tools/station-control-delegation.js', async (original) => {
  const actual =
    await original<
      typeof import('../../../tools/station-control-delegation.js')
    >();
  return {
    ...actual,
    delegateTask: async () => ({
      conversationId: CHILD,
      taskId: CHILD,
      sessionId: CHILD,
      currentSessionId: CHILD,
      status: 'dispatched',
      environment: { id: 'here', name: 'Here', kind: 'current' },
      target: { kind: 'agent', id: 'writer' },
    }),
    continueExecutionTargetMessage: async (input: Record<string, unknown>) => {
      support.continued.push(input);
      return {
        conversationId: String(input.conversationId),
        sessionId: String(input.conversationId),
        providerTurnId: `parent-turn-${support.continued.length}`,
        target: { kind: 'agent', id: 'lead' },
      };
    },
  };
});

function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

const makeTempDir = trackTempDirs();
let sequence = 0;

function event(
  threadId: string,
  method: string,
  fields: Record<string, unknown> = {},
): CanonicalRuntimeEvent {
  sequence += 1;
  return {
    eventId: `runtime-event-${sequence}`,
    provider: 'claude',
    threadId,
    createdAt: new Date(Date.UTC(2026, 9, 13, 0, 0, sequence)).toISOString(),
    method,
    ...fields,
  } as unknown as CanonicalRuntimeEvent;
}

/**
 * The real runtime composition over `store` (shared by both suites): the
 * runtime routes mount, startup reconcile runs, and the server listens.
 */
async function composeOver(
  homeDir: string,
  store: EventStore,
  closers: Array<() => Promise<void> | void>,
) {
  const delegationResultStore = vi.fn(() => store.delegationResultStore());
  const notifications = new NotificationService(
    new EventBus(),
    homeDir,
    999_999,
  );
  closers.push(() => notifications.shutdown());
  support.notificationService = notifications;
  __resetStationServerSelfAttestationForTests();
  const bus = new EventBus();
  const app = new Hono();
  const context = deepStub({
    projectSharedTasks: undefined,
    deploymentAuthentication: undefined,
    localAccounts: undefined,
    applicationSessions: undefined,
    app,
    port: 4321,
    appConfig: {},
    eventBus: bus,
    configLoader: {
      getProjectHomeDir: () => homeDir,
      loadAppConfig: () => ({}),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    activeAgents: new Map(),
    agentService: { listAgents: () => [] },
    agentMetadataMap: new Map(),
    agentFixedTokens: new Map(),
    agentTools: new Map(),
    agentStats: new Map(),
    agentStatus: new Map(),
    memoryAdapters: new Map(),
    metricsLog: [],
    monitoringEvents: [],
    // The delivery's reads go to the real store; the rest of the runtime
    // sees inert stubs.
    orchestrationEventStore: deepStub({
      sessionTurnBoundaryAuthority: () => ({
        reconcile: () => ({ kind: 'available', interrupted: [] }),
        hasPossibleEffect: (threadId: string) =>
          store.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
      }),
      delegationResultStore,
      listEventsByMethods: (threadId: string, methods: readonly string[]) =>
        store.listEventsByMethods(threadId, methods),
      listTurnEventsByMethods: (
        threadId: string,
        turnId: string,
        methods: readonly string[],
        limit: number,
        invocationId?: string,
      ) =>
        store.listTurnEventsByMethods(
          threadId,
          turnId,
          methods,
          limit,
          invocationId,
        ),
      readSessionInventoryHighWater: (threadId: string) =>
        store.readSessionInventoryHighWater(threadId),
      readInputlessTurnDisposition: (threadId: string) =>
        store.readInputlessTurnDisposition(threadId),
      readInvocationTerminal: (
        threadId: string,
        invocationId: string,
        turnId?: string,
      ) => store.readInvocationTerminal(threadId, invocationId, turnId),
      conversationForSession: (threadId: string) =>
        store.conversationForSession(threadId),
      conversationSessions: () => [],
      readSessionByThread: () => undefined,
      sessionControlRequestKeys: () => store.sessionControlRequestKeys(),
      threadInboxStore: () => store.threadInboxStore(),
    }),
    orchestrationService: deepStub({
      resolveSessionActingPrincipal: () => ({
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        source: 'session-owner' as const,
      }),
      sessionRecordedOwnerId: () => LOCAL_OPERATOR_PRINCIPAL_ID,
      hasSessionStartRecord: () => true,
      currentConversationSessionId: (conversationId: string) => conversationId,
      canUserReadSession: () => true,
      inspectTurnDelivery: (conversationId: string, clientTurnId: string) =>
        support.inspect?.(conversationId, clientTurnId),
      hasActiveTurn: (threadId: string) => support.busy.has(threadId),
      dispatchWithReceipt: async (
        command: Record<string, unknown>,
        dispatchContext: Record<string, unknown>,
      ) => {
        support.commands.push({ ...command, context: dispatchContext });
        if (support.steerThrows) throw new Error('receipt lost');
        return {
          result: {
            outcome: 'unsupported-engine',
            threadId: command.threadId,
          },
        };
      },
      firstStartedMetadataOfThread: () => ({
        adoptedFromThreadId: 'attached',
      }),
      firstStartedEngineOfThread: () => 'claude',
      sessionRunsHost: () => false,
    }),
    storageAdapter: deepStub({
      getProject: () => {
        throw new Error('no project');
      },
    }),
    projectMembership: deepStub({ admissionsForResolvedPrincipal: () => [] }),
    taskGraphService: { listTasks: () => [] },
    projectService: {
      listProjects: () => [],
      getProject: (slug: string) => ({ slug }),
    },
    environmentSecurityService: deepStub({
      verifyCredential: () => false,
      authorizeCredential: () => false,
      verifyOperatorCredential: () => false,
      resolveGrantedScope: () => undefined,
      identifyDevice: () => undefined,
      deviceMaySendChat: (deviceId: string) => support.devices.has(deviceId),
      devicePairing: deepStub({}),
    }),
  });
  Reflect.set(context as object, 'buildRuntimeContext', () => context);
  const result = configureRuntimeRoutes(
    context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
  );
  await result.kitLifecycleReady;
  let resolvePort!: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const server = serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    (info) => resolvePort((info as AddressInfo).port),
  );
  closers.unshift(
    () =>
      new Promise<void>((resolve) => {
        (
          server as unknown as { closeAllConnections?: () => void }
        ).closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  /** Persist, then publish on the runtime's own bus. */
  const emit = (threadId: string, method: string, fields = {}) => {
    const persisted = event(threadId, method, fields);
    store.appendEvent(persisted);
    bus.emit('orchestration:event', { event: persisted });
  };
  return {
    base: `http://127.0.0.1:${await listening}`,
    emit,
    delegationResultStore,
  };
}

describe('configureRuntimeRoutes: delegated result delivery wiring (#3158)', () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    delete process.env[HOSTED_TENANT_REGISTRY_FILE_ENV];
    support.continued.length = 0;
    support.commands.length = 0;
    support.busy.clear();
    support.steerThrows = false;
    support.inspect = undefined;
    support.devices.clear();
    for (const close of closers.splice(0)) await close();
  });

  async function setup(
    options: {
      hosted?: boolean;
      /** Before composition: what an earlier process left behind. */
      seed?: (store: EventStore) => void;
    } = {},
  ) {
    const homeDir = makeTempDir('station-delegation-result-runtime-');
    if (options.hosted) {
      const registryPath = join(homeDir, 'tenants.json');
      writeFileSync(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
        }),
      );
      process.env[HOSTED_TENANT_REGISTRY_FILE_ENV] = registryPath;
    }
    const store = new EventStore(join(homeDir, 'orchestration.sqlite'));
    closers.push(() => {
      store.close();
    });
    options.seed?.(store);
    return { store, ...(await composeOver(homeDir, store, closers)) };
  }

  const callerHeaders = (channel: 'sdk-in-process' | 'url-token') => ({
    'content-type': 'application/json',
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    [STATION_CONTROL_CALLER_TOKEN_HEADER]: mintStationControlMcpToken(
      PARENT,
      channel,
    ).token,
  });

  async function delegate(
    base: string,
    channel: 'sdk-in-process' | 'url-token',
  ) {
    const response = await fetch(`${base}/api/orchestration/delegations`, {
      method: 'POST',
      headers: callerHeaders(channel),
      body: JSON.stringify({
        prompt: 'write the notes',
        target: { environment: { kind: 'current' }, agent: 'writer' },
      }),
    });
    expect(response.status).toBe(200);
  }

  const settleChild = (
    emit: (threadId: string, method: string, fields?: object) => void,
  ) => {
    emit(CHILD, 'turn.started', { turnId: 'child-turn-1', prompt: 'work' });
    emit(CHILD, 'turn.completed', {
      turnId: 'child-turn-1',
      outputText: 'notes are written',
    });
  };

  test("a bound caller's child result starts a parent turn through the production port, as the dispatch was attributed", async () => {
    const { base, emit } = await setup();
    await delegate(base, 'sdk-in-process');
    settleChild(emit);
    await vi.waitFor(() => expect(support.continued).toHaveLength(1));
    expect(support.continued[0]).toMatchObject({
      conversationId: PARENT,
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerAttribution: 'verified-bound',
      fullAccessGrant: null,
      clientOrigin: {
        actor: { kind: 'internal' },
        sender: { kind: 'delegation-result', sessionId: CHILD },
      },
    });
    expect(String(support.continued[0]!.message)).toContain(
      '> notes are written',
    );
  });

  test("a copied-token (url-token) caller's child result is replayed unattributed, never verified-bound", async () => {
    const { base, emit } = await setup();
    await delegate(base, 'url-token');
    settleChild(emit);
    await vi.waitFor(() => expect(support.continued).toHaveLength(1));
    expect(support.continued[0]!.ownerAttribution).toBe('unattributed-agent');
  });

  test('a busy parent is steered through the production steer port with the recorded attribution', async () => {
    const { base, emit } = await setup();
    await delegate(base, 'url-token');
    emit(PARENT, 'turn.started', { turnId: 'parent-turn-a' });
    settleChild(emit);
    await vi.waitFor(() => expect(support.commands).toHaveLength(1));
    expect(support.commands[0]).toMatchObject({
      type: 'steerTurn',
      threadId: PARENT,
      context: {
        ownerAttribution: 'unattributed-agent',
        clientOrigin: {
          actor: { kind: 'internal' },
          sender: { kind: 'delegation-result', sessionId: CHILD },
        },
      },
    });
    // The engine cannot steer: the result waits for the parent's turn end.
    expect(support.continued).toHaveLength(0);
    emit(PARENT, 'turn.completed', { turnId: 'parent-turn-a' });
    await vi.waitFor(() => expect(support.continued).toHaveLength(1));
  });

  test('startup reconcile delivers a result a previous process left undelivered', async () => {
    await setup({
      seed: (store) => {
        store.delegationResultStore().arm({
          childConversationId: CHILD,
          taskId: CHILD,
          parentConversationId: PARENT,
          actor: {
            userId: LOCAL_OPERATOR_PRINCIPAL_ID,
            attribution: 'verified-bound',
          },
        });
        store.appendEvent(
          event(CHILD, 'turn.started', { turnId: 'child-turn-1' }),
        );
        store.appendEvent(
          event(CHILD, 'turn.completed', {
            turnId: 'child-turn-1',
            outputText: 'finished while down',
          }),
        );
      },
    });
    await vi.waitFor(() => expect(support.continued).toHaveLength(1));
    expect(String(support.continued[0]!.message)).toContain(
      '> finished while down',
    );
  });

  test('a hosted Station composes no delivery', async () => {
    const { delegationResultStore } = await setup({
      hosted: true,
      seed: (store) => {
        store.delegationResultStore().arm({
          childConversationId: CHILD,
          taskId: CHILD,
          parentConversationId: PARENT,
          actor: {
            userId: LOCAL_OPERATOR_PRINCIPAL_ID,
            attribution: 'verified-bound',
          },
        });
        store.appendEvent(
          event(CHILD, 'turn.started', { turnId: 'child-turn-1' }),
        );
        store.appendEvent(
          event(CHILD, 'turn.completed', { turnId: 'child-turn-1' }),
        );
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(delegationResultStore).not.toHaveBeenCalled();
    expect(support.continued).toHaveLength(0);
  });

  test('a steer whose dispatch throws stays unconfirmed and is not sent again as a start', async () => {
    support.steerThrows = true;
    const { base, emit, store } = await setup();
    await delegate(base, 'sdk-in-process');
    emit(PARENT, 'turn.started', { turnId: 'parent-turn-a' });
    settleChild(emit);
    await vi.waitFor(() =>
      expect(store.delegationResultStore().listForChild(CHILD)).toEqual([
        expect.objectContaining({ state: 'claimed', attempts: 1 }),
      ]),
    );
    emit(PARENT, 'turn.completed', { turnId: 'parent-turn-a' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(support.continued).toHaveLength(0);
    expect(store.delegationResultStore().listForChild(CHILD)[0]!.decision).toBe(
      `steer:${PARENT}`,
    );
  });

  test('#3568 D1: a delivery whose key a Session of the parent already started is not continued again', async () => {
    const { base, emit, store } = await setup();
    support.inspect = () => ({
      outcome: 'started',
      sessionId: `${PARENT}:session:earlier`,
      turnId: 'parent-turn-earlier',
    });
    await delegate(base, 'sdk-in-process');
    settleChild(emit);
    await vi.waitFor(() =>
      expect(store.delegationResultStore().listForChild(CHILD)[0]?.state).toBe(
        'delivered',
      ),
    );
    expect(support.continued).toHaveLength(0);
  });

  test.each(['indeterminate', 'expired'] as const)(
    '#3568 R2-1: a delivery whose key a Session of the parent may have taken (%s) is never continued',
    async (outcome) => {
      const { base, emit, store } = await setup();
      support.inspect = () => ({ outcome });
      await delegate(base, 'sdk-in-process');
      settleChild(emit);
      await vi.waitFor(() =>
        expect(
          store.delegationResultStore().listForChild(CHILD)[0],
        ).toMatchObject({ state: 'claimed', unconfirmed: `start:${PARENT}` }),
      );
      expect(support.continued).toHaveLength(0);
    },
  );

  test('#3568 R2-2: a delivery whose key a live attempt holds on another Session is not continued', async () => {
    const { base, emit, store } = await setup();
    support.inspect = () => ({ outcome: 'received' });
    await delegate(base, 'sdk-in-process');
    settleChild(emit);
    await vi.waitFor(() =>
      expect(
        store.delegationResultStore().listForChild(CHILD)[0]?.attempts,
      ).toBeGreaterThan(0),
    );
    expect(support.continued).toHaveLength(0);
  });
});

describe('configureRuntimeRoutes: conversation inbox wiring (#3568)', () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    support.continued.length = 0;
    support.inspect = undefined;
    support.devices.clear();
    for (const close of closers.splice(0)) await close();
  });

  const held = (
    store: EventStore,
    clientTurnId: string,
    clientOrigin?: Record<string, unknown>,
  ) =>
    store.threadInboxStore().submit({
      conversationId: PARENT,
      clientTurnId,
      payload: {
        message: `held ${clientTurnId}`,
        actor: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
        ...(clientOrigin ? { clientOrigin: clientOrigin as never } : {}),
      },
      now: Date.now(),
    });

  // The same composition as the delegation suite above, reached through its
  // `setup`; re-declared here so this block owns its own closers.
  async function compose(seed: (store: EventStore) => void) {
    const homeDir = makeTempDir('station-thread-inbox-runtime-');
    const store = new EventStore(join(homeDir, 'orchestration.sqlite'));
    closers.push(() => {
      store.close();
    });
    seed(store);
    return { store, ...(await composeOver(homeDir, store, closers)) };
  }

  test('startup places a held follow-up through the production start port, as its sender', async () => {
    support.inspect = () => ({ outcome: 'not-received' });
    const { store } = await compose((store) => held(store, 'k1'));
    await vi.waitFor(() => expect(support.continued).toHaveLength(1));
    expect(support.continued[0]).toMatchObject({
      conversationId: PARENT,
      message: 'held k1',
      clientTurnId: 'k1',
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      fullAccessGrant: null,
    });
    await vi.waitFor(() =>
      expect(store.threadInboxStore().list(PARENT)[0]?.state).toBe('placed'),
    );
  });

  test('a real durable boundary holds a queued follow-up until its exact uninvoked owner releases it', async () => {
    support.inspect = () => ({ outcome: 'not-received' });
    const homeDir = makeTempDir('station-thread-inbox-durable-hold-');
    const store = new EventStore(join(homeDir, 'orchestration.sqlite'));
    closers.push(() => {
      store.close();
    });
    const authority = store.sessionTurnBoundaryAuthority();
    const owned = authority.claim(PARENT, new Date().toISOString());
    if (owned.kind !== 'owner')
      throw new Error('actual boundary owner required');
    const boundaryRows = () =>
      store['db']
        .prepare(
          'SELECT * FROM orchestration_turn_boundaries WHERE thread_id=?',
        )
        .all(PARENT);
    const original = boundaryRows();
    let released = false;
    const release = () => {
      if (released) return;
      if (!isDeepStrictEqual(boundaryRows(), original))
        throw new Error('Boundary changed; preserve intervening state');
      expect(owned.claim.notInvoked()).toEqual({ kind: 'applied' });
      released = true;
    };
    const reads = vi.spyOn(authority, 'hasPossibleEffect');
    try {
      expect(original).toHaveLength(1);
      held(store, 'durable-hold');
      const { emit } = await composeOver(homeDir, store, closers);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const queued = store.threadInboxStore().list(PARENT);
      expect(queued).toMatchObject([{ key: 'durable-hold', state: 'queued' }]);
      expect(support.continued).toHaveLength(0);
      expect(support.commands).toHaveLength(0);
      expect(boundaryRows()).toEqual(original);
      expect(reads).toHaveBeenCalledWith(PARENT);
      expect(reads.mock.results).toContainEqual({
        type: 'return',
        value: { kind: 'available', active: true },
      });
      writeSync(
        1,
        `@@STATION_RUNTIME_DURABLE_HOLD@@${JSON.stringify({
          phase: 'held',
          rows: queued,
          boundary: original,
          durableReads: reads.mock.results.slice(0, 32),
          durableReadCount: reads.mock.results.length,
          durableReadsTruncated: reads.mock.results.length > 32,
          continued: support.continued,
          commands: support.commands,
        })}@@END_STATION_RUNTIME_DURABLE_HOLD@@\n`,
      );
      release();
      expect(boundaryRows()).toEqual([]);
      emit(PARENT, 'session.configured');
      await vi.waitFor(() =>
        expect(store.threadInboxStore().list(PARENT)[0]?.state).toBe('placed'),
      );
      expect(support.continued).toHaveLength(1);
      expect(support.continued[0]).toMatchObject({
        conversationId: PARENT,
        clientTurnId: 'durable-hold',
        message: 'held durable-hold',
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        fullAccessGrant: null,
      });
      expect(support.commands).toHaveLength(0);
      expect(reads.mock.results).toContainEqual({
        type: 'return',
        value: { kind: 'available', active: false },
      });
      writeSync(
        1,
        `@@STATION_RUNTIME_DURABLE_HOLD@@${JSON.stringify({
          phase: 'placed',
          rows: store.threadInboxStore().list(PARENT),
          boundary: boundaryRows(),
          durableReads: reads.mock.results.slice(0, 32),
          durableReadCount: reads.mock.results.length,
          durableReadsTruncated: reads.mock.results.length > 32,
          continued: support.continued,
          commands: support.commands,
        })}@@END_STATION_RUNTIME_DURABLE_HOLD@@\n`,
      );
    } finally {
      reads.mockRestore();
      release();
    }
  });

  test('a held follow-up whose key the conversation already started is settled without a send', async () => {
    support.inspect = () => ({
      outcome: 'started',
      sessionId: PARENT,
      turnId: 'turn-already',
    });
    const { store } = await compose((store) => held(store, 'k2'));
    await vi.waitFor(() =>
      expect(store.threadInboxStore().list(PARENT)[0]?.state).toBe('placed'),
    );
    expect(support.continued).toHaveLength(0);
  });

  test('a reader the personal Station lets continue the conversation has a held follow-up delivered', async () => {
    support.inspect = () => ({ outcome: 'not-received' });
    // The conversation's recorded owner is the operator; this sender is not,
    // but may read (and so, by the live rule, continue) it.
    const { store } = await compose((store) =>
      store.threadInboxStore().submit({
        conversationId: PARENT,
        clientTurnId: 'k4',
        payload: {
          message: 'from the reader',
          actor: { userId: 'human:local:reader' },
        },
        now: Date.now(),
      }),
    );
    await vi.waitFor(() => expect(support.continued).toHaveLength(1));
    expect(support.continued[0]).toMatchObject({
      userId: 'human:local:reader',
      message: 'from the reader',
    });
    await vi.waitFor(() =>
      expect(store.threadInboxStore().list(PARENT)[0]?.state).toBe('placed'),
    );
  });

  test('a follow-up from a device that lost the scope to send is refused, never sent', async () => {
    const { store } = await compose((store) =>
      held(store, 'k3', {
        version: 1,
        actor: { kind: 'device', deviceId: 'phone' },
        reported: { version: 1, surface: 'web', build: null },
      }),
    );
    await vi.waitFor(() =>
      expect(store.threadInboxStore().list(PARENT)[0]).toMatchObject({
        state: 'refused',
      }),
    );
    expect(
      JSON.parse(store.threadInboxStore().list(PARENT)[0]!.outcome ?? '{}'),
    ).toMatchObject({ reasonCode: 'device_not_permitted' });
    expect(support.continued).toHaveLength(0);
  });
});
