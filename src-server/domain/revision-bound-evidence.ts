import { createHash } from 'node:crypto';
import { canonicalizeForDigest } from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  type ProposedChange,
  type ProposedChangeDecision,
  validateProposedChange,
} from '@kontourai/station-contracts/proposed-change';
import { revisionEvidenceOutcomes } from '../telemetry/metrics.js';
import {
  compareWorkingStateIds,
  SharedWorkingState,
  type RevisionId as SharedWorkingStateRevisionId,
  type WorkingStateActor,
  type WorkingStateScope,
  type WorkingStateSnapshot,
} from './shared-working-state.js';

export const REVISION_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_REVISION_EVIDENCE_CAPACITY = 256;
export const DEFAULT_REVISION_EVIDENCE_IMPORT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REVISION_EVIDENCE_SNAPSHOT_BYTES = 512 * 1024;
export const DEFAULT_REVISION_EVIDENCE_TEXT_BYTES = 256 * 1024;
export const DEFAULT_REVISION_EVIDENCE_RECORD_BYTES = 768 * 1024;
export const MAX_REVISION_EVIDENCE_IDENTIFIER_BYTES = 256;
export const MAX_REVISION_EVIDENCE_LABEL_BYTES = 256;
export const MAX_REVISION_EVIDENCE_ATTESTATION_BYTES = 4 * 1024;

export type EvidenceRevisionId = `revision-evidence-v1:${string}`;

export interface RevisionCorrelation {
  readonly projectId: string;
  readonly taskId: string;
  readonly agentSessionId?: string;
  readonly runId?: string;
  readonly proposedChangeId?: string;
}

export interface FreezeRevisionInput {
  readonly snapshot: WorkingStateSnapshot;
  readonly parents: readonly EvidenceRevisionId[];
  /** Opaque request identity; never part of the revision identity. */
  readonly requestId: string;
}

export interface CommittedRevision {
  readonly schemaVersion: typeof REVISION_EVIDENCE_SCHEMA_VERSION;
  readonly revisionId: EvidenceRevisionId;
  /** #2889's convergence witness; this module does not reproduce it. */
  readonly sharedRevision: SharedWorkingStateRevisionId;
  readonly scope: WorkingStateScope;
  readonly text: string;
  readonly snapshot: WorkingStateSnapshot;
  readonly actor: WorkingStateActor;
  readonly parents: readonly EvidenceRevisionId[];
  readonly correlation: RevisionCorrelation;
  /** Opaque portable authority receipt; it is integrity material, never a secret. */
  readonly attributionAttestation: string;
}

/** Canonical public material that determines one immutable receipt identity. */
export interface RevisionIdentityPayload {
  readonly schemaVersion: typeof REVISION_EVIDENCE_SCHEMA_VERSION;
  readonly sharedRevision: SharedWorkingStateRevisionId;
  readonly scope: WorkingStateScope;
  readonly snapshot: WorkingStateSnapshot;
  readonly actor: WorkingStateActor;
  readonly parents: readonly EvidenceRevisionId[];
  readonly correlation: RevisionCorrelation;
}

/** Exact receipt facts an authority must bind in its opaque attestation. */
export interface RevisionAttributionBinding {
  readonly revisionId: EvidenceRevisionId;
  readonly parents: readonly EvidenceRevisionId[];
  readonly scope: WorkingStateScope;
  readonly sharedRevision: SharedWorkingStateRevisionId;
  readonly actor: WorkingStateActor;
  readonly correlation: RevisionCorrelation;
  readonly canonicalPayload: RevisionIdentityPayload;
}

export type RevisionEvidenceState =
  | {
      readonly state: 'live_buffer';
      readonly scope: WorkingStateScope;
      readonly sharedRevision: SharedWorkingStateRevisionId;
    }
  | {
      readonly state: 'locally_pending';
      readonly scope: WorkingStateScope;
      readonly sharedRevision: SharedWorkingStateRevisionId;
    }
  | {
      readonly state: 'committed_revision';
      readonly revision: CommittedRevision;
    }
  | {
      readonly state: 'proposed_change';
      readonly proposedChangeId: string;
      readonly status: ProposedChange['status'];
    };

/** Station-local immutable reference, not a Surface/Flow/Veritas shape. */
export interface ImmutableRevisionReference {
  readonly revisionId: EvidenceRevisionId;
  readonly verification: 'verified' | 'unverified';
}

export type RevisionReferenceResolution =
  | { readonly state: 'AVAILABLE'; readonly revision: CommittedRevision }
  | {
      readonly state: 'UNAVAILABLE';
      readonly reason: 'revision_missing' | 'revision_unavailable';
      readonly revisionId: string;
    }
  | {
      readonly state: 'UNVERIFIED';
      readonly reason: 'unverified_reference' | 'malformed_reference';
      readonly revisionId?: string;
    };

export interface RevisionEvidenceExport {
  readonly schemaVersion: typeof REVISION_EVIDENCE_SCHEMA_VERSION;
  readonly revisions: readonly CommittedRevision[];
}

export type RevisionEvidenceExportOutcome =
  | RevisionEvidenceExport
  | { readonly state: 'UNAVAILABLE'; readonly reason: 'revision_unavailable' };

export type RevisionLookupOutcome =
  | CommittedRevision
  | undefined
  | {
      readonly state: 'UNAVAILABLE';
      readonly reason: 'revision_unavailable';
      readonly revisionId: string;
    };

export type RevisionEvidenceRejectionReason =
  | 'malformed'
  | 'snapshot_invalid'
  | 'pending_state'
  | 'missing_parent'
  | 'wrong_scope'
  | 'attribution_unavailable'
  | 'attribution_mismatch'
  | 'attribution_unverified'
  | 'identity_collision'
  | 'capacity_exceeded'
  /** The durable adapter could not prove an exact committed readback. */
  | 'persistence_unavailable';

/**
 * Private durable adapter boundary. It deliberately deals in complete
 * immutable receipts rather than exposing a database, cursor, or CRUD API.
 * The module remains the only place that validates receipt semantics.
 */
export interface RevisionEvidencePersistence {
  restore(input: RevisionEvidencePersistenceBounds):
    | {
        readonly outcome: 'available';
        readonly revisions: readonly unknown[];
        readonly witness: string;
      }
    | { readonly outcome: 'unavailable' | 'corrupt' | 'capacity' };
  persist(input: {
    readonly records: readonly CommittedRevision[];
    readonly bounds: RevisionEvidencePersistenceBounds;
    /** Exact authority-validated restore witness this write is based on. */
    readonly expectedWitness: string;
  }):
    | {
        readonly outcome: 'committed' | 'duplicate';
        readonly inserted: number;
        /** Exact durable readbacks, never caller objects. */
        readonly records: readonly unknown[];
      }
    | {
        readonly outcome: 'rejected';
        readonly reason:
          | 'missing_parent'
          | 'wrong_scope'
          | 'identity_collision'
          | 'capacity_exceeded';
      }
    | {
        readonly outcome: 'unavailable';
        readonly reason?: 'stale_witness';
      }
    | { readonly outcome: 'corrupt' };
}

export interface RevisionEvidencePersistenceBounds {
  readonly maxRevisions: number;
  readonly maxPortableBytes: number;
  readonly maxRecordBytes: number;
}

export type FreezeOutcome =
  | { readonly outcome: 'committed'; readonly revision: CommittedRevision }
  | { readonly outcome: 'duplicate'; readonly revision: CommittedRevision }
  | {
      readonly outcome: 'rejected';
      readonly reason: RevisionEvidenceRejectionReason;
    };

