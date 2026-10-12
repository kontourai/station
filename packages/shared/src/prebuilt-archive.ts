/**
 * What a prebuilt Station archive is, and where install.sh put it (#2675).
 *
 * The CLI (packages/cli/src/commands/lifecycle-code-root.ts) and the server's
 * update route (src-server/routes/system/install-provenance.ts) both ask
 * these questions, so both read the answer from here: one resolver for "is
 * this tree a prebuilt archive" and one for "is it an installer-owned version
 * directory".
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { STATION_RELEASE_RINGS, type StationReleaseRing } from './ports.js';
import { windowsSystemUtilityPath } from './windows-system-utility.mjs';

export interface PackagedReleaseManifest {
  schemaVersion: 2;
  sha: string;
  ref: string;
  createdAt: string;
  channel: PackagedRuntimeChannel;
  releaseChannel: PackagedReleaseChannel;
  prerelease: boolean;
}

export type PackagedReleaseChannel = StationReleaseRing;
export type PackagedRuntimeChannel =
  (typeof STATION_RELEASE_RINGS)[PackagedReleaseChannel]['runtimeChannel'];

export const PACKAGED_RELEASE_MANIFEST_FILENAME = '.station-release.json';

/**
 * The installable packaged rings come from config/channel-ports.json (via the
 * generated STATION_RELEASE_RINGS); a Nightly-staging bundle is evidence-only
 * and deliberately absent. A prerelease ring's tag is `vX.Y.Z-<ring>.N`.
 */
function packagedReleaseTag(ring: PackagedReleaseChannel): RegExp {
  const label = STATION_RELEASE_RINGS[ring].prerelease
    ? `-${ring}\\.(?:[1-9]\\d*)`
    : '';
  return new RegExp(
    `^v(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)${label}$`,
  );
}

export function isPackagedReleaseChannel(
  value: unknown,
): value is PackagedReleaseChannel {
  return (
    typeof value === 'string' && Object.hasOwn(STATION_RELEASE_RINGS, value)
  );
}

export function validatePackagedReleaseManifest(
  value: unknown,
): PackagedReleaseManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PackagedReleaseManifest>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'channel',
    'createdAt',
    'prerelease',
    'ref',
    'releaseChannel',
    'schemaVersion',
    'sha',
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    candidate.schemaVersion !== 2 ||
    typeof candidate.sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(candidate.sha) ||
    typeof candidate.ref !== 'string' ||
    !/^[A-Za-z0-9._/-]{1,128}$/.test(candidate.ref) ||
    typeof candidate.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    new Date(Date.parse(candidate.createdAt)).toISOString() !==
      candidate.createdAt ||
    !isPackagedReleaseChannel(candidate.releaseChannel) ||
    candidate.channel !==
      STATION_RELEASE_RINGS[candidate.releaseChannel].runtimeChannel ||
    candidate.prerelease !==
      STATION_RELEASE_RINGS[candidate.releaseChannel].prerelease ||
    !packagedReleaseTag(candidate.releaseChannel).test(candidate.ref)
  ) {
    return null;
  }
  return {
    schemaVersion: 2,
    sha: candidate.sha,
    ref: candidate.ref,
    createdAt: candidate.createdAt,
    channel: STATION_RELEASE_RINGS[candidate.releaseChannel].runtimeChannel,
    releaseChannel: candidate.releaseChannel,
    prerelease: STATION_RELEASE_RINGS[candidate.releaseChannel].prerelease,
  };
}

/**
 * Written only by the portable server archive builder
 * (scripts/lib/portable-server-archive.mjs), whose trees ship dist-server and
 * dist-ui prebuilt and carry no toolchain to rebuild them. install.sh's
 * source release trees also have `.station-release.json` and no `.git`, but
 * they are built on the host and never contain this marker.
 */
export const PREBUILT_ARCHIVE_MARKER_FILENAME = '.station-prebuilt-archive';
export const PREBUILT_ARCHIVE_MARKER_CONTENT = 'station-prebuilt-archive-v1\n';

