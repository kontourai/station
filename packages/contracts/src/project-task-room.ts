import type { ChannelSequencingEnvelope } from './channel-log.js';

export const PROJECT_TASK_ROOM_SCHEMA_VERSION =
  'station.project-task-room/v2' as const;
export const PROJECT_TASK_ROOM_GRANT_SCHEMA_VERSION =
  'station.project-task-room-grant/v1' as const;
export const PROJECT_TASK_ROOM_ASSURANCE = 'L0' as const;
/**
 * Exact worst-case item counts for the closed v2 record/page shapes. The
 * record maximum uses the agent principal, lifecycle-finished body with run
 * link, correlation+causation, and embedded grant receipt. The wrapper maximum
 * includes checkpoint plus continuation cursor. Changing either closed schema
 * requires changing this derivation beside it.
 */
export const PROJECT_TASK_ROOM_MAX_RECORD_JSON_ITEMS =
  1 + 1 + 4 + 10 + 1 + 1 + 62 + 10 + 1 + 1;
export const PROJECT_TASK_ROOM_MAX_PAGE_WRAPPER_JSON_ITEMS =
  1 + 1 + 1 + 7 + 1 + 11 + 1;
export const PROJECT_TASK_ROOM_MAX_PAGE_RECORDS = 100;
export const PROJECT_TASK_ROOM_MAX_PAGE_JSON_ITEMS =
  PROJECT_TASK_ROOM_MAX_RECORD_JSON_ITEMS * PROJECT_TASK_ROOM_MAX_PAGE_RECORDS +
  PROJECT_TASK_ROOM_MAX_PAGE_WRAPPER_JSON_ITEMS;
export interface ProjectTaskRoomScope {
  projectId: string;
  projectSlug: string;
  taskId: string;
}
export type ProjectTaskRoomGrantKind =
  | 'discover'
  | 'history-read'
  | 'message-write'
  | 'lifecycle-append'
  | 'revision-link'
  | 'home-transfer'
  | 'agent-publish';
declare const roomGrantBrand: unique symbol;
export interface ProjectTaskRoomGrant<K extends ProjectTaskRoomGrantKind> {
  readonly schemaVersion: typeof PROJECT_TASK_ROOM_GRANT_SCHEMA_VERSION;
  readonly capability: K;
  readonly opaqueToken: string;
  readonly [roomGrantBrand]: K;
}
export interface ProjectTaskRoomHumanPrincipal {
  kind: 'operator';
  operatorId: string;
  deviceId: string;
}
export interface ProjectTaskRoomAgentPrincipal {
  kind: 'agent';
  agentId: string;
  ownerOperatorId: string;
  deviceId: string;
  authorizationReceiptId: string;
}
export type ProjectTaskRoomPrincipal =
  | ProjectTaskRoomHumanPrincipal
  | ProjectTaskRoomAgentPrincipal;
export interface ProjectTaskRoomResolvedLink {
  schemaVersion: 'station.project-task-room-resolved-link/v1';
  kind: 'run' | 'revision' | 'proposed-change' | 'evidence' | 'receipt';
  /** `receipt` links a durable Station receipt as content, not this authority's receipt. */
  stableId: string;
  digest: string;
  authorityReceiptId: string;
}
export type ProjectTaskRoomAppendBody =
  | { kind: 'human-message'; text: string }
  | { kind: 'live-work-started'; sessionId: string; runReference?: string }
  | {
      /** Presence is a collaboration fact, never a work terminal state. */
      kind: 'live-work-presence-ended';
      sessionId: string;
      reason: 'departed' | 'withdrawn' | 'expired';
      runReference?: string;
    }
  | {
      kind: 'live-work-finished';
      sessionId: string;
      outcome: 'completed' | 'failed' | 'cancelled';
      runReference?: string;
      revisionReference?: string;
      outcomeReference?: string;
    }
  | {
      kind: 'outcome-link';
      linkKind: ProjectTaskRoomResolvedLink['kind'];
      reference: string;
    };
