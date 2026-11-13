import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RegistryCatalogSelection,
  RegistryItem,
  RegistrySource,
} from '@kontourai/station-contracts/catalog';
import { writeJsonDurably } from '@kontourai/station-shared/durable-json-file';
import {
  managedCapabilityDenial,
  managedPolicyRequiresSignedPackages,
  registryLocationAllowedByManagedPolicy,
} from '../../security/managed-capability-limits.js';
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
  getRegisteredPluginRegistryProviders,
  getSkillRegistryProviders,
  pluginProviderSourceGeneration,
} from './registry.js';
import { readRegistryCatalogInstalledState } from './registry-catalog-installed-state.js';
import {
  defaultRegistrySourceName,
  digest,
  legacyRegistrySourceKind,
  ManagedRegistryRefusal,
  normalizeRegistrySourceLocation,
  RegistryCatalogRefusal,
  RegistrySourceInputError,
  readRegistryCatalogSelection,
  readRegistrySourceConfiguration,
  registryCatalogId,
  registryItemSchema,
  retainRegistrySourceSnapshots,
  type SourceConfig,
  type StoredSource,
  type StoredSourceDetection,
  serializeRegistrySourceConfiguration,
  snapshotKey,
  sourceInput,
} from './registry-source-configuration.js';
import {
  detectRegistrySourceDocument,
  detectRegistrySourceTree,
  type RegistrySourceDetectionResult,
  RegistrySourceScanRefusal,
  readGitHubSourceTree,
  readLocalSourceTree,
  readSourceDocument,
} from './registry-source-detection.js';

export {
  ManagedRegistryRefusal,
  RegistryCatalogRefusal,
  RegistrySourceInputError,
  readRegistryCatalogSelection,
} from './registry-source-configuration.js';

type CatalogKind = RegistryCatalogSelection['kind'];
type Provider = ISkillRegistryProvider | IPluginRegistryProvider;
type Entry = {
  source: RegistrySource;
  provider: Provider;
  kind: CatalogKind;
  generation: number;
};
type Snapshot = { data: RegistryItem[]; revision: string; checkedAt: string };

/**
 * #4521: why the managed policy refuses a source, or undefined. Station's
 * bundled catalog ships with the install and is never refused. A location
 * outside `limits.registries.allowedUrls` is refused, and with
 * `unsignedPackages: false` so is every other skill catalog, because a skill
 * has no signature to verify.
 */
function managedRegistrySourceDenial(
  source: Pick<RegistrySource, 'kind' | 'origin' | 'location'>,
): string | undefined {
  const bundled = source.origin === 'station';
  if (!registryLocationAllowedByManagedPolicy(source.location, bundled))
    return managedCapabilityDenial('this marketplace');
  if (
    !bundled &&
    source.kind === 'skills' &&
    managedPolicyRequiresSignedPackages()
  )
    return managedCapabilityDenial(
      'skills from marketplaces, because they cannot be signed',
    );
  return undefined;
}

