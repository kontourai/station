import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_EXTERNAL_CONTENT_TRUST,
  type IntegrationTrustReviewDecision,
  type IntegrationTrustReviewField,
  isSafeToolServerId,
  personOwnedUntrustedContentFields,
  type ToolDef,
  type UntrustedContentChange,
  type UntrustedContentPermissions,
} from '@kontourai/station-contracts/tool';
import { fsyncDirectorySync } from './fs-windows-compat.js';
import { stationCuratedContentTrust } from './station-curation.js';

type Field = 'contentTrust' | 'permissions' | 'trustReadOnlyHints';
type Entry = { present: false } | { present: true; value: unknown };
type Overlay = {
  version: 1;
  id: string;
  fields: Partial<Record<Field, Entry>>;
  changes: UntrustedContentChange[];
};
const FIELDS: readonly Field[] = [
  'contentTrust',
  'permissions',
  'trustReadOnlyHints',
];
const key = (field: Field) =>
  field === 'permissions' ? 'untrustedContentPermissions' : field;
function pathFor(home: string, id: string): string {
  if (!isSafeToolServerId(id)) throw new Error('Invalid integration id');
  return join(
    home,
    'config',
    'integration-trust',
    `${createHash('sha256').update(id).digest('hex')}.json`,
  );
}

