import type {
  ApplyResult,
  SharedWorkingStateLivePort,
  SharedWorkingStateRecoveryPort,
  TextDocumentOperation,
} from '../src-server/domain/shared-working-state.js';
import type {
  SharedWorkingStateEditBatch,
  SharedWorkingStateEditingCapability,
} from '../src-server/domain/shared-working-state-editing.js';
import {
  MAX_COLLABORATIVE_EDIT_BATCH_BYTES,
  MAX_COLLABORATIVE_EDIT_BATCH_OPERATIONS,
  MAX_COLLABORATIVE_EDIT_OPERATION_BYTES,
} from './collaborative-edit-limits.js';

/** Deep, host-neutral editor-pane Module for #2890. */
export const COLLABORATIVE_ROOM_SCHEMA_VERSION = 1 as const;
export const MAX_COLLABORATIVE_PARTICIPANTS = 64;
export const MAX_COLLABORATIVE_CURSORS = 64;
export const MAX_COLLABORATIVE_PENDING_INTENTS = 64;
export const MAX_COLLABORATIVE_PENDING_BYTES =
  MAX_COLLABORATIVE_EDIT_BATCH_BYTES;
export const MAX_COLLABORATIVE_RELEASED_OPERATIONS = 64;
export const MAX_COLLABORATIVE_ATTRIBUTIONS = 64;
export const MAX_COLLABORATIVE_REJECTIONS = 64;
export const MAX_COLLABORATIVE_TEXT_BYTES = 256 * 1024;
export const MAX_COLLABORATIVE_ID_BYTES = 256;
export const MAX_COLLABORATIVE_LABEL_BYTES = 512;
export const COLLABORATIVE_PRESENCE_TTL_MS = 15_000;
export const COLLABORATIVE_CURSOR_RATE_LIMIT_PER_SECOND = 20;

export type CollaborativeActorKind = 'human' | 'agent';
export type CollaborativeDocumentMode =
  | 'solo'
  | 'live'
  | 'pending'
  | 'rejected-write'
  | 'read-only'
  | 'resyncing'
  | 'stale'
  | 'unavailable';
export type CollaborativeRoomConnection =
  | 'disconnected'
  | 'connected'
  | 'reconnecting'
  | 'stale';

export interface CollaborativePaneScope {
  readonly projectId: string;
  readonly taskId: string;
  readonly documentId: string;
}

export interface CollaborativeCapabilities {
  readonly document: { readonly read: boolean; readonly write: boolean };
  /** Join/read/share/watch/follow are deliberately independent. */
  readonly room: {
    readonly join: boolean;
    readonly read: boolean;
    readonly share: boolean;
    readonly watch: boolean;
    readonly follow: boolean;
  };
}

export interface CollaborativeAuthorityAvailable {
  readonly state: 'AVAILABLE';
  readonly authorityRevision: string;
  readonly actorId: string;
  readonly scope: CollaborativePaneScope;
  readonly capabilities: CollaborativeCapabilities;
}

/** Server-owned and dynamically resolved at every ingress. */
export interface CollaborativeAuthorityAdapter {
  current(): unknown;
}

export interface CollaborativePrincipalAuthorityAdapter {
  resolve(input: {
    readonly actorId: string;
    readonly scope: CollaborativePaneScope;
    readonly workingStateRevision: string;
  }): unknown;
}

export interface CollaborativeTargetProjectionAuthorityAdapter {
  resolve(input: {
    readonly scope: CollaborativePaneScope;
    readonly workingStateRevision: string;
  }): unknown;
}

/** Mints an opaque one-use host capability from the current exact authority. */
export interface CollaborativeNavigationCapabilityAuthorityAdapter {
  mint(input: {
    readonly actorId: string;
    readonly scope: CollaborativePaneScope;
    readonly view: CollaborativeFollowableView;
    readonly authorityRevision: string;
    readonly reason: 'jump' | 'follow';
  }): unknown;
}

export interface CollaborativeRoomStreamAuthorityAdapter {
  current(scope: CollaborativePaneScope): unknown;
}

export type SharedSurfaceLocation =
  | {
      readonly state: 'shared-project-task';
      readonly projectId: string;
      readonly taskId: string;
    }
  | { readonly state: 'authorized-unshared' }
  | { readonly state: 'outside-or-undisclosed' };

export interface CollaborativeSelection {
  readonly anchor: number;
  readonly focus: number;
}

export interface CollaborativeFollowableView {
  readonly paneId: string;
  readonly documentId: string;
  readonly workingStateRevision: string;
  readonly selection: CollaborativeSelection;
  readonly viewportAnchor: number;
}

export interface CollaborativeParticipant {
  readonly actorId: string;
  readonly kind: CollaborativeActorKind;
  readonly label: string;
  readonly surface: SharedSurfaceLocation;
  readonly expiresAt: number;
  readonly agentSessionId?: string;
  readonly runId?: string;
  readonly followableView?: CollaborativeFollowableView;
}

export interface CollaborativeCursor {
  readonly actorId: string;
  readonly workingStateRevision: string;
  readonly selection: CollaborativeSelection;
  readonly expiresAt: number;
}

export interface CollaborativeDocumentProjection {
  readonly scope: CollaborativePaneScope;
  readonly text: string;
  /** #2889 working-state revision, never an immutable evidence revision. */
  readonly workingStateRevision: string;
}

export type CollaborativeOperation = TextDocumentOperation;

export type CollaborativeConvergenceResult =
  | {
      readonly outcome: 'applied' | 'replayed';
      readonly operationId: string;
      readonly operationDeferred: boolean;
      readonly releasedOperationIds: readonly string[];
      readonly projection: CollaborativeDocumentProjection;
    }
  | {
      readonly outcome: 'duplicate';
      readonly operationId: string;
      readonly operationDeferred: boolean;
      readonly projection: CollaborativeDocumentProjection;
    }
  | {
      readonly outcome: 'deferred';
      readonly operationId: string;
      readonly operationDeferred: true;
      readonly missing: readonly string[];
      readonly projection: CollaborativeDocumentProjection;
    }
  | {
      readonly outcome: 'rejected';
      readonly operationId: string;
      readonly reason: string;
      readonly projection: CollaborativeDocumentProjection;
    }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export type CollaborativeProjectionResult =
  | {
      readonly outcome: 'available';
      readonly projection: CollaborativeDocumentProjection;
    }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface SharedWorkingStateProjectionAdapter {
  projection(): unknown;
  applyAccepted(operation: CollaborativeOperation): unknown;
  resync(signal: AbortSignal): Promise<unknown>;
}

/**
 * Direct Station-owned #2889 adapter. Recovery admits accepted authoritative
 * facts and never trusts a client writer epoch or merges text.
 */
export function createSharedWorkingStateProjectionAdapter(options: {
  live: SharedWorkingStateLivePort;
  recovery: SharedWorkingStateRecoveryPort;
  resync?: (signal: AbortSignal) => Promise<unknown>;
}): SharedWorkingStateProjectionAdapter {
  const projection = (): CollaborativeDocumentProjection => ({
    scope: cloneScope(options.live.scope),
    text: options.live.text(),
    workingStateRevision: options.live.revision,
  });
  return {
    projection: () => {
      try {
        return { outcome: 'available', projection: projection() };
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'working-state projection unavailable',
        };
      }
    },
    applyAccepted: (operation) => {
      try {
        const result = options.recovery.replay(operation);
        const operationDeferred = options.live
          .snapshot()
          .deferred.some(
            (entry) => entry.operation.operationId === operation.operationId,
          );
        return convergenceResult(
          operation.operationId,
          result,
          projection(),
          operationDeferred,
        );
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'working-state apply unavailable',
        };
      }
    },
    resync: async (signal) => {
      if (!options.resync)
        return {
          outcome: 'unavailable',
          reason: 'working-state resync unavailable',
        };
      try {
        return await options.resync(signal);
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'working-state resync unavailable',
        };
      }
    },
  };
}

function convergenceResult(
  operationId: string,
  result: ApplyResult,
  projection: CollaborativeDocumentProjection,
  operationDeferred: boolean,
): CollaborativeConvergenceResult {
  switch (result.outcome) {
    case 'applied':
    case 'replayed':
      return {
        outcome: result.outcome,
        operationId,
        operationDeferred,
        releasedOperationIds: [...result.releasedOperationIds],
        projection,
      };
    case 'duplicate':
      return {
        outcome: 'duplicate',
        operationId,
        operationDeferred,
        projection,
      };
    case 'deferred':
      return {
        outcome: 'deferred',
        operationId,
        operationDeferred: true,
        missing: [...result.missing],
        projection,
      };
    case 'rejected':
      return {
        outcome: 'rejected',
        operationId,
        reason: result.reason,
        projection,
      };
  }
}

export interface CollaborativeTransportBatch {
  readonly intentId: string;
  readonly digest: string;
  readonly operations: readonly CollaborativeOperation[];
}

export type CollaborativeTransportResult =
  | {
      readonly outcome: 'accepted';
      readonly intentId: string;
      readonly digest: string;
    }
  | {
      readonly outcome: 'refused';
      readonly intentId: string;
      readonly digest: string;
      readonly reason: string;
    }
  | {
      readonly outcome: 'indeterminate';
      readonly intentId: string;
      readonly digest: string;
      readonly reason: string;
    }
  | {
      readonly outcome: 'definitely-not-invoked';
      readonly intentId: string;
      readonly digest: string;
      readonly reason: string;
    };

/** Transport owns idempotent retry and returns exact possible-effect truth. */
export interface CollaborativeEditorTransportAdapter {
  submitBatch(batch: CollaborativeTransportBatch): Promise<unknown>;
}

export interface CollaborativePendingIntent {
  readonly intentId: string;
  readonly operationCount: number;
  readonly createdAt: number;
  readonly states: Readonly<{
    uninvoked: number;
    possibleEffect: number;
    committedAwaitingProjection: number;
    indeterminate: number;
    refused: number;
  }>;
  readonly reason?: string;
}

type PendingOperationSettlement =
  | 'uninvoked'
  | 'possible-effect'
  | 'committed-awaiting-projection'
  | 'indeterminate'
  | 'refused'
  | 'projected';

interface PendingOperationRecord {
  readonly operationId: string;
  readonly operation: CollaborativeOperation;
  readonly settlement: PendingOperationSettlement;
  readonly reason?: string;
}

interface PendingIntentRecord {
  readonly intentId: string;
  readonly batchDigest: string;
  /** Bounded by the pending-intent cap until its one total response settles. */
  readonly submitted: boolean;
  readonly transportOutcome?: CollaborativeTransportResult['outcome'];
  readonly order: number;
  readonly operations: readonly PendingOperationRecord[];
  readonly selection: CollaborativeSelection;
  readonly createdAt: number;
  readonly retainedBytes: number;
}

/**
 * Room Adapter owns source TTL enforcement and upstream capacity. The
 * controller revalidates hard limits and subscribes only with join+read.
 */
export interface CollaborativeLiveRoomContextAdapter {
  subscribe(listener: (update: unknown) => void): () => void;
  requestFreshSignals?(input: {
    readonly scope: CollaborativePaneScope;
    readonly workingStateRevision: string;
  }): unknown;
}

export interface CollaborativeRoomUpdate {
  readonly schemaVersion: typeof COLLABORATIVE_ROOM_SCHEMA_VERSION;
  readonly kind: 'snapshot' | 'delta';
  readonly generation: number;
  readonly epoch: string;
  readonly sequence: number;
  readonly scope: CollaborativePaneScope;
  readonly connection: 'connected' | 'reconnecting';
  readonly participants: readonly CollaborativeParticipant[];
  readonly cursors: readonly CollaborativeCursor[];
  readonly departedActorIds: readonly string[];
}

export interface CollaborativeCursorPublication {
  readonly schemaVersion: typeof COLLABORATIVE_ROOM_SCHEMA_VERSION;
  readonly scope: CollaborativePaneScope;
  readonly actorId: string;
  readonly workingStateRevision: string;
  readonly selection: CollaborativeSelection;
  readonly expiresAt: number;
}

/** Adapter owns the declared rate and capacity; publication is ephemeral. */
export interface CollaborativeCursorOutputAdapter {
  readonly maxPerSecond: number;
  publish(cursor: CollaborativeCursorPublication): unknown;
}

export interface CollaborativeEphemeralScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

