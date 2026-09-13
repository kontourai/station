/**
 * station#1707 — A RUNTIME'S ATTACHMENT BARRIER BELONGS TO THAT RUNTIME.
 *
 * `session.attachment.settled` is a milestone receipt and carries no
 * publisher: production has one process and one boot, so there was never a
 * second runtime to distinguish. A test suite that builds a runtime per test
 * does not have that shape, and the barrier every such suite used — a receipt
 * wait keyed on that `kind` alone — resolves on whichever runtime settles
 * first.
 *
 * The observed failure that shape produces: under corpus load one test's wait
 * exceeds `waitForReceipt`'s timeout and is abandoned; its runtime settles a
 * moment later and publishes anyway; the NEXT test's wait is satisfied by
 * that stale receipt while its own runtime is still inside the
 * attachment fail-open window, so its transcript search reads through a gate
 * that has not opened and returns nothing. The red lands on an innocent test
 * as `expected [] to deeply equal [ '<thread>-owned' ]`, with the thread
 * varying by whichever test lost — which is why it read as a load flake
 * rather than a barrier defect.
 *
 * These tests await the accessors directly rather than through
 * `__test-utils__/session-runtime-barriers.ts`: their subject IS a barrier
 * staying pending, and those wrappers throw on exactly that.
 *
 * WHAT THIS FILE PINS, and it is one property: a runtime whose own recovery
 * is still in flight does not become settled because a DIFFERENT runtime
 * settled. The barrier is captured before the other runtime settles, exactly
 * as the real call sites capture theirs before `initialize()`, so a barrier
 * re-implemented over the receipt bus fails here rather than passing by
 * having subscribed too late to see the foreign publish.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { receiptBus } from '../../infra/receipt-bus.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const logger = { debug: () => {}, warn: () => {} };

/**
 * Minimal adapter. `hasSession` is the awaited seam recovery crosses once per
 * persisted session, which is what lets a test hold a runtime's recovery open
 * without stubbing the recovery pass itself.
 */
class BarrierAdapter implements ProviderAdapterShape {
  readonly provider = 'claude';
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'claude Runtime',
    description: 'claude adapter for the attachment-barrier tests',
    capabilities: ['agent-runtime'],
    engineId: engineId('claude'),
    builtin: true,
  };
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();

  constructor(private readonly gate?: Promise<void>) {}

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const now = new Date().toISOString();
    return {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
  }
  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    return { threadId: input.threadId, turnId: 'claude-turn' };
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async listSessions(): Promise<ProviderSession[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    await this.gate;
    return false;
  }
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
  async getPrerequisites() {
    return [];
  }
}

function createRegistry(
  adapters: ProviderAdapterShape[],
): IProviderAdapterRegistry {
  return {
    register() {},
    get: (provider) =>
      adapters.find((adapter) => adapter.provider === provider),
    list: () => adapters,
  };
}

/**
 * `settled` or `pending` for a barrier already captured. The losing arm is a
 * real timer rather than a microtask drain: a receipt-bus barrier resolves
 * from a synchronous publish on a later macrotask, and a microtask-only race
 * would report `pending` for it whether or not it was going to resolve.
 */
async function stateOf(barrier: Promise<void>): Promise<'settled' | 'pending'> {
  return Promise.race<'settled' | 'pending'>([
    barrier.then(() => 'settled' as const),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
}

describe('session attachment barrier (station#1707)', () => {
  let tmp: string;
  let eventStore: EventStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'attachment-barrier-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    // One persisted session, so recovery has something to cross the awaited
    // `hasSession` seam for. Without it the held runtime settles immediately
    // and the assertion below could not fail however the barrier is built.
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-persisted',
      status: 'ready',
      createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:01.000Z',
    });
  });

  afterEach(() => {
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
    receiptBus.resetForTest();
  });

  test('a runtime still recovering is not settled by another runtime settling', async () => {
    let releaseRecovery: () => void = () => {};
    const recoveryHeld = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const held = new OrchestrationService({
      adapterRegistry: createRegistry([new BarrierAdapter(recoveryHeld)]),
      eventBus: new EventBus(),
      eventStore,
      logger,
    });
    held.initialize();
    // Captured BEFORE the other runtime settles — the order every real call
    // site uses, and the order that makes a bus-backed barrier observable.
    const heldBarrier = held.whenSessionAttachmentSettled();

    const other = new OrchestrationService({
      adapterRegistry: createRegistry([new BarrierAdapter()]),
      eventBus: new EventBus(),
      eventStore,
      logger,
    });
    other.initialize();
    await other.whenSessionAttachmentSettled();

    // The process-wide milestone has now been published once. It says nothing
    // about `held`, whose recovery has not returned.
    expect(await stateOf(heldBarrier)).toBe('pending');

    releaseRecovery();
    await heldBarrier;
    expect(await stateOf(heldBarrier)).toBe('settled');

    await held.shutdown();
    await other.shutdown();
  });

  /**
   * `session.recovery.completed` has the same publisher-less shape, and it
   * fires EARLIER in the same chain, so a stale one is worse than a red: the
   * next test proceeds against a read model recovery has not populated and
   * passes vacuously. Its `threadIds` are not a substitute for a publisher —
   * they are the threads the pass RESTORED, and the receipt below names a
   * thread the held runtime's store has never heard of.
   */
  test('a runtime still recovering is not completed by another runtime completing', async () => {
    let releaseRecovery: () => void = () => {};
    const recoveryHeld = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const held = new OrchestrationService({
      adapterRegistry: createRegistry([new BarrierAdapter(recoveryHeld)]),
      eventBus: new EventBus(),
      eventStore,
      logger,
    });
    held.initialize();
    const heldBarrier = held.whenSessionRecoveryCompleted();

    // A separate store, so the other runtime's receipt carries a thread id
    // this one has never seen — the "stale receipt from a prior runtime"
    // case, at its most obviously foreign.
    const otherTmp = mkdtempSync(join(tmpdir(), 'attachment-barrier-other-'));
    const otherStore = new EventStore(join(otherTmp, 'orchestration.sqlite'));
    otherStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-belonging-to-the-other-runtime',
      status: 'ready',
      createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:01.000Z',
    });
    const other = new OrchestrationService({
      adapterRegistry: createRegistry([new BarrierAdapter()]),
      eventBus: new EventBus(),
      eventStore: otherStore,
      logger,
    });
    other.initialize();
    await other.whenSessionRecoveryCompleted();

    expect(await stateOf(heldBarrier)).toBe('pending');

    releaseRecovery();
    await heldBarrier;
    expect(await stateOf(heldBarrier)).toBe('settled');

    await held.shutdown();
    await other.shutdown();
    otherStore.close();
    rmSync(otherTmp, { recursive: true, force: true });
  });

  test('a runtime that never initializes never settles', async () => {
    const idle = new OrchestrationService({
      adapterRegistry: createRegistry([new BarrierAdapter()]),
      eventBus: new EventBus(),
      eventStore,
      logger,
    });
    const idleBarrier = idle.whenSessionAttachmentSettled();

    const other = new OrchestrationService({
      adapterRegistry: createRegistry([new BarrierAdapter()]),
      eventBus: new EventBus(),
      eventStore,
      logger,
    });
    other.initialize();
    await other.whenSessionAttachmentSettled();

    expect(await stateOf(idleBarrier)).toBe('pending');
    await other.shutdown();
  });
});
