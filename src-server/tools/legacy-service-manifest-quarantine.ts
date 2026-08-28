/**
 * One-way, crash-recoverable quarantine of the pre-channel service manifest.
 *
 * This is intentionally not part of the instance-registry module.  The
 * registry is the current liveness authority; this narrow transaction only
 * removes one fully identified obsolete record before a desktop sidecar can
 * make an ownership decision.  Its public result contains no host paths.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isStationProfileStore } from '@kontourai/station-contracts';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import {
  type InstanceConfig,
  readInstanceRegistry,
  reconcileStaleDesktopSidecars,
  withInstanceRegistryMutationLock,
} from '@kontourai/station-shared/instance-registry';
import { acquireFileMutationLock } from '@kontourai/station-shared/lifecycle-events';
import { birthProvesReuse } from '@kontourai/station-shared/process-identity';
import {
  admitStationRuntimeHome,
  resolveStationRoot,
} from '@kontourai/station-shared/runtime-path-resolver';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
  StationHomeLifecycleUnavailableError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { withProfileStoreLock } from '../../packages/cli/src/commands/profile-store.js';

const LEGACY_SOURCE_RELATIVE_PATH = join('service', 'default.json');
const SHARED_QUARANTINE_DIRECTORY = 'quarantine';
const LEGACY_QUARANTINE_DIRECTORY = join(
  SHARED_QUARANTINE_DIRECTORY,
  'legacy-service-manifest',
);
const LEGACY_MANIFEST_KIND = 'legacy-service-default';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024;
// A valid committed state has three final records; one temporary can coexist
// with its final record between link and temporary cleanup.
const MAX_QUARANTINE_ENTRIES = 4;
// Native gives the child three seconds total. Never retain profile ownership
// while waiting on the registry's normal ten-second mutation timeout.
const PREPARATION_LOCK_TIMEOUT_MS = 250;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_MANIFEST_KEYS = [
  'allowedOrigins',
  'baseDir',
  'features',
  'host',
  'installedAt',
  'instanceId',
  'label',
  'nodePath',
  'platform',
  'repoPath',
  'serverPort',
  'uiPort',
  'unitPath',
] as const;
// These are the only two labels emitted by the pre-channel service installer.
// Do not accept label prefixes or future channel identifiers here: this
// transaction is allowed to move only an already-obsolete, exact record.
const LEGACY_MANIFEST_LABELS = [
  'default',
  'io.kontourai.station.default',
] as const;

export type LegacyServiceManifestDisposition =
  | 'absent'
  | 'new'
  | 'already'
  | 'recovered'
  | 'refused';

export interface LegacyServiceManifestQuarantineResult {
  readonly kind: LegacyServiceManifestDisposition;
}

/** Test-only failpoints model a crash at each durable transaction boundary. */
export interface LegacyServiceManifestQuarantineHooks {
  /** Test-only process liveness seam; production uses `process.kill(pid, 0)`. */
  readonly registryProcessProbe?: (pid: number) => void;
  readonly beforePreparedFsync?: () => void;
  readonly afterPreparedFsyncBeforeLink?: () => void;
  readonly afterPreparedLinkBeforeDirectoryFsync?: () => void;
  readonly afterPreparedBeforeRename?: () => void;
  readonly beforeRename?: () => void;
  readonly afterFinalObservationBeforeRename?: () => void;
  readonly afterRenameBeforeSourceFsync?: () => void;
  readonly afterSourceFsyncBeforeTargetFsync?: () => void;
  readonly afterRenameBeforeCommit?: () => void;
  readonly afterCommittedFsyncBeforeLink?: () => void;
  readonly afterCommittedLinkBeforeDirectoryFsync?: () => void;
}

interface FileObservation {
  readonly raw: Buffer;
  readonly digest: string;
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
}

/**
 * Path identities admitted before this transaction publishes any evidence.
 * They are capabilities, not observations to be refreshed at the final
 * rename: a pathname replacement must never become a new baseline.
 */
interface QuarantineDirectoryBaseline {
  readonly home: Stats;
  readonly service: Stats;
  readonly quarantine: Stats;
}

interface Receipt {
  readonly schemaVersion: 1;
  readonly kind: typeof LEGACY_MANIFEST_KIND;
  readonly state: 'prepared' | 'committed';
  readonly digest: string;
  readonly source: { readonly dev: number; readonly ino: number };
  readonly sourcePath: typeof LEGACY_SOURCE_RELATIVE_PATH;
  readonly quarantinedPath: string;
}

