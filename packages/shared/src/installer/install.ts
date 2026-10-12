/**
 * The Windows installer core (#2675 slice W). install.ps1 is a thin
 * PowerShell bootstrap: it finds a Node.js (host, the channel's installed
 * runtime, or the pinned official zip) and runs this module, bundled into
 * install.ps1 as a generated block, with the caller's environment. It is the
 * same contract as install.sh, in the same variables and messages, for the
 * prebuilt `station-server-win32-x64.zip` archive.
 *
 * This module holds what every mode shares: the request and path rules, the
 * signed-manifest and archive checks, and staging a verified version into
 * `<install root>/versions/<version>` (download and verify the signed
 * manifest, download the archive within its signed size and check its
 * sha256, refuse any unsafe zip entry, read its marker and provenance,
 * extract, run its own `--version`, write the completion sentinel and seal
 * it read-only). STATION_INSTALL_STAGE_ONLY=1 stops there (slice W1);
 * full-install.ts makes it the active install and uninstalls (slice W2).
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
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { STATION_RELEASE_RINGS_DATA } from '../channel-ports.generated.js';
import { renamePathSyncRetrying } from '../fs-windows-compat.js';
import { findPortableServerTarget } from '../portable-server-targets.mjs';
import type { ReleaseManifestPayload } from '../release-manifest.mjs';
import { STATION_RELEASE_MANIFEST_KEYS as PINNED_MANIFEST_SIGNING_KEYS } from '../release-manifest-keys.generated.js';
import {
  assertWindowsPathsTrusted,
  hardenWindowsPathsTrusted,
  runWindowsTrustCommand,
} from '../windows-path-trust.js';
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
export const INSTALL_ROOT_MARKER = '.station-portable-install-root';
export const INSTALL_ROOT_SIGNATURE = 'station-portable-install-root-v1\n';
export const DATA_ROOT_MARKER = '.station-portable-data-root';
export const DATA_ROOT_SIGNATURE = 'station-portable-data-root-v1\n';
export const STATE_FILE = '.station-release-state.json';
const VERSION_SENTINEL = '.station-install-complete';
const SELF_CHECK_TIMEOUT_MS = 120_000;

type Ring = { runtimeChannel: string; prerelease: boolean; launcher: string };
export const RINGS: Record<string, Ring> = STATION_RELEASE_RINGS_DATA;
const PRERELEASE_RINGS = new Set(
  Object.entries(RINGS)
    .filter(([, ring]) => ring.prerelease)
    .map(([name]) => name),
);

/** A refusal: the installer prints `Station install failed: <message>`. */
export class InstallRefusal extends Error {}

export function fail(message: string): never {
  throw new InstallRefusal(message);
}

export type InstallerIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export type InstallerEnv = Readonly<Record<string, string | undefined>>;

/** The ring an installable runtime channel installs as, or undefined. */
export function ringOfRuntime(channel: string): string | undefined {
  return Object.entries(RINGS).find(
    ([, ring]) => ring.runtimeChannel === channel,
  )?.[0];
}

const foldsCase = process.platform === 'win32' || process.platform === 'darwin';
const fold = (value: string) => (foldsCase ? value.toLowerCase() : value);
export const same = (left: string, right: string) => fold(left) === fold(right);
export const inside = (child: string, parent: string) =>
  same(child, parent) || fold(child).startsWith(`${fold(parent)}${sep}`);

/**
 * `path` absolute, with every existing prefix resolved through its links, as
 * install.sh's canonicalize_path does.
 */
export function canonicalize(path: string): string {
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

export const owner =
  typeof process.getuid === 'function' ? process.getuid() : null;

/** A same-user directory nobody else can write (POSIX modes; ACLs are W2). */
function assertSafeDirectory(path: string): boolean {
  const info = lstatSync(path);
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (owner === null || (info.uid === owner && (info.mode & 0o022) === 0))
  );
}

export function prepareSafeDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!assertSafeDirectory(path))
    fail(`directory must be same-user and not group/world writable: ${path}`);
}

/**
 * install.sh's prepare_owned_root. Creates `root` when missing; an existing
 * root must be a same-user directory that carries `signature` in `marker`,
 * or be empty, when the marker is written (`created`). A non-empty root with
 * no marker is refused (`reject`) or used without claiming it (`preserve`,
 * for the data home). Returns null for a root it refuses.
 */
