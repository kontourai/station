import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  RegistryCatalogSelection,
  RegistryItem,
  RegistrySource,
} from '@kontourai/station-contracts/catalog';
import { writeJsonDurably } from '@kontourai/station-shared/durable-json-file';
import { z } from 'zod';
import { scanInstalledPluginInventory } from '../../services/plugins/installed-plugin-inventory.js';
import { mapWithConcurrency } from '../../utils/bounded-async.js';
import type {
  IPluginRegistryProvider,
  ISkillRegistryProvider,
} from '../provider-interfaces.js';
import { FilesystemSkillRegistryProvider } from './filesystem-skill-registry.js';
import { GitHubSkillRegistryProvider } from './github-skill-registry.js';
import { JsonManifestRegistryProvider } from './json-manifest-registry.js';
import { MultiSourceSkillRegistryProvider } from './multi-source-skill-registry.js';
import {
  getPluginRegistryProviders,
  getSkillRegistryProviders,
  pluginProviderSourceGeneration,
} from './registry.js';
import { readRegistryInstallAliases } from './registry-install-aliases.js';

const sourceInput = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    adapter: z.enum(['manifest', 'directory', 'github']),
    location: z.string().trim().min(1).max(2000),
  })
  .strict();
const selectionSchema = z
  .object({
    sourceId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(200),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['skills', 'plugins']),
  })
  .strict();

const registryItemSchema = z.object({
  id: z.string().min(1).max(1500),
  displayName: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  version: z.string().max(200).optional(),
  source: z.string().max(2000).optional(),
  status: z.string().max(200).optional(),
  installed: z.boolean(),
  installedPluginName: z.string().max(200).optional(),
  tags: z.array(z.string().max(100)).max(32).optional(),
  catalog: selectionSchema.optional(),
  catalogSourceName: z.string().max(100).optional(),
  packageRevision: z.string().max(200).optional(),
});
const snapshotSchema = z.object({
  data: z.array(registryItemSchema).max(512),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.string().datetime(),
});
const configuration = z.object({
  version: z.literal(1),
  sources: z
    .array(sourceInput.extend({ id: z.string().uuid(), enabled: z.boolean() }))
    .max(32),
  snapshots: z.record(z.string(), snapshotSchema).default({}),
  disabled: z.array(z.string()).max(128),
});

type SourceConfig = z.infer<typeof configuration>;
type SourceInput = z.infer<typeof sourceInput>;
type Provider = ISkillRegistryProvider | IPluginRegistryProvider;
type Entry = {
  source: RegistrySource;
  provider: Provider;
  kind: RegistryCatalogSelection['kind'];
  generation: number;
};
type Snapshot = { data: RegistryItem[]; revision: string; checkedAt: string };

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function registryCatalogId(selection: RegistryCatalogSelection): string {
  return `catalog.${Buffer.from(JSON.stringify(selection)).toString('base64url')}`;
}

export function readRegistryCatalogSelection(
  id: string,
): RegistryCatalogSelection | null {
  if (!id.startsWith('catalog.')) return null;
  if (id.length > 1500) throw new Error('Invalid catalog selection.');
  try {
    return selectionSchema.parse(
      JSON.parse(Buffer.from(id.slice(8), 'base64url').toString('utf8')),
    );
  } catch {
    throw new Error('Invalid catalog selection.');
  }
}

export class RegistryCatalogRefusal extends Error {
  constructor(
    readonly code:
      | 'source-unavailable'
      | 'source-changed'
      | 'source-authority-changed'
      | 'item-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'RegistryCatalogRefusal';
  }
}

const managers = new Map<string, RegistrySourceManager>();
export function registrySourceManager(home: string): RegistrySourceManager {
  let manager = managers.get(home);
  if (!manager) {
    manager = new RegistrySourceManager(home);
    managers.set(home, manager);
  }
  return manager;
}

export async function resolveSelectedPluginCatalog(id: string): Promise<{
  provider: IPluginRegistryProvider;
  itemId: string;
  packageRevision?: string;
} | null> {
  const selection = readRegistryCatalogSelection(id);
  if (!selection) return null;
  if (selection.kind !== 'plugins')
    throw new Error('The selected catalog item is not a plugin.');
  const owners = [...managers.values()].filter((manager) =>
    manager.hasSource(selection.sourceId, 'plugins'),
  );
  if (owners.length !== 1)
    throw new RegistryCatalogRefusal(
      'source-unavailable',
      'Selected marketplace is no longer available.',
    );
  const resolved = await owners[0]!.resolve(id);
  return {
    provider: resolved.entry.provider as IPluginRegistryProvider,
    itemId: selection.itemId,
    packageRevision: resolved.item.packageRevision,
  };
}

