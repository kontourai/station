/**
 * Canonical orchestration fetchers (#165/#173 Wave 1, inside the #167 DRY
 * client layer). One HTTP-call implementation per operation, shared by the
 * CLI's `approvals` verb (`packages/cli/src/commands/approvals.ts`) and the
 * repointed `acp commands`/`acp command-options` verbs
 * (`packages/cli/src/commands/surfaces.ts`).
 *
 * Routes:
 * - `POST /api/orchestration/commands` `{type:'respondToRequest',...}` —
 *   `src-server/routes/orchestration/orchestration.ts:48-52` (schema), `:297-317` (handler).
 * - `GET /api/orchestration/sessions/:threadId` — `orchestration.ts:248-254`.
 * - `GET /api/orchestration/sessions/read-model` — `orchestration.ts:121-146`
 *   region (session-list endpoints).
 * - `GET /api/orchestration/providers/:provider/commands` —
 *   `orchestration.ts:126-130`.
 * - `GET /api/orchestration/sessions/:threadId/flow-run` —
 *   `src-server/routes/orchestration/orchestration.ts:216-231` (route),
 *   `OrchestrationService.readSessionFlowRun`
 *   (`src-server/services/orchestration/orchestration-service.ts:797-809`). Added for
 *   #168 (`station operate`'s gate-verdicts pane); zero new server routes
 *   (the route already shipped, this is the missing SDK client fetcher).
 *
 * `respondToRequest` deliberately does not use `http.ts`'s
 * `readEnvelopeOrThrow`: the `/commands` route's envelope is
 * `{success, data, receipt}`, not the bare `{success,data}` `JsonEnvelope<T>`
 * shape `readEnvelopeOrThrow` assumes, and `receipt` must reach the caller
 * (the CLI prints it) on *both* the success path (returned alongside
 * `result`) and the failure path (server-side
 * `OrchestrationCommandDispatchError` can attach a `receipt` too — preserved
 * as a property on the thrown `Error`, #165 iteration-2 code-review LOW
 * fix) — so this function parses the body itself instead of using the
 * generic helper. All four fetchers here parse-then-check (parse the JSON
 * body before checking `response.ok`) per the #167 iteration-2 H1
 * convention documented in `client/runs.ts`'s `unwrapRunsResponse`, so a
 * non-2xx `{success:false,error}` body's `error` text is preserved instead
 * of being replaced with a generic status message.
 */
import type { AdoptedSessionResult } from '@kontourai/station-contracts/orchestration';
import { apiErrorMessage } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  StationHttpError,
} from './http';

interface OrchestrationEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  receipt?: unknown;
}

async function unwrapOrchestrationResponse<T>(response: Response): Promise<T> {
  let result: OrchestrationEnvelope<T> | null = null;
  try {
    result = (await response.json()) as OrchestrationEnvelope<T>;
  } catch {
    // A body that is not JSON says nothing about the STATUS, and the status is
    // what a caller's retry classification reads. Throwing a bare Error here
    // made an intermediary's non-JSON 401/403 — a reverse proxy, a tunnel, an
    // access gateway — indistinguishable from a transient failure, so a
    // consumer classifying terminality by `instanceof StationHttpError`
    // retried a request that could never clear (station#3378 review, HIGH).
    if (!response.ok) {
      throw new StationHttpError(
        response.status,
        `Orchestration API error: ${response.status}`,
      );
    }
    throw new Error(`Orchestration API error: ${response.status}`);
  }
  if (!response.ok || !result.success) {
    const message =
      typeof result.error === 'string'
        ? result.error
        : `Orchestration API error: ${response.status}`;
    if (!response.ok) {
      throw new StationHttpError(response.status, message);
    }
    throw new Error(message);
  }
  return result.data as T;
}

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface RespondToRequestInput {
  threadId: string;
  requestId: string;
  expectedRequestEventId?: string;
  decision: ApprovalDecision;
}

export interface RespondToRequestResult {
  result: unknown;
  receipt: unknown;
}

/**
 * `POST /api/orchestration/commands` with `{type:'respondToRequest',...}` —
 * resolves an open `request.opened` (approval/permission/confirmation/input)
 * with one of the four decisions the server's zod schema accepts. See the
 * module docblock for why this does not use `readEnvelopeOrThrow`.
 */