export type CollaborativeWatchState =
  | { readonly state: 'off' }
  | {
      readonly state: 'active';
      readonly targetActorId: string;
      readonly view: CollaborativeFollowableView;
      readonly following: boolean;
    }
  | {
      readonly state: 'paused';
      readonly targetActorId: string;
      readonly reason:
        | 'departed'
        | 'target-missing'
        | 'reconnecting'
        | 'view-unavailable'
        | 'navigation-unavailable';
      readonly resumeFollow: boolean;
    };

export type CollaborativeHostIntentResult =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface CollaborativePaneHostAdapter {
  /** Validates and consumes the opaque capability while joining and navigating. */
  joinAndNavigate(intent: {
    readonly reason: 'jump' | 'follow';
    readonly targetActorId: string;
    readonly view: CollaborativeFollowableView;
    readonly capability: string;
  }): unknown;
  requestSurfaceJoin(intent: {
    readonly targetActorId: string;
    readonly scope: CollaborativePaneScope;
  }): unknown;
  share(intent: {
    readonly scope: CollaborativePaneScope;
    readonly workingStateRevision: string;
  }): unknown;
}

export interface ImmutableRevisionRequest {
  readonly evidenceRevisionId: string;
  readonly scope: CollaborativePaneScope;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

export type ImmutableRevisionResolution =
  | {
      readonly state: 'AVAILABLE';
      readonly evidenceRevisionId: string;
      readonly scope: CollaborativePaneScope;
      readonly correlationId: string;
      readonly workingStateRevision: string;
      readonly projection: CollaborativeDocumentProjection;
    }
  | {
      readonly state: 'UNAVAILABLE' | 'UNVERIFIED';
      readonly reason: string;
    };

/** Server-owned #2891-compatible immutable revision resolver. */
export interface CollaborativeRevisionResolverAdapter {
  resolve(request: ImmutableRevisionRequest): Promise<unknown>;
}

export interface AcceptedOperationAttribution {
  readonly operationId: string;
  readonly actorId: string;
  readonly kind: CollaborativeActorKind;
  readonly label: string;
  readonly agentSessionId?: string;
  readonly runId?: string;
}

export interface CollaborativePaneState {
  readonly authoritative: CollaborativeDocumentProjection;
  readonly displayText: string;
  readonly selection: CollaborativeSelection;
  readonly mode: CollaborativeDocumentMode;
  readonly roomConnection: CollaborativeRoomConnection;
  readonly capabilities: CollaborativeCapabilities;
  readonly participants: readonly CollaborativeParticipant[];
  readonly cursors: readonly CollaborativeCursor[];
  readonly displayCursors: readonly CollaborativeCursor[];
  readonly pendingIntents: readonly CollaborativePendingIntent[];
  readonly rejectedWrites: readonly {
    readonly operationId: string;
    readonly reason: string;
    readonly intentOrder: number;
  }[];
  readonly acceptedAttributions: readonly AcceptedOperationAttribution[];
  readonly watch: CollaborativeWatchState;
  readonly lastUnavailable: string | null;
}

export type CollaborativePaneEvent =
  | { readonly type: 'authority-changed' }
  | {
      readonly type: 'local-input';
      readonly text: string;
      readonly selection: CollaborativeSelection;
    }
  | {
      readonly type: 'local-selection';
      readonly selection: CollaborativeSelection;
    }
  | {
      readonly type: 'local-interaction';
      readonly kind: 'pointer' | 'navigation' | 'selection' | 'edit';
    }
  | {
      readonly type: 'remote-accepted';
      readonly operation: CollaborativeOperation;
    }
  | { readonly type: 'room'; readonly update: unknown }
  | { readonly type: 'watch'; readonly actorId: string }
  | { readonly type: 'follow'; readonly actorId: string }
  | { readonly type: 'unfollow' }
  | { readonly type: 'stop-watch' }
  | { readonly type: 'jump'; readonly actorId: string }
  | { readonly type: 'request-surface-join'; readonly actorId: string }
  | { readonly type: 'share-current' }
  | { readonly type: 'dismiss-rejection'; readonly operationId: string }
  | { readonly type: 'retry-pending'; readonly intentId: string }
  | {
      readonly type: 'restore-evidence-revision';
      readonly evidenceRevisionId: string;
    }
  | { readonly type: 'resync' };

const EMPTY_CAPABILITIES: CollaborativeCapabilities = Object.freeze({
  document: Object.freeze({ read: false, write: false }),
  room: Object.freeze({
    join: false,
    read: false,
    share: false,
    watch: false,
    follow: false,
  }),
});
const EMPTY_SCOPE: CollaborativePaneScope = Object.freeze({
  projectId: 'unavailable',
  taskId: 'unavailable',
  documentId: 'unavailable',
});
const EMPTY_PROJECTION: CollaborativeDocumentProjection = Object.freeze({
  scope: EMPTY_SCOPE,
  text: '',
  workingStateRevision: 'unavailable',
});

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function boundedString(
  value: unknown,
  maxBytes = MAX_COLLABORATIVE_ID_BYTES,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxBytes &&
    wellFormedUnicode(value) &&
    utf8Bytes(value) <= maxBytes
  );
}
function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) =>
        descriptor.get === undefined && descriptor.set === undefined,
    );
  } catch {
    return false;
  }
}
function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}
function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function cloneScope(value: CollaborativePaneScope): CollaborativePaneScope {
  return Object.freeze({
    projectId: value.projectId,
    taskId: value.taskId,
    documentId: value.documentId,
  });
}
function sameScope(
  left: CollaborativePaneScope,
  right: CollaborativePaneScope,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.documentId === right.documentId
  );
}
function parseScope(value: unknown): CollaborativePaneScope | null {
  if (
    !record(value) ||
    !exactKeys(value, ['projectId', 'taskId', 'documentId']) ||
    !boundedString(value.projectId) ||
    !boundedString(value.taskId) ||
    !boundedString(value.documentId)
  )
    return null;
  return cloneScope(value as unknown as CollaborativePaneScope);
}
function cloneCapabilities(
  value: CollaborativeCapabilities,
): CollaborativeCapabilities {
  return Object.freeze({
    document: Object.freeze({
      read: value.document.read,
      write: value.document.write,
    }),
    room: Object.freeze({ ...value.room }),
  });
}
function parseCapabilities(value: unknown): CollaborativeCapabilities | null {
  if (
    !record(value) ||
    !exactKeys(value, ['document', 'room']) ||
    !record(value.document) ||
    !exactKeys(value.document, ['read', 'write']) ||
    !record(value.room) ||
    !exactKeys(value.room, ['join', 'read', 'share', 'watch', 'follow'])
  )
    return null;
  const entries = [
    value.document.read,
    value.document.write,
    value.room.join,
    value.room.read,
    value.room.share,
    value.room.watch,
    value.room.follow,
  ];
  return entries.every((entry) => typeof entry === 'boolean')
    ? cloneCapabilities(value as unknown as CollaborativeCapabilities)
    : null;
}
function parseAuthority(
  value: unknown,
  actorId: string,
  scope: CollaborativePaneScope,
): CollaborativeAuthorityAvailable | null {
  if (
    !record(value) ||
    value.state !== 'AVAILABLE' ||
    !exactKeys(value, [
      'state',
      'authorityRevision',
      'actorId',
      'scope',
      'capabilities',
    ])
  )
    return null;
  const parsedScope = parseScope(value.scope);
  const capabilities = parseCapabilities(value.capabilities);
  if (
    !boundedString(value.authorityRevision) ||
    value.actorId !== actorId ||
    !parsedScope ||
    !sameScope(parsedScope, scope) ||
    !capabilities
  )
    return null;
  return Object.freeze({
    state: 'AVAILABLE',
    authorityRevision: value.authorityRevision,
    actorId,
    scope: parsedScope,
    capabilities,
  });
}

interface CanonicalCollaborativePrincipal {
  readonly actorId: string;
  readonly kind: CollaborativeActorKind;
  readonly label: string;
  readonly scope: CollaborativePaneScope;
  readonly workingStateRevision: string;
  readonly agentSessionId?: string;
  readonly runId?: string;
}

function parsePrincipal(
  value: unknown,
  actorId: string,
  scope: CollaborativePaneScope,
  workingStateRevision: string,
): CanonicalCollaborativePrincipal | null {
  try {
    if (
      !record(value) ||
      value.state !== 'AVAILABLE' ||
      !exactKeys(
        value,
        ['state', 'actorId', 'kind', 'label', 'scope', 'workingStateRevision'],
        ['agentSessionId', 'runId'],
      ) ||
      value.actorId !== actorId ||
      (value.kind !== 'human' && value.kind !== 'agent') ||
      !boundedString(value.label, MAX_COLLABORATIVE_LABEL_BYTES) ||
      value.workingStateRevision !== workingStateRevision ||
      (value.agentSessionId !== undefined &&
        !boundedString(value.agentSessionId)) ||
      (value.runId !== undefined && !boundedString(value.runId)) ||
      (value.kind === 'human' &&
        (value.agentSessionId !== undefined || value.runId !== undefined))
    )
      return null;
    const principalScope = parseScope(value.scope);
    if (!principalScope || !sameScope(principalScope, scope)) return null;
    return Object.freeze({
      actorId,
      kind: value.kind,
      label: value.label,
      scope: principalScope,
      workingStateRevision,
      ...(value.agentSessionId
        ? { agentSessionId: value.agentSessionId as string }
        : {}),
      ...(value.runId ? { runId: value.runId as string } : {}),
    });
  } catch {
    return null;
  }
}
function validSelection(
  value: unknown,
  max: number,
): value is CollaborativeSelection {
  return (
    record(value) &&
    exactKeys(value, ['anchor', 'focus']) &&
    safeInteger(value.anchor) &&
    safeInteger(value.focus) &&
    value.anchor <= max &&
    value.focus <= max
  );
}
function cloneSelection(value: CollaborativeSelection): CollaborativeSelection {
  return Object.freeze({ anchor: value.anchor, focus: value.focus });
}

function parseProjection(
  value: unknown,
  scope: CollaborativePaneScope,
): CollaborativeProjectionResult {
  if (
    !record(value) ||
    value.outcome !== 'available' ||
    !exactKeys(value, ['outcome', 'projection']) ||
    !record(value.projection) ||
    !exactKeys(value.projection, ['scope', 'text', 'workingStateRevision'])
  )
    return {
      outcome: 'unavailable',
      reason: 'working-state projection unavailable',
    };
  const parsedScope = parseScope(value.projection.scope);
  if (
    !parsedScope ||
    !sameScope(parsedScope, scope) ||
    typeof value.projection.text !== 'string' ||
    value.projection.text.length > MAX_COLLABORATIVE_TEXT_BYTES ||
    utf8Bytes(value.projection.text) > MAX_COLLABORATIVE_TEXT_BYTES ||
    !boundedString(value.projection.workingStateRevision)
  )
    return {
      outcome: 'unavailable',
      reason: 'working-state projection malformed',
    };
  return {
    outcome: 'available',
    projection: Object.freeze({
      scope: parsedScope,
      text: value.projection.text,
      workingStateRevision: value.projection.workingStateRevision,
    }),
  };
}

function validBoundedStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_COLLABORATIVE_PENDING_INTENTS)
    return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!boundedString(entry) || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function validOperationTargets(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 65_536)
    return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!boundedString(entry) || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function parseConvergence(
  value: unknown,
  operationId: string,
  scope: CollaborativePaneScope,
): CollaborativeConvergenceResult {
  if (!record(value) || typeof value.outcome !== 'string')
    return {
      outcome: 'unavailable',
      reason: 'working-state apply malformed',
    };
  if (value.outcome === 'unavailable')
    return exactKeys(value, ['outcome', 'reason']) &&
      boundedString(value.reason, MAX_COLLABORATIVE_LABEL_BYTES)
      ? { outcome: 'unavailable', reason: value.reason }
      : { outcome: 'unavailable', reason: 'working-state apply malformed' };
  if (value.operationId !== operationId)
    return {
      outcome: 'unavailable',
      reason: 'working-state operation identity mismatch',
    };
  const parsed = parseProjection(
    { outcome: 'available', projection: value.projection },
    scope,
  );
  if (parsed.outcome !== 'available') return parsed;
  if (
    value.outcome === 'duplicate' &&
    exactKeys(value, [
      'outcome',
      'operationId',
      'operationDeferred',
      'projection',
    ]) &&
    typeof value.operationDeferred === 'boolean'
  )
    return {
      outcome: 'duplicate',
      operationId,
      operationDeferred: value.operationDeferred,
      projection: parsed.projection,
    };
  if (
    value.outcome === 'deferred' &&
    exactKeys(value, [
      'outcome',
      'operationId',
      'operationDeferred',
      'missing',
      'projection',
    ]) &&
    value.operationDeferred === true &&
    validBoundedStringArray(value.missing)
  )
    return {
      outcome: 'deferred',
      operationId,
      operationDeferred: true,
      missing: Object.freeze([...value.missing]),
      projection: parsed.projection,
    };
  if (
    value.outcome === 'rejected' &&
    exactKeys(value, ['outcome', 'operationId', 'reason', 'projection']) &&
    boundedString(value.reason, MAX_COLLABORATIVE_LABEL_BYTES)
  )
    return {
      outcome: 'rejected',
      operationId,
      reason: value.reason,
      projection: parsed.projection,
    };
  if (
    (value.outcome === 'applied' || value.outcome === 'replayed') &&
    exactKeys(value, [
      'outcome',
      'operationId',
      'operationDeferred',
      'releasedOperationIds',
      'projection',
    ]) &&
    typeof value.operationDeferred === 'boolean' &&
    validBoundedStringArray(value.releasedOperationIds)
  )
    return {
      outcome: value.outcome,
      operationId,
      operationDeferred: value.operationDeferred,
      releasedOperationIds: Object.freeze([...value.releasedOperationIds]),
      projection: parsed.projection,
    };
  return {
    outcome: 'unavailable',
    reason: 'working-state apply malformed',
  };
}

