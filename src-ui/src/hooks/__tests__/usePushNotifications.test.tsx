/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  DevicePairingRequiredError: class DevicePairingRequiredError extends Error {},
  fetchVapidPublicKey: vi.fn(),
  subscribePushNotifications: vi.fn(),
  unsubscribePushNotifications: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  DevicePairingRequiredError: mocks.DevicePairingRequiredError,
  fetchVapidPublicKey: mocks.fetchVapidPublicKey,
  subscribePushNotifications: mocks.subscribePushNotifications,
  unsubscribePushNotifications: mocks.unsubscribePushNotifications,
}));

import { usePushNotifications } from '../usePushNotifications';

describe('usePushNotifications', () => {
  const getSubscription = vi.fn();
  const pushManagerSubscribe = vi.fn();
  const register = vi.fn();

  beforeEach(() => {
    getSubscription.mockReset().mockResolvedValue(null);
    pushManagerSubscribe.mockReset();
    register.mockReset().mockResolvedValue({
      pushManager: {
        getSubscription,
        subscribe: pushManagerSubscribe,
      },
    });
    mocks.fetchVapidPublicKey.mockReset().mockResolvedValue('AQAB');
    mocks.subscribePushNotifications.mockReset().mockResolvedValue(undefined);
    mocks.unsubscribePushNotifications.mockReset().mockResolvedValue(undefined);

    Object.defineProperty(window, 'PushManager', {
      configurable: true,
      value: class PushManager {},
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register },
    });
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('reports support and discovers an existing subscription on mount', async () => {
    getSubscription.mockResolvedValue({
      endpoint: 'https://push.test/current',
    });

    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );

    expect(result.current.supported).toBe(true);
    await waitFor(() => expect(result.current.subscribed).toBe(true));
    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  test('does no service-worker or server work when disabled', async () => {
    const { result } = renderHook(() =>
      usePushNotifications({ enabled: false, apiBase: 'http://station.test' }),
    );

    await act(async () => {
      await result.current.subscribe();
      await result.current.unsubscribe();
    });

    expect(result.current.supported).toBe(false);
    expect(register).not.toHaveBeenCalled();
    expect(mocks.fetchVapidPublicKey).not.toHaveBeenCalled();
    expect(mocks.subscribePushNotifications).not.toHaveBeenCalled();
    expect(mocks.unsubscribePushNotifications).not.toHaveBeenCalled();
  });

  test('surfaces service-worker registration failures', async () => {
    register.mockRejectedValue(new Error('service worker unavailable'));

    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );

    await waitFor(() =>
      expect(result.current.error).toBe('service worker unavailable'),
    );
  });

  test('stops when notification permission is denied', async () => {
    vi.mocked(Notification.requestPermission).mockResolvedValue('denied');
    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );
    await waitFor(() => expect(register).toHaveBeenCalled());

    await act(async () => result.current.subscribe());

    expect(result.current.permission).toBe('denied');
    expect(result.current.error).toBe('Notification permission denied');
    expect(mocks.fetchVapidPublicKey).not.toHaveBeenCalled();
    expect(mocks.subscribePushNotifications).not.toHaveBeenCalled();
  });

  test('subscribes locally and persists the subscription on the active server', async () => {
    const subscription = {
      endpoint: 'https://push.test/subscription',
      toJSON: vi.fn(() => ({ endpoint: 'https://push.test/subscription' })),
      unsubscribe: vi.fn(),
    };
    pushManagerSubscribe.mockResolvedValue(subscription);
    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );
    await waitFor(() => expect(register).toHaveBeenCalled());

    await act(async () => result.current.subscribe());

    expect(mocks.fetchVapidPublicKey).toHaveBeenCalledWith(
      'http://station.test',
    );
    expect(pushManagerSubscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(mocks.subscribePushNotifications).toHaveBeenCalledWith(
      { endpoint: 'https://push.test/subscription' },
      'http://station.test',
    );
    expect(result.current.subscribed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  test('presents a pairing rejection as an actionable state', async () => {
    pushManagerSubscribe.mockResolvedValue({
      endpoint: 'https://push.test/subscription',
      toJSON: () => ({ endpoint: 'https://push.test/subscription' }),
    });
    mocks.subscribePushNotifications.mockRejectedValue(
      new mocks.DevicePairingRequiredError('pairing required'),
    );
    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );
    await waitFor(() => expect(register).toHaveBeenCalled());

    await act(async () => result.current.subscribe());

    expect(result.current.pairingRequired).toBe(true);
    expect(result.current.error).toBe('Pair this device first');
    expect(result.current.subscribed).toBe(false);
  });

  test('surfaces an ordinary subscription failure', async () => {
    mocks.fetchVapidPublicKey.mockRejectedValue(new Error('VAPID unavailable'));
    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );
    await waitFor(() => expect(register).toHaveBeenCalled());

    await act(async () => result.current.subscribe());

    expect(result.current.pairingRequired).toBe(false);
    expect(result.current.error).toBe('VAPID unavailable');
    expect(result.current.subscribed).toBe(false);
  });

  test('unsubscribes locally and removes the endpoint from the active server', async () => {
    const subscription = {
      endpoint: 'https://push.test/subscription',
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    getSubscription.mockResolvedValue(subscription);
    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );
    await waitFor(() => expect(result.current.subscribed).toBe(true));

    await act(async () => result.current.unsubscribe());

    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.unsubscribePushNotifications).toHaveBeenCalledWith(
      subscription.endpoint,
      'http://station.test',
    );
    expect(result.current.subscribed).toBe(false);
  });

  test('treats server cleanup as best-effort after local unsubscribe', async () => {
    const subscription = {
      endpoint: 'https://push.test/subscription',
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    getSubscription.mockResolvedValue(subscription);
    mocks.unsubscribePushNotifications.mockRejectedValue(
      new Error('server offline'),
    );
    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );
    await waitFor(() => expect(result.current.subscribed).toBe(true));

    await act(async () => result.current.unsubscribe());

    expect(result.current.subscribed).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
