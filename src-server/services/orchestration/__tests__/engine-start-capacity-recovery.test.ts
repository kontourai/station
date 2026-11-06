/**
 * #4568: person-first engine-start capacity for the starts an existing
 * Session needs — a cold follow-up's respawn and a credential-profile
 * restart — through the real OrchestrationService, a real EventStore and the
 * real start-lease controller. The status assertions read the Session's
 * published summary, the projection the composer renders.
 */
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
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
import { OrchestrationService } from '../orchestration-service.js';

const operator: ClientOrigin = {
  version: 1,
  actor: { kind: 'operator' },
  reported: { version: 1, surface: 'web', build: '1' },
};

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
});

async function harness(options: { engineStartWaitMs?: number } = {}) {
  const tmp = makeTempDir('engine-start-recovery-');
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
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus,
    eventStore,
    resourcePosture: createRuntimeResourcePostureController(
      options.engineStartWaitMs !== undefined
        ? { engineStartWaitMs: options.engineStartWaitMs }
        : {},
    ),
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  cleanups.push(async () => {
    backgroundGate.release();
    await service.shutdown();
  });

  /**
   * Resolves on the projection change the composer refreshes from, published
   * for `threadId` once its capacity wait is `present` (or gone). Other
   * projection changes for the thread (turn progress) do not count.
   */
  const waitPublished = (threadId: string, present: boolean) =>
    new Promise<void>((resolve) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.event ===
            SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED &&
          (event.data as { threadId?: unknown } | undefined)?.threadId ===
            threadId &&
          (
            service as unknown as { engineStartWaits: Map<string, unknown> }
          ).engineStartWaits.has(threadId) === present
        ) {
          unsubscribe();
          resolve();
        }
      });
    });

  const summary = async (threadId: string) =>
    (await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE)).find(
      (session) => session.threadId === threadId,
    );

  /** A session restored at boot with no engine: the parked/interrupted case. */
  const restoreDormant = async (threadId: string) => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      resumeCursor: { cursor: `resume-${threadId}` },
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:05.000Z',
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
      { userId: 'owner' },
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

  const startsFor = (threadId: string) =>
    vi
      .mocked(adapter.startSession)
      .mock.calls.filter(([input]) => input.threadId === threadId).length;

  return {
    adapter,
    eventStore,
    service,
    waitPublished,
    summary,
    restoreDormant,
    holdStartLease,
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
    const h = await harness({ engineStartWaitMs: 25 });
    await h.restoreDormant('parked');
    const lease = await h.holdStartLease();
    const waiting = h.waitPublished('parked', true);
    const turn = h.service.dispatch(
      { type: 'sendTurn', input: { threadId: 'parked', input: 'continue' } },
      { clientOrigin: operator },
    );
    const rejected = expect(turn).rejects.toMatchObject(capacityRefusal);
    await waiting;
    const cleared = h.waitPublished('parked', false);
    await rejected;
    await cleared;
    expect((await h.summary('parked'))?.engineStartWait).toBeUndefined();
    expect(h.startsFor('parked')).toBe(0);
    await lease.release();
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