function parseTransport(
  value: unknown,
  intentId: string,
  digest: string,
): CollaborativeTransportResult {
  if (
    !record(value) ||
    value.intentId !== intentId ||
    value.digest !== digest ||
    typeof value.outcome !== 'string'
  )
    return {
      outcome: 'indeterminate',
      intentId,
      digest,
      reason: 'transport returned a malformed settlement',
    };
  if (
    value.outcome === 'accepted' &&
    exactKeys(value, ['outcome', 'intentId', 'digest'])
  )
    return { outcome: 'accepted', intentId, digest };
  if (
    (value.outcome === 'refused' ||
      value.outcome === 'indeterminate' ||
      value.outcome === 'definitely-not-invoked') &&
    exactKeys(value, ['outcome', 'intentId', 'digest', 'reason']) &&
    boundedString(value.reason, MAX_COLLABORATIVE_LABEL_BYTES)
  )
    return { outcome: value.outcome, intentId, digest, reason: value.reason };
  return {
    outcome: 'indeterminate',
    intentId,
    digest,
    reason: 'transport returned a malformed settlement',
  };
}

function parseEditingPlan(
  value: unknown,
  scope: CollaborativePaneScope,
  actorId: string,
  desiredText: string,
):
  | { outcome: 'planned'; batch: SharedWorkingStateEditBatch; bytes: number }
  | { outcome: 'unchanged' }
  | { outcome: 'refused'; reason: string } {
  try {
    if (!record(value) || typeof value.outcome !== 'string')
      return { outcome: 'refused', reason: 'editing capability was malformed' };
    if (value.outcome === 'unchanged' && exactKeys(value, ['outcome']))
      return { outcome: 'unchanged' };
    if (
      value.outcome === 'refused' &&
      exactKeys(value, ['outcome', 'reason']) &&
      boundedString(value.reason, MAX_COLLABORATIVE_LABEL_BYTES)
    )
      return { outcome: 'refused', reason: value.reason };
    if (
      value.outcome !== 'planned' ||
      !exactKeys(value, ['outcome', 'batch']) ||
      !record(value.batch) ||
      !exactKeys(value.batch, [
        'intentId',
        'digest',
        'baseRevision',
        'operations',
        'optimistic',
        'selection',
      ]) ||
      !boundedString(value.batch.intentId) ||
      typeof value.batch.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.batch.digest) ||
      !boundedString(value.batch.baseRevision) ||
      !Array.isArray(value.batch.operations) ||
      value.batch.operations.length < 1 ||
      value.batch.operations.length > MAX_COLLABORATIVE_EDIT_BATCH_OPERATIONS ||
      !record(value.batch.optimistic) ||
      !exactKeys(value.batch.optimistic, ['text', 'workingStateRevision']) ||
      value.batch.optimistic.text !== desiredText ||
      desiredText.length > MAX_COLLABORATIVE_TEXT_BYTES ||
      utf8Bytes(desiredText) > MAX_COLLABORATIVE_TEXT_BYTES ||
      !boundedString(value.batch.optimistic.workingStateRevision) ||
      !validSelection(value.batch.selection, desiredText.length)
    )
      return { outcome: 'refused', reason: 'editing batch was malformed' };
    const operations: CollaborativeOperation[] = [];
    const ids = new Set<string>();
    let bytes = 0;
    for (const raw of value.batch.operations) {
      const parsed = parseWorkingOperation(raw, scope, actorId);
      if (!parsed || ids.has(parsed.operation.operationId))
        return {
          outcome: 'refused',
          reason: 'editing operation was malformed',
        };
      ids.add(parsed.operation.operationId);
      operations.push(parsed.operation);
      bytes += parsed.bytes;
    }
    if (bytes > MAX_COLLABORATIVE_EDIT_BATCH_BYTES)
      return {
        outcome: 'refused',
        reason: 'editing batch exceeds byte capacity',
      };
    return {
      outcome: 'planned',
      bytes,
      batch: deepFreeze({
        intentId: value.batch.intentId,
        digest: value.batch.digest,
        baseRevision: value.batch.baseRevision,
        operations,
        optimistic: {
          text: desiredText,
          workingStateRevision: value.batch.optimistic.workingStateRevision,
        },
        selection: cloneSelection(value.batch.selection),
      }),
    };
  } catch {
    return { outcome: 'refused', reason: 'editing capability was unavailable' };
  }
}

function cloneOperation(
  operation: CollaborativeOperation,
): CollaborativeOperation {
  return deepFreeze(structuredClone(operation));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>))
      deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function parseWorkingOperation(
  value: unknown,
  scope: CollaborativePaneScope,
  expectedActorId?: string,
): { operation: CollaborativeOperation; bytes: number } | null {
  try {
    if (!record(value) || (value.kind !== 'insert' && value.kind !== 'delete'))
      return null;
    const common = [
      'schemaVersion',
      'operationId',
      'documentId',
      'replicaId',
      'actor',
      'parents',
      'authorizationEpoch',
      'kind',
    ];
    const specific = value.kind === 'insert' ? ['after', 'text'] : ['target'];
    if (
      !exactKeys(value, [...common, ...specific], ['attribution']) ||
      value.schemaVersion !== 1 ||
      !boundedString(value.operationId) ||
      value.documentId !== scope.documentId ||
      !boundedString(value.replicaId) ||
      !safeInteger(value.authorizationEpoch) ||
      !record(value.actor) ||
      !exactKeys(value.actor, ['actorId', 'kind'], ['displayLabel']) ||
      !boundedString(value.actor.actorId) ||
      (expectedActorId !== undefined &&
        value.actor.actorId !== expectedActorId) ||
      (value.actor.kind !== 'human' && value.actor.kind !== 'agent') ||
      (value.actor.displayLabel !== undefined &&
        !boundedString(
          value.actor.displayLabel,
          MAX_COLLABORATIVE_LABEL_BYTES,
        )) ||
      !validBoundedStringArray(value.parents)
    )
      return null;
    if (value.kind === 'insert') {
      if (
        (value.after !== null && !boundedString(value.after)) ||
        (typeof value.after === 'string' &&
          value.after.startsWith(`${value.operationId}:`)) ||
        typeof value.text !== 'string' ||
        value.text.length === 0 ||
        value.text.length > MAX_COLLABORATIVE_TEXT_BYTES ||
        !wellFormedUnicode(value.text) ||
        utf8Bytes(value.text) > MAX_COLLABORATIVE_TEXT_BYTES
      )
        return null;
    } else if (!validOperationTargets(value.target)) return null;
    if (value.parents.includes(value.operationId)) return null;
    if (value.attribution !== undefined) {
      if (!record(value.attribution)) return null;
      const keys = [
        'projectId',
        'taskId',
        'agentSessionId',
        'runId',
        'proposedChangeId',
        'correlationId',
      ];
      if (!exactKeys(value.attribution, [], keys)) return null;
      for (const entry of Object.values(value.attribution))
        if (!boundedString(entry)) return null;
      if (
        (value.attribution.projectId !== undefined &&
          value.attribution.projectId !== scope.projectId) ||
        (value.attribution.taskId !== undefined &&
          value.attribution.taskId !== scope.taskId)
      )
        return null;
    }
    const operation = cloneOperation(
      value as unknown as CollaborativeOperation,
    );
    const serialized = JSON.stringify(operation);
    if (
      serialized.length > MAX_COLLABORATIVE_EDIT_OPERATION_BYTES ||
      utf8Bytes(serialized) > MAX_COLLABORATIVE_EDIT_OPERATION_BYTES
    )
      return null;
    return { operation, bytes: utf8Bytes(serialized) };
  } catch {
    return null;
  }
}
function parseView(
  value: unknown,
  _scope: CollaborativePaneScope,
): CollaborativeFollowableView | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      'paneId',
      'documentId',
      'workingStateRevision',
      'selection',
      'viewportAnchor',
    ]) ||
    !boundedString(value.paneId) ||
    !boundedString(value.documentId) ||
    !boundedString(value.workingStateRevision) ||
    !validSelection(value.selection, Number.MAX_SAFE_INTEGER) ||
    !safeInteger(value.viewportAnchor) ||
    value.viewportAnchor > Number.MAX_SAFE_INTEGER
  )
    return null;
  return Object.freeze({
    paneId: value.paneId,
    documentId: value.documentId,
    workingStateRevision: value.workingStateRevision,
    selection: cloneSelection(value.selection),
    viewportAnchor: value.viewportAnchor,
  });
}

function parseParticipant(
  value: unknown,
  scope: CollaborativePaneScope,
  now: number,
): CollaborativeParticipant | null {
  if (
    !record(value) ||
    !exactKeys(
      value,
      ['actorId', 'kind', 'label', 'surface', 'expiresAt'],
      ['agentSessionId', 'runId', 'followableView'],
    ) ||
    !boundedString(value.actorId) ||
    (value.kind !== 'human' && value.kind !== 'agent') ||
    !boundedString(value.label, MAX_COLLABORATIVE_LABEL_BYTES) ||
    !safeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt > now + COLLABORATIVE_PRESENCE_TTL_MS
  )
    return null;
  if (
    (value.agentSessionId !== undefined &&
      !boundedString(value.agentSessionId)) ||
    (value.runId !== undefined && !boundedString(value.runId)) ||
    (value.kind === 'human' &&
      (value.agentSessionId !== undefined || value.runId !== undefined))
  )
    return null;
  if (!record(value.surface) || typeof value.surface.state !== 'string')
    return null;
  let surface: SharedSurfaceLocation;
  if (value.surface.state === 'shared-project-task') {
    if (
      !exactKeys(value.surface, ['state', 'projectId', 'taskId']) ||
      value.surface.projectId !== scope.projectId ||
      value.surface.taskId !== scope.taskId
    )
      return null;
    surface = Object.freeze({
      state: 'shared-project-task',
      projectId: scope.projectId,
      taskId: scope.taskId,
    });
  } else if (
    (value.surface.state === 'authorized-unshared' ||
      value.surface.state === 'outside-or-undisclosed') &&
    exactKeys(value.surface, ['state'])
  ) {
    surface = Object.freeze({ state: value.surface.state });
  } else return null;
  const view =
    value.followableView === undefined
      ? undefined
      : parseView(value.followableView, scope);
  if (value.followableView !== undefined && !view) return null;
  return Object.freeze({
    actorId: value.actorId,
    kind: value.kind,
    label: value.label,
    surface,
    expiresAt: value.expiresAt,
    ...(value.agentSessionId
      ? { agentSessionId: value.agentSessionId as string }
      : {}),
    ...(value.runId ? { runId: value.runId as string } : {}),
    ...(view ? { followableView: view } : {}),
  });
}

function parseCursor(
  value: unknown,
  documentLength: number,
  now: number,
): CollaborativeCursor | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      'actorId',
      'workingStateRevision',
      'selection',
      'expiresAt',
    ]) ||
    !boundedString(value.actorId) ||
    !boundedString(value.workingStateRevision) ||
    !validSelection(value.selection, documentLength) ||
    !safeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt > now + COLLABORATIVE_PRESENCE_TTL_MS
  )
    return null;
  return Object.freeze({
    actorId: value.actorId,
    workingStateRevision: value.workingStateRevision,
    selection: cloneSelection(value.selection),
    expiresAt: value.expiresAt,
  });
}

