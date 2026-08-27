/**
 * Station-owned append-only association of one exact completed answer to one
 * owner-qualified retained Flow Agents narrative. Retained bytes remain with
 * Flow Agents; this index contains only identity, CAS, and local authority.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
  type StationAnswerNarrativePublishInput,
  type StationAnswerNarrativeReadTarget,
  type StationAnswerNarrativeReceipt,
} from '@kontourai/station-contracts/answer-narrative-binding';
import {
  parseStationAnswerBinding,
  type StationAnswerBinding,
} from '@kontourai/station-contracts/task-basis';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import type { ContributionRead } from '@kontourai/surface/basis';
import type { SessionAnswerBasisQueryOutcome } from '../orchestration/session-query-module.js';
import {
  type ConfiguredNarrativeOwner,
  type OwnerNarrativeRead,
  type RetainedNarrativeOwnerAdapter,
} from './flow-agents-retained-narrative-owner.js';

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_REVISIONS_PER_ANSWER = 64;
const MAX_ROW_BYTES = 16 * 1024;

export const ANSWER_NARRATIVE_UPDATED_EVENT = 'answer.narrative.updated';
export class AnswerNarrativeConflictError extends Error {}
export class AnswerNarrativeUnavailableError extends Error {}
export class AnswerNarrativeNotFoundError extends Error {}

type StoredRevision = {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  binding: StationAnswerBinding;
  publicationId: string;
  revision: number;
  active: boolean;
  ownerId: typeof STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER;
  narrativeRef?: {
    schemaVersion: 'grounded-narrative-ref/v1';
    narrativeId: string;
    envelopeSha256: string;
  };
  projectId: string;
  workspacePath: string;
  workspaceFingerprint: string;
  ownerConfigurationFingerprint: string;
  principalId: string;
  createdAt: string;
  removedAt?: string;
};
type Index = { schemaVersion: 1; records: StoredRevision[] };
type FoundAnswer = Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;
type FlowNarrativeContributionRead = Extract<
  ContributionRead,
  { owner: { authority: '@kontourai/flow-agents' } }
>;
export type AnswerNarrativeUpdate = StationAnswerNarrativeReceipt;

/**
 * Private hand-off from the association owner to TaskGraph. The callback runs
 * while the association lease is held, so a producer cannot replace or remove
 * the captured revision between the witness and the Task publication.
 */
export type TaskAnswerNarrativePinWitness = {
  associationRevision?: number;
  isCurrent(): boolean;
};

