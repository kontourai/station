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

test.each(['delayed events', 'confirmed configuration'])(
  'an accepted start authorizes only its owner and preserves adapter configuration (%s)',
  async (ordering) => {
    const store = new EventStore(
      join(makeTempDir('start-ownership-'), 'events.sqlite'),
    );
    const adapter = new GateTestAdapter();
    const modelRoute = {
      connectionId: 'proxy-home',
      label: 'home-media',
      endpoint: 'https://proxy.example:8317',
    };
    const capabilityDelivery = {
      tools: { requested: true, delivered: true, channel: 'mcp' },
    };
    if (ordering === 'confirmed configuration') {
      const start = adapter.startSession.bind(adapter);
      vi.spyOn(adapter, 'startSession').mockImplementation(async (input) => {
        const session = await start(input);
        adapter.events.push({
          eventId: 'adapter-configured',
          provider: adapter.provider,
          threadId: input.threadId,
          sessionId: input.threadId,
          method: 'session.configured',
          createdAt: new Date().toISOString(),
          metadata: { ...input.metadata, modelRoute, capabilityDelivery },
        });
        await vi.waitFor(() =>
          expect(
            store.latestEventByMethod(input.threadId, 'session.configured')
              ?.payload.eventId,
          ).toBe('adapter-configured'),
        );
        return session;
      });
    }
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
      if (ordering === 'confirmed configuration')
        expect(
          store.latestEventByMethod('owned-start', 'session.configured')
            ?.payload.metadata,
        ).toMatchObject({ modelRoute, capabilityDelivery });
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
  },
);
