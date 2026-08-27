/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { NativePlatformAdapter } from '../platform/native';

const mocks = vi.hoisted(() => ({
  nativePlatformPromise: Promise.resolve(
    undefined,
  ) as unknown as Promise<NativePlatformAdapter>,
  showToast: vi.fn(),
}));

vi.mock('../platform/native', () => ({
  get nativePlatformPromise() {
    return mocks.nativePlatformPromise;
  },
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function adapter(
  subscribeToShare = vi.fn(() => ({ dispose: vi.fn() })),
): NativePlatformAdapter {
  return {
    platform: 'web',
    capability: vi.fn(),
    getCapabilityReport: vi.fn(),
    subscribeToShare,
    getBundledServerStatus: vi.fn(),
    subscribeToBundledServerStatus: vi.fn(() => ({ dispose: vi.fn() })),
    restartBundledServer: vi.fn(),
    // Deliberately partial: this fixture omits `hapticFeedback`, which this
    // suite never exercises — `unknown` first since the object no longer
    // sufficiently overlaps `NativePlatformAdapter` for a direct cast.
  } as unknown as NativePlatformAdapter;
}

beforeEach(() => {
  vi.resetModules();
  mocks.showToast.mockReset();
});

describe('useShareReceiver', () => {
  test('does not subscribe when disposed before the platform loads', async () => {
    const platform = deferred<NativePlatformAdapter>();
    const subscribeToShare = vi.fn(() => ({ dispose: vi.fn() }));
    mocks.nativePlatformPromise = platform.promise;
    const { useShareReceiver } = await import('../hooks/useShareReceiver');
    const { unmount } = renderHook(() =>
      useShareReceiver({ enabled: true, onShare: vi.fn() }),
    );

    unmount();
    await act(async () => platform.resolve(adapter(subscribeToShare)));

    expect(subscribeToShare).not.toHaveBeenCalled();
  });

  test('surfaces a platform initialization failure while mounted', async () => {
    const platform = deferred<NativePlatformAdapter>();
    mocks.nativePlatformPromise = platform.promise;
    const { useShareReceiver } = await import('../hooks/useShareReceiver');
    renderHook(() => useShareReceiver({ enabled: true, onShare: vi.fn() }));

    await act(async () => platform.reject(new Error('chunk unavailable')));

    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith(
        'Station could not initialize native sharing.',
      ),
    );
  });

  test('disposes the loaded platform subscription on unmount', async () => {
    const dispose = vi.fn();
    const subscribeToShare = vi.fn(() => ({ dispose }));
    mocks.nativePlatformPromise = Promise.resolve(adapter(subscribeToShare));
    const { useShareReceiver } = await import('../hooks/useShareReceiver');
    const { unmount } = renderHook(() =>
      useShareReceiver({ enabled: true, onShare: vi.fn() }),
    );

    await waitFor(() => expect(subscribeToShare).toHaveBeenCalledOnce());
    unmount();

    expect(dispose).toHaveBeenCalledOnce();
  });
});
