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
  expect(stream.url).toBe(
    'https://shared.test/api/orchestration/events?includeGeneral=1',
  );
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
