/**
 * Composition root for the managed device toolchain on a personal host
 * (#1970, D11): the operator's setup choices, the pinned installs, and the
 * supervised hub. Constructed only inside the personal-host gate in
 * `configureRuntimeRoutes`; hosted deployments never build it.
 *
 * Setup choices persist in `<STATION_HOME>/devices/setup.json`:
 * - `hubEnabled` — the operator agreed to install and run the device hub.
 * - `agentAccess` — the operator agreed to install agent-device for agents.
 *   Off keeps manual device controls without giving agents access.
 * Consent to install a tool is recorded with the choice that needs it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DeviceHubSource,
  DevicePlatformReadiness,
  DeviceToolchainStatus,
  DeviceToolchainVersions,
  DeviceToolId,
} from '@kontourai/station-contracts/device-toolchain';
import { createLogger } from '../../../utils/logger.js';
import { isValidMobileDeviceId } from '../../mobile-device/mobile-device-host.js';
import { type DeviceCaller, mayPerformDeviceAction } from '../device-shares.js';
import type { DeviceHubConnection } from './device-hub-connection.js';
import { DeviceHubSupervisor } from './device-hub-supervisor.js';
import { probeDevicePlatforms } from './device-platform-readiness.js';

const PLATFORM_PROBE_TTL_MS = 30_000;

/** Status is polled while installs run; `xcrun` need not be. */
function cachedPlatformProbe(): () => Promise<DevicePlatformReadiness[]> {
  let cached:
    | { at: number; value: Promise<DevicePlatformReadiness[]> }
    | undefined;
  return () => {
    const now = Date.now();
    if (!cached || now - cached.at > PLATFORM_PROBE_TTL_MS)
      cached = { at: now, value: probeDevicePlatforms() };
    return cached.value;
  };
}

import {
  createNpmCiInstaller,
  DeviceToolConsentRequiredError,
  DeviceToolchain,
} from './device-toolchain.js';

const logger = createLogger({ name: 'device-toolchain' });

interface SetupRecord {
  hubEnabled: boolean;
  agentAccess: boolean;
}

/** A device action the caller may not take, or with no hub to take it on. */
export class DeviceActionRefusedError extends Error {
  constructor(readonly code: 'access-denied' | 'hub-unavailable') {
    super(`Device action refused: ${code}.`);
    this.name = 'DeviceActionRefusedError';
  }
}

/** An update or install that needs a prior consent that was never given. */
export class DeviceToolNotConsentedError extends Error {
  constructor(readonly tool: DeviceToolId) {
    super(`${tool} has not been set up, so there is nothing to update.`);
    this.name = 'DeviceToolNotConsentedError';
  }
}

export interface DeviceToolchainServiceOptions {
  stationHome: string;
  /** `STATION_MOBILE_DEVICE_HUB_URL`: an externally owned hub, if set. */
  configuredHubUrl?: string;
  toolchain?: DeviceToolchain;
  supervisor?: DeviceHubSupervisor;
  probePlatforms?: () => Promise<DevicePlatformReadiness[]>;
}

export class DeviceToolchainService {
  readonly toolchain: DeviceToolchain;
  readonly supervisor: DeviceHubSupervisor;
  readonly #setupPath: string;
  readonly #configured: boolean;
  readonly #probePlatforms: () => Promise<DevicePlatformReadiness[]>;

  constructor(options: DeviceToolchainServiceOptions) {
    this.#setupPath = join(options.stationHome, 'devices', 'setup.json');
    const runDir = join(options.stationHome, 'devices', 'run');
    this.#configured = Boolean(options.configuredHubUrl);
    this.toolchain =
      options.toolchain ??
      new DeviceToolchain({
        stationHome: options.stationHome,
        installer: createNpmCiInstaller(),
      });
    this.supervisor =
      options.supervisor ??
      new DeviceHubSupervisor({
        resolveLaunch: () => {
          const entry = this.toolchain.installedEntry('expo-device-hub');
          return entry
            ? {
                entry,
                cwd: this.toolchain.installDir('expo-device-hub'),
                version: this.toolchain.pin('expo-device-hub').version,
                runDir,
              }
            : undefined;
        },
      });
    this.#probePlatforms = options.probePlatforms ?? cachedPlatformProbe();
    // Staging directories an interrupted install left behind.
    this.toolchain.removeStaleStaging();
  }

