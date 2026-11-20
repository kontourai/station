/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('@kontourai/station-sdk', () => ({
  fetchSSE: vi.fn((url, options) => {
    const controller = new AbortController();
    const stream = {
      url,
      options,
      signal: controller.signal,
      close: vi.fn(() => controller.abort()),
      retry: vi.fn(),
      restart: vi.fn(),
      completed: new Promise(() => {}),
    };
    transport.calls.push(stream);
    return stream;
  }),
  applyACPStatusEvent: vi.fn(),
  applyServerUpdateStateEvent: vi.fn(),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://shared.test' }),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://shared.test',
    authorityKey: 'person',
    isCurrent: current,
  }),
}));
const current = () => true;

import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import { GENERAL_EVENTS_RESUMED_EVENT } from '../hooks/orchestration/resumeCursor';
import { subscribeSharedOrchestrationStream } from '../hooks/orchestration/sharedStreamListeners';

afterEach(() => {
  transport.calls.length = 0;
});

test('legacy stream starts immediately and stays fenced through retries and authority changes', () => {
  const seen = vi.fn();
  const subscription = subscribeSharedOrchestrationStream(
    'https://shared.test',
    { onMessage: seen },
  );
  const release = ensureOrchestrationEventStream(
    'https://shared.test',
    undefined,
    'person',
    true,
  );
  const [stream, legacy] = transport.calls;
  expect(stream.url).toBe('https://shared.test/api/orchestration/events');
  expect(legacy.url).toBe('https://shared.test/events');
  legacy.options.onMessage({ event: 'example:changed', data: '{"value":1}' });
  expect(seen).toHaveBeenCalledTimes(1);
  stream.options.onOpen(
    new Response(null, { headers: { 'X-Station-General-Stream': '1' } }),
  );
  stream.options.onError(new Error('retry'));
  expect(legacy.close).not.toHaveBeenCalled();
  stream.options.onMessage({ event: 'station:general', data: '{}' });
  expect(seen).toHaveBeenCalledTimes(1);
  const next = ensureOrchestrationEventStream(
    'https://shared.test',
    undefined,
    'other',
    true,
  );
  expect(legacy.close).toHaveBeenCalledOnce();
  legacy.options.onMessage({ event: 'example:changed', data: '{}' });
  expect(seen).toHaveBeenCalledTimes(1);
  release();
  next();
  subscription.close();
});

test('shared mode forwards both families and fences a replaced authority until final release', () => {
  const base = 'https://mode.test';
  const seen = vi.fn();
  const subscription = subscribeSharedOrchestrationStream(base, {
    onMessage: seen,
  });
  const old = ensureOrchestrationEventStream(
    base,
    undefined,
    'old',
    true,
    true,
  );
  const [first] = transport.calls;
  expect(transport.calls).toHaveLength(1);
  expect(first.url).toBe(`${base}/api/orchestration/events?includeGeneral=1`);
  first.options.onMessage({ event: 'station:general', id: '999', data: '{}' });
  first.options.onMessage({ event: 'other:event', data: '{}' });
  expect(seen).toHaveBeenCalledTimes(2);
  const next = ensureOrchestrationEventStream(
    base,
    undefined,
    'new',
    true,
    false,
  );
  expect(first.close).toHaveBeenCalledOnce();
  expect(transport.calls.map((call) => call.url)).toEqual([
    `${base}/api/orchestration/events?includeGeneral=1`,
    `${base}/api/orchestration/events`,
    `${base}/events`,
  ]);
  expect(transport.calls[1].options.initialLastEventId).toBeUndefined();
  first.options.onMessage({ event: 'station:general', data: '{}' });
  expect(seen).toHaveBeenCalledTimes(2);
  old();
  expect(transport.calls[1].close).not.toHaveBeenCalled();
  next();
  expect(transport.calls[1].close).toHaveBeenCalledOnce();
  expect(transport.calls[2].close).toHaveBeenCalledOnce();
  subscription.close();
});

test('general frame ids never become orchestration resume cursors', () => {
  const base = 'https://cursor-mode.test';
  const release = ensureOrchestrationEventStream(
    base,
    undefined,
    'person',
    true,
    true,
  );
  const first = transport.calls[0];
  first.options.onMessage({ event: 'station:general', id: '999', data: '{}' });
  release();
  const next = ensureOrchestrationEventStream(
    base,
    undefined,
    'person',
    true,
    true,
  );
  expect(transport.calls[1].options.initialLastEventId).toBeUndefined();
  next();
});

/*
 * General events are not replayed. The connection that carries them tells its
 * listeners when it re-opens after a failure, so they can re-read what those
 * events would have refreshed; the other connection's failures say nothing
 * about general events.
 */
const resumed = {
  event: 'station:general',
  data: JSON.stringify({ event: GENERAL_EVENTS_RESUMED_EVENT, data: '{}' }),
};
const acknowledged = () =>
  new Response(null, { headers: { 'X-Station-General-Stream': '1' } });

test('the shared stream announces a re-open after a failure, not its first open', () => {
  const base = 'https://resume-shared.test';
  const seen = vi.fn();
  const subscription = subscribeSharedOrchestrationStream(base, {
    onMessage: seen,
  });
  const release = ensureOrchestrationEventStream(
    base,
    undefined,
    'person',
    true,
    true,
  );
  const [stream] = transport.calls;
  stream.options.onOpen(acknowledged());
  expect(seen).not.toHaveBeenCalled();

  stream.options.onError(new Error('socket closed'));
  expect(seen).not.toHaveBeenCalled();
  stream.options.onOpen(acknowledged());
  expect(seen.mock.calls).toEqual([[resumed]]);

  // One notice per failure: an open that follows no failure adds none.
  stream.options.onOpen(acknowledged());
  expect(seen).toHaveBeenCalledTimes(1);
  release();
  subscription.close();
});

test('in legacy mode the /events connection announces its own re-open', () => {
  const base = 'https://resume-legacy.test';
  const seen = vi.fn();
  const subscription = subscribeSharedOrchestrationStream(base, {
    onMessage: seen,
  });
  const release = ensureOrchestrationEventStream(
    base,
    undefined,
    'person',
    true,
  );
  const [stream, legacy] = transport.calls;
  expect(legacy.url).toBe(`${base}/events`);
  legacy.options.onOpen(new Response(null));
  // The orchestration stream carries no general events here.
  stream.options.onOpen(new Response(null));
  stream.options.onError(new Error('socket closed'));
  stream.options.onOpen(new Response(null));
  expect(seen).not.toHaveBeenCalled();

  legacy.options.onError(new Error('socket closed'));
  legacy.options.onOpen(new Response(null));
  expect(seen.mock.calls).toEqual([[resumed]]);

  // A connection that has been released announces nothing.
  legacy.options.onError(new Error('socket closed'));
  release();
  legacy.options.onOpen(new Response(null));
  expect(seen).toHaveBeenCalledTimes(1);
  subscription.close();
});