/** The entry as the managed policy leaves it: a refused source is disabled. */
function withManagedPolicy(entry: Entry): Entry {
  const managedDenial = managedRegistrySourceDenial(entry.source);
  return managedDenial === undefined
    ? entry
    : { ...entry, source: { ...entry.source, enabled: false, managedDenial } };
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
  // An agent entry of a source's Station manifest is a package installed
  // through the plugin pipeline, exactly like a plugin entry.
  if (selection.kind !== 'plugins' && selection.kind !== 'agents')
    throw new Error('The selected catalog item is not a plugin.');
  const owners = [...managers.values()].filter((manager) =>
    manager.hasSource(selection.sourceId, selection.kind),
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

/**
 * Whether a listed source supplies a catalog of `kind`: its primary kind, or
 * an installable kind its content was detected to provide.
 */
export function registrySourceSupplies(
  source: RegistrySource,
  kind: CatalogKind,
): boolean {
  return (
    source.kind === kind ||
    (source.detection?.kinds.some(
      (detected) => detected.kind === kind && detected.installable,
    ) ??
      false)
  );
}

/**
 * A name for a local skill folder that tells the default folders apart: the
 * engine whose folder it is, and whose (`· user` for one in the person's
 * home, `· Station app home` for an app home Station manages). Any
 * other folder is named by its parent folder.
 */
function localSkillFolderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const title = (word: string) =>
    word.charAt(0).toLocaleUpperCase() + word.slice(1);
  const appHome = parts.lastIndexOf('app-homes');
  if (appHome >= 0 && parts[appHome + 1])
    return `${title(parts[appHome + 1]!)} skills · Station app home`;
  const engine = parts.find(
    (part) => part.startsWith('.') && part !== '.agents',
  );
  if (engine) return `${title(engine.slice(1))} skills · user`;
  return `Local skills · ${parts.at(-2) ?? parts.at(-1) ?? path}`;
}

/**
 * A GitHub skill catalog's name: its repository, marked `(default)` when it
 * is one of Station's own default or configured catalogs rather than a
 * plugin's. The branch and folder stay visible in its location.
 */
function githubCatalogName(registryKey: string, isDefault: boolean): string {
  const [owner, repo] = registryKey.replace(/^github:/, '').split('/');
  const name = owner && repo ? `${owner}/${repo}` : registryKey;
  return isDefault ? `${name} (default)` : name;
}

/** Catalog kinds, in the order a source's primary kind is chosen. */
const CATALOG_KINDS: readonly CatalogKind[] = ['skills', 'plugins', 'agents'];

const SOURCE_UNREADABLE =
  'Source could not be read. Check its location and prerequisites, then refresh it.';

function snapshotKeyOf(entry: Entry): string {
  return entry.source.origin === 'user'
    ? snapshotKey(entry.source.id, entry.kind)
    : entry.source.id;
}

export class RegistrySourceManager {
  private readonly file: string;
  private config: SourceConfig;
  private readonly providers = new Map<
    string,
    { signature: string; provider: Provider }
  >();
  /** One manifest reader per source, shared by its plugin and agent catalogs. */
  private readonly manifests = new Map<
    string,
    { signature: string; provider: JsonManifestRegistryProvider }
  >();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly statuses = new Map<string, Partial<RegistrySource>>();
  private readonly detecting = new Map<
    string,
    Promise<StoredSourceDetection>
  >();

  constructor(private readonly home: string) {
    this.file = join(home, 'config', 'registry-sources.json');
    this.config = readRegistrySourceConfiguration(this.file);
    for (const [key, snapshot] of Object.entries(this.config.snapshots)) {
      this.snapshots.set(key, snapshot);
      this.statuses.set(key, {
        status: 'stale',
        lastSuccessfulAt: snapshot.checkedAt,
        itemCount: snapshot.data.length,
      });
    }
  }

  private persist(next: SourceConfig): void {
    const retained = retainRegistrySourceSnapshots(next);
    writeJsonDurably(this.file, serializeRegistrySourceConfiguration(retained));
    this.config = retained;
    const retainedIds = new Set(Object.keys(retained.snapshots));
    for (const id of this.snapshots.keys())
      if (!retainedIds.has(id)) this.snapshots.delete(id);
  }

  /**
   * Adds a person's source: a location and an optional ref. What it provides
   * is detected from its content before it is saved. The managed allow list
   * is checked first, before anything is read from the location.
   */
  async add(input: unknown): Promise<RegistrySource> {
    const parsed = sourceInput.safeParse(input);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      throw new RegistrySourceInputError(
        field === 'ref'
          ? 'Use a branch, tag or commit name of at most 200 characters.'
          : field === 'displayName'
            ? 'Use a name of at most 100 characters.'
            : 'Give a source location of at most 2000 characters and, for a repository, an optional ref.',
      );
    }
    const { location, transport } = normalizeRegistrySourceLocation(
      parsed.data.location,
      parsed.data.ref,
    );
    if (!registryLocationAllowedByManagedPolicy(location, false))
      throw new ManagedRegistryRefusal(
        managedCapabilityDenial('this marketplace'),
      );
    let adapter: StoredSource['adapter'];
    if (transport === 'local') {
      // A path that cannot be inspected now (an unmounted volume, a folder
      // not yet created) is still added and shows as unreadable. How to read
      // it falls back to an older client's `adapter`, else a folder; what it
      // provides is still detected once it can be read.
      let info: ReturnType<typeof statSync> | undefined;
      try {
        info = statSync(location);
      } catch {
        info = undefined;
      }
      adapter = info
        ? info.isDirectory()
          ? 'directory'
          : 'manifest'
        : parsed.data.adapter === 'manifest'
          ? 'manifest'
          : 'directory';
    } else adapter = transport;
    if (
      this.config.sources.some(
        (source) =>
          source.location === location && source.ref === parsed.data.ref,
      )
    )
      throw new RegistrySourceInputError('This source is already connected.');
    if (this.config.sources.length >= 32)
      throw new RegistrySourceInputError(
        'Source limit reached. Remove a source before adding another.',
      );
    const taken = new Set(
      this.list().map((source) => source.displayName.toLocaleLowerCase()),
    );
    let displayName = parsed.data.displayName;
    if (displayName !== undefined) {
      if (taken.has(displayName.toLocaleLowerCase()))
        throw new RegistrySourceInputError('Source name is already in use.');
    } else {
      const base = defaultRegistrySourceName(location).slice(0, 90);
      displayName = base;
      for (let n = 2; taken.has(displayName.toLocaleLowerCase()); n += 1)
        displayName = `${base} (${n})`;
    }
    const added: StoredSource = {
      displayName,
      adapter,
      location,
      ...(parsed.data.ref === undefined ? {} : { ref: parsed.data.ref }),
      id: randomUUID(),
      enabled: true,
    };
    const detection = await this.detect(added);
    // #4521: a source whose every installable kind the policy refuses (a
    // skill library while unsigned packages are refused) is refused whole,
    // as it was when a skill library was a type the person chose.
    const kinds = this.facetKinds(added, detection);
    const denials = kinds.map((kind) =>
      managedRegistrySourceDenial({ kind, origin: 'user', location }),
    );
    if (kinds.length > 0 && denials.every((denial) => denial !== undefined))
      throw new ManagedRegistryRefusal(denials[0]!);
    if (this.config.sources.length >= 32)
      throw new RegistrySourceInputError(
        'Source limit reached. Remove a source before adding another.',
      );
    this.persist({
      ...this.config,
      sources: [...this.config.sources, added],
      detections: { ...this.config.detections, [added.id]: detection },
    });
    return this.list().find((source) => source.id === added.id)!;
  }

  /**
   * Reads the source and records what its content provides. Never throws: a
   * bound refusal and an unreadable source are states the source shows.
   */
  private detect(source: StoredSource): Promise<StoredSourceDetection> {
    const pending = this.detecting.get(source.id);
    if (pending) return pending;
    const run = this.readDetection(source).finally(() =>
      this.detecting.delete(source.id),
    );
    this.detecting.set(source.id, run);
    return run;
  }

  private async readDetection(
    source: StoredSource,
  ): Promise<StoredSourceDetection> {
    const previous = this.config.detections[source.id];
    const checkedAt = new Date().toISOString();
    try {
      let result: RegistrySourceDetectionResult;
      if (source.adapter === 'github') {
        const [owner, repo] = new URL(source.location).pathname
          .split('/')
          .slice(1);
        result = await detectRegistrySourceTree(
          await readGitHubSourceTree(owner!, repo!, source.ref ?? 'HEAD'),
        );
        // A repository's manifest names its packages by paths inside the
        // repository, which Station acquires only from a local folder.
        result.kinds = result.kinds.map((kind) =>
          kind.via === 'station-manifest' &&
          (kind.kind === 'plugins' || kind.kind === 'agents')
            ? {
                ...kind,
                installable: false,
                note: 'Plugins and agents in a repository manifest are recognized. Add a local clone of the repository to install them.',
              }
            : kind,
        );
      } else if (source.adapter === 'directory') {
        result = await detectRegistrySourceTree(
          await readLocalSourceTree(source.location),
        );
      } else {
        result = detectRegistrySourceDocument(
          await readSourceDocument(source.location),
        );
      }
      const changedAt =
        previous?.revision !== undefined &&
        previous.revision !== result.revision
          ? checkedAt
          : previous?.changedAt;
      return {
        state: result.kinds.length > 0 ? 'detected' : 'nothing-recognized',
        kinds: result.kinds,
        revision: result.revision,
        checkedAt,
        ...(changedAt === undefined ? {} : { changedAt }),
        ...(result.indexes[0] === undefined
          ? {}
          : { index: result.indexes[0] }),
        ...(result.stationManifestPath === undefined
          ? {}
          : { stationManifestPath: result.stationManifestPath }),
        ...(result.skillRoots.length > 0
          ? { skillRoots: result.skillRoots }
          : {}),
      };
    } catch (error) {
      if (error instanceof RegistrySourceScanRefusal)
        return {
          state: 'refused',
          kinds: [],
          checkedAt,
          reason: error.message,
          ...(previous?.revision === undefined
            ? {}
            : { revision: previous.revision }),
        };
      // An unreadable source keeps what it was last seen to provide, so its
      // last catalogs stay available, marked stale.
      return {
        ...(previous ?? { kinds: [] }),
        state: 'unavailable',
        checkedAt,
        reason: SOURCE_UNREADABLE,
      };
    }
  }

  private storeDetection(id: string, detection: StoredSourceDetection): void {
    if (!this.config.sources.some((source) => source.id === id)) return;
    this.persist({
      ...this.config,
      detections: { ...this.config.detections, [id]: detection },
    });
  }

  /**
   * The catalogs a person's source supplies. Before its first detection (a
   * source saved by an earlier Station) it supplies the one kind its adapter
   * implied, so stored selections and installs keep resolving with no action
   * from the person; the next read replaces that with what was detected.
   */
  private facetKinds(
    source: StoredSource,
    detection = this.config.detections[source.id],
  ): CatalogKind[] {
    if (
      !detection ||
      (detection.state === 'unavailable' && detection.kinds.length === 0)
    )
      return [legacyRegistrySourceKind(source.adapter)];
    return CATALOG_KINDS.filter((kind) =>
      detection.kinds.some(
        (detected) => detected.kind === kind && detected.installable,
      ),
    );
  }

  setEnabled(id: string, enabled: boolean): RegistrySource {
    const source = this.list().find((source) => source.id === id);
    if (!source) throw new Error('Marketplace not found.');
    if (source.origin === 'plugin')
      throw new Error('Manage this marketplace through its owning plugin.');
    if (enabled && source.managedDenial !== undefined)
      throw new ManagedRegistryRefusal(source.managedDenial);
    this.persist({
      ...this.config,
      sources: this.config.sources.map((source) =>
        source.id === id ? { ...source, enabled } : source,
      ),
      disabled: enabled
        ? this.config.disabled.filter((disabled) => disabled !== id)
        : [...new Set([...this.config.disabled, id])],
    });
    for (const key of [...this.snapshots.keys()])
      if (key === id || key.startsWith(`${id}#`)) this.snapshots.delete(key);
    return this.list().find((source) => source.id === id)!;
  }

  remove(id: string): void {
    if (!this.config.sources.some((source) => source.id === id))
      throw new Error(
        'Only user-added marketplaces can be removed. Disable a configured source or manage its owning plugin.',
      );
    const owned = (key: string) => key === id || key.startsWith(`${id}#`);
    const snapshots = Object.fromEntries(
      Object.entries(this.config.snapshots).filter(([key]) => !owned(key)),
    );
    const detections = { ...this.config.detections };
    delete detections[id];
    this.persist({
      ...this.config,
      sources: this.config.sources.filter((source) => source.id !== id),
      disabled: this.config.disabled.filter((disabled) => disabled !== id),
      snapshots,
      detections,
    });
    for (const map of [
      this.providers,
      this.manifests,
      this.snapshots,
      this.statuses,
    ])
      for (const key of [...map.keys()]) if (owned(key)) map.delete(key);
  }

  /**
   * The provider behind one catalog of a person's source. A provider is
   * reused while its configuration is unchanged, so a detection that finds
   * the same layout does not change the catalog's authority mid-read.
   */
  private facetProvider(source: StoredSource, kind: CatalogKind): Provider {
    const detection = this.config.detections[source.id];
    const cached = (key: string, signature: string, build: () => Provider) => {
      const existing = this.providers.get(key);
      if (existing?.signature === signature) return existing.provider;
      const provider = build();
      this.providers.set(key, { signature, provider });
      return provider;
    };
    if (kind === 'skills') {
      if (source.adapter === 'github') {
        const [owner, repo] = new URL(source.location).pathname
          .split('/')
          .slice(1);
        return cached(
          snapshotKey(source.id, kind),
          `github|${source.location}|${source.ref ?? 'HEAD'}`,
          () =>
            new GitHubSkillRegistryProvider({
              owner,
              repo,
              path: '',
              branch: source.ref ?? 'HEAD',
            }),
        );
      }
      const roots = (detection?.skillRoots ?? ['']).map((root) =>
        root ? join(source.location, root) : source.location,
      );
      return cached(
        snapshotKey(source.id, kind),
        `directory|${JSON.stringify(roots)}`,
        () =>
          new FilesystemSkillRegistryProvider(roots, {
            refuseAmbiguousNames: true,
            confineTo: source.location,
          }),
      );
    }
    const manifestPath =
      source.adapter === 'directory'
        ? join(source.location, detection?.stationManifestPath ?? '')
        : source.location;
    const signature = `manifest|${manifestPath}`;
    let manifest = this.manifests.get(source.id);
    if (manifest?.signature !== signature) {
      manifest = {
        signature,
        provider: new JsonManifestRegistryProvider(
          manifestPath,
          this.home,
          undefined,
          undefined,
          source.adapter === 'directory' ? { root: source.location } : {},
        ),
      };
      this.manifests.set(source.id, manifest);
    }
    const reader = manifest.provider;
    if (kind === 'plugins') return reader;
    return cached(snapshotKey(source.id, kind), signature, () =>
      reader.agentCatalog(),
    );
  }

  private entries(): Entry[] {
    const entries: Entry[] = this.config.sources.flatMap((source) =>
      this.facetKinds(source).map((kind) => ({
        source: {
          ...source,
          kind,
          origin: 'user' as const,
          status: 'unknown' as const,
        },
        provider: this.facetProvider(source, kind),
        kind,
        generation: 0,
      })),
    );
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
                ? githubCatalogName(key, origin !== 'plugin')
                : provider instanceof FilesystemSkillRegistryProvider
                  ? localSkillFolderName(key)
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
    // Refused registries too: they are shown disabled, never read.
    for (const entry of getRegisteredPluginRegistryProviders())
      collect(entry.provider, entry.source, 'plugins');
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.source.id}#${entry.kind}`;
      if (seen.has(key))
        throw new Error('Marketplace provider source identity is ambiguous.');
      seen.add(key);
    }
    // #4521: every reader (catalog, refresh, resolve, install) sees a
    // refused source as disabled, so it cannot supply anything.
    return entries.map(withManagedPolicy);
  }

  hasSource(id: string, kind: RegistryCatalogSelection['kind']): boolean {
    return this.entries().some(
      (entry) => entry.source.id === id && entry.kind === kind,
    );
  }

  list(): RegistrySource[] {
    const entries = this.entries();
    const listed: RegistrySource[] = entries
      .filter((entry) => entry.source.origin !== 'user')
      .map(({ source }) => ({
        ...source,
        ...this.statuses.get(source.id),
        ...(!source.enabled ? { status: 'disabled' as const } : {}),
      }));
    for (const source of this.config.sources)
      listed.push(
        this.userSourceRow(
          source,
          entries.filter((entry) => entry.source.id === source.id),
        ),
      );
    return listed;
  }

  /**
   * One row per person's source, however many catalogs it supplies. The row
   * is refused by the policy when its location is, or when every catalog it
   * supplies is; a refused kind beside allowed ones is marked on that kind.
   */
  private userSourceRow(source: StoredSource, facets: Entry[]): RegistrySource {
    const stored = this.config.detections[source.id];
    const locationDenial = registryLocationAllowedByManagedPolicy(
      source.location,
      false,
    )
      ? undefined
      : managedCapabilityDenial('this marketplace');
    const allDenied =
      facets.length > 0 &&
      facets.every((facet) => facet.source.managedDenial !== undefined);
    const managedDenial =
      locationDenial ??
      (allDenied ? facets[0]!.source.managedDenial : undefined);
    const enabled = source.enabled && managedDenial === undefined;
    const facetStatuses = facets.map((facet) =>
      this.statuses.get(snapshotKeyOf(facet)),
    );
    const latest = (field: 'checkedAt' | 'lastSuccessfulAt') =>
      facetStatuses
        .map((status) => status?.[field])
        .filter((value): value is string => value !== undefined)
        .sort()
        .at(-1);
    const unread =
      stored?.state === 'refused' || stored?.state === 'unavailable';
    const states = facetStatuses.map((status) => status?.status ?? 'unknown');
    const status: RegistrySource['status'] = !enabled
      ? 'disabled'
      : unread
        ? facetStatuses.some((s) => s?.lastSuccessfulAt)
          ? 'stale'
          : 'error'
        : states.includes('error')
          ? 'error'
          : states.includes('stale')
            ? 'stale'
            : states.length > 0 && states.every((state) => state === 'ready')
              ? 'ready'
              : stored?.state === 'nothing-recognized'
                ? 'ready'
                : 'unknown';
    const itemCounts = facetStatuses
      .map((status) => status?.itemCount)
      .filter((count): count is number => count !== undefined);
    const error =
      (unread ? stored?.reason : undefined) ??
      facetStatuses.find((status) => status?.error)?.error;
    const checkedAt = latest('checkedAt') ?? stored?.checkedAt;
    const lastSuccessfulAt = latest('lastSuccessfulAt');
    return {
      kind: facets[0]?.kind ?? legacyRegistrySourceKind(source.adapter),
      id: source.id,
      displayName: source.displayName,
      origin: 'user',
      location: source.location,
      ...(source.ref === undefined ? {} : { ref: source.ref }),
      adapter: source.adapter,
      enabled,
      status,
      ...(checkedAt ? { checkedAt } : {}),
      ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}),
      ...(itemCounts.length > 0
        ? { itemCount: itemCounts.reduce((sum, count) => sum + count, 0) }
        : {}),
      ...(error ? { error } : {}),
      ...(managedDenial === undefined ? {} : { managedDenial }),
      ...(stored
        ? {
            detection: {
              state: stored.state,
              kinds: stored.kinds.map((kind) => {
                const denial = facets.find((facet) => facet.kind === kind.kind)
                  ?.source.managedDenial;
                return denial === undefined
                  ? kind
                  : { ...kind, managedDenial: denial };
              }),
              ...(stored.revision === undefined
                ? {}
                : { revision: stored.revision }),
              checkedAt: stored.checkedAt,
              ...(stored.changedAt === undefined
                ? {}
                : { changedAt: stored.changedAt }),
              ...(stored.index === undefined ? {} : { index: stored.index }),
              ...(stored.reason === undefined ? {} : { reason: stored.reason }),
            },
          }
        : {}),
    };
  }

  private isCurrent(entry: Entry): boolean {
    return this.entries().some(
      (candidate) =>
        candidate.source.id === entry.source.id &&
        candidate.kind === entry.kind &&
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
    // Plugins and a manifest's agents share the plugin catalog contract.
    const snapshotProvider =
      entry.kind !== 'skills'
        ? (provider as IPluginRegistryProvider)
        : undefined;
    const catalogSnapshot = await snapshotProvider?.getCatalogSnapshot?.();
    if (!catalogSnapshot && (fresh || entry.kind !== 'skills'))
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
    const key = snapshotKeyOf(entry);
    this.snapshots.set(key, snapshot);
    this.persist({
      ...this.config,
      snapshots: { ...this.config.snapshots, [key]: snapshot },
    });
    this.statuses.set(key, {
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
    await this.detectMissing();
    const installedState =
      kind === 'plugins' || kind === 'agents'
        ? readRegistryCatalogInstalledState(this.home, kind)
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
            if (!installedState) return data;
            return installedState(
              data,
              entry.source.id,
              entry.provider.registryKey,
            );
          } catch {
            if (!this.isCurrent(entry) || !visible(entry.source)) return [];
            const key = snapshotKeyOf(entry);
            const cached = this.snapshots.get(key);
            this.statuses.set(key, {
              ...this.statuses.get(key),
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

  /**
   * Detects every enabled source of a person's that has never been detected:
   * one saved by an earlier Station. Its stored kind keeps serving until the
   * detection is recorded, so nothing the person installed stops resolving.
   */
  private async detectMissing(): Promise<void> {
    await Promise.all(
      this.config.sources
        .filter(
          (source) =>
            source.enabled &&
            this.config.detections[source.id] === undefined &&
            registryLocationAllowedByManagedPolicy(source.location, false),
        )
        .map(async (source) => {
          const detection = await this.detect(source);
          if (this.config.detections[source.id] === undefined)
            this.storeDetection(source.id, detection);
        }),
    );
  }

  async refresh(id: string): Promise<RegistrySource> {
    const row = this.list().find((source) => source.id === id);
    if (!row) throw new Error('Marketplace not found.');
    if (row.managedDenial !== undefined)
      throw new ManagedRegistryRefusal(row.managedDenial);
    if (!row.enabled)
      throw new Error('Enable this marketplace before refreshing it.');
    const stored = this.config.sources.find((source) => source.id === id);
    // A person's source is read again first: what it provides, and at which
    // revision, comes from the source as it is now.
    if (stored) this.storeDetection(id, await this.detect(stored));
    for (const entry of this.entries().filter(
      (entry) =>
        entry.source.id === id &&
        entry.source.enabled &&
        entry.source.managedDenial === undefined,
    )) {
      const key = snapshotKeyOf(entry);
      try {
        await this.observe(entry, true);
      } catch {
        this.statuses.set(key, {
          ...this.statuses.get(key),
          status: this.snapshots.has(key) ? 'stale' : 'error',
          checkedAt: new Date().toISOString(),
          error:
            'Marketplace refresh failed. Check its location and prerequisites.',
        });
      }
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
    if (entry?.source.managedDenial !== undefined)
      throw new ManagedRegistryRefusal(entry.source.managedDenial);
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
      (candidate) =>
        candidate.source.id === entry.source.id &&
        candidate.kind === entry.kind,
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