export type ProjectTaskRoomBody =
  | { kind: 'human-message'; text: string }
  | {
      kind: 'live-work-started';
      sessionId: string;
      run?: ProjectTaskRoomResolvedLink;
    }
  | {
      kind: 'live-work-presence-ended';
      sessionId: string;
      reason: 'departed' | 'withdrawn' | 'expired';
      run?: ProjectTaskRoomResolvedLink;
    }
  | {
      kind: 'live-work-finished';
      sessionId: string;
      outcome: 'completed' | 'failed' | 'cancelled';
      run?: ProjectTaskRoomResolvedLink;
      revision?: ProjectTaskRoomResolvedLink;
      outcomeLink?: ProjectTaskRoomResolvedLink;
    }
  | { kind: 'outcome-link'; link: ProjectTaskRoomResolvedLink };
export interface ProjectTaskRoomAppendIntent {
  proposalId: string;
  occurredAt: string;
  correlationId?: string;
  causationId?: string;
  body: ProjectTaskRoomAppendBody;
}
export interface ProjectTaskRoomRecord {
  schemaVersion: typeof PROJECT_TASK_ROOM_SCHEMA_VERSION;
  scope: ProjectTaskRoomScope;
  principal: ProjectTaskRoomPrincipal;
  correlationId?: string;
  causationId?: string;
  envelope: ChannelSequencingEnvelope;
  body: ProjectTaskRoomBody;
  bodyBytes: number;
  checkpointDigest: string;
}
export interface ProjectTaskRoomCheckpoint {
  channelId: string;
  epoch: number;
  throughSeq: number;
  checkpointDigest: string;
  retainedAnchorSeq: number;
  retainedAnchorDigest: string;
}
export interface ProjectTaskRoomAppendReceipt {
  schemaVersion: 'station.project-task-room-append-receipt/v1';
  proposalId: string;
  proposalDigest: string;
  envelopeDigest: string;
  coordinate: { channelId: string; epoch: number; seq: number };
  checkpoint: ProjectTaskRoomCheckpoint;
  committedAt: string;
  assurance: typeof PROJECT_TASK_ROOM_ASSURANCE;
}

/** Closed, transport-safe validation for a room's immutable append receipt. */
export function isProjectTaskRoomAppendReceipt(
  value: unknown,
): value is ProjectTaskRoomAppendReceipt {
  if (
    !plainOwn(value, [
      'schemaVersion',
      'proposalId',
      'proposalDigest',
      'envelopeDigest',
      'coordinate',
      'checkpoint',
      'committedAt',
      'assurance',
    ])
  )
    return false;
  return (
    value.schemaVersion === 'station.project-task-room-append-receipt/v1' &&
    roomId(value.proposalId) &&
    sha256(value.proposalDigest) &&
    sha256(value.envelopeDigest) &&
    plainOwn(value.coordinate, ['channelId', 'epoch', 'seq']) &&
    roomId(value.coordinate.channelId) &&
    nonnegative(value.coordinate.epoch) &&
    positive(value.coordinate.seq) &&
    isProjectTaskRoomCheckpoint(value.checkpoint) &&
    value.coordinate.channelId === value.checkpoint.channelId &&
    value.coordinate.epoch === value.checkpoint.epoch &&
    value.coordinate.seq === value.checkpoint.throughSeq &&
    canonicalTimestamp(value.committedAt) &&
    value.assurance === PROJECT_TASK_ROOM_ASSURANCE
  );
}

export function isProjectTaskRoomCheckpoint(
  value: unknown,
): value is ProjectTaskRoomCheckpoint {
  return (
    plainOwn(value, [
      'channelId',
      'epoch',
      'throughSeq',
      'checkpointDigest',
      'retainedAnchorSeq',
      'retainedAnchorDigest',
    ]) &&
    roomId(value.channelId) &&
    nonnegative(value.epoch) &&
    nonnegative(value.throughSeq) &&
    sha256(value.checkpointDigest) &&
    nonnegative(value.retainedAnchorSeq) &&
    value.retainedAnchorSeq <= value.throughSeq &&
    sha256(value.retainedAnchorDigest)
  );
}

