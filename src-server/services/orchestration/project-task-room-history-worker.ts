import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import {
  CHANNEL_PROPOSAL_SCHEMA_VERSION,
  CHANNEL_SEQUENCE_SCHEMA_VERSION,
  type ChannelProposal,
  type ChannelSequencingEnvelope,
  channelProposalDigestInput,
  validateChannelSequencingEnvelope,
} from '@kontourai/station-contracts/channel-log';
import type {
  ProjectTaskRoomAppendReceipt,
  ProjectTaskRoomCheckpoint,
  ProjectTaskRoomCursor,
  ProjectTaskRoomRecord,
  ProjectTaskRoomScope,
} from '@kontourai/station-contracts/project-task-room';
import { PROJECT_TASK_ROOM_MAX_PAGE_JSON_ITEMS } from '@kontourai/station-contracts/project-task-room';
import { PROJECT_TASK_ROOM_HISTORY_MIGRATION } from '../../domain/migrations/005-project-task-room-history.js';
import { SharedWorkingState } from '../../domain/shared-working-state.js';
import { applyWalJournalMode } from '../../utils/sqlite-wal.js';
import { measureBoundedJson, plainDataObject } from './bounded-json.js';
import {
  hasPendingProjectTaskRoomExecution,
  initializeProjectTaskRoomSourceSeals,
  persistProjectTaskRoomSourceSeal,
  readProjectTaskRoomSourceSeal,
} from './project-task-room-source-seal.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { timeout?: number }) => Database;
};
interface Statement {
  run(...args: unknown[]): { changes?: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  iterate(...args: unknown[]): IterableIterator<unknown>;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
interface Head {
  channel_id: string;
  project_id: string;
  project_slug: string;
  task_id: string;
  epoch: number;
  head_seq: number;
  head_envelope_digest: string | null;
  head_checkpoint_digest: string;
  retained_anchor_seq: number;
  retained_anchor_envelope_digest: string | null;
  retained_anchor_checkpoint_digest: string;
  policy_revision: string;
}
interface Row {
  channel_id: string;
  epoch: number;
  seq: number;
  proposal_id: string;
  proposal_digest: string;
  envelope_digest: string;
  checkpoint_digest: string;
  record_json: string;
  record_bytes: number;
}
interface Identity {
  proposal_id: string;
  proposal_digest: string;
  epoch: number;
  seq: number;
  envelope_digest: string;
  checkpoint_digest: string;
  committed_at: string;
  receipt_json: string;
  receipt_bytes: number;
  receipt_digest: string;
}
interface WorkerInit {
  databasePath: string;
  retentionRecords: number;
  retentionBytes: number;
  maxIdentities: number;
  faultAfterCommitOnce?: boolean;
  unavailableAfterCommitOnce?: boolean;
}
interface AppendRequest {
  type: 'append';
  scope: ProjectTaskRoomScope;
  channelId: string;
  policyRevision: string;
  proposalId: string;
  proposalDigest: string;
  occurredAt: string;
  correlationId?: string;
  causationId?: string;
  principal: ProjectTaskRoomRecord['principal'];
  body: ProjectTaskRoomRecord['body'];
  grantReceipt: unknown;
  authorizationId: string;
  writeAdmissionRequired: boolean;
}
type Request =
  | {
      type: 'open';
      scope: ProjectTaskRoomScope;
      channelId: string;
      policyRevision: string;
      authorizationId: string;
    }
  | AppendRequest
  | {
      type: 'read';
      scope: ProjectTaskRoomScope;
      channelId: string;
      cursor?: ProjectTaskRoomCursor;
      limit: number;
      pageBytes: number;
    }
  | {
      type: 'seal-source';
      scope: ProjectTaskRoomScope;
      channelId: string;
      policyRevision: string;
      authorizationId: string;
      operationId: string;
      sourceHomeRef: string;
      targetHomeRef: string;
    }
  | {
      type: 'locate-proposal';
      scope: ProjectTaskRoomScope;
      channelId: string;
      proposalId: string;
    }
  | { type: 'read-source-seal'; scope: ProjectTaskRoomScope; channelId: string }
  | { type: 'close' };
if (
  !exactObject(workerData, [
    'databasePath',
    'retentionRecords',
    'retentionBytes',
    'maxIdentities',
    'faultAfterCommitOnce',
    'unavailableAfterCommitOnce',
  ]) ||
  typeof workerData.databasePath !== 'string' ||
  workerData.databasePath.length === 0 ||
  workerData.databasePath.length > 4_096 ||
  !Number.isSafeInteger(workerData.retentionRecords) ||
  Number(workerData.retentionRecords) < 1 ||
  !Number.isSafeInteger(workerData.retentionBytes) ||
  Number(workerData.retentionBytes) < 48 * 1024 ||
  !Number.isSafeInteger(workerData.maxIdentities) ||
  Number(workerData.maxIdentities) < Number(workerData.retentionRecords) ||
  (workerData.faultAfterCommitOnce !== undefined &&
    typeof workerData.faultAfterCommitOnce !== 'boolean') ||
  (workerData.unavailableAfterCommitOnce !== undefined &&
    typeof workerData.unavailableAfterCommitOnce !== 'boolean')
)
  throw new Error('Invalid ProjectTaskRoom worker initialization');
const init = workerData as unknown as WorkerInit;
const utf8 = new TextEncoder();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(sort(value));
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
    );
  return value;
}
function exactObject(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  if (!plainDataObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length <= allowed.length && keys.every((key) => allowed.includes(key))
  );
}
function validScope(value: unknown): value is ProjectTaskRoomScope {
  return (
    exactObject(value, ['projectId', 'projectSlug', 'taskId']) &&
    ['projectId', 'projectSlug', 'taskId'].every(
      (key) =>
        typeof value[key] === 'string' &&
        value[key].length > 0 &&
        value[key].length <= 256,
    )
  );
}
function validPrincipal(value: unknown) {
  if (!plainDataObject(value)) return false;
  return value.kind === 'operator'
    ? exactObject(value, ['kind', 'operatorId', 'deviceId']) &&
        typeof value.operatorId === 'string' &&
        typeof value.deviceId === 'string'
    : value.kind === 'agent' &&
        exactObject(value, [
          'kind',
          'agentId',
          'ownerOperatorId',
          'deviceId',
          'authorizationReceiptId',
        ]) &&
        [
          'agentId',
          'ownerOperatorId',
          'deviceId',
          'authorizationReceiptId',
        ].every(
          (key) => typeof value[key] === 'string' && value[key].length > 0,
        );
}
function validResolvedLink(value: unknown, exactKind?: string) {
  return (
    exactObject(value, [
      'schemaVersion',
      'kind',
      'stableId',
      'digest',
      'authorityReceiptId',
    ]) &&
    value.schemaVersion === 'station.project-task-room-resolved-link/v1' &&
    ['run', 'revision', 'proposed-change', 'evidence', 'receipt'].includes(
      value.kind as string,
    ) &&
    (exactKind === undefined || value.kind === exactKind) &&
    ['stableId', 'digest', 'authorityReceiptId'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0,
    )
  );
}
function validBody(value: unknown) {
  if (!plainDataObject(value)) return false;
  if (value.kind === 'human-message')
    return (
      exactObject(value, ['kind', 'text']) && typeof value.text === 'string'
    );
  if (value.kind === 'live-work-started')
    return (
      exactObject(value, ['kind', 'sessionId', 'run']) &&
      typeof value.sessionId === 'string' &&
      (value.run === undefined || validResolvedLink(value.run, 'run'))
    );
  if (value.kind === 'live-work-presence-ended')
    return (
      exactObject(value, ['kind', 'sessionId', 'reason', 'run']) &&
      typeof value.sessionId === 'string' &&
      ['departed', 'withdrawn', 'expired'].includes(value.reason as string) &&
      (value.run === undefined || validResolvedLink(value.run, 'run'))
    );
  if (value.kind === 'live-work-finished')
    return (
      exactObject(value, [
        'kind',
        'sessionId',
        'outcome',
        'run',
        'revision',
        'outcomeLink',
      ]) &&
      typeof value.sessionId === 'string' &&
      ['completed', 'failed', 'cancelled'].includes(value.outcome as string) &&
      (value.run === undefined || validResolvedLink(value.run, 'run')) &&
      (value.revision === undefined ||
        validResolvedLink(value.revision, 'revision')) &&
      (value.outcomeLink === undefined ||
        validResolvedLink(value.outcomeLink, 'receipt'))
    );
  return (
    value.kind === 'outcome-link' &&
    exactObject(value, ['kind', 'link']) &&
    validResolvedLink(value.link)
  );
}
function validGrantReceipt(value: unknown): value is Record<string, unknown> {
  return (
    exactObject(value, [
      'receiptId',
      'capability',
      'scope',
      'principal',
      'policyRevision',
    ]) &&
    typeof value.receiptId === 'string' &&
    value.receiptId.length > 0 &&
    value.receiptId.length <= 256 &&
    [
      'discover',
      'history-read',
      'message-write',
      'lifecycle-append',
      'revision-link',
      'agent-publish',
    ].includes(value.capability as string) &&
    validScope(value.scope) &&
    validPrincipal(value.principal) &&
    typeof value.policyRevision === 'string' &&
    value.policyRevision.length > 0 &&
    value.policyRevision.length <= 256
  );
}
function expectedCapability(principal: unknown, body: unknown) {
  if (!plainDataObject(principal) || !plainDataObject(body)) return undefined;
  if (principal.kind === 'agent') return 'agent-publish';
  return body.kind === 'human-message'
    ? 'message-write'
    : body.kind === 'live-work-started' ||
        body.kind === 'live-work-presence-ended' ||
        body.kind === 'live-work-finished'
      ? 'lifecycle-append'
      : body.kind === 'outcome-link'
        ? 'revision-link'
        : undefined;
}
function validCursor(value: unknown): value is ProjectTaskRoomCursor {
  return (
    exactObject(value, [
      'schemaVersion',
      'channelId',
      'epoch',
      'throughSeq',
      'checkpointDigest',
      'retainedAnchorSeq',
      'retainedAnchorDigest',
      'afterSeq',
      'afterEnvelopeDigest',
      'afterCheckpointDigest',
    ]) &&
    value.schemaVersion === 'station.project-task-room-cursor/v1' &&
    ['epoch', 'throughSeq', 'retainedAnchorSeq', 'afterSeq'].every(
      (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
    ) &&
    Number(value.retainedAnchorSeq) <= Number(value.throughSeq) &&
    [
      'channelId',
      'checkpointDigest',
      'retainedAnchorDigest',
      'afterCheckpointDigest',
    ].every((key) => typeof value[key] === 'string' && value[key].length > 0) &&
    (value.afterEnvelopeDigest === null ||
      (typeof value.afterEnvelopeDigest === 'string' &&
        value.afterEnvelopeDigest.length > 0))
  );
}
function validRequest(value: unknown): value is Request {
  if (
    !measureBoundedJson(value, {
      maxBytes: 48 * 1024,
      maxDepth: 12,
      maxItems: 5_000,
      maxStringCodeUnits: 128 * 1024,
      maxKeyCodeUnits: 256,
    }).ok ||
    !plainDataObject(value) ||
    typeof value.type !== 'string'
  )
    return false;
  if (value.type === 'close') return exactObject(value, ['type']);
  if (value.type === 'read-source-seal')
    return (
      exactObject(value, ['type', 'scope', 'channelId']) &&
      validScope(value.scope) &&
      typeof value.channelId === 'string' &&
      value.channelId.length <= 256
    );
  if (value.type === 'seal-source')
    return (
      exactObject(value, [
        'type',
        'scope',
        'channelId',
        'policyRevision',
        'authorizationId',
        'operationId',
        'sourceHomeRef',
        'targetHomeRef',
      ]) &&
      validScope(value.scope) &&
      [
        'channelId',
        'policyRevision',
        'authorizationId',
        'operationId',
        'sourceHomeRef',
        'targetHomeRef',
      ].every(
        (key) =>
          typeof value[key] === 'string' &&
          value[key].length > 0 &&
          value[key].length <= 256,
      ) &&
      value.sourceHomeRef !== value.targetHomeRef
    );
  if (value.type === 'open')
    return (
      exactObject(value, [
        'type',
        'scope',
        'channelId',
        'policyRevision',
        'authorizationId',
      ]) &&
      validScope(value.scope) &&
      typeof value.channelId === 'string' &&
      typeof value.policyRevision === 'string' &&
      typeof value.authorizationId === 'string'
    );
  if (value.type === 'locate-proposal')
    return (
      exactObject(value, ['type', 'scope', 'channelId', 'proposalId']) &&
      validScope(value.scope) &&
      typeof value.channelId === 'string' &&
      typeof value.proposalId === 'string' &&
      value.proposalId.length > 0 &&
      value.proposalId.length <= 256
    );
  if (value.type === 'read')
    return (
      exactObject(value, [
        'type',
        'scope',
        'channelId',
        'cursor',
        'limit',
        'pageBytes',
      ]) &&
      validScope(value.scope) &&
      typeof value.channelId === 'string' &&
      (value.cursor === undefined || validCursor(value.cursor)) &&
      Number.isSafeInteger(value.limit) &&
      Number(value.limit) > 0 &&
      Number.isSafeInteger(value.pageBytes) &&
      Number(value.pageBytes) > 0
    );
  return (
    value.type === 'append' &&
    exactObject(value, [
      'type',
      'scope',
      'channelId',
      'policyRevision',
      'proposalId',
      'proposalDigest',
      'occurredAt',
      'correlationId',
      'causationId',
      'principal',
      'body',
      'grantReceipt',
      'authorizationId',
      'writeAdmissionRequired',
    ]) &&
    validScope(value.scope) &&
    [
      'channelId',
      'policyRevision',
      'proposalId',
      'proposalDigest',
      'occurredAt',
      'authorizationId',
    ].every((key) => typeof value[key] === 'string' && value[key].length > 0) &&
    (value.correlationId === undefined ||
      typeof value.correlationId === 'string') &&
    (value.causationId === undefined ||
      typeof value.causationId === 'string') &&
    validPrincipal(value.principal) &&
    validBody(value.body) &&
    validGrantReceipt(value.grantReceipt) &&
    canonical(value.grantReceipt.scope) === canonical(value.scope) &&
    canonical(value.grantReceipt.principal) === canonical(value.principal) &&
    value.grantReceipt.policyRevision === value.policyRevision &&
    value.grantReceipt.receiptId === value.authorizationId &&
    typeof value.writeAdmissionRequired === 'boolean' &&
    value.grantReceipt.capability ===
      expectedCapability(value.principal, value.body) &&
    measureBoundedJson(value.body, {
      maxBytes: 16 * 1024,
      maxDepth: 8,
      maxItems: 160,
      maxStringCodeUnits: 8 * 1024,
      maxKeyCodeUnits: 64,
    }).ok
  );
}
const db = new DatabaseSync(init.databasePath, { timeout: 175 });
// archive#3661: bounded retry rather than a silent swallow — see
// `enableWalJournalMode` for why `busy_timeout` does not cover this pragma.
applyWalJournalMode(db, { store: 'project task room history' });
db.exec(PROJECT_TASK_ROOM_HISTORY_MIGRATION);
initializeProjectTaskRoomSourceSeals(db);
let faultPending = init.faultAfterCommitOnce === true;
let unavailableAfterCommitPending = init.unavailableAfterCommitOnce === true;

function head(scope: ProjectTaskRoomScope): Head | undefined {
  return db
    .prepare(
      'SELECT * FROM project_task_room_heads WHERE project_id=? AND task_id=?',
    )
    .get(scope.projectId, scope.taskId) as Head | undefined;
}
function checkpoint(
  value: Head,
  throughSeq = value.head_seq,
  digest = value.head_checkpoint_digest,
): ProjectTaskRoomCheckpoint {
  return {
    channelId: value.channel_id,
    epoch: value.epoch,
    throughSeq,
    checkpointDigest: digest,
    retainedAnchorSeq: value.retained_anchor_seq,
    retainedAnchorDigest: value.retained_anchor_checkpoint_digest,
  };
}
function readIdentity(
  channelId: string,
  proposalId: string,
): Identity | undefined {
  return db
    .prepare(
      'SELECT proposal_id,proposal_digest,epoch,seq,envelope_digest,checkpoint_digest,committed_at,receipt_json,receipt_bytes,receipt_digest FROM project_task_room_identities WHERE channel_id=? AND proposal_id=?',
    )
    .get(channelId, proposalId) as Identity | undefined;
}
function exactReceipt(
  identity: Identity,
  channelId: string,
): ProjectTaskRoomAppendReceipt | undefined {
  try {
    if (
      utf8.encode(identity.receipt_json).byteLength !== identity.receipt_bytes
    )
      return;
    if (sha(identity.receipt_json) !== identity.receipt_digest) return;
    const value = JSON.parse(
      identity.receipt_json,
    ) as ProjectTaskRoomAppendReceipt;
    if (
      value?.schemaVersion !== 'station.project-task-room-append-receipt/v1' ||
      value.proposalId !== identity.proposal_id ||
      value.proposalDigest !== identity.proposal_digest ||
      value.coordinate.channelId !== channelId ||
      value.coordinate.epoch !== identity.epoch ||
      value.coordinate.seq !== identity.seq ||
      value.checkpoint.channelId !== channelId ||
      value.checkpoint.epoch !== identity.epoch ||
      value.checkpoint.throughSeq !== identity.seq ||
      value.checkpoint.retainedAnchorSeq > value.checkpoint.throughSeq ||
      value.envelopeDigest !== identity.envelope_digest ||
      value.checkpoint.checkpointDigest !== identity.checkpoint_digest ||
      value.committedAt !== identity.committed_at
    )
      return;
    return value;
  } catch {
    return;
  }
}

async function open(
  request: Extract<Request, { type: 'open' }>,
  requestId: number,
) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const authorization = await authorizeCommit(
      requestId,
      request.authorizationId,
    );
    if (authorization !== 'admitted') {
      db.exec('ROLLBACK');
      return refused(authorization);
    }
    const value = head(request.scope);
    if (value) {
      db.exec('COMMIT');
      return value.channel_id === request.channelId &&
        value.project_slug === request.scope.projectSlug
        ? { kind: 'existing' }
        : { kind: 'unavailable' };
    }
    const genesis = sha(`room-genesis:${request.channelId}`);
    db.prepare(
      `INSERT INTO project_task_room_heads(channel_id,project_id,project_slug,task_id,epoch,head_seq,head_envelope_digest,head_checkpoint_digest,retained_anchor_seq,retained_anchor_envelope_digest,retained_anchor_checkpoint_digest,policy_revision) VALUES(?,?,?,?,0,0,NULL,?,0,NULL,?,?)`,
    ).run(
      request.channelId,
      request.scope.projectId,
      request.scope.projectSlug,
      request.scope.taskId,
      genesis,
      genesis,
      request.policyRevision,
    );
    db.exec('COMMIT');
    return { kind: 'opened' };
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {}
    return { kind: 'unavailable' };
  }
}