export function prepareOwnedRoot(
  root: string,
  markerName: string,
  signature: string,
  policy: 'reject' | 'preserve',
): 'managed' | 'created' | 'preserved' | null {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!assertSafeDirectory(root)) return null;
  const marker = join(root, markerName);
  if (existsSync(marker)) {
    const info = lstatSync(marker);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (owner !== null && (info.uid !== owner || (info.mode & 0o077) !== 0)) ||
      readFileSync(marker, 'utf8') !== signature
    )
      return null;
    return 'managed';
  }
  if (readdirSync(root).length > 0)
    return policy === 'preserve' ? 'preserved' : null;
  const fd = openSync(marker, 'wx', 0o600);
  try {
    writeFileSync(fd, signature);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return 'created';
}

/**
 * Why an existing install root is not trusted, or null when it is. On
 * Windows the install root is restricted to the current user (#2675 W2), as
 * `windows-path-trust.ts` restricts Station's own trust paths; anything else
 * may hold a version another account planted (a version's sentinel is only
 * its published sha256). POSIX installs keep install.sh's owner and mode
 * checks, so this is null there. STATION_INSTALL_TEST_UNTRUSTED_ROOT=1
 * (test-only, behind STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1) reports
 * any root as untrusted, so the refusal and uninstall paths run on every OS.
 */
export function installRootTrustProblem(
  root: string,
  env: InstallerEnv,
): string | null {
  if (env.STATION_INSTALL_TEST_UNTRUSTED_ROOT === '1') {
    if (env.STATION_INSTALL_ALLOW_INSECURE_TEST_URLS !== '1')
      fail(
        'STATION_INSTALL_TEST_UNTRUSTED_ROOT is a test-only override and requires STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1',
      );
    return 'test-only override';
  }
  if (process.platform !== 'win32') return null;
  try {
    assertWindowsPathsTrusted(runWindowsTrustCommand, [
      { kind: 'directory', path: root },
    ]);
    return null;
  } catch (error) {
    return plainPowerShellMessage((error as Error).message);
  }
}

/**
 * A root this run created gets a protected DACL with one FullControl entry
 * for the current user, inherited by everything installed in it (Windows
 * only); a root that already existed must still have it, or it is refused
 * with the way out: uninstall, which runs nothing from it.
 */
function secureInstallRoot(
  root: string,
  created: boolean,
  env: InstallerEnv,
): void {
  if (created) {
    if (process.platform !== 'win32') return;
    try {
      hardenWindowsPathsTrusted(runWindowsTrustCommand, [
        { kind: 'directory', path: root },
      ]);
    } catch (error) {
      fail(
        `could not restrict the install root to your account: ${plainPowerShellMessage((error as Error).message)}`,
      );
    }
    return;
  }
  const problem = installRootTrustProblem(root, env);
  if (problem !== null)
    fail(
      `the install root ${root} is not restricted to your account, so nothing in it is trusted (${problem}). Remove it with a freshly downloaded install.ps1 run as \`powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 uninstall\` (it runs nothing from that root and keeps your data), then install again`,
    );
}

/**
 * The install root, owned by this installer, restricted to the current user
 * on Windows.
 */
export function prepareOwnedInstallRoot(root: string, env: InstallerEnv): void {
  const state = prepareOwnedRoot(
    root,
    INSTALL_ROOT_MARKER,
    INSTALL_ROOT_SIGNATURE,
    'reject',
  );
  if (state === null)
    fail(
      `STATION_INSTALL_ROOT is not an empty or installer-owned directory: ${root}`,
    );
  secureInstallRoot(root, state === 'created', env);
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

/**
 * Runs a removal, retrying briefly where Windows refuses to delete a file
 * a process that is just exiting still holds (a stopped Station's node.exe).
 */
function removeWithRetries(remove: () => void): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      remove();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return;
      if (
        attempt >= 10 ||
        !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code)
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

/**
 * Removes a tree an installed version is sealed in, without ever following
 * a link: each entry is lstat'ed, a link (the `current` junction, or one
 * another account placed in a root it could write) is unlinked itself,
 * files are unlinked and directories removed only once empty. Nothing is
 * removed recursively by path, so a directory swapped for a link during the
 * walk is unlinked, not descended into by a later recursive removal. (Node
 * offers no handle-relative removal, so a swap between an lstat and the
 * readdir that follows it remains possible; that window is the walk's
 * only one.)
 */
export function removeTree(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    removeWithRetries(() => unlinkSync(path));
    return;
  }
  if (!info.isDirectory()) {
    // Writable again (an installed version is sealed read-only); chmod
    // follows links, so only after lstat showed a plain file.
    chmodSync(path, info.mode | 0o200);
    removeWithRetries(() => unlinkSync(path));
    return;
  }
  chmodSync(path, info.mode | 0o700);
  for (const name of readdirSync(path)) removeTree(join(path, name));
  removeWithRetries(() => rmdirSync(path));
}

