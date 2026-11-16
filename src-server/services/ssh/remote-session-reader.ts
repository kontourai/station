import type {
  OrchestrationSessionEventWindow,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
// archive#1778: ONE normalizer, shared with the SDK's fetch helpers. A second
// hand-written copy here would be the divergent-copy disease this change is
// about — and the first version of it guarded on truthiness, so a remote
// sending `{ answerable: false }` with no observer passed through as an
// unattributed negative claim.
import { withNormalizedAnswerability } from '@kontourai/station-contracts/orchestration';
import {
  type ClientRequestOptions,
  getOrchestrationSessionDetailWindow,
  listOrchestrationSessions,
  SessionDetailWindowUnsupportedError,
  StationHttpError,
  StationRequestTimeoutError,
  StationResponseTooLargeError,
  searchConversationMessages,
} from '@kontourai/station-sdk/client';
import {
  guardRemoteMessageSearch,
  type RemoteStationReadAuthority,
} from '../../security/remote-station-read-authority.js';
import { createLogger } from '../../utils/logger.js';
import type { PeerCredentialStore } from '../peers/peer-credential-store.js';
import type { SshEnvironmentService } from './ssh-environment-service.js';

const logger = createLogger({ name: 'remote-session-reader' });

/**
 * A remote's answer passed this Station's byte ceiling. Its status stays the
 * read's existing one (unavailable, unreachable), so it is logged, by
 * environment id alone: no name, address or content.
 */
function logTooLarge(
  environmentId: string,
  read: 'session-list' | 'message-search' | 'session-history',
): void {
  logger.warn('Remote Station answer exceeded its byte ceiling', {
    environmentId,
    read,
  });
}

/** R1 (archive#1097): keep every remote read well under the local list's own
 * render budget — a slow/unreachable environment must never make the human
 * work list feel slow, only quietly incomplete (R3). */
const REMOTE_SESSION_FETCH_TIMEOUT_MS = 2_000;

/** Defense-in-depth bound on one environment's session count, independent of
 * whatever limit (if any) the remote Station itself applies. */
const MAX_REMOTE_SESSIONS_PER_ENVIRONMENT = 200;

/** Defense-in-depth bound (archive#1097) on how many
 * connected environments are fanned out to concurrently — a large saved
 * profile list could otherwise open dozens of simultaneous outbound
 * connections from a single Home-view read. Environments are read in
 * batches of this size rather than all at once; each batch still resolves
 * concurrently via `Promise.allSettled`. */
export const MAX_CONCURRENT_REMOTE_ENVIRONMENTS = 16;

/** A palette keystroke never opens more than this many peer searches. */
export const MAX_REMOTE_MESSAGE_SEARCH_ENVIRONMENTS = 16;

/** A palette query may never ask one peer for enough rows to exhaust its cap. */
const MAX_REMOTE_MESSAGE_SEARCH_RESULTS_PER_ENVIRONMENT = 5;

/** The aggregate retains no more transcript excerpts than the palette can show. */
const MAX_FEDERATED_MESSAGE_SEARCH_RESULTS = 20;

/** The remote deadline remains short enough for a superseding palette query. */
const REMOTE_MESSAGE_SEARCH_TIMEOUT_MS = 2_000;

export interface RemoteEnvironmentSessions {
  environmentId: string;
  environmentName: string;
  sessions: OrchestrationSessionSummary[];
}

export interface RemoteEnvironmentUnavailable {
  environmentId: string;
  environmentName: string;
}

/**
 * A connected SSH tunnel whose remote Station rejected or lacks the outbound
 * peer bearer. This is deliberately distinct from an unreachable tunnel: the
 * operator can repair it by provisioning/replacing the peer credential.
 */
export interface RemoteEnvironmentAuthenticationRequired {
  environmentId: string;
  environmentName: string;
  action: 'provision_peer_credential';
}

export interface RemoteSessionsResult {
  environments: RemoteEnvironmentSessions[];
  unavailable: RemoteEnvironmentUnavailable[];
  authenticationRequired: RemoteEnvironmentAuthenticationRequired[];
}

export type RemoteSessionsFetcher = (
  apiBase: string,
  options?: ClientRequestOptions,
) => Promise<OrchestrationSessionSummary[]>;

export interface RemoteMessageSearchMatch {
  conversationId: string;
  messageId: string;
  /** Stable identity of the connected Station that supplied this match. */
  sourceInstanceId?: string;
  sourceInstanceName?: string;
  role: 'user' | 'assistant';
  excerpt: string;
  projectSlug?: string;
  engine?: string;
  agentSlug?: string;
}

type RemoteMessageSearchStatus =
  | 'available'
  | 'empty'
  | 'authentication_required'
  | 'timed_out'
  | 'refused'
  | 'unreachable'
  | 'deferred';

interface RemoteMessageSearchInstance {
  instanceId: string;
  instanceName: string;
  status: RemoteMessageSearchStatus;
}

interface RemoteMessageSearchResult {
  matches: RemoteMessageSearchMatch[];
  instances: RemoteMessageSearchInstance[];
  /** Connected Stations omitted by the fixed search fan-out budget. */
  deferredInstanceCount: number;
}

export type RemoteMessageSearchFetcher = (
  apiBase: string,
  query: string,
  options?: ClientRequestOptions,
) => Promise<RemoteMessageSearchMatch[]>;

/**
 * Byte ceiling on one remote's session list. The list asks for the newest
 * `MAX_REMOTE_SESSIONS_PER_ENVIRONMENT`; measured summaries (132 real attached
 * sessions: p50 4,128, p90 6,502, max 30,840 bytes) put 200 of the largest at
 * about 6.2 MB. An older remote that ignores `limit` sends every session, and
 * this still holds about 2,000 typical ones. Past it the environment is
 * unavailable for this read, logged, never parsed.
 */
export const MAX_REMOTE_SESSION_LIST_RESPONSE_BYTES = 8_388_608;

/**
 * Byte ceiling on one remote's search answer. It keeps at most five short
 * excerpts per remote, so a larger answer is not one this Station can use;
 * that remote reads as unreachable for this search.
 */
export const MAX_REMOTE_MESSAGE_SEARCH_RESPONSE_BYTES = 262_144;

const defaultFetcher: RemoteSessionsFetcher = (apiBase, options) =>
  listOrchestrationSessions<OrchestrationSessionSummary[]>(
    apiBase,
    {
      timeoutMs: REMOTE_SESSION_FETCH_TIMEOUT_MS,
      ...options,
      maxResponseBytes: MAX_REMOTE_SESSION_LIST_RESPONSE_BYTES,
    },
    { limit: MAX_REMOTE_SESSIONS_PER_ENVIRONMENT },
  );

const defaultMessageSearchFetcher: RemoteMessageSearchFetcher = (
  apiBase,
  query,
  options,
) =>
  searchConversationMessages(apiBase, query, {
    timeoutMs: REMOTE_MESSAGE_SEARCH_TIMEOUT_MS,
    ...options,
    maxResponseBytes: MAX_REMOTE_MESSAGE_SEARCH_RESPONSE_BYTES,
  });

interface ConnectedEnvironment {
  /** Stable local SSH-profile id, returned to the Home UI. */
  id: string;
  /** Remote peer identity, the key for its outbound stored bearer. */
  peerEnvironmentId: string | null;
  name: string;
  localUrl: string;
}

function connectedEnvironments(
  service: Pick<SshEnvironmentService, 'list'>,
): ConnectedEnvironment[] {
  const connected: ConnectedEnvironment[] = [];
  for (const view of service.list()) {
    if (view.state.phase === 'connected') {
      connected.push({
        id: view.profile.id,
        peerEnvironmentId: view.profile.environmentId,
        name: view.profile.name,
        localUrl: view.state.localUrl,
      });
    }
  }
  return connected;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function isConnectionRefused(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    // A StationHttpError is an ANSWER, so nothing it carries is a refused
    // connection — and its `code` is the peer's envelope code (#2708), which a
    // peer could set to any label, `ECONNREFUSED` included.
    if (current instanceof StationHttpError) return false;
    if ((current as { code?: unknown }).code === 'ECONNREFUSED') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function statusForRemoteMessageSearchFailure(
  error: unknown,
): Exclude<RemoteMessageSearchStatus, 'available' | 'empty'> {
  if (
    error instanceof RemoteSessionAuthenticationRequiredError ||
    (error instanceof StationHttpError && error.status === 401)
  ) {
    return 'authentication_required';
  }
  if (error instanceof StationRequestTimeoutError) return 'timed_out';
  if (isConnectionRefused(error)) return 'refused';
  return 'unreachable';
}

/**
 * Searches a bounded set of connected Stations through the established SSH
 * tunnel and explicit peer bearer. The remote route derives its authority
 * locally; this caller forwards only the query, never a user, tenant, or ACL
 * claim.
 *
 * A palette keystroke launches no more than
 * `MAX_REMOTE_MESSAGE_SEARCH_ENVIRONMENTS` peers, with that same concurrent
 * ceiling. Remaining connected peers are explicitly `deferred`, never
 * silently represented as empty. Each queried peer yields at most five rows
 * and the caller applies the global cap. A superseding browser request aborts
 * the same signal that reaches every fetch.
 */
export async function searchConnectedRemoteMessages(
  service: Pick<SshEnvironmentService, 'list'>,
  query: string,
  signal?: AbortSignal,
  fetchMessages: RemoteMessageSearchFetcher = defaultMessageSearchFetcher,
  peerCredentials?: Pick<PeerCredentialStore, 'get'>,
): Promise<RemoteMessageSearchResult> {
  const matches: RemoteMessageSearchMatch[] = [];
  const instances: RemoteMessageSearchInstance[] = [];

  const connected = connectedEnvironments(service);
  const queried = connected.slice(0, MAX_REMOTE_MESSAGE_SEARCH_ENVIRONMENTS);
  const deferred = connected.slice(MAX_REMOTE_MESSAGE_SEARCH_ENVIRONMENTS);
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const settled = await Promise.allSettled(
    queried.map(async (environment) => {
      const peer = environment.peerEnvironmentId
        ? peerCredentials?.get(environment.peerEnvironmentId)
        : null;
      if (peerCredentials && !peer) {
        throw new RemoteSessionAuthenticationRequiredError();
      }
      const result = await fetchMessages(
        environment.localUrl,
        query,
        peer
          ? {
              headers: { Authorization: `Bearer ${peer.credential}` },
              signal,
            }
          : { signal },
      );
      if (!Array.isArray(result)) {
        throw new Error('Remote Station returned an invalid message search');
      }
      // The source is assigned at the receiving Station, from its connected
      // environment record. A remote response may not choose or overwrite
      // the identity the local UI uses for routing.
      return result
        .slice(0, MAX_REMOTE_MESSAGE_SEARCH_RESULTS_PER_ENVIRONMENT)
        .map((match) => ({
          ...match,
          sourceInstanceId: environment.id,
          sourceInstanceName: environment.name,
        }));
    }),
  );
  settled.forEach((result, index) => {
    const environment = queried[index];
    if (result.status === 'fulfilled') {
      matches.push(
        ...result.value.slice(
          0,
          Math.max(0, MAX_FEDERATED_MESSAGE_SEARCH_RESULTS - matches.length),
        ),
      );
      instances.push({
        instanceId: environment.id,
        instanceName: environment.name,
        status: result.value.length > 0 ? 'available' : 'empty',
      });
      return;
    }
    if (isAbort(result.reason, signal)) {
      throw result.reason;
    }
    if (isResponseTooLarge(result.reason))
      logTooLarge(environment.id, 'message-search');
    instances.push({
      instanceId: environment.id,
      instanceName: environment.name,
      status: statusForRemoteMessageSearchFailure(result.reason),
    });
  });
  return {
    matches,
    instances,
    // Keep the incomplete-search signal visible without projecting one DOM
    // status per unqueried saved profile on every settled keystroke.
    deferredInstanceCount: deferred.length,
  };
}

/**
 * The message search runtime-routes.ts hands the conversation routes: the
 * connected-Station search above, reached only by a caller the read
 * authority admits. A caller it refuses gets no remote result, no remote
 * Station named, and no bearer sent; the route's local results are its own.
 */
export function runtimeRemoteMessageSearch(
  reads: RemoteStationReadAuthority,
  service: Pick<SshEnvironmentService, 'list'>,
  peerCredentials: Pick<PeerCredentialStore, 'get'>,
  fetchMessages: RemoteMessageSearchFetcher = defaultMessageSearchFetcher,
) {
  return guardRemoteMessageSearch(reads, (query, signal) =>
    searchConnectedRemoteMessages(
      service,
      query,
      signal,
      fetchMessages,
      peerCredentials,
    ),
  );
}

/**
 * R1/R3 (archive#1097): read-only orchestration session summaries from every
 * currently CONNECTED SSH environment, for the Home work list's remote-session
 * badge. Deliberately never triggers a new SSH connect/tunnel — `service.list()`
 * is a synchronous read of in-memory tunnel state (`SshEnvironmentService`
 * never re-dials here), so an idle/disconnected/erroring environment is
 * skipped outright rather than paying a connect round-trip just to render a
 * home list. Each connected environment's fetch carries its own short
 * deadline and its own failure boundary (`Promise.allSettled`), so one slow
 * or unreachable environment can never block or delay another, or the local
 * list — which never calls this at all (see home-view-model.ts's
 * `buildHomeWorkItems`, which treats an empty/absent `remoteEnvironments`
 * as a pure no-op, and `HomeView.tsx`, which fetches this independently of
 * the local session/task queries).
 */
export async function listConnectedRemoteSessions(
  service: Pick<SshEnvironmentService, 'list'>,
  fetchSessions: RemoteSessionsFetcher = defaultFetcher,
  peerCredentials?: Pick<PeerCredentialStore, 'get'>,
): Promise<RemoteSessionsResult> {
  const connected = connectedEnvironments(service);
  const environments: RemoteEnvironmentSessions[] = [];
  const unavailable: RemoteEnvironmentUnavailable[] = [];
  const authenticationRequired: RemoteEnvironmentAuthenticationRequired[] = [];

  // Batches run one after another, but every environment WITHIN a batch
  // still resolves concurrently via `Promise.allSettled` — a batch boundary
  // only caps how many are ever simultaneously in flight, it never
  // serializes the whole fan-out or lets one slow/unreachable environment
  // in an earlier batch delay a later batch (each environment's own
  // timeout still bounds it independently).
  for (const batch of chunk(connected, MAX_CONCURRENT_REMOTE_ENVIRONMENTS)) {
    const settled = await Promise.allSettled(
      batch.map(async (environment) => {
        // archive#2051 follow-up: an SSH local forward only carries bytes;
        // it is never authority at the remote runtime. Resolve the already
        // provisioned, outbound peer bearer for this environment and present
        // it explicitly over the tunnel. A missing credential is a repairable
        // authentication state, not an unavailable remote Station.
        const peer = environment.peerEnvironmentId
          ? peerCredentials?.get(environment.peerEnvironmentId)
          : null;
        if (peerCredentials && !peer) {
          throw new RemoteSessionAuthenticationRequiredError();
        }
        const sessions = await fetchSessions(
          environment.localUrl,
          peer
            ? {
                headers: { Authorization: `Bearer ${peer.credential}` },
              }
            : undefined,
        );
        if (!Array.isArray(sessions)) {
          throw new Error('Remote Station returned an invalid session list');
        }
        return {
          environmentId: environment.id,
          environmentName: environment.name,
          // The read model is oldest first; keep the newest (all of them
          // from a remote that honoured `limit`).
          sessions: sessions
            .slice(-MAX_REMOTE_SESSIONS_PER_ENVIRONMENT)
            .map(withNormalizedAnswerability),
        } satisfies RemoteEnvironmentSessions;
      }),
    );

    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        environments.push(result.value);
        return;
      }
      const source = batch[index];
      if (isResponseTooLarge(result.reason))
        logTooLarge(source.id, 'session-list');
      if (
        result.reason instanceof RemoteSessionAuthenticationRequiredError ||
        (result.reason instanceof StationHttpError &&
          result.reason.status === 401)
      ) {
        authenticationRequired.push({
          environmentId: source.id,
          environmentName: source.name,
          action: 'provision_peer_credential',
        });
        return;
      }
      unavailable.push({
        environmentId: source.id,
        environmentName: source.name,
      });
    });
  }

  return { environments, unavailable, authenticationRequired };
}

