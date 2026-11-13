/**
 * Managed engine installs: an engine runtime Station downloads from a pinned
 * manifest, with a person's explicit consent, and runs from a built-in
 * descriptor's `managedRuntime` (`@kontourai/station-contracts/managed-engine-install`).
 *
 * Verification order, each step before the next is attempted:
 *
 * 1. The manifest's raw bytes must hash to the pin's `manifestSha256` (the
 *    trust root) before the manifest is parsed or any artifact is fetched.
 * 2. Each artifact must have exactly the manifest's size and sha256
 *    (`infra/pinned-artifact.ts`, shared with the Browser pane's Chromium).
 * 3. Every entry name is vetted before extraction: no absolute path, no `..`
 *    segment, no device or fifo, no link whose target leaves the root, and
 *    no entry or link target that passes through another link entry.
 * 4. The extracted tree is walked again, symlinks resolved, after extraction.
 *
 * A runtime build named `electron-builtin` is refused: Station never runs an
 * engine on its own Electron.
 *
 * Layout: `<STATION_HOME>/engines/<installId>/<version>/` holding
 * `install.json`, `engine/` and `runtime/`. It is staged beside the final
 * name, published with one rename, and made read-only. Nothing auto-updates:
 * a new version is a new pin in a reviewed change.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, win32 } from 'node:path';
import type {
  EngineInstallManifest,
  ManagedInstallArtifact,
  ManagedInstallEntry,
  ManagedInstallFailure,
  ManagedInstallPin,
  ManagedInstallPlatform,
  ManagedInstallState,
  ManagedRuntimeBuild,
} from '@kontourai/station-contracts/managed-engine-install';
import { validateManagedInstallPin } from '@kontourai/station-contracts/managed-engine-install';
import { errorMessage } from '../../utils/error-message.js';
import {
  downloadPinnedArtifact,
  findEscapingEntry,
  PinnedArtifactError,
  runArchiveTool,
  SHA256_HEX,
  unsafeArchiveEntry,
} from '../infra/pinned-artifact.js';

/** One reviewed install Station knows how to perform. */
export interface ManagedInstallDefinition {
  readonly pin: ManagedInstallPin;
  /** Shown in messages ("Kiro (KAS, no CLI)"). */
  readonly displayName: string;
  /**
   * Read the manifest document whose bytes matched the pin into the contract
   * shape, with every artifact URL absolute. Throw {@link ManagedInstallError}
   * for anything it cannot accept.
   */
  parseManifest(document: unknown, manifestUrl: string): EngineInstallManifest;
}

export class ManagedInstallError extends Error {
  constructor(
    readonly reason: ManagedInstallFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedInstallError';
  }
}

export class ManagedInstallConsentRequiredError extends Error {
  constructor() {
    super('Installing an engine requires explicit consent.');
    this.name = 'ManagedInstallConsentRequiredError';
  }
}

/** One archive entry as listed before extraction. */
export interface ArchiveEntryListing {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';
  /** For links: what the entry points at. */
  linkTarget?: string;
}

export interface ManagedInstallDeps {
  platform: NodeJS.Platform;
  arch: string;
  fetch: typeof fetch;
  listEntries(archive: string): Promise<ArchiveEntryListing[]>;
  extract(archive: string, destDir: string): Promise<void>;
  now(): Date;
}

const INSTALL_RECORD = 'install.json';
const MANIFEST_MAX_BYTES = 256 * 1024;
const ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;

export function managedEnginesRoot(stationHome: string): string {
  return join(stationHome, 'engines');
}

export function managedInstallDir(
  stationHome: string,
  pin: Pick<ManagedInstallPin, 'installId' | 'version'>,
): string {
  return join(managedEnginesRoot(stationHome), pin.installId, pin.version);
}

function tarCommand(platform: NodeJS.Platform): string {
  if (platform === 'win32')
    return win32.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'tar.exe',
    );
  return platform === 'darwin' ? '/usr/bin/tar' : 'tar';
}

/**
 * `tar -tf` gives the names and `tar -tvf` the types and link targets, line
 * for line in the same archive order. Both bsdtar (macOS, Windows) and GNU
 * tar print a symlink as `<name> -> <target>` and a hard link as
 * `<name> link to <target>`. The name is taken from `-tf`, so a name that
 * itself contains ` -> ` cannot shift the target.
 */
