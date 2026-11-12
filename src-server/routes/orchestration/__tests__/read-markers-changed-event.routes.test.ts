/**
 * #3075 review: a read-marker change reaches every open client of the person
 * whose marker moved, over the orchestration event stream they already hold,
 * and no one else's. The payload names nothing: it only says "re-read".
 */
import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, expect, test } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
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

/** The wire name, spelled out so this test also runs before the constant exists. */
const READ_MARKERS_CHANGED = 'read-markers:changed';

test('a read-marker change reaches only that person’s streams, never another person’s or the bare stream', async () => {
  const store = new EventStore(
    join(temp('read-markers-event-'), 'events.sqlite'),
  );
  const bus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventBus: bus,
    eventStore: store,
    logger: { debug() {}, warn() {} },
  });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  service.initialize();
  await awaitSessionAttachmentSettled(service);

  let actor = 'ada';
  const app = createOrchestrationRoutes(service, {
    eventBus: bus,
    getUserId: () => actor,
    logger: { debug() {} },
    // The request's read-marker person key, as the runtime derives it from
    // the request itself (resolved again for each change it publishes).
    readMarkerPersonKey: (c: {
      req: { header(name: string): string | undefined };
    }) => `human:test:${c.req.header('x-test-actor')}`,
  } as Parameters<typeof createOrchestrationRoutes>[1]);
  const openStream = async (user: string) => {
    actor = user;
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    const response = await app.request('/events', {
      signal: abort.signal,
      headers: { 'x-test-actor': user },
    });
    const reader = response.body!.getReader();
    cleanups.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let text = '';
    const until = async (marker: string) => {
      while (!text.includes(marker)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Missing stream marker ${marker}`);
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    };
    await until('orchestration:caughtUp');
    text = '';
    return { until };
  };
  const adaPhone = await openStream('ada');
  const adaDesktop = await openStream('ada');
  const bo = await openStream('bo');
  const bare = createEventRoutes({
    eventBus: bus,
    getACPStatus: () => ({ connected: false, connections: [] }),
    logger: { debug() {} },
  });
  const bareAbort = new AbortController();
  cleanups.push(() => bareAbort.abort());
  const bareReader = (
    await bare.request('/', { signal: bareAbort.signal })
  ).body!.getReader();
  cleanups.push(() => bareReader.cancel());
  let bareWire = '';
  const bareUntil = async (marker: string) => {
    while (!bareWire.includes(marker)) {
      const chunk = await bareReader.read();
      if (chunk.done) throw new Error(`Missing bare marker ${marker}`);
      bareWire += new TextDecoder().decode(chunk.value);
    }
  };
  await bareUntil('acp:status');

  bus.emit(READ_MARKERS_CHANGED as never, { personKey: 'human:test:ada' });
  // A liveness marker every stream receives bounds each read below.
  bus.emit(SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED, {
    threadId: 'liveness',
    canRead: () => true,
  });
  bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'bare-liveness' });

  for (const stream of [adaPhone, adaDesktop]) {
    const wire = await stream.until(
      SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED,
    );
    expect(wire).toContain(`event: ${READ_MARKERS_CHANGED}`);
    // The frame says only "re-read": it carries no person key.
    expect(wire).not.toContain('human:test:ada');
  }
  const boWire = await bo.until(SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED);
  expect(boWire).not.toContain(READ_MARKERS_CHANGED);
  await bareUntil('bare-liveness');
  expect(bareWire).not.toContain(READ_MARKERS_CHANGED);
});
