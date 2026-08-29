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

interface DocumentReadiness {
  readonly readyState: DocumentReadyState;
  addEventListener(
    type: 'DOMContentLoaded',
    listener: () => void,
    options: { once: true },
  ): void;
}

/**
 * Resolve the one host adapter after the document bootstrap boundary. The UI
 * entry is a head module, while Tauri installs its runtime globals through an
 * initialization script. Selecting during module evaluation can permanently
 * cache the web fallback before that script is observable in WKWebView.
 */
export function createNativePlatformPromise(
  create: () => Promise<NativePlatformAdapter> = () =>
    createNativePlatformAdapter(),
  documentTarget: DocumentReadiness | undefined = typeof document ===
  'undefined'
    ? undefined
    : document,
): Promise<NativePlatformAdapter> {
  if (documentTarget?.readyState !== 'loading') return create();
  return new Promise((resolve, reject) => {
    documentTarget.addEventListener(
      'DOMContentLoaded',
      () => {
        void create().then(resolve, reject);
      },
      { once: true },
    );
  });
}

export const nativePlatformPromise = createNativePlatformPromise();

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
  NativeBrowserPreviewGrantResult,
  NativeBrowserPreviewHostErrorCode,
  NativeBrowserPreviewHostResult,
  NativeBrowserPreviewObservation,
  NativeBrowserPreviewReachability,
  NativeBrowserPreviewTlsStatus,
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
