import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();

test('an accepted start authorizes its first turn before adapter events arrive, only for its recorded owner', async () => {
  const store = new EventStore(
    join(makeTempDir('start-ownership-'), 'events.sqlite'),
  );
  // This adapter returns the Session without delivering a session.started event.
  const adapter = new GateTestAdapter();
  const send = vi.spyOn(adapter, 'sendTurn');
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  try {
    const started = await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          provider: 'claude',
          threadId: 'owned-start',
          metadata: { userId: 'owner' },
        },
      },
      { userId: 'owner' },
      {},
    );
    expect(started.status).toBe('accepted');
    const command = {
      type: 'sendTurn' as const,
      input: {
        threadId: 'owned-start',
        input: 'First turn',
        clientTurnId: 'first-turn',
      },
    };
    await expect(
      service.dispatchWithReceipt(command, { userId: 'other' }),
    ).rejects.toThrow('Session not found');
    expect(send).not.toHaveBeenCalled();
    await service.dispatchWithReceipt(command, { userId: 'owner' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.findSessionOwnerUserId('owned-start')).toBe('owner');
  } finally {
    await service.shutdown();
    store.close();
  }
});
