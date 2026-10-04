/**
 * React-free transport for the Project/Task personal-room routes.  The server
 * owns grants, atoms, and write authorization; this module only exchanges the
 * closed browser representations declared by the route boundary.
 */
import type {
  ProjectTaskRoomAppendOutcome,
  ProjectTaskRoomOutputFeedback,
} from '@kontourai/station-contracts/project-task-room';
import { isProjectTaskRoomAppendReceipt } from '@kontourai/station-contracts/project-task-room';
import {
  type ProjectTaskRoomBrowserCapabilities,
  type ProjectTaskRoomBrowserDiscovery,
  type ProjectTaskRoomBrowserHistory,
  type ProjectTaskRoomBrowserLiveSnapshot,
  parseProjectTaskRoomBrowserDiscovery,
  parseProjectTaskRoomBrowserHistory,
  parseProjectTaskRoomBrowserLiveSnapshot,
} from '@kontourai/station-contracts/project-task-room-browser';
import { envelopeError, type StationHttpError } from './api-error-message';
import {
  authenticatedFetch,
  type ClientRequestOptions,
  type FetchSseConnection,
  fetchSSE,
  mutateJson,
} from './http';
import { rethrowDeadline } from './request-deadline';

export class ProjectTaskRoomProtocolError extends Error {
  /**
   * Set only when Station refused the request (#2708): the answer's status,
   * machine `code`, `details` and `Retry-After`. A malformed or unreadable
   * room response leaves them absent.
   */
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;

  constructor(failure: string | StationHttpError) {
    super(typeof failure === 'string' ? failure : failure.message);
    this.name = 'ProjectTaskRoomProtocolError';
    if (typeof failure === 'string') return;
    this.status = failure.status;
    if (failure.code !== undefined) this.code = failure.code;
    if (failure.details !== undefined) this.details = failure.details;
    if (failure.retryAfterMs !== undefined)
      this.retryAfterMs = failure.retryAfterMs;
  }
}

type RecordValue = Record<string, unknown>;
export type ProjectTaskRoomCapabilities = ProjectTaskRoomBrowserCapabilities;
export type ProjectTaskRoomDiscovery = ProjectTaskRoomBrowserDiscovery;
function record(value: unknown): value is RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  try {
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) =>
        descriptor.get === undefined && descriptor.set === undefined,
    );
  } catch {
    return false;
  }
}
function has(value: RecordValue, key: string): boolean {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function roomPath(taskId: string, suffix = ''): string {
  if (!text(taskId))
    throw new ProjectTaskRoomProtocolError('Task identity is invalid');
  return `/api/tasks/${encodeURIComponent(taskId)}/room${suffix}`;
}
/** Station refused: keep its status, code, details and Retry-After (#2708). */
function refusal(response: Response, body: unknown): StationHttpError {
  return envelopeError(
    response,
    body,
    `Room request failed (${response.status})`,
  );
}
async function envelope(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    // A refusal that is not JSON still carries the status Station answered.
    if (!response.ok)
      throw new ProjectTaskRoomProtocolError(refusal(response, undefined));
    throw new ProjectTaskRoomProtocolError('Room response is not JSON');
  }
  if (!record(body) || typeof body.success !== 'boolean') {
    if (!response.ok)
      throw new ProjectTaskRoomProtocolError(refusal(response, body));
    throw new ProjectTaskRoomProtocolError(
      'Station sent a room response that could not be read',
    );
  }
  if (!response.ok || body.success !== true || !has(body, 'data')) {
    throw new ProjectTaskRoomProtocolError(refusal(response, body));
  }
  return body.data;
}
function parseOpen(value: unknown, taskId: string): ProjectTaskRoomDiscovery {
  const parsed = parseProjectTaskRoomBrowserDiscovery(value);
  if (
    !parsed ||
    ((parsed.kind === 'opened' || parsed.kind === 'existing') &&
      parsed.scope.taskId !== taskId)
  )
    throw new ProjectTaskRoomProtocolError('Room discovery is invalid');
  return parsed;
}
function parseHistory(value: unknown): ProjectTaskRoomBrowserHistory {
  const parsed = parseProjectTaskRoomBrowserHistory(value);
  if (!parsed)
    throw new ProjectTaskRoomProtocolError('Room history is invalid');
  return parsed;
}
export const parseProjectTaskRoomHistoryResponse = parseHistory;
function parseAppend(value: unknown): ProjectTaskRoomAppendOutcome {
  if (!record(value) || typeof value.kind !== 'string')
    throw new ProjectTaskRoomProtocolError('Room message result is invalid');
  if (value.kind === 'denied' || value.kind === 'unavailable')
    return { kind: value.kind };
  if (
    (value.kind === 'committed' || value.kind === 'duplicate') &&
    isProjectTaskRoomAppendReceipt(value.receipt)
  )
    return value as ProjectTaskRoomAppendOutcome;
  if (value.kind === 'rejected' && typeof value.reason === 'string')
    return value as ProjectTaskRoomAppendOutcome;
  throw new ProjectTaskRoomProtocolError(
    'Room message result has an unknown shape',
  );
}