export class AnswerNarrativeBindingModule {
  private readonly root: string;
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
    private readonly owner: RetainedNarrativeOwnerAdapter,
    private readonly onUpdated?: (update: AnswerNarrativeUpdate) => void,
  ) {
    this.root = join(resolve(homeDir), 'answer-narrative-bindings');
    this.indexPath = join(this.root, 'index.json');
  }

  async publish(
    sessionId: string,
    turnId: string,
    input: StationAnswerNarrativePublishInput,
    authority: SessionReadAuthority,
    current: () => boolean,
  ): Promise<AnswerNarrativeUpdate> {
    if (authority.mode === 'hosted' || !current()) throw notFound();
    const answer = await this.requireAnswer(sessionId, turnId, authority);
    const binding = bindingFor(answer);
    if (!sameBinding(binding, input.expectedAnswer)) throw notFound();
    const projectId = requireProject(answer);
    const configured = this.capture(projectId, input);
    if (!configured) throw unavailable();
    const principalId = principalFor(authority);
    const inspected = await this.owner.read({
      owner: configured,
      narrativeRef: input.narrativeRef,
      authorize: async () =>
        current() &&
        (await this.sameCurrentAnswer(
          sessionId,
          turnId,
          binding,
          authority,
          projectId,
        )) &&
        this.owner.isCurrent(configured),
    });
    // A producer cannot publish an uninspectable ref. Not-captured is a read
    // state, never proof that a candidate association was valid.
    if (inspected.state !== 'available') throw unavailable();
    if (!current()) throw notFound();
    const update = await this.withLock(async () => {
      // Re-read the durable answer while holding the mutation lease.  The
      // preflight read only authorizes owner I/O; it cannot authorize a later
      // index write after a Session, lease, or Project change.
      const lockedAnswer = await this.requireAnswer(
        sessionId,
        turnId,
        authority,
      );
      const lockedBinding = bindingFor(lockedAnswer);
      const lockedProjectId = requireProject(lockedAnswer);
      const lockedPrincipalId = principalFor(authority);
      if (
        !sameBinding(binding, lockedBinding) ||
        lockedProjectId !== projectId ||
        lockedPrincipalId !== principalId ||
        !this.owner.isCurrent(configured)
      )
        throw notFound();
      const index = this.readIndex(true);
      const history = historyFor(index, sessionId, turnId);
      const head = history.at(-1);
      const published = index.records.find(
        (row) => row.publicationId === input.publicationId,
      );
      if (published) {
        if (
          samePublish(
            published,
            input,
            lockedBinding,
            lockedProjectId,
            lockedPrincipalId,
            configured,
          )
        )
          return receipt(published);
        throw conflict();
      }
      if (head && head.revision !== input.expectedRevision) throw conflict();
      if (!head && input.expectedRevision !== 0) throw conflict();
      if (
        history.length >= MAX_REVISIONS_PER_ANSWER ||
        index.records.length >= MAX_ROWS
      )
        throw unavailable();
      const record: StoredRevision = {
        schemaVersion: 1,
        sessionId,
        turnId,
        binding,
        publicationId: input.publicationId,
        revision: (head?.revision ?? 0) + 1,
        active: true,
        ownerId: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
        narrativeRef: input.narrativeRef,
        projectId: lockedProjectId,
        workspacePath: configured.workspacePath,
        workspaceFingerprint: configured.configurationFingerprint,
        ownerConfigurationFingerprint: configured.configurationFingerprint,
        principalId: lockedPrincipalId,
        createdAt: new Date().toISOString(),
      };
      // This is the commit fence: no await may follow it before the durable
      // append.  A queued request whose lease, answer, or owner changed
      // therefore leaves no index row behind.
      if (!current() || !this.owner.isCurrent(configured)) throw notFound();
      this.writeIndex({
        schemaVersion: 1,
        records: [...index.records, record],
      });
      return receipt(record);
    });
    // The durable append is already complete. Publish its cache/SSE update
    // even if this caller's request authority expires during lock release;
    // only the response is withheld, never rewritten as a rollback.
    this.onUpdated?.(update);
    if (!current() || !this.owner.isCurrent(configured)) throw notFound();
    return update;
  }

  async remove(
    sessionId: string,
    turnId: string,
    expectedRevision: number,
    authority: SessionReadAuthority,
    current: () => boolean,
  ): Promise<AnswerNarrativeUpdate> {
    if (authority.mode === 'hosted' || !current()) throw notFound();
    const answer = await this.requireAnswer(sessionId, turnId, authority);
    const binding = bindingFor(answer);
    const projectId = requireProject(answer);
    const principalId = principalFor(authority);
    // Capture this immutable owner generation before queuing for the shared
    // index lease. A later Project rebind must refuse this operation, not
    // silently turn it into a removal for the replacement workspace.
    const observedActive = historyFor(
      this.readIndex(true),
      sessionId,
      turnId,
    ).find((row) => row.revision === expectedRevision && row.active);
    if (!observedActive) throw conflict();
    const configured = this.owner.capture({
      ownerId: observedActive.ownerId,
      projectId: observedActive.projectId,
      workspacePath: observedActive.workspacePath,
      narrativeRef: observedActive.narrativeRef!,
    });
    if (
      !configured ||
      configured.configurationFingerprint !==
        observedActive.ownerConfigurationFingerprint
    )
      throw notFound();
    const update = await this.withLock(async () => {
      const index = this.readIndex(true);
      const history = historyFor(index, sessionId, turnId);
      const head = history.at(-1);
      const lockedAnswer = await this.requireAnswer(
        sessionId,
        turnId,
        authority,
      );
      const lockedBinding = bindingFor(lockedAnswer);
      const lockedProjectId = requireProject(lockedAnswer);
      const lockedPrincipalId = principalFor(authority);
      if (
        !sameBinding(binding, lockedBinding) ||
        lockedProjectId !== projectId ||
        lockedPrincipalId !== principalId
      )
        throw conflict();
      if (!current() || !this.owner.isCurrent(configured)) throw notFound();
      const active = history.find(
        (row) => row.revision === expectedRevision && row.active,
      );
      if (!active) throw conflict();
      const tombstoneId = tombstonePublicationId(active);
      // Publication IDs are global, including deterministic tombstones. A
      // same-operation retry returns its exact old receipt; any other global
      // reservation is a conflict before bytes are written.
      const reserved = index.records.find(
        (row) => row.publicationId === tombstoneId,
      );
      if (reserved) {
        if (sameTombstone(reserved, active, tombstoneId))
          return receipt(reserved);
        throw conflict();
      }
      if (
        !head?.active ||
        head.revision !== expectedRevision ||
        !sameBinding(head.binding, lockedBinding) ||
        head.projectId !== lockedProjectId ||
        head.principalId !== lockedPrincipalId ||
        !sameTombstoneSource(head, observedActive)
      )
        throw conflict();
      if (
        history.length >= MAX_REVISIONS_PER_ANSWER ||
        index.records.length >= MAX_ROWS
      )
        throw unavailable();
      // As with publish, this synchronous fence is immediately adjacent to
      // append.  Removal must not survive a revoked lease or changed Project
      // owner configuration merely because it waited for this lock.
      if (!current() || !this.owner.isCurrent(configured)) throw notFound();
      const tombstone: StoredRevision = {
        ...head,
        publicationId: tombstoneId,
        revision: head.revision + 1,
        active: false,
        narrativeRef: undefined,
        createdAt: new Date().toISOString(),
        removedAt: new Date().toISOString(),
      };
      this.writeIndex({
        schemaVersion: 1,
        records: [...index.records, tombstone],
      });
      return receipt(tombstone);
    });
    this.onUpdated?.(update);
    if (!current() || !this.owner.isCurrent(configured)) throw notFound();
    return update;
  }

  readTarget(
    answer: FoundAnswer,
    authority: SessionReadAuthority,
    current: () => boolean,
  ): StationAnswerNarrativeReadTarget {
    if (authority.mode === 'hosted' || !current()) throw notFound();
    const binding = bindingFor(answer);
    const projectId = requireProject(answer);
    const head = this.head(binding.sessionId, binding.turnId);
    if (
      head &&
      (!sameBinding(head.binding, binding) ||
        head.projectId !== projectId ||
        head.principalId !== principalFor(authority))
    )
      throw notFound();
    return {
      expectedAnswer: binding,
      revision: head?.revision ?? 0,
      active: head?.active ?? false,
      ownerId: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
    };
  }

  /**
   * Capture the current active association for one Keep without reading owner
   * bytes. The association lock is deliberately acquired before TaskGraph's
   * mutation lock; callers must perform their Task publication in `commit`.
   */
  async withTaskReferencePin<T>(input: {
    sessionId: string;
    turnId: string;
    authority: SessionReadAuthority;
    current(): boolean;
    commit(witness: TaskAnswerNarrativePinWitness): Promise<T>;
  }): Promise<T> {
    if (input.authority.mode === 'hosted' || !input.current()) throw notFound();
    return this.withLock(async () => {
      const answer = await this.requireAnswer(
        input.sessionId,
        input.turnId,
        input.authority,
      );
      const binding = bindingFor(answer);
      const projectId = requireProject(answer);
      const principalId = principalFor(input.authority);
      const index = this.readIndex(true);
      const record = historyFor(index, input.sessionId, input.turnId).at(-1);
      let associationRevision: number | undefined;
      let configured: ConfiguredNarrativeOwner | undefined;
      if (record?.active) {
        if (
          !sameBinding(record.binding, binding) ||
          record.projectId !== projectId ||
          record.principalId !== principalId ||
          !record.narrativeRef
        )
          throw notFound();
        const captured = this.owner.capture({
          ownerId: record.ownerId,
          projectId: record.projectId,
          workspacePath: record.workspacePath,
          narrativeRef: record.narrativeRef,
        });
        if (
          !captured ||
          captured.configurationFingerprint !==
            record.ownerConfigurationFingerprint ||
          !this.owner.isCurrent(captured)
        )
          throw notFound();
        configured = captured;
        associationRevision = record.revision;
      }
      const witness: TaskAnswerNarrativePinWitness = {
        ...(associationRevision === undefined ? {} : { associationRevision }),
        isCurrent: () => {
          if (!input.current()) return false;
          try {
            const latest = historyFor(
              this.readIndex(true),
              input.sessionId,
              input.turnId,
            ).at(-1);
            return (
              latest?.revision === record?.revision &&
              latest?.active === record?.active &&
              (!configured || this.owner.isCurrent(configured))
            );
          } catch {
            return false;
          }
        },
      };
      if (!witness.isCurrent()) throw notFound();
      return input.commit(witness);
    });
  }

  /** Direct Basis reads current head; Task pin support can call this with a revision later. */
  async readExactAnswerNarrative(input: {
    authorizedAnswer: FoundAnswer;
    authority: SessionReadAuthority;
    current?: () => boolean;
    revision?: number;
  }): Promise<ContributionRead> {
    const current = input.current ?? (() => true);
    const observedAt = input.authorizedAnswer.observedAt;
    if (input.authority.mode === 'hosted' || !current())
      return ownerRead('restricted', observedAt);
    const binding = bindingFor(input.authorizedAnswer);
    let record: StoredRevision | undefined;
    try {
      const history = historyFor(
        this.readIndex(true),
        binding.sessionId,
        binding.turnId,
      );
      record =
        input.revision === undefined
          ? history.at(-1)
          : history.find((row) => row.revision === input.revision);
    } catch {
      return ownerRead('unavailable', observedAt);
    }
    if (!record?.active) return ownerRead('not-captured', observedAt);
    if (
      !sameBinding(record.binding, binding) ||
      record.projectId !== input.authorizedAnswer.projectSlug ||
      record.principalId !== principalFor(input.authority)
    )
      return ownerRead('restricted', observedAt);
    if (!record.narrativeRef) return ownerRead('corrupt', observedAt);
    const configured = this.owner.capture({
      ownerId: record.ownerId,
      projectId: record.projectId,
      workspacePath: record.workspacePath,
      narrativeRef: record.narrativeRef,
    });
    if (
      !configured ||
      configured.configurationFingerprint !==
        record.ownerConfigurationFingerprint
    )
      return ownerRead('restricted', observedAt);
    const read = await this.owner.read({
      owner: configured,
      narrativeRef: record.narrativeRef,
      authorize: async () =>
        current() &&
        (await this.sameCurrentAnswer(
          binding.sessionId,
          binding.turnId,
          binding,
          input.authority,
          record!.projectId,
        )) &&
        this.owner.isCurrent(configured),
    });
    if (read.state !== 'available')
      return ownerRead(read.state, read.observedAt);
    if (
      !current() ||
      !(await this.sameCurrentAnswer(
        binding.sessionId,
        binding.turnId,
        binding,
        input.authority,
        record.projectId,
      ))
    )
      return ownerRead('restricted', read.observedAt);
    const latest = this.head(binding.sessionId, binding.turnId);
    // Direct Basis follows the active head. A Task supplies an explicit
    // historical revision and must remain able to inspect that immutable
    // association after a later replacement or tombstone.
    if (
      input.revision === undefined &&
      (!latest || latest.revision !== record.revision)
    )
      return ownerRead('unavailable', read.observedAt);
    return narrativeContribution(binding, read);
  }

  private capture(
    projectId: string,
    input: StationAnswerNarrativePublishInput,
  ) {
    return this.owner.capture({
      ownerId: input.ownerId,
      projectId,
      workspacePath: '',
      narrativeRef: input.narrativeRef,
    });
  }
  private async sameCurrentAnswer(
    sessionId: string,
    turnId: string,
    binding: StationAnswerBinding,
    authority: SessionReadAuthority,
    projectId: string,
  ) {
    if (!this.owner || authority.mode === 'hosted') return false;
    const answer = await this.answers.read(sessionId, turnId, authority);
    return (
      answer.status === 'found' &&
      sameBinding(binding, bindingFor(answer)) &&
      answer.projectSlug === projectId
    );
  }
  /**
   * The only mutation authorization source is the bounded, exact, completed
   * answer query backed by EventStore descriptors.  `not-found` remains
   * intentionally opaque; a damaged durable projection is a retryable owner
   * failure instead of a runtime TypeError disguised as a 404.
   */
  private async requireAnswer(
    sessionId: string,
    turnId: string,
    authority: SessionReadAuthority,
  ): Promise<FoundAnswer> {
    const answer = await this.answers.read(sessionId, turnId, authority);
    if (answer.status === 'unavailable' || answer.status === 'corrupt')
      throw unavailable();
    if (answer.status !== 'found') throw notFound();
    return answer;
  }
  private head(sessionId: string, turnId: string): StoredRevision | undefined {
    return historyFor(this.readIndex(true), sessionId, turnId).at(-1);
  }
  private ensure() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
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
  private readIndex(allowMissing = false): Index {
    try {
      try {
        lstatSync(this.indexPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing)
          return { schemaVersion: 1, records: [] };
        throw error;
      }
      const raw = readFileSync(this.indexPath);
      if (raw.length > MAX_INDEX_BYTES) throw new Error('large');
      return parseIndex(JSON.parse(raw.toString('utf8')));
    } catch (error) {
      if (error instanceof AnswerNarrativeUnavailableError) throw error;
      throw unavailable();
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

type UnavailableNarrativeState = Exclude<
  OwnerNarrativeRead['state'],
  'available'
>;

function ownerRead(
  state: UnavailableNarrativeState,
  observedAt: string,
): FlowNarrativeContributionRead {
  const owner = { authority: '@kontourai/flow-agents' as const };
  switch (state) {
    case 'not-captured':
      return { owner, state: 'not-captured', observedAt };
    case 'unsupported-version':
      return { owner, state: 'unsupported-version', observedAt };
    case 'corrupt':
      return { owner, state: 'corrupt', observedAt };
    case 'unavailable':
      return { owner, state: 'unavailable', observedAt };
    case 'restricted':
      return { owner, state: 'restricted', observedAt };
  }
}
function narrativeContribution(
  binding: StationAnswerBinding,
  read: Extract<OwnerNarrativeRead, { state: 'available' }>,
): FlowNarrativeContributionRead {
  const process = read.process;
  const statementCount =
    process.runtime.documentActions.length +
    process.runtime.turns.reduce(
      (count, turn) => count + turn.actions.length,
      0,
    );
  const sourceCompleteness =
    process.runtime.coverage.sources === 0
      ? 'unknown'
      : process.runtime.coverage.unavailable > 0 ||
          process.capture.channels.inactive > 0 ||
          process.capture.channels.unknown > 0 ||
          process.capture.knownGapClasses.length > 0
        ? 'partial'
        : 'complete';
  return {
    owner: { authority: '@kontourai/flow-agents' },
    state: 'available',
    observedAt: read.observedAt,
    value: [
      {
        ref: {
          authority: '@kontourai/flow-agents',
          schemaVersion: 'grounded-execution-narrative/v1',
          kind: 'narrative',
          narrativeId: process.narrativeId,
        },
        answer: binding.answer,
        role: 'execution',
        context: {
          kind: 'grounded-narrative',
          statementCount,
          sourceCompleteness,
        },
        ...(sourceCompleteness === 'complete'
          ? {}
          : {
              gaps: [
                {
                  code: 'grounded-narrative-capture-incomplete',
                  message: 'Execution captured; semantic support not assessed.',
                },
              ],
            }),
      },
    ],
  };
}
function historyFor(index: Index, sessionId: string, turnId: string) {
  return index.records
    .filter((row) => row.sessionId === sessionId && row.turnId === turnId)
    .sort((a, b) => a.revision - b.revision);
}
function bindingFor(answer: FoundAnswer): StationAnswerBinding {
  return answer.binding;
}
function sameBinding(left: StationAnswerBinding, right: StationAnswerBinding) {
  return (
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.answer.threadId === right.answer.threadId &&
    left.answer.messageId === right.answer.messageId
  );
}
function requireProject(answer: FoundAnswer) {
  if (!answer.projectSlug) throw notFound();
  return answer.projectSlug;
}
function principalFor(authority: SessionReadAuthority) {
  return `${authority.mode}:${authority.userId}`;
}
function receipt(record: StoredRevision): AnswerNarrativeUpdate {
  return {
    sessionId: record.sessionId,
    turnId: record.turnId,
    revision: record.revision,
    active: record.active,
  };
}
/** Internal tombstones also occupy the append-only global publication space. */
function tombstonePublicationId(head: StoredRevision): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'station.answer-narrative-binding/tombstone/v1',
        head.sessionId,
        head.turnId,
        head.revision + 1,
        head.publicationId,
      ]),
    )
    .digest('hex');
  return `tombstone:${digest}`;
}
function sameTombstone(
  row: StoredRevision,
  active: StoredRevision,
  publicationId: string,
) {
  return (
    !row.active &&
    row.publicationId === publicationId &&
    row.revision === active.revision + 1 &&
    sameTombstoneSource(row, active)
  );
}
function sameTombstoneSource(row: StoredRevision, active: StoredRevision) {
  return (
    row.sessionId === active.sessionId &&
    row.turnId === active.turnId &&
    sameBinding(row.binding, active.binding) &&
    row.ownerId === active.ownerId &&
    row.projectId === active.projectId &&
    row.workspacePath === active.workspacePath &&
    row.workspaceFingerprint === active.workspaceFingerprint &&
    row.ownerConfigurationFingerprint ===
      active.ownerConfigurationFingerprint &&
    row.principalId === active.principalId
  );
}
function samePublish(
  row: StoredRevision,
  input: StationAnswerNarrativePublishInput,
  binding: StationAnswerBinding,
  projectId: string,
  principalId: string,
  owner: ConfiguredNarrativeOwner,
) {
  return (
    row.active &&
    row.publicationId === input.publicationId &&
    sameBinding(row.binding, binding) &&
    row.projectId === projectId &&
    row.principalId === principalId &&
    row.ownerId === input.ownerId &&
    row.narrativeRef?.narrativeId === input.narrativeRef.narrativeId &&
    row.narrativeRef?.envelopeSha256 === input.narrativeRef.envelopeSha256 &&
    row.ownerConfigurationFingerprint === owner.configurationFingerprint
  );
}
function parseIndex(value: unknown): Index {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw unavailable();
  const input = value as { schemaVersion?: unknown; records?: unknown };
  if (
    input.schemaVersion !== 1 ||
    !Array.isArray(input.records) ||
    input.records.length > MAX_ROWS
  )
    throw unavailable();
  const seenRevisions = new Set<string>();
  const seenPublicationIds = new Set<string>();
  const records = input.records.map((raw) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_ROW_BYTES
    )
      throw unavailable();
    const row = raw as StoredRevision;
    const binding = parseStationAnswerBinding(row.binding);
    if (
      !binding ||
      row.schemaVersion !== 1 ||
      !valid(row.sessionId) ||
      !valid(row.turnId) ||
      !valid(row.publicationId) ||
      !valid(row.projectId) ||
      !valid(row.principalId) ||
      !wellFormedString(row.workspacePath) ||
      !wellFormedString(row.workspaceFingerprint) ||
      !wellFormedString(row.ownerConfigurationFingerprint) ||
      !wellFormedString(row.createdAt) ||
      (row.removedAt !== undefined && !wellFormedString(row.removedAt)) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      typeof row.active !== 'boolean' ||
      row.ownerId !== STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER ||
      !sameBinding(binding, row.binding) ||
      binding.sessionId !== row.sessionId ||
      binding.turnId !== row.turnId ||
      (row.active && !row.narrativeRef) ||
      (!row.active && row.narrativeRef !== undefined)
    )
      throw unavailable();
    const key = `${row.sessionId}\0${row.turnId}\0${row.revision}`;
    if (seenRevisions.has(key) || seenPublicationIds.has(row.publicationId))
      throw unavailable();
    seenRevisions.add(key);
    seenPublicationIds.add(row.publicationId);
    return { ...row, binding };
  });
  for (const row of records)
    if (
      historyFor({ schemaVersion: 1, records }, row.sessionId, row.turnId)
        .length > MAX_REVISIONS_PER_ANSWER
    )
      throw unavailable();
  return { schemaVersion: 1, records };
}
function valid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    wellFormedUnicode(value) &&
    Buffer.byteLength(value, 'utf8') <= 512
  );
}
function wellFormedString(value: unknown): value is string {
  return typeof value === 'string' && wellFormedUnicode(value);
}
function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
function conflict() {
  return new AnswerNarrativeConflictError('Narrative revision conflicts');
}
function unavailable() {
  return new AnswerNarrativeUnavailableError('Narrative unavailable');
}
function notFound() {
  return new AnswerNarrativeNotFoundError('Narrative not found');
}
function atomicWrite(path: string, bytes: Buffer, max: number) {
  if (bytes.length > max) throw unavailable();
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
  } catch {
    throw unavailable();
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
