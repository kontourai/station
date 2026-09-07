import {
  ATTENTION_REQUEST_ID_MAX_CHARS,
  type AttentionRequestInspection,
  type AttentionRequestReference,
} from '@kontourai/station-contracts/attention';
import type { RequestOpenedEvent } from '@kontourai/station-contracts/runtime-events';
import type { EventStore } from './event-store.js';
import { presentOpenRequest } from './request-presentation.js';

export function attentionRequestReference(
  request: RequestOpenedEvent,
  expectedThreadId?: string,
): AttentionRequestReference | undefined {
  if (expectedThreadId !== undefined && request.threadId !== expectedThreadId)
    return undefined;
  if (
    request.requestType !== 'approval' &&
    request.requestType !== 'permission'
  )
    return undefined;
  const values = [request.threadId, request.requestId, request.eventId];
  if (
    values.some(
      (value) =>
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > ATTENTION_REQUEST_ID_MAX_CHARS,
    )
  )
    return undefined;
  return {
    threadId: request.threadId,
    requestId: request.requestId,
    requestEventId: request.eventId,
  };
}

export class RequestEventGuardError extends Error {
  constructor(
    readonly code: 'request_event_changed' | 'request_verification_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'RequestEventGuardError';
  }
}

type InspectedRequestFact =
  | Omit<
      Extract<AttentionRequestInspection, { state: 'open' }>,
      'answerability' | 'canRespond'
    >
  | Exclude<AttentionRequestInspection, { state: 'open' }>;

export function inspectRequestEvent(
  store: Pick<EventStore, 'readCurrentRequestEvent'> | undefined,
  reference: AttentionRequestReference,
  expectedProvider?: string,
): InspectedRequestFact {
  const unavailable = (): InspectedRequestFact => ({
    state: 'unavailable',
    reference,
    message:
      'This request could not be verified. Refresh attention before responding.',
  });
  if (!store) return unavailable();
  let current: ReturnType<EventStore['readCurrentRequestEvent']>;
  try {
    current = store.readCurrentRequestEvent(
      reference.threadId,
      reference.requestId,
    );
  } catch {
    return unavailable();
  }
  if (current.state !== 'found') return unavailable();
  const event = current.event.payload;
  if (
    current.event.threadId !== reference.threadId ||
    event.eventId !== current.event.id ||
    event.method !== current.event.method ||
    event.provider !== current.event.provider ||
    (expectedProvider !== undefined && event.provider !== expectedProvider) ||
    event.threadId !== reference.threadId ||
    event.requestId !== reference.requestId
  )
    return unavailable();
  if (event.method === 'request.resolved')
    return {
      state: 'resolved',
      reference,
      message: 'This request has already been resolved.',
    };
  if (event.method !== 'request.opened') return unavailable();
  if (
    current.event.id !== reference.requestEventId ||
    event.eventId !== reference.requestEventId
  ) {
    return {
      state: 'changed',
      reference,
      message:
        'This request changed after the attention item was created. Refresh attention and inspect the current request.',
    };
  }
  if (
    !attentionRequestReference(event) ||
    typeof event.createdAt !== 'string' ||
    event.createdAt.length > 128 ||
    !Number.isFinite(Date.parse(event.createdAt)) ||
    typeof event.title !== 'string' ||
    (event.description !== undefined &&
      typeof event.description !== 'string') ||
    (event.payload !== undefined &&
      (!event.payload ||
        typeof event.payload !== 'object' ||
        Array.isArray(event.payload)))
  )
    return unavailable();
  return {
    state: 'open',
    reference,
    provider: event.provider,
    requestType: event.requestType as 'approval' | 'permission',
    ...presentOpenRequest(event),
    openedAt: event.createdAt,
  };
}
