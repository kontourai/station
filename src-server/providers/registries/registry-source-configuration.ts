import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { RegistryCatalogSelection } from '@kontourai/station-contracts/catalog';
import { readBoundedRegularFileSync } from '@kontourai/station-shared/regular-file';
import { z } from 'zod';

export const sourceInput = z
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

export const registryItemSchema = z.object({
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
const configuration = z.object({
  version: z.literal(1),
  sources: z
    .array(sourceInput.extend({ id: z.string().uuid(), enabled: z.boolean() }))
    .max(32),
  snapshots: z
    .record(z.string(), snapshotSchema)
    .refine((snapshots) => Object.keys(snapshots).length <= 32)
    .default({}),
  disabled: z.array(z.string()).max(128),
});

export type SourceConfig = z.infer<typeof configuration>;
type SourceInput = z.infer<typeof sourceInput>;
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
      return { version: 1, sources: [], disabled: [], snapshots: {} };
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
    for (const source of parsed.sources) validateRegistrySourceLocation(source);
    return parsed;
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

export function validateRegistrySourceLocation(input: SourceInput): string {
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
      throw new Error('Use a public https://github.com/owner/repository URL.');
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
