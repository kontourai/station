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
    const bridge: TauriEventBridge = {
      invoke: vi.fn(async (command) => {
        calls.push(`invoke:${command}`);
        return 'coreUpdates' as never;
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
    ]);
    expect(listener).toHaveBeenCalledWith({ destination: 'coreUpdates' });

    vi.mocked(bridge.invoke).mockResolvedValueOnce('connections' as never);
    wake?.({ payload: null });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenLastCalledWith({ destination: 'connections' });
    subscription.dispose();
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