export type ImportOutcome =
  | { readonly outcome: 'imported'; readonly revisions: number }
  | { readonly outcome: 'duplicate'; readonly revisions: number }
  | {
      readonly outcome: 'rejected';
      readonly reason: RevisionEvidenceRejectionReason;
    };

export interface RevisionDiff {
  readonly beforeRevisionId: EvidenceRevisionId;
  readonly afterRevisionId: EvidenceRevisionId;
  readonly prefix: string;
  readonly removed: string;
  readonly added: string;
  readonly suffix: string;
}

/** Narrow composition seam; ProposedChangeService owns all lifecycle mutation. */
export interface CanonicalProposedChangeLookup {
  find(proposedChangeId: string): ProposedChange | undefined;
  /** Optional canonical run correlation when the proposed-change owner has one. */
  runIdFor?(change: ProposedChange): string | undefined;
}

/** Server-owned attribution authority composed outside this pure receipt module. */
export interface RevisionAttributionAuthority {
  resolve(input: {
    readonly scope: WorkingStateScope;
    readonly sharedRevision: SharedWorkingStateRevisionId;
    readonly requestId: string;
  }):
    | {
        readonly outcome: 'resolved';
        readonly actor: WorkingStateActor;
        readonly correlation: RevisionCorrelation;
      }
    | { readonly outcome: 'unavailable' };
  /** Issue an opaque portable receipt only after the deterministic ID exists. */
  attest(
    input: RevisionAttributionBinding,
  ):
    | { readonly outcome: 'attested'; readonly attestation: string }
    | { readonly outcome: 'unavailable' };
  /** Verify an imported receipt against every identity-bearing public fact. */
  verify(
    input: RevisionAttributionBinding & { readonly attestation: string },
  ): { readonly outcome: 'verified' } | { readonly outcome: 'unavailable' };
}

export interface ProposedChangeRevisionBinding {
  readonly proposedChangeId: string;
  readonly beforeRevisionId: EvidenceRevisionId;
  readonly afterRevisionId: EvidenceRevisionId;
}

export type ProposedChangeRevisionResolution =
  | {
      readonly state: 'AVAILABLE';
      readonly change: {
        readonly id: string;
        readonly status: 'approved';
        readonly sessionId: string;
        readonly baseSnapshot: ProposedChange['baseSnapshot'];
        readonly proposedSnapshot: ProposedChange['proposedSnapshot'];
        readonly decision: ProposedChangeDecision;
      };
      readonly diff: RevisionDiff;
    }
  | {
      readonly state: 'UNAVAILABLE';
      readonly reason:
        | 'proposed_change_missing'
        | 'proposed_change_rejected'
        | 'proposed_change_superseded'
        | 'revision_missing'
        | 'revision_unavailable';
    }
  | {
      readonly state: 'UNVERIFIED';
      readonly reason:
        | 'proposed_change_lookup_unavailable'
        | 'proposed_change_pending'
        | 'malformed_proposed_change'
        | 'binding_mismatch';
    };

export interface RevisionEvidenceModuleOptions {
  readonly maxRevisions?: number;
  readonly maxImportEntries?: number;
  readonly maxImportBytes?: number;
  readonly maxSnapshotBytes?: number;
  readonly maxTextBytes?: number;
  readonly maxRecordBytes?: number;
  /** Required to freeze a receipt; caller-supplied attribution is never trusted. */
  readonly attribution?: RevisionAttributionAuthority;
  readonly proposedChanges?: CanonicalProposedChangeLookup;
  /** Optional server-owned durable receipt adapter. */
  readonly persistence?: RevisionEvidencePersistence;
  /** EventStore tracks the Module before starting callback-bearing restore. */
  readonly deferPersistenceRestore?: boolean;
}

/**
 * Deliberately small projection for a Project/Task room link. It excludes the
 * canonical shared-state snapshot and opaque attribution attestation; callers
 * receive no local path, storage, or mutable-record surface.
 */
export interface RevisionEvidenceLinkView {
  readonly revisionId: EvidenceRevisionId;
  readonly scope: WorkingStateScope;
  readonly text: string;
  readonly parents: readonly EvidenceRevisionId[];
  readonly actor: WorkingStateActor;
  readonly correlation: RevisionCorrelation;
}

/** Canonical digest for the exact allowlisted room-link projection. */
export function revisionEvidenceLinkViewDigest(
  view: RevisionEvidenceLinkView,
): string {
  return canonicalDigest({
    kind: 'station.revision-evidence-link-view/v1',
    revision: view,
  });
}

export type RevisionEvidenceLinkResolution =
  | { readonly state: 'AVAILABLE'; readonly revision: RevisionEvidenceLinkView }
  | {
      readonly state: 'UNAVAILABLE';
      readonly reason:
        | 'revision_missing'
        | 'revision_unavailable'
        | 'wrong_scope';
      readonly revisionId: string;
    }
  | { readonly state: 'UNVERIFIED'; readonly reason: 'malformed_reference' };

/** A read-only, scope-bound seam for later room/SDK link composition. */
export interface RevisionEvidenceReader {
  resolve(input: {
    readonly scope: WorkingStateScope;
    readonly revisionId: EvidenceRevisionId;
  }): RevisionEvidenceLinkResolution;
}

interface Bounds {
  readonly maxRevisions: number;
  readonly maxImportEntries: number;
  readonly maxImportBytes: number;
  readonly maxSnapshotBytes: number;
  readonly maxTextBytes: number;
  readonly maxRecordBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWellFormedUnicode(value: string): boolean {
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

function boundedText(
  value: unknown,
  maximum = MAX_REVISION_EVIDENCE_IDENTIFIER_BYTES,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    isWellFormedUnicode(value) &&
    Buffer.byteLength(value, 'utf8') <= maximum
  );
}

function bytes(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : Buffer.byteLength(encoded, 'utf8');
  } catch {
    return null;
  }
}

