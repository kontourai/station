/**
 * Operator-managed SSH device hosts (#1973, D11).
 *
 * `<STATION_HOME>/devices/hosts.json`: `{hostId, label, sshTarget,
 * hubEnabled}` per host. No secret is stored — authentication is the
 * operator's ssh agent and config — so the file holds nothing a reader
 * could use to reach a host. Only the operator changes it (the routes
 * enforce that); every value is validated here too, on write AND on load,
 * so a hand-edited file cannot smuggle an option-shaped target in.
 *
 * Mutations are synchronous read-modify-write inside this process, which
 * owns the file (the device shares' pattern).
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DeviceSshHost } from '@kontourai/station-contracts/mobile-device';
import { isSshDeviceTarget } from './ssh-device-target.js';

export type DeviceHostRefusal =
  | 'invalid-label'
  | 'invalid-target'
  | 'duplicate'
  | 'not-found'
  | 'too-many';

export class DeviceHostStoreError extends Error {
  constructor(readonly code: DeviceHostRefusal) {
    super(`Device host refused: ${code}.`);
    this.name = 'DeviceHostStoreError';
  }
}

const SSH_HOST_ID = /^ssh-[0-9a-f]{12}$/;
const MAX_HOSTS = 32;

export function isSshDeviceHostId(value: unknown): value is string {
  return typeof value === 'string' && SSH_HOST_ID.test(value);
}

function cleanLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : '';
  if (
    label === '' ||
    label.length > 80 ||
    [...label].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    }) ||
    // Format characters (bidi overrides, zero-width joiners…) would let a
    // label read as something it is not.
    /\p{Cf}/u.test(label)
  )
    throw new DeviceHostStoreError('invalid-label');
  return label;
}

function cleanTarget(value: unknown): string {
  if (!isSshDeviceTarget(value))
    throw new DeviceHostStoreError('invalid-target');
  return value;
}

interface StoreShape {
  version: 1;
  hosts: DeviceSshHost[];
}

export class DeviceHostStore {
  readonly #path: string;
  #hosts: DeviceSshHost[] = [];

  constructor(
    stationHome: string,
    private readonly now: () => Date = () => new Date(),
    private readonly mintId: () => string = () =>
      `ssh-${randomBytes(6).toString('hex')}`,
  ) {
    this.#path = join(stationHome, 'devices', 'hosts.json');
    this.#load();
  }

  list(): DeviceSshHost[] {
    return structuredClone(this.#hosts);
  }

  get(hostId: string): DeviceSshHost | undefined {
    const host = this.#hosts.find((candidate) => candidate.hostId === hostId);
    return host ? structuredClone(host) : undefined;
  }

  add(input: { label: unknown; sshTarget: unknown }): DeviceSshHost {
    const label = cleanLabel(input.label);
    const sshTarget = cleanTarget(input.sshTarget);
    if (this.#hosts.length >= MAX_HOSTS)
      throw new DeviceHostStoreError('too-many');
    if (this.#hosts.some((host) => host.sshTarget === sshTarget))
      throw new DeviceHostStoreError('duplicate');
    let hostId = this.mintId();
    while (this.#hosts.some((host) => host.hostId === hostId))
      hostId = this.mintId();
    if (!SSH_HOST_ID.test(hostId)) throw new Error('Invalid minted host id.');
    const at = this.now().toISOString();
    const host: DeviceSshHost = {
      hostId,
      label,
      sshTarget,
      hubEnabled: false,
      createdAt: at,
      updatedAt: at,
    };
    this.#hosts = [...this.#hosts, host];
    this.#save();
    return structuredClone(host);
  }

  /**
   * Edit a host. A new target withdraws the hub consent: consent was given
   * for installing and running on THAT machine.
   */
  update(
    hostId: string,
    input: { label?: unknown; sshTarget?: unknown },
  ): DeviceSshHost {
    const current = this.#hosts.find((host) => host.hostId === hostId);
    if (!current) throw new DeviceHostStoreError('not-found');
    const label =
      input.label === undefined ? current.label : cleanLabel(input.label);
    const sshTarget =
      input.sshTarget === undefined
        ? current.sshTarget
        : cleanTarget(input.sshTarget);
    if (
      sshTarget !== current.sshTarget &&
      this.#hosts.some((host) => host.sshTarget === sshTarget)
    )
      throw new DeviceHostStoreError('duplicate');
    const next: DeviceSshHost = {
      ...current,
      label,
      sshTarget,
      hubEnabled: sshTarget === current.sshTarget ? current.hubEnabled : false,
      updatedAt: this.now().toISOString(),
    };
    this.#hosts = this.#hosts.map((host) =>
      host.hostId === hostId ? next : host,
    );
    this.#save();
    return structuredClone(next);
  }

  setHubEnabled(hostId: string, enabled: boolean): DeviceSshHost {
    const current = this.#hosts.find((host) => host.hostId === hostId);
    if (!current) throw new DeviceHostStoreError('not-found');
    const next = {
      ...current,
      hubEnabled: enabled,
      updatedAt: this.now().toISOString(),
    };
    this.#hosts = this.#hosts.map((host) =>
      host.hostId === hostId ? next : host,
    );
    this.#save();
    return structuredClone(next);
  }

  remove(hostId: string): void {
    const next = this.#hosts.filter((host) => host.hostId !== hostId);
    if (next.length === this.#hosts.length)
      throw new DeviceHostStoreError('not-found');
    this.#hosts = next;
    this.#save();
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as StoreShape;
      if (parsed?.version !== 1 || !Array.isArray(parsed.hosts)) return;
      const seen = new Set<string>();
      for (const host of parsed.hosts) {
        // An invalid record is dropped, never repaired into something usable.
        if (
          !host ||
          !SSH_HOST_ID.test(host.hostId) ||
          seen.has(host.hostId) ||
          !isSshDeviceTarget(host.sshTarget) ||
          typeof host.hubEnabled !== 'boolean' ||
          typeof host.createdAt !== 'string' ||
          typeof host.updatedAt !== 'string'
        )
          continue;
        try {
          cleanLabel(host.label);
        } catch {
          continue;
        }
        seen.add(host.hostId);
        this.#hosts.push({
          hostId: host.hostId,
          label: host.label.trim(),
          sshTarget: host.sshTarget,
          hubEnabled: host.hubEnabled,
          createdAt: host.createdAt,
          updatedAt: host.updatedAt,
        });
        if (this.#hosts.length >= MAX_HOSTS) break;
      }
    } catch {
      // An unreadable file lists no hosts (fail closed).
    }
  }

  #save(): void {
    mkdirSync(join(this.#path, '..'), { recursive: true });
    const shape: StoreShape = { version: 1, hosts: this.#hosts };
    const temp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(shape, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.#path);
  }
}
