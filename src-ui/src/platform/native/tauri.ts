import { validateNativeShareText } from './share';
import { invokeTauri } from './tauriInvoke';
import type {
  BundledServerOwnership,
  BundledServerPhase,
  BundledServerStatus,
  HapticFeedbackKind,
  NativeBrowserPreviewGrantResult,
  NativeBrowserPreviewHostErrorCode,
  NativeBrowserPreviewObservation,
  NativeBrowserPreviewWindowResult,
  NativeCapabilityId,
  NativeCapabilityReport,
  NativeCapabilityStatus,
  NativeCommandResult,
  NativeConsentOutcome,
  NativeEventSubscription,
  NativePairingDeepLinkEvent,
  NativePlatformAdapter,
  NativePlatformError,
  NativeShareEvent,
  NativeStartupReadinessTicket,
  NativeTrayNavigationEvent,
  NativeWorkspacePanePopOutRequest,
} from './types';

export type TauriEventHandler<T> = (event: { payload: T }) => void;

export interface TauriEventBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: TauriEventHandler<T>): Promise<UnlistenFn>;
}

export interface TauriDeepLinkBridge {
  getCurrent(): Promise<string[]>;
  onOpenUrl(handler: (urls: string[]) => void): Promise<UnlistenFn>;
}

type UnlistenFn = () => void;

const TAURI_EVENT_BRIDGE: TauriEventBridge = {
  invoke: invokeTauri,
  async listen<T>(
    event: string,
    handler: TauriEventHandler<T>,
  ): Promise<UnlistenFn> {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<T>(event, handler);
  },
};

const TAURI_DEEP_LINK_BRIDGE: TauriDeepLinkBridge = {
  async getCurrent() {
    const { getCurrent } = await import('@tauri-apps/plugin-deep-link');
    return (await getCurrent()) ?? [];
  },
  async onOpenUrl(handler) {
    const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
    return onOpenUrl(handler);
  },
};

const INITIAL_TAURI_CAPABILITIES: Record<
  NativeCapabilityId,
  NativeCapabilityStatus
> = {
  'capability-report': {
    id: 'capability-report',
    state: 'enabled',
    reason: 'The native host exposes a compile-target capability report.',
  },
  'desktop-tray': {
    id: 'desktop-tray',
    state: 'disabled',
    reason:
      'Compile-target capability reports determine whether this desktop-only feature is enabled.',
  },
  haptics: {
    id: 'haptics',
    state: 'disabled',
    reason:
      'Compile-target capability reports determine whether mobile haptics are enabled.',
  },
  'host-event-bridge': {
    id: 'host-event-bridge',
    state: 'enabled',
    reason: 'The native host can deliver typed events through Tauri core.',
  },
  'local-browser-preview': {
    id: 'local-browser-preview',
    state: 'disabled',
    reason:
      'The native host must report desktop browser-preview support before it can be used.',
  },
  'workspace-pane-pop-out': {
    id: 'workspace-pane-pop-out',
    state: 'disabled',
    reason:
      'The native host must report desktop pane pop-out support before it can be used.',
  },
  'pairing-deep-link': {
    id: 'pairing-deep-link',
    state: 'disabled',
    reason:
      'Compile-target capability reports determine whether the reviewed pairing link association is enabled.',
  },
  'host-credential-broker': {
    id: 'host-credential-broker',
    state: 'disabled',
    reason:
      'The native host must report device-bound credential and request-broker support.',
  },
  'native-consent-broker': {
    id: 'native-consent-broker',
    state: 'disabled',
    reason:
      'Compile-target capability reports determine whether native consent review is enabled.',
  },
  'remote-push': {
    id: 'remote-push',
    state: 'unsupported',
    reason: 'Closed-app push requires provisioned APNs or FCM delivery.',
  },
  'share-intake': {
    id: 'share-intake',
    state: 'disabled',
    reason:
      'No reviewed native share-target or deep-link receiver is enabled yet.',
  },
};

