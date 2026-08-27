import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  type DistributionItemPolicy,
  type DistributionLifecycleOverride,
  type DistributionLifecycleOverrides,
  type DistributionProfile,
  type DistributionProfileSelection,
  type DistributionRegistrySource,
  type LayoutCatalogItem,
  MINIMAL_DISTRIBUTION_PROFILE,
  type ResolvedCatalogLayout,
  STANDARD_DISTRIBUTION_PROFILE,
} from '@kontourai/station-contracts/distribution';
import {
  type AvailableProjectLayout,
  assertNoRetiredLayoutKeys,
  BUILTIN_PROJECT_LAYOUTS,
  type LayoutCatalogContribution,
} from '@kontourai/station-contracts/layout';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { parsePluginManifest } from './plugin-manifest-loader.js';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LIFECYCLE_FILE = ['config', 'distribution-lifecycle.json'] as const;
const BUILTIN_LAYOUT_CONTRIBUTION_VERSION = '1.0.0';

interface PluginLayoutEntry {
  item: LayoutCatalogItem;
  definition: ResolvedCatalogLayout['definition'];
  pluginName: string;
}

interface ParsedPluginLayout {
  manifest: PluginManifest;
  definition: ResolvedCatalogLayout['definition'];
}

export interface InstalledPluginWorkspacePaneContribution {
  id: string;
  pluginName: string;
  enabled: boolean;
  descriptor: WorkspacePaneDescriptor;
  /**
   * Exact catalog contribution snapshot for occurrence issuance. The renderer
   * check treats this on-disk installation record and the descriptor claim as
   * a consistency check, failing closed if they diverge through tampering,
   * manual relocation, or a corrupted inventory. The supported installer
   * derives both names from `manifest.name`, so this is not independently
   * controlled identity or an execution-trust boundary; installed bundles are
   * already trusted code. An installer-assigned identity is a separate design
   * decision if attribution needs stronger provenance.
   */
  contribution: LayoutCatalogContribution;
}

