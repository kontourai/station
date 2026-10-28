/**
 * #3427: the person-facing Session reads — one fetcher per route under
 * `/api/orchestration/session-reads`, the leaves a person's own credential
 * reads (`station session wait|digest`, `station activity`). Station
 * Control's agent tools read the agent-only leaves of the same capabilities;
 * these never send a station-control caller.
 *
 * Each read is gated on the `sessionPersonReads` handshake flag: an older
 * host answers an unknown path 404 exactly like a Session that is not found,
 * so the fetcher refuses before the request with `SessionReadsUnsupportedError`
 * rather than read that 404 as "not found". A refusal the route sends
 * (`session_not_found`, `project_not_found`, `feature_preview_disabled`,
 * `wait_capacity`, …) is a `StationHttpError` carrying its status and code.
 */

import { envelopeError } from './api-error-message';
import { hasCapability } from './capability';
import { type ClientRequestOptions, getJson } from './http';
import { fetchPublicStationCapabilities } from './publicStationCapabilities';
import { rethrowDeadline } from './request-deadline';

const SESSION_READS_API = '/api/orchestration/session-reads';

/** The host does not serve the person-facing Session reads (it predates them). */
export class SessionReadsUnsupportedError extends Error {
  constructor() {
    super(
      'This Station does not serve Session reads for a person. Update Station to use this command.',
    );
    this.name = 'SessionReadsUnsupportedError';
  }
}

export type SessionWaitUntil = 'turn-settled' | 'idle';

/** How a turn that settled after the cursor ended. */
export interface SessionSettledTurn {
  turnId?: string;
  sequence: number;
  invocationId?: string;
  outcome: 'completed' | 'aborted' | 'error' | 'exited';
}

/** One bounded wait's answer: it only observes, and never stops the Session. */
export interface SessionWaitAnswer {
  sessionId: string;
  /** The condition held (`turn-settled` also when a restart cut the turn off). */
  settled: boolean;
  timedOut: boolean;
  /** `turn-settled` was asked with no cursor and no turn was running. */
  alreadyIdle?: true;
  state: 'running' | 'idle';
  openTurnId?: string;
  settledTurn?: SessionSettledTurn;
  /**
   * The turn a Station restart cut off, when that is the newest way a turn
   * ended after the cursor. It acknowledges no work: it is not a settlement.
   */
  interruptedTurn?: { turnId: string; sequence: number };
  /** Pass back as `afterEventCursor` to wait for what comes next. */
  eventCursor: number;
  /** A newer Session now serves the conversation; the named one sees none of its turns. */
  superseded?: true;
  currentSessionId?: string;
}

export interface SessionWaitQuery {
  until: SessionWaitUntil;
  /** At most 50 000 ms per call; the caller calls again to keep waiting. */
  timeoutMs?: number;
  afterEventCursor?: number;
}

/** The Session a digest summarizes, and one Project activity row. */
export interface SessionActivityIdentity {
  sessionId: string;
  conversationId?: string;
  title?: string;
  projectSlug?: string;
  engine: string;
  agent?: string;
  /** The status ladder's word, as the Station UI shows it. */
  status: string;
  worktree?: { path: string; branch: string };
}

export interface SessionActivityRow extends SessionActivityIdentity {
  turnRunning: boolean;
  lastActivityAt: string;
  workingDirectory?: string;
  claims?: Array<{
    claimId: string;
    workItemRef?: string;
    paths?: string[];
    note?: string;
    taskId?: string;
    claimedAt: string;
    expiresAt: string;
  }>;
}

export interface SessionActivityPage {
  sessions: SessionActivityRow[];
  nextCursor: string | null;
}

export interface SessionActivityQuery {
  /** Only this Project's Sessions; a Project the person may not view is not found. */
  projectSlug?: string;
  limit?: number;
  cursor?: string;
  /** Only Sessions running a turn or active within this many minutes. */
  activeWithinMinutes?: number;
}

export interface SessionDigestPage {
  session: SessionActivityIdentity & {
    conversationId: string;
    turnCount: number;
  };
  /** Newest first; the shape is `get_session_digest`'s. */
  turns: Array<Record<string, unknown>>;
  delegatedChildrenIncomplete?: true;
  page: {
    turns: number;
    bytes: number;
    maxBytes: number;
    order: 'newest-first';
  };
  nextCursor: string | null;
}

export interface SessionDigestQuery {
  turnLimit?: number;
  cursor?: string;
}

async function read<T>(
  apiBase: string,
  path: string,
  query: Record<string, string | number | undefined>,
  fallback: string,
  opts?: ClientRequestOptions,
): Promise<T> {
  if (
    !hasCapability(
      await fetchPublicStationCapabilities(apiBase),
      'sessionPersonReads',
    )
  )
    throw new SessionReadsUnsupportedError();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  const response = await getJson(
    `${apiBase}${SESSION_READS_API}${path}${params.size ? `?${params}` : ''}`,
    opts,
  );
  let body: { success?: boolean; data?: T } | undefined;
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    rethrowDeadline(error);
    if (!response.ok) throw envelopeError(response, undefined, fallback);
    throw error;
  }
  if (!response.ok || body?.success !== true || body.data === undefined)
    throw envelopeError(response, body, fallback);
  return body.data;
}

/**
 * `GET /session-reads/:sessionId/wait` — one bounded wait (at most 50 s) for
 * a Session the person may read. Pass a `timeoutMs` budget for the server's
 * hold and a longer request deadline in `opts.timeoutMs` (or `null`).
 */
export function waitForSession(
  apiBase: string,
  sessionId: string,
  query: SessionWaitQuery,
  opts?: ClientRequestOptions,
): Promise<SessionWaitAnswer> {
  return read<SessionWaitAnswer>(
    apiBase,
    `/${encodeURIComponent(sessionId)}/wait`,
    {
      until: query.until,
      timeoutMs: query.timeoutMs,
      afterEventCursor: query.afterEventCursor,
    },
    'Failed to wait on the Session',
    opts,
  );
}

/** `GET /session-reads/:sessionId/digest` — a recorded, model-free Session summary. */
export function getSessionDigest(
  apiBase: string,
  sessionId: string,
  query: SessionDigestQuery = {},
  opts?: ClientRequestOptions,
): Promise<SessionDigestPage> {
  return read<SessionDigestPage>(
    apiBase,
    `/${encodeURIComponent(sessionId)}/digest`,
    { turnLimit: query.turnLimit, cursor: query.cursor },
    'Failed to read the Session digest',
    opts,
  );
}

/** `GET /session-reads/activity` — the person's Sessions, newest activity first. */
export function listSessionActivity(
  apiBase: string,
  query: SessionActivityQuery = {},
  opts?: ClientRequestOptions,
): Promise<SessionActivityPage> {
  return read<SessionActivityPage>(
    apiBase,
    '/activity',
    {
      projectSlug: query.projectSlug,
      limit: query.limit,
      cursor: query.cursor,
      activeWithinMinutes: query.activeWithinMinutes,
    },
    'Failed to list Session activity',
    opts,
  );
}
