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
  const getRegistration = vi.fn();

  function makeSubscription(endpoint: string, secondKey = false) {
    return {
      endpoint,
      options: {
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array(secondKey ? [2, 0, 1] : [1, 0, 1])
          .buffer,
      },
      toJSON: () => ({ endpoint }),
      unsubscribe: vi.fn(async () => {
        getSubscription.mockResolvedValue(null);
        return true;
      }),
    };
  }

  beforeEach(() => {
    getSubscription.mockReset().mockResolvedValue(null);
    pushManagerSubscribe.mockReset();
    register.mockReset().mockResolvedValue({
      pushManager: {
        getSubscription,
        subscribe: pushManagerSubscribe,
      },
    });
    getRegistration.mockReset().mockResolvedValue(undefined);
    mocks.fetchVapidPublicKey.mockReset().mockResolvedValue('AQAB');
    mocks.subscribePushNotifications.mockReset().mockResolvedValue(undefined);
    mocks.unsubscribePushNotifications.mockReset().mockResolvedValue(undefined);

    Object.defineProperty(window, 'PushManager', {
      configurable: true,
      value: class PushManager {},
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register, getRegistration },
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
    getSubscription.mockResolvedValue(
      makeSubscription('https://push.test/current'),
    );

    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );

    expect(result.current.supported).toBe(true);
    await waitFor(() => expect(result.current.subscribed).toBe(true));
    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  test.each([false, true])(
    'switching Stations requires its registration receipt and matching VAPID key (different key: %s)',
    async (differentKey) => {
      const existing = makeSubscription('https://push.test/station-a');
      getSubscription.mockResolvedValue(existing);
      mocks.fetchVapidPublicKey.mockImplementation(async (base: string) =>
        base === 'https://station-b.test' && differentKey ? 'AgAB' : 'AQAB',
      );
      let acknowledgeB = () => {};
      mocks.subscribePushNotifications.mockImplementation(
        (_sub, base: string) =>
          base === 'https://station-b.test'
            ? new Promise<void>((resolve) => {
                acknowledgeB = resolve;
              })
            : Promise.resolve(),
      );
      const { result, rerender } = renderHook(
        ({ apiBase }) => usePushNotifications({ enabled: true, apiBase }),
        {
          initialProps: { apiBase: 'https://station-a.test' },
        },
      );
      await waitFor(() => expect(result.current.subscribed).toBe(true));
      rerender({ apiBase: 'https://station-b.test' });
      expect(result.current.subscribed).toBe(false);
      await waitFor(() =>
        expect(mocks.fetchVapidPublicKey).toHaveBeenCalledWith(
          'https://station-b.test',
        ),
      );
      if (differentKey) {
        await waitFor(() =>
          expect(result.current.error).toContain('another Station'),
        );
        expect(mocks.subscribePushNotifications).not.toHaveBeenCalledWith(
          existing.toJSON(),
          'https://station-b.test',
        );
        expect(existing.unsubscribe).not.toHaveBeenCalled();
        const next = makeSubscription('https://push.test/station-b', true);
        pushManagerSubscribe.mockImplementation(async () => {
          getSubscription.mockResolvedValue(next);
          return next;
        });
        let enabling!: Promise<void>;
        act(() => {
          enabling = result.current.subscribe();
        });
        await waitFor(() =>
          expect(mocks.subscribePushNotifications).toHaveBeenCalledWith(
            next.toJSON(),
            'https://station-b.test',
          ),
        );
        await act(async () => {
          acknowledgeB();
          await enabling;
        });
        expect(existing.unsubscribe).toHaveBeenCalledOnce();
        expect(mocks.unsubscribePushNotifications).toHaveBeenCalledWith(
          existing.endpoint,
          'https://station-a.test',
        );
      } else {
        await waitFor(() =>
          expect(mocks.subscribePushNotifications).toHaveBeenCalledWith(
            existing.toJSON(),
            'https://station-b.test',
          ),
        );
        expect(result.current.subscribed).toBe(false);
        await act(async () => {
          acknowledgeB();
        });
        expect(existing.unsubscribe).not.toHaveBeenCalled();
      }
      await waitFor(() => expect(result.current.subscribed).toBe(true));
    },
  );

  test('repeated Enable calls cannot recreate a subscription after explicit Unsubscribe', async () => {
    const current = makeSubscription('https://push.test/coalesced');
    pushManagerSubscribe.mockImplementation(async () => {
      getSubscription.mockResolvedValue(current);
      return current;
    });
    let acknowledge = () => {};
    mocks.subscribePushNotifications.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { result } = renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: 'http://station.test' }),
    );
    await waitFor(() => expect(register).toHaveBeenCalled());
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.subscribe();
      second = result.current.subscribe();
    });
    await waitFor(() =>
      expect(mocks.subscribePushNotifications).toHaveBeenCalledOnce(),
    );
    await act(async () => result.current.unsubscribe());
    await act(async () => {
      acknowledge();
      await Promise.all([first, second]);
    });
    expect(mocks.subscribePushNotifications).toHaveBeenCalledOnce();
    expect(await getSubscription()).toBeNull();
    expect(result.current.subscribed).toBe(false);
  });

  test('does not create a service worker or subscription when disabled', async () => {
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
      options: {
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array([1, 0, 1]).buffer,
      },
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
      options: {
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array([1, 0, 1]).buffer,
      },
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
      options: {
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array([1, 0, 1]).buffer,
      },
      toJSON: () => ({ endpoint: 'https://push.test/subscription' }),
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

  test.each([false, true])(
    'switching off during server registration invalidates that write even if enabled later becomes %s',
    async (enableAgain) => {
      const subscription = {
        endpoint: 'https://push.test/subscription',
        options: {
          userVisibleOnly: true,
          applicationServerKey: new Uint8Array([1, 0, 1]).buffer,
        },
        toJSON: () => ({ endpoint: 'https://push.test/subscription' }),
        unsubscribe: vi.fn(async () => {
          getSubscription.mockResolvedValue(null);
          return true;
        }),
      };
      pushManagerSubscribe.mockImplementation(async () => {
        getSubscription.mockResolvedValue(subscription);
        return subscription;
      });
      getRegistration.mockResolvedValue({
        pushManager: { getSubscription, subscribe: pushManagerSubscribe },
      });
      let finishRegistration = () => {};
      mocks.subscribePushNotifications.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishRegistration = resolve;
          }),
      );
      const { result, rerender } = renderHook(
        ({ enabled }) =>
          usePushNotifications({ enabled, apiBase: 'http://station.test' }),
        { initialProps: { enabled: true } },
      );
      await waitFor(() => expect(register).toHaveBeenCalled());
      let subscribing: Promise<void>;
      act(() => {
        subscribing = result.current.subscribe();
      });
      await waitFor(() =>
        expect(mocks.subscribePushNotifications).toHaveBeenCalledOnce(),
      );

      rerender({ enabled: false });
      await waitFor(() =>
        expect(mocks.unsubscribePushNotifications).toHaveBeenCalledOnce(),
      );
      if (enableAgain) rerender({ enabled: true });
      await act(async () => {
        finishRegistration();
        await subscribing;
      });

      expect(mocks.unsubscribePushNotifications).toHaveBeenCalledTimes(2);
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(2);
      expect(result.current.subscribed).toBe(false);
    },
  );

  test('treats server cleanup as best-effort after local unsubscribe', async () => {
    const subscription = {
      endpoint: 'https://push.test/subscription',
      options: {
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array([1, 0, 1]).buffer,
      },
      toJSON: () => ({ endpoint: 'https://push.test/subscription' }),
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
