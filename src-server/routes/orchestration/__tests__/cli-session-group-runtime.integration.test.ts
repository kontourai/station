import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileDelegationAttemptClaimStore } from '../../../services/orchestration/delegation-attempt-claim-store.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { createRemoteStationForwarder } from '../../../services/remote-stations/remote-station-forwarder.js';
import {
  delegateTask,
  interruptDelegatedTask,
  observeDelegatedTask,
} from '../../../tools/station-control-delegation.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const temporary = trackTempDirs();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

class MemberAdapter extends GateTestAdapter {
  readonly starts: ProviderSessionStartInput[] = [];
  private readonly sessions = new Map<
    string,
    Awaited<ReturnType<GateTestAdapter['startSession']>>
  >();
  readonly turns: ProviderSendTurnInput[] = [];
  readonly interrupts: { sessionId: string; turnId: string }[] = [];
  holdTurns = false;
  override async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
    const session = await super.startSession(input);
    this.sessions.set(input.threadId, session);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      createdAt: session.createdAt,
      metadata: input.metadata,
    });
    return session;
  }
  override async hasSession(threadId?: string) {
    return threadId !== undefined && this.sessions.has(threadId);
  }
  override async listSessions() {
    return [...this.sessions.values()];
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const turnId = randomUUID();
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      method: 'turn.started',
      createdAt: new Date().toISOString(),
      invocationId: input.invocationId,
    });
    if (this.holdTurns) return { threadId: input.threadId, turnId };
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      method: 'turn.completed',
      createdAt: new Date().toISOString(),
      outputText: 'Returned member result',
      finishReason: 'stop',
      invocationId: input.invocationId,
    });
    return { threadId: input.threadId, turnId };
  }

  override async interruptTurn(threadId: string, turnId?: string) {
    if (!turnId) return { outcome: 'no-active-turn' as const };
    this.interrupts.push({ sessionId: threadId, turnId });
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId,
      turnId,
      method: 'turn.aborted',
      createdAt: new Date().toISOString(),
      reason: 'cancelled',
    });
    return { outcome: 'cancelled' as const, turnId };
  }
}

async function fixture() {
  const root = realpathSync(temporary('station-real-cli-group-'));
  const actor = humanPrincipal('test', 'group-owner', 'Group owner');
  const adapter = new MemberAdapter();
  const store = new EventStore(join(root, 'events.sqlite'));
  cleanup.push(async () => {
    store.close();
  });
  const bus = new EventBus();
  let prepare: () => Promise<void> = async () => {};
  let beforeReceipt: (
    handle: Awaited<ReturnType<typeof delegateTask>>,
  ) => Promise<void> = async () => {};
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore: store,
    logger: { debug() {}, warn() {} },
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: async () => {
        await prepare();
        return { name: 'Reviewer', prompt: 'Review the supplied brief.' };
      },
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    }),
  });
  cleanup.push(() => service.shutdown());
  const remote = createRemoteStationForwarder({
    ssh: {
      list: () => [],
      connect: async () => {
        throw new Error('No remote fixture');
      },
    },
    peers: { get: () => null },
  });
  const pendingDispatches: Promise<unknown>[] = [];
  const app = new Hono();
  app.get('/.well-known/station/v1', (c) =>
    c.json({ environmentId: 'group-host' }),
  );
  app.get('/api/agents/reviewer', (c) =>
    c.json({
      success: true,
      data: {
        slug: 'reviewer',
        name: 'Reviewer',
        available: true,
        execution: { agentConnectionId: 'claude' },
      },
    }),
  );
  app.get('/api/connections/claude', (c) =>
    c.json({
      success: true,
      data: {
        id: 'claude',
        kind: 'agent',
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
        config: { provider: 'claude' },
      },
    }),
  );
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      cliSessionGroups: {
        home: root,
        preview: { select: ({ enabled }) => enabled() },
      },
      delegationAttemptClaimStore: new FileDelegationAttemptClaimStore(root),
      eventBus: bus,
      logger: { debug() {}, warn() {} },
      resolvePrincipal: () => actor,
      callerBindingForRequest: () => 'fixture-group-owner',
      isRequestPrincipalCurrent: () => true,
      delegateTask: (input) => {
        const pending = delegateTask(input, service, remote).then(
          async (handle) => {
            await beforeReceipt(handle);
            return handle;
          },
        );
        pendingDispatches.push(pending);
        return pending;
      },
      interruptDelegatedTask: (input) =>
        interruptDelegatedTask(input, service, remote),
      observeDelegatedTask: (input) =>
        observeDelegatedTask(input, service, remote),
    }),
  );
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  if (!server.listening)
    await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv('STATION_API_BASE', apiBase);
  vi.stubEnv('STATION_INTERNAL_API_TOKEN', 'group-test');
  return {
    app,
    actor,
    adapter,
    store,
    service,
    pendingDispatches,
    setBeforeReceipt: (work: typeof beforeReceipt) => {
      beforeReceipt = work;
    },
    setPreparation: (work: typeof prepare) => {
      prepare = work;
    },
  };
}

