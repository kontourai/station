/**
 * Platform-neutral boundary for host capabilities used by the React app.
 *
 * React features depend on this contract rather than a host SDK. New native
 * integrations must extend this boundary and report their availability here
 * before UI code can use them.
 */

export type NativePlatform = 'web' | 'tauri';

export type NativeCapabilityState =
  | 'enabled'
  | 'disabled'
  | 'unsupported'
  | 'permission-required';

export type NativeCapabilityId =
  | 'capability-report'
  | 'desktop-tray'
  | 'haptics'
  | 'host-event-bridge'
  | 'local-browser-preview'
  | 'workspace-pane-pop-out'
  | 'pairing-deep-link'
  | 'host-credential-broker'
  | 'native-consent-broker'
  | 'remote-push'
  | 'share-intake';

export interface NativeCapabilityStatus {
  id: NativeCapabilityId;
  state: NativeCapabilityState;
  reason: string;
  /** False when the Tauri host returned no usable capability report. */
  reportVerified?: boolean;
}

export type NativeCompileTarget =
  | 'android'
  | 'ios'
  | 'linux'
  | 'macos'
  | 'windows'
  | 'unknown';

export interface NativeCapabilityReport {
  platform: NativeCompileTarget;
  channel?: 'stable' | 'dev' | 'beta' | 'nightly';
  /** The one custom scheme registered by this native client channel. */
  pairingDeepLinkScheme?: string;
  capabilities: NativeCapabilityStatus[];
  /**
   * True for a development build. Absent from older hosts, so treat a missing
   * value as a release build rather than tinting a real install by accident.
   */
  devBuild?: boolean;
  /**
   * Secret-free HTTPS origin baked into a native-mobile build by its trusted
   * release environment. Saved/default profiles remain authoritative.
   */
  mobileDefaultEndpoint?: string;
}

export type NativeCommandName =
  | 'capability-report'
  | 'bundled-server-status'
  | 'haptic-feedback'
  | 'open-local-browser-preview'
  | 'discover-local-browser-preview-target'
  | 'open-local-browser-preview-window'
  | 'open-workspace-pane-pop-out'
  | 'open-desktop-tray-menu'
  | 'restart-bundled-server'
  | 'commit-renderer-mount'
  | 'commit-startup-readiness'
  | 'commit-startup-recovery-ui'
  | 'review-consent-natively';

/** Exact workspace identity admitted by a desktop pane pop-out request. */
export interface NativeWorkspacePanePopOutRequest {
  projectId: string;
  projectSlug: string;
  layoutId: string;
  descriptorId: string;
  instanceId: string;
}

/**
 * Ephemeral request data for the desktop-only Browser Preview renderer. This
 * intentionally is not a Workspace Pane contract: the selected endpoint and
 * native session cease to exist when the host action ends.
 */
export interface NativeBrowserPreviewGrant {
  /** Opaque, short-lived native handle; never write it to Pane state. */
  grantId: string;
  /** UTC epoch milliseconds for display/retry policy only. */
  expiresAtMs: number;
  /** Native-only observation made while selecting this exact target. */
  observation: NativeBrowserPreviewObservation;
}

export type NativeBrowserPreviewReachability =
  | 'reachable'
  | 'refused'
  | 'dns-failed'
  | 'unreachable'
  | 'not-observed';

export type NativeBrowserPreviewTlsStatus = 'not-applicable' | 'not-observed';

/**
 * This is an observation, not a browser-health assertion. A separate native
 * window can report its creation and installed navigation policy, but cannot
 * read a cross-origin document's final location, title, history, or frame.
 */
export interface NativeBrowserPreviewObservation {
  reachability: NativeBrowserPreviewReachability;
  tls: NativeBrowserPreviewTlsStatus;
  navigation: 'not-observed' | 'policy-installed';
  frame: 'not-applicable';
  renderer: 'not-created' | 'created-unverified';
  title: 'not-observable';
  history: 'not-observable';
}

export type NativeBrowserPreviewHostErrorCode =
  | 'authority-unavailable'
  | 'grant-consumed'
  | 'grant-expired'
  | 'invalid-grant'
  | 'invalid-target'
  | 'renderer-unavailable'
  | 'target-refused'
  | 'target-dns-failed'
  | 'target-unreachable';