/** Exact JSON byte count for portable ordinary data, with bounded streaming. */
function boundedPortableJsonBytes(
  value: unknown,
  maximum: number,
): number | null {
  const ancestors = new WeakSet<object>();
  const jsonStringBytes = (current: string, limit: number): number => {
    let total = 1; // opening quote
    for (let index = 0; index < current.length; index += 1) {
      const unit = current.charCodeAt(index);
      let size: number;
      if (unit <= 0x1f) {
        size =
          unit === 0x08 ||
          unit === 0x09 ||
          unit === 0x0a ||
          unit === 0x0c ||
          unit === 0x0d
            ? 2
            : 6;
      } else if (unit === 0x22 || unit === 0x5c) {
        size = 2;
      } else if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = current.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          size = 4;
          index += 1;
        } else {
          // Well-formed JSON.stringify escapes unpaired surrogates.
          size = 6;
        }
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        size = 6;
      } else if (unit <= 0x7f) {
        size = 1;
      } else if (unit <= 0x7ff) {
        size = 2;
      } else {
        size = 3;
      }
      if (total > limit - size) return limit + 1;
      total += size;
    }
    return total > limit - 1 ? limit + 1 : total + 1; // closing quote
  };
  const scalar = (
    current: string | number | boolean | null,
    limit: number,
  ): number => {
    if (typeof current === 'string') return jsonStringBytes(current, limit);
    if (current === null) return limit < 4 ? limit + 1 : 4;
    if (typeof current === 'boolean') {
      const size = current ? 4 : 5;
      return limit < size ? limit + 1 : size;
    }
    // Finite IEEE-754 JSON numbers serialize to a bounded ASCII spelling.
    const rendered = JSON.stringify(current);
    return rendered === undefined || rendered.length > 32
      ? limit + 1
      : rendered.length > limit
        ? limit + 1
        : rendered.length;
  };
  const add = (left: number, right: number, limit: number): number =>
    left > limit - right ? limit + 1 : left + right;
  const visit = (
    current: unknown,
    depth: number,
    arrayElement = false,
    limit = maximum,
  ): number | null => {
    if (depth > 32) return null;
    if (typeof current === 'string') return scalar(current, limit);
    if (current === null || typeof current === 'boolean')
      return scalar(current, limit);
    if (typeof current === 'number')
      return Number.isFinite(current) ? scalar(current, limit) : null;
    if (
      current === undefined ||
      typeof current === 'function' ||
      typeof current === 'symbol'
    )
      return arrayElement ? scalar(null, limit) : -1;
    if (typeof current !== 'object') return null;
    if (ancestors.has(current)) return null;
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        // Check length before any element indexing; holes stringify as null.
        if (current.length > 4_096) return limit + 1;
        let total = 2;
        if (total > limit) return limit + 1;
        for (let index = 0; index < current.length; index += 1) {
          if (index > 0) total = add(total, 1, limit);
          if (total > limit) return total;
          const childBytes = visit(
            current[index],
            depth + 1,
            true,
            limit - total,
          );
          if (childBytes === null) return null;
          total = add(total, childBytes, limit);
          if (total > limit) return total;
        }
        return total;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return null;
      let total = 2;
      if (total > limit) return limit + 1;
      let count = 0;
      let emitted = 0;
      for (const key in current) {
        if (!Object.prototype.propertyIsEnumerable.call(current, key)) continue;
        count += 1;
        if (count > 4_096) return limit + 1;
        const child = (current as Record<string, unknown>)[key];
        // JSON omits undefined/function/symbol object properties.
        if (
          child === undefined ||
          typeof child === 'function' ||
          typeof child === 'symbol'
        )
          continue;
        if (emitted > 0) total = add(total, 1, limit);
        if (total > limit) return total;
        const keyBytes = scalar(key, limit - total);
        total = add(total, keyBytes, limit);
        total = add(total, 1, limit); // colon
        if (total > limit) return total;
        const childBytes = visit(child, depth + 1, false, limit - total);
        if (childBytes === null) return null;
        total = add(total, childBytes, limit);
        if (total > limit) return total;
        emitted += 1;
      }
      return total;
    } finally {
      ancestors.delete(current);
    }
  };
  try {
    return visit(value, 0);
  } catch {
    return null;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForDigest(value)) ?? 'null')
    .digest('hex');
}

function same(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalizeForDigest(left)) ===
    JSON.stringify(canonicalizeForDigest(right))
  );
}

function canonicalScope(value: unknown): WorkingStateScope | null {
  if (!isRecord(value)) return null;
  if (
    !boundedText(value.projectId) ||
    !boundedText(value.taskId) ||
    !boundedText(value.documentId)
  )
    return null;
  return {
    projectId: value.projectId,
    taskId: value.taskId,
    documentId: value.documentId,
  };
}

function canonicalActor(value: unknown): WorkingStateActor | null {
  if (
    !isRecord(value) ||
    !boundedText(value.actorId) ||
    (value.kind !== 'human' && value.kind !== 'agent')
  )
    return null;
  if (
    value.displayLabel !== undefined &&
    !boundedText(value.displayLabel, MAX_REVISION_EVIDENCE_LABEL_BYTES)
  )
    return null;
  return {
    actorId: value.actorId,
    kind: value.kind,
    ...(value.displayLabel === undefined
      ? {}
      : { displayLabel: value.displayLabel }),
  };
}

function canonicalCorrelation(value: unknown): RevisionCorrelation | null {
  if (
    !isRecord(value) ||
    !boundedText(value.projectId) ||
    !boundedText(value.taskId)
  )
    return null;
  const agentSessionId = value.agentSessionId;
  const runId = value.runId;
  const proposedChangeId = value.proposedChangeId;
  if (
    (agentSessionId !== undefined && !boundedText(agentSessionId)) ||
    (runId !== undefined && !boundedText(runId)) ||
    (proposedChangeId !== undefined && !boundedText(proposedChangeId))
  )
    return null;
  return {
    projectId: value.projectId,
    taskId: value.taskId,
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    ...(runId === undefined ? {} : { runId }),
    ...(proposedChangeId === undefined ? {} : { proposedChangeId }),
  };
}

function validEvidenceRevisionId(value: unknown): value is EvidenceRevisionId {
  return (
    typeof value === 'string' &&
    /^revision-evidence-v1:[0-9a-f]{64}$/.test(value)
  );
}

function stableIds<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareWorkingStateIds);
}

function sameScope(left: WorkingStateScope, right: WorkingStateScope): boolean {
  return (
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.documentId === right.documentId
  );
}

function revisionIdentityPayload(input: {
  snapshot: WorkingStateSnapshot;
  sharedRevision: SharedWorkingStateRevisionId;
  scope: WorkingStateScope;
  actor: WorkingStateActor;
  parents: readonly EvidenceRevisionId[];
  correlation: RevisionCorrelation;
}): RevisionIdentityPayload {
  return {
    schemaVersion: REVISION_EVIDENCE_SCHEMA_VERSION,
    sharedRevision: input.sharedRevision,
    scope: input.scope,
    snapshot: input.snapshot,
    actor: input.actor,
    parents: stableIds(input.parents),
    correlation: input.correlation,
  };
}

function revisionIdentity(
  payload: RevisionIdentityPayload,
): EvidenceRevisionId {
  return `revision-evidence-v1:${canonicalDigest(payload)}`;
}

function attributionBinding(record: {
  revisionId: EvidenceRevisionId;
  sharedRevision: SharedWorkingStateRevisionId;
  scope: WorkingStateScope;
  snapshot: WorkingStateSnapshot;
  actor: WorkingStateActor;
  parents: readonly EvidenceRevisionId[];
  correlation: RevisionCorrelation;
}): RevisionAttributionBinding {
  const canonicalPayload = revisionIdentityPayload(record);
  return {
    revisionId: record.revisionId,
    parents: canonicalPayload.parents,
    scope: record.scope,
    sharedRevision: record.sharedRevision,
    actor: record.actor,
    correlation: record.correlation,
    canonicalPayload,
  };
}

function sameReceiptIdentity(
  left: CommittedRevision,
  right: CommittedRevision,
): boolean {
  return (
    left.revisionId === right.revisionId &&
    same(revisionIdentityPayload(left), revisionIdentityPayload(right))
  );
}