const CAPABILITY_IDS: NativeCapabilityId[] = [
  'capability-report',
  'desktop-tray',
  'haptics',
  'host-event-bridge',
  'local-browser-preview',
  'workspace-pane-pop-out',
  'pairing-deep-link',
  'host-credential-broker',
  'native-consent-broker',
  'remote-push',
  'share-intake',
];
// `native-consent-broker` is deliberately NOT required: a UI served by a
// newer Station must still verify an older shell's report (archive#3677).
const REQUIRED_CAPABILITY_IDS: NativeCapabilityId[] = [
  'capability-report',
  'desktop-tray',
  'haptics',
  'host-event-bridge',
  'local-browser-preview',
  'pairing-deep-link',
  'host-credential-broker',
  'remote-push',
  'share-intake',
];

const HAPTIC_KINDS = new Set<HapticFeedbackKind>([
  'selection',
  'light',
  'medium',
  'success',
  'error',
]);
const CAPABILITY_STATES = new Set([
  'enabled',
  'disabled',
  'unsupported',
  'permission-required',
]);
const COMPILE_TARGETS = new Set([
  'android',
  'ios',
  'linux',
  'macos',
  'windows',
  'unknown',
]);
const BROWSER_PREVIEW_HOST_ERROR_CODES =
  new Set<NativeBrowserPreviewHostErrorCode>([
    'authority-unavailable',
    'grant-consumed',
    'grant-expired',
    'invalid-grant',
    'invalid-target',
    'renderer-unavailable',
    'target-refused',
    'target-dns-failed',
    'target-unreachable',
  ]);

const BROWSER_PREVIEW_REACHABILITY = new Set([
  'reachable',
  'refused',
  'dns-failed',
  'unreachable',
  'not-observed',
]);

function parseBrowserPreviewObservation(
  value: unknown,
): NativeBrowserPreviewObservation | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.reachability !== 'string' ||
    !BROWSER_PREVIEW_REACHABILITY.has(candidate.reachability) ||
    (candidate.tls !== 'not-applicable' && candidate.tls !== 'not-observed') ||
    (candidate.navigation !== 'not-observed' &&
      candidate.navigation !== 'policy-installed') ||
    candidate.frame !== 'not-applicable' ||
    (candidate.renderer !== 'not-created' &&
      candidate.renderer !== 'created-unverified') ||
    candidate.title !== 'not-observable' ||
    candidate.history !== 'not-observable'
  )
    return null;
  return candidate as unknown as NativeBrowserPreviewObservation;
}

const UNOBSERVED_BROWSER_PREVIEW: NativeBrowserPreviewObservation = {
  reachability: 'not-observed',
  tls: 'not-observed',
  navigation: 'not-observed',
  frame: 'not-applicable',
  renderer: 'not-created',
  title: 'not-observable',
  history: 'not-observable',
};

function parseBrowserPreviewWindowResponse(
  value: unknown,
): NativeBrowserPreviewWindowResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.status === 'opened' &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    parseBrowserPreviewObservation(candidate.observation)
  ) {
    return {
      status: 'ok',
      value: {
        sessionId: candidate.sessionId,
        observation: parseBrowserPreviewObservation(candidate.observation)!,
      },
    };
  }
  if (
    candidate.status === 'rejected' &&
    typeof candidate.code === 'string' &&
    BROWSER_PREVIEW_HOST_ERROR_CODES.has(
      candidate.code as NativeBrowserPreviewHostErrorCode,
    ) &&
    typeof candidate.message === 'string' &&
    candidate.message.length > 0
  ) {
    return {
      status: 'error',
      command: 'open-local-browser-preview-window',
      code: candidate.code as NativeBrowserPreviewHostErrorCode,
      message: candidate.message,
    };
  }
  return null;
}