function parseRoomUpdate(
  value: unknown,
  scope: CollaborativePaneScope,
  documentLength: number,
  now: number,
): CollaborativeRoomUpdate | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'generation',
      'epoch',
      'sequence',
      'scope',
      'connection',
      'participants',
      'cursors',
      'departedActorIds',
    ]) ||
    value.schemaVersion !== COLLABORATIVE_ROOM_SCHEMA_VERSION ||
    (value.kind !== 'snapshot' && value.kind !== 'delta') ||
    !safeInteger(value.generation) ||
    !boundedString(value.epoch) ||
    !safeInteger(value.sequence) ||
    (value.connection !== 'connected' && value.connection !== 'reconnecting')
  )
    return null;
  const updateScope = parseScope(value.scope);
  if (
    !updateScope ||
    !sameScope(updateScope, scope) ||
    !Array.isArray(value.participants) ||
    !Array.isArray(value.cursors) ||
    !Array.isArray(value.departedActorIds)
  )
    return null;
  // Refuse oversized arrays before examining a single member.
  if (
    value.participants.length > MAX_COLLABORATIVE_PARTICIPANTS ||
    value.cursors.length > MAX_COLLABORATIVE_CURSORS ||
    value.departedActorIds.length > MAX_COLLABORATIVE_PARTICIPANTS
  )
    return null;
  const participants: CollaborativeParticipant[] = [];
  const participantIds = new Set<string>();
  for (const raw of value.participants) {
    const participant = parseParticipant(raw, scope, now);
    if (!participant || participantIds.has(participant.actorId)) return null;
    participantIds.add(participant.actorId);
    participants.push(participant);
  }
  const cursors: CollaborativeCursor[] = [];
  const cursorIds = new Set<string>();
  for (const raw of value.cursors) {
    const cursor = parseCursor(raw, documentLength, now);
    if (!cursor || cursorIds.has(cursor.actorId)) return null;
    cursorIds.add(cursor.actorId);
    cursors.push(cursor);
  }
  const departed: string[] = [];
  const departedIds = new Set<string>();
  for (const raw of value.departedActorIds) {
    if (!boundedString(raw) || departedIds.has(raw)) return null;
    departedIds.add(raw);
    departed.push(raw);
  }
  return Object.freeze({
    schemaVersion: COLLABORATIVE_ROOM_SCHEMA_VERSION,
    kind: value.kind,
    generation: value.generation,
    epoch: value.epoch,
    sequence: value.sequence,
    scope: updateScope,
    connection: value.connection,
    participants: Object.freeze(participants),
    cursors: Object.freeze(cursors),
    departedActorIds: Object.freeze(departed),
  });
}

function parseHostResult(value: unknown): CollaborativeHostIntentResult {
  if (
    record(value) &&
    value.outcome === 'accepted' &&
    exactKeys(value, ['outcome'])
  )
    return { outcome: 'accepted' };
  if (
    record(value) &&
    value.outcome === 'unavailable' &&
    exactKeys(value, ['outcome', 'reason']) &&
    boundedString(value.reason, MAX_COLLABORATIVE_LABEL_BYTES)
  )
    return { outcome: 'unavailable', reason: value.reason };
  return {
    outcome: 'unavailable',
    reason: 'host returned a malformed outcome',
  };
}

function cloneProjection(
  value: CollaborativeDocumentProjection,
): CollaborativeDocumentProjection {
  return Object.freeze({
    scope: cloneScope(value.scope),
    text: value.text,
    workingStateRevision: value.workingStateRevision,
  });
}

export class CollaborativeEditorPaneController {
  readonly #paneId: string;
  readonly #scope: CollaborativePaneScope;
  readonly #localActorId: string;
  readonly #correlationId: string;
  readonly #authority: CollaborativeAuthorityAdapter;
  readonly #principalAuthority: CollaborativePrincipalAuthorityAdapter;
  readonly #targetProjectionAuthority: CollaborativeTargetProjectionAuthorityAdapter;
  readonly #navigationCapabilityAuthority: CollaborativeNavigationCapabilityAuthorityAdapter;
  readonly #roomStreamAuthority: CollaborativeRoomStreamAuthorityAdapter;
  readonly #convergence: SharedWorkingStateProjectionAdapter;
  readonly #editing: SharedWorkingStateEditingCapability;
  readonly #transport: CollaborativeEditorTransportAdapter;
  readonly #room?: CollaborativeLiveRoomContextAdapter;
  readonly #cursorOutput?: CollaborativeCursorOutputAdapter;
  readonly #host: CollaborativePaneHostAdapter;
  readonly #revisionResolver: CollaborativeRevisionResolverAdapter;
  readonly #now: () => number;
  readonly #scheduler: CollaborativeEphemeralScheduler;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<string, PendingIntentRecord>();
  readonly #operationToIntent = new Map<string, string>();
  readonly #rejections = new Map<
    string,
    { operationId: string; reason: string; intentOrder: number }
  >();
  readonly #principalDigests = new Map<string, string>();
  readonly #cursorAdmissions: number[] = [];
  #roomClose: (() => void) | null = null;
  #roomSubscribing = false;
  readonly #queuedSynchronousRoomUpdates: unknown[] = [];
  #roomSequence = -1;
  #roomEpoch: string | null = null;
  #roomGeneration: number | null = null;
  #ttlCancel: (() => void) | null = null;
  #intentOrder = 0;
  #recoveryGeneration = 0;
  #recoveryAbort: AbortController | null = null;
  #health: 'available' | 'stale' | 'unavailable' = 'unavailable';
  #busy = false;
  #disposed = false;
  #lifecycleGeneration = 0;
  #state: CollaborativePaneState;

