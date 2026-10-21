/**
 * station#3413 part B: a work claim as Station's routes answer it. A Session
 * says what it is on (a work item, paths, a note) so peers in its Project
 * don't duplicate it. A claim is information, not a lock.
 *
 * `GET /api/orchestration/work-claims` answers a person with the active claims
 * (unreleased, unexpired, claimant Session not ended) of the Sessions they may
 * read; the claim tools answer with the claim they made or changed.
 */

/** The Project a claim belongs to, or the global space. */
export type WorkClaimScope =
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'global' };

export interface WorkClaimView {
  readonly claimId: string;
  /** The Session that claimed. */
  readonly sessionId: string;
  /** Its conversation, when it has one; a later Session of it keeps the claim. */
  readonly conversationId?: string;
  readonly scope: WorkClaimScope;
  /** The Task the claimant Session was dispatched for, when it was. */
  readonly taskId?: string;
  readonly workItemRef?: string;
  readonly paths?: readonly string[];
  readonly note?: string;
  readonly claimedAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
  readonly releaseNote?: string;
}

const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** One claim from an untrusted body, or `undefined` when it is not one. */
export function parseWorkClaimView(value: unknown): WorkClaimView | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const scope = record.scope as Record<string, unknown> | undefined;
  const parsedScope: WorkClaimScope | undefined =
    scope?.kind === 'global'
      ? { kind: 'global' }
      : scope?.kind === 'project' && isString(scope.id)
        ? { kind: 'project', id: scope.id }
        : undefined;
  if (
    !isString(record.claimId) ||
    !isString(record.sessionId) ||
    !parsedScope ||
    !isString(record.claimedAt) ||
    !isString(record.renewedAt) ||
    !isString(record.expiresAt)
  )
    return undefined;
  const paths = Array.isArray(record.paths)
    ? record.paths.filter(isString)
    : [];
  return {
    claimId: record.claimId,
    sessionId: record.sessionId,
    ...(isString(record.conversationId)
      ? { conversationId: record.conversationId }
      : {}),
    scope: parsedScope,
    ...(isString(record.taskId) ? { taskId: record.taskId } : {}),
    ...(isString(record.workItemRef)
      ? { workItemRef: record.workItemRef }
      : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(isString(record.note) ? { note: record.note } : {}),
    claimedAt: record.claimedAt,
    renewedAt: record.renewedAt,
    expiresAt: record.expiresAt,
    ...(isString(record.releasedAt) ? { releasedAt: record.releasedAt } : {}),
    ...(isString(record.releaseNote)
      ? { releaseNote: record.releaseNote }
      : {}),
  };
}

/**
 * What a claim is on, in a few words: its work item, else its first path's
 * last segment and how many more paths (`work-claims.ts +1`), so the count
 * survives a narrow row.
 */
export function workClaimSubjectLabel(
  claim: Pick<WorkClaimView, 'workItemRef' | 'paths'>,
): string {
  if (claim.workItemRef) return claim.workItemRef;
  const [first, ...rest] = claim.paths ?? [];
  if (!first) return '';
  const trimmed = first.replace(/\/+$/u, '');
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1) || first;
  return rest.length > 0 ? `${name} +${rest.length}` : name;
}

/** Everything a claim is on, in full: its work item and every path. */
export function workClaimSubjectDetail(
  claim: Pick<WorkClaimView, 'workItemRef' | 'paths'>,
): string {
  return [
    ...(claim.workItemRef ? [claim.workItemRef] : []),
    ...(claim.paths ?? []),
  ].join(', ');
}
