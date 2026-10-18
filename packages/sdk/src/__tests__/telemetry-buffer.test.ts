import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { setClientRawEgressPolicyResolver } from '../client/http';
import { createPluginTelemetry, instrument, telemetry } from '../telemetry';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientRawEgressPolicyResolver(undefined);
});

test('legacy ambient diagnostics and instrumentation never send undeclared observations', async () => {
  _setApiBase('https://station.example.test');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  telemetry.count('opened');
  telemetry.track('sdk.opened');
  await telemetry.flush();
  const fn = vi.fn(async () => 'result');
  expect(await instrument('opened', fn)()).toBe('result');
  const failure = new Error('failure');
  await expect(
    instrument('failed', async () => {
      throw failure;
    })(),
  ).rejects.toBe(failure);
  expect(fetch).not.toHaveBeenCalled();
});

test('scoped counts send only the captured pane capability, never an ambient plugin header', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  await createPluginTelemetry(
    'https://station.example.test',
    'pane-token',
  ).count('opened', { surface: 'main' });
  expect(fetch).toHaveBeenCalledOnce();
  const headers = new Headers(fetch.mock.calls[0][1].headers);
  expect(headers.get('x-station-plugin-capability')).toBe('pane-token');
  expect(headers.has('x-station-plugin')).toBe(false);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    events: [{ event: 'opened', attributes: { surface: 'main' } }],
  });
});

test('a missing pane capability cannot send', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    createPluginTelemetry(
      'https://station.example.test',
      () => undefined,
    ).count('opened'),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

test('a pane capability cannot use a broker route or a replaced Station authority', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const scoped = createPluginTelemetry(
    'https://station.example.test',
    'pane-token',
  );
  for (const kind of ['direct', 'broker'] as const) {
    setClientRawEgressPolicyResolver(() => ({
      kind,
      apiBase: 'https://station.example.test',
      connectionId: 'station',
      activationEpoch: 'epoch',
      isCurrent: () => kind === 'broker',
    }));
    await expect(scoped.count('opened')).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
});