export type ProjectTaskRoomDocument =
  | {
      readonly kind: 'snapshot';
      readonly revision: string;
      readonly text: string;
    }
  | { readonly kind: 'delta'; readonly revision: string; readonly text: string }
  | { readonly kind: 'gap'; readonly floor: string }
  | { readonly kind: 'unavailable' };
export type ProjectTaskRoomEditPlan =
  | {
      readonly kind: 'planned';
      readonly intentId: string;
      readonly digest: string;
      readonly optimistic: unknown;
      readonly selection: { anchor: number; focus: number };
      readonly operationCount: number;
    }
  | {
      readonly kind: 'not-found' | 'unavailable' | 'rejected' | 'refused';
      readonly reason?: string;
    }
  | { readonly kind: 'unchanged' };
export type ProjectTaskRoomBatchResult =
  | {
      readonly kind: 'committed' | 'duplicate';
      readonly revision: string;
      readonly text: string;
    }
  | { readonly kind: 'rejected' | 'unavailable'; readonly reason?: string };
export type ProjectTaskRoomLiveResult =
  | {
      readonly kind: 'available';
      readonly generation: string;
      readonly snapshot: ProjectTaskRoomBrowserLiveSnapshot;
    }
  | { readonly kind: 'not-found' | 'unavailable' };
export type ProjectTaskRoomLiveCommand =
  | {
      readonly command: 'join' | 'announce' | 'depart';
      readonly requestId?: string;
    }
  | { readonly command: 'heartbeat' }
  | {
      readonly command: 'watch' | 'follow';
      readonly paneId: string;
      readonly targetActorId: string;
    }
  | { readonly command: 'stop'; readonly paneId: string }
  | { readonly command: 'typing'; readonly active: boolean }
  | {
      readonly command: 'cursor';
      readonly generation: string;
      readonly workingRevision: string;
      readonly selection: { readonly anchor: number; readonly focus: number };
    };

function parseDocument(value: unknown): ProjectTaskRoomDocument {
  if (!record(value) || typeof value.kind !== 'string')
    throw new ProjectTaskRoomProtocolError('Room document is invalid');
  if (value.kind === 'unavailable') return { kind: 'unavailable' };
  if (value.kind === 'gap' && text(value.floor))
    return { kind: 'gap', floor: value.floor };
  if (
    (value.kind === 'snapshot' || value.kind === 'delta') &&
    text(value.revision) &&
    typeof value.text === 'string'
  )
    return { kind: value.kind, revision: value.revision, text: value.text };
  throw new ProjectTaskRoomProtocolError('Room document has an unknown shape');
}
export const parseProjectTaskRoomDocumentResponse = parseDocument;

/**
 * Only an authenticated ordered committed document SSE may advance the query.
 * Duplicate responses can arrive after a newer revision and must refetch.
 */