/** An internal sentinel so Promise.allSettled preserves auth-vs-transport. */
class RemoteSessionAuthenticationRequiredError extends Error {
  constructor() {
    super(
      'No outbound peer credential is provisioned for this SSH environment',
    );
    this.name = 'RemoteSessionAuthenticationRequiredError';
  }
}

/** One history page is a short, bounded read over the tunnel. */
const REMOTE_SESSION_HISTORY_TIMEOUT_MS = 5_000;

/** Newest turns asked of the remote per page; the route refuses more. */
export const MAX_REMOTE_SESSION_HISTORY_TURNS = 20;

/**
 * Byte ceiling on one relayed page's complete response. A current remote
 * answers at most `SESSION_EVENT_WINDOW_MAX_RESPONSE_BYTES` (64,000) per
 * window; this leaves headroom for other versions while bounding a legacy
 * remote that ignores `view=window-v1` and sends its whole detail. Read past
 * it is refused (`too_large`), never parsed.
 */
export const MAX_REMOTE_SESSION_HISTORY_RESPONSE_BYTES = 262_144;

/** The SDK's refusal of a bounded body, found anywhere on the cause chain. */
function isResponseTooLarge(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current instanceof Error && depth < 8;
    current = current.cause, depth += 1
  )
    if (current instanceof StationResponseTooLargeError) return true;
  return false;
}