function pluginPaneContributionId(
  pluginName: string,
  descriptorId: string,
): string {
  const suffix = createHash('sha256')
    .update(descriptorId)
    .digest('hex')
    .slice(0, 12);
  return `plugin:${pluginName}:pane-${suffix}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
}

function isSafeRelativeFilePath(value: string): boolean {
  return (
    !isAbsolute(value) &&
    !value.split(/[\\/]+/).some((segment) => segment === '' || segment === '..')
  );
}

function resolvePluginDirectory(
  projectHomeDir: string,
  pluginName: string,
): string | null {
  const pluginsDir = resolve(projectHomeDir, 'plugins');
  const pluginDir = resolve(pluginsDir, pluginName);
  try {
    if (!lstatSync(pluginsDir).isDirectory()) return null;
    if (!lstatSync(pluginDir).isDirectory()) return null;
    const realPluginsDir = realpathSync(pluginsDir);
    const realPluginDir = realpathSync(pluginDir);
    return isContainedPath(realPluginsDir, realPluginDir)
      ? realPluginDir
      : null;
  } catch {
    return null;
  }
}

function readContainedRegularFile(pluginDir: string, source: string): string {
  if (!isSafeRelativeFilePath(source)) {
    throw new Error('Plugin file source must be a safe relative path');
  }
  const candidate = resolve(pluginDir, source);
  const status = lstatSync(candidate);
  if (!status.isFile()) {
    throw new Error('Plugin file must be a regular file');
  }
  const realCandidate = realpathSync(candidate);
  if (!isContainedPath(pluginDir, realCandidate)) {
    throw new Error('Plugin file escapes the plugin directory');
  }
  return readFileSync(realCandidate, 'utf-8');
}

function readContainedRegularJson(pluginDir: string, source: string): unknown {
  return JSON.parse(readContainedRegularFile(pluginDir, source)) as unknown;
}

function parseLayoutDefinition(
  value: unknown,
  manifest: PluginManifest,
  pluginName: string,
): ResolvedCatalogLayout['definition'] {
  if (!isPlainObject(value)) {
    throw new Error('Plugin layout must be an object');
  }
  const manifestSlug = manifest.layout?.slug;
  const slug =
    typeof value.slug === 'string'
      ? value.slug
      : typeof manifestSlug === 'string'
        ? manifestSlug
        : '';
  if (!SAFE_ID.test(slug)) throw new Error('Plugin layout slug is invalid');
  // Before reading anything: a layout still on a retired key must fail by
  // name. Reading `globalSkills` off a layout that declares `globalPrompts`
  // yields `undefined`, and the profile then resolves cleanly with every
  // global action gone (review M1).
  assertNoRetiredLayoutKeys(value, `Plugin '${pluginName}' layout`);
  return {
    name:
      typeof value.name === 'string'
        ? value.name
        : typeof manifest.displayName === 'string'
          ? manifest.displayName
          : pluginName,
    slug,
    icon: typeof value.icon === 'string' ? value.icon : undefined,
    description:
      typeof value.description === 'string'
        ? value.description
        : typeof manifest.description === 'string'
          ? manifest.description
          : undefined,
    type: typeof value.type === 'string' ? value.type : 'chat',
    tabs: Array.isArray(value.tabs) ? (value.tabs as any[]) : [],
    globalSkills: Array.isArray(value.globalSkills)
      ? (value.globalSkills as any[])
      : undefined,
    defaultAgent:
      typeof value.defaultAgent === 'string'
        ? agentId(value.defaultAgent)
        : undefined,
    availableAgents: Array.isArray(value.availableAgents)
      ? (value.availableAgents as string[]).map(agentId)
      : undefined,
    requiredProviders: Array.isArray(value.requiredProviders)
      ? (value.requiredProviders as string[])
      : undefined,
  };
}

function readPluginManifestFile(
  projectHomeDir: string,
  pluginName: string,
): { manifest: PluginManifest; pluginDir: string } {
  const pluginDir = resolvePluginDirectory(projectHomeDir, pluginName);
  if (!pluginDir) throw new Error('Plugin directory is unavailable');
  const manifestPath = resolve(pluginDir, 'plugin.json');
  const manifest = parsePluginManifest(
    readContainedRegularFile(pluginDir, 'plugin.json'),
    manifestPath,
  );
  return { manifest, pluginDir };
}

function readPluginLayoutFiles(
  projectHomeDir: string,
  pluginName: string,
): ParsedPluginLayout {
  const { manifest, pluginDir } = readPluginManifestFile(
    projectHomeDir,
    pluginName,
  );
  const layoutSource = manifest.layout?.source || 'layout.json';
  const layout = readContainedRegularJson(pluginDir, layoutSource);
  return {
    manifest,
    definition: parseLayoutDefinition(layout, manifest, pluginName),
  };
}

function logInvalidPlugin(pluginName: string, error: unknown): void {
  console.debug('Failed to read installed plugin layout:', pluginName, error);
}

function cloneProfile(profile: DistributionProfile): DistributionProfile {
  return {
    ...profile,
    registrySources: profile.registrySources.map((source) => ({ ...source })),
    itemPolicies: Object.fromEntries(
      Object.entries(profile.itemPolicies ?? {}).map(([id, policy]) => [
        id,
        { ...policy },
      ]),
    ),
  };
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} must be a lowercase, path-safe identifier`);
  }
}

function assertSafeCatalogId(value: string): void {
  if (
    !/^(builtin|plugin):[a-z0-9][a-z0-9-]{0,62}(?::[a-z0-9][a-z0-9-]{0,62})?$/.test(
      value,
    )
  ) {
    throw new Error(`Invalid layout catalog item id: ${value || '(empty)'}`);
  }
}