/** Validate and bind all document snapshots while the caller holds the room transaction. */
function roomWorkingStateDigest(
  scope: ProjectTaskRoomScope,
): string | undefined {
  const digest = createHash('sha256').update(
    'station-room-seal-documents/v1\0',
  );
  digest.update(JSON.stringify([scope.projectId, scope.taskId]));
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_task_room_working_states'",
      )
      .get()
  )
    return digest.digest('hex');
  const size = db
    .prepare(`SELECT count(*) AS count,
    coalesce(max(length(CAST(snapshot_json AS BLOB))),0) AS largest,
    coalesce(max(length(CAST(document_id AS BLOB))),0) AS idBytes,
    coalesce(max(length(CAST(revision AS BLOB))),0) AS revisionBytes,
    coalesce(max(length(CAST(compaction_floor AS BLOB))),0) AS floorBytes
    FROM project_task_room_working_states WHERE project_id=? AND task_id=?`)
    .get(scope.projectId, scope.taskId) as {
    count: number;
    largest: number;
    idBytes: number;
    revisionBytes: number;
    floorBytes: number;
  };
  if (
    size.count > 128 ||
    size.largest > 512 * 1024 ||
    size.idBytes > 1024 ||
    size.revisionBytes > 1024 ||
    size.floorBytes > 1024
  )
    return undefined;
  for (const raw of db
    .prepare(`SELECT document_id,snapshot_json,revision,compaction_floor
    FROM project_task_room_working_states WHERE project_id=? AND task_id=? ORDER BY document_id`)
    .iterate(scope.projectId, scope.taskId)) {
    const row = raw as {
      document_id: string;
      snapshot_json: string;
      revision: string;
      compaction_floor: string;
    };
    const state = new SharedWorkingState({
      scope: {
        projectId: scope.projectId,
        taskId: scope.taskId,
        documentId: row.document_id,
      },
      snapshot: JSON.parse(row.snapshot_json),
    });
    const snapshot = state.snapshot();
    if (
      snapshot.revision !== row.revision ||
      typeof row.compaction_floor !== 'string' ||
      row.compaction_floor.length === 0 ||
      snapshot.deferred.length
    )
      return undefined;
    // Length-framed JSON binds the exact accepted source bytes, not just a caller's revision label.
    digest.update(
      JSON.stringify([
        row.document_id,
        row.revision,
        row.compaction_floor,
        row.snapshot_json,
      ]),
    );
  }
  return digest.digest('hex');
}