class LegacyServiceManifestRefusal extends Error {}

function refuse(): never {
  throw new LegacyServiceManifestRefusal('legacy service manifest refused');
}

function sameIdentity(
  left: Pick<Stats, 'dev' | 'ino'>,
  right: Pick<Stats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContentMetadata(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function ownerOnly(info: Stats, exactMode?: number): boolean {
  return (
    (typeof process.getuid !== 'function' || info.uid === process.getuid()) &&
    (process.platform === 'win32' ||
      (exactMode === undefined
        ? (info.mode & 0o077) === 0
        : (info.mode & 0o777) === exactMode))
  );
}

function trustedDirectory(path: string, exactMode?: number): Stats {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    refuse();
  }
  if (
    !info!.isDirectory() ||
    info!.isSymbolicLink() ||
    !ownerOnly(info!, exactMode)
  ) {
    refuse();
  }
  return info!;
}

function digest(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function readBoundedDescriptor(
  descriptor: number,
  maximumBytes: number,
): Buffer {
  const chunks: Buffer[] = [];
  let length = 0;
  while (true) {
    // Keep one probe byte available even at the maximum, so growth and an
    // over-limit final byte are refused without allocating from file size.
    const chunk = Buffer.allocUnsafe(
      Math.min(8192, Math.max(1, maximumBytes - length + 1)),
    );
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, length);
    if (bytesRead > maximumBytes - length) refuse();
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    length += bytesRead;
  }
}

function readDedicatedQuarantineEntries(path: string): string[] {
  const directory = opendirSync(path);
  try {
    const entries: string[] = [];
    while (true) {
      const entry = directory.readSync();
      if (!entry) return entries;
      entries.push(entry.name);
      if (entries.length > MAX_QUARANTINE_ENTRIES) refuse();
    }
  } finally {
    directory.closeSync();
  }
}

/** Reads through a no-follow descriptor, then proves the pathname stayed put. */
function readTrustedFile(
  path: string,
  maximumBytes: number,
  exactMode?: number,
): FileObservation | undefined {
  let pre: Stats;
  try {
    pre = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    refuse();
  }
  if (!pre!.isFile() || pre!.isSymbolicLink() || !ownerOnly(pre!, exactMode)) {
    refuse();
  }
  if (pre!.size > maximumBytes) refuse();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const observed = fstatSync(descriptor);
    if (
      !observed.isFile() ||
      !ownerOnly(observed, exactMode) ||
      !sameContentMetadata(pre!, observed) ||
      observed.size > maximumBytes
    ) {
      refuse();
    }
    const raw = readBoundedDescriptor(descriptor, maximumBytes);
    const afterRead = fstatSync(descriptor);
    if (
      raw.length !== afterRead.size ||
      !sameContentMetadata(observed, afterRead)
    )
      refuse();
    const post = lstatSync(path);
    if (
      !post.isFile() ||
      post.isSymbolicLink() ||
      !sameContentMetadata(post, afterRead)
    ) {
      refuse();
    }
    return {
      raw,
      digest: digest(raw),
      dev: observed.dev,
      ino: observed.ino,
      nlink: observed.nlink,
    };
  } catch (error) {
    if (error instanceof LegacyServiceManifestRefusal) throw error;
    refuse();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    refuse();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function boundedString(value: unknown, maximum = 4096): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function isExactLegacyManifest(value: unknown, stationRoot: string): boolean {
  if (!isObject(value) || !hasExactKeys(value, LEGACY_MANIFEST_KEYS))
    return false;
  return (
    Array.isArray(value.allowedOrigins) &&
    value.allowedOrigins.every((entry) => boundedString(entry, 1024)) &&
    value.baseDir === stationRoot &&
    (value.features === null || boundedString(value.features)) &&
    value.host === '127.0.0.1' &&
    boundedString(value.installedAt) &&
    value.instanceId === 'default' &&
    LEGACY_MANIFEST_LABELS.some((label) => value.label === label) &&
    boundedString(value.nodePath) &&
    (value.platform === 'darwin' ||
      value.platform === 'linux' ||
      value.platform === 'win32') &&
    boundedString(value.repoPath) &&
    isAbsolute(value.repoPath) &&
    resolve(value.repoPath) === value.repoPath &&
    basename(value.repoPath) === 'station-service' &&
    value.serverPort === 3141 &&
    value.uiPort === 3000 &&
    boundedString(value.unitPath)
  );
}

function quarantinePathFor(digestValue: string): string {
  return join(
    LEGACY_QUARANTINE_DIRECTORY,
    `${LEGACY_MANIFEST_KIND}-${digestValue}.json`,
  );
}

function receiptPathFor(digestValue: string): string {
  return join(
    LEGACY_QUARANTINE_DIRECTORY,
    `${LEGACY_MANIFEST_KIND}-${digestValue}.receipt.json`,
  );
}

function committedPathFor(digestValue: string): string {
  return join(
    LEGACY_QUARANTINE_DIRECTORY,
    `${LEGACY_MANIFEST_KIND}-${digestValue}.committed.json`,
  );
}

function receiptFor(state: Receipt['state'], source: FileObservation): Receipt {
  return {
    schemaVersion: 1,
    kind: LEGACY_MANIFEST_KIND,
    state,
    digest: source.digest,
    source: { dev: source.dev, ino: source.ino },
    sourcePath: LEGACY_SOURCE_RELATIVE_PATH,
    quarantinedPath: quarantinePathFor(source.digest),
  };
}

function isReceipt(value: unknown): value is Receipt {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'state',
      'digest',
      'source',
      'sourcePath',
      'quarantinedPath',
    ])
  )
    return false;
  const source = value.source;
  if (!isObject(source) || !hasExactKeys(source, ['dev', 'ino'])) return false;
  return (
    value.schemaVersion === 1 &&
    value.kind === LEGACY_MANIFEST_KIND &&
    (value.state === 'prepared' || value.state === 'committed') &&
    typeof value.digest === 'string' &&
    DIGEST_PATTERN.test(value.digest) &&
    typeof source.dev === 'number' &&
    Number.isSafeInteger(source.dev) &&
    source.dev >= 0 &&
    typeof source.ino === 'number' &&
    Number.isSafeInteger(source.ino) &&
    source.ino >= 0 &&
    value.sourcePath === LEGACY_SOURCE_RELATIVE_PATH &&
    value.quarantinedPath === quarantinePathFor(value.digest)
  );
}

