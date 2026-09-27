/**
 * What kind of tree the CLI runs from, and where its lifecycle state lives
 * (#2675 slice B1). This is the ONE resolver for "where does lifecycle state
 * live": the instance records, the prior pid file and the build candidates
 * all derive from `resolveLifecycleStateLocation`, never from their own
 * `join`.
 * (The server's git self-update keeps reading `<gitRoot>/.station/`; it only
 * ever runs from a source checkout.)
 *
 * - A **source** tree (a git checkout, or an install.sh release tree that is
 *   built on the host) keeps its state inside itself, exactly as before:
 *   `<root>/.station/instances/`, `<root>/.station/build-candidates/` and the
 *   legacy `<root>/.station.pids`. The state describes what THIS checkout
 *   started and built, so anchoring it to the checkout is the point.
 * - A **prebuilt archive** is an immutable version directory: the installer
 *   (slice B2) marks it read-only, and an upgrade runs a different version
 *   directory of the same channel. Its state therefore lives outside it, in
 *   `<STATION_ROOT>/state/<channel>/` of the root the instance's home belongs
 *   to (see `resolveLifecycleStateLocation`), shared by every version of
 *   that channel, so the new version's `stop` finds what the old one
 *   started. The default home's root is `~/.station` (`%USERPROFILE%\.station`
 *   on Windows). The channel is the
 *   runtime channel the archive's own `.station-release.json` names (the
 *   launcher refuses any other `STATION_CHANNEL`), so it never depends on
 *   the caller's environment agreeing.
 *
 * No migration: no archive has been released, so no archive-root state
 * exists anywhere to carry over.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  STATION_RELEASE_RINGS,
  type StationReleaseRing,
} from '@kontourai/station-shared/ports';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';

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
function readPrebuiltArchiveRelease(
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
 * The install root when `root` (a prebuilt archive's physical path) is the
 * version install.sh made active: `<installRoot>/versions/<version>`, in a
 * root carrying the installer's marker, whose `current` link resolves to
 * `root`. Null for any other archive copy (#2675 slice C).
 *
 * A service unit for such a version runs `<installRoot>/current`, so an
 * upgrade flips `current` without rewriting the unit and a pruned version
 * directory never breaks it.
 */
export function resolveInstallerOwnedArchiveInstallRoot(
  root: string,
  fs: InstallerOwnedArchiveFs = {
    lstatSync,
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    realpathSync: (path) => realpathSync(path),
  },
): string | null {
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
    const current = join(installRoot, 'current');
    if (!fs.lstatSync(current).isSymbolicLink()) return null;
    return fs.realpathSync(current) === fs.realpathSync(root)
      ? installRoot
      : null;
  } catch {
    return null;
  }
}

/** What the CLI runs from. Where its state lives also depends on the home. */
export type LifecycleCodeRoot =
  | { kind: 'source'; root: string }
  | {
      kind: 'prebuilt-archive';
      root: string;
      release: PackagedReleaseManifest;
    };

export interface LifecycleStateLocation {
  /** The directory holding the state below. */
  stateDir: string;
  /** `<id>.json` instance records (owner-only 0700 directory). */
  instanceStateDir: string;
  /**
   * Per-build candidate directories, promoted into the code root. Null for
   * an archive, which refuses to build before it would create one.
   */
  buildCandidatesDir: string | null;
  /**
   * The pre-instance-record pid file, read only to adopt or reap a Station an
   * old CLI started. Null for an archive: no CLI that wrote one ran there.
   */
  pidFile: string | null;
}

export function resolveLifecycleCodeRoot(root: string): LifecycleCodeRoot {
  const release = readPrebuiltArchiveRelease(root);
  return release
    ? { kind: 'prebuilt-archive', root, release }
    : { kind: 'source', root };
}

/**
 * Where lifecycle state lives for an instance of `projectHome`.
 *
 * A source tree ignores the home: its state describes what the checkout
 * started, whatever home each instance used.
 *
 * A prebuilt archive's state lives in `<root>/state/<channel>/` of the
 * Station root the home belongs to, decided by the home's path ALONE: a home
 * at `<root>/instances/<leaf>` (or `instances/dev/<leaf>`) belongs to
 * `<root>`, so the default channel home gives `~/.station`; any other home,
 * including a `--temp-home`, is its own root, so its state lives inside it
 * and goes when it goes.
 *
 * The environment is deliberately not consulted (#2675 B1 review). The
 * ambient `STATION_ROOT` depends on how the home was spelled: the CLI
 * bootstrap writes the default root into it unless `STATION_HOME` names a
 * raw home, so `STATION_HOME=/srv/st station start` and `station stop
 * --home=/srv/st` would otherwise read two different roots and lose the
 * record.
 */
export function resolveLifecycleStateLocation(
  codeRoot: LifecycleCodeRoot,
  projectHome: string,
): LifecycleStateLocation {
  if (codeRoot.kind === 'source') {
    const stateDir = join(codeRoot.root, '.station');
    return {
      stateDir,
      instanceStateDir: join(stateDir, 'instances'),
      buildCandidatesDir: join(stateDir, 'build-candidates'),
      pidFile: join(codeRoot.root, '.station.pids'),
    };
  }
  const stateDir = join(
    resolveStationRoot({ STATION_HOME: projectHome }),
    'state',
    codeRoot.release.channel,
  );
  return {
    stateDir,
    instanceStateDir: join(stateDir, 'instances'),
    buildCandidatesDir: null,
    pidFile: null,
  };
}
