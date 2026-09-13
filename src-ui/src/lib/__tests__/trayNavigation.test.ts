import { describe, expect, it, vi } from 'vitest';
import {
  subscribeToTrayNavigation,
  trayNavigationTarget,
} from '../trayNavigation';

describe('trayNavigationTarget', () => {
  it('maps only the fixed native tray destinations', () => {
    expect(trayNavigationTarget('connections')).toEqual({
      pathname: '/connections',
    });
    expect(trayNavigationTarget('coreUpdates')).toEqual({
      pathname: '/settings',
      params: { view: 'system', highlight: 'core-app-updates' },
    });
    expect(trayNavigationTarget('desktopUpdates')).toEqual({
      pathname: '/settings',
      params: { view: 'system', highlight: 'desktop-app-updates' },
    });
    expect(trayNavigationTarget('serverUpdates')).toEqual({
      pathname: '/settings',
      params: { view: 'system', highlight: 'core-app-updates' },
    });
  });

  it('keeps the desktop destination distinct from every server destination', () => {
    const desktop = trayNavigationTarget('desktopUpdates');
    const server = trayNavigationTarget('serverUpdates');
    const legacy = trayNavigationTarget('coreUpdates');
    expect(desktop).not.toEqual(server);
    expect(desktop).not.toEqual(legacy);
    // The pre-split alias keeps resolving to the same server card, so an
    // older native host cannot strand its replay.
    expect(server).toEqual(legacy);
  });

  it('routes all closed destinations and disposes the exact native subscription', async () => {
    let listener:
      | ((event: {
          destination:
            | 'connections'
            | 'pairedDevices'
            | 'coreUpdates'
            | 'desktopUpdates'
            | 'serverUpdates';
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
    listener?.({ destination: 'desktopUpdates' });
    listener?.({ destination: 'serverUpdates' });
    listener?.({ destination: 'pairedDevices' });
    expect(navigate).toHaveBeenCalledWith('/connections', undefined);
    expect(navigate).toHaveBeenCalledWith('/settings', {
      view: 'system',
      highlight: 'core-app-updates',
    });
    expect(navigate).toHaveBeenCalledWith('/settings', {
      view: 'system',
      highlight: 'desktop-app-updates',
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
      'desktopUpdates?next=https://example.com',
      { path: '/settings' },
      { destination: 'desktopUpdates' },
      null,
    ]) {
      expect(trayNavigationTarget(payload)).toBeNull();
    }
  });
});
