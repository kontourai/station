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
import { join } from 'node:path';
import {
  type PackagedReleaseManifest,
  readPrebuiltArchiveRelease,
} from '@kontourai/station-shared/prebuilt-archive';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';

// The archive facts themselves live in the shared module, which the server's
// update route reads too (#2675 D3); these re-exports keep the CLI's
// importers on one path.
export {
  INSTALL_ROOT_MARKER_CONTENT,
  INSTALL_ROOT_MARKER_FILENAME,
  type InstallerOwnedArchiveFs,
  isPackagedReleaseChannel,
  isPrebuiltArchiveRoot,
  PACKAGED_RELEASE_MANIFEST_FILENAME,
  type PackagedReleaseChannel,
  type PackagedReleaseManifest,
  type PackagedRuntimeChannel,
  PREBUILT_ARCHIVE_MARKER_CONTENT,
  PREBUILT_ARCHIVE_MARKER_FILENAME,
  resolveInstallerOwnedArchiveVersion,
  validatePackagedReleaseManifest,
} from '@kontourai/station-shared/prebuilt-archive';

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