function readReceipt(path: string): Receipt | undefined {
  const observation = readTrustedFile(path, MAX_RECEIPT_BYTES, 0o600);
  if (!observation) return undefined;
  if (observation.nlink !== 1) refuse();
  const receipt = parseJson(observation.raw);
  if (!isReceipt(receipt)) refuse();
  return receipt;
}

function sameReceipt(left: Receipt, right: Receipt): boolean {
  return (
    left.digest === right.digest &&
    left.source.dev === right.source.dev &&
    left.source.ino === right.source.ino &&
    left.sourcePath === right.sourcePath &&
    left.quarantinedPath === right.quarantinedPath
  );
}

/** Publishes one immutable receipt/event without a rename-temporary state. */
function writeReceipt(
  path: string,
  receipt: Receipt,
  quarantineDirectory: string,
  hooks: {
    readonly beforeFsync?: () => void;
    readonly afterFsyncBeforeLink?: () => void;
    readonly afterLinkBeforeDirectoryFsync?: () => void;
  } = {},
): void {
  const existing = readReceipt(path);
  if (existing) {
    if (!sameReceipt(existing, receipt) || existing.state !== receipt.state)
      refuse();
    return;
  }
  trustedDirectory(quarantineDirectory, 0o700);
  const serialized = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
  if (serialized.length > MAX_RECEIPT_BYTES) refuse();
  const temporary = join(
    quarantineDirectory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, serialized);
    hooks.beforeFsync?.();
    fsyncSync(descriptor);
    const info = fstatSync(descriptor);
    if (!info.isFile() || !ownerOnly(info, 0o600)) refuse();
    hooks.afterFsyncBeforeLink?.();
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    hooks.afterLinkBeforeDirectoryFsync?.();
    fsyncDirectorySync(quarantineDirectory);
    rmSync(temporary);
    fsyncDirectorySync(quarantineDirectory);
    const published = readReceipt(path);
    if (
      !published ||
      !sameReceipt(published, receipt) ||
      published.state !== receipt.state
    )
      refuse();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      rmSync(temporary, { force: true });
      fsyncDirectorySync(quarantineDirectory);
    } catch {}
  }
}

interface PreparedEvidence {
  readonly directory: string;
  readonly receipt: Receipt;
  readonly target?: FileObservation;
  readonly committed: boolean;
}

