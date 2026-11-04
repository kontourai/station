import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { createRuntimeResourcePostureController } from '../../infra/resource-posture.js';
import { EventBus } from '../event-bus.js';
import { OrchestrationService } from '../orchestration-service.js';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function harness() {
  const controller = createRuntimeResourcePostureController();
  const adapter = new GateTestAdapter();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    resourcePosture: controller,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const start = (
    threadId: string,
    intent: 'interactive_user' | 'queued_background',
  ) =>
    service.startSessionInternal(
      { type: 'start-session', input: { threadId, provider: 'claude' } },
      { userId: 'owner' },
      { resourceAdmissionIntent: intent },
    );
  return { adapter, controller, service, start };
}

test('an interactive start waits for a background provider start to settle', async () => {
  const h = harness();
  const gate = deferred();
  const entered = deferred();
  const original = h.adapter.startSession.bind(h.adapter);
  vi.spyOn(h.adapter, 'startSession').mockImplementation(async (input) => {
    if (input.threadId === 'background') {
      entered.release();
      await gate.promise;
    }
    return original(input);
  });
  const waiting = vi.spyOn(h.controller, 'waitForEngineStart');
  const background = h.start('background', 'queued_background');
  try {
    await entered.promise;
    const person = h.start('person', 'interactive_user');
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
    expect(h.adapter.startSession).toHaveBeenCalledTimes(1);
    gate.release();
    expect((await background).status).toBe('accepted');
    expect((await person).status).toBe('accepted');
    expect(h.adapter.startSession).toHaveBeenCalledTimes(2);
  } finally {
    gate.release();
    await h.service.shutdown();
  }
});

test('a later background start cannot pass a waiting person at lease handoff', async () => {
  const h = harness();
  const backgroundGate = deferred();
  const personGate = deferred();
  const entered = deferred();
  const personEntered = deferred();
  const original = h.adapter.startSession.bind(h.adapter);
  vi.spyOn(h.adapter, 'startSession').mockImplementation(async (input) => {
    if (input.threadId === 'background') {
      entered.release();
      await backgroundGate.promise;
    }
    if (input.threadId === 'person') {
      personEntered.release();
      await personGate.promise;
    }
    return original(input);
  });
  const waiting = vi.spyOn(h.controller, 'waitForEngineStart');
  const background = h.start('background', 'queued_background');
  try {
    await entered.promise;
    const person = h.start('person', 'interactive_user');
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
    expect(await h.start('while-waiting', 'queued_background')).toMatchObject({
      status: 'rejected',
      code: 'resource_engine_start_capacity',
    });
    backgroundGate.release();
    await personEntered.promise;
    const later = await h.start('later', 'queued_background');
    expect(later).toMatchObject({
      status: 'rejected',
      code: 'resource_engine_start_capacity',
    });
    expect(h.adapter.startSession).toHaveBeenCalledTimes(2);
    personGate.release();
    expect((await background).status).toBe('accepted');
    expect((await person).status).toBe('accepted');
    expect((await h.start('after', 'queued_background')).status).toBe(
      'accepted',
    );
  } finally {
    backgroundGate.release();
    personGate.release();
    await h.service.shutdown();
  }
});