export function parseTarListing(
  names: readonly string[],
  verbose: readonly string[],
): ArchiveEntryListing[] {
  if (names.length !== verbose.length)
    throw new Error('the archive listing is inconsistent');
  return names.map((name, index) => {
    const line = verbose[index] as string;
    const type = line[0];
    if (type === '-') return { name, kind: 'file' };
    if (type === 'd') return { name, kind: 'directory' };
    if (type === 'l' || type === 'h') {
      const marker = type === 'l' ? `${name} -> ` : `${name} link to `;
      const at = line.indexOf(marker);
      if (at < 0) throw new Error('the archive listing is inconsistent');
      return {
        name,
        kind: type === 'l' ? 'symlink' : 'hardlink',
        linkTarget: line.slice(at + marker.length),
      };
    }
    return { name, kind: 'other' };
  });
}

function defaultListEntries(
  platform: NodeJS.Platform,
): (archive: string) => Promise<ArchiveEntryListing[]> {
  const tar = tarCommand(platform);
  const lines = async (args: string[]) => {
    const chunks: Buffer[] = [];
    await runArchiveTool(tar, args, 2 * 60 * 1000, (chunk) =>
      chunks.push(chunk),
    );
    return Buffer.concat(chunks)
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '');
  };
  return async (archive) =>
    parseTarListing(
      await lines(['-tf', archive]),
      await lines(['-tvf', archive]),
    );
}

export function defaultManagedInstallDeps(): ManagedInstallDeps {
  const tar = tarCommand(process.platform);
  return {
    platform: process.platform,
    arch: process.arch,
    fetch: globalThis.fetch.bind(globalThis),
    listEntries: defaultListEntries(process.platform),
    extract: (archive, dest) =>
      runArchiveTool(tar, ['-xf', archive, '-C', dest], ARCHIVE_TIMEOUT_MS),
    now: () => new Date(),
  };
}

/** An entry name as POSIX segments, without `.` or empty segments. */
function entrySegments(name: string): string[] {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

/**
 * Why an entry may not be extracted, or undefined. A link may point only
 * inside the archive root, judged from the link's own directory.
 *
 * This judges one entry alone; {@link vetArchiveEntries} adds the checks
 * that need the whole listing (a path through another link).
 */
export function vetArchiveEntry(
  entry: ArchiveEntryListing,
): string | undefined {
  if (unsafeArchiveEntry(entry.name)) return `unsafe name ${entry.name}`;
  if (entry.kind === 'other')
    return `${entry.name} is not a file, directory or link`;
  if (entry.kind === 'symlink' || entry.kind === 'hardlink') {
    const target = entry.linkTarget ?? '';
    if (target === '' || target.includes('\0'))
      return `${entry.name} links to nothing`;
    const normalized = target.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized))
      return `${entry.name} links outside the archive`;
    // A hard link names another member from the root, which never needs `..`.
    if (entry.kind === 'hardlink' && unsafeArchiveEntry(normalized))
      return `${entry.name} links outside the archive`;
    // A symlink is relative to its own directory.
    const resolved =
      entry.kind === 'hardlink'
        ? posix.normalize(normalized)
        : posix.normalize(
            posix.join(
              posix.dirname(entry.name.replace(/\\/g, '/')),
              normalized,
            ),
          );
    if (resolved === '..' || resolved.startsWith('../'))
      return `${entry.name} links outside the archive`;
  }
  return undefined;
}

/**
 * Vet a whole listing. Besides each entry on its own:
 *
 * - no entry's path may pass through a link entry (`d/s -> ..` then
 *   `d/s/t -> ..` then `d/s/t/payload`: each link looks contained judged
 *   lexically, but extraction writes through them and climbs one level per
 *   link);
 * - no symlink's target may walk through a link entry before its last
 *   segment, for the same reason on the read side.
 *
 * A symlink target may still contain `..`: the pinned Node runtime's own
 * `bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js` does, and that is
 * contained once no path segment can be a link.
 */
