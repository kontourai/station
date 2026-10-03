/**
 * JSON Manifest Registry Provider
 * Implements registry lookups for plugins and integrations from a remote or local JSON manifest.
 * by fetching a remote JSON manifest.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { PluginRegistryCatalogSnapshot } from '@kontourai/station-contracts/catalog';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { createStationTempDirSync } from '@kontourai/station-shared/temp-dir';
import { scanInstalledPluginInventory } from '../../services/plugins/installed-plugin-inventory.js';
import {
  copyPluginTree,
  PLUGIN_TREE_COPY,
} from '../../services/plugins/plugin-content-integrity.js';
import {
  readPluginManifestBytesBounded,
  readUntrustedPluginManifestSyncWithFormat,
} from '../../services/plugins/plugin-manifest-bounded-read.js';
import { assertPluginIdentityAvailable } from '../../services/plugins/reserved-plugin-identities.js';
import { errorMessage } from '../../utils/error-message.js';
import { execGitSync } from '../../utils/git-exec.js';
import {
  endsAsGitName,
  isGitMetadataName,
} from '../../utils/git-metadata-name.js';
import type { Logger } from '../../utils/logger.js';
import type { InstallResult, RegistryItem } from '../provider-contracts.js';
import type {
  IAgentRegistryProvider,
  IIntegrationRegistryProvider,
  IPluginRegistryProvider,
} from '../provider-interfaces.js';
import { readBoundedJson } from './catalog-http.js';
import {
  type RegistryInstallAliases,
  readRegistryInstallAliases,
  writeRegistryInstallAliases,
} from './registry-install-aliases.js';

export { RegistryInstallAliasFormatError } from './registry-install-aliases.js';

/**
 * A manifest catalog entry. `type` is the catalog's KIND field: the manifest
 * lists every entry under `plugins`, and the kind is what decides which
 * browse surface an entry belongs to. Absent means plugin, because that is
 * what every entry written before the field was read actually is.
 *
 * The kind partitions the BROWSE lists only. Install and uninstall still
 * resolve an id the same way for either kind (`registry.ts` asks the plugin
 * registry first and falls through to the agent provider), so an entry cannot
 * become uninstallable by declaring a kind.
 */
interface ManifestPlugin {
  id: string;
  displayName: string;
  description: string;
  version: string;
  source: string;
  type?: string;
  claim?: unknown;
}

/** `ManifestPlugin.type` for an entry that is an agent DEFINITION, not code. */
const AGENT_MANIFEST_KIND = 'agent';

interface ManifestTool {
  id: string;
  displayName: string;
  description: string;
  version: string;
  source: string;
}

interface Manifest {
  version: number;
  plugins: ManifestPlugin[];
  tools?: ManifestTool[];
}

function assertSafeRegistrySegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a safe path segment`);
  }
}

function assertContainedPluginTarget(
  pluginsDir: string,
  targetDir: string,
): void {
  const resolvedPluginsDir = resolve(pluginsDir);
  const resolvedTargetDir = resolve(targetDir);
  const targetRelativePath = relative(resolvedPluginsDir, resolvedTargetDir);
  if (
    targetRelativePath === '' ||
    targetRelativePath.startsWith('..') ||
    isAbsolute(targetRelativePath)
  ) {
    throw new Error(`Plugin install target escapes plugin root: ${targetDir}`);
  }
}

/**
 * A manifest `source` that Station refuses to resolve because it names a
 * location the registry does not own: a local path outside the registry root,
 * any local path from a manifest fetched over the network, or a URL scheme
 * other than the remote transports below. Thrown by
 * {@link JsonManifestRegistryProvider}'s source resolution, which every
 * consumer (install, package resolution, integration reads) goes through.
 */
export class RegistrySourceConfinementError extends Error {
  readonly code = 'REGISTRY_SOURCE_NOT_CONFINED';
  constructor(
    readonly source: string,
    reason: string,
  ) {
    super(`Registry source '${source}' refused: ${reason}`);
    this.name = 'RegistrySourceConfinementError';
  }
}

/**
 * Where a manifest source resolved. For `local`, `location` is the path as
 * the manifest spells it (resolved, symlinks NOT followed) — the source
 * identity that install receipts and registry trust continuity compare — and
 * `physical` is the symlink-free path proven to be inside `root`, the physical
 * registry root. The provider's own reads and copies use `physical`. `remote`
 * is a network address (an allowed URL scheme or scp-style `git@host:path`)
 * that never reads local files.
 */
type ResolvedManifestSource =
  | { kind: 'local'; location: string; physical: string; root: string }
  | { kind: 'remote'; location: string };

/** Schemes a manifest source may name. `file:` and everything else refuse. */
const REMOTE_SOURCE_PROTOCOLS = new Set(['https:', 'http:', 'ssh:']);

function isScpGitSource(source: string): boolean {
  return /^git@[^/:\s]+:\S/.test(source);
}

/** `C:\x` / `C:/x`: a filesystem path, not a URL with scheme `c:`. */
function isDriveLetterPath(source: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(source);
}

function hasUrlScheme(source: string): boolean {
  return !isDriveLetterPath(source) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source);
}

function parseRemoteSource(source: string, base?: string): URL {
  let url: URL;
  try {
    url = base === undefined ? new URL(source) : new URL(source, base);
  } catch {
    throw new RegistrySourceConfinementError(source, 'not a valid URL');
  }
  if (!REMOTE_SOURCE_PROTOCOLS.has(url.protocol)) {
    throw new RegistrySourceConfinementError(
      source,
      `unsupported source protocol ${url.protocol}`,
    );
  }
  return url;
}

/** Containment by `path.relative`, so a root of `/` works too. */
function isInsideOrEqual(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
}

/**
 * The physical path of `path`: the realpath of its nearest existing ancestor
 * with the missing tail appended, so a symlinked directory anywhere on the way
 * is followed even when the leaf does not exist (a `./repo.git#branch` source,
 * say). A dangling symlink makes `realpathSync` throw, which callers treat as a
 * refusal.
 */
function physicalPath(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    let present = true;
    try {
      lstatSync(current);
    } catch {
      present = false;
    }
    if (present) return join(realpathSync(current), ...tail);
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail);
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * Refuses `candidate` unless it is inside `root` both lexically and
 * physically, and returns the physical path and root that were checked. A git
 * source's `#branch` suffix is split off by the installer, so the path before
 * it must be contained as well.
 */
function confineLocalSource(
  source: string,
  root: string,
  candidate: string,
): { physical: string; physicalRoot: string } {
  const lexicalRoot = resolve(root);
  let physicalRoot: string;
  try {
    physicalRoot = realpathSync(lexicalRoot);
  } catch {
    throw new RegistrySourceConfinementError(
      source,
      'the registry root does not exist',
    );
  }
  let physical = '';
  const paths = [candidate, candidate.split('#')[0] ?? candidate];
  for (const path of paths) {
    if (!isInsideOrEqual(lexicalRoot, resolve(path))) {
      throw new RegistrySourceConfinementError(
        source,
        'resolves outside the registry root',
      );
    }
    const checked = assertPhysicallyInside(source, physicalRoot, path);
    if (!physical) physical = checked;
  }
  return { physical, physicalRoot };
}

/** Physical path of `path`, refused unless inside `physicalRoot`. */
function assertPhysicallyInside(
  source: string,
  physicalRoot: string,
  path: string,
): string {
  let physical: string;
  try {
    physical = physicalPath(resolve(path));
  } catch {
    throw new RegistrySourceConfinementError(
      source,
      'cannot be resolved to a physical path',
    );
  }
  if (!isInsideOrEqual(physicalRoot, physical)) {
    throw new RegistrySourceConfinementError(
      source,
      'resolves outside the registry root through a symlink',
    );
  }
  return physical;
}

/**
 * A local registry source is a plain directory, copied. Anything git could
 * treat as a repository is refused rather than inspected: a path git-shaped
 * by either its manifest spelling or its physical path (both installers pick
 * git by an `.git` suffix and split `#branch` off the string), and a top-level
 * `.git` entry, which the plugin update route would later `git pull` through.
 * Both name checks use the shared matcher, so every spelling a filesystem may
 * read as `.git` is refused too. Git sources must be remote URLs.
 */
