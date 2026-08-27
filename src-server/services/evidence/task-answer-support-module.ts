/**
 * Explicit answer-support authority.  This is intentionally separate from the
 * public TrustBundleService: that service is a diagnostic panel seam, whereas
 * this module authorizes one immutable answer anchor and one exact, owner-local
 * Surface claim without ever returning filesystem or report identity.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import {
  isCanonicalTaskAnswerSupportId,
  MAX_TASK_REFERENCE_TARGET_LENGTH,
  type StationAnswerBinding,
  type TaskAnswerSupportAssociation,
} from '@kontourai/station-contracts';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  buildAnswerCardProjection,
  buildTrustReport,
  type FoundAnswerCardProjection,
  type TrustBundle,
  validateTrustBundle,
} from '@kontourai/surface';
import {
  buildAnswerAssessmentProjection,
  type SurfaceAssessmentRead,
} from '@kontourai/surface/basis';
import { qualifiesStationAnswerContent } from './station-answer-assessment-profile.js';

const MAX_JSON_BYTES = 1_048_576;
const MAX_BUNDLES = 100;
const MAX_CLAIMS = 1_000;
const MAX_RECORDS = 10_000;
const MAX_PER_TASK = 100;
const OPAQUE_ID_MAX_BYTES = MAX_TASK_REFERENCE_TARGET_LENGTH;

export class TaskAnswerSupportUnavailableError extends Error {}
export class TaskAnswerSupportNotFoundError extends Error {}
export class TaskAnswerSupportConflictError extends Error {}

export type AuthorizedAnswerAnchor = {
  taskId: string;
  referenceId: string;
  projectSlug: string;
  sessionId: string;
  turnId: string;
  binding: StationAnswerBinding;
};

export interface AnswerAnchorReader {
  authorize(
    taskId: string,
    referenceId: string,
    authority: SessionReadAuthority,
  ): Promise<AuthorizedAnswerAnchor | 'not-found' | 'unavailable'>;
}

export type BundleChoice = { id: string };
export type ClaimChoice = { id: string };
/** Server response adds Surface's published card shape without widening contracts. */
export type TaskAnswerSupportStandingWithCard =
  | { state: 'unassessed' }
  | {
      state: 'available';
      associationId: string;
      revision: number;
      card: FoundAnswerCardProjection;
    }
  | {
      state:
        | 'claim-missing'
        | 'corrupt'
        | 'unsupported-version'
        | 'unavailable';
    };
type ClaimRead =
  | { state: 'found'; card: FoundAnswerCardProjection }
  | {
      state:
        | 'claim-missing'
        | 'corrupt'
        | 'unsupported-version'
        | 'not-found'
        | 'unavailable';
    };

export interface ProjectTrustReportReader {
  listBundles(projectSlug: string): Promise<BundleChoice[]>;
  listClaims(
    projectSlug: string,
    bundleId: string,
  ): Promise<ClaimChoice[] | 'not-found' | 'unavailable'>;
  readClaim(
    projectSlug: string,
    bundleId: string,
    claimId: string,
  ): Promise<ClaimRead>;
  readAssessment(
    projectSlug: string,
    bundleId: string,
    claimId: string,
    binding: StationAnswerBinding,
  ): Promise<SurfaceAssessmentRead>;
}

/** Runtime-only capability supplied exclusively by personal-mode composition. */
export const PERSONAL_PROJECT_TRUST_CAPABILITY = Object.freeze({
  kind: 'personal-project-trust' as const,
});
export type PersonalProjectTrustCapability =
  typeof PERSONAL_PROJECT_TRUST_CAPABILITY;
/** Narrow deterministic observation seam for replacement-race contract tests. */
export interface TrustBundleReadObservation {
  beforeRead?(path: string): void;
  afterOpen?(path: string): void;
  afterRead?(path: string): void;
  /** Test-only simulation of a platform with no O_NOFOLLOW constant. */
  noFollow?: number | null;
}
type PathFlavor = {
  resolve(path: string): string;
  parse(path: string): { root: string };
  join(...parts: string[]): string;
  sep: string;
};

/** @internal Pure path seam for native and win32 ancestor safety tests. */
export function enumerateOwnedAncestors(
  path: string,
  flavor: PathFlavor = { resolve, parse, join, sep },
): string[] {
  const absolute = flavor.resolve(path);
  const root = flavor.parse(absolute).root;
  const parts = absolute.slice(root.length).split(flavor.sep).filter(Boolean);
  const result = [root];
  let current = root;
  for (const part of parts) {
    current = flavor.join(current, part);
    result.push(current);
  }
  return result;
}

