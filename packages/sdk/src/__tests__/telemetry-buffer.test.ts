import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { telemetry } from '../telemetry';

afterEach(async () => {
  await telemetry.flush();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('bounds a telemetry burst while keeping one scheduled flush', async () => {
  vi.useFakeTimers();
  _setApiBase('https://telemetry.example.test');
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  for (let index = 0; index < 10000; index++)
    telemetry.track('burst', { index });
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(1);
  const events = JSON.parse(fetch.mock.calls[0][1].body).events;
  expect(events).toHaveLength(1000);
  expect(events[0].attributes.index).toBe(0);
  expect(events[999].attributes.index).toBe(999);
  telemetry.track('after-flush');
  await telemetry.flush();
  expect(
    JSON.parse(fetch.mock.calls[1][1].body).events.map(
      (event: { event: string }) => event.event,
    ),
  ).toEqual(['after-flush']);
});
