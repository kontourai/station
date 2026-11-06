/**
 * #4568: a brand-new chat's engine-start wait on the wire. The real
 * OrchestrationService queues a person's first start behind a background
 * start, and the real orchestration stream route carries its
 * `orchestration:engine-start-wait` frames — to the start's owner only, again
 * to a stream that opens while it waits, and cleared once it is admitted.
 */
import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createRuntimeResourcePostureController } from '../../../services/infra/resource-posture.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createEventRoutes } from '../events.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const temp = trackTempDirs();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const WAIT = SERVER_EVENTS.ORCHESTRATION_ENGINE_START_WAIT_CHANGED;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** The `data` of every `event: <name>` frame in an SSE text, for one thread. */
function framesOf(text: string, name: string, threadId?: string): unknown[] {
  return text
    .split('\n\n')
    .filter((block) => block.split('\n').includes(`event: ${name}`))
    .map(
      (block) =>
        JSON.parse(
          block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .join('\n'),
        ) as { threadId?: string },
    )
    .filter((frame) => threadId === undefined || frame.threadId === threadId);
}

test("a person's first-start wait reaches only its owner's streams, replays to a stream opened while it waits, and clears", async () => {
  const store = new EventStore(join(temp('engine-start-wait-'), 'e.sqlite'));
  const bus = new EventBus();
  const adapter = new GateTestAdapter();
  const gate = deferred();
  const entered = deferred();
  const original = adapter.startSession.bind(adapter);
  vi.spyOn(adapter, 'startSession').mockImplementation(async (input) => {
    if (input.threadId === 'background') {
      entered.release();
      await gate.promise;
    }
    return original(input);
  });
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore: store,
    resourcePosture: createRuntimeResourcePostureController(),
    logger: { debug() {}, warn() {} },
  });
  cleanups.push(async () => {
    gate.release();
    await service.shutdown();
    store.close();
  });
  service.initialize();
  let actor = 'owner';
  const app = createOrchestrationRoutes(service, {
    eventBus: bus,
    getUserId: () => actor,
    logger: { debug() {} },
  });
  const openStream = async (user: string, path: string) => {
    actor = user;
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    const response = await app.request(path, { signal: abort.signal });
    const reader = response.body!.getReader();
    cleanups.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let text = '';
    const until = async (marker: string, count = 1) => {
      while (text.split(marker).length - 1 < count) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Missing stream marker ${marker}`);
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    };
    await until('orchestration:caughtUp');
    return { until, text: () => text };
  };
  const owner = await openStream('owner', '/events');
  const stranger = await openStream('stranger', '/events');
  const filtered = await openStream('owner', '/events?threadId=elsewhere');
  const bareAbort = new AbortController();
  cleanups.push(() => bareAbort.abort());
  const bare = createEventRoutes({
    eventBus: bus,
    getACPStatus: () => ({ connected: false, connections: [] }),
    logger: { debug() {} },
  });
  const bareResponse = await bare.request('/', { signal: bareAbort.signal });
  const bareReader = bareResponse.body!.getReader();
  cleanups.push(() => bareReader.cancel());

  // A background start holds the slot; the owner's first start queues.
  const background = service.startSessionInternal(
    {
      type: 'start-session',
      input: { threadId: 'background', provider: 'claude' },
    },
    { userId: 'owner' },
    { resourceAdmissionIntent: 'queued_background' },
  );
  await entered.promise;
  const fresh = service.startSessionInternal(
    { type: 'start-session', input: { threadId: 'fresh', provider: 'claude' } },
    { userId: 'owner' },
    { resourceAdmissionIntent: 'interactive_user' },
  );
  await owner.until(`event: ${WAIT}`);
  expect(framesOf(owner.text(), WAIT)).toEqual([
    { threadId: 'fresh', wait: { since: expect.any(String) } },
  ]);

  // Opened mid-wait, the owner's next stream is sent the wait right away.
  const reopened = await openStream('owner', '/events');
  await reopened.until(`event: ${WAIT}`);
  expect(framesOf(reopened.text(), WAIT)).toEqual([
    { threadId: 'fresh', wait: { since: expect.any(String) } },
  ]);
  const strangerReopened = await openStream('stranger', '/events');
  // A thread-filtered stream sees only its own thread's wait.
  const elsewhere = service.startSessionInternal(
    {
      type: 'start-session',
      input: { threadId: 'elsewhere', provider: 'claude' },
    },
    { userId: 'owner' },
    { resourceAdmissionIntent: 'interactive_user' },
  );
  await filtered.until(`event: ${WAIT}`);
  expect(framesOf(filtered.text(), WAIT)).toEqual([
    { threadId: 'elsewhere', wait: { since: expect.any(String) } },
  ]);

  // The stranger's own start is the liveness marker for both stranger streams.
  const strangerStart = service.startSessionInternal(
    {
      type: 'start-session',
      input: { threadId: 'theirs', provider: 'claude' },
    },
    { userId: 'stranger' },
    { resourceAdmissionIntent: 'interactive_user' },
  );
  for (const stream of [stranger, strangerReopened]) {
    await stream.until(`event: ${WAIT}`);
    expect(framesOf(stream.text(), WAIT)).toEqual([
      { threadId: 'theirs', wait: { since: expect.any(String) } },
    ]);
  }

  gate.release();
  expect((await background).status).toBe('accepted');
  expect((await fresh).status).toBe('accepted');
  expect((await elsewhere).status).toBe('accepted');
  await owner.until(`event: ${WAIT}`, 4);
  expect(framesOf(owner.text(), WAIT, 'fresh')).toEqual([
    { threadId: 'fresh', wait: { since: expect.any(String) } },
    { threadId: 'fresh', wait: null },
  ]);
  expect((await strangerStart).status).toBe('accepted');
  await stranger.until(`event: ${WAIT}`, 2);
  expect(framesOf(stranger.text(), WAIT)).toEqual([
    { threadId: 'theirs', wait: { since: expect.any(String) } },
    { threadId: 'theirs', wait: null },
  ]);
  await filtered.until(`event: ${WAIT}`, 2);
  expect(framesOf(filtered.text(), WAIT)).toEqual([
    { threadId: 'elsewhere', wait: { since: expect.any(String) } },
    { threadId: 'elsewhere', wait: null },
  ]);

  // The identity-free broadcast route relays no wait at all.
  bus.emit(SERVER_EVENTS.RUNTIME_HEALTH_CHANGED, {
    provider: 'claude',
    status: 'healthy',
  });
  const decoder = new TextDecoder();
  let bareText = '';
  while (!bareText.includes(SERVER_EVENTS.RUNTIME_HEALTH_CHANGED)) {
    const chunk = await bareReader.read();
    if (chunk.done) throw new Error('bare stream ended');
    bareText += decoder.decode(chunk.value, { stream: true });
  }
  expect(bareText).not.toContain(WAIT);
});