export function vetArchiveEntries(
  entries: readonly ArchiveEntryListing[],
): string | undefined {
  // Case-folded: on a case-insensitive file system (macOS, Windows) `d/S`
  // and `d/s` are the same directory.
  const key = (segments: readonly string[]) => segments.join('/').toLowerCase();
  const links = new Set<string>();
  const symlinks = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'symlink' || entry.kind === 'hardlink')
      links.add(key(entrySegments(entry.name)));
    if (entry.kind === 'symlink') symlinks.add(key(entrySegments(entry.name)));
  }
  const throughLink = (segments: readonly string[]) => {
    for (let i = 1; i < segments.length; i++) {
      if (links.has(key(segments.slice(0, i)))) return true;
    }
    return false;
  };
  for (const entry of entries) {
    const problem = vetArchiveEntry(entry);
    if (problem) return problem;
    const segments = entrySegments(entry.name);
    if (throughLink(segments)) return `${entry.name} is reached through a link`;
    // A hard link to a symlink copies its relative target into a new
    // directory, where it can point out of the install.
    if (
      entry.kind === 'hardlink' &&
      symlinks.has(key(entrySegments(entry.linkTarget ?? '')))
    )
      return `${entry.name} hard-links a symbolic link`;
    if (entry.kind === 'symlink') {
      const walked = segments.slice(0, -1);
      const target = entrySegments(entry.linkTarget ?? '');
      for (const [index, segment] of target.entries()) {
        if (segment === '..') walked.pop();
        else walked.push(segment);
        if (index < target.length - 1 && links.has(key(walked)))
          return `${entry.name} links through another link`;
      }
    }
  }
  return undefined;
}

/** `<process.platform>-<arch>` as a pin names it. */
export function hostInstallPlatform(
  platform: NodeJS.Platform,
  arch: string,
): ManagedInstallPlatform | undefined {
  const key = `${platform}-${arch}`;
  return (
    [
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'linux-arm64',
      'win32-x64',
    ] as const
  ).find((candidate) => candidate === key);
}

function engineArtifactFor(
  manifest: EngineInstallManifest,
  host: ManagedInstallPlatform,
): ManagedInstallArtifact | undefined {
  return (
    manifest.artifacts[host] ??
    (host.startsWith('darwin-')
      ? manifest.artifacts['darwin-universal']
      : undefined)
  );
}

function runtimeBuildFor(
  manifest: EngineInstallManifest,
  host: ManagedInstallPlatform,
): ManagedRuntimeBuild | undefined {
  return manifest.runtimeBuilds?.find((build) => build.platform === host);
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every path below `root`, deepest first, without following links. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
      out.push(path);
    }
  };
  visit(root);
  return out;
}

/** Drop write permission from every file and directory (links are skipped). */
function makeReadOnly(root: string): void {
  for (const path of [...walk(root), root]) {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) continue;
    chmodSync(path, status.mode & ~0o222 & 0o7777);
  }
}

/** Give back owner write so a read-only tree can be removed. */
function makeOwnerWritable(root: string): void {
  if (!existsSync(root)) return;
  const status = lstatSync(root);
  if (status.isSymbolicLink()) return;
  chmodSync(root, (status.mode | 0o200) & 0o7777);
  if (!status.isDirectory()) return;
  for (const path of walk(root)) {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) continue;
    chmodSync(path, (entry.mode | 0o200) & 0o7777);
  }
}

function removeTree(root: string): void {
  try {
    makeOwnerWritable(root);
  } catch {}
  rmSync(root, { recursive: true, force: true });
}

/**
 * The one executable named `name` (or `name.exe` on Windows) in a `bin/`
 * directory (anywhere on Windows) at most three levels down: a runtime build
 * unpacks to `<dist>/bin/node`.
 */
function locateRuntime(
  root: string,
  name: string,
  platform: NodeJS.Platform,
): string {
  const want = platform === 'win32' ? `${name}.exe` : name;
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) visit(path, depth + 1);
      else if (
        entry.isFile() &&
        entry.name === want &&
        (platform === 'win32' || dir.endsWith('/bin'))
      )
        found.push(path);
    }
  };
  visit(root, 0);
  if (found.length !== 1)
    throw new ManagedInstallError(
      'tree-verification-failed',
      `Expected exactly one ${want} in the runtime archive, found ${found.length}.`,
    );
  const runtime = found[0] as string;
  if (platform !== 'win32') {
    const mode = statSync(runtime).mode;
    if (!(mode & 0o100)) chmodSync(runtime, mode | 0o111);
  }
  return runtime;
}

interface InstallRecord {
  installId: string;
  version: string;
  platform: string;
  engineSha256: string;
  runtimeSha256?: string;
  /** Relative to the install directory, POSIX separators. */
  runtime: string;
  script: string;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Installs and reports one or more reviewed pins. Reads never touch the
 * network; only {@link start} with `consent: true` does.
 */
export class ManagedInstaller {
  readonly #definitions = new Map<string, ManagedInstallDefinition>();
  readonly #running = new Map<
    string,
    {
      startedAt: string;
      receivedBytes: number;
      totalBytes?: number;
      done: Promise<void>;
    }
  >();
  readonly #failures = new Map<
    string,
    Extract<ManagedInstallState, { kind: 'failed' }>
  >();