  constructor(options: {
    paneId: string;
    scope: CollaborativePaneScope;
    localActorId: string;
    correlationId: string;
    authority: CollaborativeAuthorityAdapter;
    principalAuthority: CollaborativePrincipalAuthorityAdapter;
    targetProjectionAuthority: CollaborativeTargetProjectionAuthorityAdapter;
    navigationCapabilityAuthority: CollaborativeNavigationCapabilityAuthorityAdapter;
    roomStreamAuthority: CollaborativeRoomStreamAuthorityAdapter;
    convergence: SharedWorkingStateProjectionAdapter;
    editing: SharedWorkingStateEditingCapability;
    transport: CollaborativeEditorTransportAdapter;
    host: CollaborativePaneHostAdapter;
    revisionResolver: CollaborativeRevisionResolverAdapter;
    room?: CollaborativeLiveRoomContextAdapter;
    cursorOutput?: CollaborativeCursorOutputAdapter;
    now?: () => number;
    scheduler?: CollaborativeEphemeralScheduler;
  }) {
    if (
      !boundedString(options.paneId) ||
      !parseScope(options.scope) ||
      !boundedString(options.localActorId) ||
      !boundedString(options.correlationId)
    )
      throw new TypeError('Collaborative pane composition identity is invalid');
    this.#paneId = options.paneId;
    this.#scope = cloneScope(options.scope);
    this.#localActorId = options.localActorId;
    this.#correlationId = options.correlationId;
    this.#authority = options.authority;
    this.#principalAuthority = options.principalAuthority;
    this.#targetProjectionAuthority = options.targetProjectionAuthority;
    this.#navigationCapabilityAuthority = options.navigationCapabilityAuthority;
    this.#roomStreamAuthority = options.roomStreamAuthority;
    this.#convergence = options.convergence;
    this.#editing = options.editing;
    this.#transport = options.transport;
    this.#host = options.host;
    this.#revisionResolver = options.revisionResolver;
    this.#room = options.room;
    this.#cursorOutput = options.cursorOutput;
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? {
      schedule: (delayMs, callback) => {
        const handle = setTimeout(callback, delayMs);
        (
          handle as ReturnType<typeof setTimeout> & { unref?: () => void }
        ).unref?.();
        return () => clearTimeout(handle);
      },
    };
    this.#state = Object.freeze({
      authoritative: EMPTY_PROJECTION,
      displayText: '',
      selection: Object.freeze({ anchor: 0, focus: 0 }),
      mode: 'unavailable',
      roomConnection: 'disconnected',
      capabilities: EMPTY_CAPABILITIES,
      participants: Object.freeze([]),
      cursors: Object.freeze([]),
      displayCursors: Object.freeze([]),
      pendingIntents: Object.freeze([]),
      rejectedWrites: Object.freeze([]),
      acceptedAttributions: Object.freeze([]),
      watch: Object.freeze({ state: 'off' }),
      lastUnavailable: null,
    });
    this.#refreshAuthorityAndProjection();
  }

  get paneId(): string {
    return this.#paneId;
  }
  get scope(): CollaborativePaneScope {
    return this.#scope;
  }
  snapshot(): CollaborativePaneState {
    return cloneState(this.#state);
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycleGeneration += 1;
    this.#closeRoomSubscription();
    this.#recoveryAbort?.abort();
    this.#cancelTtl();
    this.#queuedSynchronousRoomUpdates.length = 0;
    this.#listeners.clear();
  }

  dispatch(event: CollaborativePaneEvent): void {
    if (this.#disposed) return;
    switch (event.type) {
      case 'authority-changed':
        this.#refreshAuthorityAndProjection();
        break;
      case 'local-input':
        this.#localInput(event.text, event.selection);
        break;
      case 'local-selection':
        this.#localSelection(event.selection);
        break;
      case 'local-interaction':
      case 'unfollow':
        this.#exitFollow();
        break;
      case 'stop-watch':
        this.#set({ watch: Object.freeze({ state: 'off' }) });
        break;
      case 'remote-accepted':
        this.#remoteAccepted(event.operation);
        break;
      case 'room':
        this.#roomIngress(event.update);
        break;
      case 'watch':
        this.#watch(event.actorId, false);
        break;
      case 'follow':
        this.#watch(event.actorId, true);
        break;
      case 'jump':
        this.#jump(event.actorId);
        break;
      case 'request-surface-join':
        this.#requestJoin(event.actorId);
        break;
      case 'share-current':
        this.#shareCurrent();
        break;
      case 'dismiss-rejection':
        this.#dismissRejection(event.operationId);
        break;
      case 'retry-pending':
        this.#retryPending(event.intentId);
        break;
      case 'restore-evidence-revision':
        void this.#restore(event.evidenceRevisionId);
        break;
      case 'resync':
        void this.#resync();
        break;
    }
  }

  #currentAuthority(): CollaborativeAuthorityAvailable | null {
    let raw: unknown;
    try {
      raw = this.#authority.current();
    } catch {
      raw = null;
    }
    let authority: CollaborativeAuthorityAvailable | null;
    try {
      authority = parseAuthority(raw, this.#localActorId, this.#scope);
    } catch {
      authority = null;
    }
    if (!authority) {
      this.#revokeVisibleAuthority(
        'Current Project/Task authority is unavailable.',
      );
      return null;
    }
    this.#set({ capabilities: authority.capabilities });
    if (!authority.capabilities.document.read) {
      this.#revokeVisibleAuthority('Document read authority was revoked.');
      return authority;
    }
    if (!authority.capabilities.room.join || !authority.capabilities.room.read)
      this.#clearRoom();
    this.#syncRoomSubscription(authority);
    return authority;
  }

  #refreshAuthorityAndProjection(): void {
    const authority = this.#currentAuthority();
    if (!authority?.capabilities.document.read) return;
    let result: CollaborativeProjectionResult;
    try {
      result = parseProjection(this.#convergence.projection(), this.#scope);
    } catch {
      result = {
        outcome: 'unavailable',
        reason: 'working-state projection unavailable',
      };
    }
    if (result.outcome === 'unavailable') {
      this.#health = 'unavailable';
      this.#set({ lastUnavailable: result.reason });
      this.#refreshMode();
      return;
    }
    this.#health = 'available';
    this.#transitionAuthoritative(result.projection);
    this.#set({ lastUnavailable: null });
    this.#projectPending();
    while (this.#queuedSynchronousRoomUpdates.length > 0)
      this.dispatch({
        type: 'room',
        update: this.#queuedSynchronousRoomUpdates.shift(),
      });
  }

  #transitionAuthoritative(projection: CollaborativeDocumentProjection): void {
    const revision = projection.workingStateRevision;
    const cursors = this.#state.cursors.filter(
      (cursor) => cursor.workingStateRevision === revision,
    );
    const participants = this.#state.participants.map((participant) =>
      participant.followableView?.documentId === this.#scope.documentId &&
      participant.followableView.workingStateRevision !== revision
        ? Object.freeze({ ...participant, followableView: undefined })
        : participant,
    );
    let watch = this.#state.watch;
    if (
      watch.state === 'active' &&
      watch.view.documentId === this.#scope.documentId &&
      watch.view.workingStateRevision !== revision
    )
      watch = pauseWatch(watch, 'view-unavailable');
    const suppressed =
      cursors.length !== this.#state.cursors.length ||
      participants.some(
        (participant, index) =>
          participant.followableView !==
          this.#state.participants[index]?.followableView,
      );
    this.#set({
      authoritative: projection,
      cursors: Object.freeze(cursors),
      displayCursors: Object.freeze([]),
      participants: Object.freeze(participants),
      watch,
    });
    if (suppressed)
      try {
        this.#room?.requestFreshSignals?.({
          scope: this.#scope,
          workingStateRevision: revision,
        });
      } catch {
        // Ephemeral signal refresh cannot change document truth.
      }
  }

  #syncRoomSubscription(authority: CollaborativeAuthorityAvailable): void {
    const allowed =
      authority.capabilities.document.read &&
      authority.capabilities.room.join &&
      authority.capabilities.room.read;
    if (!allowed || !this.#room) {
      this.#closeRoomSubscription();
      return;
    }
    if (this.#disposed || this.#roomClose || this.#roomSubscribing) return;
    this.#roomSubscribing = true;
    const generation = this.#lifecycleGeneration;
    try {
      const close = this.#room.subscribe((update) => {
        if (this.#disposed || generation !== this.#lifecycleGeneration) return;
        if (this.#roomSubscribing) {
          if (this.#queuedSynchronousRoomUpdates.length < 8)
            this.#queuedSynchronousRoomUpdates.push(update);
          else
            this.#set({
              lastUnavailable: 'Synchronous room ingress exceeded capacity.',
            });
          return;
        }
        this.dispatch({ type: 'room', update });
      });
      if (this.#disposed || generation !== this.#lifecycleGeneration) {
        if (typeof close === 'function')
          try {
            close();
          } catch {
            // Late close is still exactly-once and total.
          }
        return;
      }
      this.#roomClose = typeof close === 'function' ? close : null;
      if (!this.#roomClose)
        this.#set({
          roomConnection: 'stale',
          lastUnavailable: 'Live room subscription was unavailable.',
        });
    } catch {
      this.#roomClose = null;
      this.#set({
        roomConnection: 'stale',
        lastUnavailable: 'Live room subscription was unavailable.',
      });
    } finally {
      this.#roomSubscribing = false;
    }
  }

  #closeRoomSubscription(): void {
    const close = this.#roomClose;
    this.#roomClose = null;
    try {
      close?.();
    } catch {
      // Adapter close cannot escape lifecycle cleanup.
    }
  }

  #cancelTtl(): void {
    const cancel = this.#ttlCancel;
    this.#ttlCancel = null;
    try {
      cancel?.();
    } catch {
      // Timer cancellation cannot escape lifecycle cleanup.
    }
  }

  #revokeVisibleAuthority(reason: string): void {
    this.#cancelRecovery();
    this.#closeRoomSubscription();
    this.#clearRoom();
    this.#rejections.clear();
    this.#health = 'unavailable';
    this.#set({
      authoritative: EMPTY_PROJECTION,
      displayText: '',
      capabilities: EMPTY_CAPABILITIES,
      rejectedWrites: Object.freeze([]),
      mode: 'unavailable',
      lastUnavailable: reason,
    });
  }

  #clearRoom(): void {
    this.#roomSequence = -1;
    this.#roomEpoch = null;
    this.#roomGeneration = null;
    this.#principalDigests.clear();
    this.#queuedSynchronousRoomUpdates.length = 0;
    this.#cancelTtl();
    this.#set({
      participants: Object.freeze([]),
      cursors: Object.freeze([]),
      displayCursors: Object.freeze([]),
      acceptedAttributions: Object.freeze([]),
      roomConnection: 'disconnected',
      watch: Object.freeze({ state: 'off' }),
    });
  }

  #localInput(text: string, selection: CollaborativeSelection): void {
    this.#exitFollow();
    const authority = this.#currentAuthority();
    if (!authority?.capabilities.document.read) return;
    if (!authority.capabilities.document.write) {
      this.#recordLocalRefusal(
        'local-write',
        'Document write authority was revoked.',
        ++this.#intentOrder,
      );
      return;
    }
    if (
      typeof text !== 'string' ||
      text.length > MAX_COLLABORATIVE_TEXT_BYTES ||
      utf8Bytes(text) > MAX_COLLABORATIVE_TEXT_BYTES ||
      !validSelection(selection, text.length)
    ) {
      this.#recordLocalRefusal(
        'local-write',
        'The edit exceeds the pane safety bounds.',
        ++this.#intentOrder,
      );
      return;
    }
    if (this.#pending.size >= MAX_COLLABORATIVE_PENDING_INTENTS) {
      this.#recordLocalRefusal(
        'local-write',
        'The pending edit capacity is full.',
        ++this.#intentOrder,
      );
      return;
    }
    let planned: ReturnType<typeof parseEditingPlan>;
    try {
      planned = parseEditingPlan(
        this.#editing.plan({
          currentText: this.#state.displayText,
          desiredText: text,
          selection,
          pending: this.#editingPending(),
        }),
        this.#scope,
        this.#localActorId,
        text,
      );
    } catch {
      planned = {
        outcome: 'refused',
        reason: 'Editing capability was unavailable.',
      };
    }
    if (planned.outcome === 'unchanged') return;
    if (planned.outcome === 'refused') {
      this.#recordLocalRefusal(
        'local-write',
        planned.reason,
        ++this.#intentOrder,
      );
      return;
    }
    if (this.#pending.has(planned.batch.intentId)) {
      this.#recordLocalRefusal(
        planned.batch.intentId,
        'The editing capability reused a pending intent identity.',
        ++this.#intentOrder,
      );
      return;
    }
    for (const operation of planned.batch.operations)
      if (this.#operationToIntent.has(operation.operationId)) {
        this.#recordLocalRefusal(
          planned.batch.intentId,
          'The editing capability reused a pending operation identity.',
          ++this.#intentOrder,
        );
        return;
      }
    const intent: PendingIntentRecord = Object.freeze({
      intentId: planned.batch.intentId,
      batchDigest: planned.batch.digest,
      submitted: false,
      order: ++this.#intentOrder,
      operations: Object.freeze(
        planned.batch.operations.map((operation) =>
          Object.freeze({
            operationId: operation.operationId,
            operation,
            // Planning is internal.  Nothing becomes possible-effect until
            // this exact batch crosses the transport boundary.
            settlement: 'uninvoked' as const,
          }),
        ),
      ),
      selection: cloneSelection(planned.batch.selection),
      createdAt: this.#now(),
      retainedBytes: planned.bytes,
    });
    const pendingBytes = [...this.#pending.values()].reduce(
      (sum, entry) => sum + entry.retainedBytes,
      intent.retainedBytes,
    );
    if (pendingBytes > MAX_COLLABORATIVE_PENDING_BYTES) {
      this.#recordLocalRefusal(
        planned.batch.intentId,
        'The pending edit byte capacity is full.',
        ++this.#intentOrder,
      );
      return;
    }
    this.#pending.set(intent.intentId, intent);
    for (const operation of intent.operations)
      this.#operationToIntent.set(operation.operationId, intent.intentId);
    this.#set({ selection: intent.selection });
    this.#projectPending();
    this.#publishSelection(intent.selection, authority);
    this.#submitBatch(intent.intentId);
  }

  #submitBatch(intentId: string): void {
    const generation = this.#lifecycleGeneration;
    const intent = this.#pending.get(intentId);
    if (!intent) return;
    const operations: CollaborativeOperation[] = [];
    for (const entry of intent.operations) {
      const parsed = parseWorkingOperation(
        entry.operation,
        this.#scope,
        this.#localActorId,
      );
      if (!parsed) {
        this.#settlePreEffectRefusal(
          intentId,
          'The batch was not invoked because it could not be copied safely.',
        );
        return;
      }
      operations.push(parsed.operation);
    }
    const batch = deepFreeze({
      intentId,
      digest: intent.batchDigest,
      operations,
    });
    void Promise.resolve()
      .then(() => {
        const authority = this.#currentAuthority();
        if (
          this.#disposed ||
          generation !== this.#lifecycleGeneration ||
          !authority?.capabilities.document.write
        ) {
          this.#settlePreEffectRefusal(
            intentId,
            'The batch was not invoked because authority or lifecycle changed.',
          );
          return null;
        }
        this.#markBatchPossibleEffect(intentId);
        return this.#transport.submitBatch(batch);
      })
      .then((raw) => {
        if (this.#disposed || generation !== this.#lifecycleGeneration) return;
        if (!this.#pending.has(intentId)) return;
        if (raw === null) return;
        this.#settleTransport(
          parseTransport(raw, intentId, intent.batchDigest),
        );
      })
      .catch(() => {
        if (this.#disposed || generation !== this.#lifecycleGeneration) return;
        this.#settleTransport({
          outcome: 'indeterminate',
          intentId,
          digest: intent.batchDigest,
          reason: 'Transport failed after a possible effect.',
        });
      });
  }

  #markBatchPossibleEffect(intentId: string): void {
    const intent = this.#pending.get(intentId);
    if (!intent) return;
    const operations = intent.operations.map((entry) =>
      entry.settlement === 'uninvoked'
        ? Object.freeze({ ...entry, settlement: 'possible-effect' as const })
        : entry,
    );
    this.#pending.set(
      intentId,
      Object.freeze({ ...intent, submitted: true, operations }),
    );
    this.#projectPending();
  }

  #settlePreEffectRefusal(intentId: string, reason: string): void {
    const intent = this.#pending.get(intentId);
    if (!intent) return;
    const operations = intent.operations.map((entry) =>
      entry.settlement === 'uninvoked'
        ? Object.freeze({ ...entry, settlement: 'refused' as const, reason })
        : entry,
    );
    this.#pending.set(intentId, Object.freeze({ ...intent, operations }));
    this.#finalizeIntent(intentId);
    this.#projectPending();
  }

  #quarantineBatch(intent: PendingIntentRecord, reason: string): void {
    const operations = intent.operations.map((entry) =>
      entry.settlement === 'projected' || entry.settlement === 'refused'
        ? entry
        : Object.freeze({
            ...entry,
            settlement: 'indeterminate' as const,
            reason,
          }),
    );
    this.#pending.set(
      intent.intentId,
      Object.freeze({ ...intent, operations }),
    );
    this.#markStale(reason);
    this.#projectPending();
  }

  #settleTransport(result: CollaborativeTransportResult): void {
    this.#currentAuthority();
    const intent = this.#pending.get(result.intentId);
    if (!intent) return;
    if (intent.batchDigest !== result.digest) return;
    if (
      (result.outcome === 'refused' ||
        result.outcome === 'definitely-not-invoked') &&
      intent.operations.some((entry) => entry.settlement === 'projected')
    ) {
      this.#quarantineBatch(
        intent,
        'Batch settlement contradicted an applied operation.',
      );
      return;
    }
    if (
      result.outcome === 'accepted' &&
      intent.operations.some((entry) => entry.settlement === 'refused')
    ) {
      this.#quarantineBatch(
        intent,
        'Accepted batch contradicted a refused operation.',
      );
      return;
    }
    const safeReason =
      result.outcome === 'refused' ||
      result.outcome === 'definitely-not-invoked'
        ? 'Operation was refused before projection.'
        : result.outcome === 'indeterminate'
          ? 'Operation outcome is unknown after a possible effect.'
          : undefined;
    const operations = intent.operations.map((entry) => {
      if (entry.settlement === 'projected' || entry.settlement === 'refused')
        return entry;
      return Object.freeze({
        ...entry,
        settlement:
          result.outcome === 'refused' ||
          result.outcome === 'definitely-not-invoked'
            ? ('refused' as const)
            : result.outcome === 'accepted'
              ? ('committed-awaiting-projection' as const)
              : ('indeterminate' as const),
        ...(safeReason ? { reason: safeReason } : {}),
      });
    });
    this.#pending.set(
      intent.intentId,
      Object.freeze({
        ...intent,
        transportOutcome: result.outcome,
        operations,
      }),
    );
    if (result.outcome === 'indeterminate')
      this.#set({ lastUnavailable: safeReason ?? null });
    this.#finalizeIntent(intent.intentId);
    this.#projectPending();
  }

  #remoteAccepted(operation: CollaborativeOperation): void {
    const authority = this.#currentAuthority();
    if (!authority?.capabilities.document.read) return;
    try {
      if (
        record(operation) &&
        operation.documentId !== this.#scope.documentId
      ) {
        this.#markStale('wrong_document');
        return;
      }
    } catch {
      this.#markStale('Remote operation envelope was malformed.');
      return;
    }
    const parsedOperation = parseWorkingOperation(operation, this.#scope);
    if (!parsedOperation) {
      this.#markStale('Remote operation envelope was malformed.');
      return;
    }
    let result: CollaborativeConvergenceResult;
    try {
      result = parseConvergence(
        this.#convergence.applyAccepted(parsedOperation.operation),
        parsedOperation.operation.operationId,
        this.#scope,
      );
    } catch {
      result = {
        outcome: 'unavailable',
        reason: 'Working-state apply was unavailable.',
      };
    }
    if (result.outcome === 'unavailable') {
      this.#markStale(result.reason);
      return;
    }
    this.#transitionAuthoritative(result.projection);
    this.#health = 'available';
    if (result.outcome === 'rejected') {
      this.#settleOperation(result.operationId, 'refused', result.reason);
      this.#set({ lastUnavailable: result.reason });
    } else {
      if (result.outcome !== 'deferred' && !result.operationDeferred) {
        this.#settleProjected(result.operationId);
        if (result.outcome === 'applied' || result.outcome === 'replayed')
          this.#recordAttribution(parsedOperation.operation);
      }
      if (result.outcome === 'applied' || result.outcome === 'replayed')
        for (const id of result.releasedOperationIds)
          this.#settleProjected(id, true);
    }
    this.#projectPending();
  }

  #settleProjected(operationId: string, attribute = false): void {
    const intentId = this.#operationToIntent.get(operationId);
    const intent = intentId ? this.#pending.get(intentId) : undefined;
    const operation = intent?.operations.find(
      (entry) => entry.operationId === operationId,
    );
    if (attribute && operation) this.#recordAttribution(operation.operation);
    this.#settleOperation(operationId, 'projected');
  }

  #settleOperation(
    operationId: string,
    settlement: 'projected' | 'refused',
    reason?: string,
  ): void {
    const intentId = this.#operationToIntent.get(operationId);
    const intent = intentId ? this.#pending.get(intentId) : undefined;
    if (!intent) return;
    if (settlement === 'refused' && intent.transportOutcome === 'accepted') {
      const operations = intent.operations.map((entry) =>
        entry.operationId === operationId
          ? Object.freeze({
              ...entry,
              settlement: 'refused' as const,
              ...(reason ? { reason } : {}),
            })
          : entry,
      );
      this.#quarantineBatch(
        Object.freeze({ ...intent, operations }),
        'Accepted batch contradicted a refused operation.',
      );
      return;
    }
    const operations = intent.operations.map((entry) =>
      entry.operationId === operationId
        ? Object.freeze({
            ...entry,
            settlement,
            ...(reason ? { reason } : {}),
          })
        : entry,
    );
    this.#pending.set(
      intent.intentId,
      Object.freeze({ ...intent, operations }),
    );
    this.#finalizeIntent(intent.intentId);
  }

  #finalizeIntent(intentId: string): void {
    const intent = this.#pending.get(intentId);
    if (!intent) return;
    if (
      intent.operations.some(
        (entry) =>
          entry.settlement !== 'projected' && entry.settlement !== 'refused',
      )
    )
      return;
    // Projection proves member effects but not the one atomic batch outcome.
    // Retain this bounded private record so a late total refusal is still
    // detectable as a contradiction rather than silently forgotten.
    if (
      intent.submitted &&
      (intent.transportOutcome === undefined ||
        intent.transportOutcome === 'indeterminate')
    )
      return;
    const refused = intent.operations.filter(
      (entry) => entry.settlement === 'refused',
    );
    if (refused.length > 0) {
      this.#rejections.set(
        intent.intentId,
        Object.freeze({
          operationId: intent.intentId,
          reason: refused.map((entry) => entry.reason ?? 'refused').join('; '),
          intentOrder: intent.order,
        }),
      );
      this.#boundRejections();
    }
    for (const operation of intent.operations)
      this.#operationToIntent.delete(operation.operationId);
    this.#pending.delete(intent.intentId);
  }

  #boundRejections(): void {
    while (this.#rejections.size > MAX_COLLABORATIVE_REJECTIONS) {
      const oldest = [...this.#rejections.values()].sort(
        (left, right) => left.intentOrder - right.intentOrder,
      )[0];
      if (!oldest) break;
      this.#rejections.delete(oldest.operationId);
    }
  }

  #resolvePrincipal(
    actorId: string,
    principalScope: CollaborativePaneScope,
    workingStateRevision: string,
  ): CanonicalCollaborativePrincipal | null {
    try {
      return parsePrincipal(
        this.#principalAuthority.resolve({
          actorId,
          scope: principalScope,
          workingStateRevision,
        }),
        actorId,
        principalScope,
        workingStateRevision,
      );
    } catch {
      return null;
    }
  }

  #resolveTargetProjection(
    view: CollaborativeFollowableView,
  ): { scope: CollaborativePaneScope; textLength: number } | null {
    const targetScope = {
      ...this.#scope,
      documentId: view.documentId,
    };
    try {
      const raw = this.#targetProjectionAuthority.resolve({
        scope: targetScope,
        workingStateRevision: view.workingStateRevision,
      });
      if (
        !record(raw) ||
        raw.state !== 'AVAILABLE' ||
        !exactKeys(raw, [
          'state',
          'scope',
          'workingStateRevision',
          'textLength',
        ]) ||
        raw.workingStateRevision !== view.workingStateRevision ||
        !safeInteger(raw.textLength)
      )
        return null;
      const resolvedScope = parseScope(raw.scope);
      if (!resolvedScope || !sameScope(resolvedScope, targetScope)) return null;
      if (
        view.selection.anchor > raw.textLength ||
        view.selection.focus > raw.textLength ||
        view.viewportAnchor > raw.textLength
      )
        return null;
      return { scope: resolvedScope, textLength: raw.textLength };
    } catch {
      return null;
    }
  }

  #mintNavigationCapability(
    actorId: string,
    view: CollaborativeFollowableView,
    reason: 'jump' | 'follow',
  ): string | null {
    const authority = this.#currentAuthority();
    if (!authority?.capabilities.room.join) return null;
    const target = this.#resolveTargetProjection(view);
    if (!target) return null;
    try {
      const raw = this.#navigationCapabilityAuthority.mint({
        actorId,
        scope: target.scope,
        view,
        authorityRevision: authority.authorityRevision,
        reason,
      });
      if (
        !record(raw) ||
        raw.state !== 'AVAILABLE' ||
        !exactKeys(raw, ['state', 'capability']) ||
        !boundedString(raw.capability)
      )
        return null;
      return raw.capability;
    } catch {
      return null;
    }
  }

  #recordAttribution(operation: CollaborativeOperation): void {
    if (!record(operation.actor) || !boundedString(operation.actor.actorId))
      return;
    const principal = this.#resolvePrincipal(
      operation.actor.actorId,
      this.#scope,
      this.#state.authoritative.workingStateRevision,
    );
    if (!principal) return;
    const identityDigest = JSON.stringify({
      kind: principal.kind,
    });
    const knownDigest = this.#principalDigests.get(principal.actorId);
    if (knownDigest !== undefined && knownDigest !== identityDigest) {
      this.#markStale('Accepted operation principal identity equivocated.');
      return;
    }
    this.#principalDigests.set(principal.actorId, identityDigest);
    while (this.#principalDigests.size > MAX_COLLABORATIVE_PARTICIPANTS) {
      const oldest = this.#principalDigests.keys().next().value;
      if (oldest === undefined) break;
      this.#principalDigests.delete(oldest);
    }
    const next = [
      ...this.#state.acceptedAttributions.filter(
        (entry) => entry.operationId !== operation.operationId,
      ),
      Object.freeze({
        operationId: operation.operationId,
        actorId: principal.actorId,
        kind: principal.kind,
        label: principal.label,
        ...(principal.agentSessionId
          ? { agentSessionId: principal.agentSessionId }
          : {}),
        ...(principal.runId ? { runId: principal.runId } : {}),
      }),
    ].slice(-MAX_COLLABORATIVE_ATTRIBUTIONS);
    this.#set({ acceptedAttributions: Object.freeze(next) });
  }

  #projectPending(): void {
    if (!this.#state.capabilities.document.read) {
      this.#set({
        displayText: '',
        displayCursors: Object.freeze([]),
        pendingIntents: this.#pendingProjection(),
        rejectedWrites: this.#rejectionProjection(),
      });
      this.#refreshMode();
      return;
    }
    let displayText = this.#state.authoritative.text;
    if (this.#pending.size > 0) {
      let result:
        | {
            outcome: 'projected';
            text: string;
            workingStateRevision: string;
          }
        | { outcome: 'unavailable'; reason: string };
      try {
        const raw = this.#editing.projectPending({
          pending: this.#editingPending(),
        });
        result =
          raw.outcome === 'projected' &&
          typeof raw.text === 'string' &&
          raw.text.length <= MAX_COLLABORATIVE_TEXT_BYTES &&
          utf8Bytes(raw.text) <= MAX_COLLABORATIVE_TEXT_BYTES &&
          boundedString(raw.workingStateRevision)
            ? raw
            : {
                outcome: 'unavailable',
                reason:
                  raw.outcome === 'unavailable'
                    ? raw.reason
                    : 'Pending projection was malformed.',
              };
      } catch {
        result = {
          outcome: 'unavailable',
          reason: 'Editing capability projection was unavailable.',
        };
      }
      if (result.outcome === 'projected') displayText = result.text;
      else {
        this.#health = 'stale';
        this.#set({ lastUnavailable: result.reason });
      }
    }
    this.#set({
      displayText,
      pendingIntents: this.#pendingProjection(),
      rejectedWrites: this.#rejectionProjection(),
    });
    this.#refreshDisplayCursors();
    this.#refreshMode();
  }

  #refreshDisplayCursors(): void {
    const projected: CollaborativeCursor[] = [];
    for (const cursor of this.#state.cursors) {
      try {
        const result = this.#editing.transformSelection({
          workingStateRevision: cursor.workingStateRevision,
          selection: cursor.selection,
          pending: this.#editingPending(),
        });
        if (
          result.outcome === 'projected' &&
          result.text === this.#state.displayText &&
          boundedString(result.workingStateRevision) &&
          validSelection(result.selection, this.#state.displayText.length)
        )
          projected.push(
            Object.freeze({
              ...cursor,
              workingStateRevision: result.workingStateRevision,
              selection: cloneSelection(result.selection),
            }),
          );
      } catch {
        // Suppression is safer than displaying a stale position.
      }
    }
    this.#set({ displayCursors: Object.freeze(projected) });
  }

  #editingPending(): readonly {
    intentId: string;
    operations: readonly CollaborativeOperation[];
  }[] {
    return Object.freeze(
      [...this.#pending.values()]
        .sort((left, right) => left.order - right.order)
        .map((intent) =>
          Object.freeze({
            intentId: intent.intentId,
            operations: Object.freeze(
              intent.operations
                .filter(
                  (operation) =>
                    operation.settlement !== 'projected' &&
                    operation.settlement !== 'refused',
                )
                .map((operation) => operation.operation),
            ),
          }),
        )
        .filter((intent) => intent.operations.length > 0),
    );
  }

  #pendingProjection(): readonly CollaborativePendingIntent[] {
    return Object.freeze(
      [...this.#pending.values()]
        .sort((left, right) => left.order - right.order)
        .map((intent) => {
          const count = (state: PendingOperationSettlement) =>
            intent.operations.filter((entry) => entry.settlement === state)
              .length;
          const reasons = intent.operations
            .map((entry) => entry.reason)
            .filter((entry): entry is string => Boolean(entry));
          return Object.freeze({
            intentId: intent.intentId,
            operationCount: intent.operations.length,
            createdAt: intent.createdAt,
            states: Object.freeze({
              uninvoked: count('uninvoked'),
              possibleEffect: count('possible-effect'),
              committedAwaitingProjection: count(
                'committed-awaiting-projection',
              ),
              indeterminate: count('indeterminate'),
              refused: count('refused'),
            }),
            ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
          });
        }),
    );
  }

  #rejectionProjection(): readonly {
    operationId: string;
    reason: string;
    intentOrder: number;
  }[] {
    return Object.freeze(
      [...this.#rejections.values()]
        .sort((a, b) => a.intentOrder - b.intentOrder)
        .map((value) => Object.freeze({ ...value })),
    );
  }

  #recordLocalRefusal(
    operationId: string,
    reason: string,
    intentOrder: number,
  ): void {
    this.#rejections.set(
      operationId,
      Object.freeze({ operationId, reason, intentOrder }),
    );
    this.#boundRejections();
    this.#set({ rejectedWrites: this.#rejectionProjection() });
    this.#refreshMode();
  }

  #dismissRejection(operationId: string): void {
    if (!boundedString(operationId)) return;
    this.#rejections.delete(operationId);
    this.#set({ rejectedWrites: this.#rejectionProjection() });
    this.#refreshMode();
  }

  #retryPending(intentId: string): void {
    const authority = this.#currentAuthority();
    const intent = this.#pending.get(intentId);
    if (!authority?.capabilities.document.write || !intent) return;
    const retry = intent.operations.filter(
      (operation) => operation.settlement === 'indeterminate',
    );
    if (retry.length === 0) return;
    const operations = intent.operations.map((operation) =>
      operation.settlement === 'indeterminate'
        ? Object.freeze({
            ...operation,
            settlement: 'uninvoked' as const,
            reason: undefined,
          })
        : operation,
    );
    this.#pending.set(intentId, Object.freeze({ ...intent, operations }));
    this.#projectPending();
    this.#submitBatch(intentId);
  }

  #refreshMode(): void {
    let mode: CollaborativeDocumentMode;
    if (
      !this.#state.capabilities.document.read ||
      this.#health === 'unavailable'
    )
      mode = 'unavailable';
    else if (this.#busy) mode = 'resyncing';
    else if (this.#health === 'stale') mode = 'stale';
    else if (!this.#state.capabilities.document.write) mode = 'read-only';
    else if (this.#pending.size > 0) mode = 'pending';
    else if (this.#rejections.size > 0) mode = 'rejected-write';
    else if (this.#state.roomConnection === 'connected') mode = 'live';
    else mode = 'solo';
    this.#set({ mode });
  }

  #roomIngress(raw: unknown): void {
    const authority = this.#currentAuthority();
    if (
      !authority?.capabilities.document.read ||
      !authority.capabilities.room.join ||
      !authority.capabilities.room.read
    ) {
      this.#clearRoom();
      return;
    }
    let update: CollaborativeRoomUpdate | null;
    try {
      update = parseRoomUpdate(
        raw,
        this.#scope,
        this.#state.authoritative.text.length,
        this.#now(),
      );
    } catch {
      update = null;
    }
    if (!update) {
      this.#set({
        participants: Object.freeze([]),
        cursors: Object.freeze([]),
        displayCursors: Object.freeze([]),
        watch: pauseWatch(this.#state.watch, 'view-unavailable'),
        roomConnection: 'stale',
        lastUnavailable: 'Live room update was malformed.',
      });
      this.#refreshMode();
      return;
    }
    let stream: {
      generation: number;
      epoch: string;
      scope: CollaborativePaneScope;
    } | null = null;
    try {
      const rawStream = this.#roomStreamAuthority.current(this.#scope);
      if (
        record(rawStream) &&
        rawStream.state === 'AVAILABLE' &&
        exactKeys(rawStream, ['state', 'scope', 'generation', 'epoch']) &&
        safeInteger(rawStream.generation) &&
        boundedString(rawStream.epoch)
      ) {
        const streamScope = parseScope(rawStream.scope);
        if (streamScope && sameScope(streamScope, this.#scope))
          stream = {
            generation: rawStream.generation,
            epoch: rawStream.epoch,
            scope: streamScope,
          };
      }
    } catch {
      stream = null;
    }
    if (!stream) {
      this.#set({
        participants: Object.freeze([]),
        cursors: Object.freeze([]),
        displayCursors: Object.freeze([]),
        watch: Object.freeze({ state: 'off' }),
        roomConnection: 'stale',
        lastUnavailable: 'Current room stream authority is unavailable.',
      });
      this.#refreshMode();
      return;
    }
    if (
      update.generation !== stream.generation ||
      update.epoch !== stream.epoch
    )
      return;
    const previousEpoch = this.#roomEpoch;
    const previousGeneration = this.#roomGeneration;
    const previousSequence = this.#roomSequence;
    const rollbackRoomClock = () => {
      this.#roomEpoch = previousEpoch;
      this.#roomGeneration = previousGeneration;
      this.#roomSequence = previousSequence;
    };
    if (update.generation !== this.#roomGeneration) {
      if (
        this.#roomGeneration !== null &&
        update.generation <= this.#roomGeneration
      )
        return;
      if (update.kind !== 'snapshot') return;
      this.#roomGeneration = update.generation;
      this.#roomEpoch = update.epoch;
      this.#roomSequence = -1;
    } else if (update.epoch !== this.#roomEpoch) return;
    if (update.sequence <= this.#roomSequence) return;
    if (update.connection === 'reconnecting') {
      this.#roomSequence = update.sequence;
      this.#set({
        roomConnection: 'reconnecting',
        watch: pauseWatch(this.#state.watch, 'reconnecting'),
      });
      this.#refreshMode();
      return;
    }
    const principalDigests = new Map(this.#principalDigests);
    const canonicalParticipants: CollaborativeParticipant[] = [];
    for (const entry of update.participants) {
      if (
        entry.followableView &&
        !this.#resolveTargetProjection(entry.followableView)
      ) {
        rollbackRoomClock();
        this.#set({
          roomConnection: 'stale',
          lastUnavailable: 'Followable target projection was not authorized.',
        });
        this.#refreshMode();
        return;
      }
      const principalScope = entry.followableView
        ? { ...this.#scope, documentId: entry.followableView.documentId }
        : this.#scope;
      const principalRevision =
        entry.followableView?.workingStateRevision ??
        this.#state.authoritative.workingStateRevision;
      const principal = this.#resolvePrincipal(
        entry.actorId,
        principalScope,
        principalRevision,
      );
      if (!principal) {
        rollbackRoomClock();
        this.#set({
          roomConnection: 'stale',
          lastUnavailable: 'Participant attribution was not authoritative.',
        });
        this.#refreshMode();
        return;
      }
      const identityDigest = JSON.stringify({
        kind: principal.kind,
      });
      const knownDigest = principalDigests.get(entry.actorId);
      if (knownDigest !== undefined && knownDigest !== identityDigest) {
        rollbackRoomClock();
        this.#set({
          roomConnection: 'stale',
          lastUnavailable: 'Participant principal identity equivocated.',
        });
        this.#refreshMode();
        return;
      }
      principalDigests.set(entry.actorId, identityDigest);
      const followableView =
        entry.followableView &&
        (entry.followableView.documentId !== this.#scope.documentId ||
          entry.followableView.workingStateRevision ===
            this.#state.authoritative.workingStateRevision)
          ? entry.followableView
          : undefined;
      canonicalParticipants.push(
        Object.freeze({
          ...entry,
          kind: principal.kind,
          label: principal.label,
          agentSessionId: principal.agentSessionId,
          runId: principal.runId,
          followableView,
        }),
      );
    }
    const departed = new Set(update.departedActorIds);
    let participants =
      update.kind === 'snapshot'
        ? canonicalParticipants
        : mergeByActor(this.#state.participants, canonicalParticipants);
    let cursors =
      update.kind === 'snapshot'
        ? [...update.cursors]
        : mergeByActor(this.#state.cursors, update.cursors);
    participants = participants.filter(
      (entry) => !departed.has(entry.actorId) && entry.expiresAt > this.#now(),
    );
    const participantIds = new Set(participants.map((entry) => entry.actorId));
    if (
      cursors.some(
        (entry) =>
          !participantIds.has(entry.actorId) && !departed.has(entry.actorId),
      )
    ) {
      rollbackRoomClock();
      this.#set({
        participants: Object.freeze([]),
        cursors: Object.freeze([]),
        displayCursors: Object.freeze([]),
        watch: pauseWatch(this.#state.watch, 'view-unavailable'),
        roomConnection: 'stale',
        lastUnavailable: 'Live room cursor referenced an unknown participant.',
      });
      this.#refreshMode();
      return;
    }
    cursors = cursors.filter(
      (entry) =>
        !departed.has(entry.actorId) &&
        participantIds.has(entry.actorId) &&
        entry.workingStateRevision ===
          this.#state.authoritative.workingStateRevision &&
        entry.expiresAt > this.#now(),
    );
    if (
      participants.length > MAX_COLLABORATIVE_PARTICIPANTS ||
      cursors.length > MAX_COLLABORATIVE_CURSORS
    ) {
      rollbackRoomClock();
      this.#set({
        roomConnection: 'stale',
        lastUnavailable: 'Live room delta exceeded resulting capacity.',
      });
      this.#refreshMode();
      return;
    }
    let watch = this.#state.watch;
    const targetId = watch.state === 'off' ? null : watch.targetActorId;
    if (targetId) {
      const target = participants.find((entry) => entry.actorId === targetId);
      if (departed.has(targetId)) watch = pauseWatch(watch, 'departed');
      else if (!target && update.kind === 'snapshot')
        watch = pauseWatch(watch, 'target-missing');
      else if (target?.followableView) {
        const following =
          watch.state === 'active'
            ? watch.following
            : watch.state === 'paused'
              ? watch.resumeFollow
              : false;
        watch = Object.freeze({
          state: 'active',
          targetActorId: targetId,
          view: target.followableView,
          following,
        });
        if (following) watch = this.#navigateWatch(watch, 'follow');
      } else if (target) watch = pauseWatch(watch, 'view-unavailable');
    }
    this.#roomSequence = update.sequence;
    this.#principalDigests.clear();
    for (const [actorId, digest] of principalDigests)
      if (!departed.has(actorId)) this.#principalDigests.set(actorId, digest);
    while (this.#principalDigests.size > MAX_COLLABORATIVE_PARTICIPANTS) {
      const oldest = this.#principalDigests.keys().next().value;
      if (oldest === undefined) break;
      this.#principalDigests.delete(oldest);
    }
    this.#set({
      participants: Object.freeze(participants),
      cursors: Object.freeze(cursors),
      roomConnection: 'connected',
      watch,
      lastUnavailable: null,
    });
    this.#refreshDisplayCursors();
    this.#scheduleExpiry();
    this.#refreshMode();
  }

  #scheduleExpiry(): void {
    this.#cancelTtl();
    if (this.#disposed) return;
    const expiries = [
      ...this.#state.participants.map((entry) => entry.expiresAt),
      ...this.#state.cursors.map((entry) => entry.expiresAt),
    ];
    if (expiries.length === 0) return;
    const deadline = Math.min(...expiries);
    const generation = this.#lifecycleGeneration;
    const epoch = this.#roomEpoch;
    try {
      this.#ttlCancel = this.#scheduler.schedule(
        Math.max(0, deadline - this.#now()),
        () => {
          if (
            this.#disposed ||
            generation !== this.#lifecycleGeneration ||
            epoch !== this.#roomEpoch
          )
            return;
          this.#ttlCancel = null;
          const now = this.#now();
          const participants = this.#state.participants.filter(
            (entry) => entry.expiresAt > now,
          );
          const participantIds = new Set(
            participants.map((entry) => entry.actorId),
          );
          for (const actorId of this.#principalDigests.keys())
            if (!participantIds.has(actorId))
              this.#principalDigests.delete(actorId);
          const cursors = this.#state.cursors.filter(
            (entry) =>
              entry.expiresAt > now && participantIds.has(entry.actorId),
          );
          const targetId =
            this.#state.watch.state === 'off'
              ? null
              : this.#state.watch.targetActorId;
          this.#set({
            participants: Object.freeze(participants),
            cursors: Object.freeze(cursors),
            watch:
              targetId && !participantIds.has(targetId)
                ? pauseWatch(this.#state.watch, 'target-missing')
                : this.#state.watch,
          });
          this.#refreshDisplayCursors();
          this.#scheduleExpiry();
        },
      );
    } catch {
      this.#ttlCancel = null;
      this.#set({
        lastUnavailable: 'Presence expiry scheduling was unavailable.',
      });
    }
  }

  #watch(actorId: string, following: boolean): void {
    const authority = this.#currentAuthority();
    if (
      !authority?.capabilities.document.read ||
      !authority.capabilities.room.read ||
      (following
        ? !authority.capabilities.room.follow
        : !authority.capabilities.room.watch)
    )
      return;
    const participant = this.#state.participants.find(
      (entry) => entry.actorId === actorId,
    );
    if (
      !participant?.followableView ||
      participant.surface.state !== 'shared-project-task'
    )
      return;
    let watch: CollaborativeWatchState = Object.freeze({
      state: 'active',
      targetActorId: actorId,
      view: participant.followableView,
      following,
    });
    if (following) watch = this.#navigateWatch(watch, 'follow');
    else if (!this.#resolveTargetProjection(watch.view)) return;
    if (watch.state !== 'active') return;
    this.#set({ watch });
  }

  #navigateWatch(
    watch: Extract<CollaborativeWatchState, { state: 'active' }>,
    reason: 'jump' | 'follow',
  ): CollaborativeWatchState {
    const capability = this.#mintNavigationCapability(
      watch.targetActorId,
      watch.view,
      reason,
    );
    if (!capability)
      return Object.freeze({
        state: 'paused',
        targetActorId: watch.targetActorId,
        reason: 'navigation-unavailable',
        resumeFollow: watch.following,
      });
    let outcome: CollaborativeHostIntentResult;
    try {
      outcome = parseHostResult(
        this.#host.joinAndNavigate({
          reason,
          targetActorId: watch.targetActorId,
          view: watch.view,
          capability,
        }),
      );
    } catch {
      outcome = {
        outcome: 'unavailable',
        reason: 'Host navigation was unavailable.',
      };
    }
    return outcome.outcome === 'accepted'
      ? watch
      : Object.freeze({
          state: 'paused',
          targetActorId: watch.targetActorId,
          reason: 'navigation-unavailable',
          resumeFollow: watch.following,
        });
  }

  #exitFollow(): void {
    if (this.#state.watch.state === 'active' && this.#state.watch.following)
      this.#set({
        watch: Object.freeze({ ...this.#state.watch, following: false }),
      });
    else if (
      this.#state.watch.state === 'paused' &&
      this.#state.watch.resumeFollow
    )
      this.#set({
        watch: Object.freeze({ ...this.#state.watch, resumeFollow: false }),
      });
  }

  #jump(actorId: string): void {
    const authority = this.#currentAuthority();
    if (
      !authority?.capabilities.document.read ||
      !authority.capabilities.room.read
    )
      return;
    const participant = this.#state.participants.find(
      (entry) => entry.actorId === actorId,
    );
    if (
      !participant?.followableView ||
      participant.surface.state !== 'shared-project-task'
    )
      return;
    const capability = this.#mintNavigationCapability(
      actorId,
      participant.followableView,
      'jump',
    );
    if (!capability) return;
    try {
      parseHostResult(
        this.#host.joinAndNavigate({
          reason: 'jump',
          targetActorId: actorId,
          view: participant.followableView,
          capability,
        }),
      );
    } catch {
      // Total host intent.
    }
  }

  #requestJoin(actorId: string): void {
    const authority = this.#currentAuthority();
    if (!authority?.capabilities.room.join) return;
    const participant = this.#state.participants.find(
      (entry) => entry.actorId === actorId,
    );
    if (participant?.surface.state !== 'authorized-unshared') return;
    try {
      parseHostResult(
        this.#host.requestSurfaceJoin({
          targetActorId: actorId,
          scope: this.#scope,
        }),
      );
    } catch {
      // Total host intent.
    }
  }

  #shareCurrent(): void {
    const authority = this.#currentAuthority();
    if (
      !authority?.capabilities.room.share ||
      !authority.capabilities.document.read
    )
      return;
    try {
      parseHostResult(
        this.#host.share({
          scope: this.#scope,
          workingStateRevision: this.#state.authoritative.workingStateRevision,
        }),
      );
    } catch {
      // Total host intent.
    }
  }

  #localSelection(selection: CollaborativeSelection): void {
    this.#exitFollow();
    const authority = this.#currentAuthority();
    if (
      !authority ||
      !validSelection(selection, this.#state.displayText.length)
    )
      return;
    this.#set({ selection: cloneSelection(selection) });
    this.#publishSelection(selection, authority);
  }

  #publishSelection(
    selection: CollaborativeSelection,
    authority: CollaborativeAuthorityAvailable,
  ): void {
    if (
      !this.#cursorOutput ||
      !authority.capabilities.document.read ||
      !authority.capabilities.room.join ||
      !authority.capabilities.room.read ||
      !authority.capabilities.room.share ||
      !validSelection(selection, this.#state.authoritative.text.length)
    )
      return;
    const declaredRate = this.#cursorOutput.maxPerSecond;
    if (!safeInteger(declaredRate) || declaredRate < 1) return;
    const admissionLimit = Math.min(
      declaredRate,
      COLLABORATIVE_CURSOR_RATE_LIMIT_PER_SECOND,
    );
    const now = this.#now();
    while (
      this.#cursorAdmissions.length > 0 &&
      this.#cursorAdmissions[0] <= now - 1_000
    )
      this.#cursorAdmissions.shift();
    if (this.#cursorAdmissions.length >= admissionLimit) return;
    this.#cursorAdmissions.push(now);
    const publication: CollaborativeCursorPublication = Object.freeze({
      schemaVersion: COLLABORATIVE_ROOM_SCHEMA_VERSION,
      scope: this.#scope,
      actorId: this.#localActorId,
      workingStateRevision: this.#state.authoritative.workingStateRevision,
      selection: cloneSelection(selection),
      expiresAt: now + COLLABORATIVE_PRESENCE_TTL_MS,
    });
    try {
      parseHostResult(this.#cursorOutput.publish(publication));
    } catch {
      // Ephemeral publication failure does not mutate document truth.
    }
  }

  async #restore(evidenceRevisionId: string): Promise<void> {
    const authority = this.#currentAuthority();
    if (
      !authority?.capabilities.document.read ||
      !boundedString(evidenceRevisionId)
    )
      return;
    const { generation, signal } = this.#beginRecovery();
    try {
      const raw = await this.#revisionResolver.resolve({
        evidenceRevisionId,
        scope: this.#scope,
        correlationId: this.#correlationId,
        signal,
      });
      if (!this.#recoveryCurrent(generation)) return;
      const refreshed = this.#currentAuthority();
      if (!refreshed?.capabilities.document.read) return;
      const resolution = parseRevisionResolution(
        raw,
        evidenceRevisionId,
        this.#scope,
        this.#correlationId,
      );
      if (resolution.state !== 'AVAILABLE') {
        this.#markStale(resolution.reason);
        return;
      }
      this.#health = 'available';
      this.#busy = false;
      this.#transitionAuthoritative(resolution.projection);
      this.#set({ lastUnavailable: null });
      this.#projectPending();
    } catch {
      if (this.#recoveryCurrent(generation))
        this.#markStale('Immutable revision resolution was unavailable.');
    }
  }

  async #resync(): Promise<void> {
    const authority = this.#currentAuthority();
    if (!authority?.capabilities.document.read) return;
    const { generation, signal } = this.#beginRecovery();
    try {
      const raw = await this.#convergence.resync(signal);
      if (!this.#recoveryCurrent(generation)) return;
      const refreshed = this.#currentAuthority();
      if (!refreshed?.capabilities.document.read) return;
      const result = parseProjection(raw, this.#scope);
      if (result.outcome !== 'available') {
        this.#markStale(result.reason);
        return;
      }
      this.#health = 'available';
      this.#busy = false;
      this.#transitionAuthoritative(result.projection);
      this.#set({ lastUnavailable: null });
      this.#projectPending();
    } catch {
      if (this.#recoveryCurrent(generation))
        this.#markStale('Working-state resync was unavailable.');
    }
  }

  #beginRecovery(): { generation: number; signal: AbortSignal } {
    this.#recoveryAbort?.abort();
    const controller = new AbortController();
    this.#recoveryAbort = controller;
    const generation = ++this.#recoveryGeneration;
    this.#busy = true;
    this.#refreshMode();
    return { generation, signal: controller.signal };
  }
  #cancelRecovery(): void {
    if (!this.#busy && !this.#recoveryAbort) return;
    this.#recoveryAbort?.abort();
    this.#recoveryAbort = null;
    this.#recoveryGeneration += 1;
    this.#busy = false;
  }
  #recoveryCurrent(generation: number): boolean {
    return (
      generation === this.#recoveryGeneration &&
      !this.#recoveryAbort?.signal.aborted
    );
  }
  #markStale(reason: string): void {
    this.#health = 'stale';
    this.#busy = false;
    this.#set({
      lastUnavailable: reason,
      roomConnection:
        this.#state.roomConnection === 'connected'
          ? 'stale'
          : this.#state.roomConnection,
    });
    this.#refreshMode();
  }
  #set(change: Partial<CollaborativePaneState>): void {
    if (this.#disposed) return;
    this.#state = Object.freeze({ ...this.#state, ...change });
    for (const listener of this.#listeners)
      try {
        listener();
      } catch {
        // One observer cannot break controller settlement or cleanup.
      }
  }
}

