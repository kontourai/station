/**
 * Producer-owned, exact-answer assessment binding.
 *
 * This is intentionally not TaskAnswerSupportStore: a Task association is a
 * local curation override, while this ledger is the producer's durable claim
 * about one exact completed assistant message.  The only semantic operation
 * here is handing a frozen bundle to Surface.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  StationAnswerAssessmentPublishInput,
  StationAnswerAssessmentReadTarget,
  StationAnswerAssessmentReceipt,
  StationReviewedSourceAssociation,
} from '@kontourai/station-contracts/answer-assessment';
import {
  parseStationAnswerBinding,
  type StationAnswerBinding,
} from '@kontourai/station-contracts/task-basis';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  buildTrustReport,
  type TrustBundle,
  validateTrustBundle,
} from '@kontourai/surface';
import {
  type AnswerAssessmentProjection,
  buildAnswerAssessmentProjection,
  type SurfaceAssessmentRead,
} from '@kontourai/surface/basis';
import type { SessionAnswerBasisQueryOutcome } from '../orchestration/session-query-module.js';
import {
  qualifiesStationAnswerContent,
  stationAnswerAssessmentProfileTarget,
} from './station-answer-assessment-profile.js';
import { readBoundedRegularFile } from './task-answer-support-module.js';

export {
  qualifiesStationAnswerContent,
  STATION_ANSWER_CONTENT_PROFILE,
  stationAnswerAssessmentClaimProfile,
  stationAnswerAssessmentProfileTarget,
  stationAnswerAssessmentTarget,
} from './station-answer-assessment-profile.js';

const MAX_BUNDLE_BYTES = 1_048_576;
// Shared guarded reader is deliberately capped at one MiB; write at the
// identical bound so a successful replacement can never make all later reads
// unavailable by construction.
const MAX_INDEX_BYTES = 1_048_576;
const HANDLE = /^sha256-[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,512}$/;

export const ANSWER_ASSESSMENT_UPDATED_EVENT = 'answer.assessment.updated';

export class AnswerAssessmentConflictError extends Error {}
export class AnswerAssessmentUnavailableError extends Error {}
export class AnswerAssessmentNotFoundError extends Error {}

/**
 * Opaque deterministic subject for one exact answer. JSON tuple hashing avoids
 * separator ambiguity and keeps message IDs out of arbitrary bundle paths.
 */

export type ProducerAssessmentInput = StationAnswerAssessmentPublishInput;

type Record = {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  binding: StationAnswerBinding;
  projectId: string;
  principalId: string;
  publicationId: string;
  revision: number;
  active: boolean;
  removedAt?: string;
  artifactHandle?: string;
  sha256?: string;
  claimId?: string;
  createdAt: string;
  updatedAt: string;
  reviewedSource?: StationReviewedSourceAssociation;
};
type Index = { schemaVersion: 1; records: Record[] };

export type AnswerAssessmentUpdate = StationAnswerAssessmentReceipt;

/** Private adapter input for Surface's reviewed-source Basis builder. */
export type ReviewedSourceBasisFacts = {
  revision: number;
  artifactSha: string;
  association: StationReviewedSourceAssociation;
  assessment: AnswerAssessmentProjection;
  evidence: import('@kontourai/surface').Evidence;
  /**
   * Synchronous witness for the exact persisted R that produced these facts.
   * It intentionally does not re-project or reauthorize the answer: callers
   * use it only after their own owner awaits to prevent an R+1 splice.
   */
  current: () => boolean;
};

/**
 * One answer-assessment observation for composition.  `reviewedSource` is
 * populated only from the same immutable record that supplied `assessment`.
 */
export type ExactAnswerAssessmentRead = {
  assessment: SurfaceAssessmentRead;
  reviewedSource?: ReviewedSourceBasisFacts;
};

/**
 * One immutable assessment observation.  The bundle, Surface projection, and
 * reviewed-source evidence are all derived from `record`, never reloaded from
 * a later index head.
 */