export async function respondToRequest(
  apiBase: string,
  input: RespondToRequestInput,
  opts?: ClientRequestOptions,
): Promise<RespondToRequestResult> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/commands`,
    'POST',
    opts,
    { type: 'respondToRequest', ...input },
  );
  let payload: OrchestrationEnvelope<unknown> | null = null;
  try {
    payload = (await response.json()) as OrchestrationEnvelope<unknown>;
  } catch {
    // Same shape as `unwrapOrchestrationResponse` above (station#3437,
    // mirrors #3378): a body that is not JSON says nothing about the
    // STATUS, and the status is what a caller's terminal/transient
    // classification reads. Message text unchanged.
    if (!response.ok) {
      throw new StationHttpError(
        response.status,
        `Orchestration API error: ${response.status}`,
      );
    }
    throw new Error(`Orchestration API error: ${response.status}`);
  }
  if (!response.ok || !payload.success) {
    // The dispatch failure path can still carry a `receipt` (server-side
    // `OrchestrationCommandDispatchError`, `src-server/routes/
    // orchestration.ts:297-314`) — preserved as a property on the thrown
    // error rather than dropped, so a caller that cares (e.g. an
    // audit/governance-facing surface) can still reach it (#165
    // iteration-2 code-review LOW fix).
    const message = apiErrorMessage(
      payload,
      `Orchestration API error: ${response.status}`,
    );
    // station#3437 review (MEDIUM): mirror `unwrapOrchestrationResponse`'s
    // `!response.ok` branch above — a status still carried by a *parsed*
    // JSON error body (Station's own unauthenticated-request response,
    // `runtime-http.ts`'s `c.json({success:false,error}, 401)`, is exactly
    // this shape) must stay classifiable by `instanceof StationHttpError`,
    // the same way the non-JSON-body path already is.
    const error = (
      response.ok
        ? new Error(message)
        : new StationHttpError(response.status, message)
    ) as (Error | StationHttpError) & { receipt?: unknown };
    if (payload.receipt !== undefined) {
      error.receipt = payload.receipt;
    }
    throw error;
  }
  return { result: payload.data ?? null, receipt: payload.receipt };
}

/**
 * `GET /api/orchestration/sessions/:threadId` — one orchestration session's
 * detail (`session` summary + full `events` list). Throws the server's own
 * `'Session not found'` text on 404.
 */
export async function getOrchestrationSession<
  T = { session: unknown; events: unknown[] },
>(apiBase: string, threadId: string, opts?: ClientRequestOptions): Promise<T> {
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}`,
    opts,
  );
  return unwrapOrchestrationResponse<T>(response);
}

/** Read a bounded, stable-sequence page from one orchestration session. */
export async function getOrchestrationSessionEventPage<T>(
  apiBase: string,
  threadId: string,
  input: { afterSequence: number; limit: number },
  opts?: ClientRequestOptions,
): Promise<T> {
  const query = new URLSearchParams({
    afterSequence: String(input.afterSequence),
    limit: String(input.limit),
  });
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/event-page?${query}`,
    opts,
  );
  return unwrapOrchestrationResponse<T>(response);
}

/** Versioned, bounded newest-turn snapshot with keyset pagination. */
export async function getOrchestrationSessionEventWindow<T>(
  apiBase: string,
  threadId: string,
  input?: { cursor?: string; turnLimit?: number },
  opts?: ClientRequestOptions,
): Promise<T> {
  const query = new URLSearchParams();
  if (input?.cursor) query.set('cursor', input.cursor);
  if (input?.turnLimit !== undefined) {
    query.set('turnLimit', String(input.turnLimit));
  }
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/event-window${query.size ? `?${query}` : ''}`,
    opts,
  );
  return unwrapOrchestrationResponse<T>(response);
}

/** Bounded durable-conversation transcript; child events remain session-keyed. */
export async function getOrchestrationConversationEventWindow<T>(
  apiBase: string,
  conversationId: string,
  input?: { cursor?: string; turnLimit?: number },
  opts?: ClientRequestOptions,
): Promise<T> {
  const query = new URLSearchParams();
  if (input?.cursor) query.set('cursor', input.cursor);
  if (input?.turnLimit !== undefined)
    query.set('turnLimit', String(input.turnLimit));
  const response = await getJson(
    `${apiBase}/api/orchestration/conversations/${encodeURIComponent(conversationId)}/event-window${query.size ? `?${query}` : ''}`,
    opts,
  );
  return unwrapOrchestrationResponse<T>(response);
}

/** `GET /api/orchestration/sessions/read-model` — the session read-model list. */
export async function listOrchestrationSessions<T = unknown[]>(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<T> {
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/read-model`,
    opts,
  );
  return unwrapOrchestrationResponse<T>(response);
}

/**
 * `GET /api/orchestration/providers/:provider/commands` — the given
 * provider's slash-command list (dispatches server-side to that provider
 * adapter's `getCommands()`). Consumed by both `approvals` (indirectly, via
 * the CLI's `acp commands` repoint) and directly by
 * `surfaces.ts`'s `runAcpCommand`.
 */
export async function getProviderCommands<T = unknown[]>(
  apiBase: string,
  provider: string,
  opts?: ClientRequestOptions,
): Promise<T> {
  const response = await getJson(
    `${apiBase}/api/orchestration/providers/${encodeURIComponent(provider)}/commands`,
    opts,
  );
  return unwrapOrchestrationResponse<T>(response);
}

/**
 * The slim shape `OrchestrationService.readSessionFlowRun` returns
 * (`src-server/services/orchestration/orchestration-service.ts:797-809`):
 * `SessionFlowBinding & {run: FlowRunStatus}`. Declared locally rather than
 * imported from server-side types (SDK package boundary) — matches
 * `FlowRunStatus`'s shape at `src-server/services/flow/flow-run-service.ts:94-100`.
 */