/**
 * The release provenance of a prebuilt archive root, or null for anything
 * else: marker, valid release provenance, and no checkout.
 */
export function readPrebuiltArchiveRelease(
  root: string,
): PackagedReleaseManifest | null {
  if (existsSync(join(root, '.git'))) return null;
  try {
    if (
      readFileSync(join(root, PREBUILT_ARCHIVE_MARKER_FILENAME), 'utf-8') !==
      PREBUILT_ARCHIVE_MARKER_CONTENT
    ) {
      return null;
    }
    return validatePackagedReleaseManifest(
      JSON.parse(
        readFileSync(join(root, PACKAGED_RELEASE_MANIFEST_FILENAME), 'utf-8'),
      ),
    );
  } catch {
    return null;
  }
}

/** A prebuilt archive: marker, valid release provenance, and no checkout. */
export function isPrebuiltArchiveRoot(root: string): boolean {
  return readPrebuiltArchiveRelease(root) !== null;
}

/** The version a release names: its tag without the leading `v`. */
export function packagedReleaseVersion(
  release: Pick<PackagedReleaseManifest, 'ref'>,
): string {
  return release.ref.slice(1);
}

/**
 * install.sh claims an install root with this marker, with exactly this
 * content (INSTALL_ROOT_MARKER / INSTALL_ROOT_SIGNATURE there).
 */
export const INSTALL_ROOT_MARKER_FILENAME = '.station-portable-install-root';
export const INSTALL_ROOT_MARKER_CONTENT = 'station-portable-install-root-v1\n';

export interface InstallerOwnedArchiveFs {
  lstatSync: (path: string) => { isSymbolicLink(): boolean };
  readFileSync: (path: string, encoding: 'utf8') => string;
  realpathSync: (path: string) => string;
}

/**
 * Where `root` (a prebuilt archive's physical path) sits in an install.sh
 * install (#2675 slice C): `<installRoot>/versions/<version>` in a root
 * carrying the installer's marker. `active` says whether the root's
 * `current` link resolves to `root`. Null for any other archive copy.
 *
 * A service unit for the active version runs `<installRoot>/current`, so an
 * upgrade flips `current` without rewriting the unit and a pruned version
 * directory never breaks it. An inactive version is one install.sh may prune
 * at its next upgrade.
 */
export function resolveInstallerOwnedArchiveVersion(
  root: string,
  fs: InstallerOwnedArchiveFs = {
    lstatSync,
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    realpathSync: (path) => realpathSync(path),
  },
): { installRoot: string; active: boolean } | null {
  const versions = dirname(root);
  if (basename(versions) !== 'versions') return null;
  const installRoot = dirname(versions);
  try {
    if (
      fs.readFileSync(
        join(installRoot, INSTALL_ROOT_MARKER_FILENAME),
        'utf8',
      ) !== INSTALL_ROOT_MARKER_CONTENT
    ) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const current = join(installRoot, 'current');
    return {
      installRoot,
      active:
        fs.lstatSync(current).isSymbolicLink() &&
        fs.realpathSync(current) === fs.realpathSync(root),
    };
  } catch {
    return { installRoot, active: false };
  }
}

export const INSTALL_STATE_FILENAME = '.station-release-state.json';

/**
 * The part of install.sh's install state (`.station-release-state.json`,
 * schema 3 or 4) an update reads: the ring it installs and, since schema 4,
 * the signed public manifest it installs from (null for the authenticated
 * GitHub-release path, and for schema 3). Null when the file is missing or
 * is not a state install.sh writes; never a guess.
 */
export interface ArchiveInstallState {
  releaseChannel: PackagedReleaseChannel;
  manifestUrl: string | null;
}

