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
 * Migration: the first start after d1 freezes the set of plugins installed
 * before it, then writes a grandfathered record for each one, at tier 2
 * (today every plugin may render in-process) and with its current digest.
 * A plugin that cannot be read now stays pending and is retried on a later
 * start; one whose bytes disagree with their own authority is never
 * grandfathered. Where the migration stands is kept in the installation
 * journal as well as in the file's `$migration` marker, so deleting or
 * editing `plugin-trust.json` after the migration began makes the records
 * unavailable rather than re-grandfathering anything.
 *
 * A record also stops describing an installation when the installed bytes
 * change outside the installer (a dependency rebuilt in place, a raw
 * registry copy): {@link pluginTrustForInstalledBytes} reports it `stale`.
 */
import { join } from 'node:path';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import { isRecord } from '../../utils/is-record.js';
import type { Logger } from '../../utils/logger.js';
import {
  GrantsFileStore,
  GrantsStoreUnavailableError,
} from './grants-file-store.js';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
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
  /** Installed content digest the decision was made against. */
  contentDigest: string;
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
  startedAt: string;
  /** Pre-d1 plugins still to be decided; empty once the migration is done. */
  pending: string[];
}

/** The journal's view of the migration; see `PackageMcpAdmissionJournal`. */
export interface PluginTrustMigrationWitness {
  installTrustMigration(): ReturnType<
    NonNullable<PackageMcpAdmissionJournal['installTrustMigration']>
  >;
  recordInstallTrustMigration(
    next: { state: 'started'; pending: string[] } | { state: 'completed' },
  ): { state: 'applied' | 'unavailable' };
}

/** The production witness is the installation journal. */
export function pluginTrustMigrationWitness(
  journal: PackageMcpAdmissionJournal | undefined,
): PluginTrustMigrationWitness | undefined {
  if (!journal?.installTrustMigration || !journal.recordInstallTrustMigration)
    return undefined;
  return {
    installTrustMigration: () => journal.installTrustMigration!(),
    recordInstallTrustMigration: (next) =>
      journal.recordInstallTrustMigration!(next),
  };
}

type TrustFile = Record<string, PluginTrustRecord | MigrationMarker>;

