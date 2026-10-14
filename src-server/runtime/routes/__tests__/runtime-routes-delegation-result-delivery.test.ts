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
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
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

describe('configureRuntimeRoutes: delegated result delivery wiring (#3158)', () => {
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    delete process.env[HOSTED_TENANT_REGISTRY_FILE_ENV];
    support.continued.length = 0;
    support.commands.length = 0;
    support.busy.clear();
    support.steerThrows = false;
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
        }),
        delegationResultStore,
        listEventsByMethods: (threadId: string, methods: readonly string[]) =>
          store.listEventsByMethods(threadId, methods),
        listTurnEventsByMethods: (
          threadId: string,
          turnId: string,
          methods: readonly string[],
          limit: number,
        ) => store.listTurnEventsByMethods(threadId, turnId, methods, limit),
        readSessionInventoryHighWater: (threadId: string) =>
          store.readSessionInventoryHighWater(threadId),
        conversationForSession: (threadId: string) =>
          store.conversationForSession(threadId),
        conversationSessions: () => [],
        readSessionByThread: () => undefined,
        sessionControlRequestKeys: () => store.sessionControlRequestKeys(),
      }),
      orchestrationService: deepStub({
        resolveSessionActingPrincipal: () => ({
          id: LOCAL_OPERATOR_PRINCIPAL_ID,
          source: 'session-owner' as const,
        }),
        sessionRecordedOwnerId: () => LOCAL_OPERATOR_PRINCIPAL_ID,
        hasSessionStartRecord: () => true,
        currentConversationSessionId: (conversationId: string) =>
          conversationId,
        canUserReadSession: () => true,
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
      store,
      emit,
      delegationResultStore,
    };
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
      clientOrigin: { actor: { kind: 'internal' } },
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
      context: { ownerAttribution: 'unattributed-agent' },
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
});
