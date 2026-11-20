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
import { PORTABLE_EXECUTION_CONSENT_METADATA_KEY } from '@kontourai/station-contracts/provider';
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
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import {
  ConcurrentEngineStartCapacityError,
  createRuntimeResourcePostureController,
  EngineStartCancelledError,
  type RuntimeEngineStartIntent,
} from '../../infra/resource-posture.js';
import { ReceiverExecutionRefusal } from '../../projects/project-contribution-service.js';
import type { CredentialProfileStageOutcome } from '../credential-recovery-module.js';
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

async function harness(
  options: { hosted?: true; credentialRecovery?: true } = {},
) {
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
  let observedStarts = 0;
  vi.spyOn(adapter, 'startSession').mockImplementation(async (input) => {
    if (input.threadId === 'background') {
      backgroundEntered.release();
      await backgroundGate.promise;
    }
    const session = await original(input);
    if (options.credentialRecovery)
      adapter.events.push({
        method: 'session.started',
        eventId: `observed-start-${++observedStarts}`,
        provider: adapter.provider,
        threadId: input.threadId,
        sessionId: input.threadId,
        createdAt: session.createdAt,
        initialState: 'created',
        metadata: input.metadata,
      });
    return session;
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
  const resourcePosture = createRuntimeResourcePostureController();
  const profileStage = vi.fn(
    async (): Promise<CredentialProfileStageOutcome> => ({
      kind: 'staged',
      attempt: {
        candidateProfileRef: 'backup',
        capability: 'restart_resume',
        commit: async () => ({ kind: 'adopted' }),
        rollback: async () => ({ kind: 'rolled-back' }),
        inspect: async () => ({ kind: 'staged' }),
        acknowledge: async () => ({ kind: 'applied' }),
      },
    }),
  );
  if (options.credentialRecovery) {
    const provider: ProviderAdapterShape = adapter;
    provider.metadata.recovery = {
      sameSession: true,
      application: 'restart_resume',
    };
  }
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
    resourcePosture,
    ...(options.credentialRecovery
      ? { credentialProfileRecoveryAdapter: { stage: profileStage } }
      : {}),
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
    (
      await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE, {
        purpose: 'session-list',
        threadIds: [threadId],
      })
    ).find((session) => session.threadId === threadId);

  /** A session restored at boot with no engine: the parked/interrupted case. */
  const restoreDormant = async (
    threadId: string,
    options: { project?: true; portable?: true } = {},
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
        ...(options.portable
          ? {
              [PORTABLE_EXECUTION_CONSENT_METADATA_KEY]: {
                portableProjectId: 'prj_capacity',
                resourceId: 'git.example/capacity',
                localProjectId: PROJECT.id,
              },
            }
          : {}),
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
    cleanups.push(release.release);
    return { reached: reached.promise, release: release.release };
  };

  /** A person's brand-new chat: a first start no Session record answers for. */
  const freshStart = (
    threadId: string,
    userId = 'owner',
    options: { project?: true; clientTurnId?: string } = {},
  ) =>
    service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId,
          provider: 'claude',
          ...(options.project ? { cwd: projectRoot } : {}),
          metadata: {
            userId,
            ...(options.project ? { projectSlug: PROJECT.slug } : {}),
          },
        },
      },
      { ...ownerContext, userId },
      {
        resourceAdmissionIntent: 'interactive_user',
        pendingStartClientTurnId: options.clientTurnId,
      },
    );

  const commands = createOrchestrationRoutes(service, {
    eventBus,
    getUserId: () => 'owner',
    logger: { debug() {} },
  });
  const stop = (
    threadId: string,
    target: { turnId?: string; clientTurnId?: string } = {},
  ) =>
    commands.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'interruptTurn', threadId, ...target }),
    });
  const startsFor = (threadId: string) =>
    vi
      .mocked(adapter.startSession)
      .mock.calls.filter(([input]) => input.threadId === threadId).length;

  return {
    adapter,
    resourcePosture,
    profileStage,
    projectRoot,
    stop,
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
      ).rejects.toMatchObject({
        cause: expect.any(ConcurrentEngineStartCapacityError),
        sessionTouched: false,
      });
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

