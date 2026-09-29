/**
 * The Windows installer core (#2675 slice W1). install.ps1 is a thin
 * PowerShell bootstrap: it finds a Node.js (host, the channel's installed
 * runtime, or the pinned official zip) and runs this module, bundled into
 * install.ps1 as a generated block, with the caller's environment. It is the
 * same contract as install.sh, in the same variables and messages, for the
 * prebuilt `station-server-win32-x64.zip` archive.
 *
 * W1 implements the stage-only mode (STATION_INSTALL_STAGE_ONLY=1), which the
 * service launcher's child runs to stage an update, and which is also the
 * first half of every install: download and verify the signed manifest,
 * download the archive within its signed size and check its sha256, refuse
 * any unsafe zip entry, read its marker and provenance, extract it into
 * `<install root>/versions/<version>`, run its own `--version`, write the
 * completion sentinel and seal it read-only. It changes nothing else: not
 * `current`, not a launcher, not the install state, not a service. A full
 * install, uninstall, the `current` junction and ACLs arrive with W2.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import CHANNEL_CONFIG from '../../../../config/channel-ports.json' with {
  type: 'json',
};
import PINNED_MANIFEST_SIGNING_KEYS from '../../../../config/release-manifest-keys.json' with {
  type: 'json',
};
import { findPortableServerTarget } from '../portable-server-targets.mjs';
import type { ReleaseManifestPayload } from '../release-manifest.mjs';
import { DownloadTooLarge, downloadCapped } from './download.js';
import {
  ManifestRefusal,
  manifestFailureSummary,
  verifyInstallManifest,
} from './manifest.js';
import { compareReleaseTags } from './release-order.js';
import {
  extractZipEntries,
  readNamedEntry,
  withZip,
  type ZipEntry,
  ZipRefusal,
} from './zip.js';

/** The launcher protocol of the launcher this installer family writes. */
export const INSTALLER_LAUNCHER_PROTOCOL = 1;
export const MANIFEST_MAX_BYTES = 1_048_576;
const ARCHIVE_ROOT = 'station';
const PREBUILT_ARCHIVE_MARKER = '.station-prebuilt-archive';
const PREBUILT_ARCHIVE_SIGNATURE = 'station-prebuilt-archive-v1\n';
const INSTALL_ROOT_MARKER = '.station-portable-install-root';
const INSTALL_ROOT_SIGNATURE = 'station-portable-install-root-v1\n';
const VERSION_SENTINEL = '.station-install-complete';
const SELF_CHECK_TIMEOUT_MS = 120_000;

type Ring = { runtimeChannel: string; prerelease: boolean };
const RINGS = CHANNEL_CONFIG.releaseRings as Record<string, Ring>;
const PRERELEASE_RINGS = new Set(
  Object.entries(RINGS)
    .filter(([, ring]) => ring.prerelease)
    .map(([name]) => name),
);

/** A refusal: the installer prints `Station install failed: <message>`. */
export class InstallRefusal extends Error {}

function fail(message: string): never {
  throw new InstallRefusal(message);
}

export type InstallerIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export type InstallerEnv = Readonly<Record<string, string | undefined>>;

/** The ring an installable runtime channel installs as, or undefined. */
function ringOfRuntime(channel: string): string | undefined {
  return Object.entries(RINGS).find(
    ([, ring]) => ring.runtimeChannel === channel,
  )?.[0];
}

const foldsCase = process.platform === 'win32' || process.platform === 'darwin';
const fold = (value: string) => (foldsCase ? value.toLowerCase() : value);
const same = (left: string, right: string) => fold(left) === fold(right);
const inside = (child: string, parent: string) =>
  same(child, parent) || fold(child).startsWith(`${fold(parent)}${sep}`);

/**
 * `path` absolute, with every existing prefix resolved through its links, as
 * install.sh's canonicalize_path does.
 */
function canonicalize(path: string): string {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    const next = join(cursor, segments[index]);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return resolve(cursor, ...segments.slice(index));
      throw error;
    }
    cursor = info.isSymbolicLink() ? realpathSync(next) : next;
  }
  return resolve(cursor);
}

const owner = typeof process.getuid === 'function' ? process.getuid() : null;

