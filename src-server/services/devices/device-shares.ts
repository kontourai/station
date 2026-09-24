/**
 * Device access (#90 amendment D12).
 *
 * Simulators and emulators are host-global and belong to the Station
 * OPERATOR. The operator shares specific devices (by UDID or emulator
 * serial) with specific Projects; admins and owners of a Project may view
 * and drive only the devices shared with it. Contributors and viewers get
 * nothing. Only the operator adds or removes shares (the routes enforce it).
 *
 * A share names its device HOST too (#1973): `(hostId, platform, id)`. A
 * simulator UDID on one host says nothing about a device with the same id
 * on another, so a share for `local` never admits an SSH host's device.
 * Records written before hosts existed are `local`.
 *
 * Stored in `<home>/devices/shares.json`, keyed by canonical Project ID.
 * Mutations are synchronous read-modify-write inside this process, which owns
 * the file (the same pattern as the Browser pane's local targets).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  isMobileDeviceHostId,
  type MobileDevicePlatform,
} from '@kontourai/station-contracts/mobile-device';
import type {
  BrowserOperatorAuthorizer,
  BrowserProjectAuthorizer,
} from '../browser/browser-access.js';
import { isValidBrowserProjectId } from '../browser/browser-session-registry.js';
import { isValidMobileDeviceId } from '../mobile-device/mobile-device-host.js';

export interface DeviceShare {
  /** The device host (`local`, or an SSH device host). */
  hostId: string;
  platform: MobileDevicePlatform;
  /** An iOS simulator UDID, or an Android AVD NAME (never an emulator serial). */
  deviceId: string;
  label: string;
  /** `operator` today; a principal key for attribution. */
  addedBy: string;
  addedAt: string;
}

export type DeviceShareRefusal =
  | 'invalid-device'
  | 'invalid-label'
  | 'duplicate'
  | 'not-found';

/**
 * A device host is too busy to answer who a device is right now (#1973 D2:
 * the per-host AVD lookup queue is full, or a lookup waited too long). It
 * is TRANSIENT and must never read as a refusal: the device routes answer
 * it 503 `device-host-busy`, never 403.
 */
export class DeviceHostBusyError extends Error {
  readonly code = 'device-host-busy' as const;
  constructor() {
    super('The device host is busy; try again.');
    this.name = 'DeviceHostBusyError';
  }
}

export class DeviceShareError extends Error {
  constructor(readonly code: DeviceShareRefusal) {
    super(`Device share refused: ${code}.`);
    this.name = 'DeviceShareError';
  }
}

const EMULATOR_SERIAL = /^emulator-[0-9]+$/;

/** A UDID for iOS; for Android an AVD name, never a port-assigned serial. */
function isShareableDeviceId(
  platform: unknown,
  deviceId: unknown,
): platform is MobileDevicePlatform {
  return (
    isValidMobileDeviceId(platform, deviceId) &&
    !(platform === 'android' && EMULATOR_SERIAL.test(deviceId as string))
  );
}

interface StoreShape {
  version: 1;
  projects: Record<string, DeviceShare[]>;
}

export class DeviceShareStore {
  readonly #path: string;
  readonly #projects = new Map<string, DeviceShare[]>();

  constructor(
    stationHome: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#path = join(stationHome, 'devices', 'shares.json');
    this.#load();
  }

  list(projectId: string): DeviceShare[] {
    return structuredClone(this.#projects.get(projectId) ?? []);
  }

  add(
    projectId: string,
    input: {
      hostId: unknown;
      platform: unknown;
      deviceId: unknown;
      label: unknown;
    },
    addedBy: string,
  ): DeviceShare {
    if (
      !isMobileDeviceHostId(input.hostId) ||
      !isShareableDeviceId(input.platform, input.deviceId)
    )
      throw new DeviceShareError('invalid-device');
    const hostId = input.hostId;
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (
      label === '' ||
      label.length > 80 ||
      [...label].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)
    )
      throw new DeviceShareError('invalid-label');
    const shares = this.#projects.get(projectId) ?? [];
    if (
      shares.some(
        (share) =>
          share.hostId === hostId &&
          share.platform === input.platform &&
          share.deviceId === input.deviceId,
      )
    )
      throw new DeviceShareError('duplicate');
    const share: DeviceShare = {
      hostId,
      platform: input.platform,
      deviceId: input.deviceId as string,
      label,
      addedBy,
      addedAt: this.now().toISOString(),
    };
    this.#projects.set(projectId, [...shares, share]);
    this.#save();
    return structuredClone(share);
  }

  remove(
    projectId: string,
    platform: string,
    deviceId: string,
    hostId: string,
  ): void {
    const shares = this.#projects.get(projectId) ?? [];
    const next = shares.filter(
      (share) =>
        !(
          share.hostId === hostId &&
          share.platform === platform &&
          share.deviceId === deviceId
        ),
    );
    if (next.length === shares.length) throw new DeviceShareError('not-found');
    if (next.length === 0) this.#projects.delete(projectId);
    else this.#projects.set(projectId, next);
    this.#save();
  }

