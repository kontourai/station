import { randomUUID } from 'node:crypto';
import type {
  MobileDevicePlatform,
  MobileDeviceSession,
  MobileDeviceStartError,
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import type { LiveSurfaceProducer } from '../live-surface/producer.js';
import type {
  LiveSurfaceAuthorizationContext,
  LiveSurfaceRegistry,
} from '../live-surface/registry.js';
import {
  type LocalMobileDeviceHost,
  MobileDeviceHostError,
} from '../mobile-device/mobile-device-host.js';
import {
  authorizeDeviceSurfaceAction,
  type DeviceAccess,
} from './device-access.js';
import type { DeviceHostActions } from './device-host-tools.js';
import type { DeviceHubEndpoint } from './device-hub-endpoint.js';
import {
  DeviceLiveSurfaceProducer,
  type DeviceLiveSurfaceProducerOptions,
} from './device-live-surface-producer.js';
import type { DeviceVideoDecoderProvider } from './h264-jpeg-decoder.js';

/**
 * Device sessions (#1970): a device on a host, open for watching and
 * driving through a live surface.
 *
 * - `open` registers ONE surface per device (a second open of the same
 *   device returns the same session, so every viewer shares one lease and
 *   one input channel). Who may use it is decided per DEVICE (D12: the
 *   operator, or an admin of a Project the operator shared the device
 *   with), on every surface request.
 * - `close` (stop watching) unregisters the surface; the device keeps
 *   running. `powerOff` closes every session on the device, then shuts it
 *   down. A device that stops on its own, or a hub that exits, ends its
 *   sessions the same way — never a surface left streaming nothing.
 * - Sessions are listed (`list`) so none is ever hidden (D6).
 */

export type DeviceSessionSummary = MobileDeviceSession;

export class DeviceSessionError extends Error {
  constructor(
    readonly code:
      | 'device-unavailable'
      | 'device-not-running'
      | 'unknown-session'
      | 'not-authorized'
      | 'hub-unavailable'
      | 'invalid-target',
  ) {
    super(`Device session refused: ${code}`);
    this.name = 'DeviceSessionError';
  }
}

interface SessionEntry {
  summary: DeviceSessionSummary;
  producer: DeviceLiveSurfaceProducer;
  unregister: () => Promise<void>;
  open: boolean;
  /** Pending end because nobody is watching (see `idleEndMs`). */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** What a Start answered: the device is up, or booting in the background. */
export interface DeviceStartResult {
  deviceId: string;
  state: 'running' | 'starting';
}

export type DeviceProducerFactory = (
  options: DeviceLiveSurfaceProducerOptions,
) => DeviceLiveSurfaceProducer;

export interface DeviceSessionServiceOptions {
  /**
   * The device host these sessions run on (D13, #1973). One service per
   * host; every session, surface authorization and hub call carries it.
   * Defaults to `local`.
   */
  hostId?: string;
  host: Pick<
    LocalMobileDeviceHost,
    | 'inventory'
    | 'boot'
    | 'attachStream'
    | 'shutdown'
    | 'screenshot'
    | 'connect'
  >;
  endpoint: Pick<DeviceHubEndpoint, 'onExit'>;
  surfaces: Pick<LiveSurfaceRegistry, 'register'>;
  /** Who may view/drive which device (D12); the surface authorizer asks it. */
  access: DeviceAccess;
  decoder?: DeviceVideoDecoderProvider;
  actions?: DeviceHostActions;
  createProducer?: DeviceProducerFactory;
  onError?: (message: string, error: unknown) => void;
  now?: () => number;
  /**
   * A session nobody has watched for this long ends (Close only detaches a
   * viewer; the last viewer leaving, then this grace, ends it). Default
   * 10 minutes: a viewer SUSPENDS (its stream is dropped) whenever its tab
   * is hidden or its pane is collapsed or scrolled away, and a routine tab
   * switch must not end the session. The grace is what tells "someone
   * stepped away" from "nobody is coming back".
   */
  idleEndMs?: number;
}

const DEFAULT_IDLE_END_MS = 10 * 60_000;
/**
 * How long a started emulator's row is kept after its boot call returned,
 * waiting for the hub to list it as `emulator-<n>`. A cold emulator boot
 * finishes well inside this; past it the row is dropped rather than left as
 * a ghost that says "Starting…" forever.
 */
const ANDROID_LISTING_GRACE_MS = 3 * 60_000;

/** A device a Start is booting, and the row it was listed under. */
interface StartingDevice {
  device: MobileDeviceSummary;
  /** When the boot call returned (Android keeps the row until it lists). */
  bootReturnedAt?: number;
}

function key(platform: MobileDevicePlatform, deviceId: string): string {
  return `${platform}:${deviceId}`;
}

export class DeviceSessionService {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly byDevice = new Map<string, string>();
  /** Devices booting in the background (Start), by platform:deviceId. */
  private readonly starting = new Map<string, StartingDevice>();
  /** Why the last background Start of a device failed, until it is retried. */
  private readonly startFailures = new Map<string, MobileDeviceStartError>();
  private readonly offExit: () => void;
  private disposed = false;

  readonly hostId: string;

  constructor(private readonly options: DeviceSessionServiceOptions) {
    this.hostId = options.hostId ?? 'local';
    this.offExit = options.endpoint.onExit((reason) => {
      for (const sessionId of [...this.sessions.keys()])
        void this.end(sessionId, reason);
    });
  }

  list(): DeviceSessionSummary[] {
    return [...this.sessions.values()]
      .filter((entry) => entry.open)
      .map((entry) => ({ ...entry.summary }));
  }

  get(sessionId: string): DeviceSessionSummary | undefined {
    const entry = this.sessions.get(sessionId);
    return entry?.open ? { ...entry.summary } : undefined;
  }

  /** The open session on a device, if any. */
  forDevice(
    platform: MobileDevicePlatform,
    deviceId: string,
  ): DeviceSessionSummary | undefined {
    const sessionId = this.byDevice.get(key(platform, deviceId));
    return sessionId ? this.get(sessionId) : undefined;
  }

  private async findDevice(
    target: MobileDeviceTarget,
  ): Promise<MobileDeviceSummary> {
    const inventory = await this.options.host.inventory();
    if (inventory.state === 'unavailable')
      throw new DeviceSessionError('hub-unavailable');
    const device = inventory.devices.find(
      (row) =>
        row.platform === target.platform && row.deviceId === target.deviceId,
    );
    if (!device) throw new DeviceSessionError('device-unavailable');
    return device;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * The listed devices, plus a `starting` row for each emulator a Start is
   * still bringing up that the hub lists under neither name yet (its AVD
   * row is gone and its `emulator-<n>` row has not appeared). Without it
   * the device the caller just started vanishes from the list mid-boot.
   * An emulator that is listed running (same name) retires its entry.
   */
  withStartingRows(devices: MobileDeviceSummary[]): MobileDeviceSummary[] {
    const out = [...devices];
    for (const [deviceKey, entry] of [...this.starting]) {
      const { device } = entry;
      if (device.platform !== 'android') continue;
      const running = devices.some(
        (row) =>
          row.platform === 'android' && row.booted && row.name === device.name,
      );
      if (
        running ||
        (entry.bootReturnedAt !== undefined &&
          this.now() - entry.bootReturnedAt > ANDROID_LISTING_GRACE_MS)
      ) {
        if (entry.bootReturnedAt !== undefined) this.starting.delete(deviceKey);
        continue;
      }
      if (
        devices.some(
          (row) =>
            row.platform === 'android' && row.deviceId === device.deviceId,
        )
      )
        continue;
      out.push({ ...device, booted: false, starting: true });
    }
    return out;
  }

  /** Whether a Start of this device is still booting it. */
  isStarting(platform: MobileDevicePlatform, deviceId: string): boolean {
    return this.starting.has(key(platform, deviceId));
  }

  /** Why the last Start of this device failed, if it did (cleared on retry). */
  startFailure(
    platform: MobileDevicePlatform,
    deviceId: string,
  ): MobileDeviceStartError | undefined {
    return this.startFailures.get(key(platform, deviceId));
  }

  /**
   * Start a stopped device. A cold boot can take minutes, so this does not
   * wait for it: it answers `starting` at once and boots in the background
   * (a caller polls the device list until the device is running). Android
   * lists a running emulator under a new id (its `emulator-<n>` serial), so
   * a poller matches by platform and name. A boot that fails is reported
   * through `onError` and the device simply stays stopped.
   */
  async start(target: MobileDeviceTarget): Promise<DeviceStartResult> {
    const device = await this.findDevice(target);
    if (device.booted) return { deviceId: device.deviceId, state: 'running' };
    const deviceKey = key(target.platform, target.deviceId);
    if (!this.starting.has(deviceKey)) {
      const entry: StartingDevice = { device: { ...device } };
      this.starting.set(deviceKey, entry);
      this.startFailures.delete(deviceKey);
      void this.options.host
        .boot(target, device.name)
        .then(() => {
          // An emulator is listed under a NEW id (its serial) only once adb
          // sees it; until then the hub lists it under neither name. Keep
          // the starting row until `withStartingRows` sees it running.
          if (target.platform === 'android') entry.bootReturnedAt = this.now();
          else this.starting.delete(deviceKey);
        })
        .catch((error) => {
          this.starting.delete(deviceKey);
          const failure = this.hostFailure(error);
          // Kept for the device list to report at once (`startError`).
          this.startFailures.set(
            deviceKey,
            failure.code === 'invalid-target' ||
              failure.code === 'device-unavailable' ||
              failure.code === 'not-authorized'
              ? failure.code
              : 'hub-unavailable',
          );
          this.options.onError?.('device start failed', failure);
        });
    }
    return { deviceId: device.deviceId, state: 'starting' };
  }

  /**
   * Open (or join) the session on a booted device. Who may do so is the
   * route's check (D12: access to THIS device); every surface request is
   * then checked again against the same device.
   */
  async open(
    target: MobileDeviceTarget,
    /**
     * Asked after the last await and before the surface is registered: a
     * caller whose credential lapsed while the helper attached must not
     * end up with a registered surface.
     */
    stillAuthorized: () => boolean = () => true,
  ): Promise<DeviceSessionSummary> {
    if (this.disposed) throw new DeviceSessionError('hub-unavailable');
    const existing = this.forDevice(target.platform, target.deviceId);
    if (existing) return existing;
    const device = await this.findDevice(target);
    if (!device.booted) throw new DeviceSessionError('device-not-running');
    if (device.platform === 'ios') {
      // A simulator booted outside Station has no streaming helper yet.
      try {
        await this.options.host.attachStream(device.deviceId);
      } catch (error) {
        throw this.hostFailure(error);
      }
    }
    if (!stillAuthorized()) throw new DeviceSessionError('not-authorized');
    // Re-check after the await: a concurrent open may have won.
    const raced = this.forDevice(target.platform, target.deviceId);
    if (raced) return raced;

    const sessionId = randomUUID();
    const surfaceId = `device:${device.platform}:${sessionId}`;
    const summary: DeviceSessionSummary = {
      sessionId,
      surfaceId,
      hostId: this.hostId,
      platform: device.platform,
      deviceId: device.deviceId,
      name: device.name,
      runtime: device.runtime,
      openedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
    };
    const producerOptions: DeviceLiveSurfaceProducerOptions = {
      surfaceId,
      platform: device.platform,
      deviceId: device.deviceId,
      hostId: this.hostId,
      hub: this.options.host,
      ...(this.options.decoder ? { decoder: this.options.decoder } : {}),
      ...(this.options.actions ? { actions: this.options.actions } : {}),
      isDeviceRunning: async () => {
        const inventory = await this.options.host.inventory();
        // An unanswering hub is not proof the device stopped.
        if (inventory.state === 'unavailable') return true;
        return inventory.devices.some(
          (row) =>
            row.platform === device.platform &&
            row.deviceId === device.deviceId &&
            row.booted,
        );
      },
      onEnded: (reason) => void this.end(sessionId, reason),
      onViewing: (watching) => this.watching(sessionId, watching),
      ...(this.options.onError ? { onError: this.options.onError } : {}),
    };
    const producer = (
      this.options.createProducer ??
      ((options) => new DeviceLiveSurfaceProducer(options))
    )(producerOptions);
    const entry: SessionEntry = {
      summary,
      producer,
      unregister: async () => {},
      open: true,
      idleTimer: null,
    };
    const session = {
      hostId: this.hostId,
      platform: summary.platform,
      deviceId: summary.deviceId,
      isOpen: () => entry.open,
      // One memo per session: the share key a check resolved, so a later
      // re-check can refuse a revoked share without the host (#2433).
      shareKeyMemo: {},
    };
    try {
      entry.unregister = this.options.surfaces.register(
        producer as LiveSurfaceProducer,
        {
          authorize: (
            _principal: string,
            _surfaceId: string,
            action,
            context?: LiveSurfaceAuthorizationContext,
          ) =>
            authorizeDeviceSurfaceAction(
              this.options.access,
              session,
              action,
              context?.request,
            ),
        },
      );
    } catch (error) {
      await producer.dispose();
      this.options.onError?.('device surface could not be registered', error);
      throw new DeviceSessionError('device-unavailable');
    }
    this.sessions.set(sessionId, entry);
    this.byDevice.set(key(device.platform, device.deviceId), sessionId);
    producer.open();
    // Nobody watches yet: if nobody ever does, the session ends by itself.
    this.watching(sessionId, false);
    return { ...summary };
  }

  /**
   * The frame stream started (someone watches) or stopped (the last viewer
   * left). The last viewer leaving arms the idle end; a viewer arriving
   * disarms it.
   *
   * Agent device control is NOT wired in this lane (an agent cannot claim a
   * device surface today: it fails closed). When it is, an agent driving an
   * unwatched device (D6) must keep its session from this idle end.
   */
  private watching(sessionId: string, watching: boolean): void {
    const entry = this.sessions.get(sessionId);
    if (!entry?.open) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (watching) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      void this.end(sessionId, 'idle');
    }, this.options.idleEndMs ?? DEFAULT_IDLE_END_MS);
    entry.idleTimer.unref?.();
  }

  /**
   * End the session for EVERY viewer ("End for everyone"): unregister the
   * surface. The device keeps running. Closing one pane does not call this;
   * it only detaches that viewer.
   */
  async close(sessionId: string): Promise<boolean> {
    return this.end(sessionId, 'closed');
  }

  /** Close every session on the device, then shut it down. */
  async powerOff(target: MobileDeviceTarget): Promise<void> {
    const sessionId = this.byDevice.get(key(target.platform, target.deviceId));
    if (sessionId) await this.end(sessionId, 'powered-off');
    try {
      await this.options.host.shutdown(target);
    } catch (error) {
      throw this.hostFailure(error);
    }
  }

  private async end(sessionId: string, reason: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.open) return false;
    entry.open = false;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    this.sessions.delete(sessionId);
    const deviceKey = key(entry.summary.platform, entry.summary.deviceId);
    if (this.byDevice.get(deviceKey) === sessionId)
      this.byDevice.delete(deviceKey);
    try {
      await entry.unregister();
    } catch (error) {
      this.options.onError?.('device surface unregister failed', error);
    }
    await entry.producer.dispose();
    if (reason !== 'closed')
      this.options.onError?.('device session ended', { sessionId, reason });
    return true;
  }

  private hostFailure(error: unknown): DeviceSessionError {
    if (error instanceof DeviceSessionError) return error;
    if (error instanceof MobileDeviceHostError) {
      if (error.code === 'invalid-target')
        return new DeviceSessionError('invalid-target');
      if (error.code === 'device-unavailable')
        return new DeviceSessionError('device-unavailable');
    }
    return new DeviceSessionError('hub-unavailable');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.offExit();
    await Promise.allSettled(
      [...this.sessions.keys()].map((sessionId) =>
        this.end(sessionId, 'shutdown'),
      ),
    );
  }
}