/** @internal Makes the no-follow fallback independently testable. */
export function answerSupportReadOpenFlags(
  noFollow: number | null | undefined = fsConstants.O_NOFOLLOW,
): number {
  return fsConstants.O_RDONLY | (noFollow ?? 0);
}

type Locations = {
  workspacePath?: string;
  pluginDataDir?: string;
  veritasEvidenceDir?: string | string[];
};
type Source = {
  kind: 'workspace' | 'plugin' | 'veritas';
  fileName: string;
  plugin?: string;
  veritasRoot?: 'current' | 'legacy';
  path: string;
};
type SourceScan =
  | { state: 'found'; sources: Source[] }
  | { state: 'unavailable' };
type DirectoryEntries =
  | { state: 'missing'; entries: [] }
  | {
      state: 'found';
      entries: Array<{ name: string; directory: boolean; file: boolean }>;
    }
  | { state: 'unavailable'; entries: [] };

/** Owner-derived, source-qualified bundle reader.  Client data never becomes a path. */
export class CanonicalProjectTrustReportReader
  implements ProjectTrustReportReader
{
  constructor(
    private readonly locationsForProject: (
      slug: string,
    ) => Locations | undefined,
    private readonly capability: PersonalProjectTrustCapability,
    private readonly observation?: TrustBundleReadObservation,
  ) {}

  async listBundles(projectSlug: string): Promise<BundleChoice[]> {
    this.assertPersonalCapability();
    const sources = this.sources(projectSlug);
    if (sources.state === 'unavailable')
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    // Bound prior to map/sort: a hostile directory must not make the list
    // endpoint allocate or compare an unbounded number of candidate names.
    return sources.sources.slice(0, MAX_BUNDLES).map((source) => {
      const id = encodeBundleId(source);
      if (!isCanonicalTaskAnswerSupportId(id))
        throw new TaskAnswerSupportUnavailableError(
          'Answer support unavailable',
        );
      return { id };
    });
  }

  async listClaims(
    projectSlug: string,
    bundleId: string,
  ): Promise<ClaimChoice[] | 'not-found' | 'unavailable'> {
    this.assertPersonalCapability();
    const read = this.readBundle(projectSlug, bundleId);
    if (read.state !== 'found')
      return read.state === 'unavailable' ? 'unavailable' : 'not-found';
    return read.report.claims
      .slice(0, MAX_CLAIMS)
      .map((claim) => ({ id: claim.id }));
  }

  async readClaim(
    projectSlug: string,
    bundleId: string,
    claimId: string,
  ): Promise<ClaimRead> {
    this.assertPersonalCapability();
    if (!validOpaqueId(claimId)) return { state: 'unavailable' };
    const read = this.readBundle(projectSlug, bundleId);
    if (read.state !== 'found') return read;
    try {
      const card = buildAnswerCardProjection(read.report, claimId);
      return card.found ? { state: 'found', card } : { state: 'claim-missing' };
    } catch {
      return { state: 'corrupt' };
    }
  }

  async readAssessment(
    projectSlug: string,
    bundleId: string,
    claimId: string,
    binding: StationAnswerBinding,
  ): Promise<SurfaceAssessmentRead> {
    this.assertPersonalCapability();
    const observedAt = new Date().toISOString();
    const read = this.readBundle(projectSlug, bundleId);
    if (read.state === 'found') {
      try {
        const value = buildAnswerAssessmentProjection(read.report, claimId);
        return value.found &&
          qualifiesStationAnswerContent(read.bundle, claimId, binding)
          ? {
              owner: { authority: '@kontourai/surface' },
              state: 'available',
              observedAt,
              value,
            }
          : value.found
            ? {
                owner: { authority: '@kontourai/surface' },
                state: 'unsupported-version',
                observedAt,
              }
            : {
                owner: { authority: '@kontourai/surface' },
                state: 'corrupt',
                observedAt,
              };
      } catch {
        return {
          owner: { authority: '@kontourai/surface' },
          state: 'corrupt',
          observedAt,
        };
      }
    }
    const state =
      read.state === 'unsupported-version'
        ? 'unsupported-version'
        : read.state === 'corrupt'
          ? 'corrupt'
          : read.state === 'unavailable'
            ? 'unavailable'
            : 'restricted';
    return { owner: { authority: '@kontourai/surface' }, state, observedAt };
  }

  private sources(projectSlug: string): SourceScan {
    let locations: Locations | undefined;
    try {
      locations = this.locationsForProject(projectSlug);
    } catch {
      return { state: 'unavailable' };
    }
    // A project with no configured source locations is an authorized empty
    // collection. It is distinct from an OS failure while enumerating one.
    if (!locations) return { state: 'found', sources: [] };
    const result: Source[] = [];
    if (locations.workspacePath) {
      const root = resolve(locations.workspacePath);
      const dir = ownedChild(root, '.station', 'trust-bundles');
      const files = this.files(dir, (fileName) => ({
        kind: 'workspace',
        fileName,
        path: ownedChild(dir, fileName),
      }));
      if (files.state === 'unavailable') return files;
      result.push(...files.sources);
    }
    if (locations.pluginDataDir) {
      const root = resolve(locations.pluginDataDir);
      const plugins = safeDirectoryEntries(root);
      if (plugins.state === 'unavailable') return { state: 'unavailable' };
      for (const entry of plugins.entries) {
        if (!entry.directory || !validSegment(entry.name)) continue;
        const dir = ownedChild(root, entry.name, 'trust-bundles');
        const files = this.files(dir, (fileName) => ({
          kind: 'plugin',
          plugin: entry.name,
          fileName,
          path: ownedChild(dir, fileName),
        }));
        if (files.state === 'unavailable') return files;
        result.push(...files.sources);
        if (result.length >= MAX_BUNDLES) break;
      }
    }
    for (const [index, root] of [locations.veritasEvidenceDir]
      .flat()
      .filter(Boolean)
      .entries() as IterableIterator<[number, string]>) {
      const dir = resolve(root);
      const files = this.files(
        dir,
        (fileName) => ({
          kind: 'veritas',
          fileName,
          veritasRoot: index === 0 ? 'current' : 'legacy',
          path: ownedChild(dir, fileName),
        }),
        true,
      );
      if (files.state === 'unavailable') return files;
      result.push(...files.sources);
      if (result.length >= MAX_BUNDLES) break;
    }
    return {
      state: 'found',
      sources: result
        .slice(0, MAX_BUNDLES)
        .sort((a, b) => encodeBundleId(a).localeCompare(encodeBundleId(b))),
    };
  }

  private assertPersonalCapability(): void {
    if (this.capability !== PERSONAL_PROJECT_TRUST_CAPABILITY)
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  }

  private files(
    dir: string,
    source: (fileName: string) => Source,
    veritas = false,
  ): SourceScan {
    const entries = safeDirectoryEntries(dir);
    if (entries.state === 'unavailable') return { state: 'unavailable' };
    return {
      state: 'found',
      sources: entries.entries
        .filter(
          (entry) =>
            entry.file &&
            entry.name.endsWith('.json') &&
            validSegment(entry.name) &&
            (!veritas || entry.name.startsWith('veritas-')),
        )
        .slice(0, MAX_BUNDLES)
        .map((entry) => source(entry.name)),
    };
  }

  private readBundle(
    projectSlug: string,
    bundleId: string,
  ):
    | {
        state: 'found';
        bundle: TrustBundle;
        report: ReturnType<typeof buildTrustReport>;
      }
    | {
        state: 'corrupt' | 'unsupported-version' | 'not-found' | 'unavailable';
      } {
    const decoded = decodeBundleId(bundleId);
    if (!decoded) return { state: 'not-found' };
    let source: Source | undefined;
    try {
      const sources = this.sources(projectSlug);
      if (sources.state === 'unavailable') return { state: 'unavailable' };
      source = sources.sources.find((candidate) =>
        sameSource(candidate, decoded),
      );
    } catch {
      return { state: 'unavailable' };
    }
    if (!source) return { state: 'not-found' };
    let raw: string;
    try {
      this.observation?.beforeRead?.(source.path);
      raw = readBoundedRegularFile(source.path, this.observation);
    } catch {
      return { state: 'unavailable' };
    }
    try {
      let value: unknown = JSON.parse(raw);
      if (source.kind === 'veritas')
        value = (value as { trust?: { bundle?: unknown } })?.trust?.bundle;
      if (!value || typeof value !== 'object') return { state: 'corrupt' };
      const schemaVersion = (value as { schemaVersion?: unknown })
        .schemaVersion;
      if (typeof schemaVersion !== 'number') return { state: 'corrupt' };
      if (
        !Number.isInteger(schemaVersion) ||
        ![2, 3, 4, 5, 6, 7].includes(schemaVersion)
      )
        return { state: 'unsupported-version' };
      const bundle = validateTrustBundle(value);
      return {
        state: 'found',
        bundle,
        report: buildTrustReport(bundle, { id: bundleId }),
      };
    } catch {
      // Once bytes have been read successfully, malformed JSON or Surface
      // rejection is corrupt. Source disappearance and access faults are
      // classified by the guarded file reader above and never become corrupt.
      return { state: 'corrupt' };
    }
  }
}

