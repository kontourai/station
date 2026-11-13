import type {
  SessionLiveContinuity,
  SessionRewindOutcome,
  SessionRewindRefusalReason,
} from '@kontourai/station-contracts/provider';
import { envelopeError } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';

const NONE: SessionLiveContinuity = {
  live: false,
  rewind: 'none',
  fork: 'none',
};

const REFUSAL_REASONS: ReadonlySet<SessionRewindRefusalReason> = new Set([
  'unsupported',
  'not-live',
  'turn-running',
  'send-preparing',
  'rewind-pending',
  'unknown-turn',
]);

function sessionPath(apiBase: string, threadId: string, action: string) {
  if (!threadId || threadId.length > 512)
    throw Error('An exact Session is required.');
  return `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/${action}`;
}

function dataOf(body: unknown): unknown {
  return body && typeof body === 'object' && 'data' in body
    ? (body as { data: unknown }).data
    : undefined;
}

function readContinuity(value: unknown): SessionLiveContinuity | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.live !== 'boolean' ||
    (record.rewind !== 'in-place' && record.rewind !== 'none') ||
    (record.fork !== 'native' && record.fork !== 'none')
  )
    return null;
  return { live: record.live, rewind: record.rewind, fork: record.fork };
}

function readStrings(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

function readRewindOutcome(value: unknown): SessionRewindOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const outcome = value as Record<string, unknown>;
  switch (outcome.kind) {
    case 'rewound': {
      const hiddenTurnIds = readStrings(outcome.hiddenTurnIds);
      if (typeof outcome.beforeTurnId !== 'string' || !hiddenTurnIds)
        return null;
      const files = outcome.affectedFiles as
        | { count?: unknown; paths?: unknown }
        | undefined;
      const paths = files ? readStrings(files.paths) : null;
      if (
        files !== undefined &&
        (typeof files.count !== 'number' ||
          !Number.isInteger(files.count) ||
          !paths)
      )
        return null;
      return {
        kind: 'rewound',
        beforeTurnId: outcome.beforeTurnId,
        hiddenTurnIds,
        ...(files && paths
          ? { affectedFiles: { count: files.count as number, paths } }
          : {}),
      };
    }
    case 'refused':
      return REFUSAL_REASONS.has(outcome.reason as SessionRewindRefusalReason)
        ? {
            kind: 'refused',
            reason: outcome.reason as SessionRewindRefusalReason,
          }
        : null;
    case 'failed':
      return typeof outcome.message === 'string'
        ? { kind: 'failed', message: outcome.message }
        : null;
    default:
      return null;
  }
}

/**
 * `GET /api/orchestration/sessions/:threadId/continuity`: what this Session's
 * live engine declared it can do natively. A host that predates the route
 * answers 404, as it does for a Session the caller cannot read; both read as
 * nothing offered.
 */
export async function getSessionLiveContinuity(
  apiBase: string,
  threadId: string,
  opts?: ClientRequestOptions,
): Promise<SessionLiveContinuity> {
  const response = await getJson(
    sessionPath(apiBase, threadId, 'continuity'),
    opts,
  );
  if (response.status === 404) return NONE;
  const body = await readJsonBody(response);
  if (!response.ok)
    throw envelopeError(response, body, 'The session could not be read');
  const continuity = readContinuity(dataOf(body));
  if (!continuity) throw Error('Invalid session continuity response');
  return continuity;
}

/**
 * `POST /api/orchestration/sessions/:threadId/rewind`: rewind the Session's
 * engine context in place to before `turnId`. The transcript is not edited.
 * Answers the typed outcome, including a refusal; a host without the route
 * (404) reads as `unsupported`.
 */
export async function rewindSessionToTurn(
  apiBase: string,
  threadId: string,
  turnId: string,
  opts?: ClientRequestOptions,
): Promise<SessionRewindOutcome> {
  if (!turnId || turnId.length > 1024)
    throw Error('An exact turn is required.');
  const response = await mutateJson(
    sessionPath(apiBase, threadId, 'rewind'),
    'POST',
    opts,
    { turnId },
  );
  if (response.status === 404)
    return { kind: 'refused', reason: 'unsupported' };
  const body = await readJsonBody(response);
  if (!response.ok)
    throw envelopeError(
      response,
      body,
      'The conversation could not be rewound',
    );
  const outcome = readRewindOutcome(dataOf(body));
  if (!outcome) throw Error('Invalid session rewind response');
  return outcome;
}