function inspectSourceSeal(
  request: Extract<Request, { type: 'read-source-seal' }>,
) {
  db.exec('BEGIN');
  try {
    const room = head(request.scope);
    if (
      !room ||
      room.channel_id !== request.channelId ||
      room.project_slug !== request.scope.projectSlug
    )
      return { kind: 'denied' };
    const all = db
      .prepare(
        'SELECT * FROM project_task_room_records WHERE channel_id=? AND epoch=? ORDER BY seq',
      )
      .iterate(room.channel_id, room.epoch) as IterableIterator<Row>;
    if (!validateHistory(room, all)) return { kind: 'unavailable' };
    const row = readProjectTaskRoomSourceSeal(db, request.scope) as
      | {
          operationId: unknown;
          sourceHomeRef: unknown;
          targetHomeRef: unknown;
          checkpointJson: unknown;
          workingStateDigest: unknown;
        }
      | undefined;
    if (!row) return { kind: 'unsealed' };
    if (
      ![row.operationId, row.sourceHomeRef, row.targetHomeRef].every(
        (value) =>
          typeof value === 'string' && value.length > 0 && value.length <= 256,
      ) ||
      row.sourceHomeRef === row.targetHomeRef ||
      typeof row.checkpointJson !== 'string'
    )
      return { kind: 'unavailable' };
    const sealedCheckpoint = JSON.parse(row.checkpointJson);
    if (
      canonical(sealedCheckpoint) !== canonical(checkpoint(room)) ||
      typeof row.workingStateDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.workingStateDigest) ||
      row.workingStateDigest !== roomWorkingStateDigest(request.scope)
    )
      return { kind: 'unavailable' };
    return {
      kind: 'sealed',
      seal: {
        operationId: row.operationId,
        sourceHomeRef: row.sourceHomeRef,
        targetHomeRef: row.targetHomeRef,
        checkpoint: sealedCheckpoint,
        workingStateDigest: row.workingStateDigest,
      },
    };
  } finally {
    db.exec('COMMIT');
  }
}