/**
 * Removes an install root with its ownership marker last, so a removal
 * that fails partway (a file a running process still holds) leaves a root
 * this installer still recognizes, and the uninstall can simply be rerun.
 */
export function removeInstallRoot(root: string, env: InstallerEnv): void {
  const failOn = env.STATION_INSTALL_TEST_FAIL_REMOVE ?? '';
  if (failOn && env.STATION_INSTALL_ALLOW_INSECURE_TEST_URLS !== '1')
    fail(
      'STATION_INSTALL_TEST_FAIL_REMOVE is a test-only override and requires STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1',
    );
  try {
    for (const name of readdirSync(root).sort()) {
      if (name === INSTALL_ROOT_MARKER) continue;
      if (name === failOn)
        throw new Error(`test-only failure removing ${join(root, name)}`);
      removeTree(join(root, name));
    }
    removeTree(join(root, INSTALL_ROOT_MARKER));
    removeWithRetries(() => rmdirSync(root));
  } catch (error) {
    fail(
      `could not remove all of ${root} (${(error as Error).message}); it is still marked as this installer's, so rerun the uninstall once nothing uses it`,
    );
  }
}

/**
 * A PowerShell error as one readable line: Windows PowerShell reports a
 * redirected error stream as CLIXML (`#< CLIXML …`), progress records and
 * all; this keeps the text before it and the first error record.
 */
export function plainPowerShellMessage(message: string): string {
  const start = message.indexOf('#< CLIXML');
  if (start < 0) return message;
  const first = /<S S="Error">([^<]*)<\/S>/.exec(message.slice(start))?.[1];
  const error = (first ?? '')
    .replace(/_x000D__x000A_/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
  return `${message.slice(0, start)}${error}`.trim();
}

/**
 * Seals an installed version read-only: an installed archive version is
 * immutable, and lifecycle state lives outside it (#2675 B1). On Windows
 * this sets each file's ReadOnly attribute; directories are left alone there.
 */
export function sealTree(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) sealTree(join(path, name));
    if (process.platform !== 'win32') chmodSync(path, info.mode & ~0o222);
    return;
  }
  chmodSync(path, info.mode & ~0o222);
}

export type Paths = {
  channel: string;
  ring: string;
  stationRoot: string;
  installRoot: string;
  versions: string;
  current: string;
  stationHome: string;
  /** Whether the caller named STATION_HOME (the default home is guarded). */
  homeRequested: boolean;
  binDir: string;
  launcher: string;
  stateFile: string;
};

/**
 * Why `installRoot` may not be used on Windows, or null. The installer
 * trusts only directories beneath the user's profile, which Windows gives
 * the user, SYSTEM and Administrators alone: a root elsewhere (C:\station,
 * say) typically inherits write access for every local user, who could plant
 * a version there between its creation and the installer restricting it to
 * the user. Both paths are canonical (links resolved).
 */
export function windowsInstallRootRefusal(
  installRoot: string,
  profile: string,
): string | null {
  if (inside(installRoot, profile) && !same(installRoot, profile)) return null;
  return `on Windows, install.ps1 installs only beneath your user profile (${profile}); ${installRoot} is outside it`;
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
    'STATION_BIN_DIR',
  ] as const) {
    const value = (env[name] ?? '').trim();
    if (value !== '' && !isAbsoluteRoot(value))
      fail(`${name} must be an absolute path: ${env[name]}`);
  }
}

const UNSAFE_RUNTIME_PATHS =
  'Station runtime paths are invalid, protected, or contain an unsafe selected link';