/** Validates singleton evidence and cleans only a source- or receipt-bound temp. */
function inspectQuarantineEvidence(
  stationHome: string,
  source?: FileObservation,
): PreparedEvidence | undefined {
  const sharedDirectory = join(stationHome, SHARED_QUARANTINE_DIRECTORY);
  let sharedExists: boolean;
  try {
    sharedExists = existsSync(sharedDirectory);
  } catch {
    refuse();
  }
  if (!sharedExists!) return undefined;
  trustedDirectory(sharedDirectory, 0o700);
  const quarantineDirectory = join(stationHome, LEGACY_QUARANTINE_DIRECTORY);
  if (!existsSync(quarantineDirectory)) return undefined;
  trustedDirectory(quarantineDirectory, 0o700);
  const entries = readDedicatedQuarantineEntries(quarantineDirectory);
  const ownedTemporary = new RegExp(
    `^\\.${LEGACY_MANIFEST_KIND}-([a-f0-9]{64})\\.(receipt|committed)\\.json\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`,
  );
  const temporaries = entries.filter((entry) => ownedTemporary.test(entry));
  const persistentEntries = entries.filter(
    (entry) => !ownedTemporary.test(entry),
  );
  if (persistentEntries.length > 3) refuse();
  if (persistentEntries.length === 0 && temporaries.length === 0)
    return undefined;
  const prefix = `${LEGACY_MANIFEST_KIND}-`;
  const receiptSuffix = '.receipt.json';
  const commitSuffix = '.committed.json';
  const records = persistentEntries.filter(
    (entry) => entry.startsWith(prefix) && entry.endsWith(receiptSuffix),
  );
  const targets = persistentEntries.filter(
    (entry) =>
      entry.startsWith(prefix) &&
      entry.endsWith('.json') &&
      !entry.endsWith(receiptSuffix) &&
      !entry.endsWith(commitSuffix),
  );
  const commits = persistentEntries.filter(
    (entry) => entry.startsWith(prefix) && entry.endsWith(commitSuffix),
  );
  if (
    persistentEntries.length > 0 &&
    (records.length + targets.length + commits.length !==
      persistentEntries.length ||
      records.length !== 1 ||
      targets.length > 1 ||
      commits.length > 1)
  )
    refuse();
  for (const entry of temporaries) {
    const match = ownedTemporary.exec(entry);
    if (!match) refuse();
    const [, temporaryDigest, temporaryKind] = match;
    const finalPath = join(
      quarantineDirectory,
      temporaryKind === 'receipt'
        ? basename(receiptPathFor(temporaryDigest!))
        : basename(committedPathFor(temporaryDigest!)),
    );
    const temporaryPath = join(quarantineDirectory, entry);
    const temporary = readTrustedFile(temporaryPath, MAX_RECEIPT_BYTES, 0o600);
    if (!temporary || temporary.nlink < 1 || temporary.nlink > 2) refuse();
    const final = readTrustedFile(finalPath, MAX_RECEIPT_BYTES, 0o600);
    if (temporary.nlink === 2) {
      if (!final) refuse();
      if (final.nlink !== 2 || !sameIdentity(temporary, final)) refuse();
    } else {
      if (final) refuse();
      const digestAuthorized =
        source?.digest === temporaryDigest ||
        persistentEntries.some(
          (persistent) =>
            persistent === basename(receiptPathFor(temporaryDigest!)) ||
            persistent === basename(quarantinePathFor(temporaryDigest!)),
        );
      if (!digestAuthorized) refuse();
    }
    rmSync(temporaryPath);
    fsyncDirectorySync(quarantineDirectory);
    if (temporary.nlink === 2) {
      const reopened = readTrustedFile(finalPath, MAX_RECEIPT_BYTES, 0o600);
      if (!reopened) refuse();
      if (reopened.nlink !== 1) refuse();
    }
  }
  const receipt =
    records.length === 1
      ? readReceipt(join(quarantineDirectory, records[0]!))
      : undefined;
  if (receipt && receipt.state !== 'prepared') refuse();
  if (!receipt && persistentEntries.length !== 0) refuse();
  if (!receipt) return undefined;
  const expectedReceiptName = basename(receiptPathFor(receipt.digest));
  const expectedTargetName = basename(quarantinePathFor(receipt.digest));
  const expectedCommitName = basename(committedPathFor(receipt.digest));
  if (
    records[0] !== expectedReceiptName ||
    (targets.length === 1 && targets[0] !== expectedTargetName) ||
    (commits.length === 1 && commits[0] !== expectedCommitName)
  )
    refuse();
  const committed = commits.length === 1;
  const commit = committed
    ? readReceipt(join(quarantineDirectory, commits[0]!))
    : undefined;
  if (
    (committed &&
      (commit?.state !== 'committed' || !sameReceipt(commit, receipt))) ||
    (committed && targets.length !== 1)
  )
    refuse();
  if (targets.length === 0) {
    if (committed) refuse();
    return { directory: quarantineDirectory, receipt, committed: false };
  }
  const target = readTrustedFile(
    join(quarantineDirectory, targets[0]!),
    MAX_MANIFEST_BYTES,
  );
  if (
    !target ||
    target.digest !== receipt.digest ||
    !sameIdentity(target, receipt.source)
  )
    refuse();
  const exactDualNameReplay =
    !committed &&
    source !== undefined &&
    source.nlink === 2 &&
    target.nlink === 2 &&
    sameIdentity(source, target);
  if (target.nlink !== 1 && !exactDualNameReplay) refuse();
  return { directory: quarantineDirectory, receipt, target, committed };
}

