/**
 * #4568: person-first engine-start capacity through the real
 * OrchestrationService, a real EventStore and the real start-lease controller:
 * a brand-new chat's first start, a cold follow-up's respawn and a
 * credential-profile restart. Waits are observed only through what Station
 * publishes: the `orchestration:engine-start-wait` frame (and the readers it
 * names), the Session summary and the stream-open replay.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { OrchestrationEngineStartWaitFrame } from '@kontourai/station-contracts/orchestration';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  INTERNAL_SESSION_READ_SCOPE,
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { awaitSessionRecoveryCompleted } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  ConcurrentEngineStartCapacityError,
  createRuntimeResourcePostureController,
  EngineStartCancelledError,
} from '../../infra/resource-posture.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import type { SessionReadScope } from '../orchestration-service.js';
import { OrchestrationService } from '../orchestration-service.js';

const operator: ClientOrigin = {
  version: 1,
  actor: { kind: 'operator' },
  reported: { version: 1, surface: 'web', build: '1' },
};

const reader = (userId: string) =>
  sessionReadAuthorityFromRequest(userId, undefined, undefined);

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.useRealTimers();
});

const PROJECT = { slug: 'demo', id: 'project-demo' };

async function harness(options: { hosted?: true } = {}) {
  const registry = parseHostedTenantRegistry({
    schemaVersion: 1,
    tenants: [
      { id: 'alpha', authority: 'alpha.station.test' },
      { id: 'bravo', authority: 'bravo.station.test' },
    ],
  });
  const ownerContext = {
    userId: 'owner',
    ...(options.hosted
      ? {
          tenantExecutionContext: {
            tenantId: tenantId('alpha'),
            source: 'request' as const,
          },
        }
      : {}),
  };
  const tmp = makeTempDir('engine-start-recovery-');
  // A real directory: workspace reauthorization compares canonical paths.
  const projectRoot = realpathSync(makeTempDir('engine-start-project-'));
  const eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
  const eventBus = new EventBus();
  const adapter = new GateTestAdapter();
  const backgroundGate = deferred();
  const backgroundEntered = deferred();
  const original = adapter.startSession.bind(adapter);
  vi.spyOn(adapter, 'startSession').mockImplementation(async (input) => {
    if (input.threadId === 'background') {
      backgroundEntered.release();
      await backgroundGate.promise;
    }
    return original(input);
  });
  /**
   * The production Project-directory resolver every start awaits to
   * reauthorize a Project workspace after admission. A test arms one hold to
   * stop a start exactly there, between the lease and the provider start.
   */
  let held: { reached: () => void; release: Promise<void> } | undefined;
  const resolveProjectSessionDirectory = vi.fn(
    async (slug: string, binding?: { localProjectId: string; cwd: string }) => {
      if (binding && held) {
        const hold = held;
        held = undefined;
        hold.reached();
        await hold.release;
      }
      if (slug !== PROJECT.slug) return undefined;
      return binding ? binding.cwd : projectRoot;
    },
  );
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    ...(options.hosted
      ? {
          requireTenantExecutionContext: () => true,
          validateRecoveredTenantExecutionContext: (
            value:
              | import('@kontourai/station-contracts/tenancy').TenantExecutionContext
              | undefined,
          ) =>
            value &&
            registry.tenants.some((tenant) => tenant.id === value.tenantId)
              ? value
              : undefined,
        }
      : {}),
    eventBus,
    eventStore,
    resourcePosture: createRuntimeResourcePostureController(),
    listProjects: () => [
      { slug: PROJECT.slug, id: PROJECT.id, workingDirectory: projectRoot },
    ],
    resolveProjectSessionDirectory,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  cleanups.push(async () => {
    backgroundGate.release();
    await service.shutdown();
  });

  /** Every wait frame Station published, with the readers it named. */
  const frames: Array<{
    frame: OrchestrationEngineStartWaitFrame;
    canRead: (scope: SessionReadScope) => boolean;
  }> = [];
  eventBus.subscribe((event) => {
    if (event.event === SERVER_EVENTS.ORCHESTRATION_ENGINE_START_WAIT_CHANGED)
      frames.push(event.data as (typeof frames)[number]);
  });

  /**
   * Resolves with the next published wait frame for `threadId` whose wait is
   * `present` (a queued start) or gone (`null`).
   */
  const waitPublished = (threadId: string, present: boolean) =>
    new Promise<(typeof frames)[number]>((resolve) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.event !== SERVER_EVENTS.ORCHESTRATION_ENGINE_START_WAIT_CHANGED
        )
          return;
        const published = event.data as (typeof frames)[number];
        if (
          published.frame.threadId === threadId &&
          (published.frame.wait !== null) === present
        ) {
          unsubscribe();
          resolve(published);
        }
      });
    });

  const summary = async (threadId: string) =>
    (await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE)).find(
      (session) => session.threadId === threadId,
    );

  /** A session restored at boot with no engine: the parked/interrupted case. */
  const restoreDormant = async (
    threadId: string,
    options: { project?: true } = {},
  ) => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      resumeCursor: { cursor: `resume-${threadId}` },
      ...(options.project ? { cwd: projectRoot } : {}),
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:05.000Z',
    });
    eventStore.appendEvent({
      eventId: `${threadId}-started`,
      provider: 'claude',
      threadId,
      method: 'session.started',
      sessionId: threadId,
      createdAt: '2026-11-01T00:00:00.000Z',
      metadata: {
        userId: 'owner',
        ...(options.project
          ? {
              projectSlug: PROJECT.slug,
              localProjectId: PROJECT.id,
              cwd: projectRoot,
            }
          : {}),
      },
    });
    service.initialize();
    await awaitSessionRecoveryCompleted(service);
  };

  /** A background engine start that holds the one start lease until released. */
  const holdStartLease = async () => {
    const background = service.startSessionInternal(
      {
        type: 'start-session',
        input: { threadId: 'background', provider: 'claude' },
      },
      ownerContext,
      { resourceAdmissionIntent: 'queued_background' },
    );
    await backgroundEntered.promise;
    return {
      release: async () => {
        backgroundGate.release();
        expect((await background).status).toBe('accepted');
      },
    };
  };

  /**
   * Hold the next post-admission Project workspace reauthorization. Arm it
   * while the start is still queued, so the hold lands after the lease.
   */
  const holdWorkspaceAuthorization = () => {
    const reached = deferred();
    const release = deferred();
    held = { reached: reached.release, release: release.promise };
    return { reached: reached.promise, release: release.release };
  };

  /** A person's brand-new chat: a first start no Session record answers for. */
  const freshStart = (
    threadId: string,
    userId = 'owner',
    options: { project?: true } = {},
  ) =>
    service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId,
          provider: 'claude',
          ...(options.project
            ? { cwd: projectRoot, metadata: { projectSlug: PROJECT.slug } }
            : {}),
        },
      },
      { ...ownerContext, userId },
      { resourceAdmissionIntent: 'interactive_user' },
    );

  const startsFor = (threadId: string) =>
    vi
      .mocked(adapter.startSession)
      .mock.calls.filter(([input]) => input.threadId === threadId).length;

  return {
    adapter,
    registry,
    eventStore,
    frames,
    service,
    waitPublished,
    summary,
    restoreDormant,
    holdStartLease,
    holdWorkspaceAuthorization,
    freshStart,
    startsFor,
  };
}