describe('review corrections at the engine-start owner boundary', () => {
  test('receiver withdrawal while capacity is held refuses the recovered provider start and retains its Session', async () => {
    const h = await harness();
    await h.restoreDormant('receiver', { project: true, portable: true });
    const retained = h.eventStore.readSessionByThread('receiver');
    expect(
      await h.service.authorizedConversationWorkspace('receiver'),
    ).toMatchObject({ cwd: h.projectRoot });
    let offered = true;
    const recheck = vi.fn(async () => {
      if (!offered)
        throw new ReceiverExecutionRefusal(
          'receiver_execution_not_offered',
          'Execution offer withdrawn',
        );
    });
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('receiver', true);
    const turn = h.service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId: 'receiver', input: 'continue', clientTurnId: 'B' },
      },
      { userId: 'owner', clientOrigin: operator },
      {
        receiverExecutionAdmission: {
          recheck,
          admitted: {
            threadId: 'receiver',
            projectSlug: PROJECT.slug,
            cwd: h.projectRoot,
            portableProjectId: 'prj_capacity',
            resourceId: 'git.example/capacity',
            localProjectId: PROJECT.id,
          },
        },
      },
    );
    const outcome = turn.catch((error: unknown) => error);
    await waiting;
    expect(recheck).toHaveBeenCalled();
    expect(
      recheck.mock.results.every((result) => result.type === 'return'),
    ).toBe(true);
    expect(h.startsFor('receiver')).toBe(0);
    offered = false;
    await lease.release();
    const result = await outcome;
    expect(h.startsFor('receiver')).toBe(0);
    expect(result).toMatchObject({ code: 'receiver_execution_not_offered' });
    expect(recheck.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.eventStore.readSessionByThread('receiver')).toEqual(retained);
    expect(
      h.eventStore
        .listEvents('receiver')
        .some((event) => event.payload.method === 'runtime.error'),
    ).toBe(false);
  });

  test.each([
    { clientTurnId: 'A' },
    { turnId: 'old-A' },
    { clientTurnId: 'B', turnId: 'old-A' },
  ])(
    'a delayed targeted Stop %j cannot cancel a cold follow-up owned by B',
    async (stale) => {
      const h = await harness();
      await h.restoreDormant('parked');
      const lease = await h.holdStartLease();
      const waiting = h.waitPublished('parked', true);
      const turn = h.service.dispatch(
        {
          type: 'sendTurn',
          input: { threadId: 'parked', input: 'B', clientTurnId: 'B' },
        },
        { clientOrigin: operator },
      );
      const outcome = turn.catch((error: unknown) => error);
      await waiting;
      expect((await h.stop('parked', stale)).status).toBe(200);
      expect((await h.summary('parked'))?.engineStartWait).toBeDefined();
      await lease.release();
      expect(await outcome).toMatchObject({ turnId: 'turn-1' });
      expect(h.startsFor('parked')).toBe(1);
    },
  );

  test.each(['fresh', 'respawn', 'restart'] as const)(
    'Stop retires never-settling post-admission %s preparation and releases its lease before late completion',
    async (kind) => {
      const h = await harness();
      const threadId =
        kind === 'fresh' ? 'fresh' : kind === 'respawn' ? 'parked' : 'live';
      if (kind !== 'fresh') await h.restoreDormant(threadId, { project: true });
      else h.service.initialize();
      if (kind === 'restart')
        await h.service.dispatch(
          { type: 'sendTurn', input: { threadId, input: 'first' } },
          { clientOrigin: operator },
        );
      const originalStarts = h.startsFor(threadId);
      const lease = await h.holdStartLease();
      const waiting = h.waitPublished(threadId, true);
      const operation =
        kind === 'fresh'
          ? h.freshStart(threadId, 'owner', {
              project: true,
              clientTurnId: 'B',
            })
          : kind === 'respawn'
            ? h.service.dispatch(
                {
                  type: 'sendTurn',
                  input: { threadId, input: 'B', clientTurnId: 'B' },
                },
                { clientOrigin: operator },
              )
            : (
                h.service as unknown as {
                  credentialProfileRecovery: import('../credential-profile-recovery.js').CredentialProfileRecovery;
                }
              ).credentialProfileRecovery.restartRecoverySession({
                threadId,
                input: 'B',
                signal: new AbortController().signal,
                recoveryCorrelationId: 'profile-B',
                credentialProfileRef: 'backup',
                dispatchOrigin: 'interactive',
                sourceTurnId: 'turn-B',
                sourceClientTurnId: 'B',
              });
      let settled = false;
      const outcome = operation.then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await waiting;
      const prep = h.holdWorkspaceAuthorization();
      await lease.release();
      await prep.reached;
      // Deliberately leave the real resolver promise pending across Stop and the next admission.
      expect((await h.stop(threadId)).status).toBe(200);
      const probe = await h.service.startSessionInternal(
        {
          type: 'start-session',
          input: { threadId: 'after-stop', provider: 'claude' },
        },
        { userId: 'owner' },
        { resourceAdmissionIntent: 'queued_background' },
      );
      expect(probe.status).toBe('accepted');
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(h.service.readableEngineStartWaits(reader('owner'))).toEqual([]);
      expect(h.startsFor(threadId)).toBe(originalStarts);
      await outcome;
      prep.release();
      await settle();
      expect(h.startsFor(threadId)).toBe(originalStarts);
    },
  );

  test('Stop after the adapter was invoked retains the lease and indeterminate provider custody', async () => {
    const h = await harness();
    h.service.initialize();
    const invoked = deferred();
    const provider = deferred();
    cleanups.push(provider.release);
    const original = h.adapter.startSession.bind(h.adapter);
    vi.mocked(h.adapter.startSession).mockImplementation(async (input) => {
      if (input.threadId === 'effect') {
        invoked.release();
        await provider.promise;
        throw new Error('provider response lost');
      }
      return original(input);
    });
    let settled = false;
    const start = h
      .freshStart('effect', 'owner', { clientTurnId: 'B' })
      .then((result) => {
        settled = true;
        return result;
      });
    await invoked.promise;
    expect((await h.stop('effect', { clientTurnId: 'B' })).status).toBe(200);
    expect(
      await h.service.startSessionInternal(
        {
          type: 'start-session',
          input: { threadId: 'probe', provider: 'claude' },
        },
        { userId: 'owner' },
        { resourceAdmissionIntent: 'queued_background' },
      ),
    ).toMatchObject({
      status: 'rejected',
      code: 'resource_engine_start_capacity',
    });
    expect(settled).toBe(false);
    provider.release();
    expect(await start).toMatchObject({ status: 'indeterminate' });
  });

  async function beginRecordedProfileRecovery(
    intent: RuntimeEngineStartIntent,
  ) {
    const h = await harness({ credentialRecovery: true });
    h.service.initialize();
    expect(await h.freshStart('live')).toMatchObject({ status: 'accepted' });
    await vi.waitFor(async () => {
      expect(h.eventStore.findSessionOwnerUserId('live')).toBe('owner');
      expect(
        (await h.service.readSession('live', reader('owner')))?.session
          .threadId,
      ).toBe('live');
    });
    expect(await h.service.readSession('live', reader('stranger'))).toBeNull();
    vi.spyOn(h.adapter, 'sendTurn').mockImplementation(async (input) => {
      h.adapter.events.push({
        method: 'turn.started',
        eventId: 'source-B',
        provider: 'claude',
        threadId: 'live',
        turnId: 'turn-B',
        createdAt: new Date().toISOString(),
        prompt: input.input,
        invocationId: input.invocationId,
        resourceAdmissionIntent: 'interactive_user',
      });
      return { threadId: 'live', turnId: 'turn-B' };
    });
    await h.service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId: 'live', input: 'source B', clientTurnId: 'B' },
      },
      { userId: 'owner', clientOrigin: operator },
      { resourceAdmissionIntent: intent },
    );
    await vi.waitFor(() =>
      expect(
        h.eventStore.latestEventByMethod('live', 'turn.started')?.payload,
      ).toMatchObject({
        turnId: 'turn-B',
        invocationId: expect.any(String),
        clientTurnId: 'B',
        dispatchOrigin: 'interactive',
        resourceAdmissionIntent: intent,
      }),
    );
    const lease = await h.holdStartLease();
    const reserve = vi.spyOn(h.resourcePosture, 'reserveEngineStart');
    const waiting = h.waitPublished('live', true);
    const source = h.eventStore.latestEventByMethod(
      'live',
      'turn.started',
    )?.payload;
    if (source?.method !== 'turn.started' || !source.invocationId)
      throw new Error('Recovery fixture has no observed source invocation');
    h.adapter.events.push({
      eventId: 'account-failure-B',
      provider: 'claude',
      threadId: 'live',
      turnId: 'turn-B',
      invocationId: source.invocationId,
      method: 'runtime.error',
      severity: 'error',
      createdAt: new Date().toISOString(),
      message: 'account capacity exhausted',
      details: { scope: 'account', retryAfterMs: 0 },
    });
    return { h, lease, reserve, waiting };
  }

  test('an automatic source with interactive attribution keeps retryable background refusal during credential recovery', async () => {
    const { h, lease, reserve } =
      await beginRecordedProfileRecovery('queued_background');
    await vi.waitFor(() => expect(h.profileStage).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(
        reserve.mock.results.some((result) => result.type === 'throw') ||
          h.frames.some(
            ({ frame }) => frame.threadId === 'live' && frame.wait !== null,
          ),
      ).toBe(true),
    );
    expect(
      h.frames.filter(
        ({ frame }) => frame.threadId === 'live' && frame.wait !== null,
      ),
    ).toEqual([]);
    expect(
      reserve.mock.results.find((result) => result.type === 'throw')?.value,
    ).toMatchObject({
      code: 'resource_engine_start_capacity',
      retryable: true,
    });
    expect(h.startsFor('live')).toBe(1);
    await lease.release();
  });

  test('a delayed Stop for source A cannot cancel the credential restart of recorded source B', async () => {
    const { h, lease, waiting } =
      await beginRecordedProfileRecovery('interactive_user');
    await waiting;
    expect(h.profileStage).toHaveBeenCalled();
    expect(
      (await h.stop('live', { turnId: 'turn-A', clientTurnId: 'A' })).status,
    ).toBe(200);
    expect((await h.summary('live'))?.engineStartWait).toBeDefined();
    expect(h.startsFor('live')).toBe(1);
    expect(
      (await h.stop('live', { turnId: 'turn-B', clientTurnId: 'B' })).status,
    ).toBe(200);
    await vi.waitFor(async () =>
      expect((await h.summary('live'))?.engineStartWait).toBeUndefined(),
    );
    await lease.release();
    expect(h.startsFor('live')).toBe(1);
  });
});
