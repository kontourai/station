import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import { STEERING_ENGINE_DURABILITY } from '@kontourai/station-contracts/engine-capability-matrix';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type {
  CanonicalRuntimeEvent,
  TurnDispatchOrigin,
} from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { DELEGATION_RESULT_CLIENT_ORIGIN } from '../delegation-result-delivery.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

/**
 * A finished-by-design Session (its turn came from a delegation, an
 * Automation or a Task wake) releases its engine shortly after that turn
 * settles instead of after the 30-minute idle park, unless something is
 * still pending on it; the next send restarts the engine in place from its
 * resume cursor. Driven through the real service and EventStore; the
 * engine's process handle is the adapter's own record.
 */
const makeTempDir = trackTempDirs();

/** Grace used throughout; the service adds its own timer slack. */
const GRACE_MS = 40;
/** Long enough for any early park this suite could schedule to have run. */
const SETTLED_WAIT_MS = 900;

interface EngineProcess {
  readonly id: number;
  readonly resumedFrom: string | undefined;
  released: boolean;
}

/**
 * One engine "process" per live Session, started by `startSession` and
 * released only by `stopSession`, which — like every real adapter — then
 * reports the engine's exit. Each start gets a resumable cursor naming the
 * native conversation, and a start given that cursor resumes it.
 */
class EngineProcessAdapter extends GateTestAdapter {
  readonly processes = new Map<string, EngineProcess>();
  readonly started: EngineProcess[] = [];
  readonly stopped: string[] = [];
  readonly sent: Array<{ threadId: string; processId: number }> = [];
  /** Each turn's invocation, which its terminal reports as the engine's does. */
  readonly invocations = new Map<string, string>();
  openWork = new Set<string>();
  /** What the engine says keeps it from the finished-session park only. */
  earlyParkRefusals = new Map<string, string>();
  private nextProcess = 1;

  /**
   * `reportsAllOpenWork: false` is an engine like Codex today: resumable, but
   * its adapter cannot tell which of its processes outlive a turn.
   */
  constructor(readonly reportsAllOpenWork = true) {
    super();
    // An engine that takes input mid-turn, as Claude does.
    Object.assign(this.metadata, { durability: STEERING_ENGINE_DURABILITY });
    if (reportsAllOpenWork)
      Object.assign(this.metadata, { openEngineWork: 'complete' });
  }