/**
 * A separate native window can prove only admission and renderer creation.
 * It does not claim that the preview server is reachable or that a page
 * finished loading; those remain a browser-runtime observation.
 */
export type NativeBrowserPreviewWindowResult =
  | {
      status: 'ok';
      value: {
        sessionId: string;
        observation: NativeBrowserPreviewObservation;
      };
    }
  | {
      status: 'unsupported';
      command: 'open-local-browser-preview-window';
      reason: string;
    }
  | {
      status: 'error';
      command: 'open-local-browser-preview-window';
      code: NativeBrowserPreviewHostErrorCode;
      message: string;
      observation?: NativeBrowserPreviewObservation;
    };

export type NativeBrowserPreviewGrantResult =
  | { status: 'ok'; value: NativeBrowserPreviewGrant }
  | {
      status: 'unsupported';
      command: 'discover-local-browser-preview-target';
      reason: string;
    }
  | {
      status: 'error';
      command: 'discover-local-browser-preview-target';
      code: NativeBrowserPreviewHostErrorCode;
      message: string;
      observation?: NativeBrowserPreviewObservation;
    };

export type NativeBrowserPreviewHostResult =
  | NativeBrowserPreviewGrantResult
  | NativeBrowserPreviewWindowResult;

/** Discrete haptic kinds the native host accepts (archive#1954). */
export type HapticFeedbackKind =
  | 'selection'
  | 'light'
  | 'medium'
  | 'success'
  | 'error';

export type NativeCommandResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'unsupported'; command: NativeCommandName; reason: string }
  | { status: 'error'; command: NativeCommandName; message: string };

/** Lifecycle phase reported for the desktop-selected Station sidecar or service. */
export type BundledServerPhase =
  | 'starting'
  | 'running'
  | 'restarting'
  | 'failed'
  | 'stopped'
  | 'stopping';

/** The selected local owner for this desktop home. */
export type BundledServerOwnership = 'sidecar' | 'service' | 'none';

/**
 * Camel-cased mirror of the native host's `station://bundled-server-status`
 * payload. The native host is authoritative for liveness; the
 * browser never probes the loopback base directly.
 */
export interface BundledServerStatus {
  phase: BundledServerPhase;
  attempt: number;
  maxAttempts: number;
  apiBase: string | null;
  port: number | null;
  /** Exact sidecar child generation, absent outside a desktop-owned sidecar. */
  generation?: number | null;
  /** Stable server instance identity selected by the desktop host. */
  instanceId?: string | null;
  /** Per-child server boot identity; never fabricate one in the renderer. */
  bootId?: string | null;
  lastExitCode: number | null;
  nextRetryInMs: number | null;
  /**
   * The selected local owner's stdout (or combined) log file, when this
   * platform writes one to a known path. `null` — never an
   * empty string standing in for "unknown" — when no such file exists (e.g.
   * systemd/journald on Linux, which logs to the journal only) (archive#1899).
   */
  logPath: string | null;
  /**
   * The stderr log, where a crashing server's actual error lands, when this
   * platform's service manager writes stdout/stderr to separate files
   * (launchd only). `undefined` on an older host that predates this field
   * (archive#1571); `null` when the host resolved status but no separate stderr
   * file exists on this platform (archive#1899).
   */
  errorLogPath?: string | null;
  /**
   * The desktop shell's OWN log file (this process, not the supervised
   * per-user service) — present so a support flow can find it even when the
   * per-user service never got far enough to log anything (archive#1899).
   * `undefined` on an older host that predates this field.
   */
  desktopLogPath?: string | null;
  ownership: BundledServerOwnership;
  canRunInBackground: boolean;
  /**
   * True when the host classified the last exit as fail-closed (retrying
   * cannot succeed). Computed once in the supervisor; the UI must read it
   * rather than re-deriving from stderr text (archive#1571).
   */
  failClosed: boolean;
  message: string;
  detail?: string | null;
}

export interface NativeStartupReadinessTicket {
  generation: number;
  instanceId: string;
  bootId: string;
  apiBase: string;
}

export interface NativeShareEvent {
  type: 'share-received';
  source: 'host-event' | 'pwa-share-target';
  text: string;
}

