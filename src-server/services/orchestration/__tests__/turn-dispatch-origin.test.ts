import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import {
  type CanonicalRuntimeEvent,
  type TurnDispatchOrigin,
  turnDispatchOrigin,
} from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSendTurnInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

/**
 * #4512: the origin Station records on a turn's `turn.started`, written
 * through the real service pipeline into a real EventStore. The engine
 * reports each start from inside `sendTurn`, before Station has accepted
 * the send, which is the case a late-only stamp would miss.
 */
const makeTempDir = trackTempDirs();

class EarlyStartAdapter extends GateTestAdapter {
  /** What the engine itself claims; Station must not believe it. */
  claimedOrigin: string | undefined;
  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const turnId = `turn-${randomUUID()}`;
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      turnId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      ...(this.claimedOrigin ? { dispatchOrigin: this.claimedOrigin } : {}),
    } as CanonicalRuntimeEvent);
    return { threadId: input.threadId, turnId };
  }
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const origin = (actor: ClientOrigin['actor']): ClientOrigin => ({
  version: 1,
  actor,
  reported: { version: 1, surface: 'web', build: 'test' },
});

async function boot() {
  const store = new EventStore(
    join(makeTempDir('station-turn-origin-'), 'orchestration.sqlite'),
  );
  const adapter = new EarlyStartAdapter();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  open.push(async () => {
    await service.shutdown();
    adapter.events.close();
    store.close();
  });
  const send = async (
    context: Parameters<OrchestrationService['dispatch']>[1],
    dispatchOrigin?: TurnDispatchOrigin,
  ) => {
    const threadId = `thread-${randomUUID()}`;
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    const accepted = (await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId, input: 'work', clientTurnId: randomUUID() },
      },
      context,
      dispatchOrigin ? { dispatchOrigin } : undefined,
    )) as ProviderTurnStartResult;
    let started: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      started = store
        .listEventsByMethods(threadId, ['turn.started'])
        .map((event) => event.payload as unknown as Record<string, unknown>)
        .find((payload) => payload.turnId === accepted.turnId);
      expect(started).toBeDefined();
    });
    return started!;
  };
  return { adapter, send };
}

describe('turn dispatch origin (#4512)', () => {
  test("a server caller's classification is recorded, with no client origin to reserve the turn", async () => {
    const { send } = await boot();
    const started = await send(undefined, 'delegation');
    expect(started.dispatchOrigin).toBe('delegation');
  });

  test("a person's send is interactive; an operator and a paired device alike", async () => {
    const { send } = await boot();
    expect(
      (await send({ clientOrigin: origin({ kind: 'operator' }) }))
        .dispatchOrigin,
    ).toBe('interactive');
    expect(
      (
        await send({
          clientOrigin: origin({ kind: 'device', deviceId: 'phone' }),
        })
      ).dispatchOrigin,
    ).toBe('interactive');
  });

  test('an unclassified internal send reads as unknown, whatever the engine claims', async () => {
    const { adapter, send } = await boot();
    adapter.claimedOrigin = 'task-dispatch';
    const internal = await send({ clientOrigin: origin({ kind: 'internal' }) });
    expect(turnDispatchOrigin(internal)).toBe('unknown');
    const bare = await send(undefined);
    expect(turnDispatchOrigin(bare)).toBe('unknown');
  });
});