/** The retryable refusal a dispatch reports for a held start lease. */
const capacityRefusal = {
  message: new ConcurrentEngineStartCapacityError().message,
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('a cold follow-up respawn (#4568)', () => {
  test("a person's follow-up waits behind a background start, shows the wait, and continues when the slot settles", async () => {
    const h = await harness();
    await h.restoreDormant('parked');
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('parked', true);
    const turn = h.service.dispatch(
      { type: 'sendTurn', input: { threadId: 'parked', input: 'continue' } },
      { clientOrigin: operator },
    );
    let settled = false;
    void turn.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waiting;
    expect((await h.summary('parked'))?.engineStartWait?.since).toEqual(
      expect.any(String),
    );
    await settle();
    expect(settled).toBe(false);
    expect(h.startsFor('parked')).toBe(0);

    const cleared = h.waitPublished('parked', false);
    await lease.release();
    await cleared;
    expect(await turn).toMatchObject({ turnId: 'turn-1' });
    expect(h.startsFor('parked')).toBe(1);
    expect((await h.summary('parked'))?.engineStartWait).toBeUndefined();
  });

  test.each([
    [
      'an automatic send carrying a person origin',
      { clientOrigin: operator },
      { resourceAdmissionIntent: 'queued_background' as const },
    ],
    ['an unclassified send', {}, undefined],
    [
      'an Automation turn',
      { clientOrigin: operator },
      { dispatchOrigin: 'automation' as const },
    ],
  ])(
    '%s keeps the immediate retryable refusal',
    async (_name, context, internal) => {
      const h = await harness();
      await h.restoreDormant('parked');
      const lease = await h.holdStartLease();
      await expect(
        h.service.dispatch(
          { type: 'sendTurn', input: { threadId: 'parked', input: 'auto' } },
          context,
          internal,
        ),
      ).rejects.toMatchObject(capacityRefusal);
      expect(h.startsFor('parked')).toBe(0);
      expect((await h.summary('parked'))?.engineStartWait).toBeUndefined();
      await lease.release();
    },
  );

  test('a person joining a refused automatic respawn starts again under their own intent', async () => {
    const h = await harness();
    await h.restoreDormant('parked');
    const lease = await h.holdStartLease();
    const automatic = h.service.dispatch(
      { type: 'sendTurn', input: { threadId: 'parked', input: 'auto' } },
      { clientOrigin: operator },
      { resourceAdmissionIntent: 'queued_background' },
    );
    const waiting = h.waitPublished('parked', true);
    const person = h.service.dispatch(
      { type: 'sendTurn', input: { threadId: 'parked', input: 'mine' } },
      { clientOrigin: operator },
    );
    await expect(automatic).rejects.toMatchObject(capacityRefusal);
    await waiting;
    expect(h.startsFor('parked')).toBe(0);
    await lease.release();
    expect(await person).toMatchObject({ turnId: 'turn-1' });
    expect(h.startsFor('parked')).toBe(1);
  });

  test("a person's Stop cancels the wait: no engine starts, no failure is recorded, and the wait clears", async () => {
    const h = await harness();
    await h.restoreDormant('parked');
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('parked', true);
    const turn = h.service.dispatch(
      { type: 'sendTurn', input: { threadId: 'parked', input: 'continue' } },
      { clientOrigin: operator },
    );
    const rejected = expect(turn).rejects.toMatchObject({
      message: new EngineStartCancelledError().message,
    });
    await waiting;
    const cleared = h.waitPublished('parked', false);
    expect(
      await h.service.dispatch({ type: 'interruptTurn', threadId: 'parked' }),
    ).toMatchObject({ outcome: 'pending-turn-start' });
    await rejected;
    await cleared;
    expect((await h.summary('parked'))?.engineStartWait).toBeUndefined();

    await lease.release();
    await settle();
    expect(h.startsFor('parked')).toBe(0);
    const methods = h.eventStore
      .listEvents('parked')
      .map((row) => row.payload.method);
    expect(methods).not.toContain('runtime.error');
    expect(h.eventStore.readSessionByThread('parked')?.status).toBe('ready');
  });

  test("a person's wait that times out is refused and its status clears", async () => {
    const h = await harness();
    await h.restoreDormant('parked');
    const lease = await h.holdStartLease();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const waiting = h.waitPublished('parked', true);
    const turn = h.service.dispatch(
      { type: 'sendTurn', input: { threadId: 'parked', input: 'continue' } },
      { clientOrigin: operator },
    );
    const rejected = expect(turn).rejects.toMatchObject(capacityRefusal);
    await waiting;
    const cleared = h.waitPublished('parked', false);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    await rejected;
    await cleared;
    expect((await h.summary('parked'))?.engineStartWait).toBeUndefined();
    expect(h.startsFor('parked')).toBe(0);
    await lease.release();
  });
  test("a person's Stop after admission but before the provider start still launches no engine", async () => {
    const h = await harness();
    await h.restoreDormant('parked', { project: true });
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('parked', true);
    const turn = h.service.dispatch(
      { type: 'sendTurn', input: { threadId: 'parked', input: 'continue' } },
      { clientOrigin: operator },
    );
    const outcome = turn.catch((error: unknown) => error);
    await waiting;
    const hold = h.holdWorkspaceAuthorization();
    const admitted = h.waitPublished('parked', false);
    await lease.release();
    await admitted;
    await hold.reached;
    await h.service.dispatch({ type: 'interruptTurn', threadId: 'parked' });
    hold.release();
    const result = await outcome;
    await settle();
    expect(h.startsFor('parked')).toBe(0);
    expect(result).toMatchObject({
      message: new EngineStartCancelledError().message,
    });
  });
});

describe('a credential-profile restart (#4568)', () => {
  async function liveSession(h: Awaited<ReturnType<typeof harness>>) {
    const started = await h.service.startSessionInternal(
      {
        type: 'start-session',
        input: { threadId: 'live', provider: 'claude' },
      },
      { userId: 'owner' },
      { resourceAdmissionIntent: 'interactive_user' },
    );
    expect(started.status).toBe('accepted');
    expect(h.startsFor('live')).toBe(1);
  }

  const restart = (
    h: Awaited<ReturnType<typeof harness>>,
    signal: AbortSignal,
    dispatchOrigin?: 'interactive' | 'automation',
  ) =>
    (
      h.service as unknown as {
        credentialProfileRecovery: {
          restartRecoverySession(input: unknown): Promise<{ turnId: string }>;
        };
      }
    ).credentialProfileRecovery.restartRecoverySession({
      threadId: 'live',
      input: 'retry',
      recoveryCorrelationId: 'credential-restart',
      signal,
      credentialProfileRef: 'backup',
      ...(dispatchOrigin ? { dispatchOrigin } : {}),
    });

  test("a restart of a person's turn waits, and its cancel never starts the provider", async () => {
    const h = await harness();
    await liveSession(h);
    const lease = await h.holdStartLease();
    const cancel = new AbortController();
    const waiting = h.waitPublished('live', true);
    const restarted = restart(h, cancel.signal, 'interactive');
    const rejected = expect(restarted).rejects.toThrow('recovery cancelled');
    await waiting;
    expect((await h.summary('live'))?.engineStartWait).toBeDefined();
    const cleared = h.waitPublished('live', false);
    cancel.abort(new Error('recovery cancelled'));
    await rejected;
    await cleared;
    expect((await h.summary('live'))?.engineStartWait).toBeUndefined();
    await lease.release();
    await settle();
    expect(h.startsFor('live')).toBe(1);
  });

  test("a restart of a person's turn continues once the slot settles", async () => {
    const h = await harness();
    await liveSession(h);
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('live', true);
    const restarted = restart(h, new AbortController().signal, 'interactive');
    await waiting;
    expect(h.startsFor('live')).toBe(1);
    await lease.release();
    expect(await restarted).toMatchObject({ turnId: 'turn-1' });
    expect(h.startsFor('live')).toBe(2);
  });

  test('a restart stopped after admission but before the provider start launches no engine', async () => {
    const h = await harness();
    await h.restoreDormant('live', { project: true });
    expect(
      await h.service.dispatch(
        { type: 'sendTurn', input: { threadId: 'live', input: 'first' } },
        { clientOrigin: operator },
      ),
    ).toMatchObject({ turnId: 'turn-1' });
    expect(h.startsFor('live')).toBe(1);
    const lease = await h.holdStartLease();
    const cancel = new AbortController();
    const waiting = h.waitPublished('live', true);
    const restarted = restart(h, cancel.signal, 'interactive');
    const outcome = restarted.catch((error: unknown) => error);
    await waiting;
    const hold = h.holdWorkspaceAuthorization();
    const admitted = h.waitPublished('live', false);
    await lease.release();
    await admitted;
    await hold.reached;
    await h.service.dispatch(
      { type: 'interruptTurn', threadId: 'live' },
      { userId: 'owner' },
    );
    hold.release();
    const result = await outcome;
    await settle();
    expect(h.startsFor('live')).toBe(1);
    expect(result).toMatchObject({
      message: new EngineStartCancelledError().message,
    });
  });

  test.each(['automation', undefined] as const)(
    'a restart of a %s turn keeps the immediate refusal',
    async (origin) => {
      const h = await harness();
      await liveSession(h);
      const lease = await h.holdStartLease();
      await expect(
        restart(h, new AbortController().signal, origin),
      ).rejects.toBeInstanceOf(ConcurrentEngineStartCapacityError);
      expect(h.startsFor('live')).toBe(1);
      expect((await h.summary('live'))?.engineStartWait).toBeUndefined();
      await lease.release();
    },
  );
});

describe("a brand-new chat's first start (#4568)", () => {
  test('waits behind a background start, publishes its wait only to its owner, and clears on admission', async () => {
    const h = await harness();
    h.service.initialize();
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('fresh', true);
    const start = h.freshStart('fresh');
    const published = await waiting;
    expect(published.frame).toEqual({
      threadId: 'fresh',
      wait: { since: expect.any(String) },
      pendingStart: true,
    });
    expect(published.canRead(reader('owner'))).toBe(true);
    expect(published.canRead(reader('stranger'))).toBe(false);
    // What a stream that opens now is sent first: only the owner sees it.
    expect(h.service.readableEngineStartWaits(reader('owner'))).toEqual([
      published.frame,
    ]);
    expect(h.service.readableEngineStartWaits(reader('stranger'))).toEqual([]);
    // Nothing pretends a Session exists before the start.
    expect(await h.summary('fresh')).toBeUndefined();
    await settle();
    expect(h.startsFor('fresh')).toBe(0);

    const cleared = h.waitPublished('fresh', false);
    await lease.release();
    expect((await cleared).canRead(reader('stranger'))).toBe(false);
    expect((await start).status).toBe('accepted');
    expect(h.startsFor('fresh')).toBe(1);
    expect(h.service.readableEngineStartWaits(reader('owner'))).toEqual([]);
  });

  test("its owner's Stop cancels the wait and no engine starts; another person's Stop is refused", async () => {
    const h = await harness();
    h.service.initialize();
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('fresh', true);
    const start = h.freshStart('fresh');
    await waiting;
    await expect(
      h.service.dispatch(
        { type: 'interruptTurn', threadId: 'fresh' },
        { userId: 'stranger' },
      ),
    ).rejects.toThrow('Session not found: fresh');
    expect(h.service.readableEngineStartWaits(reader('owner'))).toHaveLength(1);

    const cleared = h.waitPublished('fresh', false);
    await h.service.dispatch(
      { type: 'interruptTurn', threadId: 'fresh' },
      { userId: 'owner' },
    );
    expect(await start).toMatchObject({
      status: 'rejected',
      code: 'resource_engine_start_cancelled',
    });
    await cleared;
    await lease.release();
    await settle();
    expect(h.startsFor('fresh')).toBe(0);
    expect(h.service.readableEngineStartWaits(reader('owner'))).toEqual([]);
  });

  test('a wait that times out is refused and its wait clears', async () => {
    const h = await harness();
    h.service.initialize();
    const lease = await h.holdStartLease();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const waiting = h.waitPublished('fresh', true);
    const start = h.freshStart('fresh');
    await waiting;
    const cleared = h.waitPublished('fresh', false);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    expect(await start).toMatchObject({
      status: 'rejected',
      code: 'resource_engine_start_capacity',
    });
    await cleared;
    expect(h.startsFor('fresh')).toBe(0);
    expect(h.service.readableEngineStartWaits(reader('owner'))).toEqual([]);
    await lease.release();
  });

  test('a pending first start is isolated by both tenant and principal, including Stop', async () => {
    const h = await harness({ hosted: true });
    h.service.initialize();
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('fresh', true);
    const start = h.freshStart('fresh');
    await waiting;
    const scope = (userId: string, tenant: string) =>
      sessionReadAuthorityFromRequest(
        userId,
        { tenantId: tenantId(tenant) },
        h.registry,
      );
    expect(
      h.service.readableEngineStartWaits(scope('owner', 'alpha')),
    ).toHaveLength(1);
    expect(h.service.readableEngineStartWaits(scope('owner', 'bravo'))).toEqual(
      [],
    );
    expect(
      h.service.readableEngineStartWaits(scope('stranger', 'alpha')),
    ).toEqual([]);
    expect(h.service.readableEngineStartWaits(reader('owner'))).toEqual([]);
    await expect(
      h.service.dispatch(
        { type: 'interruptTurn', threadId: 'fresh' },
        {
          userId: 'owner',
          tenantExecutionContext: {
            tenantId: tenantId('bravo'),
            source: 'request',
          },
        },
      ),
    ).rejects.toThrow('Session not found');
    await h.service.dispatch(
      { type: 'interruptTurn', threadId: 'fresh' },
      {
        userId: 'owner',
        tenantExecutionContext: {
          tenantId: tenantId('alpha'),
          source: 'request',
        },
      },
    );
    expect(await start).toMatchObject({
      status: 'rejected',
      code: 'resource_engine_start_cancelled',
    });
    await lease.release();
    expect(h.startsFor('fresh')).toBe(0);
  });

  test('a provider-start failure leaves no capacity wait or pending-start identity', async () => {
    const h = await harness();
    h.service.initialize();
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('fresh', true);
    const start = h.freshStart('fresh');
    await waiting;
    vi.mocked(h.adapter.startSession).mockRejectedValueOnce(
      new Error('provider launch lost'),
    );
    const cleared = h.waitPublished('fresh', false);
    await lease.release();
    await cleared;
    expect(await start).toMatchObject({ status: 'indeterminate' });
    expect(h.startsFor('fresh')).toBe(1);
    expect(h.service.readableEngineStartWaits(reader('owner'))).toEqual([]);
  });

  test("its owner's Stop after admission but before the provider start launches no engine", async () => {
    const h = await harness();
    h.service.initialize();
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('fresh', true);
    const start = h.freshStart('fresh', 'owner', { project: true });
    await waiting;
    const hold = h.holdWorkspaceAuthorization();
    const admitted = h.waitPublished('fresh', false);
    await lease.release();
    await admitted;
    await hold.reached;
    expect(h.service.readableEngineStartWaits(reader('owner'))).toEqual([
      { threadId: 'fresh', wait: null, pendingStart: true },
    ]);
    await h.service.dispatch(
      { type: 'interruptTurn', threadId: 'fresh' },
      { userId: 'owner' },
    );
    hold.release();
    const result = await start;
    await settle();
    expect(h.startsFor('fresh')).toBe(0);
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'resource_engine_start_cancelled',
    });
  });
});
