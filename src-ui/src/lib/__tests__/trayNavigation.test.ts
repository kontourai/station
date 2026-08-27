import { describe, expect, it, vi } from 'vitest';
import {
  subscribeToTrayNavigation,
  trayNavigationTarget,
} from '../trayNavigation';

describe('trayNavigationTarget', () => {
  it('maps only the two fixed native tray destinations', () => {
    expect(trayNavigationTarget('connections')).toEqual({
      pathname: '/connections',
    });
    expect(trayNavigationTarget('coreUpdates')).toEqual({
      pathname: '/settings',
      params: { view: 'system', highlight: 'core-app-updates' },
    });
  });

  it('routes all closed destinations and disposes the exact native subscription', async () => {
    let listener:
      | ((event: {
          destination: 'connections' | 'pairedDevices' | 'coreUpdates';
        }) => void)
      | undefined;
    const dispose = vi.fn();
    const native = Promise.resolve({
      subscribeToTrayNavigation: vi.fn((next) => {
        listener = next;
        return { dispose };
      }),
    });
    const navigate = vi.fn();
    const paired = vi.fn();
    const stop = subscribeToTrayNavigation(navigate, paired, native as never);
    await Promise.resolve();
    await Promise.resolve();
    listener?.({ destination: 'connections' });
    listener?.({ destination: 'coreUpdates' });
    listener?.({ destination: 'pairedDevices' });
    expect(navigate).toHaveBeenCalledWith('/connections', undefined);
    expect(navigate).toHaveBeenCalledWith('/settings', {
      view: 'system',
      highlight: 'core-app-updates',
    });
    expect(paired).toHaveBeenCalledOnce();
    stop();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('tolerates a rejected adapter promise and disposes a late registration', async () => {
    expect(() =>
      subscribeToTrayNavigation(
        vi.fn(),
        undefined,
        Promise.reject(new Error('no native')) as never,
      ),
    ).not.toThrow();
    let resolve!: (value: any) => void;
    const pending = new Promise<any>((next) => {
      resolve = next;
    });
    const dispose = vi.fn();
    const stop = subscribeToTrayNavigation(vi.fn(), undefined, pending);
    stop();
    resolve({ subscribeToTrayNavigation: () => ({ dispose }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects arbitrary paths, queries, and payload shapes', () => {
    for (const payload of [
      '/connections',
      'connections?next=https://example.com',
      { path: '/settings' },
      null,
    ]) {
      expect(trayNavigationTarget(payload)).toBeNull();
    }
  });
});