function isLinkOrThrow(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * install.sh's normalize_runtime_paths: the Station root's shared
 * directories are real directories, the selected home and install root are
 * not links, the home is not a protected or shared Station directory, and
 * neither the home nor the install root contains the Station root.
 */
function assertRuntimePaths(
  paths: Pick<Paths, 'stationRoot' | 'installRoot' | 'stationHome'>,
  rawHome: string,
  rawInstallRoot: string,
): void {
  const { stationRoot: root, installRoot, stationHome: home } = paths;
  for (const directory of [
    root,
    ...['config', 'cache', 'installs', 'instances'].map((name) =>
      join(root, name),
    ),
    join(root, 'instances', 'dev'),
  ]) {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      fail(UNSAFE_RUNTIME_PATHS);
  }
  if (isLinkOrThrow(rawHome) || isLinkOrThrow(rawInstallRoot))
    fail(UNSAFE_RUNTIME_PATHS);
  if (
    same(home, root) ||
    ['config', 'cache', 'installs'].some((name) =>
      inside(home, join(root, name)),
    ) ||
    same(home, join(root, 'instances')) ||
    same(home, join(root, 'instances', 'dev')) ||
    inside(root, home) ||
    inside(root, installRoot)
  )
    fail(UNSAFE_RUNTIME_PATHS);
  if (inside(home, installRoot) || inside(installRoot, home))
    fail(
      'STATION_HOME and STATION_INSTALL_ROOT must not overlap so uninstall can preserve data',
    );
}

/** install.sh's assert_safe_remove_target, for a root this installer may remove. */
export function assertSafeRemoveTarget(target: string): void {
  if (isLinkOrThrow(target))
    fail(`refusing to remove a symlinked root: ${target}`);
  if (existsSync(target) && owner !== null && lstatSync(target).uid !== owner)
    fail(`refusing to remove a root owned by another user: ${target}`);
  const canonical = canonicalize(target);
  if (inside(canonicalize(homedir()), canonical))
    fail(`refusing to remove HOME or its ancestor: ${target}`);
  if (same(canonical, parse(canonical).root))
    fail(`refusing to remove ${target}`);
}

export function resolvePaths(
  env: InstallerEnv,
  channel: string,
  ring: string,
): Paths {
  assertAbsoluteRoots(env);
  const stationRoot = canonicalize(
    (env.STATION_ROOT ?? '').trim() || join(homedir(), '.station'),
  );
  const rawInstallRoot =
    env.STATION_INSTALL_ROOT || join(stationRoot, 'installs', channel);
  const rawHome = env.STATION_HOME || join(stationRoot, 'instances', channel);
  const installRoot = canonicalize(rawInstallRoot);
  const stationHome = canonicalize(rawHome);
  const binDir = canonicalize(
    env.STATION_BIN_DIR || join(homedir(), '.local', 'bin'),
  );
  assertRuntimePaths(
    { stationRoot, installRoot, stationHome },
    rawHome,
    rawInstallRoot,
  );
  assertSafeRemoveTarget(installRoot);
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
    stationHome,
    homeRequested: Boolean(env.STATION_HOME),
    binDir,
    launcher: join(binDir, `${RINGS[ring].launcher}.cmd`),
    stateFile: join(installRoot, STATE_FILE),
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

export function versionPaths(dir: string) {
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
export function activeVersionDir(current: string): string | null {
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

export type Context = {
  env: InstallerEnv;
  io: InstallerIo;
  tmp: string;
};

export type StageRequest = {
  requested: string;
  ring: string;
  manifestUrl: string;
  allowTest: boolean;
  testKeyUrl: string;
  testTarget: string;
  version: string;
};

/** The requested runtime channel and the ring it installs, validated. */
export function readChannel(env: InstallerEnv): {
  requested: string;
  ring: string;
} {
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
  return { requested, ring };
}

/** The caller's environment, validated as install.sh validates it. */
export function readStageRequest(
  env: InstallerEnv,
  mode: 'stage' | 'install',
): StageRequest {
  const { requested, ring } = readChannel(env);
  const manifestUrl = env.STATION_INSTALL_PUBLIC_MANIFEST_URL ?? '';
  if (!manifestUrl)
    fail(
      mode === 'stage'
        ? 'STATION_INSTALL_STAGE_ONLY=1 stages only from a signed public manifest (STATION_INSTALL_PUBLIC_MANIFEST_URL)'
        : 'install.ps1 installs only from a signed public manifest; set STATION_INSTALL_PUBLIC_MANIFEST_URL to the release channel manifest',
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

/** A verified release, ready for the caller (see prepareRelease). */
export type PreparedRelease = {
  payload: ReleaseManifestPayload;
  releaseDir: string;
  actualChecksum: string;
  /** The version directory `current` named before this run, or null. */
  previous: string | null;
  /**
   * `nothing-to-do`: the active version already is this release.
   * `ready`: `releaseDir` holds the complete, sealed release.
   * `replacement`: the active version is being replaced, as explicitly
   * requested, by different bytes of the same version; they are complete in
   * `incoming` and take `releaseDir`'s name only once Station has stopped.
   */
  outcome: 'nothing-to-do' | 'ready' | 'replacement';
  incoming?: string;
};

/**
 * The first half of every install, and all of stage-only: verify the signed
 * manifest, download and check the archive, read its identity, run the
 * downgrade check against `current`, then (after `prepare`, which claims the
 * roots it needs) reuse or extract `versions/<version>`. Nothing on disk
 * changes before `prepare`.
 */
export async function prepareRelease(
  context: Context,
  request: StageRequest,
  paths: Paths,
  mode: 'stage' | 'install',
  prepare: () => void,
): Promise<PreparedRelease> {
  const { env, io, tmp } = context;
  const { payload, artifact } = await fetchVerifiedRelease(request, io, tmp);
  const { archive, actualChecksum } = await downloadVerifiedArchive(
    artifact,
    request.allowTest,
    io,
    tmp,
  );

  const releaseDir = join(paths.versions, payload.version);
  return withZipOrRefuse(archive, (fd, entries): PreparedRelease => {
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
    if (provenance.runtimeChannel !== request.requested)
      fail('verified release does not match the requested runtime channel');

    const previous = activeVersionDir(paths.current);
    const isActive =
      previous !== null && same(previous, canonicalize(releaseDir));
    const result = { payload, releaseDir, actualChecksum, previous };
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
      if (outcome === 'nothing-to-do')
        return { ...result, outcome: 'nothing-to-do' };
    }
    prepare();

    if (isCompleteVersion(releaseDir, actualChecksum)) {
      io.out('Station release already installed; reusing verified files.');
      return { ...result, outcome: 'ready' };
    }
    let replacement = false;
    if (existsSync(releaseDir) || isLink(releaseDir)) {
      if (isActive) {
        if (!existsSync(join(releaseDir, VERSION_SENTINEL)))
          fail(
            'the active release cache is incomplete; refusing to replace running files',
          );
        // The running version stays where it is: the service launcher moves
        // off it only after a trial of a staged one.
        if (mode === 'stage')
          fail(
            `cannot replace the running Station ${payload.releaseTag} in place under the service launcher; nothing was changed`,
          );
        // An explicit replacement: it moves aside only once Station stops.
        replacement = true;
      } else {
        removeTree(releaseDir);
      }
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
    renamePathSyncRetrying(join(stage, ARCHIVE_ROOT), incoming);
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
    if (replacement) return { ...result, outcome: 'replacement', incoming };
    try {
      renamePathSyncRetrying(incoming, releaseDir);
      sealTree(releaseDir);
    } catch (error) {
      io.err(`${(error as Error).message}`);
      removeTree(incoming);
      removeTree(releaseDir);
      fail('could not place the verified release');
    }
    return { ...result, outcome: 'ready' };
  });
}

/**
 * Stage-only (STATION_INSTALL_STAGE_ONLY=1, #2675 slice W1): stage the
 * verified version and change nothing else, not `current`, not a launcher,
 * not the install state, not a service. The last line names the version now
 * staged, which is the active one when the manifest names nothing newer.
 */
export async function stageArchive(context: Context): Promise<number> {
  const request = readStageRequest(context.env, 'stage');
  const paths = resolvePaths(context.env, request.requested, request.ring);
  const release = await prepareRelease(context, request, paths, 'stage', () => {
    prepareOwnedInstallRoot(paths.installRoot, context.env);
    prepareSafeDirectory(paths.versions);
  });
  context.io.out(`STATION_STAGED_VERSION=${release.payload.version}`);
  return 0;
}

export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function withZipOrRefuse<T>(
  archive: string,
  use: (fd: number, entries: ZipEntry[]) => T,
): T {
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
