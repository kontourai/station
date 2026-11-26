/** @vitest-environment jsdom */

import { createHash, webcrypto } from 'node:crypto';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  DevicePairingRequiredError: class DevicePairingRequiredError extends Error {},
  fetchWebPushRegistration: vi.fn(),
  subscribePushNotifications: vi.fn(),
  unsubscribePushNotifications: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => mocks);

import { usePushNotifications } from '../usePushNotifications';

const HOME = 'https://station-a.test';
const AWAY = 'https://station-b.test';
const KEY = 'AQAB';
const OTHER_KEY = 'AgAB';

describe('usePushNotifications', () => {
  const getSubscription = vi.fn();
  const pushManagerSubscribe = vi.fn();
  const register = vi.fn();
  const getRegistration = vi.fn();
  const worker = {
    pushManager: { getSubscription, subscribe: pushManagerSubscribe },
  };

  function browserSubscription(label: string, otherKey = false) {
    const endpoint = `https://push.test/${label}`;
    const keys = { p256dh: 'p-' + label, auth: 'a-' + label };
    return {
      endpoint,
      fingerprint: createHash('sha256')
        .update(JSON.stringify([endpoint, keys.p256dh, keys.auth]))
        .digest('hex'),
      options: {
        applicationServerKey: Uint8Array.from(otherKey ? [2, 0, 1] : [1, 0, 1])
          .buffer,
      },
      toJSON: () => ({ endpoint, keys }),
      unsubscribe: vi.fn(async () => {
        getSubscription.mockResolvedValue(null);
        return true;
      }),
    };
  }

  function readRegistration(
    fingerprint: string | null = null,
    publicKey = KEY,
  ) {
    return { publicKey, registration: { status: 'paired', fingerprint } };
  }

  function mount() {
    return renderHook(() =>
      usePushNotifications({ enabled: true, apiBase: HOME }),
    );
  }

  beforeEach(() => {
    getSubscription.mockReset().mockResolvedValue(null);
    pushManagerSubscribe.mockReset();
    register.mockReset().mockResolvedValue(worker);
    getRegistration.mockReset().mockResolvedValue(worker);
    mocks.fetchWebPushRegistration
      .mockReset()
      .mockResolvedValue(readRegistration());
    mocks.subscribePushNotifications.mockReset().mockResolvedValue(undefined);
    mocks.unsubscribePushNotifications.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('PushManager', class PushManager {});
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

  test('mount and reconnect observe the exact Station registration without rewriting it', async () => {
    const existing = browserSubscription('active');
    getSubscription.mockResolvedValue(existing);
    mocks.fetchWebPushRegistration.mockResolvedValue(
      readRegistration(existing.fingerprint),
    );
    const { result } = mount();
    await waitFor(() => expect(result.current.subscribed).toBe(true));
    expect(mocks.subscribePushNotifications).not.toHaveBeenCalled();

    mocks.fetchWebPushRegistration.mockResolvedValue(readRegistration());
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() =>
      expect(result.current.error).toContain('Register this browser'),
    );
    expect(result.current.subscribed).toBe(false);
    expect(mocks.subscribePushNotifications).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'switching Stations requires a matching receipt or explicit opt-in (different key: %s)',
    async (differentKey) => {
      const existing = browserSubscription('station-a');
      getSubscription.mockResolvedValue(existing);
      mocks.fetchWebPushRegistration.mockImplementation(async (base: string) =>
        base === HOME
          ? readRegistration(existing.fingerprint)
          : readRegistration(null, differentKey ? OTHER_KEY : KEY),
      );
      const { result, rerender } = renderHook(
        ({ apiBase }) => usePushNotifications({ enabled: true, apiBase }),
        { initialProps: { apiBase: HOME } },
      );
      await waitFor(() => expect(result.current.subscribed).toBe(true));

      rerender({ apiBase: AWAY });
      expect(result.current.subscribed).toBe(false);
      await waitFor(() =>
        expect(result.current.error).toContain(
          differentKey ? 'another Station' : 'Register this browser',
        ),
      );
      expect(mocks.subscribePushNotifications).not.toHaveBeenCalled();
      expect(existing.unsubscribe).not.toHaveBeenCalled();

      const next = differentKey
        ? browserSubscription('station-b', true)
        : existing;
      pushManagerSubscribe.mockResolvedValue(next);
      await act(async () => result.current.subscribe());
      expect(mocks.subscribePushNotifications).toHaveBeenCalledExactlyOnceWith(
        next.toJSON(),
        AWAY,
        undefined,
      );
      expect(result.current.subscribed).toBe(true);
      if (differentKey) {
        expect(existing.unsubscribe).toHaveBeenCalledOnce();
        expect(mocks.unsubscribePushNotifications).toHaveBeenCalledWith(
          existing.endpoint,
          HOME,
          undefined,
        );
      } else expect(existing.unsubscribe).not.toHaveBeenCalled();
    },
  );

  test('a delayed read cannot carry a receipt across an authority change at the same URL', async () => {
    const existing = browserSubscription('scope-a');
    getSubscription.mockResolvedValue(existing);
    let resolveFirst!: (value: ReturnType<typeof readRegistration>) => void;
    mocks.fetchWebPushRegistration.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ authorityKey }) =>
        usePushNotifications({
          enabled: true,
          apiBase: HOME,
          requestScope: { apiBase: HOME, authorityKey },
        }),
      { initialProps: { authorityKey: 'a' } },
    );
    await waitFor(() =>
      expect(mocks.fetchWebPushRegistration).toHaveBeenCalledWith(HOME, {
        requestScope: { apiBase: HOME, authorityKey: 'a' },
      }),
    );
    rerender({ authorityKey: 'b' });
    await act(async () => resolveFirst(readRegistration(existing.fingerprint)));
    await waitFor(() =>
      expect(mocks.fetchWebPushRegistration).toHaveBeenCalledWith(HOME, {
        requestScope: { apiBase: HOME, authorityKey: 'b' },
      }),
    );
    expect(result.current.subscribed).toBe(false);
    expect(mocks.subscribePushNotifications).not.toHaveBeenCalled();
  });

  test('a rejected registration write cannot become subscribed on remount', async () => {
    const existing = browserSubscription('unconfirmed');
    getSubscription.mockResolvedValue(existing);
    mocks.subscribePushNotifications.mockRejectedValue(
      new Error('POST failed'),
    );
    const first = mount();
    await waitFor(() =>
      expect(first.result.current.error).toContain('Register this browser'),
    );
    await act(async () => first.result.current.subscribe());
    expect(first.result.current.subscribed).toBe(false);
    first.unmount();

    const second = mount();
    await waitFor(() =>
      expect(second.result.current.error).toContain('Register this browser'),
    );
    expect(second.result.current.subscribed).toBe(false);
    expect(mocks.subscribePushNotifications).toHaveBeenCalledOnce();
  });

  test.each([
    { status: 401, message: 'Sign in' },
    { status: 403, message: 'refused Web Push access' },
    { status: 404, message: 'unavailable on this Station' },
  ])('distinguishes VAPID HTTP $status', async ({ status, message }) => {
    mocks.fetchWebPushRegistration.mockRejectedValue(
      new StationHttpError(status),
    );
    const { result } = mount();
    await act(async () => result.current.subscribe());
    expect(result.current.error).toContain(message);
    expect(result.current.pairingRequired).toBe(false);
    expect(result.current.subscribed).toBe(false);
  });

  test('distinguishes pairing refusal from a transport failure', async () => {
    const { result } = mount();
    mocks.fetchWebPushRegistration.mockResolvedValueOnce({
      publicKey: KEY,
      registration: { status: 'pairing-required' },
    });
    await act(async () => result.current.subscribe());
    expect(result.current.pairingRequired).toBe(true);
    expect(result.current.error).toBe('Pair this device first');

    mocks.fetchWebPushRegistration.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    await act(async () => result.current.subscribe());
    expect(result.current.pairingRequired).toBe(false);
    expect(result.current.error).not.toMatch(
      /Pair this device|unavailable on this Station/,
    );
    expect(mocks.subscribePushNotifications).not.toHaveBeenCalled();
  });

  test('registers a browser subscription only after permission and successful POST', async () => {
    const subscription = browserSubscription('new');
    pushManagerSubscribe.mockResolvedValue(subscription);
    vi.mocked(Notification.requestPermission).mockResolvedValueOnce('denied');
    const { result } = mount();
    await act(async () => result.current.subscribe());
    expect(result.current.permission).toBe('denied');
    expect(pushManagerSubscribe).not.toHaveBeenCalled();

    await act(async () => result.current.subscribe());
    expect(pushManagerSubscribe).toHaveBeenCalledExactlyOnceWith({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from([1, 0, 1]),
    });
    expect(mocks.subscribePushNotifications).toHaveBeenCalledExactlyOnceWith(
      subscription.toJSON(),
      HOME,
      undefined,
    );
    expect(result.current.subscribed).toBe(true);
  });

  test.each([false, true])(
    'turning off during a pending write withdraws it even if enabled becomes %s again',
    async (enableAgain) => {
      const subscription = browserSubscription('pending');
      pushManagerSubscribe.mockImplementation(async () => {
        getSubscription.mockResolvedValue(subscription);
        return subscription;
      });
      let acknowledge!: () => void;
      mocks.subscribePushNotifications.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve;
          }),
      );
      const { result, rerender } = renderHook(
        ({ enabled }) => usePushNotifications({ enabled, apiBase: HOME }),
        { initialProps: { enabled: true } },
      );
      let enabling!: Promise<void>;
      act(() => {
        enabling = result.current.subscribe();
        expect(result.current.subscribe()).toBe(enabling);
      });
      await waitFor(() =>
        expect(mocks.subscribePushNotifications).toHaveBeenCalledOnce(),
      );
      rerender({ enabled: false });
      await waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalled());
      if (enableAgain) rerender({ enabled: true });
      await act(async () => {
        acknowledge();
        await enabling;
      });
      expect(
        mocks.unsubscribePushNotifications,
      ).toHaveBeenCalledExactlyOnceWith(subscription.endpoint, HOME, undefined);
      expect(await getSubscription()).toBeNull();
      expect(result.current.subscribed).toBe(false);
    },
  );

  test('reconnect can still verify an explicit re-enable after unsubscribe', async () => {
    const original = browserSubscription('original');
    const next = browserSubscription('next');
    getSubscription.mockResolvedValue(original);
    mocks.fetchWebPushRegistration.mockResolvedValue(
      readRegistration(original.fingerprint),
    );
    const { result } = mount();
    await waitFor(() => expect(result.current.subscribed).toBe(true));
    await act(async () => result.current.unsubscribe());

    pushManagerSubscribe.mockImplementation(async () => {
      getSubscription.mockResolvedValue(next);
      return next;
    });
    mocks.fetchWebPushRegistration.mockResolvedValue(readRegistration());
    await act(async () => result.current.subscribe());
    expect(result.current.subscribed).toBe(true);

    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() =>
      expect(result.current.error).toContain('Register this browser'),
    );
    expect(result.current.subscribed).toBe(false);
  });

  test('a failed browser unsubscribe leaves the Station registration alone', async () => {
    const subscription = browserSubscription('still-local');
    subscription.unsubscribe.mockResolvedValue(false);
    getSubscription.mockResolvedValue(subscription);
    mocks.fetchWebPushRegistration.mockResolvedValue(
      readRegistration(subscription.fingerprint),
    );
    const { result } = mount();
    await waitFor(() => expect(result.current.subscribed).toBe(true));
    await act(async () => result.current.unsubscribe());
    expect(mocks.unsubscribePushNotifications).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/Could not turn off browser push/);
  });

  test('explicit unsubscribe reports failed Station cleanup after local revocation', async () => {
    const subscription = browserSubscription('confirmed');
    getSubscription.mockResolvedValue(subscription);
    mocks.fetchWebPushRegistration.mockResolvedValue(
      readRegistration(subscription.fingerprint),
    );
    mocks.unsubscribePushNotifications.mockRejectedValue(
      new Error('server offline'),
    );
    const { result } = mount();
    await waitFor(() => expect(result.current.subscribed).toBe(true));
    await act(async () => result.current.unsubscribe());
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(await getSubscription()).toBeNull();
    expect(result.current.subscribed).toBe(false);
    expect(result.current.error).toContain(
      'Station registration cleanup failed',
    );
  });
});