function settledRecord(
  input: unknown,
  bounds: Bounds,
  attribution?: RevisionAttributionAuthority,
  active: () => boolean = () => true,
):
  | { readonly record: CommittedRevision }
  | { readonly reason: RevisionEvidenceRejectionReason } {
  if (
    !isRecord(input) ||
    !isRecord(input.snapshot) ||
    !Array.isArray(input.parents)
  )
    return { reason: 'malformed' };
  const sourceScope = canonicalScope(input.snapshot.scope);
  const sourceBytes = boundedPortableJsonBytes(
    input.snapshot,
    bounds.maxSnapshotBytes,
  );
  if (
    !sourceScope ||
    sourceBytes === null ||
    sourceBytes > bounds.maxSnapshotBytes
  )
    return { reason: 'snapshot_invalid' };
  if (
    !input.parents.every(validEvidenceRevisionId) ||
    stableIds(input.parents).length !== input.parents.length
  )
    return { reason: 'malformed' };
  try {
    // Raw caller data is only input to #2889 validation. The reconstructed
    // snapshot below is the sole snapshot retained or hashed by this module.
    const restored = new SharedWorkingState({
      scope: sourceScope,
      snapshot: input.snapshot as unknown as WorkingStateSnapshot,
    });
    const snapshot = restored.snapshot();
    if (snapshot.deferred.length > 0) return { reason: 'pending_state' };
    const scope = canonicalScope(snapshot.scope);
    if (!scope || !sameScope(scope, sourceScope))
      return { reason: 'snapshot_invalid' };
    let attributedActor: unknown = input.actor;
    let attributedCorrelation: unknown = input.correlation;
    let attestation: unknown = input.attributionAttestation;
    if (attribution) {
      if (!boundedText(input.requestId)) return { reason: 'malformed' };
      let resolved: ReturnType<RevisionAttributionAuthority['resolve']>;
      try {
        resolved = attribution.resolve({
          scope,
          sharedRevision: restored.revision,
          requestId: input.requestId,
        });
      } catch {
        return { reason: 'attribution_unavailable' };
      }
      if (!active()) return { reason: 'persistence_unavailable' };
      if (resolved.outcome !== 'resolved')
        return { reason: 'attribution_unavailable' };
      attributedActor = resolved.actor;
      attributedCorrelation = resolved.correlation;
    }
    const actor = canonicalActor(attributedActor);
    const correlation = canonicalCorrelation(attributedCorrelation);
    if (!actor || !correlation) return { reason: 'attribution_mismatch' };
    if (
      scope.projectId !== correlation.projectId ||
      scope.taskId !== correlation.taskId
    )
      return { reason: attribution ? 'attribution_mismatch' : 'wrong_scope' };
    const text = restored.text();
    if (
      !isWellFormedUnicode(text) ||
      Buffer.byteLength(text, 'utf8') > bounds.maxTextBytes
    )
      return { reason: 'capacity_exceeded' };
    const canonicalPayload = revisionIdentityPayload({
      snapshot,
      sharedRevision: restored.revision,
      scope,
      actor,
      parents: input.parents as EvidenceRevisionId[],
      correlation,
    });
    const revisionId = revisionIdentity(canonicalPayload);
    if (attribution) {
      let issued: ReturnType<RevisionAttributionAuthority['attest']>;
      try {
        issued = attribution.attest({
          revisionId,
          parents: canonicalPayload.parents,
          scope,
          sharedRevision: restored.revision,
          actor,
          correlation,
          canonicalPayload,
        });
      } catch {
        return { reason: 'attribution_unavailable' };
      }
      if (!active()) return { reason: 'persistence_unavailable' };
      if (issued.outcome !== 'attested')
        return { reason: 'attribution_unavailable' };
      attestation = issued.attestation;
    }
    if (!boundedText(attestation, MAX_REVISION_EVIDENCE_ATTESTATION_BYTES))
      return { reason: 'attribution_unverified' };
    const record: CommittedRevision = {
      schemaVersion: REVISION_EVIDENCE_SCHEMA_VERSION,
      revisionId,
      sharedRevision: restored.revision,
      scope,
      text,
      snapshot,
      actor,
      parents: stableIds(input.parents) as EvidenceRevisionId[],
      correlation,
      attributionAttestation: attestation,
    };
    const recordBytes = bytes(record);
    return recordBytes === null || recordBytes > bounds.maxRecordBytes
      ? { reason: 'capacity_exceeded' }
      : { record };
  } catch {
    return { reason: 'snapshot_invalid' };
  }
}

function exportedRecordMatches(
  value: Record<string, unknown>,
  record: CommittedRevision,
): boolean {
  return (
    value.schemaVersion === record.schemaVersion &&
    value.revisionId === record.revisionId &&
    value.sharedRevision === record.sharedRevision &&
    value.text === record.text &&
    same(value.scope, record.scope) &&
    same(value.snapshot, record.snapshot) &&
    same(value.actor, record.actor) &&
    same(value.parents, record.parents) &&
    same(value.correlation, record.correlation) &&
    value.attributionAttestation === record.attributionAttestation
  );
}

function parseExportRecord(
  value: unknown,
  bounds: Bounds,
):
  | { readonly record: CommittedRevision }
  | { readonly reason: RevisionEvidenceRejectionReason } {
  if (
    !isRecord(value) ||
    value.schemaVersion !== REVISION_EVIDENCE_SCHEMA_VERSION ||
    !validEvidenceRevisionId(value.revisionId)
  )
    return { reason: 'malformed' };
  const parsed = settledRecord(value, bounds);
  if ('reason' in parsed) return parsed;
  return exportedRecordMatches(value, parsed.record)
    ? parsed
    : { reason: 'identity_collision' };
}

function diff(
  before: CommittedRevision,
  after: CommittedRevision,
): RevisionDiff {
  let prefixLength = 0;
  while (
    prefixLength < before.text.length &&
    prefixLength < after.text.length &&
    before.text[prefixLength] === after.text[prefixLength]
  )
    prefixLength += 1;
  let suffixLength = 0;
  while (
    suffixLength < before.text.length - prefixLength &&
    suffixLength < after.text.length - prefixLength &&
    before.text[before.text.length - suffixLength - 1] ===
      after.text[after.text.length - suffixLength - 1]
  )
    suffixLength += 1;
  return {
    beforeRevisionId: before.revisionId,
    afterRevisionId: after.revisionId,
    prefix: before.text.slice(0, prefixLength),
    removed: before.text.slice(prefixLength, before.text.length - suffixLength),
    added: after.text.slice(prefixLength, after.text.length - suffixLength),
    suffix: before.text.slice(before.text.length - suffixLength),
  };
}

function canonicalDecision(
  change: ProposedChange,
): ProposedChangeDecision | null {
  if (change.decisions.length !== 1) return null;
  const decision = change.decisions[0]!;
  if (
    decision.decision !== change.status ||
    !boundedText(decision.id) ||
    !boundedText(decision.changeId) ||
    !boundedText(decision.decidedAt) ||
    (decision.reason !== undefined &&
      !boundedText(decision.reason, MAX_REVISION_EVIDENCE_LABEL_BYTES)) ||
    (decision.actorId !== undefined && !boundedText(decision.actorId)) ||
    (decision.bulkDecisionId !== undefined &&
      !boundedText(decision.bulkDecisionId))
  )
    return null;
  return {
    id: decision.id,
    changeId: decision.changeId,
    decision: decision.decision,
    actorType: decision.actorType,
    decidedAt: decision.decidedAt,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.actorId === undefined ? {} : { actorId: decision.actorId }),
    ...(decision.bulkDecisionId === undefined
      ? {}
      : { bulkDecisionId: decision.bulkDecisionId }),
  };
}

function proposedContents(
  change: ProposedChange,
  maximumBytes: number,
): { readonly before: string; readonly after: string } | null {
  const base = change.baseSnapshot?.content;
  const proposed = change.proposedSnapshot?.content;
  let before: string;
  let after: string;
  if (change.changeType === 'create') {
    if (change.baseSnapshot !== null || typeof proposed !== 'string')
      return null;
    before = '';
    after = proposed;
  } else if (change.changeType === 'delete') {
    if (typeof base !== 'string' || change.proposedSnapshot !== null)
      return null;
    before = base;
    after = '';
  } else {
    if (typeof base !== 'string' || typeof proposed !== 'string') return null;
    before = base;
    after = proposed;
  }
  if (
    !isWellFormedUnicode(before) ||
    !isWellFormedUnicode(after) ||
    Buffer.byteLength(before, 'utf8') > maximumBytes ||
    Buffer.byteLength(after, 'utf8') > maximumBytes
  )
    return null;
  return { before, after };
}