/** Completes durable directory acknowledgement after a rename-before-commit crash. */
function recoverMovedManifest(
  stationHome: string,
  stationRoot: string,
  evidence: PreparedEvidence,
  registryProcessProbe?: (pid: number) => void,
): LegacyServiceManifestQuarantineResult {
  if (!evidence.target) refuse();
  const target = readTrustedFile(
    join(stationHome, quarantinePathFor(evidence.receipt.digest)),
    MAX_MANIFEST_BYTES,
  );
  if (!target) refuse();
  if (
    target.nlink !== 1 ||
    target.digest !== evidence.receipt.digest ||
    !sameIdentity(target, evidence.receipt.source)
  )
    refuse();
  if (evidence.committed) return { kind: 'already' };
  const serviceDirectory = join(stationHome, 'service');
  try {
    if (existsSync(serviceDirectory)) {
      trustedDirectory(serviceDirectory);
      fsyncDirectorySync(serviceDirectory);
    }
  } catch {
    refuse();
  }
  fsyncDirectorySync(evidence.directory);
  // Recovery can publish a commit after a crash left only the target.  This is
  // still a mutating ownership decision, so re-read both authorities while the
  // maintenance -> registry -> profile critical section remains held.
  assertNoCurrentLegacyAuthority(
    stationRoot,
    stationHome,
    registryProcessProbe,
  );
  writeReceipt(
    join(stationHome, committedPathFor(evidence.receipt.digest)),
    { ...evidence.receipt, state: 'committed' },
    evidence.directory,
  );
  // The final receipt directory sync does not prove a hostile writer left the
  // target alone. A retained marker plus a failed exact read is safely
  // fail-closed on the next inspection, never a recovered success.
  assertTargetStillPrepared(stationHome, target);
  return { kind: 'recovered' };
}

