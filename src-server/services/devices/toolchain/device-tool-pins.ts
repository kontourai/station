/**
 * Pinned device tools (#1970, D11).
 *
 * Each tool is installed from a pinned npm lockfile, so EVERY package in its
 * tree — not just the top one — is fetched at an exact version and checked
 * against a sha512 registry integrity. The lockfiles were produced once,
 * 2026-09-22, by `npm install --ignore-scripts --save-exact <tool>@<version>`
 * in a scratch directory outside the repository and Station home, and the
 * top-level integrity was cross-checked against `npm view <tool>@<version>
 * dist.integrity`. `requiredIntegrity` below repeats that value so a lockfile
 * edited out of step with its pin fails closed (see `assertPinnedLock`).
 *
 * Version choice: expo-device-hub 0.10.1 over the 0.9.0 Station's experiment
 * used. Both were started on loopback with `--port 0` and answered `/readyz`
 * and `/api/devices` with the same device-list shape `LocalMobileDeviceHost`
 * parses, and 0.10.1 is the newer of the two. agent-device 0.21.12 is the
 * current release.
 *
 * Disclosed limitation — WebRTC is unsupported. expo-device-hub depends on
 * node-datachannel, a native addon whose install script would download a
 * prebuilt binary; `--ignore-scripts` skips it, so no native binary is
 * installed. serve-emu's WebRTC path would try to fetch one at runtime with
 * prebuild-install (unpinned); Station prevents that three ways: the hub
 * guard refuses the WebRTC offer routes, refuses to spawn prebuild-install,
 * and the hub's npm proxy settings point at a dead loopback port. Streams
 * use MJPEG (`--transport mjpeg`) and the screenshot routes.
 *
 * The hub guard (`device-hub-guard.ts`) is verified against expo-device-hub
 * 0.10.1's route surface; bumping the hub means re-checking that surface and
 * `HUB_GUARD_VERIFIED_VERSIONS`, or the supervisor refuses to launch it.
 *
 * Bump deliberately: regenerate the lockfile the same way, update the
 * version, integrity and file name together, and keep the old lock until no
 * install needs it.
 */
import type { DeviceToolId } from '@kontourai/station-contracts/device-toolchain';
import agentDeviceLock from './locks/agent-device-0.21.12.lock.json' with {
  type: 'json',
};
import deviceHubLock from './locks/expo-device-hub-0.10.1.lock.json' with {
  type: 'json',
};

/** The subset of an npm v3 lockfile the toolchain reads. */
export interface PinnedLockfile {
  name: string;
  lockfileVersion: number;
  packages: Record<
    string,
    {
      name?: string;
      version?: string;
      resolved?: string;
      integrity?: string;
      dependencies?: Record<string, string>;
      bin?: unknown;
    }
  >;
}

export interface DeviceToolPin {
  tool: DeviceToolId;
  version: string;
  /** sha512 registry integrity of the tool's own tarball. */
  requiredIntegrity: string;
  /** Entry script, relative to the installed package root. */
  entry: readonly string[];
  lock: PinnedLockfile;
}

export const DEVICE_TOOL_PINS: Readonly<Record<DeviceToolId, DeviceToolPin>> = {
  'expo-device-hub': {
    tool: 'expo-device-hub',
    version: '0.10.1',
    requiredIntegrity:
      'sha512-C2f36TsgiE86lMOxBxCPUrmBO2bBIjGZ3sM6IMM0Y5akZZZxALdy/LlDRcVGJg48cS336CHWsGvrCnnCjhw/Fw==',
    entry: ['dist', 'server', 'cli.mjs'],
    lock: deviceHubLock as PinnedLockfile,
  },
  'agent-device': {
    tool: 'agent-device',
    version: '0.21.12',
    requiredIntegrity:
      'sha512-aeIMmmMRUCnpRzhl3it0/PpTxhfcnxk8U3epV3kGRw9aQgo2UZa04kBc/h6i7wswhiuZw29TSPO0ewths3eJHg==',
    entry: ['bin', 'agent-device.mjs'],
    lock: agentDeviceLock as PinnedLockfile,
  },
};

const REGISTRY = 'https://registry.npmjs.org/';
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

/**
 * The pin's own consistency, checked before anything is fetched: the root
 * requires exactly this tool at this version, the tool's lock entry carries
 * the pinned integrity, and every package resolves from the public registry
 * with a sha512 integrity. Returns a reason, or undefined when sound.
 */
export function assertPinnedLock(pin: DeviceToolPin): string | undefined {
  const root = pin.lock.packages[''];
  const deps = root?.dependencies ?? {};
  if (
    pin.lock.lockfileVersion !== 3 ||
    Object.keys(deps).length !== 1 ||
    deps[pin.tool] !== pin.version
  )
    return `The pinned lockfile does not require exactly ${pin.tool}@${pin.version}.`;
  const own = pin.lock.packages[`node_modules/${pin.tool}`];
  if (own?.version !== pin.version || own.integrity !== pin.requiredIntegrity)
    return `The pinned lockfile's ${pin.tool} entry does not match the pinned integrity.`;
  for (const [path, entry] of Object.entries(pin.lock.packages)) {
    if (path === '') continue;
    if (
      !path.startsWith('node_modules/') ||
      path.split('/').includes('..') ||
      typeof entry.version !== 'string' ||
      typeof entry.integrity !== 'string' ||
      !SHA512.test(entry.integrity) ||
      typeof entry.resolved !== 'string' ||
      !entry.resolved.startsWith(REGISTRY)
    )
      return `The pinned lockfile entry ${path} is not an exact registry package with a sha512 integrity.`;
  }
  return undefined;
}