function plainOwn(
  value: unknown,
  keys: readonly string[],
): value is Record<string, any> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const own = Reflect.ownKeys(value);
    return (
      own.length === keys.length &&
      own.every((key) => {
        if (typeof key !== 'string' || !keys.includes(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && 'value' in descriptor;
      })
    );
  } catch {
    return false;
  }
}
function roomId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256)
    return false;
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    if (point < 32 || (point >= 0xd800 && point <= 0xdfff)) return false;
  }
  return true;
}
function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
export type ProjectTaskRoomOpenOutcome =
  | {
      kind: 'opened' | 'existing';
      scope: ProjectTaskRoomScope;
      channelId: string;
      assurance: typeof PROJECT_TASK_ROOM_ASSURANCE;
    }
  | { kind: 'not-found' | 'denied' | 'unavailable' };
export type ProjectTaskRoomAppendRejection =
  | 'malformed'
  | 'wrong-scope'
  | 'idempotency-conflict'
  | 'link-unresolved'
  | 'link-unverified'
  | 'capacity'
  | 'unsupported';
export type ProjectTaskRoomAppendOutcome =
  | { kind: 'committed'; receipt: ProjectTaskRoomAppendReceipt }
  | { kind: 'duplicate'; receipt: ProjectTaskRoomAppendReceipt }
  | { kind: 'rejected'; reason: ProjectTaskRoomAppendRejection }
  | { kind: 'denied' | 'unavailable' };
export interface ProjectTaskRoomCursor {
  schemaVersion: 'station.project-task-room-cursor/v1';
  channelId: string;
  epoch: number;
  throughSeq: number;
  checkpointDigest: string;
  retainedAnchorSeq: number;
  retainedAnchorDigest: string;
  afterSeq: number;
  afterEnvelopeDigest: string | null;
  afterCheckpointDigest: string;
}
export type ProjectTaskRoomReadOutcome =
  | {
      kind: 'available';
      records: readonly ProjectTaskRoomRecord[];
      checkpoint: ProjectTaskRoomCheckpoint;
      hasMore: boolean;
      nextCursor?: ProjectTaskRoomCursor;
      integrity: typeof PROJECT_TASK_ROOM_ASSURANCE;
    }
  | { kind: 'stale'; checkpoint?: ProjectTaskRoomCheckpoint }
  | {
      kind: 'gap';
      missingThroughSeq: number;
      checkpoint: ProjectTaskRoomCheckpoint;
      /** Authority-issued acknowledgement cursor for the retained suffix. */
      resumeCursor: ProjectTaskRoomCursor;
    }
  | { kind: 'invalid-cursor' | 'not-found' | 'denied' | 'unavailable' };
export type ProjectTaskRoomCloseOutcome = {
  kind: 'closed' | 'pending' | 'unavailable';
};
export interface ProjectTaskRoomAuthority {
  open(input: {
    grant: ProjectTaskRoomGrant<'discover'>;
  }): Promise<ProjectTaskRoomOpenOutcome>;
  append(input: {
    grant: ProjectTaskRoomGrant<
      'message-write' | 'lifecycle-append' | 'revision-link' | 'agent-publish'
    >;
    intent: ProjectTaskRoomAppendIntent;
  }): Promise<ProjectTaskRoomAppendOutcome>;
  read(input: {
    grant: ProjectTaskRoomGrant<'history-read'>;
    cursor?: ProjectTaskRoomCursor;
    limit?: number;
  }): Promise<ProjectTaskRoomReadOutcome>;
  close(): Promise<ProjectTaskRoomCloseOutcome>;
}
