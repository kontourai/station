import {
  type AnySessionInventoryGroupPage,
  type AnySessionInventoryProjection,
  parseSessionInventoryGroupPage,
  parseSessionInventoryProjection,
  type SessionInventoryScope,
  type SessionInventoryV2GroupId,
} from '@kontourai/station-contracts/session-inventory';
import type { TaskUserInputProjection } from '@kontourai/station-contracts/task-graph';
import { envelopeError, type StationHttpError } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';
import { rethrowDeadline } from './request-deadline';

export class SessionInventoryRequestError extends Error {
  readonly status: number;
  /**
   * The refusal's machine `code` and `Retry-After`, when Station answered
   * (#2708). The message stays generic on purpose: nothing the route sent
   * about protected content crosses this seam.
   */
  readonly code?: string;
  readonly retryAfterMs?: number;

  /** `0` when no response was observed; else the envelope helper's error. */
  constructor(answer: number | StationHttpError) {
    super('Session inventory unavailable');
    this.status = typeof answer === 'number' ? answer : answer.status;
    if (typeof answer !== 'number') {
      if (answer.code !== undefined) this.code = answer.code;
      if (answer.retryAfterMs !== undefined)
        this.retryAfterMs = answer.retryAfterMs;
    }
  }
}

/** The observed answer, withholding everything the route said but its code. */
function answered(response: Response, body?: unknown): StationHttpError {
  return envelopeError(response, body, 'Session inventory unavailable', {
    message: 'Session inventory unavailable',
  });
}

async function unwrap<T>(
  response: Response,
  parse: (value: unknown) => T | null,
): Promise<T> {
  let body: { success?: unknown; data?: unknown } | undefined;
  try {
    body = (await response.json()) as { success?: unknown; data?: unknown };
    const parsed = body.success === true ? parse(body.data) : null;
    if (response.ok && parsed) return parsed;
  } catch (error) {
    rethrowDeadline(error);
    /* normalize below */
  }
  throw new SessionInventoryRequestError(answered(response, body));
}
function scopeQuery(scope: SessionInventoryScope): string {
  if (scope.kind === 'kept-in-task') return '';
  const query = new URLSearchParams({ scope: scope.kind });
  if (scope.kind === 'current-answer') query.set('turnId', scope.turnId);
  return query.toString();
}
export async function getSessionInventory(
  apiBase: string,
  scope: SessionInventoryScope,
  options?: ClientRequestOptions,
): Promise<AnySessionInventoryProjection> {
  const base =
    scope.kind === 'kept-in-task'
      ? `${apiBase}/api/tasks/${encodeURIComponent(scope.taskId)}/sessions/${encodeURIComponent(scope.sessionId)}/inventory`
      : `${apiBase}/api/orchestration/sessions/${encodeURIComponent(scope.sessionId)}/inventory?${scopeQuery(scope)}`;
  try {
    return await unwrap(
      await getJson(base, options),
      parseSessionInventoryProjection,
    );
  } catch (error) {
    throw error instanceof SessionInventoryRequestError
      ? error
      : new SessionInventoryRequestError(0);
  }
}
export async function getSessionInventoryGroupPage(
  apiBase: string,
  scope: SessionInventoryScope,
  groupId: SessionInventoryV2GroupId,
  options?: ClientRequestOptions & { continuation?: string },
): Promise<AnySessionInventoryGroupPage> {
  const query = new URLSearchParams(scopeQuery(scope));
  if (options?.continuation) query.set('continuation', options.continuation);
  try {
    return await unwrap(
      await getJson(
        scope.kind === 'kept-in-task'
          ? `${apiBase}/api/tasks/${encodeURIComponent(scope.taskId)}/sessions/${encodeURIComponent(scope.sessionId)}/inventory/groups/${encodeURIComponent(groupId)}?${query}`
          : `${apiBase}/api/orchestration/sessions/${encodeURIComponent(scope.sessionId)}/inventory/groups/${encodeURIComponent(groupId)}?${query}`,
        options,
      ),
      parseSessionInventoryGroupPage,
    );
  } catch (error) {
    throw error instanceof SessionInventoryRequestError
      ? error
      : new SessionInventoryRequestError(0);
  }
}

/** Reopen one exact input without loading the Session transcript. */
export async function getSessionInventoryInput(
  apiBase: string,
  sessionId: string,
  eventId: string,
  turnId: string,
  options?: ClientRequestOptions,
): Promise<TaskUserInputProjection> {
  try {
    return await unwrap(
      await getJson(
        `${apiBase}/api/orchestration/sessions/${encodeURIComponent(sessionId)}/inputs/${encodeURIComponent(eventId)}?turnId=${encodeURIComponent(turnId)}`,
        options,
      ),
      (value) => {
        if (
          !value ||
          typeof value !== 'object' ||
          !('sessionId' in value) ||
          value.sessionId !== sessionId ||
          !('eventId' in value) ||
          value.eventId !== eventId ||
          !('turnId' in value) ||
          value.turnId !== turnId ||
          !('input' in value) ||
          !value.input ||
          typeof value.input !== 'object'
        )
          return null;
        const input = value.input;
        if (
          !('prompt' in input) ||
          typeof input.prompt !== 'string' ||
          !('attachments' in input) ||
          !Array.isArray(input.attachments) ||
          input.attachments.length > 64
        )
          return null;
        const attachments: TaskUserInputProjection['attachments'][number][] =
          [];
        for (const attachment of input.attachments) {
          if (
            !attachment ||
            typeof attachment !== 'object' ||
            typeof attachment.name !== 'string' ||
            typeof attachment.mediaType !== 'string' ||
            !Number.isSafeInteger(attachment.size) ||
            attachment.size < 0
          )
            return null;
          attachments.push({
            name: attachment.name,
            mediaType: attachment.mediaType,
            size: attachment.size,
          });
        }
        return { prompt: input.prompt, attachments };
      },
    );
  } catch (error) {
    throw error instanceof SessionInventoryRequestError
      ? error
      : new SessionInventoryRequestError(0);
  }
}