async function create(
  f: Awaited<ReturnType<typeof fixture>>,
  seats = 3,
  maxDispatches?: number,
) {
  const response = await f.app.request('/api/orchestration/session-groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'real-group',
      maxConcurrent: Math.min(2, seats),
      maxDispatches,
      deadlineAt: Date.now() + 60_000,
      members: Array.from({ length: seats }, (_, index) => ({
        seatId: `seat-${index}`,
        prompt: `Review part ${index}`,
        needs: index === 2 ? ['seat-0', 'seat-1'] : [],
        target: {
          agent: 'reviewer',
          expectedEngine: { kind: 'connection', connectionId: 'claude' },
        },
      })),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: CliSessionGroupView }).data;
}

test('actual delegation creates three sessions and first turns, joins their durable events, and completes the Flow frontier', async () => {
  const f = await fixture();
  const group = await create(f);
  const response = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    { method: 'POST', signal: AbortSignal.timeout(5000) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const final = ((await response.json()) as { data: CliSessionGroupView }).data;
  expect(f.adapter.starts).toHaveLength(3);
  expect(f.adapter.turns).toHaveLength(3);
  expect(f.adapter.turns[2]?.input).toContain('Review part 2');
  expect(final.flow?.status).toBe('completed');
  for (const member of final.members) {
    expect(member.outcome).toBe('completed');
    const turn = f.adapter.turns.find(
      (input) => input.threadId === member.reservedSessionId,
    )!;
    expect(turn.clientTurnId).toBe(member.initialClientTurnId);
    const events = f.store.listEvents(member.handle!.sessionId);
    expect(
      events.some((event) => event.payload.method === 'session.started'),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.payload.method === 'turn.completed' &&
          event.payload.turnId === member.handle!.initialTurnId,
      ),
    ).toBe(true);
  }
}, 30_000);

test('cancellation after Agent preparation starts prevents the actual adapter spawn', async () => {
  const f = await fixture();
  let preparing = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setPreparation(async () => {
    preparing = true;
    await held;
  });
  const group = await create(f, 1);
  const run = f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    { method: 'POST' },
  );
  try {
    await vi.waitFor(() => expect(preparing).toBe(true), { timeout: 5000 });
    const cancelled = await f.app.request(
      `/api/orchestration/session-groups/${group.groupId}/cancel`,
      { method: 'POST' },
    );
    expect(cancelled.status).toBe(200);
  } finally {
    release();
  }
  await run;
  await Promise.allSettled(f.pendingDispatches);
  expect(f.adapter.starts).toHaveLength(0);
  expect(f.adapter.turns).toHaveLength(0);
}, 30_000);

test('a zero-dispatch group refuses startup through the real run route', async () => {
  const f = await fixture();
  const group = await create(f, 1, 0);
  const response = await f.app.request(
    `/api/orchestration/session-groups/${group.groupId}/run`,
    { method: 'POST' },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { dispatchCount: 0, admissionClosed: 'dispatch-limit-exhausted' },
  });
  expect(f.adapter.starts).toEqual([]);
  expect(f.adapter.turns).toEqual([]);
});

function readAcceptedMember(
  f: Awaited<ReturnType<typeof fixture>>,
  path: string,
) {
  return vi.waitFor(
    async () => {
      const response = await f.app.request(path);
      expect(response.status).toBe(200);
      const { data } = (await response.json()) as { data: CliSessionGroupView };
      const handle = data.members[0]?.handle;
      expect(handle?.initialTurnId).toEqual(expect.any(String));
      return handle!;
    },
    { timeout: 5000 },
  );
}

