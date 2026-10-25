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
import {
  type InstallTrustMigrationCandidate,
  type InstallTrustMigrationState,
  isInstallTrustMigrationPending,
  MAX_INSTALL_TRUST_MIGRATION_PENDING,
  type PackageMcpAdmissionJournal,
  sameInstallTrustMigrationState,
} from './package-mcp-admission.js';
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
  /** Only Station decides in part 2a; the operator's decision arrives in 2b. */
  decidedBy: 'station';
  decidedAt: string;
}

interface MigrationMarker {
  version: 1;
  startedAt: string;
  /**
   * Pre-d1 plugins still to be decided, each with the digest frozen at the
   * first attempt; empty once the migration is done.
   */
  pending: InstallTrustMigrationCandidate[];
  /**
   * How many pre-d1 plugins the first attempt found when that exceeded the
   * bound, so none was grandfathered. Absent otherwise.
   */
  skippedOverBound?: number;
}

/** The journal's view of the migration; see `PackageMcpAdmissionJournal`. */
export type PluginTrustMigrationWitness = Required<
  Pick<
    PackageMcpAdmissionJournal,
    'installTrustMigration' | 'recordInstallTrustMigration'
  >
>;

/** The production witness is the installation journal. */
export function pluginTrustMigrationWitness(
  journal: PackageMcpAdmissionJournal | undefined,
): PluginTrustMigrationWitness | undefined {
  if (!journal?.installTrustMigration || !journal.recordInstallTrustMigration)
    return undefined;
  return {
    installTrustMigration: () => journal.installTrustMigration!(),
    recordInstallTrustMigration: (expected, next) =>
      journal.recordInstallTrustMigration!(expected, next),
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

/** A concurrent attempt moved the migration on; one retry resolves it. */
export class PluginTrustMigrationRaceError extends PluginTrustRecordsUnavailableError {
  constructor(storePath: string) {
    super(storePath, 'migration state changed concurrently');
    this.name = 'PluginTrustMigrationRaceError';
  }
}

/** An install would overwrite a record this build cannot read. */
export class PluginTrustRecordNewerError extends Error {
  readonly code = 'plugin-trust-record-newer';
  constructor(readonly pluginName: string) {
    super(
      "A newer Station wrote this plugin's install trust record. Install or update it from that Station.",
    );
    this.name = 'PluginTrustRecordNewerError';
  }
}

/**
 * The recovery Station names when trust records are missing after the
 * migration began: restoring the file, or writing an empty, completed marker
 * so every plugin reads `unrecorded` (which only ever grants less trust).
 */
export const PLUGIN_TRUST_RECORDS_RECOVERY =
  'Restore plugin-trust.json from a backup, or create it containing {"$migration":{"version":1,"startedAt":"2026-01-01T00:00:00.000Z","pending":[]}} so every plugin reads as unrecorded until it is decided again';

/**
 * The remedy for one malformed record: the entry is removed by hand, and the
 * plugin then reads `unrecorded` (no trust) until it is installed or updated
 * again. The rest of the store is untouched.
 */
export const PLUGIN_TRUST_RECORD_ENTRY_RECOVERY =
  'Delete that entry from plugin-trust.json; the plugin then reads as unrecorded until it is reinstalled or updated, which decides from scratch (an earlier decision, including a lowered tier, is forgotten)';

/**
 * Versioning rule. Records written by this build are `version: 1`; a build
 * that adds a decision kind, reason or field writes a higher version. A
 * reader that does not know a record's version treats that one record as
 * unreadable. It never rejects the whole store because of it, and never
 * installs over it. A newer migration marker is treated as a completed
 * migration this build does not continue.
 */
const TRUST_RECORD_VERSION = 1;
function isNewerVersion(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version > TRUST_RECORD_VERSION
  );
}
const NEWER_RECORD_KEY = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,213}$/;

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

// Only the decisions a writer stores. `unchanged` is never stored: a
// same-bytes reinstall keeps the earlier record's decision as it was.
const DECISIONS = new Set([
  'initial',
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
    value.decidedBy === 'station' &&
    typeof value.decidedAt === 'string' &&
    ISO_INSTANT.test(value.decidedAt) &&
    !impossibleRecord(value)
  );
}