export function parseAuthoritativeProjectTaskRoomDocumentEvent(value: unknown) {
  try {
    return parseDocument(value);
  } catch {}
  try {
    const result = parseBatch(value);
    return result.kind === 'committed'
      ? {
          kind: 'snapshot' as const,
          revision: result.revision,
          text: result.text,
        }
      : undefined;
  } catch {
    return undefined;
  }
}
function parseEditPlan(value: unknown): ProjectTaskRoomEditPlan {
  if (!record(value) || typeof value.kind !== 'string')
    throw new ProjectTaskRoomProtocolError('Room edit plan is invalid');
  if (
    value.kind === 'not-found' ||
    value.kind === 'unavailable' ||
    value.kind === 'rejected' ||
    value.kind === 'refused'
  )
    return {
      kind: value.kind,
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
  if (value.kind === 'unchanged') return { kind: 'unchanged' };
  if (value.kind !== 'planned')
    throw new ProjectTaskRoomProtocolError(
      'Room edit plan has an unknown outcome',
    );
  if (
    !text(value.intentId) ||
    !/^[0-9a-f]{64}$/.test(String(value.digest)) ||
    !record(value.selection) ||
    !integer(value.selection.anchor) ||
    !integer(value.selection.focus) ||
    !integer(value.operationCount)
  )
    throw new ProjectTaskRoomProtocolError(
      'Room edit plan has an unknown shape',
    );
  return {
    kind: 'planned',
    intentId: value.intentId,
    digest: value.digest as string,
    optimistic: value.optimistic,
    selection: { anchor: value.selection.anchor, focus: value.selection.focus },
    operationCount: value.operationCount,
  };
}
function parseBatch(value: unknown): ProjectTaskRoomBatchResult {
  if (!record(value) || typeof value.kind !== 'string')
    throw new ProjectTaskRoomProtocolError('Room batch result is invalid');
  if (
    (value.kind === 'committed' || value.kind === 'duplicate') &&
    text(value.revision) &&
    typeof value.text === 'string'
  )
    return { kind: value.kind, revision: value.revision, text: value.text };
  if (value.kind === 'rejected' || value.kind === 'unavailable')
    return {
      kind: value.kind,
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
  throw new ProjectTaskRoomProtocolError(
    'Room batch result has an unknown shape',
  );
}
function parseLive(value: unknown, taskId: string): ProjectTaskRoomLiveResult {
  if (!record(value) || typeof value.kind !== 'string')
    throw new ProjectTaskRoomProtocolError('Room live result is invalid');
  if (value.kind === 'not-found' || value.kind === 'unavailable')
    return { kind: value.kind };
  if (
    value.kind === 'available' &&
    text(value.generation) &&
    text(value.viewerActorId) &&
    has(value, 'snapshot') &&
    has(value, 'result')
  ) {
    const snapshot = parseProjectTaskRoomBrowserLiveSnapshot({
      type: 'live',
      kind: 'available',
      generation: value.generation,
      viewerActorId: value.viewerActorId,
      result: value.result,
      snapshot: value.snapshot,
    });
    if (!snapshot || snapshot.scope.taskId !== taskId)
      throw new ProjectTaskRoomProtocolError(
        'Room live result snapshot is invalid',
      );
    return {
      kind: 'available',
      generation: value.generation,
      snapshot,
    };
  }
  throw new ProjectTaskRoomProtocolError(
    'Room live result has an unknown shape',
  );
}

export async function discoverProjectTaskRoom(
  apiBase: string,
  taskId: string,
  opts?: ClientRequestOptions,
) {
  return parseOpen(
    await envelope(
      await authenticatedFetch(`${apiBase}${roomPath(taskId)}`, opts),
    ),
    taskId,
  );
}
export async function fetchProjectTaskRoomHistory(
  apiBase: string,
  taskId: string,
  page: { cursor?: string; limit?: number } = {},
  opts?: ClientRequestOptions,
) {
  if (
    page.limit !== undefined &&
    (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100)
  )
    throw new ProjectTaskRoomProtocolError('Room history limit is invalid');
  const params = new URLSearchParams();
  if (page.cursor) params.set('cursor', page.cursor);
  if (page.limit !== undefined) params.set('limit', String(page.limit));
  const query = params.size ? `?${params}` : '';
  return parseProjectTaskRoomHistoryResponse(
    await envelope(
      await authenticatedFetch(
        `${apiBase}${roomPath(taskId, `/history${query}`)}`,
        opts,
      ),
    ),
  );
}
export async function fetchProjectTaskRoomDocument(
  apiBase: string,
  taskId: string,
  after?: string,
  opts?: ClientRequestOptions,
) {
  const query = after ? `?after=${encodeURIComponent(after)}` : '';
  return parseDocument(
    await envelope(
      await authenticatedFetch(
        `${apiBase}${roomPath(taskId, `/document${query}`)}`,
        opts,
      ),
    ),
  );
}
export async function appendProjectTaskRoomHumanMessage(
  apiBase: string,
  input: {
    taskId: string;
    proposalId: string;
    text: string;
    occurredAt?: string;
    expectedTaskCreatedAt?: string;
  },
  opts?: ClientRequestOptions,
) {
  if (!text(input.proposalId) || !text(input.text))
    throw new ProjectTaskRoomProtocolError('Room message intent is invalid');
  return parseAppend(
    await envelope(
      await mutateJson(
        `${apiBase}${roomPath(input.taskId, '/messages')}`,
        'POST',
        opts,
        {
          proposalId: input.proposalId,
          text: input.text,
          ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
          ...(input.expectedTaskCreatedAt
            ? { expectedTaskCreatedAt: input.expectedTaskCreatedAt }
            : {}),
        },
      ),
    ),
  );
}
export async function appendProjectTaskRoomOutputFeedback(
  apiBase: string,
  input: {
    taskId: string;
    proposalId: string;
    occurredAt: string;
    feedback: ProjectTaskRoomOutputFeedback;
  },
  opts?: ClientRequestOptions,
) {
  const { kind: _kind, ...feedback } = input.feedback;
  return parseAppend(
    await envelope(
      await mutateJson(
        `${apiBase}${roomPath(input.taskId, '/output-feedback')}`,
        'POST',
        opts,
        {
          proposalId: input.proposalId,
          occurredAt: input.occurredAt,
          ...feedback,
        },
      ),
    ),
  );
}
export async function commandProjectTaskRoomLive(
  apiBase: string,
  taskId: string,
  command: ProjectTaskRoomLiveCommand,
  opts?: ClientRequestOptions,
) {
  return parseLive(
    await envelope(
      await authenticatedFetch(`${apiBase}${roomPath(taskId, '/live')}`, {
        ...opts,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts?.headers },
        body: JSON.stringify(command),
      }),
    ),
    taskId,
  );
}
export async function planProjectTaskRoomEdit(
  apiBase: string,
  taskId: string,
  input: {
    intentId: string;
    desiredText: string;
    selection: { anchor: number; focus: number };
  },
  opts?: ClientRequestOptions,
) {
  return parseEditPlan(
    await envelope(
      await authenticatedFetch(`${apiBase}${roomPath(taskId, '/edit-plan')}`, {
        ...opts,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts?.headers },
        body: JSON.stringify(input),
      }),
    ),
  );
}
export async function submitProjectTaskRoomBatch(
  apiBase: string,
  taskId: string,
  input: { intentId: string; intentDigest: string },
  opts?: ClientRequestOptions,
) {
  return parseBatch(
    await envelope(
      await authenticatedFetch(`${apiBase}${roomPath(taskId, '/batches')}`, {
        ...opts,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts?.headers },
        body: JSON.stringify(input),
      }),
    ),
  );
}