async function sealSource(
  request: Extract<Request, { type: 'seal-source' }>,
  requestId: number,
) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const room = head(request.scope);
    if (
      !room ||
      room.channel_id !== request.channelId ||
      room.project_slug !== request.scope.projectSlug ||
      room.policy_revision !== request.policyRevision
    ) {
      db.exec('ROLLBACK');
      return { kind: 'denied' };
    }
    const authorization = await authorizeCommit(
      requestId,
      request.authorizationId,
    );
    if (authorization !== 'admitted') {
      db.exec('ROLLBACK');
      return refused(authorization);
    }
    const all = db
      .prepare(
        'SELECT * FROM project_task_room_records WHERE channel_id=? AND epoch=? ORDER BY seq',
      )
      .iterate(room.channel_id, room.epoch) as IterableIterator<Row>;
    if (!validateHistory(room, all)) {
      db.exec('ROLLBACK');
      return { kind: 'unavailable' };
    }
    const existing = readProjectTaskRoomSourceSeal(db, request.scope) as
      | {
          operationId: string;
          sourceHomeRef: string;
          targetHomeRef: string;
          checkpointJson: string;
          workingStateDigest: string | null;
        }
      | undefined;
    if (existing) {
      const documentDigest = roomWorkingStateDigest(request.scope);
      db.exec('ROLLBACK');
      if (
        existing.operationId !== request.operationId ||
        existing.sourceHomeRef !== request.sourceHomeRef ||
        existing.targetHomeRef !== request.targetHomeRef
      )
        return { kind: 'conflict' };
      const priorCheckpoint = JSON.parse(existing.checkpointJson);
      if (
        canonical(priorCheckpoint) !== canonical(checkpoint(room)) ||
        !documentDigest ||
        existing.workingStateDigest !== documentDigest
      )
        return { kind: 'unavailable' };
      return {
        kind: 'sealed',
        seal: {
          operationId: existing.operationId,
          sourceHomeRef: existing.sourceHomeRef,
          targetHomeRef: existing.targetHomeRef,
          checkpoint: priorCheckpoint,
          workingStateDigest: documentDigest,
        },
      };
    }
    // A history-only room need not have materialized working-state tables.
    // If present, both durable publication queues must be empty at closure.
    for (const table of [
      'project_task_room_revision_publication_outbox',
      'project_task_room_agent_lifecycle_outbox',
    ]) {
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) &&
        db
          .prepare(
            `SELECT 1 FROM ${table} WHERE project_id=? AND task_id=? LIMIT 1`,
          )
          .get(request.scope.projectId, request.scope.taskId)
      ) {
        db.exec('ROLLBACK');
        return { kind: 'publication-pending' };
      }
    }
    if (hasPendingProjectTaskRoomExecution(db, request.scope)) {
      db.exec('ROLLBACK');
      return { kind: 'execution-pending' };
    }
    const workingStateDigest = roomWorkingStateDigest(request.scope);
    if (!workingStateDigest) {
      db.exec('ROLLBACK');
      return { kind: 'unavailable' };
    }
    const seal = {
      workingStateDigest,
      operationId: request.operationId,
      sourceHomeRef: request.sourceHomeRef,
      targetHomeRef: request.targetHomeRef,
      checkpoint: checkpoint(room),
    };
    persistProjectTaskRoomSourceSeal(db, request.scope, seal);
    db.exec('COMMIT');
    return { kind: 'sealed', seal };
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {}
    return { kind: 'unavailable' };
  }
}

type CommitPhase = 'authorize' | 'admit-new-write';
type CommitDisposition = 'admitted' | 'denied' | 'unavailable';
const authorizationWaiters = new Map<
  string,
  (disposition: CommitDisposition) => void
>();
function authorizeCommit(
  requestId: number,
  authorizationId: string,
  phase: CommitPhase = 'authorize',
) {
  return new Promise<CommitDisposition>((resolve) => {
    const key = `${requestId}:${authorizationId}:${phase}`;
    authorizationWaiters.set(key, resolve);
    parentPort!.postMessage({
      type: 'authorize',
      id: requestId,
      authorizationId,
      phase,
    });
  });
}