/**
 * Well-formed fields no writer combines (defence in depth: a hand-written
 * record must not read as tier 2). What the writers produce:
 * - provenance is `unsigned` exactly when there is no signer, and `kontour`
 *   only with a Sigstore signer;
 * - tier 2 comes from a grandfathered record, or from `kontour` provenance,
 *   which needs a Sigstore signer. A same-bytes reinstall keeps the earlier
 *   tier after the plugin left the lock, so a Sigstore-signed `publisher`
 *   record can stay at tier 2; nothing else can;
 * - a grandfathered record is tier 2, and only a new decision names the tier
 *   it replaced.
 */
function impossibleRecord(record: Record<string, unknown>): boolean {
  const sigstore = isRecord(record.signer) && record.signer.kind === 'sigstore';
  if ((record.signer === null) !== (record.provenance === 'unsigned'))
    return true;
  if (record.provenance === 'kontour' && !sigstore) return true;
  if (record.tier === 2 && record.decision !== 'grandfathered' && !sigstore)
    return true;
  if (record.decision === 'grandfathered' && record.tier !== 2) return true;
  return record.priorTier !== undefined && record.decision !== 'new-decision';
}

function trustFileShapeProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['must be a plain object keyed by plugin name'];
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === MIGRATION_KEY) {
      if (isNewerVersion(entry)) continue;
      if (
        !isRecord(entry) ||
        !exactKeys(
          entry,
          ['version', 'startedAt', 'pending'],
          ['skippedOverBound'],
        ) ||
        (entry.skippedOverBound !== undefined &&
          !(
            Number.isSafeInteger(entry.skippedOverBound) &&
            (entry.skippedOverBound as number) >
              MAX_INSTALL_TRUST_MIGRATION_PENDING
          )) ||
        entry.version !== 1 ||
        typeof entry.startedAt !== 'string' ||
        !ISO_INSTANT.test(entry.startedAt) ||
        !isInstallTrustMigrationPending(entry.pending)
      )
        problems.push(
          `${MIGRATION_KEY}: malformed migration marker. ${PLUGIN_TRUST_RECORDS_RECOVERY}`,
        );
      continue;
    }
    // A record from a newer build is kept, unread, even under a key grammar
    // this build does not use.
    if (isNewerVersion(entry) && NEWER_RECORD_KEY.test(key)) continue;
    if (!isCanonicalPluginId(key)) {
      // The key is not echoed: it is untrusted text, not a plugin name.
      problems.push(
        `an entry has an invalid name (not a canonical plugin id). Delete the entry with the invalid name from plugin-trust.json; no plugin is keyed by it`,
      );
      continue;
    }
    if (recordProblem(entry))
      problems.push(
        `${key}: malformed trust record. ${PLUGIN_TRUST_RECORD_ENTRY_RECOVERY}`,
      );
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
  /**
   * The migration has run (for this plugin) and it has no record.
   * `grandfatheringSkipped` when the migration grandfathered nothing because
   * more plugins than the bound were installed before d1.
   */
  | { state: 'unrecorded'; grandfatheringSkipped?: true }
  /** No record yet: the migration has not run, or will retry this plugin. */
  | { state: 'pending-migration' }
  /** A record written by a newer build; this build does not interpret it. */
  | { state: 'unreadable' };

type MigrationState = InstallTrustMigrationState;

function unavailable(projectHomeDir: string, detail: string) {
  return new PluginTrustRecordsUnavailableError(
    pluginTrustRecordsPath(projectHomeDir),
    detail,
  );
}

/**
 * The journal is the authority on whether the migration began. Once the
 * frozen set has reached the file, the file must carry its marker: a missing
 * or marker-less file is not "no records", it is records Station can no
 * longer read.
 */