function parseBrowserPreviewGrantResponse(
  value: unknown,
  command: 'discover-local-browser-preview-target',
): NativeBrowserPreviewGrantResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.status === 'issued' &&
    typeof candidate.grantId === 'string' &&
    candidate.grantId.length > 0 &&
    typeof candidate.expiresAtMs === 'number' &&
    Number.isSafeInteger(candidate.expiresAtMs)
  ) {
    return {
      status: 'ok',
      value: {
        grantId: candidate.grantId,
        expiresAtMs: candidate.expiresAtMs,
        observation:
          parseBrowserPreviewObservation(candidate.observation) ??
          UNOBSERVED_BROWSER_PREVIEW,
      },
    };
  }
  if (
    candidate.status === 'rejected' &&
    typeof candidate.code === 'string' &&
    BROWSER_PREVIEW_HOST_ERROR_CODES.has(
      candidate.code as NativeBrowserPreviewHostErrorCode,
    ) &&
    typeof candidate.message === 'string' &&
    candidate.message.length > 0
  ) {
    return {
      status: 'error',
      command,
      code: candidate.code as NativeBrowserPreviewHostErrorCode,
      message: candidate.message,
      ...(parseBrowserPreviewObservation(candidate.observation)
        ? {
            observation: parseBrowserPreviewObservation(candidate.observation)!,
          }
        : {}),
    };
  }
  return null;
}

function parseCapabilityReport(value: unknown): NativeCapabilityReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.platform !== 'string' ||
    !COMPILE_TARGETS.has(candidate.platform) ||
    !Array.isArray(candidate.capabilities)
  ) {
    return null;
  }

  const capabilities = candidate.capabilities.filter(
    (capability): capability is NativeCapabilityStatus =>
      typeof capability === 'object' &&
      capability !== null &&
      typeof capability.id === 'string' &&
      CAPABILITY_IDS.includes(capability.id as NativeCapabilityId) &&
      typeof capability.state === 'string' &&
      CAPABILITY_STATES.has(capability.state) &&
      typeof capability.reason === 'string' &&
      capability.reason.length > 0,
  );
  const ids = capabilities.map(({ id }) => id);
  if (
    capabilities.length !== candidate.capabilities.length ||
    new Set(ids).size !== capabilities.length ||
    !REQUIRED_CAPABILITY_IDS.every((id) => ids.includes(id))
  ) {
    return null;
  }

  let mobileDefaultEndpoint: string | undefined;
  if (typeof candidate.mobileDefaultEndpoint === 'string') {
    try {
      const endpoint = new URL(candidate.mobileDefaultEndpoint);
      if (
        endpoint.protocol === 'https:' &&
        !endpoint.username &&
        !endpoint.password &&
        endpoint.origin === candidate.mobileDefaultEndpoint
      ) {
        mobileDefaultEndpoint = endpoint.origin;
      }
    } catch {
      // Invalid optional bootstrap metadata is ignored fail-closed. The rest
      // of the capability report remains useful and the pairing UI remains.
    }
  }
  return {
    platform: candidate.platform as NativeCapabilityReport['platform'],
    channel:
      typeof candidate.channel === 'string' &&
      ['stable', 'dev', 'beta', 'nightly'].includes(candidate.channel)
        ? (candidate.channel as NativeCapabilityReport['channel'])
        : undefined,
    capabilities,
    // Older hosts omit this. Only a literal `true` marks a dev build, so an
    // absent or malformed value reads as release rather than tinting a real
    // install. Dropping it here silently disabled the dev tint entirely.
    devBuild: candidate.devBuild === true,
    ...(mobileDefaultEndpoint ? { mobileDefaultEndpoint } : {}),
  };
}

const BUNDLED_SERVER_PHASES = new Set<BundledServerPhase>([
  'starting',
  'running',
  'restarting',
  'failed',
  'stopped',
  'stopping',
]);

const BUNDLED_SERVER_OWNERSHIPS = new Set<BundledServerOwnership>([
  'sidecar',
  'service',
  'none',
]);

function isNullableInteger(value: unknown): boolean {
  return (
    value === null || (typeof value === 'number' && Number.isInteger(value))
  );
}

