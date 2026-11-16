/**
 * #3628: `configureRuntimeRoutes` hands the runtime's `coordinator-session`
 * selector to the coordinator routes, the wake and the HTTP MCP caller
 * records. A real registry selector, a real coordinator store; the rest of
 * the runtime is inert stubs. One case composes the REAL support services
 * (`support.real`), so the coordinator wake `configureRuntimeRoutes` passes
 * them is the one a restart's finished-alert replay reaches.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { orchestrationStreamPresenceSubjectForSession } from '../../../services/orchestration/orchestration-stream-presence.js';
import {
  __resetStationControlMcpTokensForTests,
  coordinatorGeneration,
  mintStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const support = vi.hoisted(() => ({
  notificationService: undefined as unknown,
  /** Compose the real support services instead of the inert stub. */
  real: false,
  /** The real notification services composed, newest last. */
  composed: [] as Array<{ shutdown(): Promise<unknown> }>,
}));

vi.mock('../runtime-route-support.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../runtime-route-support.js')>();
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: (
      ...args: Parameters<typeof real.configureRuntimeSupportServices>
    ) => {
      if (!support.real)
        return {
          schedulerService: stub,
          notificationService: support.notificationService,
          attentionProjection: stub,
          webPushService: stub,
          webPushEnabled: false,
        };
      const services = real.configureRuntimeSupportServices(...args);
      support.composed.push(services.notificationService);
      return services;
    },
    createRuntimeSystemRouteDeps: () => stub,
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

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-coordinator';
const COORDINATOR = 'coordinator-chat';
const makeTempDir = trackTempDirs();

