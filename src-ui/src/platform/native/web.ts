import { validateNativeShareText } from './share';
import type {
  BundledServerStatus,
  HapticFeedbackKind,
  NativeBrowserPreviewGrantResult,
  NativeBrowserPreviewWindowResult,
  NativeCapabilityId,
  NativeCapabilityStatus,
  NativeCommandResult,
  NativeEventSubscription,
  NativePairingDeepLinkEvent,
  NativePlatformAdapter,
  NativePlatformError,
  NativeShareEvent,
  NativeStartupReadinessTicket,
  NativeTrayNavigationEvent,
  NativeWorkspacePanePopOutRequest,
} from './types';

const PWA_SHARE_PARAMETERS = ['share', 'text', 'url', 'title'] as const;

const WEB_CAPABILITIES: Record<NativeCapabilityId, NativeCapabilityStatus> = {
  'capability-report': {
    id: 'capability-report',
    state: 'unsupported',
    reason: 'Compile-target reports are available only from a native host.',
  },
  'desktop-tray': {
    id: 'desktop-tray',
    state: 'unsupported',
    reason: 'The web adapter has no desktop tray host.',
  },
  haptics: {
    id: 'haptics',
    state: 'unsupported',
    reason: 'Haptic feedback requires a native mobile host.',
  },
  'host-event-bridge': {
    id: 'host-event-bridge',
    state: 'unsupported',
    reason: 'The web adapter does not expose a native host event bridge.',
  },
  'local-browser-preview': {
    id: 'local-browser-preview',
    state: 'unsupported',
    reason:
      'Local browser previews require a reviewed native desktop host capability.',
  },
  'workspace-pane-pop-out': {
    id: 'workspace-pane-pop-out',
    state: 'unsupported',
    reason: 'Pane pop-out requires a supported native desktop host.',
  },
  'pairing-deep-link': {
    id: 'pairing-deep-link',
    state: 'unsupported',
    reason:
      'Station pairing deep links require a reviewed native host association.',
  },
  'host-credential-broker': {
    id: 'host-credential-broker',
    state: 'unsupported',
    reason: 'Web sessions cannot invoke the native credential broker.',
  },
  'native-consent-broker': {
    id: 'native-consent-broker',
    state: 'unsupported',
    reason:
      'Browsers decide approvals on the distinct-origin consent page, not in native chrome.',
  },
  'remote-push': {
    id: 'remote-push',
    state: 'unsupported',
    reason: 'Closed-app native delivery is unavailable in the web adapter.',
  },
  'share-intake': {
    id: 'share-intake',
    state: 'enabled',
    reason: 'PWA share-target URL parameters are handled by the web adapter.',
  },
};

/**
 * Reads and consumes the existing PWA share-target URL shape. URLSearchParams
 * already decodes values, so this deliberately avoids a second decode step.
 */
export function consumePwaShareUrl(location: Location): string | null {
  const params = new URLSearchParams(location.search);
  const value = PWA_SHARE_PARAMETERS.map((name) => params.get(name)).find(
    (candidate): candidate is string => Boolean(candidate),
  );

  if (!value) return null;

  for (const name of PWA_SHARE_PARAMETERS) params.delete(name);
  const cleanUrl =
    location.pathname +
    (params.toString() ? `?${params.toString()}` : '') +
    location.hash;
  window.history.replaceState(null, '', cleanUrl);
  return value;
}

export class WebNativePlatformAdapter implements NativePlatformAdapter {
  readonly platform = 'web' as const;

  capability(id: NativeCapabilityId): NativeCapabilityStatus {
    return WEB_CAPABILITIES[id];
  }

  async getCapabilityReport(): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'capability-report',
      reason: WEB_CAPABILITIES['capability-report'].reason,
    };
  }

  subscribeToShare(
    listener: (event: NativeShareEvent) => void,
    onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription {
    const pwaShare = consumePwaShareUrl(window.location);
    if (pwaShare) {
      const validated = validateNativeShareText(pwaShare);
      if (validated.status === 'ok') {
        listener({
          type: 'share-received',
          source: 'pwa-share-target',
          text: validated.text,
        });
      } else if (validated.status === 'error') {
        onError?.(validated.error);
      }
    }

    return { dispose() {} };
  }

  subscribeToPairingDeepLinks(
    _listener: (event: NativePairingDeepLinkEvent) => void,
    _onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription {
    return { dispose() {} };
  }

  subscribeToTrayNavigation(
    _listener: (event: NativeTrayNavigationEvent) => void,
    _onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription {
    return { dispose() {} };
  }

  async getBundledServerStatus(): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'bundled-server-status',
      reason: 'The web adapter has no bundled Station server to supervise.',
    };
  }

  async openDesktopTrayMenu(): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'open-desktop-tray-menu',
      reason: 'The web adapter has no desktop tray menu.',
    };
  }

  subscribeToBundledServerStatus(
    _listener: (status: BundledServerStatus) => void,
    _onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription {
    return { dispose() {} };
  }

  async restartBundledServer(): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'restart-bundled-server',
      reason: 'The web adapter has no bundled Station server to restart.',
    };
  }

  async commitStartupReadiness(
    _ticket: NativeStartupReadinessTicket,
  ): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'restart-bundled-server',
      reason: 'The web adapter has no native main window to reveal.',
    };
  }

  async commitStartupRecoveryUi(): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'commit-startup-recovery-ui',
      reason: 'The web adapter has no native main window to reveal.',
    };
  }

  subscribeToStartupReadinessRetry(
    _listener: () => void,
  ): NativeEventSubscription {
    return { dispose() {} };
  }

  async reviewConsentNatively(
    _requestId: string,
  ): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'review-consent-natively',
      reason: WEB_CAPABILITIES['native-consent-broker'].reason,
    };
  }

  async openLocalBrowserPreview(
    _url: string,
  ): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'open-local-browser-preview',
      reason: WEB_CAPABILITIES['local-browser-preview'].reason,
    };
  }

  async openExternalLink(_url: string): Promise<boolean> {
    // Web navigation is performed by the semantic host composition, not this
    // platform-blind adapter.
    return false;
  }

  async discoverLocalBrowserPreviewTarget(
    _url: string,
  ): Promise<NativeBrowserPreviewGrantResult> {
    return {
      status: 'unsupported',
      command: 'discover-local-browser-preview-target',
      reason:
        'Authoritative local-server discovery requires a supported desktop native host.',
    };
  }

  async openLocalBrowserPreviewWindow(
    _grantId: string,
  ): Promise<NativeBrowserPreviewWindowResult> {
    return {
      status: 'unsupported',
      command: 'open-local-browser-preview-window',
      reason:
        'Desktop Browser Preview is unavailable in the web host; use a supported desktop Station or open the target externally there.',
    };
  }

  async openWorkspacePanePopOut(
    _request: NativeWorkspacePanePopOutRequest,
  ): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'open-workspace-pane-pop-out',
      reason: WEB_CAPABILITIES['workspace-pane-pop-out'].reason,
    };
  }

  async hapticFeedback(
    _kind: HapticFeedbackKind,
  ): Promise<NativeCommandResult<never>> {
    return {
      status: 'unsupported',
      command: 'haptic-feedback',
      reason: WEB_CAPABILITIES.haptics.reason,
    };
  }
}
