import { expect, test } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { StationRuntime } from '../station-runtime.js';

const makeTempDir = trackTempDirs();

test('runtime composes one authoritative binding before services are constructed', async () => {
  const runtime = new StationRuntime({
    projectHomeDir: makeTempDir('runtime-cascade-binding-'),
    port: 43197,
    logLevel: 'error',
  });
  const store = runtime['orchestrationEventStore'];
  let reader: OrchestrationService | undefined;
  try {
    store.appendEvent({
      eventId: 'child-exited',
      threadId: 'child',
      sessionId: 'child',
      provider: 'claude',
      method: 'session.exited',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(store.cascadeStopOwner('child').custody).toBe('settled');
    const adapter = new GateTestAdapter();
    let running = true;
    adapter.hasSession = async () => running;
    adapter.stopSession = async () => {
      running = false;
    };
    const owner = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug() {}, warn() {} },
    });
    runtime['orchestrationService'] = owner;
    owner.seedSessionRecord({ threadId: 'child', provider: 'claude' });
    await owner.whenSessionRecoveryCompleted();
    expect(store.cascadeStopOwner('child').custody).toBe('local');

    reader = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug() {}, warn() {} },
    });
    expect(store.cascadeStopOwner('child').custody).toBe('local');
    expect(() => store.bindSessionActivity(() => false)).toThrow(
      'already bound',
    );
    expect(store.cascadeStopOwner('child').custody).toBe('local');

    await owner.dispatch({ type: 'stopSession', threadId: 'child' });
    expect(store.cascadeStopOwner('child').custody).toBe('settled');
  } finally {
    await reader?.shutdown();
    await runtime.shutdown();
  }
});