  override async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const cursor = input.resumeCursor as { claudeSessionId?: string } | null;
    const resumedFrom = cursor?.claudeSessionId;
    const engine: EngineProcess = {
      id: this.nextProcess++,
      resumedFrom,
      released: false,
    };
    this.processes.set(input.threadId, engine);
    this.started.push(engine);
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      resumeCursor: {
        claudeSessionId: resumedFrom ?? `native-${input.threadId}`,
      },
      createdAt: now,
      updatedAt: now,
    };
    // Like the real adapter, the start is announced with the session.
    this.push(input.threadId, {
      method: 'session.started',
      session,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return session;
  }

  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const engine = this.processes.get(input.threadId);
    if (!engine || engine.released)
      throw new Error(`no live engine for ${input.threadId}`);
    this.sent.push({ threadId: input.threadId, processId: engine.id });
    const turnId = `turn-${randomUUID()}`;
    if (input.invocationId) this.invocations.set(turnId, input.invocationId);
    this.push(input.threadId, {
      method: 'turn.started',
      turnId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    });
    return { threadId: input.threadId, turnId };
  }

  override async stopSession(threadId: string): Promise<void> {
    const engine = this.processes.get(threadId);
    if (!engine) return;
    engine.released = true;
    this.processes.delete(threadId);
    this.stopped.push(threadId);
    this.push(threadId, { method: 'session.exited', reason: 'stopped' });
  }

  override async hasSession(threadId: string): Promise<boolean> {
    return this.processes.has(threadId);
  }

  hasOpenEngineWork(threadId: string): boolean {
    return this.openWork.has(threadId);
  }

  /** A steer lands in the running turn, reported as the engine does. */
  async steerTurn(threadId: string, input: string, turnId: string) {
    this.push(threadId, {
      method: 'turn.started',
      turnId,
      inputKind: 'steer',
      prompt: input,
    });
  }

  earlyParkRefusal(threadId: string): string | undefined {
    return this.earlyParkRefusals.get(threadId);
  }

  /** Ends the thread's turn the way an engine reports a failed one. */
  failTurn(threadId: string, turnId: string): void {
    this.push(threadId, { method: 'turn.started', turnId, prompt: 'work' });
    this.push(threadId, {
      method: 'runtime.error',
      turnId,
      severity: 'error',
      code: 'engine-turn-failed',
      retriable: false,
      message: 'limit reached',
    });
  }

  /**
   * A turn Station never classified, as every turn recorded before
   * `dispatchOrigin` existed reads: the engine reports it with no send.
   */
  async runUnclassifiedTurn(
    threadId: string,
    opened: 'by-a-send' | 'by-the-engine' = 'by-a-send',
  ): Promise<void> {
    const turnId = `turn-${randomUUID()}`;
    // An engine-opened turn (a background task's result) says so.
    const metadata =
      opened === 'by-the-engine' ? { metadata: { trigger: 'provider' } } : {};
    this.push(threadId, {
      method: 'turn.started',
      turnId,
      prompt: 'hello',
      ...metadata,
    });
    this.push(threadId, {
      method: 'turn.completed',
      turnId,
      finishReason: 'stop',
      ...metadata,
    });
  }

  push(threadId: string, event: Record<string, unknown>): void {
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId,
      sessionId: threadId,
      createdAt: new Date().toISOString(),
      ...event,
    } as CanonicalRuntimeEvent);
  }
}

const OWNER = { userId: 'owner-user' };

const person: ClientOrigin = {
  version: 1,
  actor: { kind: 'operator' },
  reported: { version: 1, surface: 'web', build: 'test' },
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function boot({
  reportsAllOpenWork = true,
  ...options
}: {
  finishedSessionParkAfterMs?: number;
  idleSessionParkAfterMs?: number;
  reportsAllOpenWork?: boolean;
} = {}) {
  const store = new EventStore(
    join(makeTempDir('station-finished-park-'), 'orchestration.sqlite'),
  );
  const adapter = new EngineProcessAdapter(reportsAllOpenWork);
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
    finishedSessionParkAfterMs: GRACE_MS,
    // The sweep never runs on its own here; only the early park can act.
    idleSessionSweepMs: 3_600_000,
    ...options,
  });
  open.push(async () => {
    await service.shutdown();
    adapter.events.close();
    store.close();
  });
  const lifecycle = async (threadId: string) =>
    (await service.readSession(threadId, INTERNAL_SESSION_READ_SCOPE))?.session
      .lifecycleState;

  /** Starts a Session and runs one turn of the given origin to completion. */
  const runTurn = async (
    threadId: string,
    origin: TurnDispatchOrigin | 'person',
  ) => {
    const accepted = (await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId, input: 'work', clientTurnId: randomUUID() },
      },
      origin === 'person' ? { ...OWNER, clientOrigin: person } : OWNER,
      origin === 'person' ? undefined : { dispatchOrigin: origin },
    )) as ProviderTurnStartResult;
    await vi.waitFor(async () =>
      expect(await lifecycle(threadId)).toBe('running'),
    );
    const invocationId = adapter.invocations.get(accepted.turnId);
    adapter.push(threadId, {
      method: 'turn.completed',
      turnId: accepted.turnId,
      ...(invocationId ? { invocationId } : {}),
      finishReason: 'stop',
    });
    await vi.waitFor(async () =>
      expect(await lifecycle(threadId)).toBe('idle'),
    );
    return accepted;
  };
  const start = async (threadId = `thread-${randomUUID()}`) => {
    await service.dispatch(
      {
        type: 'startSession',
        input: { threadId, provider: 'claude', metadata: { ...OWNER } },
      },
      OWNER,
    );
    return threadId;
  };
  /**
   * A child the delegation route started: its context, and the provenance
   * stamp the route adds when Station derived that context from its caller.
   */
  const startDelegatedChild = async (
    provenance: 'caller-derived' | 'direct-claim',
  ) => {
    const parentSessionId = await start(`parent-${randomUUID()}`);
    const threadId = `child-${randomUUID()}`;
    const context: AgentDelegationContext = {
      mode: 'isolated-child',
      depth: 1,
      maxDepth: 3,
      parentAgentSlug: agentId('lead'),
      rootAgentSlug: agentId('lead'),
      parentSessionId,
    };
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId,
          provider: 'claude',
          metadata: { ...OWNER, delegation: context },
        },
      },
      OWNER,
      { delegationProvenance: { context, provenance } },
    );
    return threadId;
  };
  return {
    adapter,
    service,
    store,
    lifecycle,
    runTurn,
    start,
    startDelegatedChild,
  };
}