export class RegistrySourceManager {
  private readonly file: string;
  private config: SourceConfig;
  private readonly providers = new Map<string, Provider>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly statuses = new Map<string, Partial<RegistrySource>>();

  constructor(private readonly home: string) {
    this.file = join(home, 'config', 'registry-sources.json');
    this.config = existsSync(this.file)
      ? configuration.parse(JSON.parse(readFileSync(this.file, 'utf8')))
      : { version: 1, sources: [], disabled: [], snapshots: {} };
    for (const [id, snapshot] of Object.entries(this.config.snapshots)) {
      this.snapshots.set(id, snapshot);
      this.statuses.set(id, {
        status: 'stale',
        lastSuccessfulAt: snapshot.checkedAt,
        itemCount: snapshot.data.length,
      });
    }
  }

  private persist(next: SourceConfig): void {
    writeJsonDurably(this.file, next);
    this.config = next;
  }

  add(input: unknown): RegistrySource {
    const parsed = sourceInput.parse(input);
    const location = this.validateLocation(parsed);
    if (
      this.list().some(
        (source) =>
          source.displayName.toLocaleLowerCase() ===
          parsed.displayName.toLocaleLowerCase(),
      )
    )
      throw new Error('Marketplace name is already in use.');
    if (
      this.config.sources.some(
        (source) =>
          source.adapter === parsed.adapter && source.location === location,
      )
    )
      throw new Error('This marketplace is already connected.');
    const added = { ...parsed, location, id: randomUUID(), enabled: true };
    if (this.config.sources.length >= 32)
      throw new Error(
        'Marketplace limit reached. Remove a source before adding another.',
      );
    this.persist({ ...this.config, sources: [...this.config.sources, added] });
    return this.list().find((source) => source.id === added.id)!;
  }

