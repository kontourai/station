import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  TURN_INTERRUPTED_CONTINUE_PROMPT,
  turnInterruptedContinueClientTurnId,
} from '@kontourai/station-shared/runtime-event-projection';
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
import { foregroundMessageObjectSchema } from '../../../routes/orchestration/orchestration.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

/**
 * The chat's Continue after a restart interrupted a turn is an ordinary send
 * keyed on the interruption (`turnInterruptedContinueClientTurnId`). These
 * pin that the server's own turn deduplication, through a real EventStore,
 * admits it once per interruption, however many times it is sent.
 */
const makeTempDir = trackTempDirs();
const THREAD = 'interrupted-chat';

class CountingAdapter extends GateTestAdapter {
  readonly sends: ProviderSendTurnInput[] = [];
  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    this.sends.push(input);
    return { threadId: input.threadId, turnId: `turn-${this.sends.length}` };
  }
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function boot() {
  const store = new EventStore(
    join(makeTempDir('station-continue-interrupted-'), 'orchestration.sqlite'),
  );
  const adapter = new CountingAdapter();
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
  await service.dispatch({
    type: 'startSession',
    input: { threadId: THREAD, provider: 'claude' },
  });
  const continueTurn = (boundaryId: string) =>
    service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: THREAD,
        input: TURN_INTERRUPTED_CONTINUE_PROMPT,
        clientTurnId: turnInterruptedContinueClientTurnId(boundaryId),
      },
    }) as Promise<ProviderTurnStartResult>;
  return { adapter, continueTurn };
}

describe('Continue after a restart interrupted a turn', () => {
  test('a repeated Continue for one interruption starts one turn', async () => {
    const { adapter, continueTurn } = await boot();
    const boundaryId = `provider-turn-boundary:${randomUUID()}`;

    const first = await continueTurn(boundaryId);
    const again = await continueTurn(boundaryId);

    expect(adapter.sends).toHaveLength(1);
    expect(adapter.sends[0]?.input).toBe(TURN_INTERRUPTED_CONTINUE_PROMPT);
    // The repeat is answered with the turn the first one started.
    expect(again.turnId).toBe(first.turnId);
  });

  test('two taps racing each other still start one turn', async () => {
    const { adapter, continueTurn } = await boot();
    const boundaryId = `provider-turn-boundary:${randomUUID()}`;

    const [one, two] = await Promise.all([
      continueTurn(boundaryId),
      continueTurn(boundaryId),
    ]);

    expect(adapter.sends).toHaveLength(1);
    expect(two.turnId).toBe(one.turnId);
  });

  test('a later interruption gets its own Continue', async () => {
    const { adapter, continueTurn } = await boot();

    await continueTurn(`provider-turn-boundary:${randomUUID()}`);
    await continueTurn(`provider-turn-boundary:${randomUUID()}`);

    expect(adapter.sends).toHaveLength(2);
  });

  test('the key is one the chat send route accepts', () => {
    const clientTurnId = turnInterruptedContinueClientTurnId(
      `provider-turn-boundary:${randomUUID()}`,
    );
    expect(
      foregroundMessageObjectSchema.shape.clientTurnId.safeParse(clientTurnId)
        .success,
    ).toBe(true);
  });
});