function refused(disposition: CommitDisposition) {
  return { kind: disposition === 'unavailable' ? 'unavailable' : 'denied' };
}

async function append(request: AppendRequest, requestId: number) {
  let committed = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    const room = head(request.scope);
    if (
      !room ||
      room.channel_id !== request.channelId ||
      room.policy_revision !== request.policyRevision
    ) {
      db.exec('ROLLBACK');
      return { kind: 'denied' };
    }
    const authorization = await authorizeCommit(
      requestId,
      request.authorizationId,
    );
    if (authorization !== 'admitted') {
      db.exec('ROLLBACK');
      return refused(authorization);
    }
    const existing = readIdentity(room.channel_id, request.proposalId);
    if (existing) {
      db.exec('COMMIT');
      if (existing.proposal_digest !== request.proposalDigest)
        return { kind: 'conflict' };
      const receipt = exactReceipt(existing, room.channel_id);
      return receipt ? { kind: 'duplicate', receipt } : { kind: 'unavailable' };
    }
    if (readProjectTaskRoomSourceSeal(db, request.scope)) {
      db.exec('ROLLBACK');
      return { kind: 'denied' };
    }
    const count = db
      .prepare(
        'SELECT count(*) AS count FROM project_task_room_identities WHERE channel_id=?',
      )
      .get(room.channel_id) as { count: number };
    if (count.count >= init.maxIdentities) {
      db.exec('ROLLBACK');
      return { kind: 'capacity' };
    }
    if (request.writeAdmissionRequired) {
      const admission = await authorizeCommit(
        requestId,
        request.authorizationId,
        'admit-new-write',
      );
      if (admission !== 'admitted') {
        db.exec('ROLLBACK');
        return refused(admission);
      }
    }
    const seq = room.head_seq + 1;
    const proposalBody = {
      schemaVersion: 'station.project-task-room-proposal/v1',
      scope: request.scope,
      principal: request.principal,
      body: request.body,
      ...(request.correlationId
        ? { correlationId: request.correlationId }
        : {}),
      ...(request.causationId ? { causationId: request.causationId } : {}),
      grantReceipt: request.grantReceipt,
    };
    const proposal: ChannelProposal = {
      schemaVersion: CHANNEL_PROPOSAL_SCHEMA_VERSION,
      proposalId: request.proposalId,
      channelId: room.channel_id,
      author:
        request.principal.kind === 'operator'
          ? {
              memberId: request.principal.operatorId,
              deviceId: request.principal.deviceId,
              keyId: 'station-local-l0',
            }
          : {
              memberId: request.principal.ownerOperatorId,
              deviceId: request.principal.deviceId,
              keyId: request.principal.agentId,
            },
      ...(request.principal.kind === 'agent'
        ? {
            onBehalfOf: {
              ownerMemberId: request.principal.ownerOperatorId,
              authorizationId: request.principal.authorizationReceiptId,
            },
            kind: 'agent-action' as const,
          }
        : { kind: 'message' as const }),
      baseEpoch: room.epoch,
      happenedAt: request.occurredAt,
      body: proposalBody,
    };
    const envelope: ChannelSequencingEnvelope = {
      schemaVersion: CHANNEL_SEQUENCE_SCHEMA_VERSION,
      channelId: room.channel_id,
      epoch: room.epoch,
      seq,
      proposal,
      proposalDigest: sha(channelProposalDigestInput(proposal)),
      committedAt: new Date().toISOString(),
      prevEnvelopeDigest: room.head_envelope_digest,
      policyRevision: room.policy_revision,
      leaseRef: 'station-local-l0',
    };
    if (!validateChannelSequencingEnvelope(envelope).ok) {
      db.exec('ROLLBACK');
      return { kind: 'unavailable' };
    }
    const envelopeMeasure = measureBoundedJson(envelope, {
      maxBytes: 48 * 1024,
      maxDepth: 12,
      maxItems: 500,
      maxStringCodeUnits: 16 * 1024,
      maxKeyCodeUnits: 128,
    });
    if (!envelopeMeasure.ok) throw new Error('room envelope exceeds budget');
    const envelopeDigest = sha(canonical(envelope));
    const nextCheckpoint = sha(
      `${room.head_checkpoint_digest}\u0000${envelopeDigest}`,
    );
    const bodyMeasure = measureBoundedJson(request.body, {
      maxBytes: 16 * 1024,
      maxDepth: 8,
      maxItems: 160,
      maxStringCodeUnits: 8 * 1024,
      maxKeyCodeUnits: 64,
    });
    if (!bodyMeasure.ok) throw new Error('room body exceeds budget');
    const record: ProjectTaskRoomRecord = {
      schemaVersion: 'station.project-task-room/v2',
      scope: request.scope,
      principal: request.principal,
      ...(request.correlationId
        ? { correlationId: request.correlationId }
        : {}),
      ...(request.causationId ? { causationId: request.causationId } : {}),
      envelope,
      body: request.body,
      bodyBytes: bodyMeasure.bytes,
      checkpointDigest: nextCheckpoint,
    };
    const recordMeasure = measureBoundedJson(record, {
      maxBytes: 48 * 1024,
      maxDepth: 12,
      maxItems: 500,
      maxStringCodeUnits: 16 * 1024,
      maxKeyCodeUnits: 128,
    });
    if (!recordMeasure.ok) throw new Error('room record exceeds budget');
    const recordJson = canonical(record);
    const recordBytes = recordMeasure.bytes;
    db.prepare(
      'INSERT INTO project_task_room_records(channel_id,epoch,seq,proposal_id,proposal_digest,envelope_digest,checkpoint_digest,record_json,record_bytes) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      room.channel_id,
      room.epoch,
      seq,
      request.proposalId,
      request.proposalDigest,
      envelopeDigest,
      nextCheckpoint,
      recordJson,
      recordBytes,
    );
    let anchorSeq = room.retained_anchor_seq;
    let anchorEnvelope = room.retained_anchor_envelope_digest;
    let anchorCheckpoint = room.retained_anchor_checkpoint_digest;
    let retainedCount = 0;
    let retainedBytes = 0;
    let floor = seq;
    const newest = db
      .prepare(
        'SELECT seq,record_bytes FROM project_task_room_records WHERE channel_id=? AND epoch=? ORDER BY seq DESC',
      )
      .iterate(room.channel_id, room.epoch) as IterableIterator<{
      seq: number;
      record_bytes: number;
    }>;
    for (const candidate of newest) {
      if (
        retainedCount >= init.retentionRecords ||
        (retainedCount > 0 &&
          candidate.record_bytes > init.retentionBytes - retainedBytes)
      )
        break;
      retainedCount += 1;
      retainedBytes += candidate.record_bytes;
      floor = candidate.seq;
    }
    if (floor - 1 > anchorSeq) {
      const anchor = db
        .prepare(
          'SELECT seq,envelope_digest,checkpoint_digest FROM project_task_room_records WHERE channel_id=? AND epoch=? AND seq=?',
        )
        .get(room.channel_id, room.epoch, floor - 1) as
        | { seq: number; envelope_digest: string; checkpoint_digest: string }
        | undefined;
      if (!anchor) throw new Error('retention anchor unavailable');
      anchorSeq = anchor.seq;
      anchorEnvelope = anchor.envelope_digest;
      anchorCheckpoint = anchor.checkpoint_digest;
    }
    db.prepare(
      'DELETE FROM project_task_room_records WHERE channel_id=? AND epoch=? AND seq<=?',
    ).run(room.channel_id, room.epoch, anchorSeq);
    db.prepare(
      'UPDATE project_task_room_heads SET head_seq=?,head_envelope_digest=?,head_checkpoint_digest=?,retained_anchor_seq=?,retained_anchor_envelope_digest=?,retained_anchor_checkpoint_digest=? WHERE channel_id=? AND head_seq=?',
    ).run(
      seq,
      envelopeDigest,
      nextCheckpoint,
      anchorSeq,
      anchorEnvelope,
      anchorCheckpoint,
      room.channel_id,
      room.head_seq,
    );
    const receipt: ProjectTaskRoomAppendReceipt = {
      schemaVersion: 'station.project-task-room-append-receipt/v1',
      proposalId: request.proposalId,
      proposalDigest: request.proposalDigest,
      envelopeDigest,
      coordinate: { channelId: room.channel_id, epoch: room.epoch, seq },
      checkpoint: {
        channelId: room.channel_id,
        epoch: room.epoch,
        throughSeq: seq,
        checkpointDigest: nextCheckpoint,
        retainedAnchorSeq: anchorSeq,
        retainedAnchorDigest: anchorCheckpoint,
      },
      committedAt: envelope.committedAt,
      assurance: 'L0',
    };
    const receiptMeasure = measureBoundedJson(receipt, {
      maxBytes: 4_096,
      maxDepth: 8,
      maxItems: 80,
      maxStringCodeUnits: 1_024,
      maxKeyCodeUnits: 128,
    });
    if (!receiptMeasure.ok) throw new Error('room receipt exceeds budget');
    const receiptJson = canonical(receipt);
    db.prepare(
      'INSERT INTO project_task_room_identities(channel_id,proposal_id,proposal_digest,epoch,seq,envelope_digest,checkpoint_digest,committed_at,receipt_json,receipt_bytes,receipt_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      room.channel_id,
      request.proposalId,
      request.proposalDigest,
      room.epoch,
      seq,
      envelopeDigest,
      nextCheckpoint,
      envelope.committedAt,
      receiptJson,
      receiptMeasure.bytes,
      sha(receiptJson),
    );
    db.exec('COMMIT');
    committed = true;
    if (faultPending) {
      faultPending = false;
      throw new Error('injected post-commit fault');
    }
    if (unavailableAfterCommitPending) {
      unavailableAfterCommitPending = false;
      return { kind: 'unavailable' };
    }
    return { kind: 'committed', receipt };
  } catch {
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {}
    }
    const identity = readIdentity(request.channelId, request.proposalId);
    if (!identity) return { kind: 'unavailable' };
    if (identity.proposal_digest !== request.proposalDigest)
      return { kind: 'conflict' };
    const receipt = exactReceipt(identity, request.channelId);
    if (!receipt) return { kind: 'unavailable' };
    const row = db
      .prepare(
        'SELECT * FROM project_task_room_records WHERE channel_id=? AND epoch=? AND seq=?',
      )
      .get(request.channelId, identity.epoch, identity.seq) as Row | undefined;
    return row &&
      row.proposal_digest === request.proposalDigest &&
      row.envelope_digest === receipt.envelopeDigest &&
      decode(row)
      ? { kind: 'committed', receipt }
      : { kind: 'unavailable' };
  }
}