  constructor(
    private readonly stationHome: string,
    definitions: readonly ManagedInstallDefinition[],
    private readonly deps: ManagedInstallDeps = defaultManagedInstallDeps(),
  ) {
    for (const definition of definitions) {
      const problems = validateManagedInstallPin(definition.pin);
      if (problems.length > 0)
        throw new Error(
          `Managed install pin ${definition.pin.installId} is not usable: ${problems.join('; ')}`,
        );
      this.#definitions.set(definition.pin.installId, definition);
    }
  }

  definition(installId: string): ManagedInstallDefinition | undefined {
    return this.#definitions.get(installId);
  }

  installDir(installId: string): string | undefined {
    const definition = this.#definitions.get(installId);
    return definition
      ? managedInstallDir(this.stationHome, definition.pin)
      : undefined;
  }

  /** Read-only. Never touches the network. */
  state(installId: string): ManagedInstallState {
    const definition = this.#definitions.get(installId);
    if (!definition) return { kind: 'not-installed' };
    const installed = this.installed(installId);
    if (installed)
      return {
        kind: 'installed',
        version: definition.pin.version,
        entry: installed,
      };
    const running = this.#running.get(installId);
    if (running)
      return {
        kind: 'installing',
        startedAt: running.startedAt,
        receivedBytes: running.receivedBytes,
        ...(running.totalBytes !== undefined
          ? { totalBytes: running.totalBytes }
          : {}),
      };
    const host = hostInstallPlatform(this.deps.platform, this.deps.arch);
    if (!host || !this.#pinCovers(definition.pin, host))
      return {
        kind: 'unsupported-platform',
        platform: `${this.deps.platform}-${this.deps.arch}`,
      };
    return this.#failures.get(installId) ?? { kind: 'not-installed' };
  }

  /** The installed entry for the pinned version, or undefined. */
  installed(installId: string): ManagedInstallEntry | undefined {
    const definition = this.#definitions.get(installId);
    if (!definition) return undefined;
    const dir = managedInstallDir(this.stationHome, definition.pin);
    let record: InstallRecord;
    try {
      record = JSON.parse(
        readFileSync(join(dir, INSTALL_RECORD), 'utf8'),
      ) as InstallRecord;
    } catch {
      return undefined;
    }
    if (
      record.installId !== definition.pin.installId ||
      record.version !== definition.pin.version ||
      typeof record.runtime !== 'string' ||
      typeof record.script !== 'string'
    )
      return undefined;
    const runtime = join(dir, ...record.runtime.split('/'));
    const script = join(dir, ...record.script.split('/'));
    if (!within(dir, runtime) || !within(dir, script)) return undefined;
    if (!isExecutableFile(runtime, this.deps.platform)) return undefined;
    try {
      if (!statSync(script).isFile()) return undefined;
    } catch {
      return undefined;
    }
    return { runtime, script };
  }

  /**
   * Start the pinned install. `consent` must be the literal `true` a person
   * gave; anything else throws before any I/O. Returns the state right
   * after starting, and a promise that settles when the install ends.
   */
  start(
    installId: string,
    request: { consent: true },
  ): { state: ManagedInstallState; completion: Promise<void> } {
    if (request?.consent !== true)
      throw new ManagedInstallConsentRequiredError();
    const definition = this.#definitions.get(installId);
    if (!definition) throw new Error(`Unknown managed install ${installId}`);
    const current = this.state(installId);
    if (current.kind !== 'not-installed' && current.kind !== 'failed')
      return {
        state: current,
        completion: this.#running.get(installId)?.done ?? Promise.resolve(),
      };
    this.#failures.delete(installId);
    const progress: {
      startedAt: string;
      receivedBytes: number;
      totalBytes?: number;
      done: Promise<void>;
    } = {
      startedAt: this.deps.now().toISOString(),
      receivedBytes: 0,
      done: Promise.resolve(),
    };
    this.#running.set(installId, progress);
    progress.done = this.#install(definition, progress)
      .catch((error: unknown) => {
        this.#failures.set(
          installId,
          error instanceof ManagedInstallError
            ? { kind: 'failed', reason: error.reason, detail: error.message }
            : {
                kind: 'failed',
                reason: 'download-failed',
                detail: errorMessage(error),
              },
        );
      })
      .finally(() => {
        if (this.#running.get(installId) === progress)
          this.#running.delete(installId);
      });
    return { state: this.state(installId), completion: progress.done };
  }

  #pinCovers(pin: ManagedInstallPin, host: ManagedInstallPlatform): boolean {
    return (
      pin.platforms.includes(host) ||
      (host.startsWith('darwin-') && pin.platforms.includes('darwin-universal'))
    );
  }

