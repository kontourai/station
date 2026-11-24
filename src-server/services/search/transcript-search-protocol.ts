/** Owner-private wire facts, never SessionReadAuthority or executable policy. */
import { types } from 'node:util';
import {
  parseWorkerRefusal,
  type SearchReadRefusal,
} from './search-read-refusal.js';
import { boundedTaskText } from './task-search-protocol.js';

export const MAX_SCOPED_TRANSCRIPT_THREADS = 64;
export const MAX_SCOPED_TRANSCRIPT_REQUEST_BYTES = 100 * 1024;

export interface TranscriptSearchSnapshot {
  owner: string;
  version: number;
}

export type TranscriptReadRequest =
  | {
      type: 'message-page';
      id: number;
      threadId: string;
      matchedEventId: string;
      ownerUserId: string;
      ownerUserIds?: readonly string[];
      tenantId?: string;
      continuation?: string;
    }
  | {
      type: 'message-search';
      id: number;
      query: string;
      ownerUserId: string;
      ownerUserIds?: readonly string[];
      tenantId?: string;
      projectId?: string;
      threadIds?: readonly string[];
      snapshot?: TranscriptSearchSnapshot;
      limit: number;
    }
  | {
      type: 'message-open';
      id: number;
      threadId: string;
      matchedEventId: string;
      ownerUserId: string;
      ownerUserIds?: readonly string[];
      tenantId?: string;
    }
  | {
      type: 'session-open';
      id: number;
      threadId: string;
      ownerUserId: string;
      ownerUserIds?: readonly string[];
      tenantId?: string;
    }
  | { type: 'session-owner'; id: number; threadId: string }
  | { type: 'search-snapshot'; id: number };
export interface TranscriptSearchMatch {
  conversationId: string;
  messageId: string;
  /** Index row identity, distinct from the potentially shared navigation anchor. */
  matchedEventId: string;
  role: 'user' | 'assistant';
  excerpt: string;
  projectSlug?: string;
  agentSlug?: string;
  engine?: string;
}
export interface TranscriptMessageOpenFact {
  conversationId: string;
  matchedEventId: string;
  messageId: string;
  projectSlug?: string;
}
export interface TranscriptSessionOpenFact {
  conversationId: string;
  projectSlug?: string;
}
export interface TranscriptMessagePageFact {
  sessionId: string;
  matchedEventId: string;
  role: 'user' | 'assistant';
  text: string;
  contentRevision: string;
  offset: number;
  nextContinuation?: string;
  projectId?: string;
  agentSlug?: string;
}
export type TranscriptReadResult =
  | { state: 'available'; page: TranscriptMessagePageFact | null }
  | { state: 'available'; rows: TranscriptSearchMatch[] }
  | { state: 'available'; snapshot: TranscriptSearchSnapshot }
  | { state: 'available'; owner: string | null }
  | { state: 'available'; target: TranscriptMessageOpenFact | null }
  | { state: 'available'; session: TranscriptSessionOpenFact | null }
  /** `cause` is log-only (#2460) and never reaches a search response. */
  | { state: 'unavailable'; cause?: SearchReadRefusal };

function exact(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return null;
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return null;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return null;
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in field)) return null;
    result[key] = field.value;
  }
  return required.every((key) => Object.hasOwn(result, key)) ? result : null;
}
function parseSnapshot(input: unknown): TranscriptSearchSnapshot | null {
  const snapshot = exact(input, ['owner', 'version'], ['owner', 'version']);
  if (
    !snapshot ||
    !boundedTaskText(snapshot.owner, 64) ||
    typeof snapshot.version !== 'number' ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 0
  )
    return null;
  return { owner: snapshot.owner, version: snapshot.version };
}

export function transcriptMessageRequest(
  input: unknown,
  id: number,
): TranscriptReadRequest | null {
  const fields = exact(
    input,
    [
      'query',
      'ownerUserId',
      'ownerUserIds',
      'tenantId',
      'projectId',
      'threadIds',
      'snapshot',
      'limit',
    ],
    ['query', 'ownerUserId', 'limit'],
  );
  return fields
    ? parseTranscriptReadRequest({ ...fields, type: 'message-search', id })
    : null;
}

export function transcriptMessageOpenRequest(
  input: unknown,
  id: number,
): TranscriptReadRequest | null {
  const fields = exact(
    input,
    ['threadId', 'matchedEventId', 'ownerUserId', 'ownerUserIds', 'tenantId'],
    ['threadId', 'matchedEventId', 'ownerUserId'],
  );
  return fields
    ? parseTranscriptReadRequest({ ...fields, type: 'message-open', id })
    : null;
}
export function transcriptSessionOpenRequest(
  input: unknown,
  id: number,
): TranscriptReadRequest | null {
  const fields = exact(
    input,
    ['threadId', 'ownerUserId', 'ownerUserIds', 'tenantId'],
    ['threadId', 'ownerUserId'],
  );
  return fields
    ? parseTranscriptReadRequest({ ...fields, type: 'session-open', id })
    : null;
}

