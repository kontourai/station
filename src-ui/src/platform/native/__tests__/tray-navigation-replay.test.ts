import { describe, expect, it, vi } from 'vitest';
import {
  type TauriEventBridge,
  type TauriEventHandler,
  TauriNativePlatformAdapter,
} from '../tauri';

describe('Tauri tray navigation replay', () => {
  it('subscribes before draining a destination queued before the renderer mounted', async () => {
    let wake: TauriEventHandler<unknown> | undefined;
    const calls: string[] = [];
    let replay = { id: 1, destination: 'coreUpdates' };
    const bridge: TauriEventBridge = {
      invoke: vi.fn(async (command, args) => {
        calls.push(`invoke:${command}`);
        if (command === 'ack_pending_tray_navigation') {
          expect(args).toEqual({ id: replay.id });
          return true as never;
        }
        return replay as never;
      }),
      listen: vi.fn(async (event, handler) => {
        calls.push(`listen:${event}`);
        wake = handler as TauriEventHandler<unknown>;
        return vi.fn();
      }),
    };
    const listener = vi.fn();
    const adapter = new TauriNativePlatformAdapter(bridge);

    const subscription = adapter.subscribeToTrayNavigation(listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(calls).toEqual([
      'listen:station://tray-navigation',
      'invoke:take_pending_tray_navigation',
      'invoke:ack_pending_tray_navigation',
    ]);
    expect(listener).toHaveBeenCalledWith({ destination: 'coreUpdates' });

    replay = { id: 2, destination: 'connections' };
    wake?.({ payload: null });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenLastCalledWith({ destination: 'connections' });
    subscription.dispose();
  });

  it('does not acknowledge a native replay lease when disposal wins the invoke race', async () => {
    let resolveReplay: ((value: unknown) => void) | undefined;
    const bridge: TauriEventBridge = {
      invoke: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveReplay = resolve;
          }) as never,
      ),
      listen: vi.fn().mockResolvedValue(vi.fn()),
    };
    const listener = vi.fn();
    const adapter = new TauriNativePlatformAdapter(bridge);

    const subscription = adapter.subscribeToTrayNavigation(listener);
    await vi.waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith(
        'take_pending_tray_navigation',
      ),
    );
    subscription.dispose();
    resolveReplay?.({ id: 7, destination: 'connections' });
    await Promise.resolve();
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
    expect(bridge.invoke).not.toHaveBeenCalledWith(
      'ack_pending_tray_navigation',
      expect.anything(),
    );
  });

  it('reports a failed pending-destination drain instead of dropping it silently', async () => {
    const bridge: TauriEventBridge = {
      invoke: vi.fn().mockRejectedValue(new Error('IPC unavailable')),
      listen: vi.fn().mockResolvedValue(vi.fn()),
    };
    const onError = vi.fn();
    const adapter = new TauriNativePlatformAdapter(bridge);

    adapter.subscribeToTrayNavigation(vi.fn(), onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith({
      code: 'listener-registration-failed',
      message: 'Station could not replay tray navigation: IPC unavailable',
    });
  });
});