function registryHasLiveService(
  stationHome: string,
  processProbe: (pid: number) => void = (pid) => {
    process.kill(pid, 0);
  },
): boolean {
  const registry = readInstanceRegistry(stationHome);
  return Object.values(registry.instances).some((instance: InstanceConfig) => {
    if (instance.type !== 'service' || typeof instance.pid !== 'number')
      return false;
    try {
      processProbe(instance.pid);
      return !birthProvesReuse(instance.birth, instance.pid);
    } catch (error) {
      // Only a proved missing PID authorizes removal. EPERM and every other
      // probe failure leave a potentially live service fenced.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  });
}

function profileAuthorizesLegacyService(stationRoot: string): boolean {
  trustedDirectory(stationRoot);
  const config = join(stationRoot, 'config');
  let configInfo: Stats;
  try {
    configInfo = lstatSync(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    refuse();
  }
  if (
    !configInfo!.isDirectory() ||
    configInfo!.isSymbolicLink() ||
    !ownerOnly(configInfo!)
  )
    refuse();
  const profiles = readTrustedFile(
    join(config, 'profiles.json'),
    MAX_MANIFEST_BYTES,
  );
  if (!profiles) return false;
  const store = parseJson(profiles.raw);
  if (!isStationProfileStore(store)) refuse();
  return store.profiles.some(
    (profile) =>
      profile.localService?.instanceId === 'default' &&
      profile.localService.baseDir === stationRoot &&
      profile.localService.serverPort === 3141 &&
      profile.localService.uiPort === 3000,
  );
}

/** The checked profile and birth-aware registry must authorize no live owner. */
function assertNoCurrentLegacyAuthority(
  stationRoot: string,
  stationHome: string,
  registryProcessProbe?: (pid: number) => void,
): void {
  if (
    profileAuthorizesLegacyService(stationRoot) ||
    registryHasLiveService(stationHome, registryProcessProbe)
  )
    refuse();
}

function assertSourceStillObserved(
  path: string,
  source: FileObservation,
): void {
  const current = readTrustedFile(path, MAX_MANIFEST_BYTES);
  if (
    !current ||
    current.digest !== source.digest ||
    current.dev !== source.dev ||
    current.ino !== source.ino ||
    current.nlink !== 1
  ) {
    refuse();
  }
}

function assertDirectoriesUnchanged(
  stationHome: string,
  serviceDirectory: string,
  quarantineDirectory: string,
  expected: QuarantineDirectoryBaseline,
): void {
  const current = {
    home: trustedDirectory(stationHome),
    service: trustedDirectory(serviceDirectory),
    quarantine: trustedDirectory(quarantineDirectory, 0o700),
  };
  if (
    !sameIdentity(current.home, expected.home) ||
    !sameIdentity(current.service, expected.service) ||
    !sameIdentity(current.quarantine, expected.quarantine)
  ) {
    refuse();
  }
}

function targetMatchesSource(path: string, source: FileObservation): boolean {
  const target = readTrustedFile(path, MAX_MANIFEST_BYTES);
  return (
    target !== undefined &&
    target.digest === source.digest &&
    target.dev === source.dev &&
    target.ino === source.ino &&
    target.nlink === 1
  );
}

/** A receipt never substitutes for a final exact target observation. */
function assertTargetStillPrepared(
  stationHome: string,
  source: FileObservation,
): void {
  if (
    !targetMatchesSource(
      join(stationHome, quarantinePathFor(source.digest)),
      source,
    )
  )
    refuse();
}

function sourceMatchesPrepared(
  evidence: PreparedEvidence,
  source: FileObservation,
): boolean {
  return (
    !evidence.target &&
    !evidence.committed &&
    evidence.receipt.digest === source.digest &&
    sameIdentity(evidence.receipt.source, source)
  );
}

function ensureQuarantineDirectory(stationHome: string): {
  readonly path: string;
  readonly identity: Stats;
} {
  const sharedDirectory = join(stationHome, SHARED_QUARANTINE_DIRECTORY);
  if (!existsSync(sharedDirectory)) {
    mkdirSync(sharedDirectory, { recursive: false, mode: 0o700 });
    fsyncDirectorySync(stationHome);
  }
  trustedDirectory(sharedDirectory, 0o700);
  const quarantineDirectory = join(stationHome, LEGACY_QUARANTINE_DIRECTORY);
  if (!existsSync(quarantineDirectory)) {
    mkdirSync(quarantineDirectory, { recursive: false, mode: 0o700 });
    fsyncDirectorySync(sharedDirectory);
  }
  return {
    path: quarantineDirectory,
    // This is the only identity minted during the transaction. It is captured
    // immediately after secure creation/admission, never at final rename.
    identity: trustedDirectory(quarantineDirectory, 0o700),
  };
}

/**
 * Runs the durable transaction.  Expected bad/untrusted states return
 * `refused`; unexpected I/O errors throw and are also fail-closed at the
 * bridge protocol boundary.
 */
export function quarantineLegacyServiceManifest(
  requestedHome: string,
  requestedRoot: string,
  hooks: LegacyServiceManifestQuarantineHooks = {},
): LegacyServiceManifestQuarantineResult {
  try {
    // Resolve only from the supplied shared-root authority; do not consult cwd
    // or STATION_HOME while determining the global profile location.
    const stationRoot = resolveStationRoot({ STATION_ROOT: requestedRoot });
    if (stationRoot !== resolve(requestedRoot)) refuse();
    const stationHome = admitStationRuntimeHome(requestedHome, {
      STATION_ROOT: stationRoot,
    } as NodeJS.ProcessEnv);
    const admittedHome = trustedDirectory(stationHome);
    // Admission and the private-directory check establish that this selected
    // home is safe before asking the shared lifecycle authority to coordinate
    // it. The lease then spans every classification and publication step.
    let lease: ReturnType<typeof acquireStationHomeMaintenanceLease>;
    try {
      lease = acquireStationHomeMaintenanceLease(stationHome, {
        acquireMutationLock: (path) =>
          acquireFileMutationLock(path, {
            timeoutMs: PREPARATION_LOCK_TIMEOUT_MS,
          }),
        // A prior desktop generation can leave its registry claim behind
        // after its sidecar has exited. Reap only a claim whose PID/birth
        // identity proves that prior owner is gone, while maintenance still
        // excludes a new runtime. This preserves the required authority order:
        // maintenance -> registry -> profile. In particular, do not use the
        // broader ephemeral reconciler here: runtime preparation owns neither
        // worktree nor inline records.
        afterMaintenanceAcquired: () => {
          reconcileStaleDesktopSidecars(stationHome, {
            processProbe: hooks.registryProcessProbe,
            mutationLockOptions: { timeoutMs: PREPARATION_LOCK_TIMEOUT_MS },
          });
        },
      });
    } catch (error) {
      if (
        error instanceof StationHomeActiveError ||
        error instanceof StationHomeLifecycleUnavailableError
      ) {
        return { kind: 'refused' };
      }
      return { kind: 'refused' };
    }
    try {
      // Every recovery write (including target-only receipt publication and
      // dual-name unlink) takes the same authority order.  Acquiring registry
      // before profile is deliberate: it is the bounded lock beneath native
      // preparation, and both are released before maintenance is released.
      return withInstanceRegistryMutationLock(
        stationHome,
        () =>
          withProfileStoreLock(() => {
            const serviceDirectory = join(stationHome, 'service');
            let serviceInfo: Stats;
            try {
              serviceInfo = lstatSync(serviceDirectory);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                const evidence = inspectQuarantineEvidence(stationHome);
                if (evidence)
                  return recoverMovedManifest(
                    stationHome,
                    stationRoot,
                    evidence,
                    hooks.registryProcessProbe,
                  );
                return { kind: 'absent' };
              }
              refuse();
            }
            if (
              !serviceInfo!.isDirectory() ||
              serviceInfo!.isSymbolicLink() ||
              !ownerOnly(serviceInfo!)
            )
              refuse();

            // Capture the home admitted before coordination and the original
            // service parent before a prepared receipt or any hook can run.
            // Every later directory check compares against these identities;
            // it must never establish a new parent baseline after a swap.
            const originalParents = {
              home: admittedHome,
              service: serviceInfo!,
            };

            const sourcePath = join(stationHome, LEGACY_SOURCE_RELATIVE_PATH);
            const source = readTrustedFile(sourcePath, MAX_MANIFEST_BYTES);
            const evidence = inspectQuarantineEvidence(stationHome, source);
            if (!source) {
              return evidence
                ? recoverMovedManifest(
                    stationHome,
                    stationRoot,
                    evidence,
                    hooks.registryProcessProbe,
                  )
                : { kind: 'absent' };
            }
            if (evidence?.target) {
              if (
                evidence.committed ||
                source.digest !== evidence.target.digest ||
                !sameIdentity(source, evidence.target) ||
                source.nlink !== 2 ||
                evidence.target.nlink !== 2
              )
                return { kind: 'refused' };
              // A cross-directory rename replay can expose both names after crash.
              // The target directory is acknowledged first, then the source link is
              // removed; only the exact shared inode is eligible.
              fsyncDirectorySync(evidence.directory);
              assertNoCurrentLegacyAuthority(
                stationRoot,
                stationHome,
                hooks.registryProcessProbe,
              );
              rmSync(sourcePath);
              fsyncDirectorySync(serviceDirectory);
              const target = readTrustedFile(
                join(stationHome, quarantinePathFor(evidence.receipt.digest)),
                MAX_MANIFEST_BYTES,
              );
              if (
                target?.nlink !== 1 ||
                !sameIdentity(target, evidence.receipt.source)
              )
                refuse();
              return recoverMovedManifest(
                stationHome,
                stationRoot,
                {
                  ...evidence,
                  target,
                },
                hooks.registryProcessProbe,
              );
            }
            if (source.nlink !== 1) refuse();
            if (!isExactLegacyManifest(parseJson(source.raw), stationRoot))
              refuse();
            // A durable prepared event with the original source still present is
            // the one resumable pre-rename state. Every other evidence/source pair
            // is a second variant or conflict and refuses.
            if (evidence && !sourceMatchesPrepared(evidence, source))
              return { kind: 'refused' };
            const lockedEvidence = inspectQuarantineEvidence(stationHome);
            if (
              (!evidence && lockedEvidence) ||
              (evidence &&
                (!lockedEvidence ||
                  !sourceMatchesPrepared(lockedEvidence, source) ||
                  !sameReceipt(lockedEvidence.receipt, evidence.receipt)))
            ) {
              return { kind: 'refused' };
            }
            assertNoCurrentLegacyAuthority(
              stationRoot,
              stationHome,
              hooks.registryProcessProbe,
            );
            const quarantine = ensureQuarantineDirectory(stationHome);
            const quarantineDirectory = quarantine.path;
            const parents: QuarantineDirectoryBaseline = {
              ...originalParents,
              quarantine: quarantine.identity,
            };
            assertDirectoriesUnchanged(
              stationHome,
              serviceDirectory,
              quarantineDirectory,
              parents,
            );
            const targetPath = join(
              stationHome,
              quarantinePathFor(source.digest),
            );
            const preparedPath = join(
              stationHome,
              receiptPathFor(source.digest),
            );
            if (
              readTrustedFile(targetPath, MAX_MANIFEST_BYTES) !== undefined ||
              (readReceipt(preparedPath) !== undefined && !lockedEvidence)
            ) {
              return { kind: 'refused' };
            }
            if (!lockedEvidence) {
              writeReceipt(
                preparedPath,
                receiptFor('prepared', source),
                quarantineDirectory,
                {
                  beforeFsync: hooks.beforePreparedFsync,
                  afterFsyncBeforeLink: hooks.afterPreparedFsyncBeforeLink,
                  afterLinkBeforeDirectoryFsync:
                    hooks.afterPreparedLinkBeforeDirectoryFsync,
                },
              );
            }
            hooks.afterPreparedBeforeRename?.();

            hooks.beforeRename?.();
            // Cooperating writers are blocked by the locks above. Recheck the
            // policy facts as well so a non-cooperating direct mutation made
            // by a failpoint cannot authorize the record behind our back.
            assertNoCurrentLegacyAuthority(
              stationRoot,
              stationHome,
              hooks.registryProcessProbe,
            );
            assertSourceStillObserved(sourcePath, source);
            if (readTrustedFile(targetPath, MAX_MANIFEST_BYTES) !== undefined)
              return { kind: 'refused' };
            // Recheck after the descriptor/path observation: an identical
            // byte replacement must not inherit the prepared inode receipt.
            assertDirectoriesUnchanged(
              stationHome,
              serviceDirectory,
              quarantineDirectory,
              parents,
            );
            assertSourceStillObserved(sourcePath, source);
            hooks.afterFinalObservationBeforeRename?.();
            assertDirectoriesUnchanged(
              stationHome,
              serviceDirectory,
              quarantineDirectory,
              parents,
            );
            assertSourceStillObserved(sourcePath, source);
            renameSync(sourcePath, targetPath);
            assertDirectoriesUnchanged(
              stationHome,
              serviceDirectory,
              quarantineDirectory,
              parents,
            );
            if (!targetMatchesSource(targetPath, source)) refuse();
            hooks.afterRenameBeforeSourceFsync?.();
            fsyncDirectorySync(quarantineDirectory);
            hooks.afterSourceFsyncBeforeTargetFsync?.();
            fsyncDirectorySync(serviceDirectory);
            if (!targetMatchesSource(targetPath, source)) refuse();

            hooks.afterRenameBeforeCommit?.();
            assertTargetStillPrepared(stationHome, source);
            // A direct non-cooperating writer can still change either source
            // while the durable move is in progress.  Do not publish the
            // commit marker unless the current profile and birth-live registry
            // still deny ownership at the exact commit boundary.
            assertNoCurrentLegacyAuthority(
              stationRoot,
              stationHome,
              hooks.registryProcessProbe,
            );
            writeReceipt(
              join(stationHome, committedPathFor(source.digest)),
              receiptFor('committed', source),
              quarantineDirectory,
              {
                afterFsyncBeforeLink: () => {
                  hooks.afterCommittedFsyncBeforeLink?.();
                  assertTargetStillPrepared(stationHome, source);
                },
                afterLinkBeforeDirectoryFsync: () => {
                  hooks.afterCommittedLinkBeforeDirectoryFsync?.();
                  assertTargetStillPrepared(stationHome, source);
                },
              },
            );
            // `writeReceipt` has removed its temporary and synced the final
            // committed publication. Only an exact one-link target may report
            // the new effect.
            assertTargetStillPrepared(stationHome, source);
            return { kind: 'new' };
          }, stationRoot),
        { timeoutMs: PREPARATION_LOCK_TIMEOUT_MS },
      );
    } finally {
      lease.release();
    }
  } catch (error) {
    if (error instanceof LegacyServiceManifestRefusal)
      return { kind: 'refused' };
    throw error;
  }
}