type CapturedAssessment = {
  record: Record;
  bundle: TrustBundle;
  report: ReturnType<typeof buildTrustReport>;
  assessment: AnswerAssessmentProjection;
};

/** A bounded owner-facing seam used by HTTP, MCP, direct, and Task readers. */
export class AnswerAssessmentModule {
  private readonly root: string;
  private readonly artifacts: string;
  private readonly indexPath: string;
  constructor(
    homeDir: string,
    private readonly answers: {
      read(
        sessionId: string,
        turnId: string,
        authority: SessionReadAuthority,
      ): Promise<SessionAnswerBasisQueryOutcome | { status: 'unavailable' }>;
    },
    private readonly onUpdated?: (update: AnswerAssessmentUpdate) => void,
  ) {
    this.root = join(resolve(homeDir), 'answer-assessments');
    this.artifacts = join(this.root, 'artifacts');
    this.indexPath = join(this.root, 'index.json');
  }

  async publish(
    sessionId: string,
    turnId: string,
    input: ProducerAssessmentInput,
    authority: SessionReadAuthority,
    current: () => boolean,
  ): Promise<AnswerAssessmentUpdate> {
    if (authority.mode === 'hosted' || !current())
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    const answer = await this.requireAnswer(sessionId, turnId, authority);
    const binding = bindingFor(answer);
    const expected = parseStationAnswerBinding(input.expectedAnswer);
    if (
      !expected ||
      expected.sessionId !== sessionId ||
      expected.turnId !== turnId ||
      !sameBinding(binding, expected)
    )
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    if (!validId(input.publicationId) || !validId(input.claimId))
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    if (
      input.reviewedSource &&
      (!validReviewedSourceAssociation(input.reviewedSource) ||
        input.reviewedSource.answerClaimId !== input.claimId ||
        input.reviewedSource.assessmentRevision !== input.expectedRevision + 1)
    )
      throw new AnswerAssessmentConflictError('Assessment revision conflicts');
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw new AnswerAssessmentConflictError('Assessment revision conflicts');
    const bytes = canonicalBundleBytes(input.bundle);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifactHandle = `sha256-${sha256}`;
    // Surface is the bounded validation and semantic authority. No producer
    // policy outcome, URL, path, or standing enters this record.
    let validated: TrustBundle;
    try {
      validated = validateTrustBundle(JSON.parse(bytes.toString('utf8')));
      const projection = buildAnswerAssessmentProjection(
        buildTrustReport(validated, { id: artifactHandle, now: new Date() }),
        input.claimId,
      );
      if (
        !projection.found ||
        !qualifiesStationAnswerContent(validated, input.claimId, binding)
      )
        throw new Error('claim missing');
    } catch {
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    }
    // Stage is immutable and happens before the index commit. A crash here
    // leaves an unreachable content-addressed blob, never a half binding.
    this.stage(artifactHandle, bytes);
    if (!current())
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    const reread = await this.requireAnswer(sessionId, turnId, authority);
    if (!current() || !sameBinding(binding, bindingFor(reread)))
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    const projectId = reread.projectSlug;
    if (!projectId)
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    const principalId = `${authority.mode}:${authority.userId}`;
    const result = await this.withLock(async () => {
      if (!current())
        throw new AnswerAssessmentNotFoundError('Assessment not found');
      const lockedAnswer = await this.requireAnswer(
        sessionId,
        turnId,
        authority,
      );
      if (
        !current() ||
        !sameBinding(binding, bindingFor(lockedAnswer)) ||
        lockedAnswer.projectSlug !== projectId
      )
        throw new AnswerAssessmentNotFoundError('Assessment not found');
      if (
        input.reviewedSource &&
        (input.reviewedSource.projectId !== projectId ||
          input.reviewedSource.principalId !== principalId)
      )
        throw new AnswerAssessmentNotFoundError('Assessment not found');
      const index = this.readIndex();
      const existing = index.records.find(
        (record) => record.sessionId === sessionId && record.turnId === turnId,
      );
      if (existing?.active) {
        if (
          sameBinding(existing.binding, binding) &&
          existing.publicationId === input.publicationId &&
          existing.sha256 === sha256 &&
          existing.claimId === input.claimId &&
          existing.principalId === principalId &&
          existing.projectId === projectId &&
          sameReviewedSourceAssociation(
            existing.reviewedSource,
            input.reviewedSource,
          )
        )
          return publicUpdate(existing);
        if (
          !sameBinding(existing.binding, binding) ||
          existing.principalId !== principalId ||
          existing.projectId !== projectId
        )
          throw new AnswerAssessmentConflictError(
            'Assessment revision conflicts',
          );
        if (existing.publicationId === input.publicationId)
          throw new AnswerAssessmentConflictError(
            'Assessment publication conflicts',
          );
        if (existing.revision !== input.expectedRevision)
          throw new AnswerAssessmentConflictError(
            'Assessment revision conflicts',
          );
        Object.assign(existing, {
          binding,
          projectId,
          principalId,
          publicationId: input.publicationId,
          artifactHandle,
          sha256,
          claimId: input.claimId,
          reviewedSource: input.reviewedSource,
          revision: existing.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        this.writeIndex(index);
        return publicUpdate(existing);
      }
      if (existing) {
        if (
          existing.revision !== input.expectedRevision ||
          existing.principalId !== principalId ||
          existing.projectId !== projectId
        )
          throw new AnswerAssessmentConflictError(
            'Assessment revision conflicts',
          );
        Object.assign(existing, {
          binding,
          projectId,
          principalId,
          publicationId: input.publicationId,
          artifactHandle,
          sha256,
          claimId: input.claimId,
          reviewedSource: input.reviewedSource,
          active: true,
          removedAt: undefined,
          revision: existing.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        this.writeIndex(index);
        return publicUpdate(existing);
      }
      if (input.expectedRevision !== 0)
        throw new AnswerAssessmentConflictError(
          'Assessment revision conflicts',
        );
      const now = new Date().toISOString();
      const record: Record = {
        schemaVersion: 1,
        sessionId,
        turnId,
        binding,
        projectId,
        principalId,
        publicationId: input.publicationId,
        revision: 1,
        active: true,
        artifactHandle,
        sha256,
        claimId: input.claimId,
        reviewedSource: input.reviewedSource,
        createdAt: now,
        updatedAt: now,
      };
      index.records.push(record);
      this.writeIndex(index);
      return publicUpdate(record);
    });
    if (!current())
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    this.onUpdated?.(result);
    return result;
  }

  readTarget(
    answer: Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>,
    authority: SessionReadAuthority,
    current: () => boolean,
  ): StationAnswerAssessmentReadTarget {
    if (authority.mode === 'hosted' || !current())
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    const expectedAnswer = bindingFor(answer);
    const principalId = `${authority.mode}:${authority.userId}`;
    const projectId = answer.projectSlug;
    if (!projectId)
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    let record: Record | undefined;
    try {
      record = this.readIndexReadOnly(true).records.find(
        (item) =>
          item.sessionId === expectedAnswer.sessionId &&
          item.turnId === expectedAnswer.turnId,
      );
    } catch {
      throw new AnswerAssessmentUnavailableError('Assessment unavailable');
    }
    if (
      !current() ||
      (record &&
        (!sameBinding(record.binding, expectedAnswer) ||
          record.principalId !== principalId ||
          record.projectId !== projectId))
    )
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    return {
      expectedAnswer,
      profile: stationAnswerAssessmentProfileTarget(expectedAnswer),
      revision: record?.revision ?? 0,
      active: record?.active ?? false,
    };
  }

  async remove(
    sessionId: string,
    turnId: string,
    expectedRevision: number,
    authority: SessionReadAuthority,
    current: () => boolean,
  ): Promise<AnswerAssessmentUpdate> {
    if (authority.mode === 'hosted' || !current())
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    const answer = await this.requireAnswer(sessionId, turnId, authority);
    const binding = bindingFor(answer);
    const principalId = `${authority.mode}:${authority.userId}`;
    const projectId = answer.projectSlug;
    const result = await this.withLock(async () => {
      if (!current())
        throw new AnswerAssessmentNotFoundError('Assessment not found');
      const lockedAnswer = await this.requireAnswer(
        sessionId,
        turnId,
        authority,
      );
      if (
        !current() ||
        !sameBinding(binding, bindingFor(lockedAnswer)) ||
        lockedAnswer.projectSlug !== projectId
      )
        throw new AnswerAssessmentNotFoundError('Assessment not found');
      const index = this.readIndex();
      const record = index.records.find(
        (item) => item.sessionId === sessionId && item.turnId === turnId,
      );
      if (
        !record?.active ||
        record.revision !== expectedRevision ||
        !sameBinding(record.binding, binding) ||
        record.principalId !== principalId ||
        record.projectId !== projectId
      )
        throw new AnswerAssessmentConflictError(
          'Assessment revision conflicts',
        );
      Object.assign(record, {
        active: false,
        revision: record.revision + 1,
        removedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      this.writeIndex(index);
      return publicUpdate(record);
    });
    if (!current())
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    this.onUpdated?.(result);
    return result;
  }

  async readExactAnswerAssessment(input: {
    authorizedAnswer: Extract<
      SessionAnswerBasisQueryOutcome,
      { status: 'found' }
    >;
    authority: SessionReadAuthority;
    current?: () => boolean;
  }): Promise<SurfaceAssessmentRead> {
    return (await this.readExactAnswerAssessmentWithReviewedSource(input))
      .assessment;
  }

  /**
   * Capture an assessment once for a composed Basis read.  The resolver gets
   * the exact source facts from this result; it must never reopen the ledger.
   */
  async readExactAnswerAssessmentWithReviewedSource(input: {
    authorizedAnswer: Extract<
      SessionAnswerBasisQueryOutcome,
      { status: 'found' }
    >;
    authority: SessionReadAuthority;
    current?: () => boolean;
  }): Promise<ExactAnswerAssessmentRead> {
    const captured = await this.captureExactAssessment(input);
    if ('read' in captured) return { assessment: captured.read };
    const assessment: SurfaceAssessmentRead = {
      owner: { authority: '@kontourai/surface' },
      state: 'available',
      observedAt: captured.record.updatedAt,
      value: captured.assessment,
    };
    const current = input.current ?? (() => true);
    const { record, report, assessment: projection } = captured;
    if (
      !record?.active ||
      !record.reviewedSource ||
      record.revision !== record.reviewedSource.assessmentRevision
    )
      return { assessment };
    try {
      // The capture already performed reauthorization and its full R fence.
      // Build E only from that immutable raw record.
      const evidence = report.evidence.find(
        (item) => item.id === record.reviewedSource!.sourceEvidenceId,
      );
      if (!evidence || !current() || !record.sha256) return { assessment };
      const facts: ReviewedSourceBasisFacts = {
        revision: record.revision,
        artifactSha: record.sha256,
        association: record.reviewedSource,
        assessment: projection,
        evidence,
        current: () => this.isCapturedAssessmentCurrent(input, record),
      };
      return facts.current()
        ? { assessment, reviewedSource: facts }
        : { assessment: unavailable() };
    } catch {
      return { assessment };
    }
  }

  /**
   * Capture R once, derive all Surface material from its immutable artifact,
   * then reauthorize and compare the complete record after the only await.
   */
  private async captureExactAssessment(input: {
    authorizedAnswer: Extract<
      SessionAnswerBasisQueryOutcome,
      { status: 'found' }
    >;
    authority: SessionReadAuthority;
    current?: () => boolean;
  }): Promise<CapturedAssessment | { read: SurfaceAssessmentRead }> {
    const current = input.current ?? (() => true);
    if (input.authority.mode === 'hosted' || !current())
      return { read: unavailable() };
    const binding = bindingFor(input.authorizedAnswer);
    const principalId = `${input.authority.mode}:${input.authority.userId}`;
    let record: Record | undefined;
    try {
      record = this.readIndexReadOnly(true).records.find(
        (item) =>
          item.sessionId === binding.sessionId &&
          item.turnId === binding.turnId,
      );
    } catch {
      return { read: unavailable() };
    }
    if (!record?.active)
      return { read: notCaptured(input.authorizedAnswer.observedAt) };
    if (
      !sameBinding(record.binding, binding) ||
      record.projectId !== input.authorizedAnswer.projectSlug ||
      record.principalId !== principalId
    )
      return { read: restricted(input.authorizedAnswer.observedAt) };
    if (!record.artifactHandle || !record.sha256 || !record.claimId)
      return { read: corrupt(input.authorizedAnswer.observedAt) };
    let bundle: TrustBundle;
    let report: ReturnType<typeof buildTrustReport>;
    let assessment: AnswerAssessmentProjection;
    try {
      const bytes = Buffer.from(
        readBoundedRegularFile(join(this.artifacts, `${record.sha256}.json`)),
      );
      if (createHash('sha256').update(bytes).digest('hex') !== record.sha256)
        return { read: corrupt(input.authorizedAnswer.observedAt) };
      bundle = validateTrustBundle(JSON.parse(bytes.toString('utf8')));
      report = buildTrustReport(bundle, {
        id: record.artifactHandle,
        now: new Date(),
      });
      assessment = buildAnswerAssessmentProjection(report, record.claimId);
      if (!assessment.found)
        return { read: corrupt(input.authorizedAnswer.observedAt) };
    } catch {
      return { read: unavailable() };
    }
    // Reauthorization follows artifact I/O.  The final read below compares the
    // entire persisted R, including artifact and full private association.
    const reread = await this.answers.read(
      binding.sessionId,
      binding.turnId,
      input.authority,
    );
    if (
      !current() ||
      reread.status !== 'found' ||
      !sameBinding(binding, bindingFor(reread)) ||
      reread.projectSlug !== record.projectId ||
      !this.isCapturedAssessmentCurrent(input, record)
    )
      return { read: unavailable() };
    if (!qualifiesStationAnswerContent(bundle, record.claimId, binding))
      return { read: unsupported(input.authorizedAnswer.observedAt) };
    return { record, bundle, report, assessment };
  }

  private isCapturedAssessmentCurrent(
    input: {
      authorizedAnswer: Extract<
        SessionAnswerBasisQueryOutcome,
        { status: 'found' }
      >;
      authority: SessionReadAuthority;
      current?: () => boolean;
    },
    captured: Record,
  ): boolean {
    const current = input.current ?? (() => true);
    if (!current()) return false;
    try {
      const binding = bindingFor(input.authorizedAnswer);
      const latest = this.readIndexReadOnly(true).records.find(
        (item) =>
          item.sessionId === binding.sessionId &&
          item.turnId === binding.turnId,
      );
      return (
        sameAssessmentRecord(latest, captured) &&
        latest?.principalId ===
          `${input.authority.mode}:${input.authority.userId}` &&
        sameBinding(latest.binding, binding) &&
        latest.projectId === input.authorizedAnswer.projectSlug
      );
    } catch {
      return false;
    }
  }

  private async requireAnswer(
    sessionId: string,
    turnId: string,
    authority: SessionReadAuthority,
  ) {
    const result = await this.answers.read(sessionId, turnId, authority);
    if (result.status === 'unavailable')
      throw new AnswerAssessmentUnavailableError('Assessment unavailable');
    if (result.status !== 'found')
      throw new AnswerAssessmentNotFoundError('Assessment not found');
    return result;
  }
  private ensure() {
    mkdirSync(this.artifacts, { recursive: true, mode: 0o700 });
  }
  private stage(handle: string, bytes: Buffer) {
    this.ensure();
    const target = join(
      this.artifacts,
      `${handle.slice('sha256-'.length)}.json`,
    );
    try {
      const existing = Buffer.from(readBoundedRegularFile(target));
      if (!existing.equals(bytes))
        throw new AnswerAssessmentConflictError(
          'Assessment artifact conflicts',
        );
      return;
    } catch (error) {
      if (
        !(error as NodeJS.ErrnoException).code ||
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      )
        throw error;
    }
    atomicWrite(target, bytes, MAX_BUNDLE_BYTES);
  }
  private async withLock<T>(work: () => T | Promise<T>): Promise<T> {
    this.ensure();
    const release = await acquireFileMutationLockAsync(
      `${this.indexPath}.mutation`,
    );
    try {
      return await work();
    } finally {
      await release();
    }
  }
  private readIndex(): Index {
    // Mutation already owns the lock and root. Reads remain guarded and strict.
    return this.readIndexReadOnly(true);
  }
  private readIndexReadOnly(allowMissing = false): Index {
    try {
      try {
        lstatSync(this.indexPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing)
          return { schemaVersion: 1, records: [] };
        throw error;
      }
      const raw = readBoundedRegularFile(this.indexPath);
      if (Buffer.byteLength(raw) > MAX_INDEX_BYTES) throw new Error('large');
      return parseIndex(JSON.parse(raw));
    } catch (_error) {
      throw new AnswerAssessmentUnavailableError('Assessment unavailable');
    }
  }
  private writeIndex(index: Index) {
    atomicWrite(
      this.indexPath,
      Buffer.from(JSON.stringify(index)),
      MAX_INDEX_BYTES,
    );
  }
}

function atomicWrite(path: string, bytes: Buffer, max: number) {
  if (bytes.length > max)
    throw new AnswerAssessmentUnavailableError('Assessment unavailable');
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (wrote <= 0) throw new Error('short');
      offset += wrote;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch (error) {
    throw error instanceof AnswerAssessmentConflictError
      ? error
      : new AnswerAssessmentUnavailableError('Assessment unavailable');
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
function parseIndex(value: unknown): Index {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('shape');
  const data = value as { schemaVersion?: unknown; records?: unknown };
  if (
    data.schemaVersion !== 1 ||
    !Array.isArray(data.records) ||
    data.records.length > 10_000
  )
    throw new Error('shape');
  const seen = new Set<string>();
  const records = data.records.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('record');
    const item = raw as Record;
    if (
      item.schemaVersion !== 1 ||
      !validId(item.sessionId) ||
      !validId(item.turnId) ||
      !validId(item.projectId) ||
      !validId(item.principalId) ||
      !validId(item.publicationId) ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 1 ||
      typeof item.active !== 'boolean' ||
      !validTimestamp(item.createdAt) ||
      !validTimestamp(item.updatedAt) ||
      !parseStationAnswerBinding(item.binding) ||
      !sameBinding(item.binding, parseStationAnswerBinding(item.binding)!)
    )
      throw new Error('record');
    if (
      item.binding.sessionId !== item.sessionId ||
      item.binding.turnId !== item.turnId
    )
      throw new Error('binding');
    const key = `${item.sessionId}\0${item.turnId}`;
    if (seen.has(key)) throw new Error('duplicate');
    seen.add(key);
    if (item.active) {
      if (
        !HANDLE.test(item.artifactHandle ?? '') ||
        !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') ||
        !validId(item.claimId)
      )
        throw new Error('active');
      if (
        item.artifactHandle !== `sha256-${item.sha256}` ||
        item.removedAt !== undefined
      )
        throw new Error('artifact');
      if (
        item.reviewedSource &&
        (!validReviewedSourceAssociation(item.reviewedSource) ||
          item.reviewedSource.answerClaimId !== item.claimId ||
          item.reviewedSource.assessmentRevision !== item.revision ||
          item.reviewedSource.projectId !== item.projectId ||
          item.reviewedSource.principalId !== item.principalId)
      )
        throw new Error('reviewed-source');
    } else if (!validTimestamp(item.removedAt)) throw new Error('tombstone');
    return item;
  });
  return { schemaVersion: 1, records };
}
function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function canonicalBundleBytes(value: unknown): Buffer {
  // JSON stringify ensures arbitrary prototype/path objects never become an IO target.
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AnswerAssessmentNotFoundError('Assessment not found');
  }
  if (!serialized || Buffer.byteLength(serialized) > MAX_BUNDLE_BYTES)
    throw new AnswerAssessmentNotFoundError('Assessment not found');
  return Buffer.from(serialized);
}
function bindingFor(
  answer: Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>,
): StationAnswerBinding {
  return answer.binding;
}
function sameAnswer(
  a: StationAnswerBinding['answer'],
  b: StationAnswerBinding['answer'],
) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sameBinding(a: StationAnswerBinding, b: StationAnswerBinding) {
  return (
    a.version === b.version &&
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    sameAnswer(a.answer, b.answer)
  );
}
function sameAssessmentRecord(
  latest: Record | undefined,
  captured: Record,
): boolean {
  return (
    latest?.active === true &&
    latest.revision === captured.revision &&
    sameBinding(latest.binding, captured.binding) &&
    latest.projectId === captured.projectId &&
    latest.principalId === captured.principalId &&
    latest.sha256 === captured.sha256 &&
    latest.artifactHandle === captured.artifactHandle &&
    latest.claimId === captured.claimId &&
    sameReviewedSourceAssociation(
      latest.reviewedSource,
      captured.reviewedSource,
    )
  );
}
function sameReviewedSourceAssociation(
  left: StationReviewedSourceAssociation | undefined,
  right: StationReviewedSourceAssociation | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function validReviewedSourceAssociation(
  value: unknown,
): value is StationReviewedSourceAssociation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as StationReviewedSourceAssociation;
  return (
    item.version === 'station.reviewed-source-association/v1' &&
    item.owner === '@kontourai/fieldwork' &&
    Number.isSafeInteger(item.assessmentRevision) &&
    item.assessmentRevision > 0 &&
    [
      item.pluginName,
      item.sourceClaimId,
      item.sourceEvidenceId,
      item.answerClaimId,
      item.answerCitationEvidenceId,
      item.runId,
      item.exactRef,
      item.projectId,
      item.workspaceId,
      item.principalId,
    ].every(validId)
  );
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
function publicUpdate(record: Record): AnswerAssessmentUpdate {
  return {
    sessionId: record.sessionId,
    turnId: record.turnId,
    revision: record.revision,
    active: record.active,
  };
}
function notCaptured(observedAt: string): SurfaceAssessmentRead {
  return {
    owner: { authority: '@kontourai/surface' },
    state: 'not-captured',
    observedAt,
  };
}
function unavailable(): SurfaceAssessmentRead {
  return {
    owner: { authority: '@kontourai/surface' },
    state: 'unavailable',
    observedAt: new Date().toISOString(),
  };
}
function restricted(observedAt: string): SurfaceAssessmentRead {
  return {
    owner: { authority: '@kontourai/surface' },
    state: 'restricted',
    observedAt,
  };
}
function corrupt(observedAt: string): SurfaceAssessmentRead {
  return {
    owner: { authority: '@kontourai/surface' },
    state: 'corrupt',
    observedAt,
  };
}
function unsupported(observedAt: string): SurfaceAssessmentRead {
  return {
    owner: { authority: '@kontourai/surface' },
    state: 'unsupported-version',
    observedAt,
  };
}
