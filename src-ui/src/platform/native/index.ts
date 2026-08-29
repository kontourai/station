import type { NativePlatformAdapter } from './types';
import { WebNativePlatformAdapter } from './web';

function hasTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    Object.hasOwn(window, '__TAURI_INTERNALS__')
  );
}

/**
 * The only host detector in the React application. Tauri's official runtime
 * marker is checked directly so the web entry does not eagerly bundle the
 * native IPC client. Platform selection must never infer execution from a
 * user agent.
 */
export async function createNativePlatformAdapter(
  detectTauri: () => boolean = hasTauriRuntime,
): Promise<NativePlatformAdapter> {
  if (!detectTauri()) return new WebNativePlatformAdapter();
  const { TauriNativePlatformAdapter } = await import('./tauri');
  return new TauriNativePlatformAdapter();
}

export const nativePlatformPromise = createNativePlatformAdapter();

export {
  decideStreamingHaptic,
  isHapticsUserEnabled,
  STREAMING_HAPTIC_THROTTLE_MS,
  setHapticsUserEnabled,
  triggerHaptic,
} from './haptics';
export {
  MAX_NATIVE_SHARE_TEXT_BYTES,
  validateNativeShareText,
} from './share';
export type {
  BundledServerPhase,
  BundledServerStatus,
  HapticFeedbackKind,
  NativeBrowserPreviewGrant,
  NativeBrowserPreviewGrantResponse,
  NativeBrowserPreviewGrantResult,
  NativeBrowserPreviewHostErrorCode,
  NativeBrowserPreviewHostResult,
  NativeBrowserPreviewObservation,
  NativeBrowserPreviewReachability,
  NativeBrowserPreviewTlsStatus,
  NativeBrowserPreviewWindowResponse,
  NativeBrowserPreviewWindowResult,
  NativeCapabilityId,
  NativeCapabilityReport,
  NativeCapabilityState,
  NativeCapabilityStatus,
  NativeCommandName,
  NativeCommandResult,
  NativeEventSubscription,
  NativePairingDeepLinkEvent,
  NativePlatform,
  NativePlatformAdapter,
  NativePlatformError,
  NativeShareEvent,
  NativeTrayNavigationEvent,
  NativeWorkspacePanePopOutRequest,
} from './types';
