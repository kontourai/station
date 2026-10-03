import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RegistryCatalogSelection,
  RegistryItem,
  RegistrySource,
} from '@kontourai/station-contracts/catalog';
import { writeJsonDurably } from '@kontourai/station-shared/durable-json-file';
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
import { readRegistryCatalogInstalledState } from './registry-catalog-installed-state.js';
import {
  digest,
  RegistryCatalogRefusal,
  readRegistryCatalogSelection,
  readRegistrySourceConfiguration,
  registryCatalogId,
  registryItemSchema,
  retainRegistrySourceSnapshots,
  type SourceConfig,
  sourceInput,
  validateRegistrySourceLocation,
} from './registry-source-configuration.js';

export {
  RegistryCatalogRefusal,
  readRegistryCatalogSelection,
} from './registry-source-configuration.js';

type Provider = ISkillRegistryProvider | IPluginRegistryProvider;
type Entry = {
  source: RegistrySource;
  provider: Provider;
  kind: RegistryCatalogSelection['kind'];
  generation: number;
};
type Snapshot = { data: RegistryItem[]; revision: string; checkedAt: string };

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
    this.config = readRegistrySourceConfiguration(this.file);
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
    const retained = retainRegistrySourceSnapshots(next);
    writeJsonDurably(this.file, retained);
    this.config = retained;
    const retainedIds = new Set(Object.keys(retained.snapshots));
    for (const id of this.snapshots.keys())
      if (!retainedIds.has(id)) this.snapshots.delete(id);
  }

  add(input: unknown): RegistrySource {
    const parsed = sourceInput.parse(input);
    const location = validateRegistrySourceLocation(parsed);
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

  private isCurrent(entry: Entry): boolean {
    return this.entries().some(
      (candidate) =>
        candidate.source.id === entry.source.id &&
        candidate.source.enabled &&
        candidate.generation === entry.generation &&
        candidate.provider === entry.provider,
    );
  }

  private async observe(entry: Entry, fresh = false): Promise<Snapshot> {
    const provider = entry.provider;
    if (
      entry.source.origin === 'user' &&
      entry.source.adapter === 'directory' &&
      !existsSync(entry.source.location!)
    )
      throw new Error('Local marketplace directory is unavailable.');
    const snapshotProvider =
      entry.kind === 'plugins'
        ? (provider as IPluginRegistryProvider)
        : undefined;
    const catalogSnapshot = await snapshotProvider?.getCatalogSnapshot?.();
    if (!catalogSnapshot && (fresh || entry.kind === 'plugins'))
      await provider.refresh?.();
    const listed = (
      catalogSnapshot?.items ?? (await provider.listAvailable())
    ).map((item) => registryItemSchema.parse({ ...item, installed: false }));
    const catalogRevision =
      catalogSnapshot?.revision ??
      (await snapshotProvider?.getCatalogRevision?.());
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
      const snapshotPackage = catalogSnapshot?.packages.find(
        (candidate) => candidate.id === item.id,
      );
      const resolved = catalogSnapshot
        ? snapshotPackage
          ? {
              source: snapshotPackage.source,
              ...(snapshotPackage.claim === undefined
                ? {}
                : { claim: snapshotPackage.claim }),
            }
          : undefined
        : await snapshotProvider?.resolvePackage?.(item.id);
      return {
        ...item,
        packageRevision: resolved ? digest(resolved) : undefined,
      };
    });
    if (
      !catalogSnapshot &&
      catalogRevision &&
      (await snapshotProvider?.getCatalogRevision?.()) !== catalogRevision
    )
      throw new RegistryCatalogRefusal(
        'source-changed',
        'Marketplace changed during catalog observation. Refresh it again.',
      );
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
          catalogFreshness: 'live' as const,
        };
      }),
      revision,
      checkedAt,
    };
    if (!this.isCurrent(entry))
      throw new RegistryCatalogRefusal(
        'source-authority-changed',
        'Selected marketplace authority changed. Inspect it again.',
      );
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
    visible: (source: RegistrySource) => boolean = () => true,
  ): Promise<RegistryItem[]> {
    const installedState =
      kind === 'plugins'
        ? readRegistryCatalogInstalledState(this.home)
        : undefined;
    const results = await Promise.all(
      this.entries()
        .filter(
          (entry) =>
            entry.kind === kind &&
            entry.source.enabled &&
            visible(entry.source),
        )
        .map(async (entry) => {
          try {
            const data = (await this.observe(entry)).data;
            if (!this.isCurrent(entry) || !visible(entry.source)) return [];
            if (entry.kind !== 'plugins') return data;
            return installedState!(
              data,
              entry.source.id,
              entry.provider.registryKey,
            );
          } catch {
            if (!this.isCurrent(entry) || !visible(entry.source)) return [];
            const cached = this.snapshots.get(entry.source.id);
            this.statuses.set(entry.source.id, {
              ...this.statuses.get(entry.source.id),
              status: cached ? 'stale' : 'error',
              checkedAt: new Date().toISOString(),
              error:
                'Marketplace unavailable. Refresh the source or check its location and prerequisites.',
            });
            const data =
              cached?.data.map((item) => ({
                ...item,
                catalogFreshness: 'stale' as const,
              })) ?? [];
            return installedState
              ? installedState(
                  data,
                  entry.source.id,
                  entry.provider.registryKey,
                )
              : data;
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
    const current = this.list().find((source) => source.id === id);
    if (!current?.enabled)
      throw new RegistryCatalogRefusal(
        'source-unavailable',
        'Selected marketplace is no longer available.',
      );
    return current;
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