/** Matches the remote orchestration route's own cursor bound. */
export const MAX_REMOTE_HISTORY_CURSOR_LENGTH = 512;

/**
 * Defense-in-depth bound on events relayed from one remote page,
 * independent of the remote Station's own window budget. A larger page is
 * refused, not truncated: a cut page would read as a complete transcript.
 */
export const MAX_REMOTE_SESSION_HISTORY_EVENTS = 2_000;

export type RemoteSessionHistoryFetcher = (
  apiBase: string,
  threadId: string,
  input: { cursor?: string; turnLimit: number },
  options?: ClientRequestOptions,
) => Promise<OrchestrationSessionEventWindow>;

const defaultHistoryFetcher: RemoteSessionHistoryFetcher = (
  apiBase,
  threadId,
  input,
  options,
) =>
  getOrchestrationSessionDetailWindow(apiBase, threadId, input, {
    timeoutMs: REMOTE_SESSION_HISTORY_TIMEOUT_MS,
    readOnly: true,
    ...options,
    maxResponseBytes: MAX_REMOTE_SESSION_HISTORY_RESPONSE_BYTES,
  });

export type RemoteSessionHistoryFailure =
  /** No saved environment by that id, or it is not connected right now. */
  | 'environment_unavailable'
  /** Connected, but no outbound peer bearer, or the remote rejected it. */
  | 'authentication_required'
  /** The remote Station has no session by that id readable to this peer. */
  | 'not_found'
  /** The remote did not answer in time or could not be reached. */
  | 'unreachable'
  /** The remote's page passed this Station's byte ceiling. */
  | 'too_large'
  /** The remote answered with a page this Station will not relay. */
  | 'invalid_response';

