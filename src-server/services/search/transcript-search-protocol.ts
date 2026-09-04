/** Owner-private wire facts, never SessionReadAuthority or executable policy. */
import { types } from 'node:util';
import { boundedTaskText } from './task-search-protocol.js';

export type TranscriptReadRequest =
  | {
      type: 'message-search';
      id: number;
      query: string;
      ownerUserId: string;
      tenantId?: string;
      projectId?: string;
      limit: number;
    }
  | {
      type: 'message-open';
      id: number;
      threadId: string;
      matchedEventId: string;
      ownerUserId: string;
      tenantId?: string;
    }
  | {
      type: 'session-open';
      id: number;
      threadId: string;
      ownerUserId: string;
      tenantId?: string;
    }
  | { type: 'session-owner'; id: number; threadId: string };
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
export type TranscriptReadResult =
  | { state: 'available'; rows: TranscriptSearchMatch[] }
  | { state: 'available'; owner: string | null }
  | { state: 'available'; target: TranscriptMessageOpenFact | null }
  | { state: 'available'; session: TranscriptSessionOpenFact | null }
  | { state: 'unavailable' };

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
export function transcriptMessageRequest(
  input: unknown,
  id: number,
): TranscriptReadRequest | null {
  const fields = exact(
    input,
    ['query', 'ownerUserId', 'tenantId', 'projectId', 'limit'],
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
    ['threadId', 'matchedEventId', 'ownerUserId', 'tenantId'],
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
    ['threadId', 'ownerUserId', 'tenantId'],
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
      'tenantId',
      'projectId',
      'limit',
      'threadId',
      'matchedEventId',
    ],
    ['type', 'id'],
  );
  if (
    !request ||
    !Number.isSafeInteger(request.id) ||
    (request.id as number) < 1
  )
    return null;
  if (request.type === 'session-owner') {
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
  } else if (request.type === 'message-open') {
    if (
      ['query', 'projectId', 'limit'].some((key) =>
        Object.hasOwn(request, key),
      ) ||
      !boundedTaskText(request.threadId, 256) ||
      !boundedTaskText(request.matchedEventId, 256) ||
      !boundedTaskText(request.ownerUserId, 256) ||
      (request.tenantId !== undefined &&
        !boundedTaskText(request.tenantId, 256))
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
    ['state', 'rows', 'owner', 'target', 'session'],
    ['state'],
  );
  if (!result) return null;
  if (result.state === 'unavailable')
    return Object.keys(result).length === 1 ? { state: 'unavailable' } : null;
  if (result.state !== 'available' || Object.keys(result).length !== 2)
    return null;
  if (request.type === 'session-owner') {
    return result.owner === null || boundedTaskText(result.owner, 256)
      ? { state: 'available', owner: result.owner }
      : null;
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