function assertPlainLocalDirectorySource(
  source: string,
  location: string,
  physical: string,
): void {
  for (const path of [source, location, physical]) {
    if (path.includes('#') || endsAsGitName(basename(path))) {
      throw new RegistrySourceConfinementError(
        source,
        'a local registry source must be a plain directory; name a git repository by its remote URL',
      );
    }
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(physical);
  } catch {
    // Not a readable directory: nothing git could use; the copy refuses it.
  }
  if (entries.some(isGitMetadataName)) {
    throw new RegistrySourceConfinementError(
      source,
      'a local registry source must not contain git metadata (.git)',
    );
  }
}

function isGitSource(source: string): boolean {
  return (
    source.startsWith('git@') ||
    source.endsWith('.git') ||
    (source.startsWith('https://') &&
      (source.includes('.git') ||
        source.includes('gitlab') ||
        source.includes('github')))
  );
}

/**
 * Ceiling on the registry manifest network read. Generous for a small JSON
 * document over a slow link, and short enough that a plugin content lock held
 * across an `install()` cannot be pinned by an unresponsive registry host.
 */
const MANIFEST_FETCH_TIMEOUT_MS = 20_000;

export class JsonManifestRegistryProvider
  implements
    IAgentRegistryProvider,
    IIntegrationRegistryProvider,
    IPluginRegistryProvider
{
  private manifestCache: Manifest | null = null;
  private cacheExpiry = 0;
  private readonly cacheTimeout = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly manifestUrl: string,
    private readonly projectHomeDir: string,
    /**
     * Ceiling on the manifest network read; see {@link fetchManifest}. A knob
     * rather than a bare constant so the refusal path can be executed in a
     * test against a host that accepts the connection and never answers — a
     * timeout nothing has ever tripped is an unproven timeout.
     */
    private readonly manifestFetchTimeoutMs: number = MANIFEST_FETCH_TIMEOUT_MS,
    private readonly logger?: Pick<Logger, 'warn'>,
  ) {}

  get registryKey(): string {
    return this.getRegistryKey();
  }

  /**
   * Reads the registry manifest, from cache when it is fresh.
   *
   * The network read is time-bounded. `install()` is called from inside a
   * plugin's content lock, and everything else that touches that plugin — a
   * consent decision, an update, an uninstall — queues behind that span. An
   * unbounded `fetch` in here therefore has no ceiling at all: a registry host
   * that accepts the connection and never answers holds the lock until the
   * process dies (archive#4309 follow-up review, MEDIUM 2). The timeout covers
   * the response BODY too, not just the headers, because the signal stays live
   * until `json()` resolves.
   */
  private async fetchManifest(fresh = false): Promise<Manifest> {
    const now = Date.now();
    if (!fresh && this.manifestCache && now < this.cacheExpiry) {
      return this.manifestCache;
    }

    // Keep this request's result local: another concurrent fetch must not
    // substitute its catalog between this source and claim observation.
    let manifest: Manifest;
    // Support both URLs and local file paths
    if (this.isLocalManifest()) {
      const bounded = readPluginManifestBytesBounded(this.manifestUrl);
      if (!bounded.ok)
        throw new Error(
          'Registry manifest is not an available bounded regular file.',
        );
      manifest = JSON.parse(bounded.raw) as Manifest;
    } else {
      const response = await fetch(this.manifestUrl, {
        signal: AbortSignal.timeout(this.manifestFetchTimeoutMs),
        ...(fresh ? { cache: 'no-store' as const } : {}),
      });
      if (!response.ok) {
        throw new Error(
          `Failed to fetch manifest: ${response.status} ${response.statusText}`,
        );
      }
      manifest = (await readBoundedJson(response)) as Manifest;
    }

    this.manifestCache = manifest;
    this.cacheExpiry = now + this.cacheTimeout;
    return manifest;
  }

  async getCatalogSnapshot(): Promise<PluginRegistryCatalogSnapshot> {
    const manifest = await this.fetchManifest(true);
    const entries = this.manifestEntriesOfKind(manifest, 'plugin');
    return {
      revision: createHash('sha256')
        .update(JSON.stringify(manifest))
        .digest('hex'),
      items: entries.map((plugin) => ({
        id: plugin.id,
        displayName: plugin.displayName,
        description: plugin.description,
        version: plugin.version,
        source: this.listedSource(plugin.id, plugin.source),
        installed: false,
      })),
      packages: entries.map((plugin) => ({
        id: plugin.id,
        source: this.resolveManifestSource(plugin.source).location,
        ...(plugin.claim === undefined
          ? {}
          : { claim: structuredClone(plugin.claim) }),
      })),
    };
  }

  async refresh(): Promise<void> {
    await this.fetchManifest(true);
  }

  async getCatalogRevision(): Promise<string> {
    return createHash('sha256')
      .update(JSON.stringify(await this.fetchManifest()))
      .digest('hex');
  }

  async resolvePackage(
    id: string,
  ): Promise<{ source: string; claim?: unknown } | null> {
    const manifest = await this.fetchManifest(true);
    const matches = manifest.plugins.filter((plugin) => plugin.id === id);
    if (matches.length > 1)
      throw new Error('Registry package identity is ambiguous');
    const plugin = matches[0];
    if (!plugin) return null;
    return {
      source: this.resolveManifestSource(plugin.source).location,
      ...(plugin.claim === undefined
        ? {}
        : { claim: structuredClone(plugin.claim) }),
    };
  }

  private getPluginsDir(): string {
    return join(this.projectHomeDir, 'plugins');
  }

  private isLocalManifest(): boolean {
    return this.manifestUrl.startsWith('/') || this.manifestUrl.startsWith('.');
  }

  private getRegistryKey(): string {
    if (this.isLocalManifest()) {
      return resolve(this.manifestUrl);
    }
    return this.manifestUrl;
  }

  /**
   * The root a local manifest's sources must stay inside: the parent of the
   * manifest's directory. That is the root the CLI registry resolver enforced
   * and what the shipped catalogs rely on — `examples/registry/*.json` name
   * their plugins as `../<example>` siblings of the `registry/` directory.
   */
  private getLocalRegistryRoot(): string {
    return resolve(dirname(resolve(this.manifestUrl)), '..');
  }

  /**
   * The single owner of manifest source resolution; every consumer goes
   * through here, so containment cannot be skipped by one of them.
   *
   * - Remote transports (`https:`, `http:`, `ssh:` URLs and scp-style
   *   `git@host:path`) pass through from either kind of manifest. `http:` is
   *   refused later for code installs, by name (#2363).
   * - A local manifest's other sources are filesystem paths, absolute or
   *   relative to the manifest, and must resolve inside
   *   {@link getLocalRegistryRoot} lexically and after following symlinks.
   * - A network manifest never names a local path: an absolute path is
   *   refused and a relative one resolves as a URL against the manifest URL.
   *
   * Any other scheme, `file:` included, is refused.
   */
  private resolveManifestSource(source: string): ResolvedManifestSource {
    if (typeof source !== 'string' || source.length === 0) {
      throw new RegistrySourceConfinementError(
        String(source),
        'source must be a non-empty string',
      );
    }
    if (isScpGitSource(source)) {
      return { kind: 'remote', location: source };
    }
    if (hasUrlScheme(source)) {
      parseRemoteSource(source);
      return { kind: 'remote', location: source };
    }

    if (this.isLocalManifest()) {
      const location = resolve(dirname(this.manifestUrl), source);
      const { physical, physicalRoot } = confineLocalSource(
        source,
        this.getLocalRegistryRoot(),
        location,
      );
      // Checked here, not at install: resolvePackage's callers stage the
      // source with their own installer and never reach this provider's.
      assertPlainLocalDirectorySource(source, location, physical);
      return { kind: 'local', location, physical, root: physicalRoot };
    }

    if (isAbsolute(source) || isDriveLetterPath(source)) {
      throw new RegistrySourceConfinementError(
        source,
        'a network registry manifest cannot name a local path',
      );
    }
    // A relative reference stays on the registry host. A backslash makes the
    // URL parser read `\\host` as an authority and switch hosts, so it is
    // refused rather than resolved (`//host` was refused above as absolute).
    // The origin is checked after resolution too, because the parser also
    // strips leading whitespace and tabs anywhere (`\t//host`).
    if (source.includes('\\')) {
      throw new RegistrySourceConfinementError(
        source,
        'a relative source cannot contain a backslash',
      );
    }
    const url = parseRemoteSource(source, this.manifestUrl);
    if (url.origin !== new URL(this.manifestUrl).origin) {
      throw new RegistrySourceConfinementError(
        source,
        'a relative source resolved to another host',
      );
    }
    return { kind: 'remote', location: url.toString() };
  }

  /**
   * Source shown in a catalog listing. A refused entry stays listed without a
   * source — installing it reports the refusal — so one bad entry does not
   * take the whole catalog down.
   */
  private listedSource(id: string, source: string): string | undefined {
    try {
      return this.resolveManifestSource(source).location;
    } catch (error) {
      if (!(error instanceof RegistrySourceConfinementError)) throw error;
      this.logger?.warn('Registry manifest source refused', {
        entryId: id,
        error: error.message,
      });
      return undefined;
    }
  }

  private readInstalledPlugins(): RegistryItem[] {
    const pluginsDir = this.getPluginsDir();
    if (!existsSync(pluginsDir)) return [];

    const items: RegistryItem[] = [];
    for (const entry of scanInstalledPluginInventory(pluginsDir, this.logger)) {
      if (entry.state === 'rejected') continue;
      const manifest = entry.manifest;
      items.push({
        id: manifest.name || entry.directoryName,
        displayName: manifest.displayName,
        description: manifest.description,
        version: manifest.version,
        installed: true,
      });
    }

    return items;
  }

  private readRegistryInstallAliases(): RegistryInstallAliases {
    return readRegistryInstallAliases(this.projectHomeDir);
  }

  private writeRegistryInstallAliases(aliases: RegistryInstallAliases): void {
    writeRegistryInstallAliases(this.projectHomeDir, aliases);
  }

  private async materializeSource(source: string): Promise<string> {
    const resolved = this.resolveManifestSource(source);
    // Copy or clone from the path the containment check validated, so a
    // symlink swapped into the manifest's spelling of it after the check is
    // not followed.
    const resolvedSource =
      resolved.kind === 'local' ? resolved.physical : resolved.location;
    if (resolved.kind === 'remote' && !isGitSource(resolvedSource)) {
      throw new Error(
        `Plugin source ${resolvedSource} is neither a git repository nor a local path inside the registry root`,
      );
    }
    const tempDir = createStationTempDirSync('registry-plugin');

    try {
      // One classification decides both the checks and the transport: a
      // remote source is cloned, a local one (already proven a plain
      // directory) is copied. A local path is never handed to git.
      if (resolved.kind === 'remote') {
        const [url, branch] = resolvedSource.split('#');
        // #2363: Station's git allows only https and ssh. Refused here, by
        // name, rather than as a transport error deep inside git: code
        // fetched over plain http can be altered in transit.
        if (/^http:\/\//i.test(url)) {
          throw new Error(
            `Plugin source ${url} uses plain http://. Use an https:// address: code installed over http can be tampered with in transit.`,
          );
        }
        const cloneArgs = ['clone', '--depth', '1'];
        if (branch) cloneArgs.push('--branch', branch);
        cloneArgs.push(url, tempDir);

        // Remote only: git keeps its `file` transport disabled (#2363).
        execGitSync(cloneArgs, { timeout: 30000 });
      } else {
        if (!existsSync(resolvedSource)) {
          throw new Error(`Source not found: ${resolvedSource}`);
        }
        // Async: `cpSync` aborts the process on an unreadable directory.
        await copyPluginTree(resolvedSource, tempDir);
      }
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }

    return tempDir;
  }

  /**
   * Entries of one catalog kind. The browse surfaces partition the manifest
   * between them so a tab lists only what it names: the agent surface used to
   * serve `manifest.plugins` whole, so a catalog of layout plugins listed
   * under "Agents" beneath a "Selected agent" heading, with an install action
   * that installed a plugin (#1536 D2).
   */
  private manifestEntriesOfKind(
    manifest: Manifest,
    kind: 'agent' | 'plugin',
  ): ManifestPlugin[] {
    return manifest.plugins.filter((entry) =>
      kind === AGENT_MANIFEST_KIND
        ? entry.type === AGENT_MANIFEST_KIND
        : entry.type !== AGENT_MANIFEST_KIND,
    );
  }

  // IPluginRegistryProvider implementation

  async listAvailable(): Promise<RegistryItem[]> {
    return this.listAvailableOfKind('plugin');
  }

  async listInstalled(): Promise<RegistryItem[]> {
    return this.listInstalledOfKind('plugin');
  }

  private async listAvailableOfKind(
    kind: 'agent' | 'plugin',
  ): Promise<RegistryItem[]> {
    const manifest = await this.fetchManifest();
    return this.manifestEntriesOfKind(manifest, kind).map((plugin) => ({
      id: plugin.id,
      displayName: plugin.displayName,
      description: plugin.description,
      version: plugin.version,
      source: this.listedSource(plugin.id, plugin.source),
      installed: false,
    }));
  }

  private async listInstalledOfKind(
    kind: 'agent' | 'plugin',
  ): Promise<RegistryItem[]> {
    const manifest = await this.fetchManifest();
    const installedPlugins = new Map(
      this.readInstalledPlugins().map((item) => [String(item.id), item]),
    );
    const aliases = this.readRegistryInstallAliases();

    return this.manifestEntriesOfKind(manifest, kind).flatMap((plugin) => {
      const alias = aliases[plugin.id];
      if (!alias || alias.registryKey !== this.getRegistryKey()) {
        return [];
      }
      const installedPluginName = alias.pluginName;
      const installedPlugin = installedPlugins.get(installedPluginName);
      if (!installedPlugin) {
        return [];
      }
      return {
        id: plugin.id,
        displayName: plugin.displayName,
        description: plugin.description,
        version: installedPlugin?.version,
        source: this.listedSource(plugin.id, plugin.source),
        installed: true,
        installedPluginName,
      };
    });
  }

  async install(
    id: string,
    options: { expectedInstalledPluginName?: string } = {},
  ): Promise<InstallResult & { rollback?: () => Promise<void> }> {
    try {
      assertSafeRegistrySegment(id, 'Registry plugin id');
      const manifest = await this.fetchManifest();
      const plugin = manifest.plugins.find((p) => p.id === id);

      if (!plugin) {
        return {
          success: false,
          message: `Plugin '${id}' not found in registry`,
        };
      }

      const pluginsDir = this.getPluginsDir();
      const stagedSourceDir = await this.materializeSource(plugin.source);
      try {
        const sourceManifestPath = join(stagedSourceDir, 'plugin.json');
        if (!existsSync(sourceManifestPath)) {
          throw new Error(`Plugin '${id}' source is missing plugin.json`);
        }
        // The staged registry source is untrusted: bounded read, no symlink
        // following (#2342 review).
        const sourceManifest =
          readUntrustedPluginManifestSyncWithFormat(
            sourceManifestPath,
          ).manifest;
        const pluginName = sourceManifest.name;
        assertSafeRegistrySegment(pluginName, 'Registry plugin manifest name');
        // This provider writes `<plugins>/<pluginName>` itself (below) rather
        // than going through `installPluginFromSource`, so the reserved-
        // identity refusal has to be here too. A registry entry is the least
        // inspected install of all — the operator picked a catalog row, not a
        // manifest.
        assertPluginIdentityAvailable(pluginName);
        if (
          options.expectedInstalledPluginName &&
          pluginName !== options.expectedInstalledPluginName
        ) {
          // Before the write below, which is `rmSync(targetDir)` +
          // `cpSync(staged, targetDir)` at a path derived from the FETCHED
          // manifest's name. A caller that has already committed to a
          // different path — an update bound to an alias, or a dependency
          // install holding `<plugins>/<dependency.id>`'s content lock —
          // passes the name it expects so the divergence is refused here
          // rather than silently rewriting another plugin's tree.
          throw new Error(
            `Registry plugin '${id}' resolved installed plugin '${pluginName}' but expected '${options.expectedInstalledPluginName}'`,
          );
        }
        const targetDir = join(pluginsDir, pluginName);
        assertContainedPluginTarget(pluginsDir, targetDir);
        const aliases = this.readRegistryInstallAliases();
        const existingAlias = aliases[id];
        if (
          existingAlias &&
          (existingAlias.pluginName !== pluginName ||
            existingAlias.registryKey !== this.getRegistryKey())
        ) {
          throw new Error(
            `Registry plugin '${id}' is already owned by another registry source or plugin target`,
          );
        }
        const existingRegistryOwner = Object.entries(aliases).find(
          ([, alias]) =>
            alias.pluginName === pluginName &&
            alias.registryKey === this.getRegistryKey(),
        )?.[0];
        if (existingRegistryOwner && existingRegistryOwner !== id) {
          throw new Error(
            `Registry plugin '${id}' cannot claim installed plugin '${pluginName}' already owned by registry plugin '${existingRegistryOwner}'`,
          );
        }
        if (existsSync(targetDir) && existingRegistryOwner !== id) {
          throw new Error(
            `Registry plugin '${id}' cannot overwrite installed plugin '${pluginName}'`,
          );
        }

        rmSync(targetDir, { recursive: true, force: true });
        mkdirSync(pluginsDir, { recursive: true });
        // Verbatim: the staged tree is deleted next, so a relative link
        // rewritten to an absolute staged path would dangle (#2342 review).
        cpSync(stagedSourceDir, targetDir, PLUGIN_TREE_COPY);
        rmSync(stagedSourceDir, { recursive: true, force: true });
        const installedAlias = {
          pluginName,
          registryKey: this.getRegistryKey(),
        };
        aliases[id] = installedAlias;
        this.writeRegistryInstallAliases(aliases);

        return {
          success: true,
          message: `Plugin '${pluginName}' installed successfully`,
          // The registry write is only the first half of a dependency
          // install. Validation and lifecycle activation happen in the
          // caller, so hand that caller an exact compensation capability.
          // It restores the prior record only while the alias still equals
          // what THIS call wrote; a later owner or supply-chain pin wins.
          rollback: async () => {
            const currentAliases = this.readRegistryInstallAliases();
            const current = currentAliases[id];
            if (
              !current ||
              current.pluginName !== installedAlias.pluginName ||
              current.registryKey !== installedAlias.registryKey ||
              current.supplyChain !== undefined
            ) {
              return;
            }
            if (existingAlias) {
              currentAliases[id] = structuredClone(existingAlias);
            } else {
              delete currentAliases[id];
            }
            this.writeRegistryInstallAliases(currentAliases);
          },
        };
      } catch (error) {
        rmSync(stagedSourceDir, { recursive: true, force: true });
        throw error;
      }
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  async update(id: string): Promise<InstallResult> {
    const aliases = this.readRegistryInstallAliases();
    const alias = aliases[id];
    if (!alias || alias.registryKey !== this.getRegistryKey()) {
      return {
        success: false,
        message: `Registry plugin '${id}' is not installed from this registry`,
      };
    }
    return this.install(id, {
      expectedInstalledPluginName: alias.pluginName,
    });
  }

  async uninstall(id: string): Promise<InstallResult> {
    try {
      assertSafeRegistrySegment(id, 'Registry plugin id');
      const pluginsDir = this.getPluginsDir();
      const aliases = this.readRegistryInstallAliases();
      const alias = aliases[id];
      if (!alias || alias.registryKey !== this.getRegistryKey()) {
        return {
          success: false,
          message: `Registry plugin '${id}' is not installed from this registry`,
        };
      }
      const pluginName = alias.pluginName;
      assertSafeRegistrySegment(pluginName, 'Registry plugin manifest name');
      const targetDir = join(pluginsDir, pluginName);
      assertContainedPluginTarget(pluginsDir, targetDir);

      if (!existsSync(targetDir)) {
        return { success: false, message: `Plugin '${id}' not found` };
      }

      rmSync(targetDir, { recursive: true, force: true });
      delete aliases[id];
      this.writeRegistryInstallAliases(aliases);
      return {
        success: true,
        message: `Plugin '${pluginName}' uninstalled successfully`,
      };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Agent-definition view over the manifest, registered as the agent registry
   * provider (`register-manifest-registry.ts`). Only entries the catalog
   * declares as agents are browsable here; install and uninstall stay the
   * class's, so an id resolves identically whichever surface offered it.
   */
  agentRegistry(): IAgentRegistryProvider {
    return {
      listAvailable: () => this.listAvailableOfKind(AGENT_MANIFEST_KIND),
      listInstalled: () => this.listInstalledOfKind(AGENT_MANIFEST_KIND),
      install: (id: string) => this.install(id),
      uninstall: (id: string) => this.uninstall(id),
    };
  }

  async resolveSource(id: string): Promise<string | null> {
    const manifest = await this.fetchManifest();
    const plugin = manifest.plugins.find((entry) => entry.id === id);
    return plugin ? this.resolveManifestSource(plugin.source).location : null;
  }

  // IIntegrationRegistryProvider implementation
  //
  // The class-level integration methods are legacy no-ops; manifest `tools`
  // entries are served through `integrationRegistry()` below so curated MCP
  // integrations don't leak into the plugin/agent browse lists.

  async getToolDef(id: string): Promise<ToolDef | null> {
    return this.readManifestToolDef(id);
  }

  async sync(): Promise<void> {
    // No-op for now
  }

  // ── Manifest tools (curated integrations) ──────────────────────

  private async findManifestTool(id: string): Promise<ManifestTool | null> {
    const manifest = await this.fetchManifest();
    return (manifest.tools ?? []).find((tool) => tool.id === id) ?? null;
  }

  /** Load the ToolDef for a manifest tool from `<source>/integration.json`. */
  private async readManifestToolDef(id: string): Promise<ToolDef | null> {
    const tool = await this.findManifestTool(id);
    if (!tool) return null;

    try {
      const resolved = this.resolveManifestSource(tool.source);
      let raw: string;
      if (resolved.kind === 'local') {
        // The file itself must be inside the root, not only its directory.
        raw = readFileSync(
          assertPhysicallyInside(
            tool.source,
            resolved.root,
            join(resolved.physical, 'integration.json'),
          ),
          'utf-8',
        );
      } else {
        const base = new URL(`${resolved.location}/`);
        if (base.protocol !== 'https:' && base.protocol !== 'http:') {
          throw new Error(
            `Integration source protocol ${base.protocol} cannot be read`,
          );
        }
        const response = await fetch(new URL('integration.json', base));
        if (!response.ok) return null;
        raw = await response.text();
      }
      const def = JSON.parse(raw) as ToolDef;
      return { ...def, id: def.id || tool.id };
    } catch (error) {
      this.logger?.warn('Registry integration manifest rejected', {
        integrationId: id,
        error: errorMessage(error),
      });
      return null;
    }
  }

  /**
   * Integration registry view over the manifest's `tools` entries. Install is
   * a validation no-op: the registry route persists the ToolDef returned by
   * `getToolDef` into `<home>/integrations/<id>/integration.json`, which is
   * also how installed-state and uninstall are tracked.
   */
  integrationRegistry(): IIntegrationRegistryProvider {
    return {
      listAvailable: async (): Promise<RegistryItem[]> => {
        const manifest = await this.fetchManifest();
        return (manifest.tools ?? []).map((tool) => ({
          id: tool.id,
          displayName: tool.displayName,
          description: tool.description,
          version: tool.version,
          source: this.listedSource(tool.id, tool.source),
          installed: false,
        }));
      },
      listInstalled: async (): Promise<RegistryItem[]> => [],
      install: async (id: string): Promise<InstallResult> => {
        // Refuse a non-confined source by name rather than as "not found".
        const tool = await this.findManifestTool(id);
        if (tool) {
          try {
            this.resolveManifestSource(tool.source);
          } catch (error) {
            if (!(error instanceof RegistrySourceConfinementError)) throw error;
            return { success: false, message: error.message };
          }
        }
        const def = await this.readManifestToolDef(id);
        if (!def) {
          return {
            success: false,
            message: `Integration '${id}' not found in registry`,
          };
        }
        return {
          success: true,
          message: `Integration '${id}' is available for install`,
        };
      },
      uninstall: async (id: string): Promise<InstallResult> => {
        const tool = await this.findManifestTool(id);
        if (!tool) {
          return { success: false, message: `Integration '${id}' not found` };
        }
        return { success: true, message: `Integration '${id}' removed` };
      },
      getToolDef: async (id: string) => this.readManifestToolDef(id),
      sync: async () => {},
    };
  }
}
