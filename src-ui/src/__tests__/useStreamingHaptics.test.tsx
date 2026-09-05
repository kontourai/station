// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useStreamingHaptics } from '../hooks/useStreamingHaptics';
import { setHapticsUserEnabled } from '../platform/native/haptics';

const native = vi.hoisted(() => ({
  capability: vi.fn(() => ({ state: 'enabled' })),
  hapticFeedback: vi.fn(async () => ({ status: 'ok' })),
}));
vi.mock('../platform/native/index', () => ({
  nativePlatformPromise: Promise.resolve(native),
}));
let now = 1000;
beforeEach(() => {
  now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  native.capability.mockReturnValue({ state: 'enabled' });
  native.hapticFeedback.mockClear();
  setHapticsUserEnabled(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  setHapticsUserEnabled(true);
});

describe('streaming haptics native dispatch', () => {
  test('dispatches selection pulses for live growth, throttles bursts, and keeps history silent', async () => {
    const { rerender } = renderHook(
      ({ id, length }) => useStreamingHaptics(id, length),
      { initialProps: { id: 'chat-1', length: 100 } },
    );
    await act(async () => {});
    expect(native.hapticFeedback).not.toHaveBeenCalled();
    rerender({ id: 'chat-1', length: 110 });
    await waitFor(() =>
      expect(native.hapticFeedback).toHaveBeenCalledExactlyOnceWith(
        'selection',
      ),
    );
    now += 100;
    rerender({ id: 'chat-1', length: 120 });
    await act(async () => {});
    expect(native.hapticFeedback).toHaveBeenCalledTimes(1);
    now += 220;
    rerender({ id: 'chat-1', length: 130 });
    await waitFor(() => expect(native.hapticFeedback).toHaveBeenCalledTimes(2));
    rerender({ id: 'chat-2', length: 800 });
    await act(async () => {});
    expect(native.hapticFeedback).toHaveBeenCalledTimes(2);
  });
  test.each(['disabled', 'unsupported'])(
    'does not pulse when %s',
    async (mode) => {
      if (mode === 'disabled') setHapticsUserEnabled(false);
      else native.capability.mockReturnValue({ state: 'unsupported' });
      const { rerender } = renderHook(
        ({ length }) => useStreamingHaptics('chat', length),
        { initialProps: { length: 0 } },
      );
      rerender({ length: 1 });
      await act(async () => {
        await import('../platform/native/index');
      });
      expect(native.hapticFeedback).not.toHaveBeenCalled();
    },
  );
});
