/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
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
import { useServerEvents } from '../hooks/useServerEvents';

afterEach(() => {
  transport.calls.length = 0;
});

test('general and orchestration subscribers own one stream and release recovery with the last owner', () => {
  const client = new QueryClient();
  const handler = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const remove = vi.spyOn(window, 'removeEventListener');
  const hook = renderHook(
    () => useServerEvents({ 'example:changed': handler }),
    { wrapper },
  );
  const seen = vi.fn();
  const subscription = subscribeSharedOrchestrationStream(
    'https://shared.test',
    { onMessage: seen },
  );
  const release = ensureOrchestrationEventStream(
    'https://shared.test',
    undefined,
    'person',
  );
  expect(transport.calls).toHaveLength(1);
  const stream = transport.calls[0];
  expect(stream.url).toBe(
    'https://shared.test/api/orchestration/events?includeGeneral=1',
  );
  expect(stream.options.authentication).toBe('required');
  act(() =>
    stream.options.onOpen(
      new Response(null, { headers: { 'X-Station-General-Stream': '1' } }),
    ),
  );
  expect(stream.options.headers['X-Station-Client-Session']).toBeTruthy();
  act(() =>
    stream.options.onMessage({
      event: 'station:general',
      data: JSON.stringify({
        event: 'example:changed',
        data: JSON.stringify({ value: 7 }),
      }),
      id: '999',
    }),
  );
  expect(handler).toHaveBeenCalledWith({ value: 7 });
  act(() =>
    stream.options.onMessage({
      event: 'orchestration:snapshot',
      data: JSON.stringify({ sessions: [] }),
      id: '12',
    }),
  );
  expect(seen).toHaveBeenCalledTimes(2);
  hook.unmount();
  expect(stream.close).not.toHaveBeenCalled();
  subscription.close();
  release();
  expect(stream.close).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith('focus', expect.any(Function));
  window.dispatchEvent(new Event('focus'));
  expect(transport.calls).toHaveLength(1);
  const releaseAgain = ensureOrchestrationEventStream(
    'https://shared.test',
    undefined,
    'person',
  );
  expect(transport.calls[1].options.initialLastEventId).toBe('12');
  act(() =>
    transport.calls[1].options.onMessage({
      event: 'station:general',
      data: JSON.stringify({ event: 'example:changed', data: '{}' }),
      id: '500',
    }),
  );
  releaseAgain();
  const finalRelease = ensureOrchestrationEventStream(
    'https://shared.test',
    undefined,
    'person',
  );
  expect(transport.calls[2].options.initialLastEventId).toBe('12');
  finalRelease();
  const differentAuthority = ensureOrchestrationEventStream(
    'https://shared.test',
    undefined,
    'another-person',
  );
  expect(transport.calls[3].options.initialLastEventId).toBeUndefined();
  differentAuthority();
  remove.mockRestore();
  client.clear();
});

test('legacy fallback follows each response and is fenced on replacement and release', () => {
  const seen = vi.fn();
  const subscription = subscribeSharedOrchestrationStream(
    'https://shared.test',
    { onMessage: seen },
  );
  const release = ensureOrchestrationEventStream(
    'https://shared.test',
    undefined,
    'legacy-person',
  );
  const stream = transport.calls[0];
  stream.options.onOpen(new Response());
  const legacy = transport.calls[1];
  expect(legacy.url).toBe('https://shared.test/events');
  legacy.options.onMessage({ event: 'example:changed', data: '{"value":1}' });
  expect(seen).toHaveBeenCalledTimes(1);
  stream.options.onMessage({ event: 'station:general', data: '{}' });
  expect(seen).toHaveBeenCalledTimes(1);
  stream.options.onOpen(
    new Response(null, { headers: { 'X-Station-General-Stream': '1' } }),
  );
  expect(legacy.close).toHaveBeenCalledOnce();
  legacy.options.onMessage({ event: 'example:changed', data: '{}' });
  stream.options.onMessage({ event: 'station:general', data: '{}' });
  expect(seen).toHaveBeenCalledTimes(2);
  stream.options.onOpen(new Response());
  const replacement = transport.calls[2];
  release();
  expect(replacement.close).toHaveBeenCalledOnce();
  replacement.options.onMessage({ event: 'example:changed', data: '{}' });
  expect(seen).toHaveBeenCalledTimes(2);
  subscription.close();
});