/** Caller holds the integration mutation lock for any write or migration. */
export function readIntegrationTrustOverlay(
  home: string,
  id: string,
): Overlay | undefined {
  const path = pathFor(home, id);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024)
      throw new Error('Invalid trust overlay file');
    const value = JSON.parse(readFileSync(path, 'utf8')) as Overlay;
    if (
      value?.version !== 1 ||
      value.id !== id ||
      !value.fields ||
      typeof value.fields !== 'object' ||
      Array.isArray(value.fields) ||
      !Array.isArray(value.changes) ||
      value.changes.length > 50 ||
      value.changes.some(
        (change) =>
          !change ||
          typeof change !== 'object' ||
          typeof change.at !== 'string' ||
          (change.by !== undefined && typeof change.by !== 'string') ||
          (change.source !== undefined &&
            change.source !== 'local-cli-operator'),
      ) ||
      Object.keys(value.fields).some(
        (field) => !FIELDS.includes(field as Field),
      )
    )
      throw new Error('Invalid trust overlay');
    for (const field of FIELDS) {
      if (!Object.hasOwn(value.fields, field)) continue;
      const entry = value.fields[field];
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.present !== 'boolean' ||
        (entry.present && !Object.hasOwn(entry, 'value'))
      )
        throw new Error('Invalid trust overlay field');
      if (
        entry.present &&
        field === 'contentTrust' &&
        entry.value !== 'trusted' &&
        entry.value !== 'untrusted'
      )
        throw new Error('Invalid trust classification');
      if (
        entry.present &&
        field === 'trustReadOnlyHints' &&
        typeof entry.value !== 'boolean'
      )
        throw new Error('Invalid trust hints');
      if (entry.present && field === 'permissions') {
        const p = entry.value as {
          default?: unknown;
          tools?: Record<string, unknown>;
        };
        if (
          !p ||
          typeof p !== 'object' ||
          Array.isArray(p) ||
          (p.default !== undefined &&
            (typeof p.default !== 'string' ||
              !['ask', 'allow', 'deny'].includes(p.default))) ||
          (p.tools !== undefined &&
            (!p.tools ||
              typeof p.tools !== 'object' ||
              Array.isArray(p.tools) ||
              Object.values(p.tools).some(
                (v) =>
                  typeof v !== 'string' ||
                  !['ask', 'allow', 'deny'].includes(v),
              )))
        )
          throw new Error('Invalid trust permissions');
      }
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function atomicWrite(path: string, value: unknown): void {
  const directory = join(path, '..');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.overlay-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    fsyncDirectorySync(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function writeOverlay(home: string, id: string, overlay: Overlay): void {
  atomicWrite(pathFor(home, id), overlay);
}

function overlayFrom(id: string, value: ToolDef): Overlay {
  const fields: Overlay['fields'] = {};
  for (const field of personOwnedUntrustedContentFields(value)) {
    const name = key(field);
    fields[field] = Object.hasOwn(value, name)
      ? { present: true, value: value[name] }
      : { present: false };
  }
  return {
    version: 1,
    id,
    fields,
    changes: value.untrustedContentChanges ?? [],
  };
}

/**
 * #3483: legacy person-owned fields that would widen what runs. Their
 * ownership cannot be authenticated, so they wait for a person.
 */
function grantExpandingFields(overlay: Overlay): Field[] {
  const expanding: Field[] = [];
  const trust = overlay.fields.contentTrust;
  if (trust?.present && trust.value === 'trusted')
    expanding.push('contentTrust');
  const permissions = overlay.fields.permissions;
  const policy = permissions?.present
    ? (permissions.value as {
        default?: string;
        tools?: Record<string, string>;
      })
    : undefined;
  if (
    policy?.default === 'allow' ||
    Object.values(policy?.tools ?? {}).includes('allow')
  )
    expanding.push('permissions');
  const hints = overlay.fields.trustReadOnlyHints;
  if (hints?.present && hints.value === true)
    expanding.push('trustReadOnlyHints');
  return expanding;
}

/** Thrown in place of migrating legacy grant-expanding trust settings. */
export class LegacyTrustReviewRequiredError extends Error {
  readonly code = 'trust_review_required';
  constructor(
    readonly integrationId: string,
    readonly fields: IntegrationTrustReviewField[],
  ) {
    super(
      `Legacy trust settings for '${integrationId}' require person review before migration: their ownership cannot be verified`,
    );
    this.name = 'LegacyTrustReviewRequiredError';
  }
}

function reviewFields(overlay: Overlay, fields: Field[]) {
  return fields.map((field) => {
    const entry = overlay.fields[field];
    return { field, value: entry?.present ? entry.value : undefined };
  });
}

/**
 * The fields of a stored definition waiting for a person, or `undefined`
 * when it has none. Caller holds the integration mutation lock.
 */
export function integrationTrustReview(
  home: string,
  id: string,
  stored: ToolDef,
): IntegrationTrustReviewField[] | undefined {
  if (readIntegrationTrustOverlay(home, id)) return undefined;
  const overlay = overlayFrom(id, stored);
  const expanding = grantExpandingFields(overlay);
  return expanding.length ? reviewFields(overlay, expanding) : undefined;
}

/**
 * A person keeps the legacy settings (they become person-owned) or resets
 * them to Station's defaults. Either way a receipt names the person, and
 * the definition then migrates normally. Caller holds the integration
 * mutation lock and has authenticated `by`.
 */
export function resolveIntegrationTrustReview(
  home: string,
  id: string,
  stored: ToolDef,
  decision: IntegrationTrustReviewDecision,
  by: string,
  now = new Date(),
): void {
  if (readIntegrationTrustOverlay(home, id))
    throw new Error(`Integration '${id}' has no trust settings to review`);
  const overlay = overlayFrom(id, stored);
  const expanding = grantExpandingFields(overlay);
  if (expanding.length === 0)
    throw new Error(`Integration '${id}' has no trust settings to review`);
  if (decision === 'reset')
    for (const field of expanding) delete overlay.fields[field];
  const value = (field: Field) => {
    const entry = overlay.fields[field];
    return entry?.present ? entry.value : undefined;
  };
  const receipt: UntrustedContentChange = {
    at: now.toISOString(),
    by,
    ...(expanding.includes('contentTrust')
      ? {
          contentTrust: (value('contentTrust') ??
            stationCuratedContentTrust(stored) ??
            DEFAULT_EXTERNAL_CONTENT_TRUST) as 'trusted' | 'untrusted',
        }
      : {}),
    ...(expanding.includes('permissions')
      ? {
          permissions: (value('permissions') ??
            {}) as UntrustedContentPermissions,
        }
      : {}),
    ...(expanding.includes('trustReadOnlyHints')
      ? { trustReadOnlyHints: value('trustReadOnlyHints') === true }
      : {}),
  };
  // A kept field becomes person-owned by this receipt; a reset field is
  // recorded as owned and absent, so Station's default applies.
  if (decision === 'reset')
    for (const field of expanding) overlay.fields[field] = { present: false };
  overlay.changes = [...overlay.changes, receipt].slice(-50);
  writeOverlay(home, id, overlay);
  migrateIntegrationTrustOverlay(home, id, stored);
}

/** Publish the overlay before removing legacy person fields from a definition. */
export function migrateIntegrationTrustOverlay(
  home: string,
  id: string,
  stored?: ToolDef,
): Overlay | undefined {
  const existing = readIntegrationTrustOverlay(home, id);
  if (!stored) return existing;
  const migrated = existing ?? overlayFrom(id, stored);
  if (!existing) {
    const expanding = grantExpandingFields(migrated);
    if (expanding.length)
      throw new LegacyTrustReviewRequiredError(
        id,
        reviewFields(migrated, expanding),
      );
  }
  if (
    !existing &&
    (Object.keys(migrated.fields).length || migrated.changes.length)
  )
    writeOverlay(home, id, migrated);
  if (
    Object.hasOwn(stored, 'untrustedContentPermissions') ||
    Object.hasOwn(stored, 'trustReadOnlyHints') ||
    Object.hasOwn(stored, 'untrustedContentChanges') ||
    Object.hasOwn(stored, 'untrustedContentPersonOwned')
  ) {
    const cleaned = { ...stored };
    delete cleaned.untrustedContentPermissions;
    delete cleaned.trustReadOnlyHints;
    delete cleaned.untrustedContentChanges;
    delete cleaned.untrustedContentPersonOwned;
    if (migrated.fields.contentTrust)
      cleaned.contentTrust = DEFAULT_EXTERNAL_CONTENT_TRUST;
    atomicWrite(join(home, 'integrations', id, 'integration.json'), cleaned);
  }
  return existing ||
    Object.keys(migrated.fields).length ||
    migrated.changes.length
    ? migrated
    : undefined;
}

export function writeIntegrationTrustOverlay(
  home: string,
  id: string,
  effective: ToolDef,
): void {
  writeOverlay(home, id, overlayFrom(id, effective));
}

export function applyIntegrationTrustOverlay(
  def: ToolDef,
  overlay?: Overlay,
): ToolDef {
  if (!overlay) return def;
  const result = { ...def };
  delete result.untrustedContentPermissions;
  delete result.trustReadOnlyHints;
  delete result.untrustedContentChanges;
  delete result.untrustedContentPersonOwned;
  for (const field of FIELDS) {
    const entry = overlay.fields[field];
    if (!entry) continue;
    const name = key(field);
    delete result[name];
    if (entry.present) Object.assign(result, { [name]: entry.value });
    else if (field === 'contentTrust') {
      const curated = stationCuratedContentTrust(def);
      if (curated) result.contentTrust = curated;
    }
  }
  const owned = FIELDS.filter((field) => overlay.fields[field]);
  if (owned.length) result.untrustedContentPersonOwned = owned;
  if (overlay.changes.length) result.untrustedContentChanges = overlay.changes;
  return result;
}

export function deleteIntegrationTrustOverlay(home: string, id: string): void {
  rmSync(pathFor(home, id), { force: true });
}