function decode(row: Row): ProjectTaskRoomRecord | undefined {
  try {
    if (utf8.encode(row.record_json).byteLength !== row.record_bytes) return;
    const record = JSON.parse(row.record_json) as ProjectTaskRoomRecord;
    const envelope = record?.envelope;
    const payload = envelope?.proposal?.body as
      | Record<string, unknown>
      | undefined;
    const bodyMeasure = measureBoundedJson(record?.body, {
      maxBytes: 16 * 1024,
      maxDepth: 8,
      maxItems: 160,
      maxStringCodeUnits: 8 * 1024,
      maxKeyCodeUnits: 64,
    });
    if (
      record?.schemaVersion !== 'station.project-task-room/v2' ||
      envelope.seq !== row.seq ||
      envelope.channelId !== row.channel_id ||
      envelope.proposal.proposalId !== row.proposal_id ||
      sha(canonical(envelope)) !== row.envelope_digest ||
      sha(channelProposalDigestInput(envelope.proposal)) !==
        envelope.proposalDigest ||
      !validateChannelSequencingEnvelope(envelope).ok ||
      !payload ||
      payload.schemaVersion !== 'station.project-task-room-proposal/v1' ||
      canonical(payload.scope) !== canonical(record.scope) ||
      canonical(payload.principal) !== canonical(record.principal) ||
      canonical(payload.body) !== canonical(record.body) ||
      payload.correlationId !== record.correlationId ||
      payload.causationId !== record.causationId ||
      !bodyMeasure.ok ||
      bodyMeasure.bytes !== record.bodyBytes ||
      record.checkpointDigest !== row.checkpoint_digest
    )
      return;
    const semantic = {
      schemaVersion: 'station.project-task-room-proposal-semantics/v1',
      scope: payload.scope,
      channelId: row.channel_id,
      epoch: row.epoch,
      proposalId: row.proposal_id,
      occurredAt: envelope.proposal.happenedAt,
      principal: payload.principal,
      ...(payload.correlationId
        ? { correlationId: payload.correlationId }
        : {}),
      ...(payload.causationId ? { causationId: payload.causationId } : {}),
      body: payload.body,
      grantReceipt: payload.grantReceipt,
    };
    if (sha(canonical(semantic)) !== row.proposal_digest) return;
    return record;
  } catch {
    return;
  }
}
function validateHistory(room: Head, rows: Iterable<Row>): boolean {
  if (room.head_seq === 0) {
    for (const _row of rows) return false;
    const identities = db
      .prepare(
        'SELECT count(*) AS count FROM project_task_room_identities WHERE channel_id=?',
      )
      .get(room.channel_id) as { count: number };
    const genesis = sha(`room-genesis:${room.channel_id}`);
    return (
      identities.count === 0 &&
      room.head_envelope_digest === null &&
      room.head_checkpoint_digest === genesis &&
      room.retained_anchor_seq === 0 &&
      room.retained_anchor_envelope_digest === null &&
      room.retained_anchor_checkpoint_digest === genesis
    );
  }
  const identities = db
    .prepare(
      'SELECT proposal_id,proposal_digest,epoch,seq,envelope_digest,checkpoint_digest,committed_at,receipt_json,receipt_bytes,receipt_digest FROM project_task_room_identities WHERE channel_id=? ORDER BY seq',
    )
    .iterate(room.channel_id) as IterableIterator<Identity>;
  let identityCount = 0;
  for (const identity of identities) {
    identityCount += 1;
    if (
      identity.seq !== identityCount ||
      identity.epoch !== room.epoch ||
      !exactReceipt(identity, room.channel_id)
    )
      return false;
  }
  if (identityCount !== room.head_seq) return false;
  if (room.retained_anchor_seq > 0) {
    const anchorIdentity = db
      .prepare(
        'SELECT proposal_id,proposal_digest,epoch,seq,envelope_digest,checkpoint_digest,committed_at,receipt_json,receipt_bytes,receipt_digest FROM project_task_room_identities WHERE channel_id=? AND epoch=? AND seq=?',
      )
      .get(room.channel_id, room.epoch, room.retained_anchor_seq) as
      | Identity
      | undefined;
    const anchorReceipt = anchorIdentity
      ? exactReceipt(anchorIdentity, room.channel_id)
      : undefined;
    if (
      !anchorReceipt ||
      anchorReceipt.envelopeDigest !== room.retained_anchor_envelope_digest ||
      anchorReceipt.checkpoint.checkpointDigest !==
        room.retained_anchor_checkpoint_digest
    )
      return false;
  }
  let seq = room.retained_anchor_seq;
  let previous = room.retained_anchor_envelope_digest;
  let rolling = room.retained_anchor_checkpoint_digest;
  for (const row of rows) {
    if (row.seq !== seq + 1) return false;
    const record = decode(row);
    if (
      !record ||
      record.scope.projectId !== room.project_id ||
      record.scope.projectSlug !== room.project_slug ||
      record.scope.taskId !== room.task_id ||
      record.envelope.epoch !== room.epoch ||
      record.envelope.policyRevision !== room.policy_revision ||
      record.envelope.prevEnvelopeDigest !== previous
    )
      return false;
    const identity = readIdentity(room.channel_id, row.proposal_id);
    const receipt = identity
      ? exactReceipt(identity, room.channel_id)
      : undefined;
    if (
      !identity ||
      identity.seq !== row.seq ||
      identity.epoch !== row.epoch ||
      identity.proposal_digest !== row.proposal_digest ||
      !receipt ||
      receipt.envelopeDigest !== row.envelope_digest ||
      receipt.checkpoint.checkpointDigest !== row.checkpoint_digest
    )
      return false;
    rolling = sha(`${rolling}\u0000${row.envelope_digest}`);
    if (rolling !== row.checkpoint_digest) return false;
    previous = row.envelope_digest;
    seq = row.seq;
  }
  return (
    seq === room.head_seq &&
    previous === room.head_envelope_digest &&
    rolling === room.head_checkpoint_digest
  );
}
function historicalCheckpoint(
  room: Head,
  seq: number,
): ProjectTaskRoomCheckpoint | undefined {
  if (seq === 0) {
    const genesis = sha(`room-genesis:${room.channel_id}`);
    return {
      channelId: room.channel_id,
      epoch: room.epoch,
      throughSeq: 0,
      checkpointDigest: genesis,
      retainedAnchorSeq: 0,
      retainedAnchorDigest: genesis,
    };
  }
  const identity = db
    .prepare(
      'SELECT proposal_id,proposal_digest,epoch,seq,envelope_digest,checkpoint_digest,committed_at,receipt_json,receipt_bytes,receipt_digest FROM project_task_room_identities WHERE channel_id=? AND epoch=? AND seq=?',
    )
    .get(room.channel_id, room.epoch, seq) as Identity | undefined;
  return identity
    ? exactReceipt(identity, room.channel_id)?.checkpoint
    : undefined;
}
function historicalReceipt(
  room: Head,
  seq: number,
): ProjectTaskRoomAppendReceipt | undefined {
  if (seq === 0) return undefined;
  const identity = db
    .prepare(
      'SELECT proposal_id,proposal_digest,epoch,seq,envelope_digest,checkpoint_digest,committed_at,receipt_json,receipt_bytes,receipt_digest FROM project_task_room_identities WHERE channel_id=? AND epoch=? AND seq=?',
    )
    .get(room.channel_id, room.epoch, seq) as Identity | undefined;
  return identity ? exactReceipt(identity, room.channel_id) : undefined;
}
/** Locate only; the parent must feed this cursor through the existing full
 * history read/validation path before any record becomes observable. */