  private validateLocation(input: SourceInput): string {
    if (input.adapter === 'github') {
      const url = new URL(input.location);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'github.com' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          'Use a public https://github.com/owner/repository URL.',
        );
      const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
      if (
        parts.length !== 2 ||
        parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
      )
        throw new Error(
          'Use a repository URL; branch and directory selection are declared by its adapter.',
        );
      return `https://github.com/${parts.join('/')}`;
    }
    if (isAbsolute(input.location)) return resolve(input.location);
    if (input.adapter === 'manifest') {
      const url = new URL(input.location);
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        return url.href;
    }
    throw new Error(
      'Use an absolute local path or a public HTTPS manifest URL. Credential-bearing URLs are not supported.',
    );
  }

  setEnabled(id: string, enabled: boolean): RegistrySource {
    const source = this.list().find((source) => source.id === id);
    if (!source) throw new Error('Marketplace not found.');
    if (source.origin === 'plugin')
      throw new Error('Manage this marketplace through its owning plugin.');
    this.persist({
      ...this.config,
      sources: this.config.sources.map((source) =>
        source.id === id ? { ...source, enabled } : source,
      ),
      disabled: enabled
        ? this.config.disabled.filter((disabled) => disabled !== id)
        : [...new Set([...this.config.disabled, id])],
    });
    this.snapshots.delete(id);
    return this.list().find((source) => source.id === id)!;
  }

  remove(id: string): void {
    if (!this.config.sources.some((source) => source.id === id))
      throw new Error(
        'Only user-added marketplaces can be removed. Disable a configured source or manage its owning plugin.',
      );
    this.persist({
      ...this.config,
      sources: this.config.sources.filter((source) => source.id !== id),
      disabled: this.config.disabled.filter((disabled) => disabled !== id),
    });
    const snapshots = { ...this.config.snapshots };
    delete snapshots[id];
    this.persist({ ...this.config, snapshots });
    this.providers.delete(id);
    this.snapshots.delete(id);
    this.statuses.delete(id);
  }

  private managedProvider(source: SourceConfig['sources'][number]): Provider {
    let provider = this.providers.get(source.id);
    if (provider) return provider;
    if (source.adapter === 'directory')
      provider = new FilesystemSkillRegistryProvider([source.location]);
    else if (source.adapter === 'manifest')
      provider = new JsonManifestRegistryProvider(source.location, this.home);
    else {
      const parts = new URL(source.location).pathname.split('/').slice(1);
      provider = new GitHubSkillRegistryProvider({
        owner: parts[0],
        repo: parts[1],
        path: '',
        branch: 'HEAD',
      });
    }
    this.providers.set(source.id, provider);
    return provider;
  }

  private entries(): Entry[] {
    const entries: Entry[] = this.config.sources.map((source) => ({
      source: {
        ...source,
        kind: source.adapter === 'manifest' ? 'plugins' : 'skills',
        origin: 'user',
        status: 'unknown',
      },
      provider: this.managedProvider(source),
      kind: source.adapter === 'manifest' ? 'plugins' : 'skills',
      generation: 0,
    }));
    const collect = (
      provider: Provider,
      label: string,
      kind: RegistryCatalogSelection['kind'],
    ) => {
      if (
        provider instanceof MultiSourceSkillRegistryProvider ||
        (provider instanceof FilesystemSkillRegistryProvider &&
          provider.catalogProviders().length > 1)
      ) {
        for (const child of provider.catalogProviders())
          collect(child, label, kind);
        return;
      }
      const key = provider.registryKey ?? label;
      const id = `provider-${digest([this.home, kind, label, key]).slice(0, 24)}`;
      const origin =
        label === 'Bundled examples'
          ? 'station'
          : label === 'unknown' ||
              label === 'Configured registry' ||
              label === 'Core'
            ? 'configured'
            : 'plugin';
      entries.push({
        source: {
          kind,
          id,
          displayName:
            origin === 'station'
              ? 'Station'
              : provider instanceof GitHubSkillRegistryProvider
                ? key.replace(/^github:/, '')
                : provider instanceof FilesystemSkillRegistryProvider
                  ? 'Local skills'
                  : label,
          origin,
          owner: origin === 'plugin' ? label : undefined,
          location: key,
          adapter:
            provider instanceof GitHubSkillRegistryProvider
              ? 'github'
              : provider instanceof FilesystemSkillRegistryProvider
                ? 'directory'
                : provider instanceof JsonManifestRegistryProvider
                  ? 'manifest'
                  : 'provider',
          enabled: !this.config.disabled.includes(id),
          status: 'unknown',
        },
        provider,
        kind,
        generation: pluginProviderSourceGeneration(label),
      });
    };
    for (const entry of getSkillRegistryProviders())
      collect(entry.provider, entry.source, 'skills');
    for (const entry of getPluginRegistryProviders())
      collect(entry.provider, entry.source, 'plugins');
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.source.id))
        throw new Error('Marketplace provider source identity is ambiguous.');
      seen.add(entry.source.id);
    }
    return entries;
  }

  hasSource(id: string, kind: RegistryCatalogSelection['kind']): boolean {
    return this.entries().some(
      (entry) => entry.source.id === id && entry.kind === kind,
    );
  }

  list(): RegistrySource[] {
    return this.entries().map(({ source }) => ({
      ...source,
      ...this.statuses.get(source.id),
      ...(!source.enabled ? { status: 'disabled' as const } : {}),
    }));
  }

  private async observe(entry: Entry, fresh = false): Promise<Snapshot> {
    const provider = entry.provider;
    if (
      entry.source.origin === 'user' &&
      entry.source.adapter === 'directory' &&
      !existsSync(entry.source.location!)
    )
      throw new Error('Local marketplace directory is unavailable.');
    if (fresh && 'refresh' in provider) await provider.refresh?.();
    const listed = (await provider.listAvailable()).map((item) =>
      registryItemSchema.parse({ ...item, installed: false }),
    );
    const catalogRevision =
      entry.kind === 'plugins'
        ? await (provider as IPluginRegistryProvider).getCatalogRevision?.()
        : undefined;
    if (listed.length > 512)
      throw new Error('Marketplace catalog exceeds the item limit.');
    const names = new Set<string>();
    const observed = await mapWithConcurrency(listed, 4, async (item) => {
      if (names.has(item.id))
        throw new Error('Marketplace item identity is ambiguous.');
      names.add(item.id);
      if (entry.kind === 'skills') {
        const skillProvider = provider as ISkillRegistryProvider;
        return {
          ...item,
          packageRevision:
            (await skillProvider.getPackageRevision?.(item.id)) ?? undefined,
        };
      }
      const resolved = await (
        provider as IPluginRegistryProvider
      ).resolvePackage?.(item.id);
      return {
        ...item,
        packageRevision: resolved ? digest(resolved) : undefined,
      };
    });
    const revision = digest([
      entry.source.id,
      entry.generation,
      catalogRevision,
      observed,
    ]);
    const checkedAt = new Date().toISOString();
    const snapshot = {
      data: observed.map((item) => {
        const catalog = {
          sourceId: entry.source.id,
          itemId: item.id,
          revision,
          kind: entry.kind,
        };
        return {
          ...item,
          id: registryCatalogId(catalog),
          catalog,
          catalogSourceName: entry.source.displayName,
        };
      }),
      revision,
      checkedAt,
    };
    this.snapshots.set(entry.source.id, snapshot);
    this.persist({
      ...this.config,
      snapshots: { ...this.config.snapshots, [entry.source.id]: snapshot },
    });
    this.statuses.set(entry.source.id, {
      status: 'ready',
      checkedAt,
      lastSuccessfulAt: checkedAt,
      itemCount: snapshot.data.length,
      error: undefined,
    });
    return snapshot;
  }

  async catalog(
    kind: RegistryCatalogSelection['kind'],
  ): Promise<RegistryItem[]> {
    const results = await Promise.all(
      this.entries()
        .filter((entry) => entry.kind === kind && entry.source.enabled)
        .map(async (entry) => {
          try {
            const data = (await this.observe(entry)).data;
            if (entry.kind !== 'plugins') return data;
            const installed = new Set(
              scanInstalledPluginInventory(join(this.home, 'plugins')).flatMap(
                (item) => (item.state === 'valid' ? [item.manifest.name] : []),
              ),
            );
            const aliases = readRegistryInstallAliases(this.home);
            const legacyInstalled = new Map(
              (await entry.provider.listInstalled()).map((item) => [
                item.id,
                item,
              ]),
            );
            return data.map((item) => {
              const alias = Object.entries(aliases).find(([id, alias]) => {
                const selected = readRegistryCatalogSelection(id);
                return (
                  selected?.sourceId === entry.source.id &&
                  selected.itemId === item.catalog?.itemId &&
                  alias.registryKey === entry.provider.registryKey &&
                  installed.has(alias.pluginName)
                );
              })?.[1];
              const legacy = legacyInstalled.get(item.catalog!.itemId);
              return {
                ...item,
                installed: !!alias || !!legacy,
                ...(alias
                  ? { installedPluginName: alias.pluginName }
                  : legacy?.installedPluginName
                    ? { installedPluginName: legacy.installedPluginName }
                    : {}),
              };
            });
          } catch {
            const cached = this.snapshots.get(entry.source.id);
            this.statuses.set(entry.source.id, {
              ...this.statuses.get(entry.source.id),
              status: cached ? 'stale' : 'error',
              checkedAt: new Date().toISOString(),
              error:
                'Marketplace unavailable. Refresh the source or check its location and prerequisites.',
            });
            return cached?.data ?? [];
          }
        }),
    );
    return results.flat();
  }

  async refresh(id: string): Promise<RegistrySource> {
    const entry = this.entries().find((entry) => entry.source.id === id);
    if (!entry) throw new Error('Marketplace not found.');
    if (!entry.source.enabled)
      throw new Error('Enable this marketplace before refreshing it.');
    try {
      await this.observe(entry, true);
    } catch {
      this.statuses.set(id, {
        ...this.statuses.get(id),
        status: this.snapshots.has(id) ? 'stale' : 'error',
        checkedAt: new Date().toISOString(),
        error:
          'Marketplace refresh failed. Check its location and prerequisites.',
      });
    }
    return this.list().find((source) => source.id === id)!;
  }

  async resolve(id: string): Promise<{
    entry: Entry;
    item: RegistryItem;
    selection: RegistryCatalogSelection;
  }> {
    const selection = readRegistryCatalogSelection(id);
    if (!selection)
      throw new Error('Choose an item from a connected marketplace.');
    const entry = this.entries().find(
      (entry) =>
        entry.source.id === selection.sourceId && entry.kind === selection.kind,
    );
    if (!entry?.source.enabled)
      throw new RegistryCatalogRefusal(
        'source-unavailable',
        'Selected marketplace is no longer available.',
      );
    let snapshot: Snapshot;
    try {
      snapshot = await this.observe(entry, true);
    } catch {
      throw new RegistryCatalogRefusal(
        'source-unavailable',
        'Selected marketplace is unavailable. Refresh it before trying again.',
      );
    }
    const current = this.entries().find(
      (candidate) => candidate.source.id === entry.source.id,
    );
    if (
      !current?.source.enabled ||
      current.generation !== entry.generation ||
      current.provider !== entry.provider
    )
      throw new RegistryCatalogRefusal(
        'source-authority-changed',
        'Selected marketplace authority changed. Inspect it again.',
      );
    if (snapshot.revision !== selection.revision)
      throw new RegistryCatalogRefusal(
        'source-changed',
        'Marketplace changed since this selection. Inspect the item again.',
      );
    const item = snapshot.data.find(
      (item) => item.catalog?.itemId === selection.itemId,
    );
    if (!item)
      throw new RegistryCatalogRefusal(
        'item-unavailable',
        'Selected marketplace item is no longer available.',
      );
    return { entry, item, selection };
  }
}