function canonicalDecisionCardinality(change: unknown): boolean {
  if (!isRecord(change) || !Array.isArray(change.decisions)) return false;
  return change.status === 'pending'
    ? change.decisions.length === 0
    : (change.status === 'approved' ||
        change.status === 'rejected' ||
        change.status === 'superseded') &&
        change.decisions.length === 1;
}

/**
 * Deep Station module for immutable #2889 revision receipts. The canonical
 * ProposedChange service remains the sole owner of change lifecycle mutation.
 */
export class RevisionEvidenceModule {
  readonly #bounds: Bounds;
  readonly #revisions = new Map<EvidenceRevisionId, CommittedRevision>();
  readonly #attribution?: RevisionAttributionAuthority;
  readonly #proposedChanges?: CanonicalProposedChangeLookup;
  readonly #persistence?: RevisionEvidencePersistence;
  #closed = false;
  #lifecycleGeneration = 0;
  #restoreWitness?: string;
  #lastRestoreOutcome: 'available' | 'unavailable' | 'corrupt' | 'capacity' =
    'available';

  constructor(options: RevisionEvidenceModuleOptions = {}) {
    const positive = (value: number | undefined, fallback: number): number => {
      const resolved = value ?? fallback;
      if (!Number.isSafeInteger(resolved) || resolved < 1)
        throw new Error(
          'revision evidence bounds must be positive safe integers',
        );
      return resolved;
    };
    const maxRevisions = positive(
      options.maxRevisions,
      DEFAULT_REVISION_EVIDENCE_CAPACITY,
    );
    this.#bounds = {
      maxRevisions,
      maxImportEntries: positive(options.maxImportEntries, maxRevisions),
      maxImportBytes: positive(
        options.maxImportBytes,
        DEFAULT_REVISION_EVIDENCE_IMPORT_BYTES,
      ),
      maxSnapshotBytes: positive(
        options.maxSnapshotBytes,
        DEFAULT_REVISION_EVIDENCE_SNAPSHOT_BYTES,
      ),
      maxTextBytes: positive(
        options.maxTextBytes,
        DEFAULT_REVISION_EVIDENCE_TEXT_BYTES,
      ),
      maxRecordBytes: positive(
        options.maxRecordBytes,
        DEFAULT_REVISION_EVIDENCE_RECORD_BYTES,
      ),
    };
    this.#attribution = options.attribution;
    this.#proposedChanges = options.proposedChanges;
    this.#persistence = options.persistence;
    if (this.#persistence && !options.deferPersistenceRestore)
      this.initializePersistence();
  }

  /** EventStore-only second phase: registration precedes external callbacks. */
  initializePersistence(): boolean {
    const generation = this.#lifecycleGeneration;
    return this.#active(generation) && this.#restorePersisted(generation);
  }

  liveBuffer(
    scope: WorkingStateScope,
    sharedRevision: SharedWorkingStateRevisionId,
  ): RevisionEvidenceState {
    const canonical = canonicalScope(scope);
    if (!canonical || !boundedText(sharedRevision))
      throw new Error('live buffer state is malformed');
    return {
      state: 'live_buffer',
      scope: canonical,
      sharedRevision,
    };
  }

  locallyPending(
    scope: WorkingStateScope,
    sharedRevision: SharedWorkingStateRevisionId,
  ): RevisionEvidenceState {
    const canonical = canonicalScope(scope);
    if (!canonical || !boundedText(sharedRevision))
      throw new Error('locally pending state is malformed');
    return {
      state: 'locally_pending',
      scope: canonical,
      sharedRevision,
    };
  }