describe('finished-by-design Sessions release their engine early', () => {
  test('a delegated run that finishes has its engine released, and a later send resumes it in place', async () => {
    const { adapter, store, lifecycle, runTurn, start, service } = await boot();
    const threadId = await start();
    const first = adapter.processes.get(threadId);
    expect(first?.released).toBe(false);

    await runTurn(threadId, 'delegation');
    await vi.waitFor(() => expect(first?.released).toBe(true), {
      timeout: 5_000,
    });
    expect(adapter.stopped).toEqual([threadId]);

    // A park, not an ending: the exit is absorbed and the Session rests.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      store
        .listEvents(threadId)
        .some((event) => event.payload.method === 'session.exited'),
    ).toBe(false);
    expect(await lifecycle(threadId)).toBe('idle');
    expect(
      (await service.readSession(threadId, INTERNAL_SESSION_READ_SCOPE))
        ?.session.status,
    ).not.toBe('closed');

    // The delegator's follow-up restarts the same Session from its cursor
    // and lands on the new engine, not the released one.
    await runTurn(threadId, 'delegation');
    expect(adapter.started).toHaveLength(2);
    const resumed = adapter.started[1];
    expect(resumed?.resumedFrom).toBe(`native-${threadId}`);
    expect(adapter.sent.map((send) => send.processId)).toEqual([
      first?.id,
      resumed?.id,
    ]);
  });

  test('an Automation run and a Task wake are finished by design too', async () => {
    const { adapter, runTurn, start } = await boot();
    const automation = await start();
    const taskWake = await start();
    await runTurn(automation, 'automation');
    await runTurn(taskWake, 'task-dispatch');
    await vi.waitFor(
      () =>
        expect(adapter.stopped.sort()).toEqual([automation, taskWake].sort()),
      { timeout: 5_000 },
    );
  });

  test('a delegated child its agent follows up is released again after each follow-up', async () => {
    const { adapter, runTurn, startDelegatedChild } = await boot();
    const threadId = await startDelegatedChild('caller-derived');
    await runTurn(threadId, 'delegation');
    await vi.waitFor(() => expect(adapter.stopped).toEqual([threadId]), {
      timeout: 5_000,
    });
    // The delegator's `continue_task` records no origin of its own.
    await runTurn(threadId, 'unknown');
    await vi.waitFor(
      () => expect(adapter.stopped).toEqual([threadId, threadId]),
      { timeout: 5_000 },
    );
  });

  test('an unclassified turn into a child only its requester called delegated keeps its engine', async () => {
    const { adapter, runTurn, startDelegatedChild } = await boot();
    const threadId = await startDelegatedChild('direct-claim');
    await runTurn(threadId, 'unknown');
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(adapter.stopped).toEqual([]);
  });

  test("a person's own turn keeps its engine for the idle park", async () => {
    const { adapter, runTurn, start } = await boot();
    const personal = await start();
    const unclassified = await start();
    await runTurn(personal, 'person');
    await runTurn(unclassified, 'unknown');
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(adapter.stopped).toEqual([]);
    expect(adapter.processes.get(personal)?.released).toBe(false);
  });

  test('a person taking over a delegated Session inside the grace keeps its engine', async () => {
    const { adapter, runTurn, start } = await boot();
    const threadId = await start();
    await runTurn(threadId, 'delegation');
    await runTurn(threadId, 'person');
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(adapter.stopped).toEqual([]);
  });

  test('an engine whose adapter cannot report all of its open work is left to the idle park', async () => {
    const { adapter, runTurn, start } = await boot({
      reportsAllOpenWork: false,
    });
    const threadId = await start();
    await runTurn(threadId, 'delegation');
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(adapter.stopped).toEqual([]);
  });

  test('an engine that refuses the early park keeps its engine', async () => {
    const { adapter, runTurn, start } = await boot();
    const threadId = await start();
    adapter.earlyParkRefusals.set(
      threadId,
      'its scheduled wakeups are unknown',
    );
    await runTurn(threadId, 'delegation');
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(adapter.stopped).toEqual([]);
  });

  // #2540 delta review P1: what refuses the early park must never hold an
  // engine the recovery replay or the idle park would stop — a Claude engine
  // whose failed turn left its wakeups unknown refuses sends, and only a
  // park-and-restart recovers it.
  test("a failed turn's recovery replay restarts an engine that refuses the early park", async () => {
    const { adapter, service, start } = await boot();
    const threadId = await start();
    adapter.earlyParkRefusals.set(
      threadId,
      'its scheduled wakeups are unknown',
    );
    adapter.failTurn(threadId, 'failed-turn');
    await vi.waitFor(() =>
      expect(
        (
          service as unknown as {
            sessionReadModel: Map<string, { status: string }>;
          }
        ).sessionReadModel.get(threadId)?.status,
      ).toBe('error'),
    );
    const startsBefore = adapter.started.length;
    await (
      service as unknown as {
        credentialProfileRecovery: {
          createDispatchAdapter(): {
            dispatch(input: unknown): Promise<unknown>;
          };
        };
      }
    ).credentialProfileRecovery
      .createDispatchAdapter()
      .dispatch({
        intent: { provider: 'claude', threadId },
        replay: {
          threadId,
          input: 'work',
          recoveryCorrelationId: 'replay-after-failure',
          signal: new AbortController().signal,
        },
      });
    expect(adapter.stopped).toEqual([threadId]);
    expect(adapter.started.length).toBe(startsBefore + 1);
    expect(adapter.sent.at(-1)?.processId).toBe(adapter.started.at(-1)?.id);
  });

  test('the idle park still parks an engine that refuses the early park', async () => {
    const { adapter, runTurn, service, start } = await boot({
      idleSessionParkAfterMs: 60_000,
    });
    const threadId = await start();
    adapter.earlyParkRefusals.set(threadId, 'a scheduled wakeup');
    await runTurn(threadId, 'delegation');
    await expect(
      service.sweepIdleSessions(Date.now() + 120_000),
    ).resolves.toEqual([threadId]);
    expect(adapter.stopped).toEqual([threadId]);
  });

  test('a delegated run a steer reached keeps its engine', async () => {
    const { adapter, lifecycle, service, start } = await boot();
    const threadId = await start();
    const accepted = (await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId, input: 'work', clientTurnId: randomUUID() },
      },
      OWNER,
      { dispatchOrigin: 'delegation' },
    )) as ProviderTurnStartResult;
    await vi.waitFor(async () =>
      expect(await lifecycle(threadId)).toBe('running'),
    );
    // A steer with no mark of who sent it: Station stamps it with its
    // turn's origin, so it reads `delegation` though anyone may have sent it.
    adapter.push(threadId, {
      method: 'turn.started',
      turnId: accepted.turnId,
      inputKind: 'steer',
      prompt: 'also check the tests',
    });
    adapter.push(threadId, {
      method: 'turn.completed',
      turnId: accepted.turnId,
      invocationId: adapter.invocations.get(accepted.turnId),
      finishReason: 'stop',
    });
    await vi.waitFor(async () =>
      expect(await lifecycle(threadId)).toBe('idle'),
    );
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(adapter.stopped).toEqual([]);
  });

  /**
   * Starts a delegated turn, steers it the way `origin` does through the
   * service's own steer command, and completes it.
   */
  const steeredDelegatedRun = async (
    booted: Awaited<ReturnType<typeof boot>>,
    origin: ClientOrigin,
  ) => {
    const { adapter, lifecycle, service, start } = booted;
    const threadId = await start();
    const accepted = (await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId, input: 'work', clientTurnId: randomUUID() },
      },
      OWNER,
      { dispatchOrigin: 'delegation' },
    )) as ProviderTurnStartResult;
    await vi.waitFor(async () =>
      expect(await lifecycle(threadId)).toBe('running'),
    );
    const steered = (await service.dispatch(
      {
        type: 'steerTurn',
        threadId,
        input: 'more context',
        clientInputId: randomUUID(),
      },
      { ...OWNER, clientOrigin: origin },
    )) as { outcome?: string };
    expect(steered.outcome).toBe('steered');
    adapter.push(threadId, {
      method: 'turn.completed',
      turnId: accepted.turnId,
      invocationId: adapter.invocations.get(accepted.turnId),
      finishReason: 'stop',
    });
    await vi.waitFor(async () =>
      expect(await lifecycle(threadId)).toBe('idle'),
    );
    return threadId;
  };

  // #2540 delta review 2 P3: a child's result Station steered into a
  // delegated parent is Station's own input, so the parent still qualifies.
  test("a delegated parent its child's result was steered into is still released", async () => {
    const booted = await boot();
    const threadId = await steeredDelegatedRun(booted, {
      ...DELEGATION_RESULT_CLIENT_ORIGIN,
      sender: { kind: 'delegation-result', sessionId: 'child-session' },
    });
    await vi.waitFor(() => expect(booted.adapter.stopped).toEqual([threadId]), {
      timeout: 5_000,
    });
  });

  test("a person's steer into a delegated run keeps its engine", async () => {
    const booted = await boot();
    await steeredDelegatedRun(booted, person);
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(booted.adapter.stopped).toEqual([]);
  });

  test('a steer that only claims to be a result keeps its engine', async () => {
    const booted = await boot();
    // The sender without Station's internal actor: not Station's own input.
    await steeredDelegatedRun(booted, {
      ...person,
      sender: { kind: 'delegation-result', sessionId: 'child-session' },
    });
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(booted.adapter.stopped).toEqual([]);
  });

  test('a chat whose earlier turns predate the origin record keeps its engine', async () => {
    const { adapter, lifecycle, runTurn, start } = await boot();
    const threadId = await start();
    // A person's turn from before Station recorded who sent it.
    await adapter.runUnclassifiedTurn(threadId);
    await vi.waitFor(async () =>
      expect(await lifecycle(threadId)).toBe('idle'),
    );
    await runTurn(threadId, 'automation');
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(adapter.stopped).toEqual([]);
  });

  test('a turn the engine opened on its own does not count as a person sending', async () => {
    const { adapter, runTurn, start } = await boot();
    const threadId = await start();
    await runTurn(threadId, 'delegation');
    await vi.waitFor(() => expect(adapter.stopped).toEqual([threadId]), {
      timeout: 5_000,
    });
    // Restarted by the delegator's next turn; then the engine opens one.
    await runTurn(threadId, 'delegation');
    await adapter.runUnclassifiedTurn(threadId, 'by-the-engine');
    await vi.waitFor(
      () => expect(adapter.stopped).toEqual([threadId, threadId]),
      { timeout: 5_000 },
    );
  });

  test("an Automation run queued into a person's chat keeps its engine", async () => {
    const { adapter, runTurn, start } = await boot();
    const threadId = await start();
    await runTurn(threadId, 'person');
    await runTurn(threadId, 'automation');
    await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
    expect(adapter.stopped).toEqual([]);
  });

  describe('pending work keeps the engine of a finished delegated run', () => {
    test('an open request', async () => {
      const { adapter, lifecycle, runTurn, start } = await boot();
      const threadId = await start();
      await runTurn(threadId, 'delegation');
      adapter.push(threadId, {
        method: 'request.opened',
        requestId: 'request-1',
        requestType: 'approval',
      });
      await vi.waitFor(async () =>
        expect(await lifecycle(threadId)).toBe('review_pending'),
      );
      await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
      expect(adapter.stopped).toEqual([]);
    });

    test('child work the engine reports running', async () => {
      const { adapter, runTurn, start } = await boot();
      const threadId = await start();
      await runTurn(threadId, 'delegation');
      const subagent = {
        producer: 'engine-subagent' as const,
        reporterThreadId: threadId,
      };
      adapter.push(threadId, {
        method: 'child-work.updated',
        delta: {
          kind: 'snapshot',
          ...subagent,
          running: [{ ...subagent, childId: 'task-1', status: 'running' }],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
      expect(adapter.stopped).toEqual([]);
    });

    test('a background task the engine has not ended', async () => {
      const { adapter, runTurn, start } = await boot();
      const threadId = await start();
      adapter.openWork.add(threadId);
      await runTurn(threadId, 'delegation');
      await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
      expect(adapter.stopped).toEqual([]);
    });

    test('engine activity after the turn settled restarts the grace', async () => {
      const grace = 2_000;
      const { adapter, runTurn, start } = await boot({
        finishedSessionParkAfterMs: grace,
      });
      const threadId = await start();
      await runTurn(threadId, 'delegation');
      const settledAt = Date.now();
      // Halfway through the grace, a backgrounded subagent reports progress.
      await new Promise((resolve) => setTimeout(resolve, grace / 2));
      adapter.push(threadId, {
        method: 'tool.progress',
        itemId: 'toolu-subagent',
        toolCallId: 'toolu-subagent',
        message: 'still committing',
      });
      // Past when a park counted from the settle would have run, well before
      // one counted from that progress can.
      await new Promise((resolve) =>
        setTimeout(resolve, settledAt + grace * 1.5 - Date.now()),
      );
      expect(adapter.stopped).toEqual([]);
      // Quiet for a whole grace since: released.
      await vi.waitFor(() => expect(adapter.stopped).toEqual([threadId]), {
        timeout: grace * 2,
      });
    });

    test('engine activity dated past the grace', async () => {
      const { adapter, runTurn, start } = await boot({
        finishedSessionParkAfterMs: 400,
      });
      const threadId = await start();
      await runTurn(threadId, 'delegation');
      adapter.push(threadId, {
        method: 'tool.progress',
        itemId: 'toolu-subagent',
        toolCallId: 'toolu-subagent',
        message: 'still committing',
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await new Promise((resolve) =>
        setTimeout(resolve, SETTLED_WAIT_MS + 400),
      );
      expect(adapter.stopped).toEqual([]);
    });
  });

  test('turning early parking off, or parking off altogether, keeps the engine', async () => {
    for (const options of [
      { finishedSessionParkAfterMs: 0 },
      { idleSessionParkAfterMs: 0 },
    ]) {
      const { adapter, runTurn, start } = await boot(options);
      const threadId = await start();
      await runTurn(threadId, 'delegation');
      await new Promise((resolve) => setTimeout(resolve, SETTLED_WAIT_MS));
      expect(adapter.stopped, JSON.stringify(options)).toEqual([]);
    }
  });
});