export class RemoteSessionHistoryError extends Error {
  constructor(readonly reason: RemoteSessionHistoryFailure) {
    super(`Remote session history unavailable: ${reason}`);
    this.name = 'RemoteSessionHistoryError';
  }
}

export interface RemoteSessionHistoryPage {
  environmentId: string;
  environmentName: string;
  window: OrchestrationSessionEventWindow;
}

/**
 * Read one bounded history page of a session that lives on a connected SSH
 * environment's Station. The remote Station discovered and owns the
 * session (its own attached-session follower read its own host), so this
 * Station only relays a read: it never dials a tunnel (only an environment
 * already `connected` is used), presents the provisioned outbound peer
 * bearer, and the remote derives the read's authority itself. The remote's
 * answer must name the requested session, and the environment identity on
 * the result comes from this Station's profile, never from the response.
 */
export async function readConnectedRemoteSessionHistory(
  service: Pick<SshEnvironmentService, 'list'>,
  environmentId: string,
  threadId: string,
  input: { cursor?: string; turnLimit: number },
  fetchHistory: RemoteSessionHistoryFetcher = defaultHistoryFetcher,
  peerCredentials?: Pick<PeerCredentialStore, 'get'>,
  /** The caller's own request signal: a caller that leaves cancels the read. */
  signal?: AbortSignal,
): Promise<RemoteSessionHistoryPage> {
  const environment = connectedEnvironments(service).find(
    (candidate) => candidate.id === environmentId,
  );
  if (!environment) {
    throw new RemoteSessionHistoryError('environment_unavailable');
  }
  const peer = environment.peerEnvironmentId
    ? peerCredentials?.get(environment.peerEnvironmentId)
    : null;
  if (peerCredentials && !peer) {
    throw new RemoteSessionHistoryError('authentication_required');
  }
  let window: OrchestrationSessionEventWindow;
  try {
    window = await fetchHistory(
      environment.localUrl,
      threadId,
      {
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        turnLimit: Math.min(input.turnLimit, MAX_REMOTE_SESSION_HISTORY_TURNS),
      },
      peer
        ? {
            headers: { Authorization: `Bearer ${peer.credential}` },
            ...(signal ? { signal } : {}),
          }
        : signal
          ? { signal }
          : undefined,
    );
  } catch (error) {
    if (error instanceof StationHttpError) {
      if (error.status === 401) {
        throw new RemoteSessionHistoryError('authentication_required');
      }
      // A read the remote refuses for this peer is indistinguishable from
      // a missing session, as on the remote itself.
      if (error.status === 403 || error.status === 404) {
        throw new RemoteSessionHistoryError('not_found');
      }
    }
    if (isResponseTooLarge(error)) {
      logTooLarge(environment.id, 'session-history');
      throw new RemoteSessionHistoryError('too_large');
    }
    if (error instanceof SessionDetailWindowUnsupportedError) {
      throw new RemoteSessionHistoryError('invalid_response');
    }
    throw new RemoteSessionHistoryError('unreachable');
  }
  if (
    !window ||
    typeof window !== 'object' ||
    window.protocolVersion !== 1 ||
    !window.session ||
    window.session.threadId !== threadId ||
    !Array.isArray(window.events) ||
    window.events.length > MAX_REMOTE_SESSION_HISTORY_EVENTS ||
    typeof window.hasMore !== 'boolean' ||
    !Number.isSafeInteger(window.watermark) ||
    (window.nextCursor !== undefined &&
      (typeof window.nextCursor !== 'string' ||
        window.nextCursor.length > MAX_REMOTE_HISTORY_CURSOR_LENGTH))
  ) {
    throw new RemoteSessionHistoryError('invalid_response');
  }
  return {
    environmentId: environment.id,
    environmentName: environment.name,
    // Only the page's own top-level fields are relayed; any other top-level
    // field a remote adds stays on the remote. The session summary and each
    // event are relayed as the remote's ordinary authorized read returned
    // them: the events are the transcript, and the summary is the same shape
    // (cwd included) the remote-sessions list already relays to this caller.
    window: {
      protocolVersion: 1,
      session: withNormalizedAnswerability(window.session),
      events: window.events,
      hasMore: window.hasMore,
      ...(window.nextCursor !== undefined
        ? { nextCursor: window.nextCursor }
        : {}),
      ...(window.turnStartDetached === true
        ? { turnStartDetached: true as const }
        : {}),
      watermark: window.watermark,
    },
  };
}
