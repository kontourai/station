import type {
  NativeApplicationSignaling,
  NativeApplicationTrustOwner,
} from '@kontourai/station-connect/native-application';
import type { TauriInvoker } from './nativeRelaySignalingBridge';
import { createNativeRelaySignalingBridge } from './nativeRelaySignalingBridge';
import { invokeTauri } from './tauriInvoke';

const defaultInvoker: TauriInvoker = {
  invoke: (command, args) => invokeTauri<unknown>(command, args),
};

/**
 * Creates the explicit opt-in native application signaling adapter for one
 * exact saved-profile revision. It speaks only the three host application
 * relay commands, re-reads the host binding before every trust checkpoint,
 * and never requests or returns a broker bearer or private key. It does not
 * fetch application data and does not auto-connect; composing it into a live
 * transport is a separate, explicit step.
 */
export async function createNativeApplicationSignalingBridge(
  profileName: string,
  profileRevision: number,
  invoke: TauriInvoker = defaultInvoker,
): Promise<{
  signaling: NativeApplicationSignaling;
  trust: NativeApplicationTrustOwner;
}> {
  return createNativeRelaySignalingBridge({
    bindingCommand: 'station_native_relay_application_binding',
    openCommand: 'station_native_relay_application_open',
    readCommand: 'station_native_relay_application_read',
    errorPrefix: 'native_application',
    profileName,
    profileRevision,
    invoke,
  });
}
