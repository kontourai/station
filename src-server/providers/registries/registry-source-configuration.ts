import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { RegistryCatalogSelection } from '@kontourai/station-contracts/catalog';
import { MANAGED_POLICY_CAPABILITY_DISABLED_CODE } from '@kontourai/station-contracts/managed-policy';
import { readBoundedRegularFileSync } from '@kontourai/station-shared/regular-file';
import { z } from 'zod';

/**
 * How Station reads a source's location. It is derived from the location and
 * never decides what the source provides; detection does that. Stored so a
 * Station that predates detection can still read the file.
 */
const transport = z.enum(['manifest', 'directory', 'github']);
const ref = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/,
    'Use a branch, tag or commit name.',
  );

/**
 * What a person gives to add a source: a location and an optional ref. An
 * `adapter` from an older client is accepted and ignored.
 */
export const sourceInput = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    location: z.string().trim().min(1).max(2000),
    ref: ref.optional(),
    adapter: transport.optional(),
  })
  .strict();
const storedSource = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    adapter: transport,
    location: z.string().trim().min(1).max(2000),
    ref: ref.optional(),
    id: z.string().uuid(),
    enabled: z.boolean(),
  })
  .strict();
const registryCatalogKind = z.enum(['skills', 'plugins', 'agents']);
const selectionSchema = z
  .object({
    sourceId: z.string().min(1).max(100),
    itemId: z.string().min(1).max(200),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    kind: registryCatalogKind,
  })
  .strict();

export const registryItemSchema = z.object({
  providesTools: z.boolean().optional(),
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
  catalogFreshness: z.enum(['live', 'stale']).optional(),
  packageRevision: z.string().max(200).optional(),
});
const snapshotSchema = z.object({
  data: z.array(registryItemSchema).max(512),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.string().datetime(),
});
const detectedKindSchema = z
  .object({
    kind: z.enum(['skills', 'plugins', 'agents', 'integrations']),
    count: z.number().int().min(0).max(100_000),
    via: z.string().min(1).max(100),
    installable: z.boolean(),
    note: z.string().max(500).optional(),
  })
  .strict();
const detectionSchema = z
  .object({
    state: z.enum(['detected', 'nothing-recognized', 'refused', 'unavailable']),
    kinds: z.array(detectedKindSchema).max(16),
    revision: z.string().max(200).optional(),
    checkedAt: z.string().datetime(),
    changedAt: z.string().datetime().optional(),
    index: z.string().max(300).optional(),
    reason: z.string().max(500).optional(),
    stationManifestPath: z.string().max(300).optional(),
    skillRoots: z.array(z.string().max(2000)).max(512).optional(),
  })
  .strict();
export type StoredSourceDetection = z.infer<typeof detectionSchema>;
const configuration = z.object({
  version: z.literal(1),
  sources: z.array(storedSource).max(32),
  /**
   * Offline catalogs, keyed `<sourceId>` for a source with one catalog and
   * `<sourceId>#<kind>` for a person's source (see {@link snapshotKey}).
   * At most 32 are retained, so a Station that predates detection can still
   * read the file.
   */
  snapshots: z
    .record(z.string(), snapshotSchema)
    .refine((snapshots) => Object.keys(snapshots).length <= 32)
    .default({}),
  disabled: z.array(z.string()).max(128),
  /**
   * Offline catalogs whose rows carry a catalog kind a Station that predates
   * detection does not know (`agents`). That Station validates every
   * `snapshots` entry against its own kinds and would refuse the whole file,
   * but it drops an unknown top-level key, so these live here: it ignores
   * them and keeps every source, ref check included. Merged into `snapshots`
   * on read; see {@link serializeRegistrySourceConfiguration}.
   */
  kindSnapshots: z
    .record(z.string(), snapshotSchema)
    .refine((snapshots) => Object.keys(snapshots).length <= 32)
    .default({}),
  detections: z
    .record(z.string().uuid(), detectionSchema)
    .refine((detections) => Object.keys(detections).length <= 32)
    .default({}),
});