  /**
   * Ports the managed hub and its stream helpers listen on, read live: the
   * Browser pane's host Chromium must never reach them (Station-listener
   * deny), and they can never be registered as local targets.
   */
  listeningPorts(): number[] {
    return this.supervisor.listeningPorts();
  }

  #readSetup(): SetupRecord {
    try {
      const value = JSON.parse(readFileSync(this.#setupPath, 'utf8')) as {
        hubEnabled?: unknown;
        agentAccess?: unknown;
      };
      return {
        hubEnabled: value.hubEnabled === true,
        agentAccess: value.agentAccess === true,
      };
    } catch {
      // Absent or unreadable: nothing was agreed to.
      return { hubEnabled: false, agentAccess: false };
    }
  }

  #writeSetup(record: SetupRecord): void {
    mkdirSync(join(this.#setupPath, '..'), { recursive: true });
    const temp = `${this.#setupPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, ...record })}\n`);
    renameSync(temp, this.#setupPath);
  }

  #consented(tool: DeviceToolId, setup = this.#readSetup()): boolean {
    return tool === 'expo-device-hub' ? setup.hubEnabled : setup.agentAccess;
  }

  hubSource(): DeviceHubSource {
    if (this.#configured) return 'configured';
    return this.#readSetup().hubEnabled &&
      this.toolchain.installedEntry('expo-device-hub')
      ? 'managed'
      : 'none';
  }

  async status(): Promise<DeviceToolchainStatus> {
    const setup = this.#readSetup();
    return {
      managedBy: 'station',
      // The routes narrow this for non-operators.
      canManage: true,
      hub: this.toolchain.state('expo-device-hub', setup.hubEnabled),
      agentDevice: this.toolchain.state('agent-device', setup.agentAccess),
      hubProcess: this.supervisor.state(),
      hubSource: this.hubSource(),
      hubEnabled: setup.hubEnabled,
      agentAccess: setup.agentAccess,
      platforms: await this.#probePlatforms(),
    };
  }

  /** Read-only: starts and installs nothing. */
  versions(): DeviceToolchainVersions {
    return this.toolchain.versions({
      'expo-device-hub': this.supervisor.runningVersion(),
    });
  }

  /**
   * Enable the hub: record consent, install the pinned hub, then start it.
   * `consent` must be the literal `true`.
   */
  enableHub(request: { consent: true }): { completion: Promise<void> } {
    if (request?.consent !== true) throw new DeviceToolConsentRequiredError();
    this.#writeSetup({ ...this.#readSetup(), hubEnabled: true });
    const { completion } = this.toolchain.install('expo-device-hub', {
      consent: true,
    });
    return {
      completion: completion.then(async () => {
        // An externally configured hub serves the routes; do not run a second.
        if (
          this.#configured ||
          !this.toolchain.installedEntry('expo-device-hub')
        )
          return;
        await this.supervisor.ensureStarted().catch((error: unknown) => {
          logger.warn('device hub did not start after install', {
            error: String(error),
          });
        });
      }),
    };
  }

  /** Disable the hub: stop it and withdraw the choice. Files stay. */
  async disableHub(): Promise<void> {
    this.#writeSetup({ ...this.#readSetup(), hubEnabled: false });
    await this.supervisor.stop();
  }

  /**
   * Turn agent access on (installs agent-device; needs literal consent) or
   * off (records the choice; nothing is removed or started).
   */
  setAgentAccess(
    enabled: boolean,
    request?: { consent: true },
  ): { completion: Promise<void> } {
    if (!enabled) {
      this.#writeSetup({ ...this.#readSetup(), agentAccess: false });
      return { completion: Promise.resolve() };
    }
    if (request?.consent !== true) throw new DeviceToolConsentRequiredError();
    this.#writeSetup({ ...this.#readSetup(), agentAccess: true });
    return this.toolchain.install('agent-device', { consent: true });
  }

  /**
   * Install the required version of a tool that was already set up, restart
   * the hub onto it, then reclaim versions nothing runs from.
   */
  update(tool: DeviceToolId): { completion: Promise<void> } {
    if (!this.#consented(tool)) throw new DeviceToolNotConsentedError(tool);
    const { completion } = this.toolchain.install(tool, { consent: true });
    return {
      completion: completion.then(async () => {
        if (!this.toolchain.installedEntry(tool)) return;
        if (
          tool === 'expo-device-hub' &&
          this.supervisor.runningVersion() !== null &&
          this.supervisor.runningVersion() !==
            this.toolchain.pin('expo-device-hub').version
        ) {
          await this.supervisor.restart().catch(() => {});
        }
        await this.reclaim(tool);
      }),
    };
  }

  /** Remove obsolete managed installs that nothing runs from. */
  reclaim(tool: DeviceToolId): Promise<string[]> {
    const running = this.supervisor.runningInstallDir();
    return this.toolchain.reclaimObsolete(
      tool,
      tool === 'expo-device-hub' && running ? [running] : [],
    );
  }

  /** Start (or restart after `crashed`) the managed hub. */
  startHub(): Promise<DeviceHubConnection> {
    return this.supervisor.ensureStarted();
  }

  /** The running managed hub, or undefined. Never starts anything. */
  hubConnection(): DeviceHubConnection | undefined {
    return this.supervisor.connection();
  }

  /**
   * The managed hub for a request that needs one: started on demand when the
   * operator enabled it and it is installed. Undefined otherwise, or when an
   * externally configured hub takes precedence.
   */
  async ensureHub(): Promise<DeviceHubConnection | undefined> {
    if (this.#configured) return undefined;
    const live = this.supervisor.connection();
    if (live) return live;
    if (
      !this.#readSetup().hubEnabled ||
      !this.toolchain.installedEntry('expo-device-hub')
    )
      return undefined;
    const state = this.supervisor.state().state;
    // A crash waits for a person; a scheduled restart is already on its way.
    if (state === 'crashed' || state === 'restarting') return undefined;
    try {
      return await this.supervisor.ensureStarted();
    } catch {
      return undefined;
    }
  }

  /**
   * Attach serve-sim's stream helper to a booted simulator (server-side
   * only; never proxied to clients). The caller must be allowed to DRIVE
   * that device (D12); the hub starts only if the operator enabled it.
   */
  attachStreamHelper(caller: DeviceCaller, udid: string): Promise<Response> {
    return this.#gridAction(caller, 'drive', 'start', udid);
  }

  /**
   * serve-sim's grid shutdown powers the simulator off, so it is the
   * operator's alone, like the hub's `/api/devices/shutdown`.
   */
  detachStreamHelper(caller: DeviceCaller, udid: string): Promise<Response> {
    return this.#gridAction(caller, 'operator', 'shutdown', udid);
  }

  async #gridAction(
    caller: DeviceCaller,
    purpose: 'drive' | 'operator',
    action: 'start' | 'shutdown',
    udid: string,
  ): Promise<Response> {
    if (
      !isValidMobileDeviceId('ios', udid) ||
      !mayPerformDeviceAction(caller, purpose, 'ios', udid, 'local')
    )
      throw new DeviceActionRefusedError('access-denied');
    const hub = await this.ensureHub();
    if (!hub) throw new DeviceActionRefusedError('hub-unavailable');
    return hub.request('POST', `/vendor/serve-sim/grid/api/${action}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ udid }),
    });
  }

  async shutdown(): Promise<void> {
    this.toolchain.abort();
    await this.supervisor.stop();
  }
}