/** A same-user directory nobody else can write (POSIX modes; ACLs are W2). */
function assertSafeDirectory(path: string): boolean {
  const info = lstatSync(path);
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (owner === null || (info.uid === owner && (info.mode & 0o022) === 0))
  );
}

function prepareSafeDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!assertSafeDirectory(path))
    fail(`directory must be same-user and not group/world writable: ${path}`);
}

/** install.sh's prepare_owned_root with the `reject` policy. */
function prepareOwnedInstallRoot(root: string): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const refuse = () =>
    fail(
      `STATION_INSTALL_ROOT is not an empty or installer-owned directory: ${root}`,
    );
  if (!assertSafeDirectory(root)) refuse();
  const marker = join(root, INSTALL_ROOT_MARKER);
  if (existsSync(marker)) {
    const info = lstatSync(marker);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (owner !== null && (info.uid !== owner || (info.mode & 0o077) !== 0)) ||
      readFileSync(marker, 'utf8') !== INSTALL_ROOT_SIGNATURE
    )
      refuse();
    return;
  }
  if (readdirSync(root).length > 0) refuse();
  const fd = openSync(marker, 'wx', 0o600);
  try {
    writeFileSync(fd, INSTALL_ROOT_SIGNATURE);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The installer owns exactly one channel leaf, never a shared Station root
 * or container (install.sh's assert_install_root_is_channel_leaf).
 */
function assertInstallRootIsChannelLeaf(
  installRoot: string,
  stationRoot: string,
  channel: string,
  rawInstallRoot: string,
): void {
  try {
    if (lstatSync(rawInstallRoot).isSymbolicLink())
      fail(
        'Station runtime paths are invalid, protected, or contain an unsafe selected link',
      );
  } catch (error) {
    if (error instanceof InstallRefusal) throw error;
  }
  for (const shared of [
    stationRoot,
    join(stationRoot, 'config'),
    join(stationRoot, 'instances'),
    join(stationRoot, 'cache'),
    join(stationRoot, 'installs'),
  ])
    if (inside(shared, installRoot))
      fail(
        `STATION_INSTALL_ROOT must be a channel leaf, not a Station shared root or container: ${rawInstallRoot}`,
      );
  for (const name of ['config', 'instances', 'cache'])
    if (inside(installRoot, join(stationRoot, name)))
      fail(
        `STATION_INSTALL_ROOT must not be inside protected Station data: ${rawInstallRoot}`,
      );
  const leaf = join(stationRoot, 'installs', channel);
  if (
    inside(installRoot, join(stationRoot, 'installs')) &&
    !same(installRoot, leaf)
  )
    fail(
      `STATION_INSTALL_ROOT must be the verified ${channel} channel leaf: ${rawInstallRoot}`,
    );
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Makes a tree writable again (an installed version is sealed) and removes it. */
export function removeTree(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    chmodSync(path, info.mode | 0o700);
    for (const name of readdirSync(path)) removeTree(join(path, name));
  } else if (!info.isSymbolicLink()) {
    chmodSync(path, info.mode | 0o200);
  }
  rmSync(path, { recursive: true, force: true });
}

/**
 * Seals an installed version read-only: an installed archive version is
 * immutable, and lifecycle state lives outside it (#2675 B1). On Windows
 * this sets each file's ReadOnly attribute; directories are left alone there.
 */
function sealTree(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) sealTree(join(path, name));
    if (process.platform !== 'win32') chmodSync(path, info.mode & ~0o222);
    return;
  }
  chmodSync(path, info.mode & ~0o222);
}

type Paths = {
  channel: string;
  ring: string;
  stationRoot: string;
  installRoot: string;
  versions: string;
  current: string;
};

/**
 * Why `installRoot` may not be used on Windows, or null. Until install.ps1
 * applies and checks the install root's ACL (#2675 slice W2), the only
 * directories this installer trusts on Windows are those beneath the user's
 * profile, which Windows gives the user, SYSTEM and Administrators alone. A
 * root elsewhere (C:\station, say) typically inherits write access for every
 * local user, who could then plant a version the installer reuses. Both
 * paths are canonical (links resolved).
 */
export function windowsInstallRootRefusal(
  installRoot: string,
  profile: string,
): string | null {
  if (inside(installRoot, profile) && !same(installRoot, profile)) return null;
  return `on Windows, install.ps1 installs only beneath your user profile (${profile}) until it checks install-root permissions (#2675 slice W2); ${installRoot} is outside it`;
}