function migrationState(
  projectHomeDir: string,
  file: TrustFile,
  witness: PluginTrustMigrationWitness | undefined,
): MigrationState {
  const marker = Object.hasOwn(file, MIGRATION_KEY)
    ? (file[MIGRATION_KEY] as MigrationMarker)
    : undefined;
  const fromFile: MigrationState = !marker
    ? { state: 'none' }
    : isNewerVersion(marker) || marker.pending.length === 0
      ? { state: 'completed' }
      : { state: 'started', pending: [...marker.pending], fileWritten: true };
  if (!witness) return fromFile;
  const recorded = witness.installTrustMigration();
  if (recorded.state === 'unavailable')
    throw unavailable(projectHomeDir, 'migration state unreadable');
  if (recorded.state === 'none') return fromFile;
  if (!marker) {
    // The attempt's own first write never landed: the next attempt rebuilds
    // the file from the journal's frozen set.
    if (recorded.state === 'started' && !recorded.fileWritten) return recorded;
    throw unavailable(
      projectHomeDir,
      `records missing after migration. ${PLUGIN_TRUST_RECORDS_RECOVERY}`,
    );
  }
  // A completed marker (or one from a newer build) is final, including the
  // empty marker written by hand as the documented recovery.
  if (fromFile.state === 'completed') return fromFile;
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
  if (entry && isNewerVersion(entry)) return { state: 'unreadable' };
  if (entry) return { state: 'recorded', record: structuredClone(entry) };
  if (
    migration.state === 'none' ||
    (migration.state === 'started' &&
      migration.pending.some((entry) => entry.name === pluginName))
  )
    return { state: 'pending-migration' };
  const marker = Object.hasOwn(file, MIGRATION_KEY)
    ? (file[MIGRATION_KEY] as MigrationMarker)
    : undefined;
  return marker?.skippedOverBound !== undefined && !isNewerVersion(marker)
    ? { state: 'unrecorded', grandfatheringSkipped: true }
    : { state: 'unrecorded' };
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
    const migration = migrationState(projectHomeDir, current, witness);
    // An installer's record decides the plugin: it leaves the migration's
    // pending set, so deleting that record later reads `unrecorded` and is
    // never grandfathered by a later attempt. Journal first (compare-and-set
    // under this lock), then the marker in the same file write; a failure
    // after the journal step only ever leaves the plugin less trusted.
    if (
      record !== null &&
      migration.state === 'started' &&
      migration.pending.some((entry) => entry.name === pluginName)
    ) {
      const pending = migration.pending.filter(
        (entry) => entry.name !== pluginName,
      );
      if (witness)
        witnessed(
          projectHomeDir,
          witness,
          migration,
          pending.length > 0
            ? { state: 'started', pending, fileWritten: true }
            : { state: 'completed' },
        );
      // Before the frozen set's first file write this write lands it, so
      // the marker is created here and the rest stay pending for the next
      // attempt (which grandfathers only digest matches, as always).
      const marker = current[MIGRATION_KEY] as MigrationMarker | undefined;
      current[MIGRATION_KEY] = {
        ...(marker ?? { version: 1, startedAt: new Date().toISOString() }),
        pending,
      };
    }
    if (record === null) delete current[pluginName];
    else current[pluginName] = structuredClone(record);
    return current;
  });
}

export type PluginTrustMigrationClassificationResult =
  | { kind: 'absent' | 'mismatch' }
  /** Not readable now; `digest` when the bytes were readable. */
  | { kind: 'transient'; digest: string | null }
  | { kind: 'installed'; contentDigest: string; signer: PluginSigner | null };

const sameState = sameInstallTrustMigrationState;

function witnessed(
  projectHomeDir: string,
  witness: PluginTrustMigrationWitness,
  expected: MigrationState,
  next: Exclude<MigrationState, { state: 'none' }>,
): void {
  const result = witness.recordInstallTrustMigration(expected, next);
  if (result.state === 'applied') return;
  if (result.state === 'stale')
    throw new PluginTrustMigrationRaceError(
      pluginTrustRecordsPath(projectHomeDir),
    );
  throw unavailable(
    projectHomeDir,
    result.state === 'too-many'
      ? `more than ${MAX_INSTALL_TRUST_MIGRATION_PENDING} plugins wait for the migration`
      : 'migration state could not be recorded',
  );
}

