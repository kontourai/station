/**
 * JSON Manifest Registry Provider
 * Implements registry lookups for plugins and integrations from a remote or local JSON manifest.
 * by fetching a remote JSON manifest.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { createStationTempDirSync } from '@kontourai/station-shared/temp-dir';
import { scanInstalledPluginInventory } from '../../services/plugins/installed-plugin-inventory.js';
import { readPluginManifestFileSync } from '../../services/plugins/plugin-manifest-loader.js';
import { assertPluginIdentityAvailable } from '../../services/plugins/reserved-plugin-identities.js';
import { execGitSync } from '../../utils/git-exec.js';
import type { Logger } from '../../utils/logger.js';
import type { InstallResult, RegistryItem } from '../provider-contracts.js';
import type {
  IAgentRegistryProvider,
  IIntegrationRegistryProvider,
  IPluginRegistryProvider,
} from '../provider-interfaces.js';
import {
  type RegistryInstallAliases,
  readRegistryInstallAliases,
  writeRegistryInstallAliases,
} from './registry-install-aliases.js';

export { RegistryInstallAliasFormatError } from './registry-install-aliases.js';

interface ManifestPlugin {
  id: string;
  displayName: string;
  description: string;
  version: string;
  source: string;
  type: string;
}

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
  private async fetchManifest(): Promise<Manifest> {
    const now = Date.now();
    if (this.manifestCache && now < this.cacheExpiry) {
      return this.manifestCache;
    }

    // Support both URLs and local file paths
    if (this.manifestUrl.startsWith('/') || this.manifestUrl.startsWith('.')) {
      const raw = readFileSync(this.manifestUrl, 'utf-8');
      this.manifestCache = JSON.parse(raw) as Manifest;
    } else {
      const response = await fetch(this.manifestUrl, {
        signal: AbortSignal.timeout(this.manifestFetchTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `Failed to fetch manifest: ${response.status} ${response.statusText}`,
        );
      }
      this.manifestCache = (await response.json()) as Manifest;
    }

    this.cacheExpiry = now + this.cacheTimeout;
    return this.manifestCache!;
  }

  private getPluginsDir(): string {
    return join(this.projectHomeDir, 'plugins');
  }

  private getRegistryKey(): string {
    if (this.manifestUrl.startsWith('/') || this.manifestUrl.startsWith('.')) {
      return resolve(this.manifestUrl);
    }
    return this.manifestUrl;
  }

  private resolveManifestSource(source: string): string {
    if (
      source.startsWith('git@') ||
      source.startsWith('https://') ||
      source.startsWith('http://')
    ) {
      return source;
    }

    if (isAbsolute(source)) {
      return source;
    }

    if (this.manifestUrl.startsWith('/') || this.manifestUrl.startsWith('.')) {
      return resolve(dirname(this.manifestUrl), source);
    }

    try {
      return new URL(source, this.manifestUrl).toString();
    } catch {
      return source;
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

  private materializeSource(source: string): string {
    const resolvedSource = this.resolveManifestSource(source);
    const tempDir = createStationTempDirSync('registry-plugin');

    try {
      if (isGitSource(resolvedSource)) {
        const [url, branch] = resolvedSource.split('#');
        const cloneArgs = ['clone', '--depth', '1'];
        if (branch) cloneArgs.push('--branch', branch);
        cloneArgs.push(url, tempDir);

        execGitSync(cloneArgs, { timeout: 30000 });
      } else {
        if (!existsSync(resolvedSource)) {
          throw new Error(`Source not found: ${resolvedSource}`);
        }
        cpSync(resolvedSource, tempDir, { recursive: true });
      }
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }

    return tempDir;
  }

  // IAgentRegistryProvider implementation

  async listAvailable(): Promise<RegistryItem[]> {
    const manifest = await this.fetchManifest();
    return manifest.plugins.map((plugin) => ({
      id: plugin.id,
      displayName: plugin.displayName,
      description: plugin.description,
      version: plugin.version,
      source: this.resolveManifestSource(plugin.source),
      installed: false,
    }));
  }

  async listInstalled(): Promise<RegistryItem[]> {
    const manifest = await this.fetchManifest();
    const installedPlugins = new Map(
      this.readInstalledPlugins().map((item) => [String(item.id), item]),
    );
    const aliases = this.readRegistryInstallAliases();

    return manifest.plugins.flatMap((plugin) => {
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
        source: this.resolveManifestSource(plugin.source),
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
      const stagedSourceDir = this.materializeSource(plugin.source);
      try {
        const sourceManifestPath = join(stagedSourceDir, 'plugin.json');
        if (!existsSync(sourceManifestPath)) {
          throw new Error(`Plugin '${id}' source is missing plugin.json`);
        }
        const sourceManifest = readPluginManifestFileSync(sourceManifestPath);
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
        cpSync(stagedSourceDir, targetDir, { recursive: true });
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

  async resolveSource(id: string): Promise<string | null> {
    const manifest = await this.fetchManifest();
    const plugin = manifest.plugins.find((entry) => entry.id === id);
    return plugin ? this.resolveManifestSource(plugin.source) : null;
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

    const resolvedSource = this.resolveManifestSource(tool.source);
    try {
      let raw: string;
      if (
        resolvedSource.startsWith('https://') ||
        resolvedSource.startsWith('http://')
      ) {
        const response = await fetch(
          new URL('integration.json', `${resolvedSource}/`).toString(),
        );
        if (!response.ok) return null;
        raw = await response.text();
      } else {
        raw = readFileSync(join(resolvedSource, 'integration.json'), 'utf-8');
      }
      const def = JSON.parse(raw) as ToolDef;
      return { ...def, id: def.id || tool.id };
    } catch (error) {
      this.logger?.warn('Registry integration manifest rejected', {
        integrationId: id,
        error: error instanceof Error ? error.message : String(error),
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
          source: this.resolveManifestSource(tool.source),
          installed: false,
        }));
      },
      listInstalled: async (): Promise<RegistryItem[]> => [],
      install: async (id: string): Promise<InstallResult> => {
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
