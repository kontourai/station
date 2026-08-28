/**
 * Closed server-only work-item projection before a canonical terminal event
 * exists. It intentionally excludes the durable event/time fields.
 */
import {
  SESSION_WORK_ITEM_ASSOCIATION_V1,
  SESSION_WORK_ITEM_MAX_ASSOCIATION_ID_BYTES,
  SESSION_WORK_ITEM_MAX_ID_BYTES,
  SESSION_WORK_ITEM_MAX_REPOSITORY_PART_BYTES,
  type SessionWorkItemAssociation,
} from '@kontourai/station-contracts/session-work-item';

const candidateBrand = Symbol('session-work-item-candidate');
const issuedCandidates = new WeakSet<object>();

/** Structural facts validated before the projector issues a runtime capability. */
export type SessionWorkItemCandidateFields = Omit<
  SessionWorkItemAssociation,
  'eventId' | 'observedAt'
>;

/**
 * Server-only pre-terminal capability. It is not structural: the reviewed
 * result projector is the only issuer, and staging checks its exact identity.
 */
export type SessionWorkItemCandidate = Readonly<
  SessionWorkItemCandidateFields & {
    readonly [candidateBrand]: true;
  }
>;

const encoder = new TextEncoder();
const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const githubRepository = /^[A-Za-z0-9._-]{1,100}$/;
const nativeId = /^[1-9]\d*$/;

function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function bounded(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= maxBytes
  );
}

/**
 * Validates every candidate-owned field without fabricating event/time facts.
 * The published association parser remains the final authority once a caller
 * has canonical terminal metadata to construct the complete closed record.
 */
export function parseSessionWorkItemCandidate(
  value: unknown,
): SessionWorkItemCandidateFields | null {
  try {
    if (!plain(value)) return null;
    const keys = Object.keys(value);
    const required = [
      'version',
      'associationId',
      'sessionId',
      'conversationId',
      'turnId',
      'toolCallId',
      'relation',
      'provider',
      'workItemRef',
      'repository',
      'nativeId',
    ];
    if (
      keys.length !== required.length ||
      !required.every((key) => Object.hasOwn(value, key)) ||
      !required.every((key) => keys.includes(key)) ||
      value.version !== SESSION_WORK_ITEM_ASSOCIATION_V1 ||
      !bounded(
        value.associationId,
        SESSION_WORK_ITEM_MAX_ASSOCIATION_ID_BYTES,
      ) ||
      !bounded(value.sessionId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !bounded(value.conversationId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !bounded(value.turnId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !bounded(value.toolCallId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      value.relation !== 'created' ||
      !plain(value.provider) ||
      Object.keys(value.provider).length !== 2 ||
      value.provider.id !== 'github' ||
      value.provider.host !== 'github.com' ||
      !plain(value.repository) ||
      Object.keys(value.repository).length !== 2 ||
      !bounded(
        value.repository.owner,
        SESSION_WORK_ITEM_MAX_REPOSITORY_PART_BYTES,
      ) ||
      !bounded(
        value.repository.name,
        SESSION_WORK_ITEM_MAX_REPOSITORY_PART_BYTES,
      ) ||
      !githubOwner.test(value.repository.owner) ||
      !githubRepository.test(value.repository.name) ||
      value.repository.name === '.' ||
      value.repository.name === '..' ||
      !bounded(value.nativeId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !nativeId.test(value.nativeId) ||
      !bounded(value.workItemRef, SESSION_WORK_ITEM_MAX_ID_BYTES)
    )
      return null;
    const repository = {
      owner: value.repository.owner.toLowerCase(),
      name: value.repository.name.toLowerCase(),
    };
    const match = /^github:([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(
      value.workItemRef,
    );
    if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
    const workItemRef = `github:${repository.owner}/${repository.name}#${match[3]}`;
    if (value.workItemRef.toLowerCase() !== workItemRef) return null;
    return {
      version: SESSION_WORK_ITEM_ASSOCIATION_V1,
      associationId: value.associationId,
      sessionId: value.sessionId,
      conversationId: value.conversationId,
      turnId: value.turnId,
      toolCallId: value.toolCallId,
      relation: 'created',
      provider: { id: 'github', host: 'github.com' },
      workItemRef: workItemRef as SessionWorkItemAssociation['workItemRef'],
      repository,
      nativeId: value.nativeId,
    };
  } catch {
    return null;
  }
}

/** Internal projector bridge; no route or EventStore caller receives an issuer. */
export function issueSessionWorkItemCandidateFromProjector(
  value: unknown,
): SessionWorkItemCandidate | null {
  const parsed = parseSessionWorkItemCandidate(value);
  if (!parsed) return null;
  const issued = { ...parsed } as SessionWorkItemCandidate;
  Object.defineProperty(issued, candidateBrand, {
    value: true,
    enumerable: false,
  });
  Object.freeze(issued);
  issuedCandidates.add(issued);
  return issued;
}

/** Admission boundary: parseable lookalikes are not runtime-issued candidates. */
export function isIssuedSessionWorkItemCandidate(
  value: unknown,
): value is SessionWorkItemCandidate {
  return !!value && typeof value === 'object' && issuedCandidates.has(value);
}