export class PluginTrustRecordsUnavailableError extends GrantsStoreUnavailableError {
  constructor(
    storePath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(storePath, detail, options);
    this.message = `Plugin trust records are unavailable (${detail})`;
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
    typeof value.contentDigest === 'string' &&
    SHA256_DIGEST.test(value.contentDigest) &&
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
        !exactKeys(entry, ['version', 'startedAt', 'pending']) ||
        entry.version !== 1 ||
        typeof entry.startedAt !== 'string' ||
        !ISO_INSTANT.test(entry.startedAt) ||
        !Array.isArray(entry.pending) ||
        entry.pending.length > 4096 ||
        !entry.pending.every(isCanonicalPluginId)
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
  /** The migration has run (for this plugin) and it has no record. */
  | { state: 'unrecorded' }
  /** No record yet: the migration has not run, or will retry this plugin. */
  | { state: 'pending-migration' };

type MigrationState =
  | { state: 'none' }
  | { state: 'started'; pending: string[] }
  | { state: 'completed' };

function unavailable(projectHomeDir: string, detail: string) {
  return new PluginTrustRecordsUnavailableError(
    pluginTrustRecordsPath(projectHomeDir),
    detail,
  );
}

/**
 * The journal is the authority on whether the migration began. Once it has,
 * the file must carry its marker: a missing or marker-less file is not "no
 * records", it is records Station can no longer read.
 */
function migrationState(
  projectHomeDir: string,
  file: TrustFile,
  witness: PluginTrustMigrationWitness | undefined,
): MigrationState {
  const marker = Object.hasOwn(file, MIGRATION_KEY)
    ? (file[MIGRATION_KEY] as MigrationMarker)
    : undefined;
  const fromFile: MigrationState = marker
    ? marker.pending.length > 0
      ? { state: 'started', pending: [...marker.pending] }
      : { state: 'completed' }
    : { state: 'none' };
  if (!witness) return fromFile;
  const recorded = witness.installTrustMigration();
  if (recorded.state === 'unavailable')
    throw unavailable(projectHomeDir, 'migration state unreadable');
  if (recorded.state === 'none') return fromFile;
  if (!marker)
    throw unavailable(projectHomeDir, 'records missing after migration');
  return recorded;
}

function recordState(
  file: TrustFile,
  migration: MigrationState,
  pluginName: string,
): PluginTrustRecordState {
  const entry =
    pluginName !== MIGRATION_KEY && Object.hasOwn(file, pluginName)
      ? (file[pluginName] as PluginTrustRecord)
      : undefined;
  if (entry) return { state: 'recorded', record: structuredClone(entry) };
  if (
    migration.state === 'none' ||
    (migration.state === 'started' && migration.pending.includes(pluginName))
  )
    return { state: 'pending-migration' };
  return { state: 'unrecorded' };
}

/** Throws {@link PluginTrustRecordsUnavailableError}; never reads as empty. */
export function readPluginTrustRecord(
  projectHomeDir: string,
  pluginName: string,
  witness?: PluginTrustMigrationWitness,
): PluginTrustRecordState {
  const file = trustStore(projectHomeDir).read();
  return recordState(
    file,
    migrationState(projectHomeDir, file, witness),
    pluginName,
  );
}

/**
 * Whether a record still describes the installed bytes. A record whose
 * digest differs from the bytes now installed (changed outside the
 * installer) is `stale`; slice d2 must treat `stale` and `unrecorded` as
 * untrusted.
 */
export function pluginTrustForInstalledBytes(
  state: PluginTrustRecordState,
  installedDigest: string | null,
): PluginTrustRecordState | { state: 'stale'; record: PluginTrustRecord } {
  if (state.state !== 'recorded') return state;
  return installedDigest !== null &&
    state.record.contentDigest === installedDigest
    ? state
    : { state: 'stale', record: state.record };
}

/** Writes (or, with `null`, removes) one plugin's record. */
export async function writePluginTrustRecord(
  projectHomeDir: string,
  pluginName: string,
  record: PluginTrustRecord | null,
  witness?: PluginTrustMigrationWitness,
): Promise<void> {
  if (!isCanonicalPluginId(pluginName))
    throw new Error('Trust records are keyed by canonical plugin id');
  if (record !== null && recordProblem(record))
    throw new Error('Refusing to write a malformed trust record');
  await trustStore(projectHomeDir).mutate(pluginName, (current) => {
    // Refuses a write into a file that lost its marker after the migration
    // began, so one install cannot silently recreate an empty store.
    migrationState(projectHomeDir, current, witness);
    if (record === null) delete current[pluginName];
    else current[pluginName] = structuredClone(record);
    return current;
  });
}

export type PluginTrustMigrationClassificationResult =
  | { kind: 'absent' | 'mismatch' }
  | { kind: 'transient' }
  | { kind: 'installed'; contentDigest: string; signer: PluginSigner | null };

/**
 * One migration attempt. The first attempt freezes `candidates()`; later
 * attempts retry only the plugins that were still pending, so nothing
 * installed after d1 can join. Existing records are never replaced.
 */
export async function migrateGrandfatheredPluginTrust(options: {
  projectHomeDir: string;
  witness?: PluginTrustMigrationWitness;
  candidates: () => Promise<readonly string[]>;
  classify: (
    pluginName: string,
  ) => Promise<PluginTrustMigrationClassificationResult>;
  now: () => Date;
  logger?: Logger;
}): Promise<
  | { state: 'migrated'; grandfathered: string[]; pending: string[] }
  | { state: 'already-migrated' }
> {
  const store = trustStore(options.projectHomeDir);
  const file = store.read();
  const migration = migrationState(
    options.projectHomeDir,
    file,
    options.witness,
  );
  if (migration.state === 'completed') {
    // The file says done and the journal has no row yet: record it there.
    if (options.witness?.installTrustMigration().state === 'none')
      options.witness.recordInstallTrustMigration({ state: 'completed' });
    return { state: 'already-migrated' };
  }
  const candidates =
    migration.state === 'started'
      ? migration.pending
      : [...new Set(await options.candidates())].filter(isCanonicalPluginId);
  const decidedAt = options.now().toISOString();
  const startedAt =
    (file[MIGRATION_KEY] as MigrationMarker | undefined)?.startedAt ??
    decidedAt;
  const decided = new Map<
    string,
    Extract<PluginTrustMigrationClassificationResult, { kind: 'installed' }>
  >();
  const pending: string[] = [];
  for (const pluginName of candidates) {
    if (Object.hasOwn(file, pluginName)) continue;
    const result = await options.classify(pluginName);
    if (result.kind === 'installed') decided.set(pluginName, result);
    else if (result.kind === 'transient') pending.push(pluginName);
  }
  const grandfathered: string[] = [];
  await store.mutate(MIGRATION_KEY, (current) => {
    grandfathered.length = 0;
    migrationState(options.projectHomeDir, current, options.witness);
    for (const [pluginName, installation] of decided) {
      if (Object.hasOwn(current, pluginName)) continue;
      current[pluginName] = {
        version: 1,
        signer: installation.signer,
        provenance: installation.signer === null ? 'unsigned' : 'publisher',
        contentDigest: installation.contentDigest,
        tier: 2,
        decision: 'grandfathered',
        decidedBy: 'station',
        decidedAt,
      };
      grandfathered.push(pluginName);
    }
    current[MIGRATION_KEY] = { version: 1, startedAt, pending };
    return current;
  });
  // After the file: a crash between the two leaves a marker the next start
  // reconciles, never a journal row pointing at a file without one.
  const witnessed = options.witness?.recordInstallTrustMigration(
    pending.length > 0 ? { state: 'started', pending } : { state: 'completed' },
  );
  if (witnessed?.state === 'unavailable')
    options.logger?.warn(
      'Install trust migration state could not be recorded in the journal',
    );
  options.logger?.info(
    'Grandfathered install trust records for plugins installed before d1',
    { count: grandfathered.length, pending: pending.length },
  );
  return { state: 'migrated', grandfathered, pending };
}