test('cancelling a running group interrupts only its accepted initial turn', async () => {
  const f = await fixture();
  f.adapter.holdTurns = true;
  const group = await create(f, 1);
  const path = `/api/orchestration/session-groups/${group.groupId}`;
  const controller = new AbortController();
  const running = f.app.request(`${path}/run`, {
    method: 'POST',
    signal: controller.signal,
  });
  try {
    const accepted = await readAcceptedMember(f, path);
    const response = await f.app.request(`${path}/cancel`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect((await running).status).toBe(200);
    expect(f.adapter.interrupts).toEqual([
      { sessionId: accepted.sessionId, turnId: accepted.initialTurnId },
    ]);
  } finally {
    controller.abort();
    await running;
  }
}, 30_000);

test('disconnecting a group run requests an exact stop for the accepted initial turn', async () => {
  const f = await fixture();
  f.adapter.holdTurns = true;
  const group = await create(f, 1);
  const path = `/api/orchestration/session-groups/${group.groupId}`;
  const controller = new AbortController();
  const running = f.app.request(`${path}/run`, {
    method: 'POST',
    signal: controller.signal,
  });
  try {
    const accepted = await readAcceptedMember(f, path);
    controller.abort();
    expect((await running).status).toBe(403);
    await vi.waitFor(
      () =>
        expect(f.adapter.interrupts).toEqual([
          { sessionId: accepted.sessionId, turnId: accepted.initialTurnId },
        ]),
      { timeout: 5000 },
    );
  } finally {
    controller.abort();
    await running;
    await Promise.allSettled(f.pendingDispatches);
  }
}, 30_000);

test('a receipt arriving after cancellation reserves the exact stop without guessing a turn', async () => {
  const f = await fixture();
  f.adapter.holdTurns = true;
  let received: Awaited<ReturnType<typeof delegateTask>> | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setBeforeReceipt(async (handle) => {
    received = handle;
    await held;
  });
  const group = await create(f, 1);
  const path = `/api/orchestration/session-groups/${group.groupId}`;
  const controller = new AbortController();
  const running = f.app.request(`${path}/run`, {
    method: 'POST',
    signal: controller.signal,
  });
  try {
    const accepted = await vi.waitFor(
      () => {
        expect(received?.turnId).toEqual(expect.any(String));
        return received!;
      },
      { timeout: 5000 },
    );
    const cancelled = await f.app.request(`${path}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      data: { cancelled: true, members: [{ state: 'launch-intent' }] },
    });
    expect(f.adapter.interrupts).toEqual([]);
    release();
    await vi.waitFor(
      () => {
        expect(f.adapter.interrupts).toEqual([
          { sessionId: accepted.sessionId, turnId: accepted.turnId },
        ]);
      },
      { timeout: 5000 },
    );
    expect((await running).status).toBe(200);
  } finally {
    release();
    controller.abort();
    await running;
    await Promise.allSettled(f.pendingDispatches);
  }
}, 30_000);

test('sync resolves the exact completed member and refuses before journaling on an unsupported runtime', async () => {
  const f = await fixture();
  const group = await create(f, 1);
  const path = `/api/orchestration/session-groups/${group.groupId}`;
  const ran = await f.app.request(`${path}/run`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
  });
  expect(ran.status, await ran.clone().text()).toBe(200);
  const completed = ((await ran.json()) as { data: CliSessionGroupView }).data;
  expect(completed.members[0]?.outcome).toBe('completed');
  expect(f.adapter.turns).toHaveLength(1);
  const preflight = vi.spyOn(f.service, 'assertRetainedSessionSyncAvailable');
  const sync = await f.app.request(`${path}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'sync-one',
      runId: 'fold-one',
      content: 'Folded result',
      deadlineAt: Date.now() + 30_000,
    }),
  });
  expect(sync.status, await sync.clone().text()).toBe(503);
  expect(await sync.json()).toEqual({
    success: false,
    code: 'group_unavailable',
  });
  expect(preflight).toHaveBeenCalledExactlyOnceWith(
    completed.members[0]?.handle?.sessionId,
    expect.objectContaining({ userId: f.actor.id }),
  );
  const read = await f.app.request(`${path}?includeContextSync=1`);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { data: CliSessionGroupView }).data).toEqual(
    completed,
  );
  expect(f.adapter.turns).toHaveLength(1);
});