export type SourceConfig = z.infer<typeof configuration>;
export type StoredSource = SourceConfig['sources'][number];
export type RegistrySourceTransport = z.infer<typeof transport>;

/**
 * The snapshot key of one catalog of a person's source. A source added
 * before detection kept its single catalog under its bare id; that key is
 * read as the kind its adapter used to imply (see
 * {@link migrateRegistrySourceConfiguration}).
 */
export function snapshotKey(
  sourceId: string,
  kind: RegistryCatalogSelection['kind'],
): string {
  return `${sourceId}#${kind}`;
}

/** The one kind a source added before detection provided, from its adapter. */
export function legacyRegistrySourceKind(
  adapter: RegistrySourceTransport,
): RegistryCatalogSelection['kind'] {
  return adapter === 'manifest' ? 'plugins' : 'skills';
}

/**
 * Moves a pre-detection file's bare-id snapshots to their per-kind keys. No
 * source, selection or installed record changes: a source keeps its id, and
 * its old catalog stays the catalog of the kind it always provided.
 */
function migrateRegistrySourceConfiguration(
  config: SourceConfig,
): SourceConfig {
  const users = new Map(config.sources.map((source) => [source.id, source]));
  const snapshots: SourceConfig['snapshots'] = {};
  for (const [key, snapshot] of Object.entries(config.snapshots)) {
    const source = users.get(key);
    snapshots[
      source ? snapshotKey(key, legacyRegistrySourceKind(source.adapter)) : key
    ] = snapshot;
  }
  return {
    ...config,
    snapshots: { ...snapshots, ...config.kindSnapshots },
    kindSnapshots: {},
  };
}

/** Catalog kinds a Station that predates detection reads in `snapshots`. */
const ORIGINAL_SNAPSHOT_KINDS: ReadonlySet<string> = new Set([
  'skills',
  'plugins',
]);

/**
 * The file's bytes for a configuration: snapshots whose rows name a newer
 * catalog kind are written under `kindSnapshots`, so an earlier Station can
 * still read the file (it ignores that key). Every other field is written as
 * held.
 */
export function serializeRegistrySourceConfiguration(
  config: SourceConfig,
): SourceConfig {
  const snapshots: SourceConfig['snapshots'] = {};
  const kindSnapshots: SourceConfig['kindSnapshots'] = {};
  for (const [key, snapshot] of Object.entries(config.snapshots)) {
    const newer = snapshot.data.some(
      (item) =>
        item.catalog !== undefined &&
        !ORIGINAL_SNAPSHOT_KINDS.has(item.catalog.kind),
    );
    (newer ? kindSnapshots : snapshots)[key] = snapshot;
  }
  return { ...config, snapshots, kindSnapshots };
}
export function digest(value: unknown): string {
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
      | 'item-unavailable'
      | 'source-forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'RegistryCatalogRefusal';
  }
}

/**
 * #4521: the managed policy's `limits.registries` refuses the source. A
 * `source-forbidden` refusal, so every existing handler answers 403, whose
 * message is the managed denial sentence clients show.
 */
export class ManagedRegistryRefusal extends RegistryCatalogRefusal {
  readonly managedCode = MANAGED_POLICY_CAPABILITY_DISABLED_CODE;

  /**
   * The outward sentence, built only by `managedCapabilityDenial` from the
   * policy's organization and support link; routes serialize this field, not
   * an arbitrary error message.
   */
  constructor(readonly denial: string) {
    super('source-forbidden', denial);
    this.name = 'ManagedRegistryRefusal';
  }
}

const CONFIGURATION_MAX_BYTES = 8 * 1024 * 1024;