function locateProposal(
  request: Extract<Request, { type: 'locate-proposal' }>,
) {
  db.exec('BEGIN');
  try {
    const room = head(request.scope);
    if (!room || room.channel_id !== request.channelId)
      return { kind: 'missing' };
    const identity = readIdentity(room.channel_id, request.proposalId);
    if (!identity || identity.seq <= room.retained_anchor_seq)
      return { kind: 'missing' };
    const receipt = exactReceipt(identity, room.channel_id);
    const before =
      identity.seq > 1 ? historicalReceipt(room, identity.seq - 1) : undefined;
    if (!receipt || (identity.seq > 1 && !before))
      return { kind: 'unavailable' };
    return {
      kind: 'located',
      cursor: {
        schemaVersion: 'station.project-task-room-cursor/v1',
        ...checkpoint(room),
        afterSeq: identity.seq - 1,
        afterEnvelopeDigest: before?.envelopeDigest ?? null,
        afterCheckpointDigest:
          before?.checkpoint.checkpointDigest ??
          sha(`room-genesis:${room.channel_id}`),
      },
    };
  } finally {
    db.exec('COMMIT');
  }
}

function read(request: Extract<Request, { type: 'read' }>) {
  try {
    db.exec('BEGIN');
    const room = head(request.scope);
    if (!room || room.channel_id !== request.channelId) {
      db.exec('COMMIT');
      return { kind: 'denied' };
    }
    const all = db
      .prepare(
        'SELECT * FROM project_task_room_records WHERE channel_id=? AND epoch=? ORDER BY seq',
      )
      .iterate(room.channel_id, room.epoch) as IterableIterator<Row>;
    if (!validateHistory(room, all)) {
      db.exec('COMMIT');
      return { kind: 'unavailable' };
    }
    const cursor = request.cursor;
    const through = cursor?.throughSeq ?? room.head_seq;
    const snapshot = historicalCheckpoint(room, through);
    const cursorAnchor = cursor
      ? historicalCheckpoint(room, cursor.retainedAnchorSeq)
      : undefined;
    const afterReceipt = cursor
      ? historicalReceipt(room, cursor.afterSeq)
      : undefined;
    const expectedAfterEnvelope =
      cursor?.afterSeq === 0 ? null : afterReceipt?.envelopeDigest;
    const expectedAfterCheckpoint =
      cursor?.afterSeq === 0
        ? sha(`room-genesis:${room.channel_id}`)
        : afterReceipt?.checkpoint.checkpointDigest;
    if (
      cursor &&
      (cursor.channelId !== room.channel_id ||
        cursor.epoch !== room.epoch ||
        cursorAnchor?.checkpointDigest !== cursor.retainedAnchorDigest ||
        cursor.afterSeq > through ||
        through > room.head_seq ||
        snapshot?.checkpointDigest !== cursor.checkpointDigest ||
        expectedAfterEnvelope !== cursor.afterEnvelopeDigest ||
        expectedAfterCheckpoint !== cursor.afterCheckpointDigest)
    ) {
      db.exec('COMMIT');
      return { kind: 'stale', checkpoint: checkpoint(room) };
    }
    if (!snapshot) {
      db.exec('COMMIT');
      return { kind: 'stale', checkpoint: checkpoint(room) };
    }
    const cp: ProjectTaskRoomCheckpoint = cursor
      ? {
          ...snapshot,
          retainedAnchorSeq: cursor.retainedAnchorSeq,
          retainedAnchorDigest: cursor.retainedAnchorDigest,
        }
      : checkpoint(room, through, snapshot.checkpointDigest);
    const after = cursor?.afterSeq ?? 0;
    if (after < through && after < room.retained_anchor_seq) {
      const resumeAnchor = Math.min(room.retained_anchor_seq, through);
      const resumeReceipt = historicalReceipt(room, resumeAnchor);
      const genesis = sha(`room-genesis:${room.channel_id}`);
      const resumeAnchorDigest =
        resumeAnchor === 0
          ? genesis
          : (resumeReceipt?.checkpoint.checkpointDigest ?? genesis);
      db.exec('COMMIT');
      return {
        kind: 'gap',
        missingThroughSeq: resumeAnchor,
        checkpoint: {
          ...cp,
          retainedAnchorSeq: resumeAnchor,
          retainedAnchorDigest: resumeAnchorDigest,
        },
        resumeCursor: {
          schemaVersion: 'station.project-task-room-cursor/v1',
          channelId: room.channel_id,
          epoch: room.epoch,
          throughSeq: through,
          checkpointDigest: cp.checkpointDigest,
          retainedAnchorSeq: resumeAnchor,
          retainedAnchorDigest: resumeAnchorDigest,
          afterSeq: resumeAnchor,
          afterEnvelopeDigest:
            resumeAnchor === 0 ? null : (resumeReceipt?.envelopeDigest ?? null),
          afterCheckpointDigest:
            resumeAnchor === 0
              ? genesis
              : (resumeReceipt?.checkpoint.checkpointDigest ?? genesis),
        },
      };
    }
    const records: ProjectTaskRoomRecord[] = [];
    let bytes = 0;
    const rows = db
      .prepare(
        'SELECT * FROM project_task_room_records WHERE channel_id=? AND epoch=? AND seq>? AND seq<=? ORDER BY seq',
      )
      .iterate(
        room.channel_id,
        room.epoch,
        after,
        through,
      ) as IterableIterator<Row>;
    for (const row of rows) {
      if (
        records.length >= request.limit ||
        bytes + row.record_bytes > request.pageBytes
      )
        break;
      const record = decode(row);
      if (!record) {
        db.exec('COMMIT');
        return { kind: 'unavailable' };
      }
      records.push(record);
      bytes += row.record_bytes;
    }
    const last = records.at(-1)?.envelope.seq ?? after;
    const lastRecord = records.at(-1);
    const hasMore = last < through;
    const result = {
      kind: 'available',
      records,
      checkpoint: cp,
      hasMore,
      ...(hasMore
        ? {
            nextCursor: {
              schemaVersion: 'station.project-task-room-cursor/v1',
              channelId: room.channel_id,
              epoch: room.epoch,
              throughSeq: through,
              checkpointDigest: cp.checkpointDigest,
              retainedAnchorSeq: cp.retainedAnchorSeq,
              retainedAnchorDigest: cp.retainedAnchorDigest,
              afterSeq: last,
              afterEnvelopeDigest: lastRecord
                ? sha(canonical(lastRecord.envelope))
                : (cursor?.afterEnvelopeDigest ?? null),
              afterCheckpointDigest:
                lastRecord?.checkpointDigest ??
                cursor?.afterCheckpointDigest ??
                cp.retainedAnchorDigest,
            },
          }
        : {}),
      integrity: 'L0',
    };
    if (
      !measureBoundedJson(result, {
        maxBytes: request.pageBytes + 4_096,
        maxDepth: 16,
        maxItems: PROJECT_TASK_ROOM_MAX_PAGE_JSON_ITEMS,
        maxStringCodeUnits: 16 * 1024,
        maxKeyCodeUnits: 128,
      }).ok
    ) {
      db.exec('COMMIT');
      return { kind: 'unavailable' };
    }
    db.exec('COMMIT');
    return result;
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {}
    return { kind: 'unavailable' };
  }
}

