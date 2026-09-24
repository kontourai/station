/**
 * The managed device toolchain (#1970, design D11): the pinned tools Station
 * installs, supervises and reports on so a person does not run the device
 * hub by hand.
 *
 * Every state here is DERIVED by the server from what is on disk and what it
 * is running. None of it names a host path, a port or a credential: the hub's
 * loopback address is internal to the server and never crosses this
 * contract.
 */

/** The two external tools device support is built on. */
export type DeviceToolId = 'expo-device-hub' | 'agent-device';

/** What an install is doing right now, in order. */
export type DeviceToolInstallPhase =
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'publishing';

export type DeviceToolFailure =
  /** No npm Station can run was found beside its Node runtime or on PATH. */
  | 'package-manager-unavailable'
  /** The package manager exited non-zero or timed out. */
  | 'install-failed'
  /** An installed package does not match its pinned registry integrity. */
  | 'integrity-mismatch'
  /** The install finished but the tool's entry point is not where it is pinned. */
  | 'entry-missing'
  /** The verified install could not be moved into place. */
  | 'publish-failed';

export type DeviceToolState =
  /** Nobody has agreed to this install yet. Nothing is fetched. */
  | { tool: DeviceToolId; state: 'needs-consent'; requiredVersion: string }
  /** Agreed to before, but no completed install is present now. */
  | { tool: DeviceToolId; state: 'not-installed'; requiredVersion: string }
  | {
      tool: DeviceToolId;
      state: 'installing';
      requiredVersion: string;
      phase: DeviceToolInstallPhase;
      /** 1-based position of `phase` among `totalSteps`. */
      step: number;
      totalSteps: number;
      startedAt: string;
    }
  | { tool: DeviceToolId; state: 'installed'; version: string }
  /** An older managed install is present; the required one is not. */
  | {
      tool: DeviceToolId;
      state: 'update-available';
      installedVersion: string;
      requiredVersion: string;
    }
  | {
      tool: DeviceToolId;
      state: 'failed';
      requiredVersion: string;
      reason: DeviceToolFailure;
      detail: string;
      /** A consented retry can succeed; false for an environment problem. */
      retryable: boolean;
    };

/** The supervised hub process. `running` is only claimed after it answered. */
export type DeviceHubProcessState =
  | { state: 'stopped' }
  | { state: 'starting'; version: string }
  | { state: 'running'; version: string; startedAt: string }
  | { state: 'restarting'; attempt: number; retryAt: string }
  /** Restarts stopped after repeated failures; a person must start it again. */
  | { state: 'crashed'; attempts: number; detail: string };

/** Where the device routes get their hub from. */
export type DeviceHubSource =
  /** `STATION_MOBILE_DEVICE_HUB_URL` names an externally owned hub. */
  | 'configured'
  /** Station's own supervised hub. */
  | 'managed'
  | 'none';

export type DevicePlatformReadinessReason =
  | 'ready'
  | 'requires-macos'
  | 'xcode-missing'
  | 'android-sdk-missing'
  | 'adb-missing'
  | 'emulator-missing';

export interface DevicePlatformReadiness {
  platform: 'ios' | 'android';
  ready: boolean;
  reason: DevicePlatformReadinessReason;
}

/** One tool's versions: never starts or installs anything to answer. */
export interface DeviceToolVersionReport {
  tool: DeviceToolId;
  required: string;
  /** Completed managed installs present on disk, ascending. */
  installed: string[];
  /** The version the supervisor is running now, if any. */
  running: string | null;
}

export interface DeviceToolchainVersions {
  checkedAt: string;
  tools: DeviceToolVersionReport[];
}

export interface DeviceToolchainStatus {
  /** Always Station: these installs live under the Station home. */
  managedBy: 'station';
  /**
   * Whether the caller may change device setup (the Station operator). A
   * Project admin reading status sees states without failure detail or
   * platform probes, and is told to ask the operator.
   */
  canManage: boolean;
  hub: DeviceToolState;
  agentDevice: DeviceToolState;
  hubProcess: DeviceHubProcessState;
  hubSource: DeviceHubSource;
  /** The operator's device-hub choice (setup step 1). */
  hubEnabled: boolean;
  /** The operator's agent-access choice. Off keeps manual device controls. */
  agentAccess: boolean;
  platforms: DevicePlatformReadiness[];
}
