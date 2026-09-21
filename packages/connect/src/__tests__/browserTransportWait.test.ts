import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  delayBrowserTransport,
  waitForBrowserTransport,
} from '../core/browserTransportWait.js';

afterEach(() => vi.useRealTimers());
describe('browser transport event ownership', () => {
  test('already-open subscription can finish synchronously and cleans once', async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    await expect(
      waitForBrowserTransport(abort.signal, (finish) => {
        finish();
        return cleanup;
      }),
    ).resolves.toBeUndefined();
    abort.abort();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  test('abort during subscription cleans the newly returned subscription', async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    await expect(
      waitForBrowserTransport(abort.signal, () => {
        abort.abort(new Error('retired'));
        return cleanup;
      }),
    ).rejects.toThrow('retired');
    expect(cleanup).toHaveBeenCalledOnce();
  });
  test('normal polling delays remove abort listeners', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    for (let count = 0; count < 40; count++) {
      const pending = delayBrowserTransport(abort.signal, 100);
      await vi.advanceTimersByTimeAsync(100);
      await pending;
    }
    expect(add).toHaveBeenCalledTimes(40);
    expect(remove).toHaveBeenCalledTimes(40);
    expect(vi.getTimerCount()).toBe(0);
  });
  test('abort and deadline reject and retire pending event listeners', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const pending = waitForBrowserTransport(
      new AbortController().signal,
      () => cleanup,
      25,
    );
    const result = expect(pending).rejects.toThrow('browser_transport_timeout');
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