function parseRevisionResolution(
  value: unknown,
  evidenceRevisionId: string,
  scope: CollaborativePaneScope,
  correlationId: string,
): ImmutableRevisionResolution {
  if (
    !record(value) ||
    value.state !== 'AVAILABLE' ||
    !exactKeys(value, [
      'state',
      'evidenceRevisionId',
      'scope',
      'correlationId',
      'workingStateRevision',
      'projection',
    ])
  )
    return {
      state: 'UNAVAILABLE',
      reason: 'Immutable revision result was not AVAILABLE.',
    };
  const resolvedScope = parseScope(value.scope);
  const projection = parseProjection(
    { outcome: 'available', projection: value.projection },
    scope,
  );
  if (
    value.evidenceRevisionId !== evidenceRevisionId ||
    !resolvedScope ||
    !sameScope(resolvedScope, scope) ||
    value.correlationId !== correlationId ||
    !boundedString(value.workingStateRevision) ||
    projection.outcome !== 'available' ||
    projection.projection.workingStateRevision !== value.workingStateRevision
  )
    return {
      state: 'UNVERIFIED',
      reason:
        'Immutable revision identity, scope, or correlation did not match.',
    };
  return {
    state: 'AVAILABLE',
    evidenceRevisionId,
    scope: resolvedScope,
    correlationId,
    workingStateRevision: value.workingStateRevision,
    projection: projection.projection,
  };
}