/**
 * A root the installer accepts: absolute, and on Windows drive-qualified or
 * UNC (`\\foo` and `C:foo` depend on the current drive or its directory). A
 * relative root would resolve against whichever directory a caller's tool
 * uses, which install.ps1 cannot keep consistent (#2675 W1 review).
 */
export function isAbsoluteRoot(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32')
    return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value);
  return value.startsWith('/');
}

function assertAbsoluteRoots(env: InstallerEnv): void {
  for (const name of [
    'STATION_ROOT',
    'STATION_INSTALL_ROOT',
    'STATION_HOME',
  ] as const) {
    const value = (env[name] ?? '').trim();
    if (value !== '' && !isAbsoluteRoot(value))
      fail(`${name} must be an absolute path: ${env[name]}`);
  }
}

function resolvePaths(env: InstallerEnv, channel: string, ring: string): Paths {
  assertAbsoluteRoots(env);
  const stationRoot = canonicalize(
    (env.STATION_ROOT ?? '').trim() || join(homedir(), '.station'),
  );
  const rawInstallRoot =
    env.STATION_INSTALL_ROOT || join(stationRoot, 'installs', channel);
  const installRoot = canonicalize(rawInstallRoot);
  assertInstallRootIsChannelLeaf(
    installRoot,
    stationRoot,
    channel,
    rawInstallRoot,
  );
  if (process.platform === 'win32') {
    const refusal = windowsInstallRootRefusal(
      installRoot,
      canonicalize(homedir()),
    );
    if (refusal) fail(refusal);
  }
  return {
    channel,
    ring,
    stationRoot,
    installRoot,
    versions: join(installRoot, 'versions'),
    current: join(installRoot, 'current'),
  };
}

function isUrlAllowed(value: string, allowTest: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' ||
    (allowTest && ['http:', 'file:'].includes(url.protocol))
  );
}

type Provenance = { runtimeChannel: string; bytes: Buffer };

function verifyProvenance(
  bytes: Buffer,
  payload: ReleaseManifestPayload,
): Provenance {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('release provenance is invalid');
  }
  const ring =
    typeof value?.releaseChannel === 'string' &&
    Object.hasOwn(RINGS, value.releaseChannel)
      ? RINGS[value.releaseChannel]
      : undefined;
  if (
    value?.schemaVersion !== 2 ||
    !ring ||
    value.channel !== ring.runtimeChannel ||
    value.prerelease !== ring.prerelease ||
    value.sha !== payload.sourceSha ||
    value.ref !== payload.releaseTag ||
    value.releaseChannel !== payload.channel ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(new Date(value.createdAt).getTime()) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  )
    fail('release provenance is invalid');
  return { runtimeChannel: ring.runtimeChannel, bytes };
}

function versionPaths(dir: string) {
  return {
    node: join(dir, 'runtime', 'node.exe'),
    entry: join(dir, 'bin', 'station.mjs'),
    sentinel: join(dir, VERSION_SENTINEL),
  };
}

function isCompleteVersion(dir: string, sha256: string): boolean {
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const paths = versionPaths(dir);
    return (
      statSync(paths.node).isFile() &&
      statSync(paths.entry).isFile() &&
      readFileSync(paths.sentinel, 'utf8') === `${sha256}\n`
    );
  } catch {
    return false;
  }
}

/** The version directory `current` names, or null when there is no `current`. */
function activeVersionDir(current: string): string | null {
  try {
    if (!lstatSync(current).isSymbolicLink()) return null;
    return realpathSync(current);
  } catch {
    return null;
  }
}

/**
 * The extracted archive reports its own identity and the Node.js that runs
 * it, which must be the signed manifest's (install.sh finish_archive_version).
 */