  async #fetchManifest(
    definition: ManagedInstallDefinition,
  ): Promise<EngineInstallManifest> {
    const { pin } = definition;
    let response: Response;
    try {
      response = await this.deps.fetch(pin.manifestUrl, { redirect: 'error' });
    } catch (error) {
      throw new ManagedInstallError(
        'download-failed',
        `Could not reach ${new URL(pin.manifestUrl).host}: ${(error as Error).message}`,
      );
    }
    if (!response.ok)
      throw new ManagedInstallError(
        'download-failed',
        `The manifest host answered HTTP ${response.status}.`,
      );
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MANIFEST_MAX_BYTES)
      throw new ManagedInstallError(
        'manifest-digest-mismatch',
        'The manifest is too large to be the pinned one.',
      );
    const digest = createHash('sha256').update(body).digest('hex');
    // The trust root: nothing below runs on bytes that do not match the pin.
    if (digest !== pin.manifestSha256)
      throw new ManagedInstallError(
        'manifest-digest-mismatch',
        `The manifest does not match the pinned sha256 (got ${digest}); refusing to install.`,
      );
    let document: unknown;
    try {
      document = JSON.parse(body.toString('utf8'));
    } catch {
      throw new ManagedInstallError(
        'manifest-digest-mismatch',
        'The pinned manifest is not JSON.',
      );
    }
    const manifest = definition.parseManifest(document, pin.manifestUrl);
    if (
      manifest.installId !== pin.installId ||
      manifest.version !== pin.version
    )
      throw new ManagedInstallError(
        'manifest-digest-mismatch',
        `The manifest describes ${manifest.installId} ${manifest.version}, not the pinned ${pin.installId} ${pin.version}.`,
      );
    return manifest;
  }

  async #fetchArtifact(
    artifact: ManagedInstallArtifact,
    dest: string,
    sourceName: string,
    progress: { receivedBytes: number },
  ): Promise<void> {
    if (!SHA256_HEX.test(artifact.sha256))
      throw new ManagedInstallError(
        'artifact-digest-mismatch',
        'The manifest pins an artifact without a sha256.',
      );
    let url: URL;
    try {
      url = new URL(artifact.url);
    } catch {
      throw new ManagedInstallError(
        'download-failed',
        'The manifest names an invalid artifact URL.',
      );
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new ManagedInstallError(
        'download-failed',
        'The manifest names an artifact that is not https.',
      );
    const before = progress.receivedBytes;
    try {
      await downloadPinnedArtifact({
        fetch: this.deps.fetch,
        url: artifact.url,
        dest,
        bytes: artifact.size,
        sha256: artifact.sha256,
        sourceName,
        onProgress: (received) => {
          progress.receivedBytes = before + received;
        },
      });
    } catch (error) {
      if (error instanceof PinnedArtifactError)
        throw new ManagedInstallError(
          error.reason === 'size-mismatch'
            ? 'artifact-size-mismatch'
            : error.reason === 'integrity-mismatch'
              ? 'artifact-digest-mismatch'
              : 'download-failed',
          error.message,
        );
      throw error;
    }
  }

  async #extractVetted(archive: string, into: string): Promise<void> {
    let entries: ArchiveEntryListing[];
    try {
      entries = await this.deps.listEntries(archive);
    } catch (error) {
      throw new ManagedInstallError(
        'unsafe-entry-name',
        `Could not list the archive: ${(error as Error).message}`,
      );
    }
    if (entries.length === 0)
      throw new ManagedInstallError(
        'unsafe-entry-name',
        'The archive is empty.',
      );
    const problem = vetArchiveEntries(entries);
    if (problem)
      throw new ManagedInstallError(
        'unsafe-entry-name',
        `The archive has an entry Station will not extract: ${problem}.`,
      );
    mkdirSync(into, { recursive: true });
    try {
      await this.deps.extract(archive, into);
    } catch (error) {
      throw new ManagedInstallError(
        'tree-verification-failed',
        `Could not extract the archive: ${(error as Error).message}`,
      );
    }
    const escaping = findEscapingEntry(into);
    if (escaping !== undefined)
      throw new ManagedInstallError(
        'tree-verification-failed',
        `An extracted entry resolves outside the install directory: ${escaping}`,
      );
  }

  async #install(
    definition: ManagedInstallDefinition,
    progress: { receivedBytes: number; totalBytes?: number },
  ): Promise<void> {
    const { pin } = definition;
    const host = hostInstallPlatform(this.deps.platform, this.deps.arch);
    if (!host || !this.#pinCovers(pin, host))
      throw new ManagedInstallError(
        'download-failed',
        `${definition.displayName} has no build for ${this.deps.platform}-${this.deps.arch}.`,
      );
    const manifest = await this.#fetchManifest(definition);
    if (manifest.runtimeBuilds?.some((b) => b.runtime === 'electron-builtin'))
      throw new ManagedInstallError(
        'runtime-refused',
        `${definition.displayName} ${manifest.version} expects to run inside Electron; Station runs engines only on a runtime the manifest pins.`,
      );
    const engine = engineArtifactFor(manifest, host);
    if (!engine)
      throw new ManagedInstallError(
        'download-failed',
        `${definition.displayName} ${manifest.version} publishes no build for ${host}.`,
      );
    const runtime = runtimeBuildFor(manifest, host);
    if (manifest.runtimeBuilds && !runtime)
      throw new ManagedInstallError(
        'download-failed',
        `${definition.displayName} ${manifest.version} publishes no runtime for ${host}.`,
      );
    progress.totalBytes = engine.size + (runtime?.size ?? 0);

    const final = managedInstallDir(this.stationHome, pin);
    const parent = dirname(final);
    mkdirSync(parent, { recursive: true });
    const staging = join(
      parent,
      `.staging-${pin.version}-${randomBytes(6).toString('hex')}`,
    );
    mkdirSync(staging, { recursive: true });
    try {
      const downloads = join(staging, 'downloads');
      mkdirSync(downloads);
      const engineArchive = join(downloads, 'engine-archive');
      await this.#fetchArtifact(
        engine,
        engineArchive,
        definition.displayName,
        progress,
      );
      let runtimeArchive: string | undefined;
      if (runtime) {
        runtimeArchive = join(downloads, 'runtime-archive');
        await this.#fetchArtifact(
          runtime,
          runtimeArchive,
          `${definition.displayName} runtime`,
          progress,
        );
      }
      const engineDir = join(staging, 'engine');
      await this.#extractVetted(engineArchive, engineDir);
      const runtimeDir = join(staging, 'runtime');
      if (runtimeArchive) await this.#extractVetted(runtimeArchive, runtimeDir);
      rmSync(downloads, { recursive: true, force: true });

      const script = join(engineDir, ...manifest.entry.split('/'));
      if (
        unsafeArchiveEntry(manifest.entry) ||
        !within(engineDir, script) ||
        !existsSync(script) ||
        !statSync(script).isFile()
      )
        throw new ManagedInstallError(
          'tree-verification-failed',
          `The engine archive has no ${manifest.entry}.`,
        );
      const runtimePath = runtime
        ? locateRuntime(runtimeDir, runtime.runtime, this.deps.platform)
        : undefined;
      if (!runtimePath)
        throw new ManagedInstallError(
          'tree-verification-failed',
          'The manifest pins no runtime to run the engine with.',
        );
      const record: InstallRecord = {
        installId: pin.installId,
        version: pin.version,
        platform: host,
        engineSha256: engine.sha256,
        ...(runtime ? { runtimeSha256: runtime.sha256 } : {}),
        runtime: relative(staging, runtimePath).split(/[\\/]/).join('/'),
        script: relative(staging, script).split(/[\\/]/).join('/'),
      };
      writeFileSync(
        join(staging, INSTALL_RECORD),
        `${JSON.stringify(record, null, 2)}\n`,
      );
      makeReadOnly(staging);
      // Only now does an existing directory at this version go: a failure
      // above leaves it untouched.
      if (existsSync(final)) removeTree(final);
      renameSync(staging, final);
    } finally {
      if (existsSync(staging)) removeTree(staging);
    }
  }
}

// --- The instance's installer ------------------------------------------------

let registered: ManagedInstaller | null = null;

/** Bootstrap installs the instance's installer; tests install their own. */
export function registerManagedInstaller(installer: ManagedInstaller | null) {
  registered = installer;
}

export function managedInstaller(): ManagedInstaller | null {
  return registered;
}
