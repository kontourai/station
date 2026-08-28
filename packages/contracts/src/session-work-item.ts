/** Immutable identity-grade work-item observations made during a Session. */
export const SESSION_WORK_ITEM_ASSOCIATION_V1 =
  'station.session-work-item/v1' as const;

export const SESSION_WORK_ITEM_MAX_ID_BYTES = 512;
export const SESSION_WORK_ITEM_MAX_ASSOCIATION_ID_BYTES = 256;
export const SESSION_WORK_ITEM_MAX_REPOSITORY_PART_BYTES = 100;

export type GithubWorkItemRepository = { owner: string; name: string };

export type SessionWorkItemAssociation = {
  version: typeof SESSION_WORK_ITEM_ASSOCIATION_V1;
  associationId: string;
  sessionId: string;
  conversationId: string;
  eventId: string;
  turnId: string;
  toolCallId: string;
  relation: 'created';
  provider: { id: 'github'; host: 'github.com' };
  workItemRef: `github:${string}/${string}#${number}`;
  repository: GithubWorkItemRepository;
  /** Provider-native immutable database/fullDatabase identity, never a result/body payload. */
  nativeId: string;
  observedAt: string;
};

export type SessionWorkItemPresentation = {
  sessionId: string;
  /** Session lineage stays explicit at the deduplicated read seam. */
  conversationId: string;
  workItemRef: SessionWorkItemAssociation['workItemRef'];
  provider: SessionWorkItemAssociation['provider'];
  repository: GithubWorkItemRepository;
  nativeId: string;
  associationIds: readonly string[];
  observedAt: string;
};

export type SessionWorkItemReadProjection = {
  version: typeof SESSION_WORK_ITEM_ASSOCIATION_V1;
  observations: readonly SessionWorkItemAssociation[];
  items: readonly SessionWorkItemPresentation[];
};

const encoder = new TextEncoder();
const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const githubRepository = /^[A-Za-z0-9._-]{1,100}$/;

function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= maxBytes
  );
}

function validRepository(value: unknown): value is GithubWorkItemRepository {
  return (
    plain(value) &&
    Object.keys(value).length === 2 &&
    boundedText(value.owner, SESSION_WORK_ITEM_MAX_REPOSITORY_PART_BYTES) &&
    boundedText(value.name, SESSION_WORK_ITEM_MAX_REPOSITORY_PART_BYTES) &&
    githubOwner.test(value.owner) &&
    githubRepository.test(value.name) &&
    value.name !== '.' &&
    value.name !== '..'
  );
}

function nativeId(value: unknown): value is string {
  return (
    boundedText(value, SESSION_WORK_ITEM_MAX_ID_BYTES) &&
    /^[1-9]\d*$/.test(value)
  );
}

function timestamp(value: unknown): value is string {
  return (
    boundedText(value, 128) &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * Fail-closed closed-contract parser. It copies each admitted fact so a
 * hostile Proxy/getter cannot remain in a durable association after parsing.
 */
export function parseSessionWorkItemAssociation(
  value: unknown,
): SessionWorkItemAssociation | null {
  try {
    if (!plain(value)) return null;
    const keys = Object.keys(value);
    const required = [
      'version',
      'associationId',
      'sessionId',
      'conversationId',
      'eventId',
      'turnId',
      'toolCallId',
      'relation',
      'provider',
      'workItemRef',
      'repository',
      'nativeId',
      'observedAt',
    ];
    if (
      keys.length !== required.length ||
      !required.every((key) => keys.includes(key)) ||
      value.version !== SESSION_WORK_ITEM_ASSOCIATION_V1 ||
      !boundedText(
        value.associationId,
        SESSION_WORK_ITEM_MAX_ASSOCIATION_ID_BYTES,
      ) ||
      !boundedText(value.sessionId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !boundedText(value.conversationId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !boundedText(value.eventId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !boundedText(value.turnId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      !boundedText(value.toolCallId, SESSION_WORK_ITEM_MAX_ID_BYTES) ||
      value.relation !== 'created' ||
      !plain(value.provider) ||
      Object.keys(value.provider).length !== 2 ||
      value.provider.id !== 'github' ||
      value.provider.host !== 'github.com' ||
      !validRepository(value.repository) ||
      !nativeId(value.nativeId) ||
      !timestamp(value.observedAt) ||
      typeof value.workItemRef !== 'string'
    )
      return null;
    const match = /^github:([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(
      value.workItemRef,
    );
    if (!match) return null;
    const issueNumber = Number(match[3]);
    if (!Number.isSafeInteger(issueNumber)) return null;
    const repository = {
      owner: value.repository.owner.toLowerCase(),
      name: value.repository.name.toLowerCase(),
    };
    const workItemRef = `github:${repository.owner}/${repository.name}#${issueNumber}`;
    if (value.workItemRef.toLowerCase() !== workItemRef) return null;
    return {
      version: SESSION_WORK_ITEM_ASSOCIATION_V1,
      associationId: value.associationId,
      sessionId: value.sessionId,
      conversationId: value.conversationId,
      eventId: value.eventId,
      turnId: value.turnId,
      toolCallId: value.toolCallId,
      relation: 'created',
      provider: { id: 'github', host: 'github.com' },
      workItemRef: workItemRef as SessionWorkItemAssociation['workItemRef'],
      repository,
      nativeId: value.nativeId,
      observedAt: value.observedAt,
    };
  } catch {
    return null;
  }
}