export function readRegistrySourceConfiguration(file: string): SourceConfig {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return {
        version: 1,
        sources: [],
        disabled: [],
        snapshots: {},
        kindSnapshots: {},
        detections: {},
      };
    throw new Error(
      'Registry source configuration is unavailable. Restore its existing file before continuing.',
    );
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > CONFIGURATION_MAX_BYTES
  )
    throw new Error(
      'Registry source configuration must be a bounded regular file. Its existing bytes are preserved.',
    );
  const raw = readBoundedRegularFileSync(file, CONFIGURATION_MAX_BYTES);
  if (raw === null)
    throw new Error(
      'Registry source configuration could not be read safely. Its existing bytes are preserved.',
    );
  try {
    const parsed = configuration.parse(JSON.parse(raw));
    if (
      new Set(parsed.sources.map((source) => source.id)).size !==
      parsed.sources.length
    )
      throw new Error('Duplicate identity');
    for (const source of parsed.sources) {
      const normalized = normalizeRegistrySourceLocation(
        source.location,
        source.ref,
      );
      if (
        normalized.location !== source.location ||
        (normalized.transport === 'github') !== (source.adapter === 'github')
      )
        throw new Error('Inconsistent location');
    }
    return migrateRegistrySourceConfiguration(parsed);
  } catch {
    throw new Error(
      'Registry source configuration is invalid or unsupported. Restore its existing file; it has not been reset.',
    );
  }
}

export function retainRegistrySourceSnapshots(
  config: SourceConfig,
): SourceConfig {
  if (config.disabled.length > 128)
    throw new Error(
      'Disabled marketplace limit reached. Re-enable a source before disabling another.',
    );
  const retained: SourceConfig = { ...config, snapshots: {} };
  const snapshots = Object.entries(config.snapshots).sort(([, a], [, b]) =>
    b.checkedAt.localeCompare(a.checkedAt),
  );
  for (const [id, snapshot] of snapshots) {
    if (Object.keys(retained.snapshots).length === 32) break;
    retained.snapshots[id] = snapshot;
    if (
      Buffer.byteLength(`${JSON.stringify(retained, null, 2)}\n`) >
      CONFIGURATION_MAX_BYTES
    )
      delete retained.snapshots[id];
  }
  return retained;
}

/**
 * A location or ref a person gave that Station cannot use. `reason` is the
 * outward sentence: always one of the fixed sentences written here, never
 * text from a source or a lower layer, so routes serialize it rather than an
 * arbitrary error message.
 */
export class RegistrySourceInputError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RegistrySourceInputError';
  }
}

/**
 * The canonical spelling of a source location and how Station reads it. Pure:
 * a local path is not checked for existence here.
 *
 * - `https://github.com/<owner>/<repo>` is a repository read through GitHub;
 *   `ref` selects a branch, tag or commit.
 * - An absolute path is a local folder or file.
 * - Any other `https` URL is one document.
 */
export function normalizeRegistrySourceLocation(
  location: string,
  sourceRef?: string,
): { location: string; transport: RegistrySourceTransport | 'local' } {
  if (isAbsolute(location)) {
    if (sourceRef !== undefined)
      throw new RegistrySourceInputError(
        'A ref applies only to a GitHub repository.',
      );
    return { location: resolve(location), transport: 'local' };
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new RegistrySourceInputError(
      'Use a public https:// address or an absolute path on this Station.',
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new RegistrySourceInputError(
      'Use a public https:// address. Credential-bearing and plain http addresses are not supported.',
    );
  if (url.search || url.hash)
    throw new RegistrySourceInputError(
      'Remove the query or fragment from the address.',
    );
  if (url.hostname === 'github.com') {
    const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
    if (
      parts.length !== 2 ||
      parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
    )
      throw new RegistrySourceInputError(
        'Use a repository address, https://github.com/<owner>/<repository>, and put a branch or tag in Ref.',
      );
    return {
      location: `https://github.com/${parts.join('/')}`,
      transport: 'github',
    };
  }
  if (sourceRef !== undefined)
    throw new RegistrySourceInputError(
      'A ref applies only to a GitHub repository.',
    );
  return { location: url.href, transport: 'manifest' };
}

/** A label for a source the person did not name. */
export function defaultRegistrySourceName(location: string): string {
  if (isAbsolute(location)) return basename(location) || location;
  const url = new URL(location);
  if (url.hostname === 'github.com') return url.pathname.slice(1);
  return url.hostname;
}