  /**
   * Withdraw every share on one device host, in every Project (#1973 M2):
   * the host was retargeted to another machine, or removed. Returns how
   * many were withdrawn.
   */
  removeHost(hostId: string): number {
    let removed = 0;
    for (const [projectId, shares] of [...this.#projects]) {
      const next = shares.filter((share) => share.hostId !== hostId);
      removed += shares.length - next.length;
      if (next.length === 0) this.#projects.delete(projectId);
      else this.#projects.set(projectId, next);
    }
    if (removed > 0) this.#save();
    return removed;
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as StoreShape;
      if (parsed?.version !== 1 || typeof parsed.projects !== 'object') return;
      for (const [projectId, shares] of Object.entries(parsed.projects)) {
        if (!Array.isArray(shares)) continue;
        // A share keyed by an emulator serial (older records) is refused:
        // the serial follows whichever AVD boots on that port next. The
        // operator re-shares by AVD name.
        const valid = shares
          .map((share) =>
            // Written before device hosts existed: those were all local.
            share && share.hostId === undefined
              ? { ...share, hostId: 'local' }
              : share,
          )
          .filter(
            (share) =>
              share &&
              isMobileDeviceHostId(share.hostId) &&
              isShareableDeviceId(share.platform, share.deviceId) &&
              typeof share.label === 'string',
          );
        if (valid.length > 0) this.#projects.set(projectId, valid);
      }
    } catch {
      // An unreadable file shares nothing (fail closed).
    }
  }

  #save(): void {
    mkdirSync(join(this.#path, '..'), { recursive: true });
    const shape: StoreShape = {
      version: 1,
      projects: Object.fromEntries(this.#projects),
    };
    const temp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(shape, null, 2)}\n`);
    renameSync(temp, this.#path);
  }
}

/** Who is asking, as far as devices are concerned (D12). */
export type DeviceCaller =
  | { kind: 'operator' }
  | {
      kind: 'project-admin';
      projectId: string;
      principalId: string;
      shares: DeviceShare[];
    };

export interface DeviceAccessDeps {
  authorizeOperator: BrowserOperatorAuthorizer;
  authorizeProject: BrowserProjectAuthorizer;
  /** Slug to canonical Project ID; undefined when there is no such Project. */
  resolveProject(slug: string): { id: string } | undefined;
  shares: Pick<DeviceShareStore, 'list'>;
  /**
   * The AVD running on an emulator serial right now, on THAT host (`adb emu
   * avd name` there); undefined when it cannot be told. Absent: Android
   * serials never match.
   */
  resolveAndroidAvd?: (
    serial: string,
    hostId: string,
  ) => Promise<string | undefined>;
}

/**
 * The key a device is shared under: the UDID for iOS; for Android the AVD
 * name — a request naming an emulator serial is resolved to the AVD running
 * there now. Undefined (refuse) when a serial cannot be resolved.
 */
export async function deviceShareKey(
  deps: Pick<DeviceAccessDeps, 'resolveAndroidAvd'>,
  platform: string,
  deviceId: string,
  hostId: string,
): Promise<string | undefined> {
  if (platform !== 'android' || !EMULATOR_SERIAL.test(deviceId))
    return deviceId;
  if (!isMobileDeviceHostId(hostId)) return undefined;
  return deps.resolveAndroidAvd
    ? await deps.resolveAndroidAvd(deviceId, hostId).catch((error) => {
        // Busy is not "not shared": it propagates (D2). Anything else refuses.
        if (error instanceof DeviceHostBusyError) throw error;
        return undefined;
      })
    : undefined;
}

/**
 * Resolve the caller: the operator, or an active admin/owner of the Project
 * named by `?projectSlug=` that has at least one device shared with it.
 * Anyone else, and any failure, is undefined (refused).
 */
export async function resolveDeviceCaller(
  deps: DeviceAccessDeps,
  request: Request,
  purpose: 'view' | 'drive',
): Promise<DeviceCaller | undefined> {
  if (await deps.authorizeOperator(request)) return { kind: 'operator' };
  const slug = new URL(request.url).searchParams.get('projectSlug');
  if (slug === null || !isValidBrowserProjectId(slug)) return undefined;
  const project = deps.resolveProject(slug);
  if (!project) return undefined;
  const actor = await deps.authorizeProject(request, project.id, purpose);
  if (actor?.kind !== 'project-admin') return undefined;
  const shares = deps.shares.list(project.id);
  if (shares.length === 0) return undefined;
  return {
    kind: 'project-admin',
    projectId: project.id,
    principalId: actor.principalId,
    shares,
  };
}

/** Whether a caller may use the device shared under `(hostId, platform, shareKey)`. */
function callerMayUseDevice(
  caller: DeviceCaller,
  hostId: string,
  platform: string,
  shareKey: string,
): boolean {
  const deviceId = shareKey;
  return (
    caller.kind === 'operator' ||
    caller.shares.some(
      (share) =>
        share.hostId === hostId &&
        share.platform === platform &&
        share.deviceId === deviceId,
    )
  );
}

/**
 * Whether `caller` may perform a hub route's action on one device: the
 * operator always; an admin only on a device shared with their Project, and
 * never an operator-only action (power off).
 */
export function mayPerformDeviceAction(
  caller: DeviceCaller,
  purpose: 'view' | 'drive' | 'operator',
  platform: string,
  shareKey: string | undefined,
  hostId: string,
): boolean {
  if (caller.kind === 'operator') return true;
  if (purpose === 'operator' || shareKey === undefined) return false;
  return callerMayUseDevice(caller, hostId, platform, shareKey);
}

/**
 * {@link mayPerformDeviceAction} for a device as a request names it,
 * resolving an Android serial to its AVD first (operators skip the lookup).
 */
export async function mayUseNamedDevice(
  deps: Pick<DeviceAccessDeps, 'resolveAndroidAvd'>,
  caller: DeviceCaller,
  purpose: 'view' | 'drive' | 'operator',
  platform: string,
  deviceId: string,
  hostId: string,
): Promise<boolean> {
  if (caller.kind === 'operator') return true;
  return mayPerformDeviceAction(
    caller,
    purpose,
    platform,
    await deviceShareKey(deps, platform, deviceId, hostId),
    hostId,
  );
}