/**
 * One migration attempt.
 *
 * The first attempt freezes every pre-d1 plugin with the digest of its bytes
 * then, and records that set in the journal BEFORE writing the file. Until
 * the journal says the set reached the file, a missing file is a first write
 * that never landed and the next attempt rebuilds it from the frozen set;
 * after that, a missing file reads as unavailable (fail closed). A later
 * attempt retries only the frozen plugins still pending, and grandfathers
 * one only when its bytes still match the frozen digest; bytes first seen
 * after the freeze (a frozen `null` digest) are never grandfathered. Every
 * journal write is compare-and-set against the state this attempt read, and
 * a failed journal write fails the attempt. Existing records are never
 * replaced.
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
  const { projectHomeDir, witness } = options;
  const store = trustStore(projectHomeDir);
  const file = store.read();
  let migration = migrationState(projectHomeDir, file, witness);
  // A file marker the journal has not seen (a journal-less history, or a
  // journal reset): the journal adopts the file's state first.
  // A completed file the journal has not caught up with (the final journal
  // write failed, or the file was replaced by the documented recovery): the
  // journal follows the file.
  if (witness && migration.state !== 'none') {
    const journaled = witness.installTrustMigration();
    if (journaled.state === 'none')
      witnessed(projectHomeDir, witness, journaled, migration);
    else if (migration.state === 'completed' && journaled.state === 'started')
      witnessed(projectHomeDir, witness, journaled, migration);
  }
  if (migration.state === 'completed') return { state: 'already-migrated' };

  const decidedAt = options.now().toISOString();
  const decided = new Map<
    string,
    Extract<PluginTrustMigrationClassificationResult, { kind: 'installed' }>
  >();
  const pending: InstallTrustMigrationCandidate[] = [];
  let skippedOverBound = (file[MIGRATION_KEY] as MigrationMarker | undefined)
    ?.skippedOverBound;
  if (migration.state === 'none') {
    // First attempt: classify everything and freeze the set with digests.
    const frozen: InstallTrustMigrationCandidate[] = [];
    for (const name of [...new Set(await options.candidates())].filter(
      isCanonicalPluginId,
    )) {
      if (Object.hasOwn(file, name)) continue;
      const result = await options.classify(name);
      if (result.kind === 'installed') {
        frozen.push({ name, digest: result.contentDigest });
        decided.set(name, result);
      } else if (result.kind === 'transient') {
        frozen.push({ name, digest: result.digest });
        // Unreadable bytes are never grandfathered later: they would be
        // bytes first seen after the freeze.
        if (result.digest !== null)
          pending.push({ name, digest: result.digest });
      }
    }
    if (frozen.length > MAX_INSTALL_TRUST_MIGRATION_PENDING) {
      // Too many to freeze: grandfather nothing and complete. Every pre-d1
      // plugin then reads `unrecorded` and is decided again, which fails
      // closed without locking installs out.
      options.logger?.error(
        'Too many plugins installed before d1 to grandfather; none was',
        { count: frozen.length, bound: MAX_INSTALL_TRUST_MIGRATION_PENDING },
      );
      skippedOverBound = frozen.length;
      frozen.length = 0;
      pending.length = 0;
      decided.clear();
    }
    const started: MigrationState = {
      state: 'started',
      pending: frozen,
      fileWritten: false,
    };
    if (witness) witnessed(projectHomeDir, witness, migration, started);
    migration = started;
  } else {
    for (const candidate of migration.pending) {
      if (Object.hasOwn(file, candidate.name) || candidate.digest === null)
        continue;
      const result = await options.classify(candidate.name);
      if (result.kind === 'installed') {
        if (result.contentDigest === candidate.digest)
          decided.set(candidate.name, result);
      } else if (result.kind === 'transient') pending.push(candidate);
    }
  }

  const grandfathered: string[] = [];
  const startedAt =
    (file[MIGRATION_KEY] as MigrationMarker | undefined)?.startedAt ??
    decidedAt;
  await store.mutate(MIGRATION_KEY, (current) => {
    grandfathered.length = 0;
    // Recheck under the lock: a concurrent attempt may have moved on.
    if (witness && !sameState(witness.installTrustMigration(), migration))
      throw new PluginTrustMigrationRaceError(
        pluginTrustRecordsPath(projectHomeDir),
      );
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
    current[MIGRATION_KEY] = {
      version: 1,
      startedAt,
      pending,
      ...(skippedOverBound !== undefined ? { skippedOverBound } : {}),
    };
    return current;
  });
  if (witness)
    witnessed(
      projectHomeDir,
      witness,
      migration,
      pending.length > 0
        ? { state: 'started', pending, fileWritten: true }
        : { state: 'completed' },
    );
  options.logger?.info(
    'Grandfathered install trust records for plugins installed before d1',
    { count: grandfathered.length, pending: pending.length },
  );
  return {
    state: 'migrated',
    grandfathered,
    pending: pending.map((entry) => entry.name),
  };
}