function pauseWatch(
  watch: CollaborativeWatchState,
  reason: Extract<CollaborativeWatchState, { state: 'paused' }>['reason'],
): CollaborativeWatchState {
  if (watch.state === 'off') return watch;
  return Object.freeze({
    state: 'paused',
    targetActorId: watch.targetActorId,
    reason,
    resumeFollow:
      watch.state === 'active' ? watch.following : watch.resumeFollow,
  });
}

function mergeByActor<T extends { readonly actorId: string }>(
  current: readonly T[],
  updates: readonly T[],
): T[] {
  const map = new Map(current.map((entry) => [entry.actorId, entry]));
  for (const entry of updates) map.set(entry.actorId, entry);
  return [...map.values()];
}

function cloneState(state: CollaborativePaneState): CollaborativePaneState {
  return Object.freeze({
    ...state,
    authoritative: cloneProjection(state.authoritative),
    selection: cloneSelection(state.selection),
    capabilities: cloneCapabilities(state.capabilities),
    participants: Object.freeze(
      state.participants.map((entry) =>
        Object.freeze({
          ...entry,
          surface: Object.freeze({ ...entry.surface }),
          ...(entry.followableView
            ? {
                followableView: Object.freeze({
                  ...entry.followableView,
                  selection: cloneSelection(entry.followableView.selection),
                }),
              }
            : {}),
        }),
      ),
    ),
    cursors: Object.freeze(
      state.cursors.map((entry) =>
        Object.freeze({ ...entry, selection: cloneSelection(entry.selection) }),
      ),
    ),
    displayCursors: Object.freeze(
      state.displayCursors.map((entry) =>
        Object.freeze({ ...entry, selection: cloneSelection(entry.selection) }),
      ),
    ),
    pendingIntents: Object.freeze(
      state.pendingIntents.map((entry) =>
        Object.freeze({
          ...entry,
          states: Object.freeze({ ...entry.states }),
        }),
      ),
    ),
    rejectedWrites: Object.freeze(
      state.rejectedWrites.map((entry) => Object.freeze({ ...entry })),
    ),
    acceptedAttributions: Object.freeze(
      state.acceptedAttributions.map((entry) => Object.freeze({ ...entry })),
    ),
    watch:
      state.watch.state === 'active'
        ? Object.freeze({
            ...state.watch,
            view: Object.freeze({
              ...state.watch.view,
              selection: cloneSelection(state.watch.view.selection),
            }),
          })
        : Object.freeze({ ...state.watch }),
  });
}
