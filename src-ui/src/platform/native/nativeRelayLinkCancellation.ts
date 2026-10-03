import { invokeTauri } from './tauriInvoke';

export async function cancelNativeRelayLink(pendingId: string): Promise<void> {
  await invokeTauri('station_native_relay_link_cancel', { pendingId });
}