function isNullableNumber(value: unknown): boolean {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Defensive validator for the native host's bundled-server status payload,
 * mirroring parseCapabilityReport: an untrusted host must never inject an
 * arbitrary shape into React state.
 */
function parseBundledServerStatus(value: unknown): BundledServerStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.phase !== 'string' ||
    !BUNDLED_SERVER_PHASES.has(candidate.phase as BundledServerPhase) ||
    !Number.isInteger(candidate.attempt) ||
    !Number.isInteger(candidate.maxAttempts) ||
    typeof candidate.ownership !== 'string' ||
    !BUNDLED_SERVER_OWNERSHIPS.has(
      candidate.ownership as BundledServerOwnership,
    ) ||
    typeof candidate.canRunInBackground !== 'boolean' ||
    !(candidate.logPath === null || typeof candidate.logPath === 'string') ||
    typeof candidate.message !== 'string' ||
    !(candidate.apiBase === null || typeof candidate.apiBase === 'string') ||
    !isNullableInteger(candidate.port) ||
    !(
      candidate.generation === undefined ||
      isNullableInteger(candidate.generation)
    ) ||
    !(
      candidate.instanceId === null ||
      candidate.instanceId === undefined ||
      typeof candidate.instanceId === 'string'
    ) ||
    !(
      candidate.bootId === null ||
      candidate.bootId === undefined ||
      typeof candidate.bootId === 'string'
    ) ||
    !isNullableInteger(candidate.lastExitCode) ||
    !isNullableNumber(candidate.nextRetryInMs) ||
    !(
      candidate.detail === undefined ||
      candidate.detail === null ||
      typeof candidate.detail === 'string'
    ) ||
    !(
      candidate.errorLogPath === undefined ||
      candidate.errorLogPath === null ||
      typeof candidate.errorLogPath === 'string'
    ) ||
    !(
      candidate.desktopLogPath === undefined ||
      candidate.desktopLogPath === null ||
      typeof candidate.desktopLogPath === 'string'
    ) ||
    typeof candidate.failClosed !== 'boolean'
  ) {
    return null;
  }
  return {
    phase: candidate.phase as BundledServerPhase,
    attempt: candidate.attempt as number,
    maxAttempts: candidate.maxAttempts as number,
    apiBase: candidate.apiBase as string | null,
    port: candidate.port as number | null,
    ...(candidate.generation === undefined
      ? {}
      : { generation: candidate.generation as number | null }),
    ...(candidate.instanceId === undefined
      ? {}
      : { instanceId: candidate.instanceId as string | null }),
    ...(candidate.bootId === undefined
      ? {}
      : { bootId: candidate.bootId as string | null }),
    lastExitCode: candidate.lastExitCode as number | null,
    nextRetryInMs: candidate.nextRetryInMs as number | null,
    logPath: candidate.logPath as string | null,
    // Older hosts omit these; normalize so consumers see one stable shape.
    errorLogPath: (candidate.errorLogPath ?? null) as string | null,
    desktopLogPath: (candidate.desktopLogPath ?? null) as string | null,
    ownership: candidate.ownership as BundledServerOwnership,
    canRunInBackground: candidate.canRunInBackground,
    failClosed: candidate.failClosed,
    message: candidate.message,
    detail: (candidate.detail ?? null) as string | null,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/** The sole Tauri SDK adapter for Station's React application. */
export class TauriNativePlatformAdapter implements NativePlatformAdapter {
  readonly platform = 'tauri' as const;
  private capabilityReportReadFailed = false;
  private capabilities = Object.fromEntries(
    Object.entries(INITIAL_TAURI_CAPABILITIES).map(([id, status]) => [
      id,
      { ...status },
    ]),
  ) as Record<NativeCapabilityId, NativeCapabilityStatus>;

  constructor(
    private readonly bridge: TauriEventBridge = TAURI_EVENT_BRIDGE,
    private readonly deepLinkBridge: TauriDeepLinkBridge = TAURI_DEEP_LINK_BRIDGE,
  ) {}

  capability(id: NativeCapabilityId): NativeCapabilityStatus {
    return {
      ...this.capabilities[id],
      ...(this.capabilityReportReadFailed ? { reportVerified: false } : {}),
    };
  }

  async getCapabilityReport(): Promise<
    NativeCommandResult<NativeCapabilityReport>
  > {
    try {
      const report = parseCapabilityReport(
        await this.bridge.invoke<unknown>('native_capability_report'),
      );
      if (!report) {
        this.capabilityReportReadFailed = true;
        return {
          status: 'error',
          command: 'capability-report',
          message: 'The native host returned an invalid capability report.',
        };
      }
      this.capabilities = {
        ...INITIAL_TAURI_CAPABILITIES,
        ...Object.fromEntries(
          report.capabilities.map((capability) => [
            capability.id,
            { ...capability },
          ]),
        ),
      } as Record<NativeCapabilityId, NativeCapabilityStatus>;
      this.capabilityReportReadFailed = false;
      return {
        status: 'ok',
        value: report,
      };
    } catch (error) {
      this.capabilityReportReadFailed = true;
      return {
        status: 'error',
        command: 'capability-report',
        message: errorMessage(error),
      };
    }
  }

  subscribeToShare(
    listener: (event: NativeShareEvent) => void,
    onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void this.bridge
      .listen<unknown>('station://share-received', ({ payload }) => {
        if (disposed) return;
        if (typeof payload !== 'object' || payload === null) return;
        const validated = validateNativeShareText(
          (payload as Record<string, unknown>).text,
        );
        if (validated.status === 'ok') {
          listener({
            type: 'share-received',
            source: 'host-event',
            text: validated.text,
          });
        } else if (validated.status === 'error') {
          onError?.(validated.error);
        }
      })
      .then((registeredUnlisten) => {
        unlisten = registeredUnlisten;
        if (disposed) unlisten();
      })
      .catch((error) => {
        if (disposed) return;
        const message = errorMessage(error);
        this.capabilities['host-event-bridge'] = {
          id: 'host-event-bridge',
          state: 'permission-required',
          reason: message,
        };
        onError?.({
          code: 'listener-registration-failed',
          message: `Station could not receive native share events: ${message}`,
        });
      });

    return {
      dispose() {
        disposed = true;
        unlisten?.();
      },
    };
  }

  subscribeToPairingDeepLinks(
    listener: (event: NativePairingDeepLinkEvent) => void,
    onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    const emit = (urls: string[]) => {
      if (disposed) return;
      for (const url of urls) listener({ url });
    };

    void this.deepLinkBridge
      .onOpenUrl(emit)
      .then((registeredUnlisten) => {
        if (disposed) {
          registeredUnlisten();
          return;
        }
        unlisten = registeredUnlisten;
        // Register the active listener first so a link cannot fall between
        // launch discovery and subscription. If launch discovery then fails,
        // the shared rejection path below tears this successful listener down.
        return this.deepLinkBridge.getCurrent().then(emit);
      })
      .catch((error) => {
        if (disposed) return;
        unlisten?.();
        unlisten = undefined;
        const message = errorMessage(error);
        this.capabilities['pairing-deep-link'] = {
          id: 'pairing-deep-link',
          state: 'permission-required',
          reason: message,
        };
        onError?.({
          code: 'listener-registration-failed',
          message: `Station could not receive pairing links: ${message}`,
        });
      });

    return {
      dispose() {
        disposed = true;
        unlisten?.();
      },
    };
  }

  subscribeToTrayNavigation(
    listener: (event: NativeTrayNavigationEvent) => void,
    onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let drainInFlight = false;
    let drainAgain = false;
    const drainPending = () => {
      if (disposed) return;
      if (drainInFlight) {
        drainAgain = true;
        return;
      }
      drainInFlight = true;
      void this.bridge
        .invoke<unknown>('take_pending_tray_navigation')
        .then(async (replay) => {
          if (disposed || typeof replay !== 'object' || replay === null) return;
          const { id, destination } = replay as Record<string, unknown>;
          if (
            !Number.isSafeInteger(id) ||
            (destination !== 'connections' &&
              destination !== 'pairedDevices' &&
              destination !== 'coreUpdates')
          ) {
            return;
          }
          // Acknowledgement consumes the single native lease before user code
          // can navigate or dispose this subscription. Delivery is best effort
          // after that at-most-once handoff.
          await this.bridge.invoke<unknown>('ack_pending_tray_navigation', {
            id,
          });
          if (disposed) return;
          listener({ destination });
        })
        .catch((error) => {
          if (!disposed)
            onError?.({
              code: 'listener-registration-failed',
              message: `Station could not replay tray navigation: ${errorMessage(error)}`,
            });
        })
        .finally(() => {
          drainInFlight = false;
          if (drainAgain && !disposed) {
            drainAgain = false;
            drainPending();
          }
        });
    };
    void this.bridge
      .listen('station://tray-navigation', () => {
        void drainPending();
      })
      .then((registered) => {
        unlisten = registered;
        if (disposed) {
          unlisten();
          return;
        }
        // Subscribe first, then drain. A click before subscription is retained
        // natively; a click after subscription wakes this same drain path.
        void drainPending();
      })
      .catch((error) => {
        if (!disposed)
          onError?.({
            code: 'listener-registration-failed',
            message: `Station could not receive tray navigation: ${errorMessage(error)}`,
          });
      });
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        unlisten?.();
      },
    };
  }

  async getBundledServerStatus(): Promise<
    NativeCommandResult<BundledServerStatus>
  > {
    try {
      const status = parseBundledServerStatus(
        await this.bridge.invoke<unknown>('bundled_server_status'),
      );
      if (!status) {
        return {
          status: 'error',
          command: 'bundled-server-status',
          message: 'The native host returned an invalid bundled-server status.',
        };
      }
      return { status: 'ok', value: status };
    } catch (error) {
      return {
        status: 'error',
        command: 'bundled-server-status',
        message: errorMessage(error),
      };
    }
  }

  async openDesktopTrayMenu(): Promise<NativeCommandResult<void>> {
    try {
      const opened = await this.bridge.invoke<unknown>(
        'open_desktop_tray_menu',
      );
      if (opened === true) return { status: 'ok', value: undefined };
      if (opened === false) {
        return {
          status: 'unsupported',
          command: 'open-desktop-tray-menu',
          reason:
            'This desktop environment opens the Station menu from its system tray indicator.',
        };
      }
      return {
        status: 'error',
        command: 'open-desktop-tray-menu',
        message: 'The native host returned an invalid tray-menu result.',
      };
    } catch (error) {
      return {
        status: 'error',
        command: 'open-desktop-tray-menu',
        message: errorMessage(error),
      };
    }
  }

  subscribeToBundledServerStatus(
    listener: (status: BundledServerStatus) => void,
    onError?: (error: NativePlatformError) => void,
  ): NativeEventSubscription {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void this.bridge
      .listen<unknown>('station://bundled-server-status', ({ payload }) => {
        if (disposed) return;
        const status = parseBundledServerStatus(payload);
        if (status) listener(status);
      })
      .then((registeredUnlisten) => {
        unlisten = registeredUnlisten;
        if (disposed) unlisten();
      })
      .catch((error) => {
        if (disposed) return;
        onError?.({
          code: 'listener-registration-failed',
          message: `Station could not receive bundled-server status: ${errorMessage(error)}`,
        });
      });

    return {
      dispose() {
        disposed = true;
        unlisten?.();
      },
    };
  }

  async restartBundledServer(): Promise<NativeCommandResult<void>> {
    try {
      await this.bridge.invoke<unknown>('restart_bundled_server');
      return { status: 'ok', value: undefined };
    } catch (error) {
      return {
        status: 'error',
        command: 'restart-bundled-server',
        message: errorMessage(error),
      };
    }
  }

  async commitStartupReadiness(
    ticket: NativeStartupReadinessTicket,
  ): Promise<NativeCommandResult<void>> {
    try {
      await this.bridge.invoke<unknown>('commit_startup_readiness', { ticket });
      return { status: 'ok', value: undefined };
    } catch (error) {
      return {
        status: 'error',
        command: 'commit-startup-readiness',
        message: errorMessage(error),
      };
    }
  }

  async commitRendererMount(): Promise<NativeCommandResult<void>> {
    try {
      await this.bridge.invoke<unknown>('commit_renderer_mount');
      return { status: 'ok', value: undefined };
    } catch (error) {
      return {
        status: 'error',
        command: 'commit-renderer-mount',
        message: errorMessage(error),
      };
    }
  }

  async commitStartupRecoveryUi(): Promise<NativeCommandResult<void>> {
    try {
      await this.bridge.invoke<unknown>('commit_startup_recovery_ui');
      return { status: 'ok', value: undefined };
    } catch (error) {
      return {
        status: 'error',
        command: 'commit-startup-recovery-ui',
        message: errorMessage(error),
      };
    }
  }

  subscribeToStartupReadinessRetry(
    listener: () => void,
  ): NativeEventSubscription {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void this.bridge
      .listen('station://startup-readiness-retry', () => {
        if (!disposed) listener();
      })
      .then((value) => {
        unlisten = value;
        if (disposed) value();
      });
    return {
      dispose() {
        disposed = true;
        unlisten?.();
      },
    };
  }

  async openLocalBrowserPreview(
    url: string,
  ): Promise<NativeCommandResult<void>> {
    const capability = this.capabilities['local-browser-preview'];
    if (capability.state !== 'enabled') {
      return {
        status: 'unsupported',
        command: 'open-local-browser-preview',
        reason: capability.reason,
      };
    }
    try {
      await this.bridge.invoke<unknown>('open_local_browser_preview', { url });
      return { status: 'ok', value: undefined };
    } catch (error) {
      return {
        status: 'error',
        command: 'open-local-browser-preview',
        message: errorMessage(error),
      };
    }
  }

  async openExternalLink(url: string): Promise<boolean> {
    try {
      await this.bridge.invoke<unknown>('open_external_link', { url });
      return true;
    } catch {
      return false;
    }
  }

  async discoverLocalBrowserPreviewTarget(
    url: string,
  ): Promise<NativeBrowserPreviewGrantResult> {
    const capability = this.capabilities['local-browser-preview'];
    if (capability.state !== 'enabled') {
      return {
        status: 'unsupported',
        command: 'discover-local-browser-preview-target',
        reason: capability.reason,
      };
    }
    try {
      const response = parseBrowserPreviewGrantResponse(
        await this.bridge.invoke<unknown>(
          'discover_local_browser_preview_target',
          { url },
        ),
        'discover-local-browser-preview-target',
      );
      if (response) return response;
      return {
        status: 'error',
        command: 'discover-local-browser-preview-target',
        code: 'renderer-unavailable',
        message:
          'The native host returned an invalid local Browser Preview discovery result.',
      };
    } catch (error) {
      return {
        status: 'error',
        command: 'discover-local-browser-preview-target',
        code: 'renderer-unavailable',
        message: errorMessage(error),
      };
    }
  }

  async openLocalBrowserPreviewWindow(
    grantId: string,
  ): Promise<NativeBrowserPreviewWindowResult> {
    const capability = this.capabilities['local-browser-preview'];
    if (capability.state !== 'enabled') {
      return {
        status: 'unsupported',
        command: 'open-local-browser-preview-window',
        reason: capability.reason,
      };
    }
    try {
      const response = parseBrowserPreviewWindowResponse(
        await this.bridge.invoke<unknown>('open_local_browser_preview_window', {
          grantId,
        }),
      );
      if (response) return response;
      return {
        status: 'error',
        command: 'open-local-browser-preview-window',
        code: 'renderer-unavailable',
        message:
          'The native host returned an invalid Browser Preview response.',
      };
    } catch (error) {
      return {
        status: 'error',
        command: 'open-local-browser-preview-window',
        code: 'renderer-unavailable',
        message: errorMessage(error),
      };
    }
  }

  async openWorkspacePanePopOut(
    request: NativeWorkspacePanePopOutRequest,
  ): Promise<NativeCommandResult<void>> {
    const capability = this.capabilities['workspace-pane-pop-out'];
    if (capability.state !== 'enabled') {
      return {
        status: 'unsupported',
        command: 'open-workspace-pane-pop-out',
        reason: capability.reason,
      };
    }
    try {
      await this.bridge.invoke<unknown>('open_workspace_pane_pop_out', {
        request,
      });
      return { status: 'ok', value: undefined };
    } catch (error) {
      return {
        status: 'error',
        command: 'open-workspace-pane-pop-out',
        message: errorMessage(error),
      };
    }
  }

  async hapticFeedback(
    kind: HapticFeedbackKind,
  ): Promise<NativeCommandResult<void>> {
    if (!HAPTIC_KINDS.has(kind)) {
      return {
        status: 'error',
        command: 'haptic-feedback',
        message: `Unknown haptic kind: ${String(kind)}`,
      };
    }
    if (this.capabilities.haptics.state !== 'enabled') {
      return {
        status: 'unsupported',
        command: 'haptic-feedback',
        reason: this.capabilities.haptics.reason,
      };
    }
    try {
      // Official Tauri mobile plugin (same class as notification). Kept inside
      // the platform adapter so feature code never imports Tauri directly.
      //
      // `ImpactFeedbackStyle`/`NotificationFeedbackType` used to be runtime
      // enum objects (`ImpactFeedbackStyle.Light`); the plugin now generates
      // them as plain string-literal TYPES only (`dist-js/bindings.d.ts`:
      // `export type ImpactFeedbackStyle = 'light' | 'medium' |...`), with
      // no matching runtime export in `dist-js/index.js` at all — so the old
      // `.Light`/`.Medium`/`.Success`/`.Error` member access threw at
      // runtime (caught by the try/catch below, silently returning a
      // `status: 'error'` result; haptics have been silently broken since
      // this plugin version). Station's own `HapticFeedbackKind` already
      // uses the same lowercase strings, so the fix is to pass them
      // directly — same style/type mapping as before, now actually callable.
      const { impactFeedback, notificationFeedback, selectionFeedback } =
        await import('@tauri-apps/plugin-haptics');
      switch (kind) {
        case 'selection':
          await selectionFeedback();
          break;
        case 'light':
          await impactFeedback('light');
          break;
        case 'medium':
          await impactFeedback('medium');
          break;
        case 'success':
          await notificationFeedback('success');
          break;
        case 'error':
          await notificationFeedback('error');
          break;
      }
      return { status: 'ok', value: undefined };
    } catch (error) {
      return {
        status: 'error',
        command: 'haptic-feedback',
        message: errorMessage(error),
      };
    }
  }

  async reviewConsentNatively(
    requestId: string,
  ): Promise<NativeCommandResult<NativeConsentOutcome>> {
    const capability = this.capabilities['native-consent-broker'];
    if (capability.state !== 'enabled') {
      return {
        status: 'unsupported',
        command: 'review-consent-natively',
        reason: capability.reason,
      };
    }
    try {
      const outcome = await this.bridge.invoke<unknown>(
        'station_native_consent_review',
        { requestId },
      );
      const status =
        typeof outcome === 'object' &&
        outcome !== null &&
        typeof (outcome as { status?: unknown }).status === 'string'
          ? (outcome as { status: string }).status
          : null;
      if (status === null) {
        return {
          status: 'error',
          command: 'review-consent-natively',
          message: 'Unexpected native consent outcome',
        };
      }
      return { status: 'ok', value: { status } };
    } catch (error) {
      return {
        status: 'error',
        command: 'review-consent-natively',
        message: errorMessage(error),
      };
    }
  }
}
