/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  BundledServerStatus,
  NativePlatformAdapter,
} from '../platform/native';

const mocks = vi.hoisted(() => ({
  nativePlatformPromise: Promise.resolve(
    undefined,
  ) as unknown as Promise<NativePlatformAdapter>,
}));

vi.mock('../platform/native', () => ({
  get nativePlatformPromise() {
    return mocks.nativePlatformPromise;
  },
}));

import {
  restartBundledServer,
  useBundledServerStatus,
} from '../platform/useBundledServerStatus';

function status(
  overrides: Partial<BundledServerStatus> = {},
): BundledServerStatus {
  return {
    phase: 'starting',
    attempt: 0,
    maxAttempts: 5,
    apiBase: null,
    port: null,
    lastExitCode: null,
    nextRetryInMs: null,
    logPath: '/tmp/station-server.log',
    ownership: 'sidecar',
    canRunInBackground: true,
    failClosed: false,
    message: '',
    ...overrides,
  };
}

interface Harness {
  adapter: NativePlatformAdapter;
  order: string[];
  dispose: ReturnType<typeof vi.fn>;
  emit: (next: BundledServerStatus) => void;
}

function makeHarness(pullValue: BundledServerStatus): Harness {
  const order: string[] = [];
  const dispose = vi.fn();
  let listener: ((next: BundledServerStatus) => void) | undefined;
  const adapter = {
    platform: 'tauri',
    capability: vi.fn(),
    getCapabilityReport: vi.fn(),
    subscribeToShare: vi.fn(() => ({ dispose: vi.fn() })),
    getBundledServerStatus: vi.fn(async () => {
      order.push('pull');
      return { status: 'ok' as const, value: pullValue };
    }),
    subscribeToBundledServerStatus: vi.fn(
      (next: (s: BundledServerStatus) => void) => {
        order.push('subscribe');
        listener = next;
        return { dispose };
      },
    ),
    restartBundledServer: vi.fn(async () => ({
      status: 'ok' as const,
      value: undefined,
    })),
  } as unknown as NativePlatformAdapter;
  return {
    adapter,
    order,
    dispose,
    emit: (next) => listener?.(next),
  };
}

describe('useBundledServerStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('subscribes before pulling the authoritative snapshot, then tracks transitions', async () => {
    const harness = makeHarness(status({ phase: 'starting' }));
    mocks.nativePlatformPromise = Promise.resolve(harness.adapter);

    const { result, unmount } = renderHook(() => useBundledServerStatus(true));

    await waitFor(() => expect(result.current?.phase).toBe('starting'));
    // Ordering is the event-before-listen guard: the listener exists before
    // a potentially stale pull returns.
    expect(harness.order).toEqual(['subscribe', 'pull']);

    act(() =>
      harness.emit(
        status({
          phase: 'running',
          apiBase: 'http://127.0.0.1:3200',
          port: 3200,
        }),
      ),
    );
    expect(result.current?.phase).toBe('running');
    expect(result.current?.apiBase).toBe('http://127.0.0.1:3200');

    unmount();
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });

  test('does not let a slow snapshot overwrite an external service transition', async () => {
    let resolvePull:
      | ((
          value: Awaited<
            ReturnType<NativePlatformAdapter['getBundledServerStatus']>
          >,
        ) => void)
      | undefined;
    const harness = makeHarness(status({ phase: 'stopped' }));
    harness.adapter.getBundledServerStatus = vi.fn(
      () =>
        new Promise<
          Awaited<ReturnType<NativePlatformAdapter['getBundledServerStatus']>>
        >((resolve) => {
          resolvePull = resolve;
        }),
    );
    mocks.nativePlatformPromise = Promise.resolve(harness.adapter);

    const { result } = renderHook(() => useBundledServerStatus(true));
    await waitFor(() => expect(harness.order).toEqual(['subscribe']));

    act(() => harness.emit(status({ phase: 'running' })));
    expect(result.current?.phase).toBe('running');
    await act(async () => {
      resolvePull?.({ status: 'ok', value: status({ phase: 'stopped' }) });
    });
    expect(result.current?.phase).toBe('running');
  });

  test('is inert on web/mobile: disabled never pulls and stays null', async () => {
    const harness = makeHarness(status({ phase: 'running' }));
    mocks.nativePlatformPromise = Promise.resolve(harness.adapter);

    const { result } = renderHook(() => useBundledServerStatus(false));

    // Give any stray microtask a chance to run before asserting the no-op.
    await Promise.resolve();
    expect(result.current).toBeNull();
    expect(harness.adapter.getBundledServerStatus).not.toHaveBeenCalled();
    expect(
      harness.adapter.subscribeToBundledServerStatus,
    ).not.toHaveBeenCalled();
  });

  test('disposes and re-pulls when supervision is toggled off then on', async () => {
    const harness = makeHarness(status({ phase: 'starting' }));
    mocks.nativePlatformPromise = Promise.resolve(harness.adapter);

    const { result, rerender } = renderHook(
      ({ enabled }) => useBundledServerStatus(enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current?.phase).toBe('starting'));

    rerender({ enabled: false });
    expect(harness.dispose).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();

    rerender({ enabled: true });
    await waitFor(() =>
      expect(harness.adapter.getBundledServerStatus).toHaveBeenCalledTimes(2),
    );
  });

  test('restartBundledServer delegates to the native adapter', async () => {
    const harness = makeHarness(status({ phase: 'failed' }));
    mocks.nativePlatformPromise = Promise.resolve(harness.adapter);

    await restartBundledServer();
    expect(harness.adapter.restartBundledServer).toHaveBeenCalledTimes(1);
  });
});