function selfCheck(
  dir: string,
  payload: ReleaseManifestPayload,
  runtimeChannel: string,
  cwd: string,
): boolean {
  const paths = versionPaths(dir);
  const result = spawnSync(paths.node, [paths.entry, '--version', '--json'], {
    cwd,
    encoding: 'utf8',
    timeout: SELF_CHECK_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return false;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  return (
    value?.ref === payload.releaseTag &&
    value.sha === payload.sourceSha &&
    value.channel === runtimeChannel &&
    value.releaseChannel === payload.channel &&
    value.node === `v${payload.nodeVersion}`
  );
}

type Context = {
  env: InstallerEnv;
  io: InstallerIo;
  tmp: string;
};

type StageRequest = {
  requested: string;
  ring: string;
  manifestUrl: string;
  allowTest: boolean;
  testKeyUrl: string;
  testTarget: string;
  version: string;
};

/** The caller's environment, validated as install.sh validates it. */
function readStageRequest(env: InstallerEnv): StageRequest {
  const requested = env.STATION_CHANNEL || 'stable';
  if (requested === 'preview')
    fail(
      'STATION_CHANNEL=preview is a legacy unqualified channel; rerun with STATION_CHANNEL=beta (or install stable with STATION_CHANNEL=stable)',
    );
  const ring = ringOfRuntime(requested);
  if (!ring)
    fail(
      `STATION_CHANNEL must be one of: ${Object.values(RINGS)
        .map((entry) => entry.runtimeChannel)
        .join(' ')}`,
    );
  const manifestUrl = env.STATION_INSTALL_PUBLIC_MANIFEST_URL ?? '';
  if (!manifestUrl)
    fail(
      'STATION_INSTALL_STAGE_ONLY=1 stages only from a signed public manifest (STATION_INSTALL_PUBLIC_MANIFEST_URL)',
    );
  const allowTest = env.STATION_INSTALL_ALLOW_INSECURE_TEST_URLS === '1';
  const testKeyUrl = env.STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL ?? '';
  if (testKeyUrl && !allowTest)
    fail(
      'STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL is a test-only override and requires STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1; public installs verify against the pinned signing keys',
    );
  const testTarget = env.STATION_INSTALL_TEST_HOST_TARGET ?? '';
  if (testTarget && !allowTest)
    fail(
      'STATION_INSTALL_TEST_HOST_TARGET is a test-only override and requires STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1',
    );
  for (const value of [manifestUrl, testKeyUrl])
    if (value && !isUrlAllowed(value, allowTest))
      fail('the public manifest URL must use HTTPS');

  const version = env.STATION_VERSION || 'latest';
  if (version !== 'latest') {
    const match =
      /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([a-z]+)\.[1-9][0-9]*)?$/.exec(
        version,
      );
    const versionRing = !match
      ? undefined
      : match[1] === undefined
        ? Object.keys(RINGS).find((name) => !RINGS[name].prerelease)
        : PRERELEASE_RINGS.has(match[1])
          ? match[1]
          : undefined;
    if (!versionRing) fail(`invalid STATION_VERSION: ${version}`);
    if (versionRing !== ring)
      fail(
        `STATION_VERSION ${version} is a ${versionRing} release; it cannot be installed as STATION_CHANNEL=${requested}`,
      );
  }
  return {
    requested,
    ring,
    manifestUrl,
    allowTest,
    testKeyUrl,
    testTarget,
    version,
  };
}

type VerifiedRelease = {
  payload: ReleaseManifestPayload;
  artifact: ReleaseManifestPayload['artifacts'][number];
};

/** Downloads and verifies the signed manifest, and selects this host's archive. */
async function fetchVerifiedRelease(
  request: StageRequest,
  io: InstallerIo,
  tmp: string,
): Promise<VerifiedRelease> {
  const { ring, manifestUrl, allowTest, testKeyUrl, testTarget, version } =
    request;
  // Trust comes from the pinned keys plus the sha256 the signed payload
  // carries; see install.sh for what a signature does and does not prove.
  const manifestFile = join(tmp, 'station-ecosystem-manifest.json');
  try {
    await downloadCapped(manifestUrl, manifestFile, {
      maxBytes: MANIFEST_MAX_BYTES,
      allowTestUrls: allowTest,
    });
  } catch (error) {
    if (error instanceof DownloadTooLarge)
      fail('the public ecosystem manifest is larger than 1 MiB');
    io.err(`${(error as Error).message}`);
    fail('could not download public ecosystem manifest');
  }
  let testKeyPem: string | undefined;
  if (testKeyUrl) {
    const keyFile = join(tmp, 'station-ecosystem-manifest-test-key.pem');
    try {
      await downloadCapped(testKeyUrl, keyFile, {
        maxBytes: 65_536,
        allowTestUrls: allowTest,
      });
    } catch {
      fail('could not download the test-only manifest verification key');
    }
    testKeyPem = readFileSync(keyFile, 'utf8');
  }
  const hostTarget = testTarget || `${process.platform}-${process.arch}`;
  let payload: ReleaseManifestPayload;
  let artifact: ReleaseManifestPayload['artifacts'][number];
  try {
    let envelope: unknown;
    try {
      envelope = JSON.parse(readFileSync(manifestFile, 'utf8'));
    } catch {
      throw new ManifestRefusal('manifest is not JSON', 1);
    }
    payload = verifyInstallManifest(envelope, PINNED_MANIFEST_SIGNING_KEYS, {
      expectedChannel: ring,
      allowTestUrls: allowTest,
      testKeyPem,
    });
    io.out(
      `Verified the signed release manifest for Station ${payload.releaseTag} (${payload.channel}).`,
    );
    const found = payload.artifacts.find(
      (candidate) => `${candidate.os}-${candidate.arch}` === hostTarget,
    );
    if (!found)
      throw new ManifestRefusal(
        `the release manifest has no server archive for ${hostTarget}`,
        6,
      );
    artifact = found;
    const { min, max } = payload.launcherProtocol;
    if (INSTALLER_LAUNCHER_PROTOCOL < min || INSTALLER_LAUNCHER_PROTOCOL > max)
      throw new ManifestRefusal(
        `${payload.releaseTag} supports launcher protocols ${min}-${max}; this installer writes protocol ${INSTALLER_LAUNCHER_PROTOCOL}`,
        7,
      );
  } catch (error) {
    if (!(error instanceof ManifestRefusal)) throw error;
    io.err(`Station manifest verification: ${error.message}`);
    fail(manifestFailureSummary(error.code, hostTarget));
  }
  if (version !== 'latest' && version !== payload.releaseTag)
    fail('requested version does not match public ecosystem manifest');
  if (findPortableServerTarget(artifact.os, artifact.arch)?.format !== 'zip')
    fail(
      `${artifact.name} is not a zip archive; this installer extracts zip only`,
    );
  return { payload, artifact };
}

/**
 * Downloads the archive within its signed size, then checks the exact size
 * and the sha256; returns the local path and its digest.
 */
async function downloadVerifiedArchive(
  artifact: VerifiedRelease['artifact'],
  allowTest: boolean,
  io: InstallerIo,
  tmp: string,
): Promise<{ archive: string; actualChecksum: string }> {
  // The signed size bounds the download itself; the exact size and the
  // sha256 are checked once it is complete.
  const archive = join(tmp, artifact.name);
  try {
    await downloadCapped(artifact.url, archive, {
      maxBytes: artifact.size,
      allowTestUrls: allowTest,
    });
  } catch (error) {
    if (error instanceof DownloadTooLarge)
      fail(
        `${artifact.name} is larger than the ${artifact.size} bytes the signed manifest says`,
      );
    io.err(`${(error as Error).message}`);
    fail(`could not download ${artifact.name}`);
  }
  const downloaded = statSync(archive).size;
  if (downloaded > artifact.size)
    fail(
      `${artifact.name} is larger than the ${artifact.size} bytes the signed manifest says`,
    );
  if (downloaded !== artifact.size)
    fail(
      `${artifact.name} is ${downloaded} bytes; the signed manifest says ${artifact.size}`,
    );
  const actualChecksum = sha256File(archive);
  if (actualChecksum !== artifact.sha256)
    fail('release checksum did not match');
  return { archive, actualChecksum };
}

async function stageArchive(context: Context): Promise<number> {
  const { env, io, tmp } = context;
  const request = readStageRequest(env);
  const { requested } = request;
  const paths = resolvePaths(env, requested, request.ring);
  const { payload, artifact } = await fetchVerifiedRelease(request, io, tmp);
  const { archive, actualChecksum } = await downloadVerifiedArchive(
    artifact,
    request.allowTest,
    io,
    tmp,
  );

  const releaseDir = join(paths.versions, payload.version);
  return withZipOrRefuse(archive, (fd, entries) => {
    // Identity first, from the verified archive, before anything on disk
    // changes.
    const marker = readNamedEntry(
      fd,
      entries,
      `${ARCHIVE_ROOT}/${PREBUILT_ARCHIVE_MARKER}`,
    );
    const provenanceBytes = readNamedEntry(
      fd,
      entries,
      `${ARCHIVE_ROOT}/.station-release.json`,
    );
    if (!marker || !provenanceBytes)
      fail(
        'release archive is not a prebuilt Station archive (it has no marker or provenance)',
      );
    if (marker.toString('utf8') !== PREBUILT_ARCHIVE_SIGNATURE)
      fail('release archive marker is invalid');
    const provenance = verifyProvenance(provenanceBytes, payload);
    if (provenance.runtimeChannel !== requested)
      fail('verified release does not match the requested runtime channel');

    const previous = activeVersionDir(paths.current);
    const isActive =
      previous !== null && same(previous, canonicalize(releaseDir));
    if (previous !== null) {
      const outcome = checkAgainstInstalled(
        env,
        io,
        paths,
        payload,
        releaseDir,
        actualChecksum,
        isActive,
      );
      if (outcome === 'nothing-to-do') {
        io.out(`STATION_STAGED_VERSION=${payload.version}`);
        return 0;
      }
    }
    prepareOwnedInstallRoot(paths.installRoot);
    prepareSafeDirectory(paths.versions);

    if (isCompleteVersion(releaseDir, actualChecksum)) {
      io.out('Station release already installed; reusing verified files.');
      io.out(`STATION_STAGED_VERSION=${payload.version}`);
      return 0;
    }
    if (existsSync(releaseDir) || isLink(releaseDir)) {
      if (isActive) {
        if (!existsSync(join(releaseDir, VERSION_SENTINEL)))
          fail(
            'the active release cache is incomplete; refusing to replace running files',
          );
        // The running version stays where it is: the service launcher moves
        // off it only after a trial of a staged one.
        fail(
          `cannot replace the running Station ${payload.releaseTag} in place under the service launcher; nothing was changed`,
        );
      }
      removeTree(releaseDir);
    }
    io.out(`Extracting Station ${payload.releaseTag}...`);
    const stage = join(paths.versions, `.stage.${process.pid}`);
    const incoming = join(paths.versions, `.incoming.${process.pid}`);
    removeTree(stage);
    removeTree(incoming);
    mkdirSync(stage, { mode: 0o700 });
    try {
      extractZipEntries(fd, entries, stage);
    } catch (error) {
      removeTree(stage);
      if (error instanceof ZipRefusal)
        fail(`release archive is invalid: ${error.message}`);
      io.err(`${(error as Error).message}`);
      fail('could not extract the release archive');
    }
    renameSync(join(stage, ARCHIVE_ROOT), incoming);
    rmdirSync(stage);
    // The files extracted are the ones whose identity was read above.
    const extractedMatches = (() => {
      try {
        return (
          readFileSync(join(incoming, '.station-release.json')).equals(
            provenance.bytes,
          ) &&
          readFileSync(join(incoming, PREBUILT_ARCHIVE_MARKER)).equals(marker)
        );
      } catch {
        return false;
      }
    })();
    if (!extractedMatches) {
      removeTree(incoming);
      fail('the extracted release does not match the verified archive');
    }
    if (!selfCheck(incoming, payload, provenance.runtimeChannel, tmp)) {
      removeTree(incoming);
      fail(
        `the extracted release did not report itself as Station ${payload.releaseTag} on Node.js ${payload.nodeVersion}`,
      );
    }
    writeFileSync(join(incoming, VERSION_SENTINEL), `${actualChecksum}\n`);
    try {
      renameSync(incoming, releaseDir);
      sealTree(releaseDir);
    } catch (error) {
      io.err(`${(error as Error).message}`);
      removeTree(incoming);
      removeTree(releaseDir);
      fail('could not place the verified release');
    }
    io.out(`STATION_STAGED_VERSION=${payload.version}`);
    return 0;
  });
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function withZipOrRefuse(
  archive: string,
  use: (fd: number, entries: ZipEntry[]) => number,
): number {
  try {
    return withZip(archive, ARCHIVE_ROOT, use);
  } catch (error) {
    if (error instanceof ZipRefusal)
      fail(
        `release archive contains an unsafe or invalid entry: ${error.message}`,
      );
    throw error;
  }
}

/**
 * Downgrade protection (install.sh check_public_manifest_version): a signed
 * manifest proves who published a release, not that it is newer than the
 * installed one. Only the caller naming the exact version with
 * STATION_INSTALL_ALLOW_ROLLBACK=1 replaces it with an older release or with
 * different bytes of the same version.
 */
function checkAgainstInstalled(
  env: InstallerEnv,
  io: InstallerIo,
  paths: Paths,
  payload: ReleaseManifestPayload,
  releaseDir: string,
  actualChecksum: string,
  isActive: boolean,
): 'nothing-to-do' | 'proceed' {
  const tag = payload.releaseTag;
  const explicit =
    env.STATION_INSTALL_ALLOW_ROLLBACK === '1' &&
    (env.STATION_VERSION || 'latest') === tag;
  let installedTag: unknown;
  try {
    installedTag = JSON.parse(
      readFileSync(join(paths.current, '.station-release.json'), 'utf8'),
    )?.ref;
  } catch {
    installedTag = undefined;
  }
  const relation =
    typeof installedTag === 'string'
      ? compareReleaseTags(installedTag, tag, PRERELEASE_RINGS)
      : null;
  if (relation === null) {
    if (explicit) {
      io.err(
        `Warning: cannot read the installed Station version; replacing it with ${tag} as explicitly requested (STATION_INSTALL_ALLOW_ROLLBACK=1).`,
      );
      return 'proceed';
    }
    fail(
      `cannot compare the installed release with ${tag}; set STATION_VERSION=${tag} and STATION_INSTALL_ALLOW_ROLLBACK=1 to replace it explicitly`,
    );
  }
  if (relation === 'newer') return 'proceed';
  if (relation === 'same') {
    if (isActive && isCompleteVersion(releaseDir, actualChecksum)) {
      io.out(`Station ${tag} is already installed; nothing to do.`);
      return 'nothing-to-do';
    }
    if (explicit) {
      io.out(
        `Replacing the installed Station ${tag} with different bytes published as the same version (STATION_INSTALL_ALLOW_ROLLBACK=1).`,
      );
      return 'proceed';
    }
    fail(
      `refusing to replace the installed Station ${installedTag} with different bytes published as the same version; to replace it deliberately, set STATION_VERSION=${tag} and STATION_INSTALL_ALLOW_ROLLBACK=1`,
    );
  }
  if (explicit) {
    io.out(
      `Rolling back Station from ${installedTag} to ${tag} (STATION_INSTALL_ALLOW_ROLLBACK=1).`,
    );
    return 'proceed';
  }
  fail(
    `refusing to downgrade Station from ${installedTag} to ${tag}; to roll back deliberately, set STATION_VERSION=${tag} and STATION_INSTALL_ALLOW_ROLLBACK=1`,
  );
}

/**
 * Runs the installer for `argv` (`install` or `uninstall [--purge-data]`)
 * and returns its exit status. Every refusal prints
 * `Station install failed: <reason>` and returns 1.
 */
export async function runInstaller(
  argv: readonly string[],
  env: InstallerEnv,
  io: InstallerIo,
): Promise<number> {
  const provided = env.STATION_INSTALLER_TEMP;
  let tmp: string;
  let ownsTmp = false;
  if (provided) {
    tmp = provided;
  } else {
    tmp = mkdtempSync(join(tmpdir(), 'station-install.'));
    ownsTmp = true;
  }
  try {
    const action = argv[0] ?? 'install';
    if (action === 'uninstall')
      fail(
        'install.ps1 cannot uninstall yet; uninstall arrives with the full Windows install (#2675 slice W2)',
      );
    if (action !== 'install')
      fail('usage: install.ps1 [install|uninstall [-PurgeData]]');
    if (argv.length > 1) fail(`unexpected argument: ${argv[1]}`);
    if (env.STATION_INSTALL_STAGE_ONLY !== '1')
      fail(
        'install.ps1 supports only STATION_INSTALL_STAGE_ONLY=1 so far; the full Windows install arrives with #2675 slice W2',
      );
    return await stageArchive({ env, io, tmp });
  } catch (error) {
    if (error instanceof InstallRefusal) {
      io.err(`Station install failed: ${error.message}`);
      return 1;
    }
    io.err(
      `Station install failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  } finally {
    if (ownsTmp) removeTree(tmp);
  }
}