type Stored = TaskAnswerSupportAssociation & {
  sessionId: string;
  turnId: string;
  projectSlug: string;
  bundleId: string;
  claimId: string;
};
type StoreDocument = { schemaVersion: 1; records: Stored[] };
/** Internal fault-injection seam; runtime never supplies it. */
interface StoreIo {
  write?: (
    fd: number,
    bytes: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  afterTempClose?: (tempPath: string) => void;
  afterRename?: (indexPath: string) => void;
}
type StoredMutation = Omit<
  Stored,
  'id' | 'revision' | 'createdAt' | 'updatedAt' | 'schemaVersion' | 'kind'
>;

function sameImmutableAnchor(a: Stored, b: StoredMutation): boolean {
  return (
    a.taskId === b.taskId &&
    a.answerReferenceId === b.answerReferenceId &&
    a.projectSlug === b.projectSlug &&
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId
  );
}

/** Strict durable IDs-and-lifecycle ledger; it does not write TaskGraph. */
export class TaskAnswerSupportStore {
  private readonly path: string;
  private readonly home: string;
  private readonly root: string;
  constructor(
    homeDir: string,
    private readonly io: StoreIo = {},
  ) {
    this.home = resolve(homeDir);
    this.root = ownedChild(this.home, 'task-answer-support');
    this.path = ownedChild(this.root, 'index.json');
  }
  async readForTask(taskId: string): Promise<Stored[]> {
    return this.withLock(() =>
      this.read().records.filter((record) => record.taskId === taskId),
    );
  }
  async create(input: StoredMutation): Promise<Stored> {
    return this.withLock(() => {
      const doc = this.read();
      const prior = doc.records.find(
        (item) =>
          item.taskId === input.taskId &&
          item.answerReferenceId === input.answerReferenceId,
      );
      if (prior) {
        if (
          sameImmutableAnchor(prior, input) &&
          prior.bundleId === input.bundleId &&
          prior.claimId === input.claimId
        )
          return prior;
        throw new TaskAnswerSupportConflictError('Answer support conflicts');
      }
      if (
        doc.records.length >= MAX_RECORDS ||
        doc.records.filter((item) => item.taskId === input.taskId).length >=
          MAX_PER_TASK
      )
        throw new TaskAnswerSupportUnavailableError(
          'Answer support unavailable',
        );
      const now = new Date().toISOString();
      const record: Stored = {
        schemaVersion: 1,
        kind: 'answer-support',
        id: randomUUID(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...input,
      };
      doc.records.push(record);
      this.write(doc);
      return record;
    });
  }
  async replace(
    input: StoredMutation & { expectedRevision: number },
  ): Promise<Stored> {
    return this.withLock(() => {
      const doc = this.read();
      const prior = doc.records.find(
        (item) =>
          item.taskId === input.taskId &&
          item.answerReferenceId === input.answerReferenceId,
      );
      if (!prior)
        throw new TaskAnswerSupportNotFoundError('Answer support not found');
      if (!sameImmutableAnchor(prior, input))
        throw new TaskAnswerSupportConflictError('Answer support conflicts');
      if (prior.revision !== input.expectedRevision) {
        if (
          prior.revision === input.expectedRevision + 1 &&
          prior.bundleId === input.bundleId &&
          prior.claimId === input.claimId
        )
          return prior;
        throw new TaskAnswerSupportConflictError(
          'Answer support revision conflicts',
        );
      }
      Object.assign(prior, {
        bundleId: input.bundleId,
        claimId: input.claimId,
        revision: prior.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      this.write(doc);
      return prior;
    });
  }
  async remove(
    taskId: string,
    referenceId: string,
    expectedRevision: number,
  ): Promise<void> {
    return this.withLock(() => {
      const doc = this.read();
      const at = doc.records.findIndex(
        (item) =>
          item.taskId === taskId && item.answerReferenceId === referenceId,
      );
      if (at < 0) return;
      if (doc.records[at].revision !== expectedRevision)
        throw new TaskAnswerSupportConflictError(
          'Answer support revision conflicts',
        );
      doc.records.splice(at, 1);
      this.write(doc);
    });
  }
  private async withLock<T>(work: () => T): Promise<T> {
    this.ensureRoot();
    const release = await acquireFileMutationLockAsync(`${this.path}.mutation`);
    try {
      return work();
    } finally {
      await release();
    }
  }
  private read(): StoreDocument {
    try {
      if (!safeFileExists(this.path)) return { schemaVersion: 1, records: [] };
      const raw = readBoundedRegularFile(this.path);
      const parsed: unknown = JSON.parse(raw);
      assertStore(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof TaskAnswerSupportUnavailableError) throw error;
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    }
  }
  private ensureRoot(): void {
    // The Station home is the ownership anchor. Do not create through a
    // symlinked/malformed home or let mkdir({recursive}) cross one.
    assertOwnedDirectory(this.home);
    try {
      mkdirSync(this.root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new TaskAnswerSupportUnavailableError(
          'Answer support unavailable',
        );
    }
    assertOwnedDirectory(this.root);
  }
  private write(doc: StoreDocument): void {
    assertStore(doc);
    const encoded = JSON.stringify(doc);
    if (Buffer.byteLength(encoded) > MAX_JSON_BYTES)
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    const temp = join(dirname(this.path), `.${randomUUID()}.tmp`);
    try {
      const flags =
        fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0);
      const descriptor = openSync(temp, flags, 0o600);
      let writtenIdentity: FileIdentity | undefined;
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.isSymbolicLink())
          throw new TaskAnswerSupportUnavailableError(
            'Answer support unavailable',
          );
        const bytes = Buffer.from(encoded, 'utf8');
        let offset = 0;
        while (offset < bytes.length) {
          const written = (this.io.write ?? writeSync)(
            descriptor,
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (written <= 0)
            throw new TaskAnswerSupportUnavailableError(
              'Answer support unavailable',
            );
          offset += written;
        }
        fsyncSync(descriptor);
        assertNoSymlinkAncestors(temp);
        const after = fstatSync(descriptor);
        if (!sameFileIdentity(after, fileIdentity(temp)))
          throw new TaskAnswerSupportUnavailableError(
            'Answer support unavailable',
          );
        writtenIdentity = after;
      } finally {
        closeSync(descriptor);
      }
      this.io.afterTempClose?.(temp);
      assertNoSymlinkAncestors(temp);
      if (
        !writtenIdentity ||
        !sameFileIdentity(writtenIdentity, fileIdentity(temp))
      )
        throw new TaskAnswerSupportUnavailableError(
          'Answer support unavailable',
        );
      renameSync(temp, this.path);
      this.io.afterRename?.(this.path);
      fsyncDirectorySync(dirname(this.path));
      // A successful rename is not enough when a filesystem reports an
      // uncertain post-commit state: prove the strict document is readable.
      this.read();
    } catch {
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
}

export class TaskAnswerSupportModule {
  constructor(
    private readonly input: {
      anchors: AnswerAnchorReader;
      reports: ProjectTrustReportReader;
      store: TaskAnswerSupportStore;
    },
  ) {}
  async bundles(
    taskId: string,
    referenceId: string,
    authority: SessionReadAuthority,
  ): Promise<BundleChoice[] | 'not-found' | 'unavailable'> {
    const anchor = await this.anchor(taskId, referenceId, authority);
    return typeof anchor === 'string'
      ? anchor
      : this.input.reports.listBundles(anchor.projectSlug);
  }
  async claims(
    taskId: string,
    referenceId: string,
    bundleId: string,
    authority: SessionReadAuthority,
  ): Promise<ClaimChoice[] | 'not-found' | 'unavailable'> {
    const anchor = await this.anchor(taskId, referenceId, authority);
    if (typeof anchor === 'string') return anchor;
    return this.input.reports.listClaims(anchor.projectSlug, bundleId);
  }
  async create(
    taskId: string,
    referenceId: string,
    bundleId: string,
    claimId: string,
    authority: SessionReadAuthority,
  ): Promise<TaskAnswerSupportAssociation> {
    const anchor = await this.requireClaim(
      taskId,
      referenceId,
      bundleId,
      claimId,
      authority,
    );
    const {
      referenceId: _referenceId,
      binding: _binding,
      ...recordAnchor
    } = anchor;
    return publicRecord(
      await this.input.store.create({
        ...recordAnchor,
        answerReferenceId: referenceId,
        bundleId,
        claimId,
      }),
    );
  }
  async replace(
    taskId: string,
    referenceId: string,
    bundleId: string,
    claimId: string,
    expectedRevision: number,
    authority: SessionReadAuthority,
  ): Promise<TaskAnswerSupportAssociation> {
    const anchor = await this.requireClaim(
      taskId,
      referenceId,
      bundleId,
      claimId,
      authority,
    );
    const {
      referenceId: _referenceId,
      binding: _binding,
      ...recordAnchor
    } = anchor;
    return publicRecord(
      await this.input.store.replace({
        ...recordAnchor,
        answerReferenceId: referenceId,
        bundleId,
        claimId,
        expectedRevision,
      }),
    );
  }
  async remove(
    taskId: string,
    referenceId: string,
    expectedRevision: number,
    authority: SessionReadAuthority,
  ): Promise<void> {
    await this.requireAnchor(taskId, referenceId, authority);
    await this.input.store.remove(taskId, referenceId, expectedRevision);
  }
  async standing(
    taskId: string,
    referenceId: string,
    authority: SessionReadAuthority,
  ): Promise<TaskAnswerSupportStandingWithCard> {
    // Read standing is deliberately ordered. In particular no stored join is
    // examined until the exact Task/turn anchor has been reauthorized.
    let anchor: AuthorizedAnswerAnchor;
    try {
      anchor = await this.requireAnchor(taskId, referenceId, authority);
    } catch (error) {
      if (error instanceof TaskAnswerSupportNotFoundError)
        return { state: 'unavailable' };
      throw error;
    }
    let record: Stored | undefined;
    try {
      record = (await this.input.store.readForTask(taskId)).find(
        (item) => item.answerReferenceId === referenceId,
      );
      if (!record) return { state: 'unassessed' };
      if (
        record.projectSlug !== anchor.projectSlug ||
        record.sessionId !== anchor.sessionId ||
        record.turnId !== anchor.turnId
      )
        return { state: 'unavailable' };
      const claim = await this.input.reports.readClaim(
        anchor.projectSlug,
        record.bundleId,
        record.claimId,
      );
      return claim.state === 'found'
        ? {
            state: 'available',
            associationId: record.id,
            revision: record.revision,
            card: claim.card,
          }
        : claim.state === 'not-found'
          ? { state: 'unavailable' }
          : claim.state === 'unavailable'
            ? (() => {
                throw new TaskAnswerSupportUnavailableError(
                  'Answer support unavailable',
                );
              })()
            : { state: claim.state };
    } catch (error) {
      if (error instanceof TaskAnswerSupportUnavailableError) throw error;
      return { state: 'unavailable' };
    }
  }
  /** Task-local override reader. Its presence deliberately suppresses producer fallback. */
  async assessment(
    taskId: string,
    referenceId: string,
    authority: SessionReadAuthority,
  ): Promise<SurfaceAssessmentRead | null> {
    const anchor = await this.requireAnchor(taskId, referenceId, authority);
    const record = (await this.input.store.readForTask(taskId)).find(
      (item) => item.answerReferenceId === referenceId,
    );
    if (!record) return null;
    if (
      record.projectSlug !== anchor.projectSlug ||
      record.sessionId !== anchor.sessionId ||
      record.turnId !== anchor.turnId
    )
      return {
        owner: { authority: '@kontourai/surface' },
        state: 'restricted',
        observedAt: new Date().toISOString(),
      };
    return this.input.reports.readAssessment(
      anchor.projectSlug,
      record.bundleId,
      record.claimId,
      anchor.binding,
    );
  }
  private async anchor(
    taskId: string,
    referenceId: string,
    authority: SessionReadAuthority,
  ) {
    return this.input.anchors.authorize(taskId, referenceId, authority);
  }
  private async requireClaim(
    taskId: string,
    referenceId: string,
    bundleId: string,
    claimId: string,
    authority: SessionReadAuthority,
  ): Promise<AuthorizedAnswerAnchor> {
    if (!isCanonicalTaskAnswerSupportId(bundleId) || !validOpaqueId(claimId))
      throw new TaskAnswerSupportNotFoundError('Answer support not found');
    const anchor = await this.requireAnchor(taskId, referenceId, authority);
    const read = await this.input.reports.readClaim(
      anchor.projectSlug,
      bundleId,
      claimId,
    );
    if (read.state === 'unavailable')
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    if (read.state !== 'found')
      throw new TaskAnswerSupportNotFoundError('Answer support not found');
    return anchor;
  }
  private async requireAnchor(
    taskId: string,
    referenceId: string,
    authority: SessionReadAuthority,
  ): Promise<AuthorizedAnswerAnchor> {
    const anchor = await this.anchor(taskId, referenceId, authority);
    if (anchor === 'unavailable')
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    if (anchor === 'not-found')
      throw new TaskAnswerSupportNotFoundError('Answer support not found');
    return anchor;
  }
}

function publicRecord(record: Stored): TaskAnswerSupportAssociation {
  const {
    sessionId: _sessionId,
    turnId: _turnId,
    projectSlug: _projectSlug,
    bundleId: _bundleId,
    claimId: _claimId,
    ...safe
  } = record;
  return safe;
}
function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= OPAQUE_ID_MAX_BYTES
  );
}
function validSegment(value: string): boolean {
  return (
    validOpaqueId(value) &&
    value === value.trim() &&
    !value.includes('\\') &&
    !value.includes('/') &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    value !== '.' &&
    value !== '..'
  );
}
function encodeBundleId(
  source: Pick<Source, 'kind' | 'fileName' | 'plugin' | 'veritasRoot'>,
): string {
  return `sb1.${Buffer.from(
    JSON.stringify([
      source.kind,
      source.plugin ?? '',
      source.veritasRoot ?? '',
      source.fileName,
    ]),
  ).toString('base64url')}`;
}
function decodeBundleId(
  value: string,
): Pick<Source, 'kind' | 'fileName' | 'plugin' | 'veritasRoot'> | undefined {
  if (!isCanonicalTaskAnswerSupportId(value) || !value.startsWith('sb1.'))
    return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value.slice(4), 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      !['workspace', 'plugin', 'veritas'].includes(parsed[0]) ||
      typeof parsed[1] !== 'string' ||
      typeof parsed[2] !== 'string' ||
      typeof parsed[3] !== 'string' ||
      !validSegment(parsed[3]) ||
      (parsed[0] === 'plugin' && !validSegment(parsed[1]))
    )
      return undefined;
    if (
      (parsed[0] === 'veritas' && !['current', 'legacy'].includes(parsed[2])) ||
      (parsed[0] === 'workspace' && (parsed[1] !== '' || parsed[2] !== '')) ||
      (parsed[0] === 'plugin' && parsed[2] !== '')
    )
      return undefined;
    const decoded = {
      kind: parsed[0] as Source['kind'],
      plugin: parsed[1] || undefined,
      veritasRoot: (parsed[2] || undefined) as
        | Source['veritasRoot']
        | undefined,
      fileName: parsed[3],
    };
    return encodeBundleId(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}
function isCanonicalBundleId(value: unknown): value is string {
  return typeof value === 'string' && decodeBundleId(value) !== undefined;
}
function sameSource(
  a: Source,
  b: Pick<Source, 'kind' | 'fileName' | 'plugin' | 'veritasRoot'>,
): boolean {
  return (
    a.kind === b.kind &&
    a.fileName === b.fileName &&
    a.plugin === b.plugin &&
    a.veritasRoot === b.veritasRoot
  );
}
function safeDirectoryEntries(path: string): DirectoryEntries {
  try {
    assertNoSymlinkAncestors(path);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return { state: 'unavailable', entries: [] };
    const directory = opendirSync(path);
    try {
      const entries: Array<{
        name: string;
        directory: boolean;
        file: boolean;
      }> = [];
      while (true) {
        const entry = directory.readSync();
        if (!entry) break;
        if (entries.length >= MAX_BUNDLES)
          return { state: 'unavailable', entries: [] };
        entries.push({
          name: entry.name,
          directory: entry.isDirectory(),
          file: entry.isFile(),
        });
      }
      return {
        state: 'found',
        entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
      };
    } finally {
      directory.closeSync();
    }
  } catch (error) {
    if (isMissing(error)) return { state: 'missing', entries: [] };
    return { state: 'unavailable', entries: [] };
  }
}
function safeFileExists(path: string): boolean {
  try {
    assertNoSymlinkAncestors(path);
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  }
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
/** Build an owned descendant only from canonical non-empty path components. */
function ownedChild(root: string, ...parts: string[]): string {
  if (!parts.every(validSegment))
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, ...parts);
  if (!candidate.startsWith(`${absoluteRoot}${sep}`))
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  return candidate;
}
function assertNoSymlinkAncestors(path: string): void {
  for (const current of enumerateOwnedAncestors(path)) {
    const stat =
      lstatSync(
        current,
      ); /* macOS exposes the kernel-owned /var alias before user-controlled paths. */
    if (stat.isSymbolicLink() && current !== '/var')
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  }
}
/** Shared guarded read for Station-owned immutable JSON artifacts. */
export function readBoundedRegularFile(
  path: string,
  observation?: TrustBundleReadObservation,
): string {
  assertNoSymlinkAncestors(path);
  // Windows lacks O_NOFOLLOW on some supported Node/filesystem combinations.
  // Its fallback is guarded by pre/post component and pathname identity checks;
  // a platform that does provide O_NOFOLLOW receives the kernel check too.
  const pathBefore = fileIdentity(path);
  let fd: number;
  try {
    fd = openSync(path, answerSupportReadOpenFlags(observation?.noFollow));
  } catch {
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  }
  try {
    observation?.afterOpen?.(path);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_JSON_BYTES)
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    const raw = readFileSync(fd, 'utf8');
    observation?.afterRead?.(path);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      Buffer.byteLength(raw) > MAX_JSON_BYTES
    )
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    // Recheck every component and the pathname after the read. This detects
    // final or intermediate replacement even when the opened descriptor still
    // points at a regular file with unchanged bytes.
    assertNoSymlinkAncestors(path);
    const pathAfter = fileIdentity(path);
    if (
      !sameFileIdentity(pathBefore, pathAfter) ||
      !sameFileIdentity(pathBefore, before)
    )
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    return raw;
  } catch (error) {
    if (error instanceof TaskAnswerSupportUnavailableError) throw error;
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  } finally {
    closeSync(fd);
  }
}
type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};
function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}
function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function assertStore(value: unknown): asserts value is StoreDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  const doc = value as { schemaVersion?: unknown; records?: unknown };
  if (
    !hasExactKeys(doc as Record<string, unknown>, ['schemaVersion', 'records'])
  )
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  if (
    doc.schemaVersion !== 1 ||
    !Array.isArray(doc.records) ||
    doc.records.length > MAX_RECORDS
  )
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
  const keys = new Set<string>();
  const perTask = new Map<string, number>();
  for (const item of doc.records) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    const r = item as Record<string, unknown>;
    if (
      !hasExactKeys(r, [
        'schemaVersion',
        'kind',
        'id',
        'taskId',
        'answerReferenceId',
        'revision',
        'createdAt',
        'updatedAt',
        'sessionId',
        'turnId',
        'projectSlug',
        'bundleId',
        'claimId',
      ])
    )
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    if (
      r.schemaVersion !== 1 ||
      r.kind !== 'answer-support' ||
      !isCanonicalUuid(r.id) ||
      !validOpaqueId(r.taskId) ||
      !validOpaqueId(r.answerReferenceId) ||
      !validOpaqueId(r.sessionId) ||
      !validOpaqueId(r.turnId) ||
      !validOpaqueId(r.projectSlug) ||
      !isCanonicalBundleId(r.bundleId) ||
      !validOpaqueId(r.claimId) ||
      !Number.isInteger(r.revision) ||
      (r.revision as number) < 1 ||
      !isCanonicalTimestamp(r.createdAt) ||
      !isCanonicalTimestamp(r.updatedAt) ||
      Date.parse(r.updatedAt as string) < Date.parse(r.createdAt as string)
    )
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    const key = JSON.stringify([r.taskId, r.answerReferenceId]);
    if (keys.has(key))
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    keys.add(key);
    const count = (perTask.get(r.taskId) ?? 0) + 1;
    if (count > MAX_PER_TASK)
      throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
    perTask.set(r.taskId, count);
  }
}
function assertOwnedDirectory(path: string): void {
  assertNoSymlinkAncestors(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new TaskAnswerSupportUnavailableError('Answer support unavailable');
}
function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}
function isCanonicalUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}
function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