export interface SessionFlowRunView {
  runId: string;
  definitionId: string;
  cwd: string;
  run: {
    runId: string;
    dir: string;
    definition: unknown;
    state: unknown;
    manifest: unknown;
    openGates: Array<{ id: string; step: string }>;
  };
  /**
   * Freshness of the run's gate evaluation (station#189 S1), flattened onto
   * the view by `readSessionFlowRun`. `run.state.updated_at` is NOT freshness:
   * it moves on every write to the run, so a run that has never had a gate
   * evaluated still looks recent. Optional here because a caller may be
   * talking to an older server that does not send these fields.
   */
  lastEvaluatedAt?: string | null;
  blockedReason?: 'ungated-step';
  gateOutcomeCount?: number;
  evidenceCount?: number;
}

/**
 * `GET /api/orchestration/sessions/:threadId/flow-run` — the Flow run bound
 * to a session, or `null` when the session is not Flow-bound. Route:
 * `src-server/routes/orchestration/orchestration.ts:216-231`. Consumed by `station
 * operate`'s (#168) gate-verdicts pane (`packages/cli/src/commands/
 * operate/shell.ts`, Wave 2), pulled once on focus-change and on manual
 * refresh (`r` key) — never polled continuously.
 *
 * Per the #167 iteration-2 H1 convention (parse-then-check, see this file's
 * module docblock), this checks `response.status === 404` *before* the
 * generic envelope unwrap and returns `null` — mirrors
 * `session-client.ts`'s `readRuntimeSessionOrNull` 404-as-null precedent
 * (`session-client.ts:497-515`): a 404 here means "no Flow run bound to
 * this session," not an error. Any other non-2xx still throws via
 * `unwrapOrchestrationResponse`.
 */
export async function getSessionFlowRun<T = SessionFlowRunView>(
  apiBase: string,
  threadId: string,
  opts?: ClientRequestOptions,
): Promise<T | null> {
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/flow-run`,
    opts,
  );
  if (response.status === 404) {
    return null;
  }
  return unwrapOrchestrationResponse<T>(response);
}

/**
 * The Builder run joined to a session (station#189 S4) — mirrors
 * `SessionBuilderRunView` in `@kontourai/station-contracts/workflow`,
 * re-declared here for the same SDK-package-boundary reason
 * `SessionFlowRunView` is.
 *
 * `identityStatus` and `matchKind` are BOTH required reading: the first says
 * whether the joined run carries a runtime-session identity at all, the second
 * says what entitled Station to attach that run to this session. A surface
 * that renders one without the other is claiming more than was established.
 */
export interface SessionBuilderRunView {
  identityStatus: 'present' | 'unavailable' | 'unsupported';
  matchKind: 'started-by-station' | 'correlation-matched' | 'none';
  reason?: string;
  taskSlug?: string;
  /**
   * The binding named a task whose sidecar could not be read (a broken
   * binding). Absent means "not that" — the only thing a server predating
   * this field could have meant.
   */
  taskSidecarUnreadable?: true;
  runRef?: string;
  /** `state.json.updated_at` — when the sidecar FILE was last written. */
  sidecarUpdatedAt?: string;
  flowRun?: {
    run_id: string;
    definition_id: string;
    definition_version: string;
    status: string;
    current_step: string;
    run_ref: string;
    open_gate_ids: string[];
    route_back_attempt?: number;
    route_back_max_attempts?: number;
  };
}

/**
 * `GET /api/orchestration/sessions/:threadId/builder-run` — the Builder run
 * joined to a session, or `null` when nothing could be joined and there was
 * nothing to disclose about why. Same 404-as-null convention (and the same
 * parse-then-check ordering) as `getSessionFlowRun` above.
 *
 * A separate call from `getSessionFlowRun` deliberately: the auto-attached
 * `station-delivery` run and the Builder run are different runs with
 * independent lifecycles, and merging them into one progress figure is the
 * exact misreading station#189 exists to remove.
 */
export async function getSessionBuilderRun<T = SessionBuilderRunView>(
  apiBase: string,
  threadId: string,
  opts?: ClientRequestOptions,
): Promise<T | null> {
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/builder-run`,
    opts,
  );
  if (response.status === 404) {
    return null;
  }
  return unwrapOrchestrationResponse<T>(response);
}

/** Continue a read-only attached session as a new Station-owned child. */
export async function adoptSession(
  apiBase: string,
  sourceThreadId: string,
  opts?: ClientRequestOptions,
): Promise<AdoptedSessionResult> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/commands`,
    'POST',
    opts,
    { type: 'adoptSession', sourceThreadId },
  );
  return unwrapOrchestrationResponse<AdoptedSessionResult>(response);
}

/** Interrupt the active turn while keeping the session available to resume. */
export async function interruptTurn(
  apiBase: string,
  input: { threadId: string; turnId?: string },
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/commands`,
    'POST',
    opts,
    {
      type: 'interruptTurn',
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
  );
  return unwrapOrchestrationResponse<unknown>(response);
}