if (!parentPort)
  throw new Error('ProjectTaskRoom worker requires a parent port');
async function handleRequest(message: unknown) {
  if (
    !exactObject(message, ['id', 'request']) ||
    !Number.isSafeInteger(message.id) ||
    !validRequest(message.request)
  ) {
    const id =
      plainDataObject(message) && Number.isSafeInteger(message.id)
        ? message.id
        : -1;
    parentPort!.postMessage({ id, result: { kind: 'unavailable' } });
    return;
  }
  let result: unknown;
  try {
    result =
      message.request.type === 'open'
        ? await open(message.request, Number(message.id))
        : message.request.type === 'append'
          ? await append(message.request, Number(message.id))
          : message.request.type === 'read-source-seal'
            ? inspectSourceSeal(message.request)
            : message.request.type === 'seal-source'
              ? await sealSource(message.request, Number(message.id))
              : message.request.type === 'locate-proposal'
                ? locateProposal(message.request)
                : message.request.type === 'read'
                  ? read(message.request)
                  : { kind: 'closed' };
  } catch {
    result = { kind: 'unavailable' };
  }
  if (message.request.type === 'close') {
    db.close();
    parentPort!.postMessage({ id: message.id, result });
    parentPort!.close();
  } else parentPort!.postMessage({ id: message.id, result });
}
let requestQueue = Promise.resolve();
parentPort.on('message', (message: unknown) => {
  if (
    exactObject(message, [
      'type',
      'id',
      'authorizationId',
      'phase',
      'disposition',
    ]) &&
    message.type === 'authorization' &&
    Number.isSafeInteger(message.id) &&
    typeof message.authorizationId === 'string' &&
    (message.phase === 'authorize' || message.phase === 'admit-new-write') &&
    ['admitted', 'denied', 'unavailable'].includes(
      message.disposition as string,
    )
  ) {
    const key = `${message.id}:${message.authorizationId}:${message.phase}`;
    const resolve = authorizationWaiters.get(key);
    if (resolve) {
      authorizationWaiters.delete(key);
      resolve(message.disposition as CommitDisposition);
    }
    return;
  }
  requestQueue = requestQueue.then(
    () => handleRequest(message),
    () => handleRequest(message),
  );
});