/** A validated URL delivered through the reviewed Station pairing association. */
export interface NativePairingDeepLinkEvent {
  url: string;
}
export type NativeTrayNavigationDestination =
  | 'connections'
  | 'pairedDevices'
  | 'coreUpdates';
export interface NativeTrayNavigationEvent {
  destination: NativeTrayNavigationDestination;
}

export interface NativePlatformError {
  code: 'listener-registration-failed' | 'share-too-large';
  message: string;
}

export interface NativeEventSubscription {
  dispose(): void;
}

export interface NativePlatformAdapter {
  readonly platform: NativePlatform;
  capability(id: NativeCapabilityId): NativeCapabilityStatus;
  getCapabilityReport(): Promise<NativeCommandResult<NativeCapabilityReport>>;
  subscribeToShare(
    listener: (event: NativeShareEvent) => void,
    onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription;
  /** Receive URLs opened through this client's reviewed pairing association. */
  subscribeToPairingDeepLinks(
    listener: (event: NativePairingDeepLinkEvent) => void,
    onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription;
  subscribeToTrayNavigation(
    listener: (event: NativeTrayNavigationEvent) => void,
    onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription;
  /** One-shot snapshot of the configured local service state. */
  getBundledServerStatus(): Promise<NativeCommandResult<BundledServerStatus>>;
  /** Reveal the desktop tray menu when the native indicator host supports it. */
  openDesktopTrayMenu(): Promise<NativeCommandResult<void>>;
  /** Subscribe to local-service lifecycle transitions. */
  subscribeToBundledServerStatus(
    listener: (status: BundledServerStatus) => void,
    onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription;
  /** Ask the native host to start the configured durable service. */
  restartBundledServer(): Promise<NativeCommandResult<void>>;
  /** Commit one post-React-layout mount from the exact main WebView. */
  commitRendererMount(): Promise<NativeCommandResult<void>>;
  /** Recheck and reveal the main window after the renderer commits its exact proof. */
  commitStartupReadiness(
    ticket: NativeStartupReadinessTicket,
  ): Promise<NativeCommandResult<void>>;
  commitStartupRecoveryUi(): Promise<NativeCommandResult<void>>;
  subscribeToStartupReadinessRetry(
    listener: () => void,
  ): NativeEventSubscription;
  /**
   * Ask the desktop host to open one revalidated loopback URL in the system
   * browser. The host, not the webview, owns this boundary.
   */
  openLocalBrowserPreview(url: string): Promise<NativeCommandResult<void>>;
  /** Opens one host-validated external URL outside the WebView. */
  openExternalLink(url: string): Promise<boolean>;
  /**
   * Resolves and probes one loopback target from the native service boundary,
   * then returns the only one-time grant that a desktop preview can consume.
   */
  discoverLocalBrowserPreviewTarget(
    url: string,
  ): Promise<NativeBrowserPreviewGrantResult>;
  /**
   * Open an isolated renderer using a one-time native grant. The renderer
   * never receives a caller-supplied target or endpoint identity.
   */
  openLocalBrowserPreviewWindow(
    grantId: string,
  ): Promise<NativeBrowserPreviewWindowResult>;
  /** Open one Station-routed desktop window for a catalog-issued pane occurrence. */
  openWorkspacePanePopOut(
    request: NativeWorkspacePanePopOutRequest,
  ): Promise<NativeCommandResult<void>>;
  /**
   * Fire a one-shot haptic pulse. Web and desktop hosts return
   * `unsupported`; mobile hosts that report the `haptics` capability as
   * enabled return `ok` after requesting the OS feedback (archive#1954).
   */
  hapticFeedback(kind: HapticFeedbackKind): Promise<NativeCommandResult<void>>;
  /**
   * Review and decide one consent transaction in native OS chrome
   * (archive#3677). The native host fetches the server-authored
   * description with its own local-grant credential, shows an OS dialog the
   * webview cannot script, commits the decision server-side, and returns
   * only the settled status. Web hosts return `unsupported` — they use the
   * distinct-origin consent page instead.
   */
  reviewConsentNatively(
    requestId: string,
  ): Promise<NativeCommandResult<NativeConsentOutcome>>;
}

/** The settled transaction status the native consent broker returns. */
export interface NativeConsentOutcome {
  status: string;
}