export function parseTranscriptReadRequest(
  value: unknown,
): TranscriptReadRequest | null {
  const request = exact(
    value,
    [
      'type',
      'id',
      'query',
      'ownerUserId',
      'ownerUserIds',
      'tenantId',
      'projectId',
      'limit',
      'threadId',
      'threadIds',
      'snapshot',
      'matchedEventId',
      'continuation',
    ],
    ['type', 'id'],
  );
  if (
    !request ||
    !Number.isSafeInteger(request.id) ||
    (request.id as number) < 1
  )
    return null;
  if (request.type !== 'message-page' && Object.hasOwn(request, 'continuation'))
    return null;
  if (
    Object.hasOwn(request, 'threadIds') !== Object.hasOwn(request, 'snapshot')
  )
    return null;
  if (Object.hasOwn(request, 'threadIds')) {
    const ids = request.threadIds;
    if (
      request.type !== 'message-search' ||
      request.tenantId !== undefined ||
      !Array.isArray(ids) ||
      types.isProxy(ids) ||
      ids.length > MAX_SCOPED_TRANSCRIPT_THREADS ||
      !parseSnapshot(request.snapshot)
    )
      return null;
    for (let index = 0; index < ids.length; index++) {
      const field = Object.getOwnPropertyDescriptor(ids, String(index));
      if (!field || !('value' in field) || !boundedTaskText(field.value, 256))
        return null;
    }
  }
  if (request.ownerUserIds !== undefined) {
    const owners = request.ownerUserIds;
    if (
      request.tenantId !== undefined ||
      !Array.isArray(owners) ||
      types.isProxy(owners) ||
      owners.length === 0 ||
      owners.length > 256
    )
      return null;
    for (let index = 0; index < owners.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(owners, String(index));
      if (!entry || !('value' in entry) || !boundedTaskText(entry.value, 256))
        return null;
    }
  }
  if (request.type === 'search-snapshot') {
    if (Object.keys(request).length !== 2) return null;
  } else if (request.type === 'session-owner') {
    if (
      Object.keys(request).length !== 3 ||
      !boundedTaskText(request.threadId, 256)
    )
      return null;
  } else if (request.type === 'session-open') {
    if (
      ['query', 'projectId', 'limit', 'matchedEventId'].some((key) =>
        Object.hasOwn(request, key),
      ) ||
      !boundedTaskText(request.threadId, 256) ||
      !boundedTaskText(request.ownerUserId, 256) ||
      (request.tenantId !== undefined &&
        !boundedTaskText(request.tenantId, 256))
    )
      return null;
  } else if (
    request.type === 'message-open' ||
    request.type === 'message-page'
  ) {
    if (
      ['query', 'projectId', 'limit'].some((key) =>
        Object.hasOwn(request, key),
      ) ||
      !boundedTaskText(request.threadId, 256) ||
      !boundedTaskText(request.matchedEventId, 256) ||
      !boundedTaskText(request.ownerUserId, 256) ||
      (request.tenantId !== undefined &&
        !boundedTaskText(request.tenantId, 256)) ||
      (request.type === 'message-open' &&
        Object.hasOwn(request, 'continuation')) ||
      (request.continuation !== undefined &&
        !boundedTaskText(request.continuation, 256))
    )
      return null;
  } else if (request.type === 'message-search') {
    if (
      Object.hasOwn(request, 'threadId') ||
      Object.hasOwn(request, 'matchedEventId') ||
      !boundedTaskText(request.query, 256) ||
      !boundedTaskText(request.ownerUserId, 256) ||
      (request.tenantId !== undefined &&
        !boundedTaskText(request.tenantId, 256)) ||
      (request.projectId !== undefined &&
        !boundedTaskText(request.projectId, 256)) ||
      !Number.isInteger(request.limit) ||
      (request.limit as number) < 1 ||
      (request.limit as number) > 20
    )
      return null;
  } else return null;
  return request as unknown as TranscriptReadRequest;
}
export function parseTranscriptReadResult(
  value: unknown,
  request: TranscriptReadRequest,
): TranscriptReadResult | null {
  const result = exact(
    value,
    [
      'state',
      'rows',
      'owner',
      'target',
      'session',
      'page',
      'snapshot',
      'cause',
    ],
    ['state'],
  );
  if (!result) return null;
  if (result.state === 'unavailable') {
    const keys = Object.keys(result).length;
    if (keys === 1) return { state: 'unavailable' };
    const cause = keys === 2 ? parseWorkerRefusal(result.cause) : null;
    return cause ? { state: 'unavailable', cause } : null;
  }
  if (Object.hasOwn(result, 'cause')) return null;
  if (result.state !== 'available' || Object.keys(result).length !== 2)
    return null;
  if (request.type === 'search-snapshot') {
    const snapshot = parseSnapshot(result.snapshot);
    return snapshot ? { state: 'available', snapshot } : null;
  }
  if (request.type === 'session-owner') {
    return result.owner === null || boundedTaskText(result.owner, 256)
      ? { state: 'available', owner: result.owner }
      : null;
  }
  if (request.type === 'message-page') {
    if (result.page === null) return { state: 'available', page: null };
    const page = exact(
      result.page,
      [
        'sessionId',
        'matchedEventId',
        'role',
        'text',
        'contentRevision',
        'offset',
        'nextContinuation',
        'projectId',
        'agentSlug',
      ],
      [
        'sessionId',
        'matchedEventId',
        'role',
        'text',
        'contentRevision',
        'offset',
      ],
    );
    if (
      !page ||
      page.sessionId !== request.threadId ||
      page.matchedEventId !== request.matchedEventId ||
      !['user', 'assistant'].includes(String(page.role)) ||
      typeof page.text !== 'string' ||
      Buffer.byteLength(page.text) > 16384 ||
      Array.from(page.text).length > 4096 ||
      typeof page.contentRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(page.contentRevision) ||
      !Number.isSafeInteger(page.offset) ||
      (page.offset as number) < 0 ||
      (page.offset as number) > 131072 ||
      ['nextContinuation', 'projectId', 'agentSlug'].some(
        (key) => page[key] !== undefined && !boundedTaskText(page[key], 256),
      )
    )
      return null;
    return {
      state: 'available',
      page: page as unknown as TranscriptMessagePageFact,
    };
  }
  if (request.type === 'message-open') {
    if (result.target === null) return { state: 'available', target: null };
    const target = exact(
      result.target,
      ['conversationId', 'matchedEventId', 'messageId', 'projectSlug'],
      ['conversationId', 'matchedEventId', 'messageId'],
    );
    if (
      !target ||
      target.conversationId !== request.threadId ||
      target.matchedEventId !== request.matchedEventId ||
      !boundedTaskText(target.messageId, 512) ||
      (target.projectSlug !== undefined &&
        !boundedTaskText(target.projectSlug, 256))
    )
      return null;
    return {
      state: 'available',
      target: target as unknown as TranscriptMessageOpenFact,
    };
  }
  if (request.type === 'session-open') {
    if (result.session === null) return { state: 'available', session: null };
    const session = exact(
      result.session,
      ['conversationId', 'projectSlug'],
      ['conversationId'],
    );
    return session &&
      session.conversationId === request.threadId &&
      (session.projectSlug === undefined ||
        boundedTaskText(session.projectSlug, 256))
      ? {
          state: 'available',
          session: session as unknown as TranscriptSessionOpenFact,
        }
      : null;
  }
  if (
    !Array.isArray(result.rows) ||
    types.isProxy(result.rows) ||
    result.rows.length > request.limit
  )
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(result.rows);
  if (Reflect.ownKeys(descriptors).length !== result.rows.length + 1)
    return null;
  const rows: TranscriptSearchMatch[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < result.rows.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) return null;
    const row = exact(
      descriptor.value,
      [
        'conversationId',
        'messageId',
        'matchedEventId',
        'role',
        'excerpt',
        'projectSlug',
        'agentSlug',
        'engine',
      ],
      ['conversationId', 'messageId', 'matchedEventId', 'role', 'excerpt'],
    );
    if (
      !row ||
      !boundedTaskText(row.conversationId, 256) ||
      !boundedTaskText(row.messageId, 512) ||
      !boundedTaskText(row.matchedEventId, 256) ||
      (request.projectId !== undefined &&
        row.projectSlug !== request.projectId) ||
      (row.role !== 'user' && row.role !== 'assistant') ||
      typeof row.excerpt !== 'string' ||
      Buffer.byteLength(row.excerpt) > 1024 ||
      ['projectSlug', 'agentSlug', 'engine'].some(
        (key) => row[key] !== undefined && !boundedTaskText(row[key], 256),
      )
    )
      return null;
    const identity = JSON.stringify([row.conversationId, row.matchedEventId]);
    if (identities.has(identity)) return null;
    identities.add(identity);
    rows.push(row as unknown as TranscriptSearchMatch);
  }
  return { state: 'available', rows };
}
