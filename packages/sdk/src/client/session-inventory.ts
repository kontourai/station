import {
  type AnySessionInventoryGroupPage,
  type AnySessionInventoryProjection,
  parseSessionInventoryGroupPage,
  parseSessionInventoryProjection,
  type SessionInventoryScope,
  type SessionInventoryV2GroupId,
} from '@kontourai/station-contracts/session-inventory';
import { type ClientRequestOptions, getJson } from './http';

export class SessionInventoryRequestError extends Error {
  constructor(readonly status: number) {
    super('Session inventory unavailable');
  }
}

async function unwrap<T>(
  response: Response,
  parse: (value: unknown) => T | null,
): Promise<T> {
  try {
    const body = (await response.json()) as {
      success?: unknown;
      data?: unknown;
    };
    const parsed = body.success === true ? parse(body.data) : null;
    if (response.ok && parsed) return parsed;
  } catch {
    /* normalize below */
  }
  throw new SessionInventoryRequestError(response.status);
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
