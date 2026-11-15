import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
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
  private nextProcess = 1;

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

async function boot(
  options: {
    finishedSessionParkAfterMs?: number;
    idleSessionParkAfterMs?: number;
  } = {},
) {
  const store = new EventStore(
    join(makeTempDir('station-finished-park-'), 'orchestration.sqlite'),
  );
  const adapter = new EngineProcessAdapter();
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
      parentAgentSlug: 'lead',
      rootAgentSlug: 'lead',
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
