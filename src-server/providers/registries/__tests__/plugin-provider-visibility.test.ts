import { afterEach, expect, test, vi } from 'vitest';
import {
  clearAll,
  createProviderAdapterRegistry,
  getProvider,
  getProviderAdapter,
  getProviderAdapters,
  listProviders,
  type PluginProviderReadView,
  replacePluginProvidersForSource,
} from '../registry.js';

afterEach(() => clearAll());

test('pending registrations are hidden from every ordinary getter while an exact active view can inspect them', async () => {
  let ready = false,
    active = true;
  const view = Object.freeze({}) as PluginProviderReadView;
  const visibility = {
    ready: () => ready,
    permits: (candidate: PluginProviderReadView) =>
      active && candidate === view,
  };
  const call = vi.fn(() => 'effect');
  const adapter = Object.freeze({
    provider: 'fixture',
    startSession: call,
    stopAll: vi.fn(),
  });
  await replacePluginProvidersForSource('fixture', [
    {
      source: 'fixture',
      type: 'branding',
      provider: Object.freeze({ getAppName: call }),
      visibility,
    },
    {
      source: 'fixture',
      type: 'providerAdapter',
      provider: adapter,
      visibility,
    },
  ]);
  expect(getProvider('branding')).toBeNull();
  expect(listProviders('branding')).toEqual([]);
  expect(getProviderAdapter('fixture' as never)).toBeUndefined();
  expect(getProviderAdapters()).toEqual([]);
  expect(createProviderAdapterRegistry().list()).toEqual([]);
  expect(
    getProvider('branding', undefined, {} as PluginProviderReadView),
  ).toBeNull();
  const privateHandle = getProvider<{ getAppName(): string }>(
    'branding',
    undefined,
    view,
  )!;
  expect(privateHandle.getAppName()).toBe('effect');
  expect(
    createProviderAdapterRegistry(view).get('fixture' as never),
  ).toBeDefined();
  const escaped = privateHandle.getAppName;
  active = false;
  ready = true;
  expect(() => escaped()).toThrow('unavailable');
  expect(getProvider('branding', undefined, view)).toBeNull();
  expect(getProvider<{ getAppName(): string }>('branding')!.getAppName()).toBe(
    'effect',
  );
  expect(call).toHaveBeenCalledTimes(2);
});

test('a previously returned ordinary method checks currentness and still permits exact cleanup after revocation', async () => {
  let ready = true;
  const start = vi.fn(),
    stop = vi.fn();
  await replacePluginProvidersForSource('fixture', [
    {
      source: 'fixture',
      type: 'providerAdapter',
      provider: Object.freeze({
        provider: 'fixture',
        startSession: start,
        stopAll: stop,
      }),
      visibility: { ready: () => ready, permits: () => false },
    },
  ]);
  const handle = getProviderAdapter('fixture' as never)!;
  const escaped = handle.startSession;
  ready = false;
  expect(getProviderAdapters()).toEqual([]);
  expect(() => escaped({} as never)).toThrow('unavailable');
  expect(handle.provider).toBe('fixture');
  await handle.stopAll();
  expect(stop).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
});