export type ProjectTaskRoomSseEvent = {
  readonly kind: 'snapshot' | 'room' | 'document' | 'terminal';
  readonly id?: string;
  readonly value?: unknown;
};
export function subscribeProjectTaskRoomEvents(
  apiBase: string,
  taskId: string,
  callbacks: {
    onEvent(event: ProjectTaskRoomSseEvent): void;
    onError?(error: unknown): void;
    onOpen?(): void;
    onTerminal?(): void;
    onCheckpoint?(id: string): void;
  },
): FetchSseConnection {
  return fetchSSE(`${apiBase}${roomPath(taskId, '/events')}`, {
    onOpen: () => callbacks.onOpen?.(),
    onError: callbacks.onError,
    onTerminal: () => callbacks.onTerminal?.(),
    onCheckpoint: (checkpoint) => {
      if (checkpoint.id) callbacks.onCheckpoint?.(checkpoint.id);
    },
    onMessage: (message) => {
      if (message.event === 'ping') return true;
      if (message.event === 'terminal') {
        callbacks.onEvent({
          kind: 'terminal',
          ...(message.id ? { id: message.id } : {}),
        });
        return true;
      }
      if (
        message.event !== 'snapshot' &&
        message.event !== 'room' &&
        message.event !== 'document'
      ) {
        callbacks.onError?.(
          new ProjectTaskRoomProtocolError('Unknown room SSE event'),
        );
        return false;
      }
      try {
        callbacks.onEvent({
          kind: message.event,
          ...(message.id ? { id: message.id } : {}),
          value: JSON.parse(message.data),
        });
        return true;
      } catch {
        callbacks.onError?.(
          new ProjectTaskRoomProtocolError('Malformed room SSE event'),
        );
        return false;
      }
    },
  });
}
