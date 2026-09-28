import type { NativeDiagnosticEchoInput } from '@kontourai/station-connect/native-diagnostic-echo';
import type { TauriInvoker } from './nativeRelaySignalingBridge';
import { createNativeRelaySignalingBridge } from './nativeRelaySignalingBridge';
import { invokeTauri } from './tauriInvoke';

const defaultInvoker: TauriInvoker = {
  invoke: (command, args) => invokeTauri<unknown>(command, args),
};

/**
 * Creates the explicit native diagnostic adapter for one exact saved-profile
 * revision. It is deliberately opt-in and does not mount application traffic.
 */
export async function createNativeDiagnosticEchoBridge(
  profileName: string,
  profileRevision: number,
  invoke: TauriInvoker = defaultInvoker,
): Promise<NativeDiagnosticEchoInput> {
  return createNativeRelaySignalingBridge({
    bindingCommand: 'station_native_relay_diagnostic_binding',
    openCommand: 'station_native_relay_signal_diagnostic_open',
    readCommand: 'station_native_relay_signal_diagnostic_read',
    errorPrefix: 'native_diagnostic',
    profileName,
    profileRevision,
    invoke,
  });
}
