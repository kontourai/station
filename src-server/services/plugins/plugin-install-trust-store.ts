/**
 * Persisted install trust records (#2998, slice d1 part 2).
 *
 * One record per installed plugin in `plugin-trust.json`, beside
 * `plugin-grants.json`, through the same fail-closed store: a corrupt or
 * unreadable file is never read as "no records", `.previous` is never
 * consumed automatically, and every write runs under the cross-process lock.
 *
 * A record states what the installer decided, not what the runtime enforces.
 * Renderer selection does not read the tier until slice d2.
 *
 * Migration: the first start after d1 writes a grandfathered record for every
 * plugin already installed, at tier 2 (today every plugin may render
 * in-process) and with its current digest, then sets the `$migration` marker.
 * After the marker exists, a plugin with no record is `unrecorded`: it was
 * placed by hand or by a pre-d1 process, and it is never grandfathered later.
 */
import { join } from 'node:path';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import { isRecord } from '../../utils/is-record.js';
import type { Logger } from '../../utils/logger.js';
import {
  GrantsFileStore,
  GrantsStoreUnavailableError,
} from './grants-file-store.js';
import type {
  PluginProvenance,
  PluginSigner,
  PluginTrustDecision,
  PluginTrustTier,
} from './plugin-install-trust.js';

const MIGRATION_KEY = '$migration';
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_FIELD = 512;

export type PluginTrustRecordDecision =
  | PluginTrustDecision['kind']
  /** Installed before d1; kept at the tier it ran at, pending the operator. */
  | 'grandfathered';

export interface PluginTrustRecord {
  version: 1;
  signer: PluginSigner | null;
  provenance: PluginProvenance;
  /**
   * Installed content digest the decision was made against. `null` only on a
   * grandfathered record whose bytes could not be read at migration.
   */
  contentDigest: string | null;
  tier: PluginTrustTier;
  decision: PluginTrustRecordDecision;
  /** Present on a `new-decision`: why the earlier decision did not carry over. */
  reason?: Extract<PluginTrustDecision, { kind: 'new-decision' }>['reason'];
  /** The tier recorded before a `new-decision` replaced it. */
  priorTier?: PluginTrustTier;
  decidedBy: 'station' | 'operator';
  decidedAt: string;
}

interface MigrationMarker {
  version: 1;
  completedAt: string;
}

type TrustFile = Record<string, PluginTrustRecord | MigrationMarker>;

export class PluginTrustRecordsUnavailableError extends GrantsStoreUnavailableError {
  constructor(
    storePath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(storePath, detail, options);
    this.name = 'PluginTrustRecordsUnavailableError';
  }
}

function boundedString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD
  );
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function signerProblem(value: unknown): boolean {
  if (value === null) return false;
  if (!isRecord(value)) return true;
  if (value.kind === 'sigstore')
    return !(
      exactKeys(value, [
        'kind',
        'issuer',
        'identity',
        'repositoryId',
        'ownerId',
      ]) &&
      boundedString(value.issuer) &&
      boundedString(value.identity) &&
      boundedString(value.repositoryId) &&
      boundedString(value.ownerId)
    );
  if (value.kind === 'ed25519')
    return !(
      exactKeys(value, ['kind', 'keyId', 'keyFingerprint']) &&
      boundedString(value.keyId) &&
      boundedString(value.keyFingerprint)
    );
  return true;
}

const DECISIONS = new Set([
  'initial',
  'unchanged',
  'inherited',
  'new-decision',
  'grandfathered',
]);
const REASONS = new Set([
  'signer-changed',
  'unsigned-content-changed',
  'tier-exceeds-provenance',
]);

function recordProblem(value: unknown): boolean {
  if (!isRecord(value)) return true;
  return !(
    exactKeys(
      value,
      [
        'version',
        'signer',
        'provenance',
        'contentDigest',
        'tier',
        'decision',
        'decidedBy',
        'decidedAt',
      ],
      ['reason', 'priorTier'],
    ) &&
    value.version === 1 &&
    !signerProblem(value.signer) &&
    ['kontour', 'publisher', 'unsigned'].includes(value.provenance as string) &&
    (value.contentDigest === null
      ? value.decision === 'grandfathered'
      : typeof value.contentDigest === 'string' &&
        SHA256_DIGEST.test(value.contentDigest)) &&
    (value.tier === 2 || value.tier === 3) &&
    DECISIONS.has(value.decision as string) &&
    (value.decision === 'new-decision'
      ? REASONS.has(value.reason as string)
      : value.reason === undefined) &&
    (value.priorTier === undefined ||
      value.priorTier === 2 ||
      value.priorTier === 3) &&
    (value.decidedBy === 'station' || value.decidedBy === 'operator') &&
    typeof value.decidedAt === 'string' &&
    ISO_INSTANT.test(value.decidedAt)
  );
}

function trustFileShapeProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['must be a plain object keyed by plugin name'];
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === MIGRATION_KEY) {
      if (
        !isRecord(entry) ||
        !exactKeys(entry, ['version', 'completedAt']) ||
        entry.version !== 1 ||
        typeof entry.completedAt !== 'string' ||
        !ISO_INSTANT.test(entry.completedAt)
      )
        problems.push(`${MIGRATION_KEY}: malformed migration marker`);
      continue;
    }
    if (!isCanonicalPluginId(key)) {
      problems.push('a record key is not a canonical plugin id');
      continue;
    }
    if (recordProblem(entry)) problems.push(`${key}: malformed trust record`);
  }
  return problems;
}

export function pluginTrustRecordsPath(projectHomeDir: string): string {
  return join(projectHomeDir, 'plugin-trust.json');
}

function trustStore(projectHomeDir: string): GrantsFileStore<TrustFile> {
  return new GrantsFileStore<TrustFile>({
    filePath: pluginTrustRecordsPath(projectHomeDir),
    storeLabel: 'plugin-trust',
    shapeProblems: trustFileShapeProblems,
    makeUnavailableError: (storePath, detail, cause) =>
      new PluginTrustRecordsUnavailableError(storePath, detail, { cause }),
    emptyValue: {},
  });
}

export type PluginTrustRecordState =
  | { state: 'recorded'; record: PluginTrustRecord }
  /** The migration has run and this plugin has no record. */
  | { state: 'unrecorded' }
  /** No record and the migration has not run yet. */
  | { state: 'pending-migration' };

/** Throws {@link PluginTrustRecordsUnavailableError}; never reads as empty. */
export function readPluginTrustRecord(
  projectHomeDir: string,
  pluginName: string,
): PluginTrustRecordState {
  const file = trustStore(projectHomeDir).read();
  const entry = Object.hasOwn(file, pluginName) ? file[pluginName] : undefined;
  if (entry && pluginName !== MIGRATION_KEY)
    return {
      state: 'recorded',
      record: structuredClone(entry) as PluginTrustRecord,
    };
  return Object.hasOwn(file, MIGRATION_KEY)
    ? { state: 'unrecorded' }
    : { state: 'pending-migration' };
}

/** Writes (or, with `null`, removes) one plugin's record. */
export async function writePluginTrustRecord(
  projectHomeDir: string,
  pluginName: string,
  record: PluginTrustRecord | null,
): Promise<void> {
  if (!isCanonicalPluginId(pluginName))
    throw new Error('Trust records are keyed by canonical plugin id');
  if (record !== null && recordProblem(record))
    throw new Error('Refusing to write a malformed trust record');
  await trustStore(projectHomeDir).mutate(pluginName, (current) => {
    if (record === null) delete current[pluginName];
    else current[pluginName] = structuredClone(record);
    return current;
  });
}

export interface GrandfatheredInstallation {
  pluginName: string;
  /** `null` when the installed bytes could not be read. */
  contentDigest: string | null;
  signer: PluginSigner | null;
}

/**
 * One-time migration. Adds a grandfathered tier-2 record for every listed
 * installation that has none, keeps every existing record, and sets the
 * marker in the same write. Idempotent: after the marker, it changes nothing.
 */
export async function migrateGrandfatheredPluginTrust(options: {
  projectHomeDir: string;
  installations: () => Promise<readonly GrandfatheredInstallation[]>;
  now: () => Date;
  logger?: Logger;
}): Promise<
  { state: 'migrated'; grandfathered: string[] } | { state: 'already-migrated' }
> {
  const store = trustStore(options.projectHomeDir);
  if (Object.hasOwn(store.read(), MIGRATION_KEY))
    return { state: 'already-migrated' };
  const installations = await options.installations();
  const decidedAt = options.now().toISOString();
  const grandfathered: string[] = [];
  await store.mutate(MIGRATION_KEY, (current) => {
    grandfathered.length = 0;
    if (Object.hasOwn(current, MIGRATION_KEY)) return current;
    for (const installation of installations) {
      if (
        !isCanonicalPluginId(installation.pluginName) ||
        Object.hasOwn(current, installation.pluginName)
      )
        continue;
      current[installation.pluginName] = {
        version: 1,
        signer: installation.signer,
        provenance: installation.signer === null ? 'unsigned' : 'publisher',
        contentDigest: installation.contentDigest,
        tier: 2,
        decision: 'grandfathered',
        decidedBy: 'station',
        decidedAt,
      };
      grandfathered.push(installation.pluginName);
    }
    current[MIGRATION_KEY] = { version: 1, completedAt: decidedAt };
    return current;
  });
  options.logger?.info(
    'Grandfathered install trust records for plugins installed before d1',
    {
      count: grandfathered.length,
    },
  );
  return { state: 'migrated', grandfathered };
}