export function readArchiveInstallState(
  installRoot: string,
): ArchiveInstallState | null {
  let value: unknown;
  try {
    value = JSON.parse(
      readFileSync(join(installRoot, INSTALL_STATE_FILENAME), 'utf8'),
    );
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== 3 && state.schemaVersion !== 4) return null;
  if (!isPackagedReleaseChannel(state.releaseChannel)) return null;
  if (
    state.channel !== STATION_RELEASE_RINGS[state.releaseChannel].runtimeChannel
  )
    return null;
  let manifestUrl: string | null = null;
  if (state.schemaVersion === 4) {
    if (state.manifestUrl !== null && typeof state.manifestUrl !== 'string')
      return null;
    manifestUrl = state.manifestUrl || null;
  }
  return { releaseChannel: state.releaseChannel, manifestUrl };
}

/**
 * The launch facts the CLI's source bootstrap (scripts/source-bootstrap.ts)
 * writes into the environment of every Station CLI process, including the one
 * running `station upgrade` and the service's `service run`. They describe
 * that process, filled with the channel's defaults when the caller named
 * nothing, so they are not a request for the installed runtime. install.sh
 * reads STATION_SERVER_PORT and STATION_UI_PORT as explicit ports that beat
 * the recorded ones (#2675), and the rest would reach the processes it runs.
 * STATION_CHANNEL, STATION_ROOT and STATION_HOME are bootstrap facts too, but
 * every installer invocation sets them from the install state.
 */
const BOOTSTRAP_LAUNCH_ENV_KEYS: readonly string[] = [
  'STATION_SERVER_PORT',
  'STATION_PORT',
  'STATION_UI_PORT',
  'STATION_CONSENT_PORT',
  'STATION_INSTANCE_ID',
];

/**
 * `env` without the bootstrap's launch facts, for an install.sh a Station CLI
 * process runs. A deliberate port change goes through the installer's own
 * STATION_INSTALL_SERVER_PORT / STATION_INSTALL_UI_PORT, which the bootstrap
 * never sets and which pass through.
 */
export function installerInheritedEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !BOOTSTRAP_LAUNCH_ENV_KEYS.includes(key),
    ),
  );
}

/**
 * How a Station CLI re-runs the installer an installed archive version
 * carries (#2675): its install.sh through `sh` on Linux and macOS, and on
 * Windows its install.ps1 (slice W2) through the system's Windows PowerShell,
 * never one PATH selects, with the execution policy bypassed for that one
 * script. `file` is the installer the version must carry.
 */
export function packagedInstallerCommand(
  releaseDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; file: string } {
  if (platform === 'win32') {
    const file = join(releaseDir, 'install.ps1');
    return {
      command: windowsSystemUtilityPath('powershell', env),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        file,
        'install',
      ],
      file,
    };
  }
  return {
    command: 'sh',
    args: ['./install.sh', 'install'],
    file: join(releaseDir, 'install.sh'),
  };
}

/**
 * Station's release order, the one install.sh's downgrade check and the
 * service launcher (packaging/portable-server/bin/station-launcher.mjs
 * `compareVersions`) apply: X.Y.Z, or X.Y.Z-<ring>.N within one ring, and a
 * release outranks every prerelease of its X.Y.Z. Null when the two cannot be
 * ordered (another ring's prerelease, or not a Station version at all).
 */
export function compareStationReleaseVersions(
  left: string,
  right: string,
): -1 | 0 | 1 | null {
  const shape =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z]+)\.([1-9][0-9]*))?$/;
  const read = (version: string) => {
    const match = shape.exec(version);
    if (!match) return null;
    return {
      release: match.slice(1, 4).map((part) => BigInt(part)),
      ring: match[4] ?? null,
      build: match[5] === undefined ? null : BigInt(match[5]),
    };
  };
  const a = read(left);
  const b = read(right);
  if (!a || !b) return null;
  const order = (x: bigint | null, y: bigint | null): -1 | 0 | 1 =>
    x === y ? 0 : (x ?? 0n) < (y ?? 0n) ? -1 : 1;
  for (let part = 0; part < 3; part += 1) {
    const result = order(a.release[part] ?? 0n, b.release[part] ?? 0n);
    if (result !== 0) return result;
  }
  if (a.ring === b.ring) return a.ring === null ? 0 : order(a.build, b.build);
  if (a.ring === null) return 1;
  if (b.ring === null) return -1;
  return null;
}
