import {
  ACTION_OPERATION_SCHEMA_VERSION,
  type ActionOperation,
  type ActionOperationPage,
  type ActionOperationWatchSnapshot,
  parseActionOperation,
} from '@kontourai/station-contracts/action-operation';
import { envelopeError, type StationHttpError } from './api-error-message';
import { authenticatedFetch } from './http';
import { rethrowDeadline } from './request-deadline';

export class ActionOperationProtocolError extends Error {
  /**
   * Set only when Station refused the request (#2708): the answer's status,
   * machine `code`, `details` and `Retry-After`. A malformed or unreadable
   * response leaves them absent.
   */
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;

  constructor(failure: string | StationHttpError) {
    super(typeof failure === 'string' ? failure : failure.message);
    this.name = 'ActionOperationProtocolError';
    if (typeof failure === 'string') return;
    this.status = failure.status;
    if (failure.code !== undefined) this.code = failure.code;
    if (failure.details !== undefined) this.details = failure.details;
    if (failure.retryAfterMs !== undefined)
      this.retryAfterMs = failure.retryAfterMs;
  }
}

/** A refusal under this client's own sentence, keeping status and `code`. */
function refused(
  response: Response,
  body: unknown,
  message: string,
): ActionOperationProtocolError {
  return new ActionOperationProtocolError(
    envelopeError(response, body, message, { message }),
  );
}

function page(value: unknown): ActionOperationPage | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schemaVersion?: unknown }).schemaVersion !==
      ACTION_OPERATION_SCHEMA_VERSION ||
    !Array.isArray((value as { items?: unknown }).items)
  ) {
    return undefined;
  }
  const items = (value as { items: unknown[] }).items.map(parseActionOperation);
  if (items.some((item) => !item)) return undefined;
  const nextCursor = (value as { nextCursor?: unknown }).nextCursor;
  if (
    nextCursor !== undefined &&
    (typeof nextCursor !== 'string' || nextCursor.length > 64)
  )
    return undefined;
  return {
    schemaVersion: ACTION_OPERATION_SCHEMA_VERSION,
    items: items as ActionOperation[],
    ...(typeof nextCursor === 'string' ? { nextCursor } : {}),
  };
}
function envelope(value: unknown): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { success?: unknown }).success !== true
  )
    throw new ActionOperationProtocolError('Action operation request failed');
  return (value as { data?: unknown }).data;
}

export async function fetchActionOperations(
  apiBase: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<ActionOperationPage> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit) query.set('limit', String(options.limit));
  const response = await authenticatedFetch(
    `${apiBase}/api/action-operations${query.size ? `?${query}` : ''}`,
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    throw new ActionOperationProtocolError(
      'Action operation response is not JSON',
    );
  }
  if (!response.ok)
    throw refused(response, body, 'Action operation request failed');
  const parsed = page(envelope(body));
  if (!parsed)
    throw new ActionOperationProtocolError(
      'Action operation response is invalid',
    );
  return parsed;
}

export async function watchActionOperations(
  apiBase: string,
  cursor?: string,
): Promise<ActionOperationWatchSnapshot> {
  const response = await authenticatedFetch(
    `${apiBase}/api/action-operations/watch${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    throw new ActionOperationProtocolError(
      'Action operation watch response is not JSON',
    );
  }
  if (!response.ok)
    throw refused(response, body, 'Action operation watch failed');
  const data = envelope(body);
  const parsed = page(data);
  if (
    !parsed ||
    !data ||
    typeof data !== 'object' ||
    ((data as { mode?: unknown }).mode !== 'snapshot' &&
      (data as { mode?: unknown }).mode !== 'delta') ||
    typeof (data as { cursor?: unknown }).cursor !== 'string'
  ) {
    throw new ActionOperationProtocolError(
      'Action operation watch response is invalid',
    );
  }
  return {
    ...parsed,
    mode: (data as { mode: 'snapshot' | 'delta' }).mode,
    cursor: (data as { cursor: string }).cursor,
  };
}

export async function cancelActionOperation(
  apiBase: string,
  id: string,
): Promise<ActionOperation> {
  const response = await authenticatedFetch(
    `${apiBase}/api/action-operations/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' },
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    throw new ActionOperationProtocolError(
      'Action operation cancellation response is not JSON',
    );
  }
  if (!response.ok) {
    // A cancellation refusal is read out: the route's reason is the message.
    throw new ActionOperationProtocolError(
      envelopeError(response, body, 'Action operation cancellation failed'),
    );
  }
  const operation = parseActionOperation(envelope(body));
  if (!operation)
    throw new ActionOperationProtocolError(
      'Action operation cancellation response is invalid',
    );
  return operation;
}