function assertSource(source: DistributionRegistrySource): void {
  assertSafeId(source.id, 'Registry source id');
  if (source.kind === 'builtin') {
    if (source.source)
      throw new Error('Built-in registry sources cannot set source');
    return;
  }
  if (!source.source) {
    throw new Error(`Registry source '${source.id}' requires source`);
  }
  if (source.kind === 'local') {
    if (
      isAbsolute(source.source) ||
      source.source
        .split(/[\\/]+/)
        .some((segment) => segment === '..' || !segment)
    ) {
      throw new Error(
        `Local registry source '${source.id}' must be a safe relative path`,
      );
    }
    return;
  }
  let url: URL;
  try {
    url = new URL(source.source);
  } catch {
    throw new Error(
      `Remote registry source '${source.id}' must be a valid URL`,
    );
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Remote registry source '${source.id}' must use http(s) without credentials`,
    );
  }
}

/** Resolve and validate a profile without causing network or plugin side effects. */
export function resolveDistributionProfile(
  selection: DistributionProfileSelection | undefined,
): DistributionProfile {
  const profile = cloneProfile(
    selection === undefined || selection === 'standard'
      ? STANDARD_DISTRIBUTION_PROFILE
      : selection === 'minimal'
        ? MINIMAL_DISTRIBUTION_PROFILE
        : selection,
  );
  assertSafeId(profile.id, 'Distribution profile id');
  const sourceIds = new Set<string>();
  for (const source of profile.registrySources) {
    assertSource(source);
    if (sourceIds.has(source.id)) {
      throw new Error(`Duplicate registry source id: ${source.id}`);
    }
    sourceIds.add(source.id);
  }
  for (const [itemId, policy] of Object.entries(profile.itemPolicies ?? {})) {
    assertSafeCatalogId(itemId);
    if (!policy || typeof policy !== 'object') {
      throw new Error(`Layout policy '${itemId}' must be an object`);
    }
    for (const value of Object.values(policy)) {
      if (value !== undefined && typeof value !== 'boolean') {
        throw new Error(`Layout policy '${itemId}' values must be boolean`);
      }
    }
  }
  return profile;
}

/**
 * Owns the distribution policy projection and only explicit user lifecycle
 * overrides. It deliberately does not fetch a remote registry or execute a
 * plugin while listing catalog entries.
 */
export class DistributionProfileService {
  readonly profile: DistributionProfile;

  constructor(
    private readonly projectHomeDir: string,
    selection?: DistributionProfileSelection,
  ) {
    this.profile = resolveDistributionProfile(selection);
  }

  listLayouts(): LayoutCatalogItem[] {
    const builtins = this.hasBuiltinSource()
      ? BUILTIN_PROJECT_LAYOUTS.map((layout) => this.toBuiltinItem(layout))
      : [];
    const plugins = this.listInstalledPluginLayouts();
    return [...builtins, ...plugins]
      .filter((item) => item.visible)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listInstalledLayouts(): LayoutCatalogItem[] {
    return this.listLayouts().filter(
      (item) => item.lifecycle.state === 'installed',
    );
  }

  /** Reads inert direct Pane declarations from installed local plugins. */
  listPluginWorkspacePaneContributions(): InstalledPluginWorkspacePaneContribution[] {
    if (
      !this.profile.registrySources.some((source) => source.kind === 'local')
    ) {
      return [];
    }
    const pluginsDir = join(this.projectHomeDir, 'plugins');
    if (!existsSync(pluginsDir)) return [];
    try {
      if (!lstatSync(pluginsDir).isDirectory()) return [];
    } catch {
      return [];
    }
    const result: InstalledPluginWorkspacePaneContribution[] = [];
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !SAFE_ID.test(entry.name) ||
        !this.pluginIsAllowed(entry.name)
      ) {
        continue;
      }
      try {
        const { manifest } = readPluginManifestFile(
          this.projectHomeDir,
          entry.name,
        );
        for (const descriptor of manifest.workspacePanes ?? []) {
          const id = pluginPaneContributionId(entry.name, descriptor.id);
          const policy = this.policyFor(id);
          const override = this.readOverrides().items[id] ?? {};
          result.push({
            id,
            pluginName: entry.name,
            enabled: override.enabled ?? policy.enabled ?? true,
            descriptor,
            contribution: {
              id,
              version: manifest.version,
              sourceIdentity: {
                id: entry.name,
                kind: 'local',
                source: `plugins/${entry.name}`,
              },
              provenance: { origin: 'plugin', pluginId: entry.name },
            },
          });
        }
      } catch (error) {
        logInvalidPlugin(entry.name, error);
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  getLayout(id: string): LayoutCatalogItem | undefined {
    assertSafeCatalogId(id);
    return this.listLayouts().find((item) => item.id === id);
  }

  resolveForApply(id: string): ResolvedCatalogLayout {
    const resolved = this.resolveForCatalog(id);
    if (
      resolved.item.lifecycle.state !== 'installed' ||
      !resolved.item.enabled
    ) {
      throw new Error('Layout is not installed and enabled');
    }
    return resolved;
  }

  /**
   * Reads a known installed or disabled layout descriptor without authorizing
   * application, renderer loading, or plugin execution. Callers that mutate a
   * project must use `resolveForApply` instead.
   */
  resolveForCatalog(id: string): ResolvedCatalogLayout {
    const item = this.getLayout(id);
    if (
      !item ||
      (item.lifecycle.state !== 'installed' &&
        item.lifecycle.state !== 'disabled')
    ) {
      throw new Error('Layout is not a known installed contribution');
    }
    if (item.source === 'builtin') {
      return {
        item,
        definition: {
          name: item.name,
          slug: item.slug,
          icon: item.icon,
          description: item.description,
          type: item.type,
          tabs: [],
        },
      };
    }
    const plugin = this.readPluginLayout(item.plugin!);
    if (!plugin)
      throw new Error('Known plugin layout descriptor is unavailable');
    return {
      item,
      definition: plugin.definition,
      pluginName: plugin.pluginName,
    };
  }

  getPluginManifest(pluginName: string): PluginManifest | undefined {
    assertSafeId(pluginName, 'Plugin name');
    if (!this.pluginIsAllowed(pluginName)) return undefined;
    try {
      return readPluginManifestFile(this.projectHomeDir, pluginName).manifest;
    } catch (error) {
      logInvalidPlugin(pluginName, error);
      return undefined;
    }
  }

  setEnabled(id: string, enabled: boolean): LayoutCatalogItem {
    const item = this.getLayout(id);
    if (!item) throw new Error('Layout not found');
    this.writeOverride(id, { enabled });
    return this.getLayout(id)!;
  }

  /** Installing a built-in records an explicit user choice; no code executes. */
  installBuiltin(id: string): LayoutCatalogItem {
    const item = this.getLayout(id);
    if (item?.source !== 'builtin')
      throw new Error('Built-in layout not found');
    this.writeOverride(id, { installed: true, enabled: true });
    return this.getLayout(id)!;
  }

  /** Built-ins are removed from catalog use through an override, never deleted. */
  removeBuiltin(id: string): LayoutCatalogItem {
    const item = this.getLayout(id);
    if (item?.source !== 'builtin')
      throw new Error('Built-in layout not found');
    this.writeOverride(id, { installed: false, enabled: false });
    return this.getLayout(id)!;
  }

  private hasBuiltinSource(): boolean {
    return this.profile.registrySources.some(
      (source) => source.kind === 'builtin',
    );
  }

  private policyFor(id: string): DistributionItemPolicy {
    return this.profile.itemPolicies?.[id] ?? {};
  }

  private toBuiltinItem(layout: AvailableProjectLayout): LayoutCatalogItem {
    const id = `builtin:${layout.slug}`;
    const policy = this.policyFor(id);
    const override = this.readOverrides().items[id] ?? {};
    const installed = override.installed ?? policy.preinstalled ?? false;
    const enabled = installed && (override.enabled ?? policy.enabled ?? false);
    const state = !installed
      ? 'installable'
      : enabled
        ? 'installed'
        : 'disabled';
    return {
      ...layout,
      id,
      sourceIdentity: { id: 'builtin', kind: 'builtin' },
      contribution: {
        id,
        version: BUILTIN_LAYOUT_CONTRIBUTION_VERSION,
        sourceIdentity: { id: 'builtin', kind: 'builtin' },
        provenance: { origin: 'builtin' },
      },
      lifecycle: { itemId: id, state, source: 'builtin' },
      visible: policy.visible ?? true,
      installable: !installed,
      enabled,
      policy,
    };
  }

  private listInstalledPluginLayouts(): LayoutCatalogItem[] {
    if (
      !this.profile.registrySources.some((source) => source.kind === 'local')
    ) {
      return [];
    }
    const pluginsDir = join(this.projectHomeDir, 'plugins');
    if (!existsSync(pluginsDir)) return [];
    try {
      if (!lstatSync(pluginsDir).isDirectory()) return [];
    } catch {
      return [];
    }
    const result: LayoutCatalogItem[] = [];
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !SAFE_ID.test(entry.name) ||
        !this.pluginIsAllowed(entry.name)
      ) {
        continue;
      }
      const plugin = this.readPluginLayout(entry.name);
      if (plugin) result.push(plugin.item);
    }
    return result;
  }

  private pluginIsAllowed(pluginName: string): boolean {
    return this.profile.registrySources.some(
      (source) =>
        source.kind === 'local' &&
        (source.source === 'plugins' ||
          source.source === `plugins/${pluginName}`),
    );
  }

  private readPluginLayout(pluginName: string): PluginLayoutEntry | null {
    assertSafeId(pluginName, 'Plugin name');
    let parsed: ParsedPluginLayout;
    try {
      parsed = readPluginLayoutFiles(this.projectHomeDir, pluginName);
    } catch (error) {
      logInvalidPlugin(pluginName, error);
      return null;
    }
    return this.projectPluginLayout(pluginName, parsed);
  }

  private projectPluginLayout(
    pluginName: string,
    parsed: ParsedPluginLayout,
  ): PluginLayoutEntry {
    const { definition } = parsed;
    const id = `plugin:${pluginName}:${definition.slug}`;
    const policy = this.policyFor(id);
    const override = this.readOverrides().items[id] ?? {};
    const enabled = override.enabled ?? policy.enabled ?? true;
    const visible = policy.visible ?? true;
    const item: LayoutCatalogItem = {
      source: 'plugin',
      plugin: pluginName,
      name: definition.name,
      slug: definition.slug,
      icon: definition.icon,
      description: definition.description,
      type: definition.type,
      id,
      sourceIdentity: {
        id: pluginName,
        kind: 'local',
        source: `plugins/${pluginName}`,
      },
      contribution: {
        id,
        version: parsed.manifest.version,
        sourceIdentity: {
          id: pluginName,
          kind: 'local',
          source: `plugins/${pluginName}`,
        },
        provenance: { origin: 'plugin', pluginId: pluginName },
      },
      lifecycle: {
        itemId: id,
        state: enabled ? 'installed' : 'disabled',
        source: pluginName,
      },
      visible,
      installable: false,
      enabled,
      policy,
      tabCount: definition.tabs.length,
    };
    return { item, definition, pluginName };
  }

  private lifecyclePath(): string {
    return join(this.projectHomeDir, ...LIFECYCLE_FILE);
  }

  private readOverrides(): DistributionLifecycleOverrides {
    const path = this.lifecyclePath();
    if (!existsSync(path)) return { version: 1, items: {} };
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      if (
        !isPlainObject(data) ||
        data.version !== 1 ||
        !isPlainObject(data.items)
      ) {
        throw new Error('invalid');
      }
      for (const [id, value] of Object.entries(data.items)) {
        assertSafeCatalogId(id);
        if (!isPlainObject(value)) throw new Error('invalid');
        for (const [key, field] of Object.entries(value)) {
          if (
            (key !== 'installed' && key !== 'enabled') ||
            typeof field !== 'boolean'
          ) {
            throw new Error('invalid');
          }
        }
      }
      return data as unknown as DistributionLifecycleOverrides;
    } catch {
      throw new Error('Distribution lifecycle state is invalid');
    }
  }

  private writeOverride(
    id: string,
    patch: DistributionLifecycleOverride,
  ): void {
    assertSafeCatalogId(id);
    const state = this.readOverrides();
    const next: DistributionLifecycleOverrides = {
      version: 1,
      items: { ...state.items, [id]: { ...state.items[id], ...patch } },
    };
    const path = this.lifecyclePath();
    mkdirSync(join(this.projectHomeDir, 'config'), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf-8');
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