  freeze(input: unknown): FreezeOutcome {
    const generation = this.#lifecycleGeneration;
    if (!this.#active(generation))
      return this.#freezeResult({
        outcome: 'rejected',
        reason: 'persistence_unavailable',
      });
    if (!this.#attribution)
      return this.#freezeResult({
        outcome: 'rejected',
        reason: 'attribution_unavailable',
      });
    if (this.#persistence && !this.#restoreForWrite(generation))
      return this.#freezeResult({
        outcome: 'rejected',
        reason: 'persistence_unavailable',
      });
    const parsed = settledRecord(input, this.#bounds, this.#attribution, () =>
      this.#active(generation),
    );
    if (!this.#active(generation))
      return this.#freezeResult({
        outcome: 'rejected',
        reason: 'persistence_unavailable',
      });
    if ('reason' in parsed)
      return this.#freezeResult({ outcome: 'rejected', reason: parsed.reason });
    if (this.#persistence) {
      const persisted = this.#persistDurable([parsed.record], generation);
      if (persisted.outcome === 'rejected')
        return this.#freezeResult({
          outcome: 'rejected',
          reason: persisted.reason,
        });
      if (
        persisted.outcome === 'unavailable' ||
        persisted.outcome === 'corrupt' ||
        !this.#admitPersisted([parsed.record], persisted.records, generation)
      )
        return this.#freezeResult({
          outcome: 'rejected',
          reason: 'persistence_unavailable',
        });
      const durable = this.#revisions.get(parsed.record.revisionId);
      if (
        !this.#active(generation) ||
        !durable ||
        !sameReceiptIdentity(durable, parsed.record)
      ) {
        return this.#freezeResult({
          outcome: 'rejected',
          reason: durable ? 'identity_collision' : 'persistence_unavailable',
        });
      }
      if (!this.#active(generation))
        return this.#freezeResult({
          outcome: 'rejected',
          reason: 'persistence_unavailable',
        });
      return this.#freezeResult({
        outcome: persisted.inserted === 1 ? 'committed' : 'duplicate',
        revision: clone(durable),
      });
    }
    const existing = this.#revisions.get(parsed.record.revisionId);
    if (existing)
      return this.#freezeResult(
        this.#active(generation) && sameReceiptIdentity(existing, parsed.record)
          ? { outcome: 'duplicate', revision: clone(existing) }
          : { outcome: 'rejected', reason: 'identity_collision' },
      );
    if (this.#revisions.size >= this.#bounds.maxRevisions)
      return this.#freezeResult({
        outcome: 'rejected',
        reason: 'capacity_exceeded',
      });
    if (parsed.record.parents.some((id) => !this.#revisions.has(id)))
      return this.#freezeResult({
        outcome: 'rejected',
        reason: 'missing_parent',
      });
    if (
      parsed.record.parents.some(
        (id) => !sameScope(this.#revisions.get(id)!.scope, parsed.record.scope),
      )
    )
      return this.#freezeResult({ outcome: 'rejected', reason: 'wrong_scope' });
    if (!this.#active(generation))
      return this.#freezeResult({
        outcome: 'rejected',
        reason: 'persistence_unavailable',
      });
    this.#revisions.set(parsed.record.revisionId, clone(parsed.record));
    if (!this.#active(generation)) {
      this.#revisions.delete(parsed.record.revisionId);
      return this.#freezeResult({
        outcome: 'rejected',
        reason: 'persistence_unavailable',
      });
    }
    return this.#freezeResult({
      outcome: 'committed',
      revision: clone(parsed.record),
    });
  }

  revision(revisionId: EvidenceRevisionId): RevisionLookupOutcome {
    const generation = this.#lifecycleGeneration;
    if (
      !this.#active(generation) ||
      (this.#persistence && !this.#restoreForWrite(generation))
    )
      return {
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
        revisionId,
      };
    const record = this.#revisions.get(revisionId);
    if (!this.#active(generation))
      return {
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
        revisionId,
      };
    return record ? clone(record) : undefined;
  }

  /** EventStore fences retained capabilities before closing its SQLite owner. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifecycleGeneration += 1;
    this.#restoreWitness = undefined;
    this.#revisions.clear();
  }

  #active(generation: number): boolean {
    return !this.#closed && this.#lifecycleGeneration === generation;
  }

  /**
   * Scope-bound projection used by room-history links and a later SDK route.
   * Full snapshots and attestations remain server-only even when a link is
   * available to the same Project/Task/document.
   */
  reader(): RevisionEvidenceReader {
    return Object.freeze({
      resolve: (input: Parameters<RevisionEvidenceReader['resolve']>[0]) =>
        this.#resolveLink(input),
    });
  }

  resolveEvidence(reference: unknown): RevisionReferenceResolution {
    return this.#resolve(reference, 'evidence');
  }

  resolveGateInput(reference: unknown): RevisionReferenceResolution {
    return this.#resolve(reference, 'gate_input');
  }

  resolveProposedChange(binding: unknown): ProposedChangeRevisionResolution {
    const generation = this.#lifecycleGeneration;
    if (
      !this.#active(generation) ||
      (this.#persistence && !this.#restorePersisted(generation))
    )
      return this.#proposedResult({
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
      });
    if (!this.#proposedChanges)
      return this.#proposedResult({
        state: 'UNVERIFIED',
        reason: 'proposed_change_lookup_unavailable',
      });
    if (
      !isRecord(binding) ||
      !boundedText(binding.proposedChangeId) ||
      !validEvidenceRevisionId(binding.beforeRevisionId) ||
      !validEvidenceRevisionId(binding.afterRevisionId) ||
      binding.beforeRevisionId === binding.afterRevisionId
    )
      return this.#proposedResult({
        state: 'UNVERIFIED',
        reason: 'binding_mismatch',
      });
    let change: ProposedChange | undefined;
    try {
      change = this.#proposedChanges.find(binding.proposedChangeId);
    } catch {
      if (!this.#active(generation))
        return this.#proposedResult({
          state: 'UNAVAILABLE',
          reason: 'revision_unavailable',
        });
      return this.#proposedResult({
        state: 'UNVERIFIED',
        reason: 'proposed_change_lookup_unavailable',
      });
    }
    if (!this.#active(generation))
      return this.#proposedResult({
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
      });
    if (!change)
      return this.#proposedResult({
        state: 'UNAVAILABLE',
        reason: 'proposed_change_missing',
      });
    if (
      !canonicalDecisionCardinality(change) ||
      !validateProposedChange(change).valid ||
      change.id !== binding.proposedChangeId ||
      (change.status !== 'pending' && !canonicalDecision(change))
    )
      return this.#proposedResult({
        state: 'UNVERIFIED',
        reason: 'malformed_proposed_change',
      });
    const before = this.#revisions.get(binding.beforeRevisionId);
    const after = this.#revisions.get(binding.afterRevisionId);
    if (!before || !after)
      return this.#proposedResult({
        state: 'UNAVAILABLE',
        reason: 'revision_missing',
      });
    if (change.status === 'pending')
      return this.#proposedResult({
        state: 'UNVERIFIED',
        reason: 'proposed_change_pending',
      });
    if (change.status === 'rejected')
      return this.#proposedResult({
        state: 'UNAVAILABLE',
        reason: 'proposed_change_rejected',
      });
    if (change.status === 'superseded')
      return this.#proposedResult({
        state: 'UNAVAILABLE',
        reason: 'proposed_change_superseded',
      });
    const decision = canonicalDecision(change);
    if (decision?.decision !== 'approved')
      return this.#proposedResult({
        state: 'UNVERIFIED',
        reason: 'malformed_proposed_change',
      });
    const contents = proposedContents(change, this.#bounds.maxTextBytes);
    let canonicalRunId: string | undefined;
    try {
      canonicalRunId = this.#proposedChanges.runIdFor?.(change);
    } catch {
      if (!this.#active(generation))
        return this.#proposedResult({
          state: 'UNAVAILABLE',
          reason: 'revision_unavailable',
        });
      return this.#proposedResult({
        state: 'UNVERIFIED',
        reason: 'proposed_change_lookup_unavailable',
      });
    }
    if (!this.#active(generation))
      return this.#proposedResult({
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
      });
    if (
      !contents ||
      !sameScope(before.scope, after.scope) ||
      !this.#isAncestor(before.revisionId, after.revisionId) ||
      before.scope.projectId !== change.projectId ||
      after.scope.projectId !== change.projectId ||
      before.correlation.proposedChangeId !== change.id ||
      after.correlation.proposedChangeId !== change.id ||
      before.correlation.agentSessionId !== change.sessionId ||
      after.correlation.agentSessionId !== change.sessionId ||
      (canonicalRunId !== undefined &&
        (!boundedText(canonicalRunId) ||
          before.correlation.runId !== canonicalRunId ||
          after.correlation.runId !== canonicalRunId)) ||
      before.text !== contents.before ||
      after.text !== contents.after
    )
      return this.#proposedResult({
        state: 'UNVERIFIED',
        reason: 'binding_mismatch',
      });
    if (!this.#active(generation))
      return this.#proposedResult({
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
      });
    return this.#proposedResult({
      state: 'AVAILABLE',
      change: {
        id: change.id,
        status: 'approved',
        sessionId: change.sessionId,
        baseSnapshot: clone(change.baseSnapshot),
        proposedSnapshot: clone(change.proposedSnapshot),
        decision,
      },
      diff: clone(diff(before, after)),
    });
  }

  exportPortable(): RevisionEvidenceExportOutcome {
    const generation = this.#lifecycleGeneration;
    if (
      !this.#active(generation) ||
      (this.#persistence && !this.#restorePersisted(generation))
    )
      return { state: 'UNAVAILABLE', reason: 'revision_unavailable' };
    if (!this.#active(generation))
      return { state: 'UNAVAILABLE', reason: 'revision_unavailable' };
    return {
      schemaVersion: REVISION_EVIDENCE_SCHEMA_VERSION,
      revisions: clone(
        [...this.#revisions.values()].sort((left, right) =>
          compareWorkingStateIds(left.revisionId, right.revisionId),
        ),
      ),
    };
  }

  importPortable(input: unknown): ImportOutcome {
    const generation = this.#lifecycleGeneration;
    if (
      !this.#active(generation) ||
      (this.#persistence && !this.#restoreForWrite(generation))
    )
      return this.#importResult({
        outcome: 'rejected',
        reason: 'persistence_unavailable',
      });
    if (!this.#attribution)
      return this.#importResult({
        outcome: 'rejected',
        reason: 'attribution_unverified',
      });
    if (
      !isRecord(input) ||
      input.schemaVersion !== REVISION_EVIDENCE_SCHEMA_VERSION ||
      !Array.isArray(input.revisions)
    )
      return this.#importResult({ outcome: 'rejected', reason: 'malformed' });
    if (input.revisions.length > this.#bounds.maxImportEntries)
      return this.#importResult({
        outcome: 'rejected',
        reason: 'capacity_exceeded',
      });
    const inputBytes = boundedPortableJsonBytes(
      input,
      this.#bounds.maxImportBytes,
    );
    if (inputBytes === null)
      return this.#importResult({ outcome: 'rejected', reason: 'malformed' });
    if (inputBytes > this.#bounds.maxImportBytes)
      return this.#importResult({
        outcome: 'rejected',
        reason: 'capacity_exceeded',
      });
    const incoming = new Map<EvidenceRevisionId, CommittedRevision>();
    for (const value of input.revisions) {
      const parsed = parseExportRecord(value, this.#bounds);
      if ('reason' in parsed)
        return this.#importResult({
          outcome: 'rejected',
          reason: parsed.reason,
        });
      if (!this.#verifyAttribution(parsed.record, generation)) {
        if (!this.#active(generation))
          return this.#importResult({
            outcome: 'rejected',
            reason: 'persistence_unavailable',
          });
        return this.#importResult({
          outcome: 'rejected',
          reason: 'attribution_unverified',
        });
      }
      const duplicate =
        incoming.get(parsed.record.revisionId) ??
        this.#revisions.get(parsed.record.revisionId);
      if (duplicate && !sameReceiptIdentity(duplicate, parsed.record))
        return this.#importResult({
          outcome: 'rejected',
          reason: 'identity_collision',
        });
      incoming.set(parsed.record.revisionId, parsed.record);
    }
    const newCount = [...incoming.keys()].filter(
      (id) => !this.#revisions.has(id),
    ).length;
    if (newCount > this.#bounds.maxRevisions - this.#revisions.size)
      return this.#importResult({
        outcome: 'rejected',
        reason: 'capacity_exceeded',
      });
    const staged = new Map(this.#revisions);
    const remaining = new Map(incoming);
    while (remaining.size > 0) {
      const ready = [...remaining.values()]
        .filter((record) =>
          record.parents.every((parent) => staged.has(parent)),
        )
        .sort((left, right) =>
          compareWorkingStateIds(left.revisionId, right.revisionId),
        );
      if (ready.length === 0)
        return this.#importResult({
          outcome: 'rejected',
          reason: 'missing_parent',
        });
      for (const record of ready) {
        if (
          record.parents.some(
            (parent) => !sameScope(staged.get(parent)!.scope, record.scope),
          )
        )
          return this.#importResult({
            outcome: 'rejected',
            reason: 'wrong_scope',
          });
        staged.set(record.revisionId, clone(record));
        remaining.delete(record.revisionId);
      }
    }
    let persistedCount: number | undefined;
    if (this.#persistence) {
      const intended = [...incoming.values()];
      const persisted = this.#persistDurable(intended, generation);
      if (persisted.outcome === 'rejected')
        return this.#importResult({
          outcome: 'rejected',
          reason: persisted.reason,
        });
      if (
        persisted.outcome === 'unavailable' ||
        persisted.outcome === 'corrupt' ||
        !this.#admitPersisted(intended, persisted.records, generation)
      )
        return this.#importResult({
          outcome: 'rejected',
          reason: 'persistence_unavailable',
        });
      for (const record of incoming.values()) {
        const durable = this.#revisions.get(record.revisionId);
        if (!durable || !sameReceiptIdentity(durable, record)) {
          return this.#importResult({
            outcome: 'rejected',
            reason: durable ? 'identity_collision' : 'persistence_unavailable',
          });
        }
      }
      persistedCount = persisted.inserted;
    } else {
      if (!this.#active(generation))
        return this.#importResult({
          outcome: 'rejected',
          reason: 'persistence_unavailable',
        });
      for (const [id, record] of staged) this.#revisions.set(id, record);
    }
    if (!this.#active(generation)) {
      this.#revisions.clear();
      return this.#importResult({
        outcome: 'rejected',
        reason: 'persistence_unavailable',
      });
    }
    return this.#importResult(
      this.#persistence
        ? persistedCount === 0
          ? { outcome: 'duplicate', revisions: 0 }
          : { outcome: 'imported', revisions: persistedCount! }
        : newCount === 0
          ? { outcome: 'duplicate', revisions: 0 }
          : { outcome: 'imported', revisions: newCount },
    );
  }

  #isAncestor(
    ancestor: EvidenceRevisionId,
    descendant: EvidenceRevisionId,
  ): boolean {
    const pending = [descendant];
    const visited = new Set<EvidenceRevisionId>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const revision = this.#revisions.get(current);
      if (!revision) continue;
      for (const parent of revision.parents) {
        if (parent === ancestor) return true;
        pending.push(parent);
      }
    }
    return false;
  }

  #restorePersisted(generation = this.#lifecycleGeneration): boolean {
    if (!this.#persistence) return this.#active(generation);
    if (!this.#active(generation)) return false;
    this.#restoreWitness = undefined;
    let restored: ReturnType<RevisionEvidencePersistence['restore']>;
    try {
      restored = this.#persistence.restore(this.#persistenceBounds());
    } catch {
      this.#lastRestoreOutcome = 'unavailable';
      revisionEvidenceOutcomes.add(1, {
        operation: 'restore',
        outcome: 'unavailable',
      });
      return false;
    }
    if (!this.#active(generation)) return false;
    if (restored.outcome !== 'available') {
      this.#lastRestoreOutcome = restored.outcome;
      revisionEvidenceOutcomes.add(1, {
        operation: 'restore',
        outcome: restored.outcome,
      });
      return false;
    }
    if (!/^revision-evidence-ledger-v1:[0-9a-f]{64}$/.test(restored.witness)) {
      this.#lastRestoreOutcome = 'corrupt';
      return false;
    }
    // Reuse the portable recovery validator in a persistence-free instance.
    // It proves schema, identity/digests, settled state, topology, bounds and
    // attribution without exposing the backing store to this Module's callers.
    const validated = new RevisionEvidenceModule({
      maxRevisions: this.#bounds.maxRevisions,
      maxImportEntries: this.#bounds.maxImportEntries,
      maxImportBytes: this.#bounds.maxImportBytes,
      maxSnapshotBytes: this.#bounds.maxSnapshotBytes,
      maxTextBytes: this.#bounds.maxTextBytes,
      maxRecordBytes: this.#bounds.maxRecordBytes,
      attribution: this.#attribution,
      proposedChanges: this.#proposedChanges,
    });
    const imported = validated.importPortable({
      schemaVersion: REVISION_EVIDENCE_SCHEMA_VERSION,
      revisions: restored.revisions,
    });
    if (!this.#active(generation)) return false;
    if (imported.outcome === 'rejected') {
      this.#lastRestoreOutcome = 'corrupt';
      revisionEvidenceOutcomes.add(1, {
        operation: 'restore',
        outcome: 'corrupt',
      });
      return false;
    }
    const exported = validated.exportPortable();
    if (!this.#active(generation)) return false;
    if ('state' in exported) {
      this.#lastRestoreOutcome = 'corrupt';
      return false;
    }
    if (!this.#active(generation)) return false;
    this.#revisions.clear();
    for (const revision of exported.revisions)
      this.#revisions.set(revision.revisionId, revision);
    if (!this.#active(generation)) {
      this.#revisions.clear();
      return false;
    }
    this.#restoreWitness = restored.witness;
    this.#lastRestoreOutcome = 'available';
    revisionEvidenceOutcomes.add(1, {
      operation: 'restore',
      outcome: 'available',
    });
    return true;
  }

  #persistenceBounds(): RevisionEvidencePersistenceBounds {
    return {
      // A durable ledger must be admissible by the same bounded restore path.
      maxRevisions: Math.min(
        this.#bounds.maxRevisions,
        this.#bounds.maxImportEntries,
      ),
      maxPortableBytes: this.#bounds.maxImportBytes,
      maxRecordBytes: this.#bounds.maxRecordBytes,
    };
  }

  #persistDurable(
    records: readonly CommittedRevision[],
    generation: number,
  ): ReturnType<RevisionEvidencePersistence['persist']> {
    if (!this.#persistence || !this.#active(generation))
      return { outcome: 'unavailable' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0 && !this.#restoreForWrite(generation)) {
        return this.#lastRestoreOutcome === 'corrupt' ||
          this.#lastRestoreOutcome === 'capacity'
          ? { outcome: 'corrupt' }
          : { outcome: 'unavailable' };
      }
      const expectedWitness = this.#restoreWitness;
      if (!expectedWitness) return { outcome: 'corrupt' };
      let persisted: ReturnType<RevisionEvidencePersistence['persist']>;
      try {
        persisted = this.#persistence.persist({
          records: records.map(clone),
          bounds: this.#persistenceBounds(),
          expectedWitness,
        });
      } catch {
        persisted = { outcome: 'unavailable' };
      }
      if (!this.#active(generation)) return { outcome: 'unavailable' };
      this.#observePersist(
        persisted.outcome === 'unavailable' ? 'unavailable' : persisted.outcome,
      );
      if (persisted.outcome === 'unavailable' && attempt === 0) continue;
      if (
        (persisted.outcome === 'committed' && persisted.inserted < 1) ||
        (persisted.outcome === 'duplicate' && persisted.inserted !== 0) ||
        ((persisted.outcome === 'committed' ||
          persisted.outcome === 'duplicate') &&
          (!Number.isSafeInteger(persisted.inserted) ||
            persisted.inserted < 0 ||
            persisted.inserted > records.length))
      )
        return { outcome: 'corrupt' };
      return persisted;
    }
    return { outcome: 'unavailable' };
  }

  #restoreForWrite(generation = this.#lifecycleGeneration): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.#active(generation)) return false;
      if (this.#restorePersisted(generation)) return this.#active(generation);
      if (this.#lastRestoreOutcome !== 'unavailable') return false;
    }
    return false;
  }

  #admitPersisted(
    intended: readonly CommittedRevision[],
    persisted: readonly unknown[],
    generation: number,
  ): boolean {
    if (!this.#active(generation)) return false;
    if (persisted.length !== intended.length) return false;
    const intendedById = new Map(
      intended.map((record) => [record.revisionId, record]),
    );
    const admitted = new Map<EvidenceRevisionId, CommittedRevision>();
    for (const value of persisted) {
      const parsed = parseExportRecord(value, this.#bounds);
      if (
        'reason' in parsed ||
        !this.#verifyAttribution(parsed.record, generation)
      )
        return false;
      const expected = intendedById.get(parsed.record.revisionId);
      if (!expected || !sameReceiptIdentity(expected, parsed.record))
        return false;
      admitted.set(parsed.record.revisionId, parsed.record);
    }
    if (admitted.size !== intendedById.size) return false;
    if (!this.#active(generation)) return false;
    for (const [id, record] of admitted) this.#revisions.set(id, clone(record));
    if (!this.#active(generation)) {
      for (const id of admitted.keys()) this.#revisions.delete(id);
      return false;
    }
    return true;
  }

  #verifyAttribution(
    record: CommittedRevision,
    generation = this.#lifecycleGeneration,
  ): boolean {
    if (!this.#attribution || !this.#active(generation)) return false;
    try {
      const result = this.#attribution.verify({
        ...attributionBinding(record),
        attestation: record.attributionAttestation,
      });
      if (!this.#active(generation)) return false;
      return result.outcome === 'verified';
    } catch {
      return false;
    }
  }

  #resolve(
    reference: unknown,
    operation: 'evidence' | 'gate_input',
  ): RevisionReferenceResolution {
    const generation = this.#lifecycleGeneration;
    if (
      !isRecord(reference) ||
      !validEvidenceRevisionId(reference.revisionId) ||
      (reference.verification !== 'verified' &&
        reference.verification !== 'unverified')
    )
      return this.#resolutionResult(operation, {
        state: 'UNVERIFIED',
        reason: 'malformed_reference',
      });
    if (reference.verification === 'unverified')
      return this.#resolutionResult(operation, {
        state: 'UNVERIFIED',
        reason: 'unverified_reference',
        revisionId: reference.revisionId,
      });
    if (
      !this.#active(generation) ||
      (this.#persistence && !this.#restorePersisted(generation))
    )
      return this.#resolutionResult(operation, {
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
        revisionId: reference.revisionId,
      });
    const revision = this.#revisions.get(reference.revisionId);
    if (!this.#active(generation))
      return this.#resolutionResult(operation, {
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
        revisionId: reference.revisionId,
      });
    return this.#resolutionResult(
      operation,
      revision
        ? { state: 'AVAILABLE', revision: clone(revision) }
        : {
            state: 'UNAVAILABLE',
            reason: 'revision_missing',
            revisionId: reference.revisionId,
          },
    );
  }

  #resolveLink(input: unknown): RevisionEvidenceLinkResolution {
    const generation = this.#lifecycleGeneration;
    if (
      !isRecord(input) ||
      !validEvidenceRevisionId(input.revisionId) ||
      !canonicalScope(input.scope)
    )
      return { state: 'UNVERIFIED', reason: 'malformed_reference' };
    if (
      !this.#active(generation) ||
      (this.#persistence && !this.#restorePersisted(generation))
    )
      return {
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
        revisionId: input.revisionId,
      };
    const revision = this.#revisions.get(input.revisionId);
    if (!this.#active(generation))
      return {
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
        revisionId: input.revisionId,
      };
    if (!revision)
      return {
        state: 'UNAVAILABLE',
        reason: 'revision_missing',
        revisionId: input.revisionId,
      };
    const scope = canonicalScope(input.scope)!;
    if (!sameScope(scope, revision.scope))
      return {
        state: 'UNAVAILABLE',
        reason: 'wrong_scope',
        revisionId: input.revisionId,
      };
    if (!this.#active(generation))
      return {
        state: 'UNAVAILABLE',
        reason: 'revision_unavailable',
        revisionId: input.revisionId,
      };
    return {
      state: 'AVAILABLE',
      revision: clone({
        revisionId: revision.revisionId,
        scope: revision.scope,
        text: revision.text,
        parents: revision.parents,
        actor: revision.actor,
        correlation: revision.correlation,
      }),
    };
  }

  #freezeResult(result: FreezeOutcome): FreezeOutcome {
    revisionEvidenceOutcomes.add(1, {
      operation: 'freeze',
      outcome: result.outcome === 'rejected' ? result.reason : result.outcome,
    });
    return result;
  }

  #observePersist(outcome: string): void {
    revisionEvidenceOutcomes.add(1, {
      operation: 'persist',
      outcome,
    });
  }

  #importResult(result: ImportOutcome): ImportOutcome {
    revisionEvidenceOutcomes.add(1, {
      operation: 'import',
      outcome: result.outcome === 'rejected' ? result.reason : result.outcome,
    });
    return result;
  }

  #resolutionResult(
    operation: 'evidence' | 'gate_input',
    result: RevisionReferenceResolution,
  ): RevisionReferenceResolution {
    revisionEvidenceOutcomes.add(1, {
      operation: `resolve_${operation}`,
      outcome: result.state.toLowerCase(),
    });
    return result;
  }

  #proposedResult(
    result: ProposedChangeRevisionResolution,
  ): ProposedChangeRevisionResolution {
    revisionEvidenceOutcomes.add(1, {
      operation: 'proposed_change',
      outcome: result.state.toLowerCase(),
    });
    return result;
  }
}
