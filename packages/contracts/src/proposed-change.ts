export type ProposedChangeStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'superseded';

export type ProposedChangeDecisionStatus = Exclude<
  ProposedChangeStatus,
  'pending'
>;

export type ProposedChangeType = 'create' | 'modify' | 'delete' | 'rename';

export type ProposedChangeContentKind =
  | 'code'
  | 'markdown'
  | 'text'
  | 'json'
  | 'unknown';

export type ProposedChangeActorType = 'human' | 'agent' | 'system';

export interface ProposedChangeSnapshot {
  content: string | null;
  hash?: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface ProposedChangeDecision {
  id: string;
  changeId: string;
  decision: ProposedChangeDecisionStatus;
  reason?: string;
  actorId?: string;
  actorType: ProposedChangeActorType;
  decidedAt: string;
  bulkDecisionId?: string;
}

export interface ProposedChange {
  id: string;
  sessionId: string;
  projectId: string;
  path: string;
  changeType: ProposedChangeType;
  contentKind: ProposedChangeContentKind;
  baseSnapshot: ProposedChangeSnapshot | null;
  proposedSnapshot: ProposedChangeSnapshot | null;
  createdAt: string;
  updatedAt: string;
  sourceRuntime: string;
  status: ProposedChangeStatus;
  decisions: ProposedChangeDecision[];
  supersededById?: string;
  metadata?: Record<string, unknown>;
}

export interface ProposedChangeCreateInput {
  id?: string;
  sessionId: string;
  projectId: string;
  path: string;
  changeType: ProposedChangeType;
  contentKind: ProposedChangeContentKind;
  baseSnapshot?: ProposedChangeSnapshot | null;
  proposedSnapshot?: ProposedChangeSnapshot | null;
  sourceRuntime: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ProposedChangeDecisionInput {
  reason?: string;
  actorId?: string;
  actorType?: ProposedChangeActorType;
}

export interface ProposedChangeBulkDecisionInput
  extends ProposedChangeDecisionInput {
  ids: string[];
}

export interface ProposedChangeFilters {
  status?: ProposedChangeStatus[];
  sessionId?: string;
  projectId?: string;
}

export interface ProposedChangeValidationResult {
  valid: boolean;
  errors: string[];
}

const STATUSES: ProposedChangeStatus[] = [
  'pending',
  'approved',
  'rejected',
  'superseded',
];
const DECISIONS: ProposedChangeDecisionStatus[] = [
  'approved',
  'rejected',
  'superseded',
];
const CHANGE_TYPES: ProposedChangeType[] = [
  'create',
  'modify',
  'delete',
  'rename',
];
const CONTENT_KINDS: ProposedChangeContentKind[] = [
  'code',
  'markdown',
  'text',
  'json',
  'unknown',
];
const ACTOR_TYPES: ProposedChangeActorType[] = ['human', 'agent', 'system'];

export function isProposedChangeStatus(
  value: string,
): value is ProposedChangeStatus {
  return STATUSES.includes(value as ProposedChangeStatus);
}

export function isProposedChangeDecisionStatus(
  value: string,
): value is ProposedChangeDecisionStatus {
  return DECISIONS.includes(value as ProposedChangeDecisionStatus);
}

export function canTransitionProposedChangeStatus(
  from: ProposedChangeStatus,
  to: ProposedChangeStatus,
): boolean {
  if (from === to) return true;
  if (from !== 'pending') return false;
  return to === 'approved' || to === 'rejected' || to === 'superseded';
}

export function validateProposedChange(
  change: ProposedChange,
): ProposedChangeValidationResult {
  const errors: string[] = [];

  requireNonEmpty(change.id, 'id', errors);
  requireNonEmpty(change.sessionId, 'sessionId', errors);
  requireNonEmpty(change.projectId, 'projectId', errors);
  requireNonEmpty(change.path, 'path', errors);
  requireNonEmpty(change.sourceRuntime, 'sourceRuntime', errors);
  requireIsoDate(change.createdAt, 'createdAt', errors);
  requireIsoDate(change.updatedAt, 'updatedAt', errors);

  if (!CHANGE_TYPES.includes(change.changeType)) {
    errors.push('changeType is invalid');
  }
  if (!CONTENT_KINDS.includes(change.contentKind)) {
    errors.push('contentKind is invalid');
  }
  if (!STATUSES.includes(change.status)) {
    errors.push('status is invalid');
  }
  validateSnapshot(change.baseSnapshot, 'baseSnapshot', errors);
  validateSnapshot(change.proposedSnapshot, 'proposedSnapshot', errors);

  if (!Array.isArray(change.decisions)) {
    errors.push('decisions must be an array');
  } else {
    for (const decision of change.decisions) {
      validateDecision(decision, change.id, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateDecision(
  decision: ProposedChangeDecision,
  changeId: string,
  errors: string[],
): void {
  requireNonEmpty(decision.id, 'decision.id', errors);
  requireNonEmpty(decision.changeId, 'decision.changeId', errors);
  requireIsoDate(decision.decidedAt, 'decision.decidedAt', errors);
  if (decision.changeId !== changeId) {
    errors.push('decision.changeId must match proposed change id');
  }
  if (!DECISIONS.includes(decision.decision)) {
    errors.push('decision.decision is invalid');
  }
  if (!ACTOR_TYPES.includes(decision.actorType)) {
    errors.push('decision.actorType is invalid');
  }
}

function validateSnapshot(
  snapshot: ProposedChangeSnapshot | null,
  field: string,
  errors: string[],
): void {
  if (snapshot === null) return;
  if (typeof snapshot !== 'object') {
    errors.push(`${field} must be an object or null`);
    return;
  }
  if (typeof snapshot.content !== 'string' && snapshot.content !== null) {
    errors.push(`${field}.content must be a string or null`);
  }
}

function requireNonEmpty(
  value: string | undefined,
  field: string,
  errors: string[],
): void {
  if (!value || value.trim().length === 0) {
    errors.push(`${field} is required`);
  }
}

function requireIsoDate(
  value: string | undefined,
  field: string,
  errors: string[],
): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    errors.push(`${field} must be a valid ISO date`);
  }
}