describe('configureRuntimeRoutes: coordinator-session preview', () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    __resetStationControlMcpTokensForTests();
    for (const close of closers.splice(0)) await close();
    for (const service of support.composed.splice(0)) await service.shutdown();
    support.real = false;
  });

  async function setup(
    options: {
      /** Reuse this home and store (a restart of the same Station). */
      reuse?: { homeDir: string; store: EventStore };
      /** Turn the coordinator-session preview on before composing. */
      previewEnabled?: boolean;
      /** Session facts the real support services read. */
      orchestration?: Record<string, unknown>;
    } = {},
  ) {
    const homeDir =
      options.reuse?.homeDir ?? makeTempDir('station-coordinator-preview-');
    const store =
      options.reuse?.store ??
      new EventStore(join(homeDir, 'orchestration.sqlite'));
    if (!options.reuse) {
      closers.push(() => {
        store.close();
      });
      store.coordinatorStore().designate({
        conversationId: COORDINATOR,
        actor: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
        replace: false,
        now: 1,
      });
    }
    const notifications = new NotificationService(
      new EventBus(),
      homeDir,
      999_999,
    );
    closers.push(() => notifications.shutdown());
    support.notificationService = notifications;
    __resetStationServerSelfAttestationForTests();
    const registry = new FeaturePreviewRegistry(homeDir, {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as never);
    const bus = new EventBus();
    // Every frame on this process's bus, from before it is composed: a
    // replay dispatched while composing or settling is not missed.
    const frames: string[] = [];
    bus.subscribe((frame) => void frames.push(frame.event));
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
      featurePreviews: registry,
      coordinatorSessionPreview: registry.bind({
        id: 'coordinator-session',
        label: 'Coordinator chat',
        description: 'test',
      }),
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
      // The coordinator's reads go to the real store; the rest is inert.
      orchestrationEventStore: deepStub({
        sessionTurnBoundaryAuthority: () => ({
          reconcile: () => ({ kind: 'available', interrupted: [] }),
          hasPossibleEffect: () => ({ kind: 'available', active: false }),
        }),
        coordinatorStore: () => store.coordinatorStore(),
        delegationResultStore: () => store.delegationResultStore(),
        threadInboxStore: () => store.threadInboxStore(),
        conversationForSession: (threadId: string) =>
          store.conversationForSession(threadId),
        listEventsByMethods: (threadId: string, methods: readonly string[]) =>
          store.listEventsByMethods(threadId, methods),
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
        currentConversationSessionId: (conversationId: string) =>
          conversationId,
        canUserReadSession: () => true,
        canUserReadConversation: () => true,
        firstStartedMetadataOfThread: () => undefined,
        ...options.orchestration,
      }),
      storageAdapter: deepStub({
        getProject: () => {
          throw new Error('no project');
        },
      }),
      projectMembership: deepStub({ admissionsForResolvedPrincipal: () => [] }),
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
      environmentSecurityService: deepStub({
        verifyCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        authorizeCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        resolveGrantedScope: (credential: string) =>
          credential === OPERATOR_CREDENTIAL
            ? 'orchestration:read orchestration:operate'
            : undefined,
        identifyDevice: () => undefined,
        devicePairing: deepStub({}),
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    // After `registry.bind` (in the context above) offers the preview, and
    // before composing: the replay that composition queues reads it enabled.
    if (options.previewEnabled)
      await registry.setEnabled('coordinator-session', true);
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
    return {
      base: `http://127.0.0.1:${await listening}`,
      bus,
      store,
      registry,
      homeDir,
      frames,
      /** Stops this process's HTTP server (its other listeners stay idle). */
      closeServer: closers[0],
    };
  }

  async function until<T>(
    read: () => T | Promise<T>,
    done: (value: T) => boolean,
    what: string,
  ): Promise<T> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  test('a restart that finds a finish written just before Station stopped wakes the coordinator through the real composition, without delivering it again', {
    timeout: 60_000,
  }, async () => {
    const owner = orchestrationStreamPresenceSubjectForSession(
      LOCAL_OPERATOR_PRINCIPAL_ID,
    );
    const orchestration = {
      isReadOnlyAttachedSession: () => false,
      isEphemeralSession: () => false,
      resolveSessionPresenceSubject: () => owner,
      readFinishedAlertHold: (): string[] => [],
      isDelegatedChildSession: () => false,
      consumeInternalStopSuppression: () => false,
    };
    const tag = 'turn-completion:worker-1:t1';
    const episodesFile = (homeDir: string) =>
      join(homeDir, 'finished-alert-episodes.json');
    support.real = true;

    // Process 1: the coordinator preview is off, so nothing it delivers
    // reaches the coordinator. The real producer writes the record.
    const first = await setup({ orchestration });
    let atCommit: string | undefined;
    first.bus.subscribe((frame) => {
      if (frame.event === SERVER_EVENTS.NOTIFICATION_DELIVERED)
        // Station stops here: the record is committed, and the producer
        // has saved its `writing` row but not yet acknowledged the write.
        atCommit ??= readFileSync(episodesFile(first.homeDir), 'utf8');
    });
    const turn = {
      createdAt: new Date().toISOString(),
      provider: 'claude',
      threadId: 'worker-1',
      turnId: 't1',
    };
    first.bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: { ...turn, method: 'turn.started', prompt: 'go' },
    });
    first.bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: {
        ...turn,
        eventId: 'terminal-1',
        method: 'turn.completed',
        finishReason: 'stop',
      },
    });
    const firstNotifications = support.composed.at(-1) as unknown as {
      list(): Promise<Array<{ id: string; source: string }>>;
      get(id: string): Promise<unknown>;
    };
    const [record] = await until(
      async () =>
        (await firstNotifications.list()).filter(
          (n) => n.source === 'turn-completion',
        ),
      (records) => records.length === 1,
      'the finished record',
    );
    const before = await firstNotifications.get(record!.id);
    expect(JSON.parse(atCommit ?? '[]')).toEqual([
      expect.objectContaining({
        state: 'writing',
        threadId: 'worker-1',
        turnId: 't1',
      }),
    ]);
    expect(
      first.store.coordinatorStore().waitingItems(LOCAL_OPERATOR_PRINCIPAL_ID),
    ).toEqual([]);
    // Dispose process 1, and leave the home as it was at the stop.
    await support.composed.shift()?.shutdown();
    await first.closeServer?.();
    writeFileSync(episodesFile(first.homeDir), atCommit!);

    // Process 2: the preview is on; only its recovery can wake the
    // coordinator.
    const second = await setup({
      reuse: { homeDir: first.homeDir, store: first.store },
      previewEnabled: true,
      orchestration,
    });
    const items = await until(
      () =>
        second.store
          .coordinatorStore()
          .waitingItems(LOCAL_OPERATOR_PRINCIPAL_ID)
          .map((item) => item.itemKey),
      (keys) => keys.length > 0,
      'the coordinator item',
    );
    expect(items).toEqual([`finished:${tag}`]);
    const secondNotifications = support.composed.at(-1) as unknown as {
      get(id: string): Promise<unknown>;
    };
    expect(await secondNotifications.get(record!.id)).toEqual(before);
    expect(
      second.frames.filter(
        (event) =>
          event === SERVER_EVENTS.NOTIFICATION_DELIVERED ||
          event === SERVER_EVENTS.NOTIFICATION_UPDATED,
      ),
    ).toEqual([]);
  });

  test('the routes, the wake and coordinator credentials follow the live choice', async () => {
    const { base, bus, store, registry } = await setup();
    const readDesignation = () =>
      fetch(`${base}/api/orchestration/coordinator`, {
        headers: { authorization: `Bearer ${OPERATOR_CREDENTIAL}` },
      });
    const notify = (n: number) =>
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
        id: `n${n}`,
        category: 'turn-failed',
        title: 'Worker failed',
        metadata: {
          sessionId: `worker-${n}`,
          dedupeTag: `turn-completion:worker-${n}:t1`,
        },
      });
    const generation = coordinatorGeneration(COORDINATOR);
    const { token } = mintStationControlMcpToken(
      COORDINATOR,
      'url-token',
      undefined,
      undefined,
      undefined,
      'coordinator-control',
      undefined,
      () => coordinatorGeneration(COORDINATOR) === generation,
    );
    const initialize = () =>
      fetch(`${base}/mcp/station-control?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' },
          },
        }),
      });

    const off = await readDesignation();
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({
      code: 'feature_preview_disabled',
      previewId: 'coordinator-session',
    });
    notify(1);
    expect(
      store.coordinatorStore().waitingItems(LOCAL_OPERATOR_PRINCIPAL_ID),
    ).toEqual([]);
    expect((await initialize()).status).toBe(401);

    await registry.setEnabled('coordinator-session', true);
    const on = await readDesignation();
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      data: { designation: { conversationId: COORDINATOR } },
    });
    notify(2);
    expect(
      store
        .coordinatorStore()
        .waitingItems(LOCAL_OPERATOR_PRINCIPAL_ID)
        .map((item) => item.sessionId),
    ).toEqual(['worker-2']);
    const accepted = await initialize();
    expect(accepted.status).toBe(200);
    await accepted.text();
  });
});
